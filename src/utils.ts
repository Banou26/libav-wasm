import * as flatbuffers from 'flatbuffers'

import { Interface, Operation, State } from './shared-buffer_generated'

type SharedInterface = {
  state: State
  operation: Operation
  argOffset: bigint
  argWhence: number
  argBufferSize: number
  buffer: Uint8Array
  offset: bigint
}

export const setSharedInterface = (
  sharedArrayBuffer: SharedArrayBuffer,
  options:
    SharedInterface
    | (
      Pick<SharedInterface, 'state' | 'operation'>
      & (
        Pick<SharedInterface, 'argOffset' | 'argWhence'>
        | Pick<SharedInterface, 'argOffset' | 'argWhence' | 'offset'>
        | Pick<SharedInterface, 'argOffset' | 'argBufferSize'>
        | Pick<SharedInterface, 'argOffset' | 'argBufferSize' | 'buffer'>
      )
    )
) => {
  const uint8Array = new Uint8Array(sharedArrayBuffer)
  const builder = new flatbuffers.Builder(sharedArrayBuffer.byteLength)
  const bufferVector = Interface.createBufferVector(builder, uint8Array)
  const sharedInterface = Interface.createInterface(
    builder,
    options.state,
    options.operation,
    'argOffset' in options ? options.argOffset : 0n,
    'argWhence' in options ? options.argWhence : 0,
    'argBufferSize' in options ? options.argBufferSize : 0,
    bufferVector,
    'offset' in options ? options.offset : 0n
  )
  builder.finish(sharedInterface)
  const result = builder.asUint8Array()
  uint8Array.set(result)
  notifyInterface(sharedArrayBuffer, 0)
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

export const waitForInterfaceNotification = (sharedArrayBuffer: SharedArrayBuffer, index: number, value: State) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  return Atomics.waitAsync(int32Array, index, value).value as Promise<"ok" | "timed-out">
}

export const waitSyncForInterfaceNotification = (sharedArrayBuffer: SharedArrayBuffer, index: number, value: State) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  return Atomics.wait(int32Array, index, value)
}

export const freeInterface = (sharedArrayBuffer: SharedArrayBuffer) => {
  setSharedInterface(sharedArrayBuffer, {
    state: State.Idle,
    operation: Operation.Idle,
    argOffset: 0n,
    argWhence: 0,
    argBufferSize: 0,
    buffer: new Uint8Array(),
    offset: 0n,
  })
}
