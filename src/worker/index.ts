import { makeCallListener, registerListener } from 'osra'

import WASMModule from 'libav'

import { freeInterface, notifyInterface, State, waitSyncForInterfaceNotification } from '../utils'
import { SEEK_FLAG, SEEK_WHENCE_FLAG } from '..'
import { ApiMessage, Read, Seek, Write } from '../gen/src/shared-memory-api_pb'

const makeModule = () =>
  WASMModule({
    locateFile: (path: string, scriptDirectory: string) => `/dist/${path.replace('/dist', '')}`
  })

let module: ReturnType<typeof makeModule> = await makeModule()

// todo: if seek latency is too slow, because of destroy + init + seek + process, we can use multiple transmuxer already initialized waiting to seek + process
// todo: We can keep in memory all of the chunks needed to initialize the transmuxer

// @ts-ignore
const init = makeCallListener(async (
  { length, sharedArrayBuffer, bufferSize, attachment, subtitle, write }:
  {
    length: number
    sharedArrayBuffer: SharedArrayBuffer
    bufferSize: number
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
    write: (offset:number, buffer: ArrayBufferLike, pts: number, duration: number, pos: number, bufferIndex: number) => Promise<void>
  }, extra) => {

  const dataview = new DataView(sharedArrayBuffer)
  let currentOffset = 0

  const makeTransmuxer = () => new module.Transmuxer({
    length,
    bufferSize,
    error: (critical, message) => {
      console.log('worker error', critical, message)
    },
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
      subtitle(streamIndex, isHeader, data, ...rest)
    },
    attachment: (filename: string, mimetype: string, _buffer: ArrayBuffer) => {
      const buffer = new ArrayBuffer(_buffer.byteLength)
      attachment(filename, mimetype, buffer)
    },
    seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
      const request = new ApiMessage({
        endpoint: {
          case: 'seek',
          value: {
            request: {
              currentOffset,
              offset,
              whence
            }
          }
        }
      })
      const uint8Array = new Uint8Array(sharedArrayBuffer)
      const requestBuffer = request.toBinary()
      dataview.setUint32(4, requestBuffer.byteLength)
      uint8Array.set(requestBuffer, 8)

      notifyInterface(sharedArrayBuffer, State.Requested)
      waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)

      const messageLength = dataview.getUint32(4)
      const response = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
      const resultOffset = (response.endpoint.value as Seek).response!.offset

      if (whence !== SEEK_WHENCE_FLAG.AVSEEK_SIZE) currentOffset = resultOffset
      freeInterface(sharedArrayBuffer)
      notifyInterface(sharedArrayBuffer, State.Idle)

      return resultOffset
    },
    read: (offset: number, bufferSize: number) => {
      const request = new ApiMessage({
        endpoint: {
          case: 'read',
          value: {
            request: {
              offset,
              bufferSize
            }
          }
        }
      })
      const uint8Array = new Uint8Array(sharedArrayBuffer)
      const requestBuffer = request.toBinary()
      dataview.setUint32(4, requestBuffer.byteLength)
      uint8Array.set(requestBuffer, 8)

      notifyInterface(sharedArrayBuffer, State.Requested)
      waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)

      const messageLength = dataview.getUint32(4)
      const response = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
      const resultBuffer = (response.endpoint.value as Read).response!.buffer

      currentOffset = offset + resultBuffer.byteLength
      freeInterface(sharedArrayBuffer)
      notifyInterface(sharedArrayBuffer, State.Idle)

      return {
        buffer: resultBuffer,
        size: resultBuffer.byteLength
      }
    },
    write: (
      offset: number, arrayBuffer: Uint8Array, timebaseNum: number,
      timebaseDen: number, lastFramePts: number, lastFrameDuration: number,
      keyframeDuration: number, keyframePts: number, keyframePos: number,
      bufferIndex: number
    ) => {
      const request = new ApiMessage({
        endpoint: {
          case: 'write',
          value: {
            request: {
              buffer: arrayBuffer,
              bufferIndex,
              keyframeDuration,
              keyframePts,
              keyframePos,
              lastFrameDuration,
              lastFramePts,
              offset,
              timebaseDen,
              timebaseNum
            }
          }
        }
      })

      const uint8Array = new Uint8Array(sharedArrayBuffer)
      const requestBuffer = request.toBinary()
      dataview.setUint32(4, requestBuffer.byteLength)
      uint8Array.set(requestBuffer, 8)

      notifyInterface(sharedArrayBuffer, State.Requested)
      waitSyncForInterfaceNotification(sharedArrayBuffer, State.Requested)

      const messageLength = dataview.getUint32(4)
      const response = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
      const resultBytesWritten = (response.endpoint.value as Write).response!.bytesWritten

      freeInterface(sharedArrayBuffer)
      notifyInterface(sharedArrayBuffer, State.Idle)

      return resultBytesWritten
    }
  })

  let transmuxer: ReturnType<typeof makeTransmuxer> = makeTransmuxer()

  let firstInit = true
  return {
    init: async () => {
      module = await makeModule()
      transmuxer = makeTransmuxer()
      transmuxer.init(firstInit)
      if (firstInit) firstInit = false
    },
    destroy: () => {
      transmuxer.destroy()
      transmuxer = undefined
      module = undefined
    },
    seek: (timestamp: number, flags: SEEK_FLAG) => transmuxer.seek(timestamp, flags),
    process: (size: number) => transmuxer.process(size),
    getInfo: () => transmuxer.getInfo()
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
