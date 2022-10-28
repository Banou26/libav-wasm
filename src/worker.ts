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
  console.log('worker sharedArrayBuffer', sharedArrayBuffer)
  let currentOffset = 0
  const transmuxer = new module.Transmuxer({
    length,
    bufferSize,
    error: (critical, message) => {
      console.log('worker error', critical, message)
    },
    seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
      console.log('worker seeking', offset, whence)
      setSharedInterface(sharedArrayBuffer, {
        operation: Operation.Seek,
        argOffset: offset,
        argWhence: whence
      })
      notifyInterface(sharedArrayBuffer, State.Requested)
      console.log('WORKER BEFORE SEEK NOTIFICATION RESPONSE', [...new Uint8Array(sharedArrayBuffer.slice(0, 5))])
      const res = waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)
      console.log('WORKER SEEK NOTIFICATION RESPONSE', res)
      const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
      const offsetResult = responseSharedInterface.offset()
      freeInterface(sharedArrayBuffer)
      console.log('worker seeked', offsetResult)
      return offsetResult
    },
    read: (bufferSize: number) => {
      console.log('worker reading', bufferSize, [...new Uint8Array(sharedArrayBuffer.slice(0, 5))])
      setSharedInterface(sharedArrayBuffer, {
        operation: Operation.Read,
        argOffset: currentOffset,
        argBufferSize: bufferSize
      })
      notifyInterface(sharedArrayBuffer, State.Requested)
      console.log('WORKER BEFORE READ NOTIFICATION RESPONSE', [...new Uint8Array(sharedArrayBuffer.slice(0, 5))])
      const res = waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)
      console.log('WORKER READ NOTIFICATION RESPONSE', res)
      const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
      const sharedBuffer: Uint8Array | null = structuredClone(responseSharedInterface.bufferArray())
      if (!sharedBuffer) throw new Error('Transmuxer read returned null result buffer')
      const buffer = new ArrayBuffer(sharedBuffer.byteLength)
      const uint8Buffer = new Uint8Array(buffer)
      uint8Buffer.set(sharedBuffer)
      currentOffset = currentOffset + buffer.byteLength
      freeInterface(sharedArrayBuffer)
      console.log('worker read BUFFER', uint8Buffer)
      console.log('worker read', buffer)
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: (type, keyframeIndex, size, offset, arrayBuffer, keyframePts, keyframePos, done) => {
      console.log('worker writing', arrayBuffer)
      const buffer = new Uint8Array(arrayBuffer.slice())
      console.log('worker wrote', buffer)
      write(buffer)
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
