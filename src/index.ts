import type { Resolvers as WorkerResolvers } from './worker'

import PQueue from 'p-queue'
import { call } from 'osra'

import { SEEK_FLAG, SEEK_WHENCE_FLAG } from './utils'

export {
  SEEK_FLAG,
  SEEK_WHENCE_FLAG
}

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerPath: string
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  seek: (currentOffset: number, offset: number, whence: SEEK_WHENCE_FLAG) => Promise<number>
  subtitle: (title: string, language: string, data: string) => Promise<void> | void
  attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void> | void
  write: (chunk: Chunk) => Promise<void> | void
  length: number
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
  bufferSize = 1_000_000
}: MakeTransmuxerOptions) => {
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

  const apiQueue = new PQueue()

  const addTask = <T extends (...args: any) => any>(func: T) =>
    apiQueue.add<Awaited<ReturnType<T>>>(func)
  
  const subtitles = new Map<number, Subtitle>()

  const { init: workerInit, destroy: workerDestroy, process: workerProcess, seek: workerSeek, getInfo } =
    await target(
      'init',
      {
        publicPath,
        length,
        bufferSize,
        subtitle: async (streamIndex, isHeader, data, ...rest) => {
          if (isHeader) {
            const [language, title] = rest as string[]
            const subtitle = {
              streamIndex,
              header: data,
              language,
              title,
              dialogues: []
            }
            subtitles.set(streamIndex, subtitle)
            _subtitle(subtitle.title, subtitle.language, `${subtitle.header.trim()}\n`)
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
        read: (offset, bufferSize) => _read(offset, bufferSize),
        seek: (currentOffset, offset, whence) => _seek(currentOffset, offset, whence),
        write: (chunk) => _write({ ...chunk, buffer: new Uint8Array(chunk.buffer) })
      }
    )

  const result = {
    init: () => addTask(() => workerInit()),
    destroy: (destroyWorker = false) => {
      if (destroyWorker) {
        worker.terminate()
        return
      }
      return addTask(() => workerDestroy())
    },
    process: (size: number) => addTask(() => workerProcess(size)),
    seek: (time: number) => addTask(() => workerSeek(time)),
    getInfo: () => getInfo() as Promise<{ input: MediaInfo, output: MediaInfo }>
  }

  return result
}

export default makeTransmuxer
