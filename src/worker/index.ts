import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'

// ──────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────

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
    streamIndex: number
    start: number
    end: number
    dialogueIndex: number
    layer: number
    content: string
    fields: Record<string, string>
  }

export type Index = {
  index: number
  timestamp: number
  pos: number
}

export type Chapter = {
  index: number
  start: number
  end: number
  title: string
}

export type Attachment = {
  filename: string
  mimetype: string
  data: ArrayBuffer
}

// ──────────────────────────────────────────────
// WASM-specific types (internal)
// ──────────────────────────────────────────────

type WASMVector<T> = {
  size: () => number
  get: (index: number) => T
}

type RemuxerInstanceSubtitleFragment = {
  isHeader: boolean
  streamIndex: number
  data: Uint8Array
  format: string[]
  language: string
  title: string
  start: string
  end: string
}

type RemuxerInstanceAttachment = {
  filename: string
  mimetype: string
  data: Uint8Array
  size: number
  ptr: number
}

type WASMReadFunction = (offset: number, size: number) => Promise<{
  resolved: Uint8Array
  rejected: boolean
}>

type ReadFunction = (offset: number, size: number) => Promise<{
  resolved: ArrayBuffer
  rejected: boolean
}>

interface IOInfo {
  input: MediaInfoFields
  output: MediaInfoFields
}

interface MediaInfoFields {
  audioMimeType: string
  duration: number
  formatName: string
  mimeType: string
  videoMimeType: string
}

interface WASMInitResult {
  data: Uint8Array
  attachments: WASMVector<RemuxerInstanceAttachment>
  subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
  indexes: WASMVector<Index>
  chapters: WASMVector<Chapter>
  info: IOInfo
  videoExtradata: WASMVector<number>
}

interface WASMReadResult {
  data: Uint8Array
  subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
  offset: number
  pts: number
  duration: number
  cancelled: boolean
  finished: boolean
}

interface WASMThumbnailReadResult {
  data: Uint8Array
  pts: number
  duration: number
  offset: number
  cancelled: boolean
}

interface RemuxerInstance {
  init: (read: WASMReadFunction) => Promise<WASMInitResult>
  destroy: () => void
  seek: (read: WASMReadFunction, timestamp: number) => Promise<WASMReadResult>
  read: (read: WASMReadFunction) => Promise<WASMReadResult>
  readKeyframe: (read: WASMReadFunction, timestamp: number) => Promise<WASMThumbnailReadResult>
}

// ──────────────────────────────────────────────
// Public result types
// ──────────────────────────────────────────────

export interface InitResult {
  data: ArrayBuffer
  attachments: Attachment[]
  subtitles: SubtitleFragment[]
  info: IOInfo
  chapters: Chapter[]
  indexes: Index[]
  videoExtradata: ArrayBuffer
}

export interface ReadResult {
  data: ArrayBuffer
  subtitles: SubtitleFragment[]
  offset: number
  pts: number
  duration: number
  cancelled: boolean
  finished: boolean
}

export interface ThumbnailReadResult {
  data: ArrayBuffer
  pts: number
  duration: number
  offset: number
  cancelled: boolean
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const vectorToArray = <T>(vector: WASMVector<T>): T[] => {
  const length = vector.size()
  const result: T[] = new Array(length)
  for (let i = 0; i < length; i++) {
    result[i] = vector.get(i)
  }
  return result
}

const copyTypedArray = (source: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(source.byteLength)
  copy.set(source)
  return copy.buffer
}

const readToWasmRead = (read: ReadFunction): WASMReadFunction =>
  (offset: number, size: number) =>
    read(Number(offset), Number(size))
      .then(
        ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
        () => ({ resolved: new Uint8Array(0), rejected: true })
      )

const mapDialogueSubtitles = (wasmSubtitles: WASMVector<RemuxerInstanceSubtitleFragment>): SubtitleFragment[] =>
  vectorToArray(wasmSubtitles).map((sub) => {
    if (sub.isHeader) throw new Error('Subtitle type is header')
    const { isHeader: _, data, ...rest } = sub
    return { ...rest, type: 'dialogue' as const, content: data }
  })

const mapReadResult = (result: WASMReadResult): ReadResult => {
  if (result.cancelled) throw new Error('Cancelled')
  return {
    data: copyTypedArray(new Uint8Array(result.data)),
    subtitles: mapDialogueSubtitles(result.subtitles),
    offset: result.offset,
    pts: result.pts,
    duration: result.duration,
    cancelled: result.cancelled,
    finished: result.finished
  }
}

const copyIOInfo = (info: IOInfo): IOInfo => ({
  input: { ...info.input },
  output: { ...info.output }
})

// ──────────────────────────────────────────────
// WASM module loader
// ──────────────────────────────────────────────

const makeModule = (publicPath: string) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    print: (text: string) => console.log(text),
    printErr: (text: string) => {
      if (!text.includes('Read error at pos')) console.error(text)
    },
  }) as Promise<EmscriptenModule & { Remuxer: { new(options: { resolvedPromise: Promise<void>; length: number; bufferSize: number }): RemuxerInstance } }>

