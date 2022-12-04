import type { Resolvers as WorkerResolvers } from './worker'

import PQueue from 'p-queue'
import { call } from 'osra'

import { notifyInterface, State, waitForInterfaceNotification, SEEK_FLAG, SEEK_WHENCE_FLAG } from './utils'
import {
  ApiMessage, Read, ReadRequest, ReadResponse, Seek,
  SeekRequest, SeekResponse, Write, WriteRequest, WriteResponse
} from './gen/src/shared-memory-api_pb'

export {
  SEEK_FLAG,
  SEEK_WHENCE_FLAG
}

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerPath: string
  read: (offset: number, size: number) => Promise<Uint8Array>
  seek: (currentOffset: number, offset: number, whence: SEEK_WHENCE_FLAG) => Promise<number>
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

export type Chunk = {
  isHeader: boolean
  offset: number
  buffer: Uint8Array
  pts: number
  duration: number
  pos: number
}

// converts ms to 'h:mm:ss.cc' format
const convertTimestamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .slice(11, 22)
    .replace(/^00/, '0')

export const makeTransmuxer = async ({
  publicPath,
  workerPath,
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
  const worker = new Worker(workerPath, { type: 'module' })

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
  let lastChunk: Chunk | undefined

  const { init: workerInit, destroy: workerDestroy, process: workerProcess, seek: workerSeek, getInfo } =
    await target(
      'init',
      {
        publicPath,
        length,
        sharedArrayBuffer,
        bufferSize,
        subtitle: async (streamIndex, isHeader, data, ...rest) => {
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
          if (subtitle?.dialogues.some(({ data: _data }) => _data === data)) return
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
        attachment: async (filename, mimetype, buffer) => attachment(filename, mimetype, buffer),
      }
    )

  const seek = async ({ currentOffset, offset, whence }: SeekRequest) => {
    const resultOffset = await _seek(currentOffset, offset, whence)
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

  let GOPBuffer: Uint8Array | undefined = undefined
  let unflushedWrite: Chunk | undefined = undefined
  let headerBuffer: Uint8Array | undefined = undefined
  let headerFinished = false
  let processBufferChunks: Chunk[] = []
  const write = async ({
    buffer, bufferIndex, keyframeDuration, keyframePos, keyframePts,
    lastFramePts, offset, timebaseDen, timebaseNum
  }: WriteRequest) => {
    const pts = ((keyframePts - keyframeDuration) / timebaseDen) / timebaseNum
    const duration = (((lastFramePts) / timebaseDen) / timebaseNum) - pts

    const messageLength = dataview.getUint32(4)
    const responseMessage = ApiMessage.fromBinary(uint8Array.slice(8, 8 + messageLength))
    const readResponse = new WriteResponse({ bytesWritten: buffer.byteLength })
    ;(responseMessage.endpoint.value as Write).response = readResponse
    // header chunk
    if (bufferIndex === -2) {
      if (headerFinished) return responseMessage
      if (!headerBuffer) {
        headerBuffer = buffer
        return responseMessage
      } else {
        const _headerBuffer = headerBuffer
        headerBuffer = new Uint8Array(headerBuffer.byteLength + buffer.byteLength)
        headerBuffer.set(_headerBuffer)
        headerBuffer.set(buffer, _headerBuffer.byteLength)
      }
      const chunk = {
        isHeader: true,
        offset,
        buffer: headerBuffer,
        pts,
        duration,
        pos: keyframePos
      }
      processBufferChunks = [...processBufferChunks, chunk]
      headerFinished = true
      await _write(chunk)
      return responseMessage
    }

    // flush buffers
    if (bufferIndex === -1) {
      if (!unflushedWrite) return responseMessage
      // this case happens right after headerChunk
      if (!GOPBuffer) return responseMessage
      lastChunk = {
        ...unflushedWrite,
        buffer: GOPBuffer,
      }
      processBufferChunks = [...processBufferChunks, lastChunk]
      await _write(lastChunk)
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
      // this happens randomly and throws an error, but it doesn't break playback
      if (!request) {
        setTimeout(waitForTransmuxerCall, 10)
        return
      }

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

  const result = {
    init: () => addTask(async () => {
      GOPBuffer = undefined
      unflushedWrite = undefined
      headerBuffer = undefined
      // headerFinished = false
      processBufferChunks = []
      await workerInit()
    }),
    destroy: (destroyWorker = false) => {
      if (destroyWorker) {
        worker.terminate()
        return
      }
      return addTask(() => workerDestroy())
    },
    process: (size: number) => addTask(async() => {
      processBufferChunks = []
      await workerProcess(size)
      if (unflushedWrite) {
        const chunk = {
          ...unflushedWrite,
          buffer: GOPBuffer!
        }
        processBufferChunks = [...processBufferChunks, chunk]
        await _write(chunk)
        GOPBuffer = undefined
        unflushedWrite = undefined
      }
      const writtenChunks = processBufferChunks
      console.log('writtenChunks', writtenChunks, processBufferChunks)
      processBufferChunks = []
      return writtenChunks
    }),
    seek: (time: number) => {
      return addTask(async () => {
        console.log('lastChunk', lastChunk, time)
        const p = performance.now()
        if (lastChunk && (lastChunk.pts > time)) {
          console.log('re-init')
          await workerDestroy()
          GOPBuffer = undefined
          unflushedWrite = undefined
          headerBuffer = undefined
          // headerFinished = false
          processBufferChunks = []
          await workerInit()
          const p2 = performance.now()
          console.log('REINIIIIIIIIIIIIIIIIIIIIIIT', p2 - p)
        }
        await result.process(bufferSize)
        console.log('SEEKKKKKKKK NOWWWWWWWWWWWWWWWW')
        const p3 = performance.now()
        await workerSeek(
          Math.max(0, time) * 1000,
          SEEK_FLAG.NONE
        )
        const p2 = performance.now()
        console.log('SEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEk', p2 - p3)
      })
    },
    getInfo: () => getInfo() as Promise<{ input: MediaInfo, output: MediaInfo }>
  }

  return result
}

export default makeTransmuxer
