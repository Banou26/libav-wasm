import * as flatbuffers from 'flatbuffers'

import { Interface, Operation } from './shared-buffer_generated'

type SharedInterface = {
  state: number
  operation: Operation
  argOffset: bigint
  argWhence: number
  argBufferSize: number
  buffer: Uint8Array
}

export const setSharedInterface = (
  sharedArrayBuffer: SharedArrayBuffer,
  { state, operation, argOffset, argWhence, argBufferSize, buffer }: SharedInterface
) => {
  const uint8Array = new Uint8Array(sharedArrayBuffer)
  const builder = new flatbuffers.Builder(sharedArrayBuffer.byteLength)
  const bufferVector = Interface.createBufferVector(builder, buffer)
  const sharedInterface = Interface.createInterface(
    builder,
    state,
    operation,
    argOffset,
    argWhence,
    argBufferSize,
    bufferVector
  )
  builder.finish(sharedInterface)
  const result = builder.asUint8Array()
  uint8Array.set(result)
}

export const getSharedInterface = (sharedArrayBuffer: SharedArrayBuffer) => {
  const uint8Array = new Uint8Array(sharedArrayBuffer)
  const byteBuffer = new flatbuffers.ByteBuffer(uint8Array)
  return Interface.getRootAsInterface(byteBuffer)
}

export const notifyInterface = (sharedArrayBuffer: SharedArrayBuffer, index: number) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  return Atomics.notify(int32Array, index)
}

export const waitForInterfaceNotification = (sharedArrayBuffer: SharedArrayBuffer, index: number, value: number) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  return Atomics.waitAsync(int32Array, index, value).value as Promise<"ok" | "timed-out">
}
