import type { Chunk } from '..'

import { makeCallListener, registerListener } from 'osra'

// @ts-ignore
import WASMModule from '../../dist'

import { SEEK_FLAG, SEEK_WHENCE_FLAG } from '../utils'

const makeModule = (publicPath: string) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`
  })

let module: ReturnType<typeof makeModule>

// todo: if seek latency is too slow, because of destroy + init + seek + process, we can use multiple transmuxer already initialized waiting to seek + process
// todo: We can keep in memory all of the chunks needed to initialize the transmuxer

// @ts-ignore
const init = makeCallListener(async (
  { publicPath, length, bufferSize, read, seek, write, attachment, subtitle }:
  {
    publicPath: string
    length: number
    bufferSize: number
    read: (offset: number, size: number) => Promise<ArrayBuffer>
    write: (chunk: Omit<Chunk, 'buffer'> & { buffer: ArrayBuffer }) => Promise<void> | void
    seek: (currentOffset: number, offset: number, whence: SEEK_WHENCE_FLAG) => Promise<number>
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  }) => {
  if (!module) module = await makeModule(publicPath)
  let initBuffers: Uint8Array[] = []
  let currentOffset = 0
  let initRead = 0
  let lastChunk: Chunk | undefined
  let GOPBuffer: Uint8Array | undefined = undefined
  let unflushedWrite: Chunk | undefined = undefined
  let headerBuffer: Uint8Array | undefined = undefined
  let headerFinished = false
  let processBufferChunks: Chunk[] = []
  const makeTransmuxer = () => new module.Transmuxer({
    length,
    bufferSize,
    error: (critical: boolean, message: string) => {
      console.log('worker error', critical, message)
    },
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
      subtitle(streamIndex, isHeader, data, ...rest)
    },
    attachment: (filename: string, mimetype: string, _buffer: ArrayBuffer) => {
      const buffer = new ArrayBuffer(_buffer.byteLength)
      attachment(filename, mimetype, buffer)
    },
    seek: async (offset: number, whence: SEEK_WHENCE_FLAG) => seek(currentOffset, offset, whence),
    read: async (offset: number, bufferSize: number) => {
      const buffer = await read(offset, bufferSize)
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: async (
      offset: number, _buffer: Uint8Array, timebaseNum: number,
      timebaseDen: number, lastFramePts: number, lastFrameDuration: number,
      keyframeDuration: number, keyframePts: number, keyframePos: number,
      bufferIndex: number
    ) => {
      const buffer = structuredClone(new Uint8Array(_buffer))
      const pts = ((keyframePts - keyframeDuration) / timebaseDen) / timebaseNum
      const duration = (((lastFramePts) / timebaseDen) / timebaseNum) - pts
      // header chunk
      if (bufferIndex === -2) {
        if (headerFinished) return
        if (!headerBuffer) {
          headerBuffer = buffer
          return
        } else {
          const _headerBuffer = headerBuffer
          headerBuffer = new Uint8Array(headerBuffer.byteLength + buffer.byteLength)
          headerBuffer.set(_headerBuffer)
          headerBuffer.set(buffer, _headerBuffer.byteLength)
        }
        const chunk = {
          isHeader: true,
          offset,
          buffer: headerBuffer,
          pts,
          duration,
          pos: keyframePos
        }
        processBufferChunks = [...processBufferChunks, chunk]
        headerFinished = true
        await write({...chunk, buffer: new Uint8Array(chunk.buffer).buffer })
        return
      }

      // flush buffers
      if (bufferIndex === -1) {
        if (!unflushedWrite) return
        // this case happens right after headerChunk
        if (!GOPBuffer) return
        lastChunk = {
          ...unflushedWrite,
          buffer: GOPBuffer,
        }
        processBufferChunks = [...processBufferChunks, lastChunk]
        await write({...lastChunk, buffer: new Uint8Array(lastChunk.buffer).buffer })
        GOPBuffer = undefined
        unflushedWrite = undefined
        return
      }

      if (!GOPBuffer) {
        GOPBuffer = buffer
      } else {
        const _buffer = GOPBuffer
        GOPBuffer = new Uint8Array(GOPBuffer.byteLength + buffer.byteLength)
        GOPBuffer.set(_buffer)
        GOPBuffer.set(buffer, _buffer.byteLength)
      }

      unflushedWrite = {
        isHeader: false,
        offset,
        buffer: buffer,
        pts,
        duration,
        pos: keyframePos
      }
    }
  })

  let transmuxer: ReturnType<typeof makeTransmuxer> = makeTransmuxer()

  let firstInit = true
  const result = {
    init: async () => {
      GOPBuffer = undefined
      unflushedWrite = undefined
      headerBuffer = undefined
      processBufferChunks = []
      initRead = 0
      currentOffset = 0
      module = await makeModule(publicPath)
      transmuxer = makeTransmuxer()
      await transmuxer.init(firstInit)
      initRead = -1
      if (firstInit) firstInit = false
    },
    destroy: () => {
      transmuxer.destroy()
      transmuxer = undefined
      module = undefined
      currentOffset = 0
    },
    seek: async (timestamp: number) => {
      const time = Math.max(0, timestamp) * 1000
      if (lastChunk && (lastChunk.pts > time)) {
        await result.destroy()
        GOPBuffer = undefined
        unflushedWrite = undefined
        headerBuffer = undefined
        processBufferChunks = []
        await result.init()
      }
      await result.process(bufferSize)
      await transmuxer.seek(
        time,
        SEEK_FLAG.NONE
      )
    },
    process: async (size: number) => {
      processBufferChunks = []
      await transmuxer.process(size)
      if (unflushedWrite) {
        const chunk = {
          ...unflushedWrite,
          buffer: GOPBuffer!
        }
        processBufferChunks = [...processBufferChunks, chunk]
        await write({...chunk, buffer: new Uint8Array(chunk.buffer).buffer })
        GOPBuffer = undefined
        unflushedWrite = undefined
      }
      const writtenChunks = processBufferChunks
      processBufferChunks = []
      return writtenChunks.map(chunk => ({...chunk, buffer: new Uint8Array(chunk.buffer).buffer }))
      
    },
    getInfo: () => transmuxer.getInfo()
  }
  return result
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
