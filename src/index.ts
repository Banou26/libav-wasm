import PQueue from 'p-queue'
import type { Resolvers } from './worker'
import type { SubtitleFragment } from './worker'

import { expose } from 'osra'
export * from './utils'

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  length: number
  /** how much the demuxer reads ahead; defaults to 2.5 MB for a remuxer and 1 MB for a thumbnailer */
  bufferSize?: number
  /** Input stream index of the audio track to mux; defaults to the first audio stream */
  audioStreamIndex?: number
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

/**
 * The worker, the wasm instance and the serialized task queue that both public entry points share.
 *
 * Split out because a thumbnailer and a remuxer need identical plumbing and nothing else in common: only
 * which wasm entry point they open the file with, and which calls they then expose.
 */
const makeSession = async ({
  publicPath,
  workerUrl,
  workerOptions,
  read,
  length,
  bufferSize,
  audioStreamIndex
}: MakeTransmuxerOptions & { bufferSize: number }) => {
  const worker = new Worker(workerUrl, workerOptions)

  const { makeRemuxer } = await expose<Resolvers>({}, { transport: worker })

  const remuxer = await makeRemuxer({
    publicPath,
    length,
    bufferSize,
    audioStreamIndex
  })

  const queue = new PQueue({ concurrency: 1 })

  const wasmRead = (abortController: AbortController) => (offset: number, size: number) => {
    if (abortController.signal.aborted) return Promise.resolve({ resolved: new Uint8Array(0).buffer, rejected: true })
    return Promise.race([
      read(Number(offset), Number(size))
        .then(
          buffer => ({ resolved: new Uint8Array(buffer).buffer, rejected: false }),
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true })
        ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true }),
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true })
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

  const destroy = async () => {
    const currentAbortControllers = [...abortControllers]
    abortControllers = []
    queue.clear()
    currentAbortControllers.forEach(abortController => abortController.abort())
    await remuxer.destroy()
    worker.terminate()
  }

  return { worker, remuxer, wasmRead, addTask, destroy }
}

export const makeRemuxer = async (options: MakeTransmuxerOptions) => {
  const { worker, remuxer, wasmRead, addTask, destroy } = await makeSession({
    ...options,
    bufferSize: options.bufferSize ?? 2_500_000
  })

  return {
    worker,
    init: () => addTask((abortController) => remuxer.init(wasmRead(abortController))),
    destroy,
    seek: (timestamp: number) => addTask((abortController) => remuxer.seek(wasmRead(abortController), timestamp)),
    read: () => addTask((abortController) => remuxer.read(wasmRead(abortController))),
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp)),
    /** Takes effect on the next seek */
    setAudioStreamIndex: (index: number) => remuxer.setAudioStreamIndex(index)
  }
}

/**
 * Open a file for thumbnails only. No output muxer, no encoder, no stream map, no header.
 *
 * `readKeyframe` seeks BACKWARD on the input, which an output muxer cannot follow, so a remuxer that also
 * served thumbnails could only be kept correct by never doing both on one instance. There is no muxer here
 * to damage. It also opens files whose audio the muxer refuses outright, which a remuxer cannot.
 */
export const makeThumbnailer = async (options: MakeTransmuxerOptions) => {
  const { worker, remuxer, wasmRead, addTask, destroy } = await makeSession({
    ...options,
    bufferSize: options.bufferSize ?? 1_000_000
  })

  return {
    worker,
    init: () => addTask((abortController) => remuxer.initThumbnail(wasmRead(abortController))),
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp)),
    destroy
  }
}
