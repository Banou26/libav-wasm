/// <reference no-default-lib="true"/>
/// <reference lib="es2015" />
/// <reference lib="webworker" />
import * as flatbuffers from 'flatbuffers'

import { makeCallListener, registerListener } from 'osra'

import WASMModule from 'libav'
import { Interface, Operation } from './shared-buffer_generated'

const module = await WASMModule.default({
  locateFile: (path: string, scriptDirectory: string) => `/dist/${path.replace('/dist', '')}`
})

/** https://ffmpeg.org/doxygen/trunk/avformat_8h.html#ac736f8f4afc930ca1cda0b43638cc678 */
enum SEEK_FLAG {
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

enum SEEK_WHENCE_FLAG {
  SEEK_SET = 0,
  SEEK_CUR = 1 << 0,
  SEEK_END = 1 << 1,
  AVSEEK_SIZE = 1 << 16 //0x10000,
}

const init = makeCallListener(async (
  { length, sharedArrayBuffer, bufferSize }:
  { length: number, sharedArrayBuffer: SharedArrayBuffer, bufferSize: number }, extra) => {
  let currentOffset = 0
  const transmuxer = new module.Transmuxer({
    bufferSize,
    error: (critical, message) => {
      console.log('error', critical, message)
    },
    seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
      if (whence === SEEK_WHENCE_FLAG.SEEK_CUR) {
        currentOffset = currentOffset + offset
        return currentOffset
      }
      if (whence === SEEK_WHENCE_FLAG.SEEK_END) {
        // In this case offset should be a negative number
        currentOffset = length + offset
        return currentOffset
      }
      if (whence === SEEK_WHENCE_FLAG.SEEK_SET) {
        currentOffset = offset
        return currentOffset;
      }
      if (whence === SEEK_WHENCE_FLAG.AVSEEK_SIZE) {
        return length
      }
    },
    read: (bufferSize: number) => {
      const int32Array = new Int32Array(sharedArrayBuffer)
      const uint8Array = new Uint8Array(sharedArrayBuffer)
      const builder = new flatbuffers.Builder(sharedArrayBuffer.byteLength)
      const sharedInterface = Interface.createInterface(builder, 1, Operation.Read, bufferSize)
      builder.finish(sharedInterface)
      const result = builder.asUint8Array()
      uint8Array.set(result)

      Atomics.notify(int32Array, 0)
      Atomics.wait(int32Array, 0, 2)

      const byteBuffer = new flatbuffers.ByteBuffer(uint8Array)
      const responseSharedInterface = Interface.getRootAsInterface(byteBuffer)
      const resultBuffer = responseSharedInterface.bufferArray()
      if (!resultBuffer) throw new Error('Transmuxer read returned null result buffer')

      uint8Array.fill(0)

      const buffer = resultBuffer.buffer
      currentOffset = currentOffset + bufferSize
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: (type, keyframeIndex, size, offset, arrayBuffer, keyframePts, keyframePos, done) => {
      const buffer = new Uint8Array(arrayBuffer.slice())
      chunks.push({ keyframeIndex, size, offset, arrayBuffer: buffer, pts: keyframePts, pos: keyframePos, done })
      if (closed) return
      if (done) {
        closed = true
        if (buffer.byteLength) controller.enqueue(buffer)
        controller.close()
      } else {
        controller.enqueue(buffer)
      }
    }
  })

  return {
    seek: () => {

    },
    process: () => {
      
    }
  }
})

const resolvers = {
  init
}

export type Resolvers = typeof resolvers
registerListener({ target: globalThis, resolvers })
