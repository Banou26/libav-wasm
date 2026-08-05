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

/** `data` is tightly packed RGBA at width * height * 4, the exact shape an ImageData takes */
export interface ThumbnailDecodeResult {
  data: Uint8Array
  width: number
  height: number
  pts: number
  duration: number
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

export type AudioStream = {
  streamIndex: number
  language: string
  title: string
}

export type RemuxerInstanceOptions = {
  resolvedPromise: Promise<void>
  length: number
  bufferSize: number
  audioStreamIndex?: number
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
    audioStreams: WASMVector<AudioStream>
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
  readKeyframe: (read: WASMReadFunction, timestamp: number) => Promise<ThumbnailReadResult>
  decodeKeyframe: (read: WASMReadFunction, timestamp: number, width: number, height: number) => Promise<ThumbnailDecodeResult>
  setAudioStreamIndex: (index: number) => void
}

export type Remuxer = {
  new(options: RemuxerInstanceOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{
    data: ArrayBuffer
    attachments: Attachment[]
    subtitles: SubtitleFragment[]
    audioStreams: AudioStream[]
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
  decodeKeyframe: (read: WASMReadFunction, timestamp: number, width: number, height: number) => Promise<{
    data: ArrayBuffer
    width: number
    height: number
    pts: number
    duration: number
    cancelled: boolean
  }>
  setAudioStreamIndex: (index: number) => void
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    print: (text: string) => console.log(text),
    printErr: (text: string) => text.includes('Read error at pos') ? undefined : console.error(text),
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
    { publicPath, length, bufferSize, audioStreamIndex, log }:
    {
      publicPath: string
      length: number
      bufferSize: number
      audioStreamIndex?: number
      log: (isError: boolean, text: string) => Promise<void>
    }
  ) => {
    // this module should not be destructured as the HEAPU8 variable changes if the heap needs to grow
    const module = await makeModule(publicPath, log)
    const _remuxer = new module.Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize, audioStreamIndex })
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
          audioStreams: vectorToArray(result.audioStreams).map(({ streamIndex, language, title }) => ({
            streamIndex,
            language,
            title
          })),
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
          }),
      decodeKeyframe: (read, timestamp, width, height) =>
        _remuxer.decodeKeyframe(read, timestamp, width, height)
          .then((result: ThumbnailDecodeResult) => {
            if (result.cancelled) throw new Error('Cancelled')
            // copied off the wasm heap before anything can grow it out from under the view
            const typedArray = new Uint8Array(result.data.byteLength)
            typedArray.set(new Uint8Array(result.data))
            return {
              data: typedArray.buffer,
              width: result.width,
              height: result.height,
              pts: result.pts,
              duration: result.duration,
              cancelled: result.cancelled
            }
          }),
      setAudioStreamIndex: (index) => _remuxer.setAudioStreamIndex(index)
    } as Remuxer

    const readToWasmRead = (read: ReadFunction) => (offset: number, size: number) =>
      read(Number(offset), Number(size))
        .then(
          ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
          () => ({ resolved: new Uint8Array(0), rejected: true })
        )

    let videoFrameResolve: ((value: VideoFrame) => void) | undefined
    let videoFrameReject: ((reason?: any) => void) | undefined
    let decoderConfig: VideoDecoderConfig | undefined
    // WebCodecs is needed by readKeyframe and by nothing else here: demuxing and remuxing are pure wasm.
    // So none of it may be touched while building a remuxer, or a browser without WebCodecs (Firefox for
    // Android) loses PLAYBACK to a thumbnail feature it never asked for. It is built on first use instead.
    const hasWebCodecs = typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
    // decided in init(), once the codec is known: only a SOFTWARE WebCodecs decoder is usable here
    let useWebCodecs = false
    // an output with no waiter must be closed or the hw decoder's output pool exhausts
    const makeDecoder = () => new VideoDecoder({
      output: (output) => {
        if (videoFrameResolve) videoFrameResolve(output)
        else output.close()
        videoFrameResolve = undefined
        videoFrameReject = undefined
      },
      error: (err) => {
        videoFrameReject?.(err)
        videoFrameResolve = undefined
        videoFrameReject = undefined
      }
    })
    let videoDecoder: VideoDecoder | undefined
    let thumbnailCanvas: { canvas: OffscreenCanvas, context: OffscreenCanvasRenderingContext2D } | undefined
    const ensureCanvas = () => {
      if (thumbnailCanvas) return thumbnailCanvas
      const canvas = new OffscreenCanvas(200 * 16/9, 200)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('OffscreenCanvas not supported')
      return (thumbnailCanvas = { canvas, context })
    }

    return {
      destroy: async () => remuxer.destroy(),
      init: async (read: ReadFunction) => {
        const initResult = await remuxer.init(readToWasmRead(read))
        if (hasWebCodecs) {
          // hw decoders repeat the first frame under this one-keyframe-per-flush pattern, so a software
          // decoder is not a preference here, it is the only correct one.
          const swConfig: VideoDecoderConfig = {
            codec: initResult.info.input.videoMimeType,
            description: initResult.videoExtradata,
            hardwareAcceleration: 'prefer-software',
          }
          useWebCodecs = await VideoDecoder.isConfigSupported(swConfig).then(res => res.supported === true, () => false)
          // Falling back to a HARDWARE WebCodecs decoder was silently wrong. Measured on Chrome 146: hevc
          // main and main10 are supported, but never with prefer-software, so every hevc thumbnail came
          // back as the first frame of the file. libav decodes it correctly, so that is the fallback now.
          if (useWebCodecs) decoderConfig = swConfig
        }
        return initResult
      },
      seek: (read: ReadFunction, timestamp: number) => remuxer.seek(readToWasmRead(read), timestamp),
      read: (read: ReadFunction) => remuxer.read(readToWasmRead(read)),
      setAudioStreamIndex: async (index: number) => remuxer.setAudioStreamIndex(index),
      readKeyframe: async (read: ReadFunction, timestamp: number) => {
        // libav decodes and scales the keyframe itself whenever WebCodecs cannot do it CORRECTLY: either
        // it is absent entirely (Firefox for Android) or it only offers a hardware decoder for this codec,
        // which repeats the first frame. The build already carries h264, hevc and swscale, so this costs
        // nothing extra and the caller cannot tell the paths apart. Slower, which is right for a preview.
        if (!useWebCodecs) {
          const { canvas, context } = ensureCanvas()
          const decoded = await remuxer.decodeKeyframe(readToWasmRead(read), timestamp, canvas.width, canvas.height)
          context.putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height), 0, 0)
          return canvas.convertToBlob().then(blob => blob.arrayBuffer())
        }
        const readResult = await remuxer.readKeyframe(readToWasmRead(read), timestamp)
        if (!readResult.data?.byteLength) throw new Error('empty keyframe data')
        // a decode error closes the VideoDecoder permanently, so recreate it here or every later readKeyframe call fails
        if (!videoDecoder || videoDecoder.state === 'closed') videoDecoder = makeDecoder()
        if (videoDecoder.state === 'unconfigured') {
          if (!decoderConfig) throw new Error('decoder not configured')
          videoDecoder.configure(decoderConfig)
        }
        const { canvas, context } = ensureCanvas()
        const videoFramePromise = new Promise<VideoFrame>((resolve, reject) => {
          videoFrameResolve = resolve
          videoFrameReject = reject
        })
        videoDecoder.decode(new EncodedVideoChunk({
          type: "key",
          timestamp: readResult.pts,
          duration: readResult.duration,
          data: readResult.data
        }))
        const [videoFrame] = await Promise.all([videoFramePromise, videoDecoder.flush()])
        context.drawImage(videoFrame, 0, 0, 200 * 16/9, 200)
        videoFrame.close()
        return canvas.convertToBlob().then(blob => blob.arrayBuffer())
      }
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { transport: globalThis })
