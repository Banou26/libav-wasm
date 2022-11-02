import type { Resolvers as WorkerResolvers } from './worker'

import PQueue from 'p-queue'
import { call } from 'osra'

import { Operation } from './shared-buffer_generated'
import { getSharedInterface, notifyInterface, setSharedInterface, State, waitForInterfaceNotification } from './utils'

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
  write: (offset: number, buffer: ArrayBufferLike, pts: number, duration: number, pos: number) => Promise<void> | void
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

  const seek = async (offset: number, whence: SEEK_WHENCE_FLAG) => {
    const resultOffset = await _seek(offset, whence)
    setSharedInterface(sharedArrayBuffer, {
      operation: Operation.Read,
      offset: resultOffset,
      argOffset: 0,
      argWhence: 0
    })
  }

  const read = async (offset: number, size: number) => {
    const readResultBuffer = await _read(offset, size)
    setSharedInterface(sharedArrayBuffer, {
      operation: Operation.Read,
      buffer: readResultBuffer,
      argOffset: offset,
      argBufferSize: 0
    })
  }

  const waitForTransmuxerCall = async () => {
    const result = await waitForInterfaceNotification(sharedArrayBuffer, State.Idle)

    if (result === 'timed-out' || (result === 'not-equal' && new Uint8Array(sharedArrayBuffer)[0] !== 1)) {
      setTimeout(waitForTransmuxerCall, 10)
      return
    }

    const responseSharedInterface = getSharedInterface(sharedArrayBuffer)
    const operation = responseSharedInterface.operation()

    await addBlockingTask(async () => {
      if (operation === Operation.Read) {
        await read(
          responseSharedInterface.argOffset(),
          responseSharedInterface.argBufferSize()
        )
      } else {
        await seek(
          responseSharedInterface.argOffset(),
          responseSharedInterface.argWhence()
        )
      }
      notifyInterface(sharedArrayBuffer, State.Responded)
      await waitForInterfaceNotification(sharedArrayBuffer, State.Responded)
    })
    waitForTransmuxerCall()
  }

  waitForTransmuxerCall()

  return {
    init: () => addTask(() => workerInit()),
    process: (size: number) => addTask(() => workerProcess(size)),
    seek: (timestamp: number, flags: SEEK_FLAG) => addTask(() => workerSeek(timestamp, flags)),
    getInfo: () => getInfo() as Promise<{ input: MediaInfo, output: MediaInfo }>
  }
}

export default makeTransmuxer
