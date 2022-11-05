import type { Resolvers as WorkerResolvers } from './worker'

import PQueue from 'p-queue'
import { call } from 'osra'

import { Operation } from './shared-buffer_generated'
import { getSharedInterface, notifyInterface, setSharedInterface, State, waitForInterfaceNotification } from './utils'
import { ApiMessage, Read, ReadRequest, ReadResponse, Seek, SeekRequest, SeekResponse, Write, WriteRequest, WriteResponse } from './gen/src/shared-memory-api_pb'

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
  read: (offset: number, size: number) => Promise<Uint8Array>
  seek: (offset: number, whence: SEEK_WHENCE_FLAG) => Promise<number>
  subtitle: (title: string, language: string, data: string) => Promise<void> | void
  attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void> | void
  write: (params: {
    isHeader: boolean
    offset: number
    buffer: Uint8Array
    pts: number
    duration: number
    pos: number
  }) => Promise<void> | void
  length: number
  sharedArrayBufferSize: number
  bufferSize: number
}

export type Dialogue = {
  index: number
  data: string
  startTime: number
  endTime: number
  layerIndex: number
  dialogue: string
}

export type Subtitle = {
  streamIndex: number
  language: string
  title: string
  header: string
  dialogues: Dialogue[]
}

export type MediaInfo = {
  formatName: string,
  mimeType: string,
  duration: number
}

// converts ms to 'h:mm:ss.cc' format
const convertTimestamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .slice(11, 22)
    .replace(/^00/, '0')

