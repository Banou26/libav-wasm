import PQueue from 'p-queue'
import type { Resolvers } from './worker'
import type { SubtitleFragment } from './worker'

import { expose } from 'osra'
export * from './utils'

export type { SubtitleFragment }

/** @deprecated Use MakeRemuxerOptions instead */
export type MakeTransmuxerOptions = MakeRemuxerOptions

export type MakeRemuxerOptions = {
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
  new Promise<never>((_resolve, reject) => {
    if (abortSignal.aborted) {
      return reject(new DOMException('Aborted', 'AbortError'))
    }
    abortSignal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })

export const makeRemuxer = async ({
  publicPath,
  workerUrl,
  workerOptions,
  read,
  length,
  bufferSize = 2_500_000
}: MakeRemuxerOptions) => {
  const worker = new Worker(workerUrl, workerOptions)

  const { makeRemuxer } = await expose<Resolvers>({}, { transport: worker })

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
    if (abortController.signal.aborted) {
      return Promise.resolve({ resolved: new Uint8Array(0).buffer, rejected: true })
    }
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

  const addTask = <T extends (abortController: AbortController) => Promise<unknown>>(func: T) => {
    const currentAbortControllers = [...abortControllers]
    abortControllers = []
    queue.clear()
    currentAbortControllers.forEach(controller => controller.abort())

    const abortController = new AbortController()
    abortControllers = [...abortControllers, abortController]

    return Promise.race([
      queue.add<Awaited<ReturnType<T>>>(
        async () => func(abortController) as Awaited<ReturnType<T>>,
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
      const currentAbortControllers = [...abortControllers]
      abortControllers = []
      queue.clear()
      currentAbortControllers.forEach(controller => controller.abort())
      await remuxer.destroy()
      worker.terminate()
    },
    seek: (timestamp: number) => addTask((abortController) => remuxer.seek(wasmRead(abortController), timestamp)),
    read: () => addTask((abortController) => remuxer.read(wasmRead(abortController))),
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp))
  }
}
