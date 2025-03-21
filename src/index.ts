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
  bufferSize: number
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
  publicPath,
  workerUrl,
  workerOptions,
  read,
  length,
  bufferSize = 2_500_000
}: MakeTransmuxerOptions) => {
  const worker = new Worker(workerUrl, workerOptions)

  const { makeRemuxer } = await expose<Resolvers>({}, { remote: worker, local: worker })

  let currentStream: ReadableStream<Uint8Array> | undefined
  let currentStreamOffset: number | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined

  const remuxer = await makeRemuxer({
    publicPath,
    length,
    bufferSize,
    log: async (isError, text) => {
      if (isError) console.error(text)
      else console.log(text)
    }
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
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp))
  }
}
