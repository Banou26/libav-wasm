import type { Resolvers as WorkerResolvers } from './worker'

import PQueue from 'p-queue'
import * as flatbuffers from 'flatbuffers'
import { call } from 'osra'

import { Interface, Operation } from './shared-buffer_generated'
import { notifyInterface, setSharedInterface, waitForInterfaceNotification } from './utils'

/** https://ffmpeg.org/doxygen/trunk/avformat_8h.html#ac736f8f4afc930ca1cda0b43638cc678 */
export enum SEEK_FLAG {
  NONE = 0,
  /** seek backward */
  AVSEEK_FLAG_BACKWARD = 1 << 0,
  /** seeking based on position in bytes */
  AVSEEK_FLAG_BYTE = 1 << 1,
  /** seek to any frame, even non-keyframes */
  AVSEEK_FLAG_ANY = 1 << 2,
  /** seeking based on frame number */
  AVSEEK_FLAG_FRAME = 1 << 3
}

export enum SEEK_WHENCE_FLAG {
  SEEK_SET = 0,
  SEEK_CUR = 1 << 0,
  SEEK_END = 1 << 1,
  AVSEEK_SIZE = 1 << 16 //0x10000,
}

export type MakeTransmuxerOptions = {
  read: (offset: bigint, size: number) => Promise<Uint8Array>
  seek: (offset: bigint, whence: SEEK_WHENCE_FLAG) => Promise<bigint>
  length: number
  sharedArrayBufferSize: number
  bufferSize: number
}

export const makeTransmuxer = async ({
  read: _read,
  seek: _seek,
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
  
  let currentOffset = 0n
  const { process: workerProcess, seek: workerSeek } = await target(
    'init',
      {
        length,
        sharedArrayBuffer,
        bufferSize
      }
    )

  const seek = async (offset: bigint, whence: SEEK_WHENCE_FLAG) => {
    const resultOffset = await _seek(offset, whence)
    setSharedInterface(sharedArrayBuffer, {
      state: 2,
      operation: Operation.Read,
      offset: resultOffset,
      argBufferSize: 0,
      argOffset: 0n,
      argWhence: 0
    })
    notifyInterface(sharedArrayBuffer, 0)
  }

  const read = async (size: number) => {
    const readResultBuffer = await _read(currentOffset, size)
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
    if (operation === Operation.Read) await read(responseSharedInterface.argBufferSize())
    if (operation === Operation.Seek) await seek(responseSharedInterface.argOffset(), responseSharedInterface.argWhence())
    waitForTransmuxerCall()
  }

  waitForTransmuxerCall()
}

export default makeTransmuxer
