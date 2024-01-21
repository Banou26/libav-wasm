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

// todo: if seek latency is too slow, because of destroy + init + seek + process, we can use multiple remuxer already initialized waiting to seek + process
// todo: We can keep in memory all of the chunks needed to initialize the remuxer

// @ts-ignore
const init = makeCallListener(async (
  { publicPath, length, bufferSize, read, seek, write, attachment, subtitle }:
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
    seek: (currentOffset: number, offset: number, whence: SEEK_WHENCE_FLAG) => Promise<number>
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  }) => {
  if (!module) module = await makeModule(publicPath)
  let currentOffset = 0
  let currentBuffer = new Uint8Array(0)
  const makeTransmuxer = () => new module.Transmuxer({
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
    read: async (offset: number, bufferSize: number) => {
      const buffer = await read(offset, bufferSize)
      currentOffset = offset + buffer.byteLength
      return buffer
    },
    write: async (
      offset: number, buffer: Uint8Array,
      isHeader: boolean, isFlushing: boolean,
      position: number, pts: number, duration: number
    ) => {
      if (isFlushing && currentBuffer.byteLength > 0) {
        write({
          isHeader,
          offset,
          arrayBuffer: currentBuffer.buffer,
          position,
          pts,
          duration
        })
        currentBuffer = new Uint8Array(0)
        if (isHeader) return
      }

      const newBuffer = new Uint8Array(currentBuffer.byteLength + buffer.byteLength)
      newBuffer.set(currentBuffer)
      newBuffer.set(new Uint8Array(buffer), currentBuffer.byteLength)
      currentBuffer = newBuffer
    }
  })

  let remuxer: ReturnType<typeof makeTransmuxer> = makeTransmuxer()

  let firstInit = true
  return {
    init: async () => {
      currentOffset = 0
      currentBuffer = new Uint8Array(0)
      module = await makeModule(publicPath)
      remuxer = makeTransmuxer()
      await remuxer.init()
      if (firstInit) firstInit = false
    },
    destroy: () => {
      remuxer.destroy()
      remuxer = undefined
      module = undefined
      currentOffset = 0
      currentBuffer = new Uint8Array(0)
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
