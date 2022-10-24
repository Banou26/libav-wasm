import type { Resolvers as WorkerResolvers } from './worker'

import PQueue from 'p-queue'
import * as flatbuffers from 'flatbuffers'
import { call } from 'osra'

import { Interface, Operation } from './shared-buffer_generated'
import { notifyInterface, setSharedInterface, waitForInterfaceNotification } from './utils'



export type MakeTransmuxerOptions = {
  read: (offset: number, size: number) => Promise<Uint8Array>
  length: number
  sharedArrayBufferSize: number
  bufferSize: number
}

export const makeTransmuxer = async ({
  read,
  length,
  sharedArrayBufferSize = 10_000_000,
  bufferSize = 10_000_000
}: MakeTransmuxerOptions) => {
  const sharedArrayBuffer = new SharedArrayBuffer(sharedArrayBufferSize)
  const worker = new Worker('/worker.js', { type: 'module' })
  const target = call<WorkerResolvers>(worker)

  const blockingQueue = new PQueue({ concurrency: 1 })
  const apiQueue = new PQueue()

  const addBlockingTask = <T>(task: (...args: any[]) => T) =>
    blockingQueue.add(async () => {
      apiQueue.pause()
      try {
        return await task()
      } finally {
        apiQueue.start()
      }
    })

  const addTask = <T extends (...args: any) => any>(func: T) =>
    apiQueue.add<Awaited<ReturnType<T>>>(func)
  
  let currentOffset = 0
  const { process, seek } = await target(
    'init',
      {
        length,
        sharedArrayBuffer,
        bufferSize
      }
    )

  const _read = async (offset: number, size: number) => {
    const readResultBuffer = await read(offset, size)
    setSharedInterface(sharedArrayBuffer, {
      state: 2,
      operation: Operation.Read,
      buffer: readResultBuffer,
      argBufferSize: 0,
      argOffset: 0n,
      argWhence: 0
    })
    notifyInterface(sharedArrayBuffer, 0)
  }

  const waitForTransmuxerCall = async () => {
    const uint8Array = new Uint8Array(sharedArrayBuffer)
    await waitForInterfaceNotification(sharedArrayBuffer, 0, 1)
    const byteBuffer = new flatbuffers.ByteBuffer(uint8Array)
    const responseSharedInterface = Interface.getRootAsInterface(byteBuffer)
    const operation = responseSharedInterface.operation()
    if (operation === Operation.Read) await _read(currentOffset, responseSharedInterface.argBufferSize())
    waitForTransmuxerCall()
  }

  waitForTransmuxerCall()
}

export default transmuxer
