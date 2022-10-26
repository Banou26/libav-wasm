/// <reference no-default-lib="true"/>
/// <reference lib="es2015" />
/// <reference lib="webworker" />

import { makeCallListener, registerListener } from 'osra'

import WASMModule from 'libav'

import {  Operation, State } from './shared-buffer_generated'
import { freeInterface, getSharedInterface, setSharedInterface, waitSyncForInterfaceNotification } from './utils'
import { SEEK_WHENCE_FLAG } from '.'

const module = await WASMModule.default({
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
  let currentOffset = 0n
  const transmuxer = new module.Transmuxer({
    bufferSize,
    error: (critical, message) => {
      console.log('error', critical, message)
    },
    seek: (offset: bigint, whence: SEEK_WHENCE_FLAG) => {
      console.log('seeking', offset, whence)
      setSharedInterface(sharedArrayBuffer, {
        state: State.Requested,
        operation: Operation.Seek,
        argOffset: offset,
        argWhence: whence
      })
      waitSyncForInterfaceNotification(sharedArrayBuffer, 0, State.Responded)
      const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
      const offsetResult = responseSharedInterface.offset()
      freeInterface(sharedArrayBuffer)
      console.log('seeked', offsetResult)
      return offsetResult
    },
    read: (bufferSize: number) => {
      console.log('reading', bufferSize)
      setSharedInterface(sharedArrayBuffer, {
        state: State.Requested,
        operation: Operation.Read,
        argOffset: currentOffset,
        argBufferSize: bufferSize
      })
      waitSyncForInterfaceNotification(sharedArrayBuffer, 0, State.Responded)
      const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
      const buffer: Uint8Array | null = structuredClone(responseSharedInterface.bufferArray())
      if (!buffer) throw new Error('Transmuxer read returned null result buffer')
      currentOffset = currentOffset + BigInt(buffer.byteLength)
      freeInterface(sharedArrayBuffer)
      console.log('read', buffer)
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: (type, keyframeIndex, size, offset, arrayBuffer, keyframePts, keyframePos, done) => {
      console.log('writing', arrayBuffer)
      const buffer = new Uint8Array(arrayBuffer.slice())
      console.log('wrote', buffer)
      write(buffer)
    }
  })

  return {
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
