import type { Resolvers } from './worker'
import type { SubtitleFragment } from './worker'

import { expose } from 'osra'

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  getStream: (offset: number, size?: number) => Promise<ReadableStream<Uint8Array>>
  length: number
  bufferSize: number
}

export const makeRemuxer = async ({
  publicPath,
  workerUrl,
  workerOptions, 
  getStream,
  length,
  bufferSize = 1_000_000
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
    },
    read: async (offset: number) => {
      if (
        !currentStream ||
        (currentStreamOffset && currentStreamOffset + bufferSize !== offset)
      ) {
        reader?.cancel()
        currentStream = await getStream(offset)
        reader = currentStream.getReader() as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
      }

      if (!reader) throw new Error('No reader found')

      currentStreamOffset = offset

      return reader.read().then(({ value }) => value?.buffer ?? new ArrayBuffer(0))
    }
  })

  return {
    init: () => remuxer.init(),
    destroy: () => remuxer.destroy(),
    seek: (timestamp: number) => remuxer.seek(timestamp),
    read: () => remuxer.read()
  }
}
