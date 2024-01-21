import { makeCallListener, registerListener } from 'osra'

// @ts-ignore
import WASMModule from 'libav'

import { SEEK_FLAG, SEEK_WHENCE_FLAG } from '../utils'

const makeModule = (publicPath: string) =>
  WASMModule({
    module: {
      locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`
    },
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`
  })

let module: ReturnType<typeof makeModule>

// todo: if seek latency is too slow, because of destroy + init + seek + process, we can use multiple remuxer alrandomReady initialized waiting to seek + process
// todo: We can keep in memory all of the chunks needed to initialize the remuxer

// @ts-ignore
const init = makeCallListener(async (
  { publicPath, length, bufferSize, randomRead, getStream, write, attachment, subtitle }:
  {
    publicPath: string
    length: number
    bufferSize: number
    randomRead: (offset: number, size: number) => Promise<ArrayBuffer>
    getStream: (offset: number) => Promise<ReadableStream<Uint8Array>>
    write: (params: {
      offset: number, arrayBuffer: ArrayBuffer, isHeader: boolean,
      position: number, pts: number, duration: number
    }) => Promise<void> | void
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  }) => {
  if (!module) module = await makeModule(publicPath)

  let writeBuffer = new Uint8Array(0)

  let currentStream: ReadableStream<Uint8Array> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const makeRemuxer = () => new module.Remuxer({
    promise: Promise.resolve(),
    length,
    bufferSize,
    error: (critical: boolean, message: string) => {
      console.log('worker error', critical, message)
    },
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
      subtitle(streamIndex, isHeader, data, ...rest)
    },
    attachment: (filename: string, mimetype: string, _buffer: Uint8Array) => {
      const uint8 = new Uint8Array(_buffer)
      const arraybuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
      attachment(filename, mimetype, arraybuffer)
    },
    getStream: async (offset: number) => {
      if (currentStream) {
        await currentStream.cancel()
        currentStream = undefined
        reader = undefined
      }
      const stream = await getStream(offset)
      currentStream = stream
      reader = stream.getReader()
      return {
        read: async () => {
          const { done, value } = await reader!.read()
          if (done) return new Uint8Array(0)
          return value
        },
        closed: () => reader!.closed,
        cancel: async () => {
          await reader!.cancel()
          currentStream = undefined
          reader = undefined
        }
      }
    },
    randomRead: async (offset: number, bufferSize: number) => {
      const buffer = await randomRead(offset, bufferSize)
      return buffer
    },
    write: async (
      offset: number, buffer: Uint8Array,
      isHeader: boolean, isFlushing: boolean,
      position: number, pts: number, duration: number
    ) => {
      if (isFlushing && writeBuffer.byteLength > 0) {
        write({
          isHeader,
          offset,
          arrayBuffer: writeBuffer.buffer,
          position,
          pts,
          duration
        })
        writeBuffer = new Uint8Array(0)
        if (isHeader) return
      }

      const newBuffer = new Uint8Array(writeBuffer.byteLength + buffer.byteLength)
      newBuffer.set(writeBuffer)
      newBuffer.set(new Uint8Array(buffer), writeBuffer.byteLength)
      writeBuffer = newBuffer
    }
  })

  let remuxer: ReturnType<typeof makeRemuxer> = makeRemuxer()

  return {
    init: async () => {
      writeBuffer = new Uint8Array(0)
      module = await makeModule(publicPath)
      remuxer = makeRemuxer()
      await remuxer.init()
    },
    destroy: () => {
      remuxer.destroy()
      remuxer = undefined
      module = undefined
      writeBuffer = new Uint8Array(0)
    },
    seek: (timestamp: number, flags: SEEK_FLAG) => remuxer.seek(timestamp, flags),
    // todo: For some reason remuxer was undefined on firefox after a pretty normal seek(not fast seeking or anything), refactor this to prevent issues like this
    process: (timeToProcess: number) => remuxer.process(timeToProcess),
    getInfo: () => remuxer.getInfo()
  }
})

const resolvers = {
  init
}

export type Resolvers = typeof resolvers

registerListener({
  target: globalThis as unknown as Worker,
  // @ts-ignore
  resolvers
})

globalThis.postMessage('init')
