import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'
import PQueue from 'p-queue'
import Mutex from 'p-mutex'
import { createStateMachine } from './state-machine'

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

type ReadFunction = (offset: number, size: number) => Promise<{
  resolved: ArrayBuffer
  rejected: boolean
}>

type WASMReadFunction = (offset: number, size: number) => Promise<{
  resolved: Uint8Array
  rejected: boolean
}>

export interface RemuxerInstance {
  new(options: RemuxerInstanceOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{
    data: Uint8Array
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
  seek: (read: WASMReadFunction, timestamp: number) => Promise<{
    data: Uint8Array
    subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
    offset: number
    pts: number
    duration: number
    cancelled: boolean
    finished: boolean
  }>
  read: (read: WASMReadFunction) => Promise<{
    data: Uint8Array
    subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
    offset: number
    pts: number
    duration: number
    cancelled: boolean
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
  seek: (read: WASMReadFunction, timestamp: number) => Promise<{
    data: ArrayBuffer
    subtitles: SubtitleFragment[]
    offset: number
    pts: number
    duration: number
    cancelled: boolean
    finished: boolean
  }>
  read: (read: WASMReadFunction) => Promise<{
    data: ArrayBuffer
    subtitles: SubtitleFragment[]
    offset: number
    pts: number
    duration: number
    cancelled: boolean
    finished: boolean
  }>
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    // print: (text: string) => {},
    // printErr: (text: string) => {},
    print: (text: string) => console.log(text),
    printErr: (text: string) => text.includes('Read error at pos') ? undefined : console.error(text),
    // print: (text: string) => log(false, text),
    // printErr: (text: string) => log(true, text),
  }) as Promise<{ Remuxer: RemuxerInstance }>

// converts ms to 'h:mm:ss.cc' format
const convertTimestamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .slice(11, 22)
    .replace(/^00/, '0')

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
    { publicPath, length, bufferSize, log }:
    {
      publicPath: string
      length: number
      bufferSize: number
      log: (isError: boolean, text: string) => Promise<void>
    }
  ) => {
    const { Remuxer } = await makeModule(publicPath, log)
    const _remuxer = new Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize })
    const remuxer = {
      init: (read) => _remuxer.init(read).then(result => {
        const typedArray = new Uint8Array(result.data.byteLength)
        typedArray.set(new Uint8Array(result.data))
        return {
          data: typedArray.buffer,
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
        }
      }),
      destroy: () => _remuxer.destroy(),
      seek: (read, timestamp) => _remuxer.seek(read, timestamp * 1000).then(result => {
        if (result.cancelled) throw new Error('Cancelled')
        const typedArray = new Uint8Array(result.data.byteLength)
        typedArray.set(new Uint8Array(result.data))
        return {
          data: typedArray.buffer,
          subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
            if (_subtitle.isHeader) throw new Error('Subtitle type is header')
            const { isHeader, data, ...subtitle } = _subtitle
            return {
              ...subtitle,
              type: 'dialogue',
              content: new TextDecoder().decode(data)
            }
          }),
          offset: result.offset,
          pts: result.pts,
          duration: result.duration,
          cancelled: result.cancelled,
          finished: result.finished
        }
      }),
      read: (read) => _remuxer.read(read).then(result => {
        if (result.cancelled) throw new Error('Cancelled')
        const typedArray = new Uint8Array(result.data.byteLength)
        typedArray.set(new Uint8Array(result.data))
        return {
          data: typedArray.buffer,
          subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
            if (_subtitle.isHeader) throw new Error('Subtitle type is header')
            const { isHeader, data, ...subtitle } = _subtitle
            return {
              ...subtitle,
              type: 'dialogue',
              content: new TextDecoder().decode(data)
            }
          }),
          offset: result.offset,
          pts: result.pts,
          duration: result.duration,
          cancelled: result.cancelled,
          finished: result.finished
        }
      })
    } as Remuxer

    const readToWasmRead = (read: ReadFunction) => (offset: number, size: number) =>
      read(offset, size)
        .then(
          ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
          () => ({ resolved: new Uint8Array(0), rejected: true })
        )

    return {
      destroy: () => remuxer.destroy(),
      init: (read: ReadFunction) => remuxer.init(readToWasmRead(read)),
      seek: (read: ReadFunction, timestamp: number) => remuxer.seek(readToWasmRead(read), timestamp),
      read: (read: ReadFunction) => remuxer.read(readToWasmRead(read))
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { remote: globalThis, local: globalThis })