// ──────────────────────────────────────────────
// Worker resolvers
// ──────────────────────────────────────────────

const THUMBNAIL_HEIGHT = 200
const THUMBNAIL_WIDTH = Math.round(THUMBNAIL_HEIGHT * 16 / 9)

const resolvers = {
  makeRemuxer: async (
    { publicPath, length, bufferSize }:
    {
      publicPath: string
      length: number
      bufferSize: number
      log: (isError: boolean, text: string) => Promise<void>
    }
  ) => {
    const module = await makeModule(publicPath)
    const instance = new module.Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize })

    let videoFrameResolve: ((value: VideoFrame) => void) | undefined
    let videoFrameReject: ((reason?: unknown) => void) | undefined

    const videoDecoder = new VideoDecoder({
      output: (output) => {
        videoFrameResolve?.(output)
        videoFrameResolve = undefined
        videoFrameReject = undefined
      },
      error: (err) => {
        videoFrameReject?.(err)
        videoFrameResolve = undefined
        videoFrameReject = undefined
      }
    })

    const offscreen = new OffscreenCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
    const offscreenContext = offscreen.getContext('2d')
    if (!offscreenContext) throw new Error('OffscreenCanvas 2d context not supported')

    return {
      destroy: async () => instance.destroy(),

      init: async (read: ReadFunction): Promise<InitResult> => {
        const result = await instance.init(readToWasmRead(read))

        if (videoDecoder.state === 'unconfigured') {
          videoDecoder.configure({
            codec: result.info.input.videoMimeType,
            description: new Uint8Array(vectorToArray(result.videoExtradata)),
          })
        }

        return {
          data: copyTypedArray(result.data),
          videoExtradata: new Uint8Array(vectorToArray(result.videoExtradata)).buffer,
          attachments: vectorToArray(result.attachments).map(attachment => {
            const data = new Uint8Array(module.HEAPU8.buffer, attachment.ptr, attachment.size)
            return {
              filename: attachment.filename,
              mimetype: attachment.mimetype,
              data: new Uint8Array(data).buffer
            }
          }),
          subtitles: vectorToArray(result.subtitles).map((sub) => {
            if (!sub.isHeader) throw new Error('Subtitle type is not header')
            const { isHeader: _, data, ...rest } = sub
            return { ...rest, type: 'header' as const, content: data }
          }),
          indexes: vectorToArray(result.indexes).map(({ index, timestamp, pos }) => ({
            index, timestamp, pos
          })),
          chapters: vectorToArray(result.chapters).map(({ index, start, end, title }) => ({
            index, start, end, title
          })),
          info: copyIOInfo(result.info)
        }
      },

      seek: (read: ReadFunction, timestamp: number): Promise<ReadResult> =>
        instance.seek(readToWasmRead(read), timestamp * 1000).then(mapReadResult),

      read: (read: ReadFunction): Promise<ReadResult> =>
        instance.read(readToWasmRead(read)).then(mapReadResult),

      readKeyframe: async (read: ReadFunction, timestamp: number): Promise<ArrayBuffer> => {
        const videoFramePromise = new Promise<VideoFrame>((resolve, reject) => {
          videoFrameResolve = resolve
          videoFrameReject = reject
        })
        const readResult = await instance.readKeyframe(readToWasmRead(read), timestamp)
        if (readResult.cancelled) throw new Error('Cancelled')

        videoDecoder.decode(new EncodedVideoChunk({
          type: 'key',
          timestamp: readResult.pts,
          duration: readResult.duration,
          data: readResult.data
        }))
        await videoDecoder.flush()
        const videoFrame = await videoFramePromise
        offscreenContext.drawImage(videoFrame, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
        videoFrame.close()
        const blob = await offscreen.convertToBlob()
        return blob.arrayBuffer()
      }
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { transport: globalThis })
