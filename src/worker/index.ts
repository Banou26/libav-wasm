import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'
import PQueue from 'p-queue'

export type RemuxerInstanceSubtitleFragment =
  | {
    isHeader: true
    streamIndex: number
    data: Uint8Array
    format: string[]
    language: string
    title: string
    start: string
    end: string
  }

export type SubtitleFragment =
  | {
    type: 'header'
    streamIndex: number
    content: string
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
    content: string
    fields: Record<string, string>
  }

export type RemuxerInstanceAttachment = {
  filename: string
  mimetype: string
  data: Uint8Array
}

export type Attachment = {
  filename: string
  mimetype: string
  data: ArrayBuffer
}

export type RemuxerInstanceOptions = {
  resolvedPromise: Promise<void>
  length: number
  bufferSize: number
}

type WASMReadFunction = (offset: number, size: number) => Promise<{
  resolved: Uint8Array
  rejected: boolean
}>

export interface RemuxerInstance {
  new(options: RemuxerInstanceOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{
    data: WASMVector<Uint8Array>
    attachments: WASMVector<RemuxerInstanceAttachment>
    subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
    info: {
      input: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
      output: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
    }
  }>
  destroy: () => void
  seek: (read: WASMReadFunction, timestamp: number) => Promise<void>
  read: (read: WASMReadFunction) => Promise<{
    data: WASMVector<Uint8Array>
    subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
    finished: boolean
  }>
}

export type Remuxer = {
  new(options: RemuxerInstanceOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{
    data: ArrayBuffer
    attachments: Attachment[]
    subtitles: SubtitleFragment[]
    info: {
      input: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
      output: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
    }
  }>
  destroy: () => void
  seek: (read: WASMReadFunction, timestamp: number) => Promise<void>
  read: (read: WASMReadFunction) => Promise<{
    data: ArrayBuffer
    subtitles: SubtitleFragment[]
    finished: boolean
  }>
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    print: (text: string) => log(false, text),
    printErr: (text: string) => log(true, text),
  }) as Promise<{ Remuxer: RemuxerInstance }>

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

const uint8VectorToUint8Array = (vector: WASMVector<Uint8Array>) => {
  const arrays = vectorToArray(vector)
  const length = arrays.reduce((acc, arr) => acc + arr.length, 0)
  const buffer = new Uint8Array(length)
  let offset = 0
  for (const arr of arrays.reverse()) {
    buffer.set(arr, offset)
    offset += arr.length
  }
  return buffer
}

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
        data: uint8VectorToUint8Array(result.data).buffer,
        attachments: vectorToArray(result.attachments).map(attachment => ({
          filename: attachment.filename,
          mimetype: attachment.mimetype,
          data: new Uint8Array(attachment.data).buffer
        })),
        subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
          if (!_subtitle.isHeader) throw new Error('Subtitle type is not header')
          const { isHeader, data, ...subtitle } = _subtitle
          return {
            ...subtitle,
            type: 'header',
            content: new TextDecoder().decode(data)
          }
        }),
        info: {
          input: {
            audioMimeType: result.info.input.audioMimeType,
            duration: result.info.input.duration,
            formatName: result.info.input.formatName,
            mimeType: result.info.input.mimeType,
            videoMimeType: result.info.input.videoMimeType
          },
          output: {
            audioMimeType: result.info.output.audioMimeType,
            duration: result.info.output.duration,
            formatName: result.info.output.formatName,
            mimeType: result.info.output.mimeType,
            videoMimeType: result.info.output.videoMimeType
          }
        }
      })),
      destroy: () => _remuxer.destroy(),
      seek: (read, timestamp) => _remuxer.seek(read, timestamp),
      read: (read) => _remuxer.read(read).then(result => ({
        data: uint8VectorToUint8Array(result.data).buffer,
        subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
          if (_subtitle.isHeader) throw new Error('Subtitle type is header')
          const { isHeader, data, ...subtitle } = _subtitle
          return {
            ...subtitle,
            type: 'dialogue',
            content: new TextDecoder().decode(data)
          }
        }),
        finished: result.finished
      }))
    } as Remuxer

    const runTask = <T extends any>(func: (abortedPromise: Promise<void>) => Promise<T>) => {
      if (abortController) abortController.abort()
      const newAbortController = new AbortController()
      abortController = newAbortController
      const abortedPromise = abortControllerToPromise(newAbortController)
      // queue.clear()
      return queue.add(() => func(abortedPromise), { signal: abortController.signal })
    }

    const wasmRead = (abortedPromise: Promise<void>) => (offset: number, size: number) =>
      Promise.race([
        read(offset, size)
          .then(buffer => ({
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
