import { makeCallListener, registerListener } from 'osra'
import type { Chunk } from '..'

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
  { publicPath, length, bufferSize, randomRead, streamRead, clearStream, write, attachment, subtitle }:
  {
    publicPath: string
    length: number
    bufferSize: number
    randomRead: (offset: number, size: number) => Promise<ArrayBuffer>
    streamRead: (offset: number) => Promise<{ value: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>
    clearStream: () => Promise<void>
    write: (params: {
      offset: number, arrayBuffer: ArrayBuffer, isHeader: boolean,
      position: number, pts: number, duration: number
    }) => Promise<void> | void
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  }) => {
  if (!module) module = await makeModule(publicPath)

  let writeBuffer = new Uint8Array(0)

  let readResultPromiseResolve: (value: Chunk) => void
  let readResultPromiseReject: (reason?: any) => void
  let readResultPromise: Promise<Chunk>

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
    streamRead: async (offset: number) => {
      console.log('worker streamRead', offset)
      const res = await streamRead(offset)
      console.log('worker streamRead end', offset, res)
      return {
        ...res,
        value: new Uint8Array(res.value)
      }
    },
    clearStream: () => clearStream(),
    randomRead: async (offset: number, bufferSize: number) => {
      console.log('worker randomRead', offset, bufferSize)
      const buffer = await randomRead(offset, bufferSize)
      return buffer
    },
    write: async (buffer: Uint8Array) => {
      console.log('worker write', buffer.byteLength)
      const newBuffer = new Uint8Array(writeBuffer.byteLength + buffer.byteLength)
      newBuffer.set(writeBuffer)
      newBuffer.set(new Uint8Array(buffer), writeBuffer.byteLength)
      writeBuffer = newBuffer
    },
    flush: async (
      offset: number, position: number,
      pts: number, duration: number
    ) => {
      console.log('worker flush', writeBuffer.byteLength)
      if (!writeBuffer.byteLength) return true
      readResultPromiseResolve({
        isHeader: false,
        offset,
        buffer: writeBuffer.buffer as Uint8Array,
        pos: position,
        pts,
        duration
      })
      writeBuffer = new Uint8Array(0)
      return false
    }
  })

  let remuxer: ReturnType<typeof makeRemuxer> = makeRemuxer()

  return {
    init: async () => {
      writeBuffer = new Uint8Array(0)
      module = await makeModule(publicPath)
      remuxer = makeRemuxer()

      readResultPromise = new Promise<Chunk>((resolve, reject) => {
        readResultPromiseResolve = resolve
        readResultPromiseReject = reject
      })
      remuxer.init()
      return readResultPromise
    },
    destroy: () => {
      remuxer.destroy()
      remuxer = undefined
      module = undefined
      writeBuffer = new Uint8Array(0)
    },
    seek: (timestamp: number) => remuxer.seek(timestamp),
    read: () => {
      console.log('worker read')
      readResultPromise = new Promise<Chunk>((resolve, reject) => {
        readResultPromiseResolve = resolve
        readResultPromiseReject = reject
      })
      remuxer.read()
      console.log('worker read end')
      return readResultPromise
    },
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
