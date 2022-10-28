import * as flatbuffers from 'flatbuffers'

import { Interface, Operation } from './shared-buffer_generated'

export enum State {
  Idle = 0,
  Requested = 1,
  Responded = 2
}

type SharedInterface = {
  operation: Operation
  argOffset: number
  argWhence: number
  argBufferSize: number
  buffer: Uint8Array
  offset: number
}

export const setSharedInterface = (
  sharedArrayBuffer: SharedArrayBuffer,
  options:
    SharedInterface
    | Pick<SharedInterface, 'operation'> 
    & (
      Pick<SharedInterface, 'argOffset' | 'argWhence'>
      | Pick<SharedInterface, 'argOffset' | 'argWhence' | 'offset'>
      | Pick<SharedInterface, 'argOffset' | 'argBufferSize'>
      | Pick<SharedInterface, 'argOffset' | 'argBufferSize' | 'buffer'>
    )
) => {
  const uint8Array = new Uint8Array(sharedArrayBuffer)
  const builder = new flatbuffers.Builder(sharedArrayBuffer.byteLength - 4)
  const sharedInterface = Interface.createInterface(
    builder,
    options.operation,
    'argOffset' in options ? options.argOffset : 0,
    'argWhence' in options ? options.argWhence : 0,
    'argBufferSize' in options ? options.argBufferSize : 0,
    'buffer' in options
      ? Interface.createBufferVector(builder, options.buffer)
      : Interface.createBufferVector(builder, new Uint8Array()),
    'offset' in options ? options.offset : 0
  )
  // console.log('sharedInterface', sharedInterface)
  builder.finish(sharedInterface)
  const result = builder.asUint8Array()
  uint8Array.set(result, 4)
}

export const getSharedInterface = (sharedArrayBuffer: SharedArrayBuffer) => {
  const uint8Array = new Uint8Array(sharedArrayBuffer.slice(4))
  const byteBuffer = new flatbuffers.ByteBuffer(uint8Array)
  return Interface.getRootAsInterface(byteBuffer)
}

export const notifyInterface = (sharedArrayBuffer: SharedArrayBuffer, value: State) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  int32Array.set([value], 0)
  return Atomics.notify(int32Array, 0)
}

export const waitForInterfaceNotification = (
  sharedArrayBuffer: SharedArrayBuffer,
  value: State
): Promise<'ok' | 'timed-out'> | 'not-equal' => {
    const int32Array = new Int32Array(sharedArrayBuffer)
    const result = Atomics.waitAsync(int32Array, 0, value, 1_000)

    if (result.value === 'not-equal') {
      return result.value
    }
    return result.value as Promise<"ok" | "timed-out">
  }

export const waitSyncForInterfaceNotification = (sharedArrayBuffer: SharedArrayBuffer, value: State) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  console.log('GONNA WAIT FOR NOTIFICATION', value)
  return Atomics.wait(int32Array, 0, value)
}

export const freeInterface = (sharedArrayBuffer: SharedArrayBuffer) => new Uint8Array(sharedArrayBuffer).fill(0)
