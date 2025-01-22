import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'
import PQueue from 'p-queue'

export type SubtitleFragment =
  | {
    type: 'header'
    streamIndex: number
    data: string
    format: string[]
    language: string
    title: string
  }
  | {
    type: 'dialogue'
    streamIndex: any
    startTime: number
    endTime: number
    dialogueIndex: number
    layer: number
    dialogue: string
    fields: Record<string, string>
  }


export type RemuxerOptions = {
  resolvedPromise: Promise<void>
  length: number
  bufferSize: number
}

type WASMReadFunction = (offset: number, size: number) => Promise<{
  resolved: Uint8Array
  rejected: boolean
}>

export interface RemuxerInstance {
  new(options: RemuxerOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{}>
  destroy: () => void
  seek: (read: WASMReadFunction, timestamp: number) => Promise<{}>
  read: (read: WASMReadFunction) => Promise<{}>
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    print: (text: string) => log(false, text),
    printErr: (text: string) => log(true, text),
  }) as Promise<{ Remuxer: RemuxerInstance }>

type Fragment = {
  buffer: ArrayBuffer
  offset: number
  position: number
  pts: number
  duration: number
  isTrailer: boolean
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

type WASMVector<T> = {
  size: () => number
  get: (index: number) => T
}

const vectorToArray = <T>(vector: WASMVector<T>) =>
  Array(vector.size())
    .fill(undefined)
    .map((_, index) => vector.get(index))

const resolvers = {
  makeRemuxer: async (
    { publicPath, length, bufferSize, log, read }:
    {
      publicPath: string
      length: number
      bufferSize: number
      log: (isError: boolean, text: string) => Promise<void>
      read: (offset: number, size: number) => Promise<ArrayBuffer>
    }
  ) => {
    const { Remuxer } = await makeModule(publicPath, log)

    let abortController: AbortController | undefined
    const queue = new PQueue({ concurrency: 1 })
    const _remuxer = new Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize })
    const remuxer = {
      init: (read) => _remuxer.init(read).then(result => ({
        data: new Uint8Array(result.data.buffer),
        attachments: vectorToArray(result.attachments),
        subtitles: vectorToArray(result.subtitles),
        info: {
          input: {
            audioMimeType: result.info.input.audio_mime_type,
            duration: result.info.input.duration,
            formatName: result.info.input.formatName,
            mimeType: result.info.input.mimeType,
            videoMimeType: result.info.input.video_mime_type
          },
          output: {
            audioMimeType: result.info.output.audio_mime_type,
            duration: result.info.output.duration,
            formatName: result.info.output.formatName,
            mimeType: result.info.output.mimeType,
            videoMimeType: result.info.output.video_mime_type
          }
        }
      })),
      destroy: () => _remuxer.destroy(),
      seek: (read, timestamp) => _remuxer.seek(read, timestamp),
      read: (read) => _remuxer.read(read)
    } as RemuxerInstance

    const runTask = <T extends any>(func: (abortedPromise: Promise<void>) => Promise<T>) => {
      if (abortController) abortController.abort()
      const newAbortController = new AbortController()
      abortController = newAbortController
      const abortedPromise = abortControllerToPromise(newAbortController)
      return queue.add(() => func(abortedPromise), { signal: abortController.signal })
    }

    const wasmRead = (abortedPromise: Promise<void>) => (offset: number, size: number) =>
      Promise.race([
        read(offset, size)
          .then(buffer => console.log('read', buffer) || ({
            resolved: new Uint8Array(buffer),
            rejected: false
          })),
        abortedPromise
          .then(() => { throw new Error('This error should never happen') })
          .catch(() => ({
            resolved: new Uint8Array(0),
            rejected: true
          }))
      ])

    runTask((abortedPromise) => remuxer.init(wasmRead(abortedPromise)))
      .then((res) => console.log('init done', res))
      .catch(err => console.error('init err', err))

    return {
      destroy: async () => remuxer.destroy(),
      init: () => runTask((abortedPromise) => remuxer.init(wasmRead(abortedPromise))),
      seek: (timestamp: number) => runTask((abortedPromise) => remuxer.seek(wasmRead(abortedPromise), timestamp)),
      read: () => runTask((abortedPromise) => remuxer.read(wasmRead(abortedPromise)))
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { remote: globalThis, local: globalThis })
