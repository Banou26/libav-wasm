/// <reference no-default-lib="true"/>
/// <reference lib="es2015" />
/// <reference lib="webworker" />

import { makeCallListener, registerListener } from 'osra'

import WASMModule from 'libav'

import {  Operation } from './shared-buffer_generated'
import { freeInterface, getSharedInterface, notifyInterface, setSharedInterface, State, waitSyncForInterfaceNotification } from './utils'
import { SEEK_FLAG, SEEK_WHENCE_FLAG } from '.'

const module = await WASMModule({
  locateFile: (path: string, scriptDirectory: string) => `/dist/${path.replace('/dist', '')}`
})

// @ts-ignore
const init = makeCallListener(async (
  { length, sharedArrayBuffer, bufferSize, write }:
  {
    length: number
    sharedArrayBuffer: SharedArrayBuffer
    bufferSize: number
    write: (offset:number, buffer: ArrayBufferLike, keyframePts: number, keyframePos: number) => Promise<void>
  }, extra) => {
  let currentOffset = 0
  const transmuxer = new module.Transmuxer({
    length,
    bufferSize,
    error: (critical, message) => {
      console.log('worker error', critical, message)
    },
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
      const [startTime, endTime] = isHeader ? [] as number[] : rest as number[]
      const [language, title] = isHeader ? rest as string[] : [] as string[]
      console.log('SUBTITLE', streamIndex, isHeader, language, title, startTime, endTime, data)
    },
    attachment: (filename: string, mimetype: string, buffer: Uint8Array) => {
      console.log('ATTACHMENT', filename, mimetype, buffer)
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
    write: async (offset: number, arrayBuffer: Uint8Array, keyframePts: number, keyframePos: number) => {
      const buffer = new Uint8Array(arrayBuffer.slice())
      await write(offset, buffer.buffer, keyframePts, keyframePos)
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
