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

  let streamResultPromiseResolve: (value: ReadableStreamReadResult<Uint8Array>) => void
  let streamResultPromiseReject: (reason?: any) => void
  let streamResultPromise: Promise<ReadableStreamReadResult<Uint8Array>>

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
      if (!currentStream) {
        currentStream = await getStream(offset)
        reader = currentStream.getReader()
      }

      streamResultPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        streamResultPromiseResolve = resolve
        streamResultPromiseReject = reject
      })

      const tryReading = (): Promise<void> | undefined =>
        reader
          ?.read()
          .then(result => ({
            value: result.value,
            done: result.value === undefined
            // done: result.done
          }))
          .then(async (result) => {
            console.log('tryReading', result.done, result.value?.byteLength)
            if (result.done) {
              if (offset >= length) {
                return streamResultPromiseResolve(result)
              }
              currentStream = await getStream(offset)
              reader = currentStream.getReader()
              return tryReading()
            }

            return streamResultPromiseResolve(result)
          })
          .catch((err) => streamResultPromiseReject(err))

      tryReading()

      return (
        streamResultPromise
          .then((value) => ({
            value: value.value,
            done: value.done
          }))
          .catch(err => {
            return {
              value: undefined,
              done: false,
              cancelled: true
            }
          })
      )
    },
    clearStream: async () => {
      currentStream = undefined
      reader = undefined
    },
    randomRead: async (offset: number, bufferSize: number) => {
      const buffer = await randomRead(offset, bufferSize)
      return buffer
    },
    write: async (buffer: Uint8Array) => {
      // console.log('WRITE')
      const newBuffer = new Uint8Array(writeBuffer.byteLength + buffer.byteLength)
      newBuffer.set(writeBuffer)
      newBuffer.set(new Uint8Array(buffer), writeBuffer.byteLength)
      writeBuffer = newBuffer
    },
    flush: async (
      offset: number, position: number,
      pts: number, duration: number
    ) => {
      if (!writeBuffer.byteLength) return
      // console.log('FLUSH', pts, duration)
      readResultPromiseResolve({
        isHeader: false,
        offset,
        buffer: writeBuffer.buffer as Uint8Array,
        pos: position,
        pts,
        duration
      })
      writeBuffer = new Uint8Array(0)
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
    seek: (timestamp: number, flags: SEEK_FLAG) => remuxer.seek(timestamp, flags),
    read: () => {
      readResultPromise = new Promise<Chunk>((resolve, reject) => {
        readResultPromiseResolve = resolve
        readResultPromiseReject = reject
      })
      remuxer.read()
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
