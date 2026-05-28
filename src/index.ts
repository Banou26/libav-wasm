import PQueue from 'p-queue'
import type { Resolvers } from './worker'
import type { SubtitleFragment } from './worker'

import { expose, transfer } from 'osra'
export * from './utils'
export { createDecodeRenderMedia } from './videojs'
export type { DecodeRenderMedia, DecodeRenderMediaOptions } from './videojs'

export type MakeTransmuxerOptions = {
  /** URL of the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  /** URL of the single-threaded ES module glue (libav.js) */
  moduleUrl: string | URL
  /** URL of the single-threaded wasm binary (libav.wasm) */
  wasmUrl: string | URL
  /**
   * URLs of the multi-threaded build: the ES module glue (libav-mt.js) and its wasm binary
   * (libav-mt.wasm). Provide both to allow `threadCount` > 1. Multi-threading additionally
   * requires the page to be cross-origin isolated (COOP/COEP) so SharedArrayBuffer is available;
   * when either condition is missing, the single-threaded build is used instead.
   */
  threadedModuleUrl?: string | URL
  threadedWasmUrl?: string | URL
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  length: number
  bufferSize: number
  /**
   * Decoder threads for the HEVC transcode fallback: 1 = single-threaded (default),
   * 0 = auto (use all cores), N = explicit count. Requires the multi-threaded build URLs above
   * and a cross-origin-isolated page; otherwise it falls back to single-threaded.
   */
  threadCount?: number
  /**
   * OffscreenCanvas (via `transferControlToOffscreen()`) for the HEVC fallback to draw decoded
   * frames onto — init() then reports `renderMode: 'canvas'` and playback runs via `renderFrame`.
   * Omitted: the fallback re-encodes to H264 for MSE (`renderMode: 'mse'`).
   */
  renderCanvas?: OffscreenCanvas
  /**
   * Force the HEVC-fallback transcode path even when the browser can play the input codec natively
   * (otherwise that path only engages for unsupported codecs). `createDecodeRenderMedia` sets this,
   * since calling it means opting into the canvas decode-render path regardless of native support.
   */
  forceTranscode?: boolean
}

const abortSignalToPromise = (abortSignal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (abortSignal.aborted) {
      return reject()
    }
    abortSignal.addEventListener('abort', () => {
      reject()
    })
  })

export const makeRemuxer = async ({
  workerUrl,
  workerOptions,
  moduleUrl,
  wasmUrl,
  threadedModuleUrl,
  threadedWasmUrl,
  read,
  length,
  bufferSize = 2_500_000,
  threadCount = 1,
  renderCanvas,
  forceTranscode
}: MakeTransmuxerOptions) => {
  const worker = new Worker(workerUrl, workerOptions)
  const { makeRemuxer } = await expose<Resolvers>({}, { transport: worker })
  let currentStream: ReadableStream<Uint8Array> | undefined
  let currentStreamOffset: number | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined

  const remuxer = await makeRemuxer({
    moduleUrl: String(moduleUrl),
    wasmUrl: String(wasmUrl),
    threadedModuleUrl: threadedModuleUrl != null ? String(threadedModuleUrl) : undefined,
    threadedWasmUrl: threadedWasmUrl != null ? String(threadedWasmUrl) : undefined,
    length,
    bufferSize,
    threadCount,
    // transfer() so osra moves the canvas into the worker rather than copying it.
    renderCanvas: renderCanvas ? transfer(renderCanvas) : undefined,
    forceTranscode,
    log: async (isError, text) => {
      if (isError) console.error(text)
      else console.log(text)
    }
  })

  const queue = new PQueue({ concurrency: 1 })

  const wasmRead = (abortController: AbortController) => (offset: number, size: number) => {
    if (abortController.signal.aborted) return Promise.resolve({ resolved: transfer(new ArrayBuffer(0)), rejected: true })
    return Promise.race([
      read(Number(offset), Number(size))
        .then(
          buffer => ({ resolved: transfer(buffer), rejected: false }),
          () => ({ resolved: transfer(new ArrayBuffer(0)), rejected: true })
        ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => ({ resolved: transfer(new ArrayBuffer(0)), rejected: true }),
          () => ({ resolved: transfer(new ArrayBuffer(0)), rejected: true })
        )
    ])
  }

  let abortControllers: AbortController[] = []

  const addTask = <T extends (abortController: AbortController) => Promise<any>>(func: T) => {
    const currentAbortControllers = [...abortControllers]
    abortControllers = []
    queue.clear()
    currentAbortControllers.forEach(abortController => abortController.abort())
    const abortController = new AbortController()
    abortControllers = [...abortControllers, abortController]
    return Promise.race([
      queue.add<Awaited<ReturnType<T>>>(
        async () => func(abortController),
        { signal: abortController.signal }
      ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => Promise.reject(new Error('Cancelled')),
          () => Promise.reject(new Error('Cancelled'))
        )
    ])
  }

  return {
    worker,
    init: () => addTask((abortController) => remuxer.init(wasmRead(abortController))),
    destroy: async () => {
      try {
        await reader?.cancel()
      } catch (err) {}
      reader = undefined
      currentStream = undefined
      currentStreamOffset = undefined
      const currentAbortControllers = [...abortControllers]
      abortControllers = []
      queue.clear()
      currentAbortControllers.forEach(abortController => abortController.abort())
      await remuxer.destroy()
      worker.terminate()
    },
    seek: (timestamp: number) => addTask((abortController) => remuxer.seek(wasmRead(abortController), timestamp)),
    read: () => addTask((abortController) => remuxer.read(wasmRead(abortController))),
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp)),
    // Decode-render mode (renderCanvas set): the app drives these from its render loop / clock.
    renderFrame: (time: number) => addTask((abortController) => (remuxer as any).renderFrame(wasmRead(abortController), time)),
    extractAudio: (): Promise<ArrayBuffer> => addTask((abortController) => (remuxer as any).extractAudio(wasmRead(abortController))),
    captureRenderedFrame: (width: number, height: number): Promise<Uint8Array> => (remuxer as any).captureRenderedFrame(width, height),
    setSkipVideoDecode: (on: boolean): Promise<void> => (remuxer as any).setSkipVideoDecode(on),
    setVideoDecodeSkipNonref: (on: boolean): Promise<void> => (remuxer as any).setVideoDecodeSkipNonref(on)
  }
}
