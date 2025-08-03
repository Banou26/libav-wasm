import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'

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
    start: number
    end: number
    dialogueIndex: number
    layer: number
    content: string
    fields: Record<string, string>
  }

export interface ThumbnailReadResult {
  data: Uint8Array
  pts: number
  duration: number
  offset: number
  cancelled: boolean
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

export type RemuxerInstanceAttachment = {
  filename: string
  mimetype: string
  data: Uint8Array
  size: number
  ptr: number
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
    indexes: WASMVector<Index>
    chapters: WASMVector<Chapter>
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
    videoExtradata: WASMVector<number>
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
  readKeyframe: (read: WASMReadFunction, timestamp: number) => Promise<ThumbnailReadResult>;
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
    chapters: Chapter[]
    indexes: Index[]
    videoExtradata: ArrayBuffer
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
  readKeyframe: (read: WASMReadFunction, timestamp: number) => Promise<{
    data: ArrayBuffer
    pts: number
    duration: number
    offset: number
    cancelled: boolean
  }>
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    print: (text: string) => console.log(text),
    printErr: (text: string) => text.includes('Read error at pos') ? undefined : console.error(text),
    // print: (text: string) => log(false, text),
    // printErr: (text: string) => log(true, text),
  }) as Promise<EmscriptenModule & { Remuxer: RemuxerInstance }>

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
    // this module should not be destructured as the HEAPU8 variable changes if the heap needs to grow
    const module = await makeModule(publicPath, log)
    const _remuxer = new module.Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize })
    const remuxer = {
      init: (read) => _remuxer.init(read).then(result => {
        const typedArray = new Uint8Array(result.data.byteLength)
        typedArray.set(result.data)
        return {
          data: typedArray.buffer,
          videoExtradata: new Uint8Array(vectorToArray(result.videoExtradata)).buffer,
          attachments: vectorToArray(result.attachments).map(attachment => {
            const data = new Uint8Array(module.HEAPU8.buffer, attachment.ptr, attachment.size)
            const dataCopy = new Uint8Array(data)
            return {
              filename: attachment.filename,
              mimetype: attachment.mimetype,
              data: dataCopy.buffer
            }
          }),
          subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
            if (!_subtitle.isHeader) throw new Error('Subtitle type is not header')
            const { isHeader, data, ...subtitle } = _subtitle
            return {
              ...subtitle,
              type: 'header',
              content: data
            }
          }),
          indexes: vectorToArray(result.indexes).map(({ index, timestamp, pos }) => ({
            index,
            timestamp,
            pos
          })),
          chapters: vectorToArray(result.chapters).map(({ index, start, end, title }) => ({
            index,
            start,
            end,
            title
          })),
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
              content: data
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
              content: data
            }
          }),
          offset: result.offset,
          pts: result.pts,
          duration: result.duration,
          cancelled: result.cancelled,
          finished: result.finished
        }
      }),
      readKeyframe: (read, timestamp) =>
        _remuxer.readKeyframe(read, timestamp)
          .then(result => {
            if (result.cancelled) throw new Error('Cancelled')
            const typedArray = new Uint8Array(result.data.byteLength)
            typedArray.set(new Uint8Array(result.data))
            return {
              data: typedArray.buffer,
              pts: result.pts,
              duration: result.duration,
              offset: result.offset,
              cancelled: result.cancelled
            }
          })
    } as Remuxer

    const readToWasmRead = (read: ReadFunction) => (offset: number, size: number) =>
      read(Number(offset), Number(size))
        .then(
          ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
          () => ({ resolved: new Uint8Array(0), rejected: true })
        )

    let videoFrameResolve: ((value: VideoFrame) => void) | undefined
    let videoFrameReject: ((reason?: any) => void) | undefined
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
    const offscreen = new OffscreenCanvas(200 * 16/9, 200)
    const offscreenContext = offscreen.getContext('2d')
    if (!offscreenContext) throw new Error('OffscreenCanvas not supported')

    return {
      destroy: async () => remuxer.destroy(),
      init: async (read: ReadFunction) => {
        const initResult = await remuxer.init(readToWasmRead(read))
        console.log('initResult', initResult)
        if (videoDecoder.state === 'unconfigured') {
          videoDecoder.configure({
            codec: initResult.info.input.videoMimeType,
            description: initResult.videoExtradata,
          })
        }
        return initResult
      },
      seek: (read: ReadFunction, timestamp: number) => remuxer.seek(readToWasmRead(read), timestamp),
      read: (read: ReadFunction) => remuxer.read(readToWasmRead(read)),
      readKeyframe: async (read: ReadFunction, timestamp: number) => {
        const videoFramePromise = new Promise<VideoFrame>((resolve, reject) => {
          videoFrameResolve = resolve
          videoFrameReject = reject
        })
        const readResult = await remuxer.readKeyframe(readToWasmRead(read), timestamp)
        videoDecoder.decode(new EncodedVideoChunk({
          type: "key",
          timestamp: readResult.pts,
          duration: readResult.duration,
          data: readResult.data
        }))
        videoDecoder.flush()
        const videoFrame = await videoFramePromise
        offscreenContext.drawImage(videoFrame, 0, 0, 200 * 16/9, 200)
        videoFrame.close()
        return offscreen.convertToBlob().then(blob => blob.arrayBuffer())
      }
    }
  }
}

export type Resolvers = typeof resolvers

// @ts-expect-error
expose(resolvers, { remote: globalThis, local: globalThis })
