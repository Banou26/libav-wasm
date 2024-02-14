import { makeCallListener, registerListener } from 'osra'
import type { Chunk } from '..'

// @ts-ignore
import WASMModule from 'libav'
import { queuedDebounceWithLastCall } from '../utils'

const makeModule = (publicPath: string) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    printErr: (text: string) =>
      text.includes('Timestamps are unset in a packet')
        ? undefined
        : console.error(text),
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
    streamRead: (offset: number) => Promise<{ buffer: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>
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

  let readResultPromiseResolve: ((value: Chunk) => void) | undefined
  let readResultPromiseReject: ((reason?: any) => void) | undefined
  let readResultPromise: Promise<Chunk> | undefined

  let resolveCancel: ((value: any) => void) | undefined
  let cancelPromise: Promise<any> | undefined
  let cancelled = false

  let resolveCancelled: ((value: any) => void) | undefined
  let cancelledPromise: Promise<any> | undefined

  const setupCancelPromise = () => {
    cancelled = false
    cancelPromise = new Promise((resolve) => {
      resolveCancel = resolve
    })
    cancelledPromise = new Promise((resolve) => {
      resolveCancelled = resolve
    })
    cancelledPromise.then(setupCancelPromise)
  }

  setupCancelPromise()

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
    streamRead: (_offset: string) =>
      console.log('streamRead', _offset, cancelled) ||
      (cancelled
        ? ({
          buffer: new Uint8Array(0),
          done: false,
          cancelled: true
        })
        : (
          Promise.race([
            cancelPromise.then(() => ({
              buffer: new Uint8Array(0),
              done: false,
              cancelled: true
            })),
            streamRead(Number(_offset))
              .then(({ buffer, done, cancelled }) => console.log('streamRead done') || ({
                buffer: buffer ? new Uint8Array(buffer) : undefined,
                done,
                cancelled
              }))
          ])
        )
      ),
    clearStream: () => clearStream(),
    randomRead: (_offset: string, bufferSize: number) =>
      console.log('randomRead', _offset, bufferSize) ||
      (cancelled
        ? ({
          buffer: new Uint8Array(0),
          done: false,
          cancelled: true
        })
        : (
          Promise.race([
            cancelPromise.then(() => ({
              buffer: new Uint8Array(0),
              done: false,
              cancelled: true
            })),
            randomRead(Number(_offset), bufferSize)
              .then((buffer) => ({
                buffer: buffer ? new Uint8Array(buffer) : undefined,
                done: false,
                cancelled: false
              }))
          ])
        )
      ),
    write: (buffer: Uint8Array) => {
      const newBuffer = new Uint8Array(writeBuffer.byteLength + buffer.byteLength)
      newBuffer.set(writeBuffer)
      newBuffer.set(new Uint8Array(buffer), writeBuffer.byteLength)
      writeBuffer = newBuffer
    },
    flush: async (
      _offset: number, _position: number,
      pts: number, duration: number
    ) => {
      const offset = Number(_offset)
      const position = Number(_position)
      if (!writeBuffer.byteLength) return true
      if (!readResultPromiseResolve) throw new Error('No readResultPromiseResolve on libav flush')
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
    },
    exit: () => {
      console.log('exit')
      if (!resolveCancelled) throw new Error('No resolveCancelled on libav exit')
      resolveCancelled(undefined)
    }
  })

  let remuxer: ReturnType<typeof makeRemuxer> = makeRemuxer()

  let currentTask: Promise<any> | undefined

  const seekQueuedTask = queuedDebounceWithLastCall(0, async (timestamp: number) => {
    console.log('seeking task started')
    if (currentTask) throw new Error('Cannot seek while a task is running')
    try {
      currentTask = remuxer.seek(timestamp)
      await Promise.race([
        currentTask,
        cancelledPromise
      ])
      console.log('seeking task done')
    } catch (err) {
      console.log('seeking task cancelled', err)
    } finally {
      currentTask = undefined
    }
  })

  const seek = async (timestamp: number) => {
    if (currentTask && resolveCancel) {
      resolveCancel(undefined)
    }
    return seekQueuedTask(timestamp)
  }

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
    seek: (timestamp: number) => seek(timestamp),
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
