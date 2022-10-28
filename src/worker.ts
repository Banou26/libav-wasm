/// <reference no-default-lib="true"/>
/// <reference lib="es2015" />
/// <reference lib="webworker" />

import { makeCallListener, registerListener } from 'osra'

import WASMModule from 'libav'

import {  Operation } from './shared-buffer_generated'
import { freeInterface, getSharedInterface, notifyInterface, setSharedInterface, State, waitSyncForInterfaceNotification } from './utils'
import { SEEK_WHENCE_FLAG } from '.'

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
    write: (buffer: Uint8Array) => Promise<void>
  }, extra) => {
  let currentOffset = 0
  const transmuxer = new module.Transmuxer({
    length,
    bufferSize,
    error: (critical, message) => {
      console.log('worker error', critical, message)
    },
    seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
      console.group()
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
      console.groupEnd()
      return offsetResult
    },
    read: (bufferSize: number) => {
      console.group()
      setSharedInterface(sharedArrayBuffer, {
        operation: Operation.Read,
        argOffset: currentOffset,
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
      currentOffset = currentOffset + buffer.byteLength
      freeInterface(sharedArrayBuffer)
      notifyInterface(sharedArrayBuffer, State.Idle)
      console.groupEnd()
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: (type, keyframeIndex, size, offset, arrayBuffer, keyframePts, keyframePos, done) => {
      const buffer = new Uint8Array(arrayBuffer.slice())
      write(buffer.buffer)
    }
  })

  return {
    init: () => {
      transmuxer.init()
    },
    seek: () => {
      transmuxer.seek()
    },
    process: () => {
      transmuxer.process()
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
