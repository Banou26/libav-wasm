/// <reference no-default-lib="true"/>
/// <reference lib="es2015" />
/// <reference lib="webworker" />

import { makeCallListener, registerListener } from 'osra'

import WASMModule from 'libav'
import PQueue from 'p-queue'

import {  Operation } from './shared-buffer_generated'
import { freeInterface, getSharedInterface, notifyInterface, setSharedInterface, State, waitSyncForInterfaceNotification } from './utils'
import { SEEK_FLAG, SEEK_WHENCE_FLAG } from '.'

const queue = new PQueue({ concurrency: 1 })
const queueCall = <T extends (...args: any) => any>(func: T) =>
  queue.add<Awaited<ReturnType<T>>>(func)


const module = await WASMModule({
  locateFile: (path: string, scriptDirectory: string) => `/dist/${path.replace('/dist', '')}`
})

// @ts-ignore
const init = makeCallListener(async (
  { length, sharedArrayBuffer, bufferSize, attachment, subtitle, write }:
  {
    length: number
    sharedArrayBuffer: SharedArrayBuffer
    bufferSize: number
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
    write: (offset:number, buffer: ArrayBufferLike, pts: number, duration: number, pos: number, bufferIndex: number) => Promise<void>
  }, extra) => {

  let GOPBuffer: Uint8Array | undefined
  let currentOffset = 0
  
  const transmuxer = new module.Transmuxer({
    length,
    bufferSize,
    error: (critical, message) => {
      console.log('worker error', critical, message)
    },
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
      subtitle(streamIndex, isHeader, data, ...rest)
    },
    attachment: (filename: string, mimetype: string, _buffer: ArrayBuffer) => {
      const buffer = new ArrayBuffer(_buffer.byteLength)
      attachment(filename, mimetype, buffer)
    },
    seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
      setSharedInterface(sharedArrayBuffer, {
        operation: Operation.Seek,
        argOffset: offset,
        argWhence: whence
      })
      notifyInterface(sharedArrayBuffer, State.Requested)
      waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)
      const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
      const offsetResult = responseSharedInterface.offset()
      if (whence !== SEEK_WHENCE_FLAG.AVSEEK_SIZE) currentOffset = offsetResult
      freeInterface(sharedArrayBuffer)
      notifyInterface(sharedArrayBuffer, State.Idle)
      return offsetResult
    },
    read: (offset: number, bufferSize: number) => {
      setSharedInterface(sharedArrayBuffer, {
        operation: Operation.Read,
        argOffset: offset,
        argBufferSize: bufferSize
      })
      notifyInterface(sharedArrayBuffer, State.Requested)
      waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)
      const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
      const sharedBuffer: Uint8Array | null = structuredClone(responseSharedInterface.bufferArray())
      if (!sharedBuffer) throw new Error('Transmuxer read returned null result buffer')
      const buffer = new ArrayBuffer(sharedBuffer.byteLength)
      const uint8Buffer = new Uint8Array(buffer)
      uint8Buffer.set(sharedBuffer)
      currentOffset = offset + buffer.byteLength
      freeInterface(sharedArrayBuffer)
      notifyInterface(sharedArrayBuffer, State.Idle)
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: (offset: number, arrayBuffer: Uint8Array, timebaseNum: number, timebaseDen: number, lastFramePts: number, lastFrameduration: number, keyframeDuration: number, keyframePts: number, keyframePos: number, bufferIndex: number) => {
      const pts = ((keyframePts - keyframeDuration) / timebaseDen) / timebaseNum
      const duration = (((lastFramePts) / timebaseDen) / timebaseNum) - pts
      if (bufferIndex === -1) {
        if (!GOPBuffer) return
        write(offset, GOPBuffer.buffer, pts, duration, keyframePos, bufferIndex)
        GOPBuffer = undefined
        return
      }
      const buffer = new Uint8Array(arrayBuffer.slice())
      if (!GOPBuffer) {
        GOPBuffer = buffer
      } else {
        const _buffer = GOPBuffer
        GOPBuffer = new Uint8Array(GOPBuffer.byteLength + buffer.byteLength)
        GOPBuffer.set(_buffer)
        GOPBuffer.set(buffer, _buffer.byteLength)
      }

      setTimeout(() => {
        if (!GOPBuffer) return
        queueCall(() => {
          if (!GOPBuffer) return
          write(offset, GOPBuffer.buffer, pts, duration, keyframePos, bufferIndex)
          GOPBuffer = undefined
        })
      }, 0)
    }
  })

  return {
    init: () => {
      transmuxer.init()
    },
    seek: (timestamp: number, flags: SEEK_FLAG) => {
      transmuxer.seek(timestamp, flags)
    },
    process: (size: number) => {
      transmuxer.process(size)
    }
  }
})

const resolvers = {
  init
}

export type Resolvers = typeof resolvers

registerListener({
  target: globalThis,
  resolvers
})

globalThis.postMessage('init')
