import { toStreamChunkSize } from './utils'
import type { Resolvers as WorkerResolvers } from './worker'

import { call } from 'osra'

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  getStream: (offset: number, size?: number) => Promise<ReadableStream<Uint8Array>>
  subtitle: (title: string, language: string, data: string) => Promise<void> | void
  attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void> | void
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
  formatName: string
  mimeType: string
  duration: number
  video_mime_type: string
  audio_mime_type: string
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
  workerUrl,
  workerOptions, 
  randomRead: _randomRead,
  getStream: _getStream,
  write: _write,
  attachment,
  subtitle: _subtitle,
  length,
  bufferSize = 1_000_000
}: MakeTransmuxerOptions) => {
  const worker = new Worker(workerUrl, workerOptions)

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

  const subtitles = new Map<number, Subtitle>()

  let currentStream: ReadableStream<Uint8Array> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  let streamResultPromiseResolve: (value: { value: ArrayBuffer | undefined, done: boolean, cancelled: boolean }) => void
  let streamResultPromiseReject: (reason?: any) => void
  let streamResultPromise: Promise<{ value: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>

  const { init: workerInit, destroy: workerDestroy, read: workerRead, seek: workerSeek, getInfo: getInfo } =
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
        randomRead: async (offset, bufferSize) => {
          console.log('random read', offset, bufferSize)
          const stream = await _getStream(offset, bufferSize)
          const reader = stream.getReader()
          const { value, done } = await reader.read()
          console.log('randomRead done', value, done)
          setTimeout(() => {
            console.log('reader', reader)
          }, 10_000)
          return value?.buffer ?? new ArrayBuffer(0)
        },
        streamRead: async (offset: number) => {
          if (!currentStream) {
            currentStream = await _getStream(offset)
            reader = currentStream.getReader()
          }
    
          streamResultPromise = new Promise<{ value: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>((resolve, reject) => {
            streamResultPromiseResolve = resolve
            streamResultPromiseReject = reject
          })
    
          const tryReading = (): Promise<void> | undefined =>
            reader
              ?.read()
              .then(result => ({
                value: result.value?.buffer,
                done: result.value === undefined,
                cancelled: false
              }))
              .then(async (result) => {
                if (result.done) {
                  reader?.cancel()
                  if (offset >= length) {
                    return streamResultPromiseResolve(result)
                  }
                  currentStream = await _getStream(offset)
                  reader = currentStream.getReader()
                  return tryReading()
                }
    
                return streamResultPromiseResolve(result)
              })
              .catch((err) => streamResultPromiseReject(err))
    
          tryReading()
    
          return (
            streamResultPromise
              .then((value) => ({
                value: value.value,
                done: value.done,
                cancelled: false
              }))
              .catch(err => {
                console.error(err)
                return {
                  value: undefined,
                  done: false,
                  cancelled: true
                }
              })
          )
        },
        clearStream: async () => {
          reader?.cancel()
          currentStream = undefined
          reader = undefined
        },
        write: ({
          isHeader,
          offset,
          arrayBuffer,
          position,
          pts,
          duration
        }) => _write({
          isHeader,
          offset,
          buffer: new Uint8Array(arrayBuffer),
          pts,
          duration,
          pos: position
        })
      }
    )

  const result = {
    init: () => workerInit(),
    destroy: (destroyWorker = false) => {
      if (destroyWorker) {
        worker.terminate()
        return
      }
      return workerDestroy()
    },
    read: () => workerRead(),
    seek: (time: number) => workerSeek(Math.max(0, time) * 1000),
    getInfo: () => getInfo() as Promise<{ input: MediaInfo, output: MediaInfo }>
  }

  return result
}
