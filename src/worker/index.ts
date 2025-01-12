import { makeCallListener, registerListener } from 'osra'
import type { Chunk } from '..'

// @ts-ignore
import WASMModule from 'libav'
import PQueue from 'p-queue'

const makeModule = (publicPath: string) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    printErr: (text: string) =>
      text.includes('Timestamps are unset in a packet') || (import.meta.env.PROD && text.includes('Read error at pos.'))
        ? undefined
        : console.error(text),
  })

let module: ReturnType<typeof makeModule>

// todo: if seek latency is too slow, because of destroy + init + seek + process, we can use multiple remuxer alrandomReady initialized waiting to seek + process
// todo: We can keep in memory all of the chunks needed to initialize the remuxer

// @ts-ignore
const init = makeCallListener(async (
  { publicPath, length, bufferSize, randomRead, streamRead, clearStream, attachment, subtitle }:
  {
    publicPath: string
    length: number
    bufferSize: number
    randomRead: (offset: number, size: number) => Promise<ArrayBuffer>
    streamRead: (offset: number) => Promise<{ buffer: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>
    clearStream: () => Promise<void>
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  }) => {
  if (!module) module = await makeModule(publicPath)

  let writeBuffer = new Uint8Array(0)

  let readResultPromiseResolve: ((value: Chunk) => void) | undefined
  let readResultPromiseReject: ((reason?: any) => void) | undefined
  let readResultPromise: Promise<Chunk> | undefined

  const setupReadPromise = () => {
    if (readResultPromise) return readResultPromise
    readResultPromise = new Promise<Chunk>((resolve, reject) => {
      readResultPromiseResolve = resolve
      readResultPromiseReject = reject
    })
    readResultPromise
      .then(() => console.log('readResultPromise resolve'))
      .catch(() => console.log('readResultPromise reject'))
    return readResultPromise
  }

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
    streamRead: async (_offset: string) =>
      console.log('streamRead') ||
      Promise.race([
        new Promise(resolve => {
          queue.on('add', function listener() {
            if (queue.size === 0) return
            resolve(undefined)
            queue.off('add', listener)
          })
        })
          .then(() => ({
            buffer: undefined,
            done: false,
            cancelled: true
          })),
        streamRead(Number(_offset))
          .then(({ buffer, done, cancelled }) => ({
            buffer: buffer ? new Uint8Array(buffer) : undefined,
            done,
            cancelled
          }))
      ]),
    clearStream: () => console.log('clearStream') || clearStream(),
    randomRead: async (_offset: string, requestedBufferSize: number) =>
      console.log('randomRead') ||
      randomRead(Number(_offset), requestedBufferSize)
        .then((buffer) => ({
          buffer: buffer ? new Uint8Array(buffer) : undefined,
          done: false,
          cancelled: false
        })),
    write: (buffer: Uint8Array) => {
      console.log('write')
      const newBuffer = new Uint8Array(writeBuffer.byteLength + buffer.byteLength)
      newBuffer.set(writeBuffer)
      newBuffer.set(new Uint8Array(buffer), writeBuffer.byteLength)
      writeBuffer = newBuffer
    },
    flush: async (
      _offset: number, _position: number,
      pts: number, duration: number, isTrailer: boolean
    ) => {
      console.log('flush')
      const offset = Number(_offset)
      const position = Number(_position)
      if (!writeBuffer.byteLength) return true
      if (!readResultPromiseResolve) throw new Error('No readResultPromiseResolve on libav flush')
      readResultPromiseResolve({
        isTrailer,
        offset,
        buffer: writeBuffer.buffer as Uint8Array,
        pos: position,
        pts,
        duration
      })
      readResultPromiseResolve = undefined
      readResultPromiseReject = undefined
      readResultPromise = undefined
      writeBuffer = new Uint8Array(0)
      return false
    },
    exit: () => {
      console.log('exit')
      const _readResultPromiseReject = readResultPromiseReject
      readResultPromiseResolve = undefined
      readResultPromiseReject = undefined
      readResultPromise = undefined
      _readResultPromiseReject?.(new Error('exit'))
    }
  }) as {
    init: () => Promise<void>
    destroy: () => void
    seek: (timestamp: number) => Promise<void>
    read: () => Promise<void>
    getInfo: () => ({
      input: {
        formatName: string
        mimeType: string
        duration: number
        video_mime_type: string
        audio_mime_type: string
      },
      output: {
        formatName: string
        mimeType: string
        duration: number
        video_mime_type: string
        audio_mime_type: string
      }
    })
  }

  let remuxer: ReturnType<typeof makeRemuxer> = makeRemuxer()

  const queue = new PQueue({ concurrency: 1 })

  return {
    init: async () => {
      writeBuffer = new Uint8Array(0)
      module = await makeModule(publicPath)
      remuxer = makeRemuxer()

      const promise = setupReadPromise()
      remuxer.init()
      return promise
    },
    destroy: () => {
      remuxer.destroy()
      // @ts-ignore
      remuxer = undefined
      module = undefined
      writeBuffer = new Uint8Array(0)
    },
    seek: (timestamp: number) => queue.add(() => remuxer.seek(timestamp)),
    read: () => queue.add(async () => {
      const promise = setupReadPromise()
      remuxer.read()
      return promise
    }),
    getInfo: async () => remuxer.getInfo()
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
