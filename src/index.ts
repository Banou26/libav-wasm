import type { Resolvers, Resolvers as WorkerResolvers } from './worker'

import { expose } from 'osra'

import { toStreamChunkSize } from './utils'
import type { SubtitleFragment } from './worker'
import PQueue from 'p-queue'

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  getStream: (offset: number, size?: number) => Promise<ReadableStream<Uint8Array>>
  subtitle: (subtitleFragment: SubtitleFragment) => Promise<void>
  attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  fragment: (fragment: Fragment) => Promise<void>
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

export type Fragment = {
  isTrailer: boolean
  offset: number
  buffer: ArrayBuffer
  pts: number
  duration: number
  position: number
}

// converts ms to 'h:mm:ss.cc' format
const convertTimestamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .slice(11, 22)
    .replace(/^00/, '0')

const abortControllerToPromise = (abortController: AbortController) => new Promise<void>((resolve, reject) => {
  abortController.signal.addEventListener('abort', () => {
    reject()
  })
})

export const makeRemuxer = async ({
  publicPath,
  workerUrl,
  workerOptions, 
  getStream,
  attachment,
  subtitle,
  fragment,
  length,
  bufferSize = 1_000_000
}: MakeTransmuxerOptions) => {
  const worker = new Worker(workerUrl, workerOptions)

  const { makeRemuxer } = await expose<Resolvers>({}, { remote: worker, local: worker })

  let currentStream: ReadableStream<Uint8Array> | undefined
  let currentStreamOffset: number | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined
  let readAbortController: AbortController | undefined
  let seekToTimestamp: number | undefined

  const queue = new PQueue({ concurrency: 1 })

  const remuxer = await makeRemuxer({
    publicPath,
    length,
    bufferSize,
    log: async (isError, text) => {
      if (isError) console.error(text)
      else console.log(text)
    },
    read: async (offset: number) => {
      if (
        !currentStream ||
        (currentStreamOffset && currentStreamOffset + bufferSize !== offset)
      ) {
        reader?.cancel()
        currentStream = await getStream(offset)
        reader = currentStream.getReader() as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
      }

      if (!reader) throw new Error('No reader found')

      currentStreamOffset = offset

      return reader.read().then(({ value }) => value?.buffer ?? new ArrayBuffer(0))
    },
    attachment: async (filename, mimetype, buffer) => attachment(filename, mimetype, buffer),
    subtitle: (subtitleFragment: SubtitleFragment) => subtitle(subtitleFragment),
    fragment: (_fragment) => fragment(_fragment)
  })

  const queueTask = (func: () => Promise<void>) =>
    queue.add(async () => {
      readAbortController = new AbortController()
      try {
        await func()
      } finally {}
      readAbortController = undefined
    })

  const result = {
    init: () => queueTask(() => remuxer.init()),
    destroy: () => remuxer.destroy(),
    seek: async (timestamp: number) => {
      if (readAbortController) {
        const abortedPromise = abortControllerToPromise(readAbortController)
        readAbortController.abort()
        try {
          await abortedPromise
        } finally {}
      }
      if (queue.pending > 0) return queue.onIdle()
      const queuedTask = queueTask(() => remuxer.seek(timestamp))
      queuedTask.then(() => {
        if (seekToTimestamp) result.seek(seekToTimestamp)
      })
      return queuedTask
    },
    read: () => queueTask(() => remuxer.read()),
    getInfo: () => remuxer.getInfo()
  }

  return result

  // await new Promise((resolve, reject) => {
  //   const onMessage = (message: MessageEvent) => {
  //     if (message.data !== 'init') return
  //     resolve(undefined)
  //     worker.removeEventListener('message', onMessage)
  //   }
  //   worker.addEventListener('message', onMessage)
  //   setTimeout(reject, 30_000)
  // })

  // const target = call<WorkerResolvers>(worker)

  // const subtitles = new Map<number, Subtitle>()

  // // let currentStream: ReadableStream<Uint8Array> | undefined
  // // let currentStreamOffset: number | undefined
  // // let reader: ReadableStreamDefaultReader<Uint8Array> | undefined


  // const { init: workerInit, destroy: workerDestroy, read: workerRead, seek: workerSeek, getInfo: getInfo } =
  //   await target(
  //     'init',
  //     {
  //       publicPath,
  //       length,
  //       bufferSize,
  //       subtitle: async (streamIndex, isHeader, data, ...rest) => {
  //         if (isHeader) {
  //           const [language, title] = rest as string[]
  //           const subtitle = {
  //             streamIndex,
  //             header: data,
  //             language,
  //             title,
  //             dialogues: []
  //           }
  //           subtitles.set(streamIndex, subtitle)
  //           _subtitle(subtitle.title, subtitle.language, `${subtitle.header.trim()}\n`)
  //           return
  //         }
  //         const subtitle = subtitles.get(streamIndex)
  //         if (subtitle?.dialogues.some(({ data: _data }) => _data === data)) return
  //         if (!subtitle) throw new Error('Subtitle data was received but no instance was found.')
  //         const [startTime, endTime] = rest as number[]
  //         const [dialogueIndex, layer] = data.split(',')
  //         const startTimestamp = convertTimestamp(startTime)
  //         const endTimestamp = convertTimestamp(endTime)
  //         const dialogueContent = data.replace(`${dialogueIndex},${layer},`, '')
  //         const newSubtitle = {
  //           ...subtitle,
  //           dialogues: [
  //             ...subtitle?.dialogues ?? [],
  //             {
  //               index: Number(dialogueIndex),
  //               startTime,
  //               endTime,
  //               data,
  //               layerIndex: Number(layer),
  //               dialogue: `Dialogue: ${layer},${startTimestamp},${endTimestamp},${dialogueContent}`
  //             }
  //           ].sort((dialogue, dialogue2) => dialogue.index - dialogue2.index)
  //         }
  //         subtitles.set(streamIndex, newSubtitle)
  //         const subtitleString = `${subtitle.header.trim()}\n${newSubtitle.dialogues.map(({ dialogue }) => dialogue).join('\n').trim()}`
  //         _subtitle(subtitle.title, subtitle.language, subtitleString)
  //       },
  //       attachment: async (filename, mimetype, buffer) => attachment(filename, mimetype, buffer),
  //       randomRead: async (offset, bufferSize) => {
  //         const stream = toStreamChunkSize(bufferSize)(await _getStream(offset, bufferSize))
  //         const reader = stream.getReader()
  //         const { value, done } = await reader.read()
  //         reader.cancel()
  //         return value?.buffer ?? new ArrayBuffer(0)
  //       },
  //       streamRead: async (offset: number) => {
  //         if (
  //           !currentStream ||
  //           (currentStreamOffset && currentStreamOffset + bufferSize !== offset)
  //         ) {
  //           reader?.cancel()

  //           currentStream = await _getStream(offset)
  //           reader = currentStream.getReader()
  //         }

  //         if (!reader) throw new Error('No reader found')

  //         currentStreamOffset = offset
    
  //         return (
  //           reader
  //             .read()
  //             .then(({ value, done }) => ({
  //               buffer: value?.buffer,
  //               done,
  //               cancelled: false
  //             }))
  //         )
  //       },
  //       clearStream: async () => {
  //         reader?.cancel()
  //         currentStream = undefined
  //         reader = undefined
  //       }
  //     }
  //   )

  // const result = {
  //   init: () => workerInit(),
  //   destroy: (destroyWorker = false) => {
  //     if (destroyWorker) {
  //       worker.terminate()
  //       return
  //     }
  //     return workerDestroy()
  //   },
  //   read: () => workerRead(),
  //   seek: (time: number) => workerSeek(Math.max(0, time) * 1000),
  //   getInfo: () => getInfo() as Promise<{ input: MediaInfo, output: MediaInfo }>
  // }

  // return result
}