export const makeTransmuxer = async ({
  read: _read,
  seek: _seek,
  write: _write,
  attachment,
  subtitle: _subtitle,
  length,
  sharedArrayBufferSize = 10_000_000,
  bufferSize = 1_000_000
}: MakeTransmuxerOptions) => {
  const sharedArrayBuffer = new SharedArrayBuffer(sharedArrayBufferSize)
  const dataview = new DataView(sharedArrayBuffer)
  const uint8Array = new Uint8Array(sharedArrayBuffer)
  const worker = new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module' })

  await new Promise((resolve, reject) => {
    const onMessage = (message: MessageEvent) => {
      if (message.data !== 'init') return
      resolve(undefined)
      worker.removeEventListener('message', onMessage)
    }
    worker.addEventListener('message', onMessage)
    setTimeout(reject, 30_000)
  })

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
  
  const subtitles = new Map<number, Subtitle>()

  const { init: workerInit, process: workerProcess, seek: workerSeek, getInfo } =
    await target(
      'init',
      {
        length,
        sharedArrayBuffer,
        bufferSize,
        subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
          if (isHeader) {
          const [language, title] = rest as string[]
            subtitles.set(streamIndex, {
              streamIndex,
              header: data,
              language,
              title,
              dialogues: []
            })
            return
          }
          const subtitle = subtitles.get(streamIndex)
          if (subtitle?.dialogues.includes(data)) return
          if (!subtitle) throw new Error('Subtitle data was received but no instance was found.')
          const [startTime, endTime] = rest as number[]
          const [dialogueIndex, layer] = data.split(',')
          const startTimestamp = convertTimestamp(startTime)
          const endTimestamp = convertTimestamp(endTime)
          const dialogueContent = data.replace(`${dialogueIndex},${layer},`, '')
          const newSubtitle = {
            ...subtitle,
            dialogues: [
              ...subtitle?.dialogues ?? [],
              {
                index: Number(dialogueIndex),
                startTime,
                endTime,
                data,
                layerIndex: Number(layer),
                dialogue: `Dialogue: ${layer},${startTimestamp},${endTimestamp},${dialogueContent}`
              }
            ].sort((dialogue, dialogue2) => dialogue.index - dialogue2.index)
          }
          subtitles.set(streamIndex, newSubtitle)
          const subtitleString = `${subtitle.header.trim()}\n${newSubtitle.dialogues.map(({ dialogue }) => dialogue).join('\n').trim()}`
          _subtitle(subtitle.title, subtitle.language, subtitleString)
        },
        attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => {
          attachment(filename, mimetype, buffer)
        },
        write: async (offset:number, buffer: ArrayBufferLike, pts: number, duration: number, pos: number) => {
          await _write(offset, buffer, pts, duration, pos)
        }
      }
    )

  const seek = async ({ offset, whence }: SeekRequest) => {
    const resultOffset = await _seek(offset, whence)
    const messageLength = dataview.getUint32(4)
    const responseMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
    const seekResponse = new SeekResponse({ offset: resultOffset })
    ;(responseMessage.endpoint.value as Seek).response = seekResponse
    return responseMessage
  }

  const read = async ({ offset, bufferSize }: ReadRequest) => {
    const readResultBuffer = await _read(offset, bufferSize)
    const messageLength = dataview.getUint32(4)
    const responseMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
    const readResponse = new ReadResponse({ buffer: readResultBuffer })
    ;(responseMessage.endpoint.value as Read).response = readResponse
    return responseMessage
  }

  let GOPBuffer: Uint8Array | undefined
  let unflushedWrite: any
  const write = async ({
    buffer, bufferIndex, keyframeDuration, keyframePos, keyframePts,
    lastFrameDuration, lastFramePts, offset, timebaseDen, timebaseNum
  }: WriteRequest) => {
    // console.log('libav write',
    //   'buffer', buffer, 'bufferIndex', bufferIndex, 'keyframeDuration', keyframeDuration, 'keyframePos', keyframePos, 'keyframePts', keyframePts,
    //   'lastFrameDuration', lastFrameDuration, 'lastFramePts', lastFramePts, 'offset', offset, 'timebaseDen', timebaseDen, 'timebaseNum', timebaseNum
    // )
    const pts = ((keyframePts - keyframeDuration) / timebaseDen) / timebaseNum
    const duration = (((lastFramePts) / timebaseDen) / timebaseNum) - pts

    // header chunk
    if (bufferIndex === -2) {
      await _write({
        isHeader: true,
        offset,
        buffer,
        pts,
        duration,
        pos: keyframePos
      })
      const messageLength = dataview.getUint32(4)
      const responseMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
      const readResponse = new WriteResponse({ bytesWritten: buffer.byteLength })
      ;(responseMessage.endpoint.value as Write).response = readResponse
      GOPBuffer = undefined
      unflushedWrite = undefined
      return responseMessage
    }

    // flush buffers
    if (bufferIndex === -1) {
      const messageLength = dataview.getUint32(4)
      const responseMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
      const readResponse = new WriteResponse({ bytesWritten: buffer.byteLength })
      ;(responseMessage.endpoint.value as Write).response = readResponse
      // this case happens right after headerChunk
      if (!GOPBuffer) return responseMessage
      await _write({
        isHeader: false,
        offset,
        buffer: GOPBuffer,
        pts,
        duration,
        pos:  keyframePos
      })
      GOPBuffer = undefined
      unflushedWrite = undefined
      return responseMessage
    }

    if (!GOPBuffer) {
      GOPBuffer = buffer
    } else {
      const _buffer = GOPBuffer
      GOPBuffer = new Uint8Array(GOPBuffer.byteLength + buffer.byteLength)
      GOPBuffer.set(_buffer)
      GOPBuffer.set(buffer, _buffer.byteLength)
    }

    unflushedWrite = {
      isHeader: false,
      offset,
      buffer,
      pts,
      duration,
      pos: keyframePos
    }

    const messageLength = dataview.getUint32(4)
    const responseMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
    const readResponse = new WriteResponse({ bytesWritten: buffer.byteLength })
    ;(responseMessage.endpoint.value as Write).response = readResponse
    return responseMessage
  }

  const waitForTransmuxerCall = async () => {
    const result = await waitForInterfaceNotification(sharedArrayBuffer, State.Idle)

    if (result === 'timed-out' || (result === 'not-equal' && new Uint8Array(sharedArrayBuffer)[0] !== 1)) {
      setTimeout(waitForTransmuxerCall, 10)
      return
    }
    const messageLength = dataview.getUint32(4)
    const requestMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))

    await addBlockingTask(async () => {
      const request = requestMessage.endpoint.value?.request
      if (!request) throw new Error('Shared memory api request is undefined')

      const response =
        await (requestMessage.endpoint.case === 'read' ? read(request as ReadRequest)
        : requestMessage.endpoint.case === 'write' ? write(request as WriteRequest)
        : requestMessage.endpoint.case === 'seek' ? seek(request as SeekRequest)
        : undefined)

      if (!response) throw new Error('Shared memory api response is undefined')
      const responseBuffer = response.toBinary()
      dataview.setUint32(4, responseBuffer.byteLength)
      uint8Array.set(responseBuffer, 8)

      notifyInterface(sharedArrayBuffer, State.Responded)
      await waitForInterfaceNotification(sharedArrayBuffer, State.Responded)
    })
    waitForTransmuxerCall()
  }

  waitForTransmuxerCall()

  return {
    init: () => addTask(() => workerInit()),
    process: (size: number) => addTask(async() => {
      await workerProcess(size)
      if (unflushedWrite) {
        await _write({
          ...unflushedWrite,
          buffer: GOPBuffer
        })
        GOPBuffer = undefined
        unflushedWrite = undefined
      }
    }),
    seek: (timestamp: number, flags: SEEK_FLAG) => addTask(() => workerSeek(timestamp, flags)),
    getInfo: () => getInfo() as Promise<{ input: MediaInfo, output: MediaInfo }>
  }
}

export default makeTransmuxer
