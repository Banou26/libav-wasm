import { expose, transfer } from 'osra'

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

export type RemuxerInstanceMediaInfo = {
  audioMimeType: string
  duration: number
  formatName: string
  mimeType: string
  videoMimeType: string
}

export type RemuxerInstanceInitInfo = {
  input: RemuxerInstanceMediaInfo
  output: RemuxerInstanceMediaInfo
}

export interface ThumbnailReadResult {
  data: Uint8Array
  pts: number
  duration: number
  offset: number
  cancelled: boolean
}

// One media unit returned by the WASM transcode path (HEVC decoded to raw I420, audio passed
// through as AAC). Exactly one of video/audio per call; timestamps are in seconds.
export interface TranscodeUnit {
  type: 'video' | 'audio' | 'eof' | 'cancelled'
  data: Uint8Array
  width: number
  height: number
  linesize0: number
  linesize1: number
  linesize2: number
  key: boolean
  pts: number
  duration: number
  finished: boolean
  cancelled: boolean
}

export interface TranscodeInitResult {
  info: RemuxerInstanceInitInfo
  attachments: WASMVector<RemuxerInstanceAttachment>
  subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
  indexes: WASMVector<Index>
  chapters: WASMVector<Chapter>
  videoWidth: number
  videoHeight: number
  videoFpsNum: number
  videoFpsDen: number
  hasAudio: boolean
  audioSampleRate: number
  audioChannels: number
  audioExtradata: WASMVector<number>
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
  // Decoder threads for the HEVC transcode fallback: 1 = single (default), 0 = auto (all cores),
  // N = explicit. Only effective when the wasm is built with pthreads.
  threadCount?: number
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
  initTranscode: (read: WASMReadFunction) => Promise<TranscodeInitResult>;
  readTranscode: (read: WASMReadFunction) => Promise<TranscodeUnit>;
  seekTranscode: (read: WASMReadFunction, timestamp: number) => Promise<TranscodeUnit>;
  readKeyframeTranscode: (read: WASMReadFunction, timestamp: number) => Promise<TranscodeUnit>;
  initTranscodeMux: (
    videoExtradata: Uint8Array,
    width: number,
    height: number,
    hasAudio: boolean,
    audioExtradata: Uint8Array,
    sampleRate: number,
    channels: number
  ) => Uint8Array;
  writeTranscodeVideo: (data: Uint8Array, pts: number, dts: number, duration: number, keyframe: boolean) => Uint8Array;
  writeTranscodeAudio: (data: Uint8Array, pts: number, duration: number) => Uint8Array;
  flushTranscodeMux: () => Uint8Array;
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
  initTranscode: (read: WASMReadFunction) => Promise<TranscodeInit>
  readTranscode: (read: WASMReadFunction) => Promise<TranscodeUnit>
  seekTranscode: (read: WASMReadFunction, timestamp: number) => Promise<TranscodeUnit>
  readKeyframeTranscode: (read: WASMReadFunction, timestamp: number) => Promise<TranscodeUnit>
  // Mux sink (synchronous; each returns the fMP4 bytes produced during the call, copied out of the heap)
  initTranscodeMux: (
    videoExtradata: Uint8Array,
    width: number,
    height: number,
    hasAudio: boolean,
    audioExtradata: Uint8Array,
    sampleRate: number,
    channels: number
  ) => Uint8Array
  writeTranscodeVideo: (data: Uint8Array, pts: number, dts: number, duration: number, keyframe: boolean) => Uint8Array
  writeTranscodeAudio: (data: Uint8Array, pts: number, duration: number) => Uint8Array
  flushTranscodeMux: () => Uint8Array
}

// JS-friendly init result for transcode mode (WASMVectors converted to arrays).
export type TranscodeInit = {
  info: RemuxerInstanceInitInfo
  attachments: Attachment[]
  subtitles: SubtitleFragment[]
  indexes: Index[]
  chapters: Chapter[]
  videoWidth: number
  videoHeight: number
  videoFpsNum: number
  videoFpsDen: number
  hasAudio: boolean
  audioSampleRate: number
  audioChannels: number
  audioExtradata: Uint8Array
  cancelled: boolean
}

// pthreads need shared memory, which requires SharedArrayBuffer (i.e. a cross-origin-isolated page).
const canUseThreads = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined' && (globalThis as any).crossOriginIsolated === true

// Both builds are ES modules (EXPORT_ES6) loaded by URL at runtime — nothing is bundled into the
// worker. The multi-threaded build in particular must be a real file so emscripten can spawn its
// pthread workers from the module's own URL.
const makeModule = async (
  urls: { moduleUrl: string; wasmUrl: string; threadedModuleUrl?: string; threadedWasmUrl?: string },
  useThreads: boolean,
  log: (isError: boolean, text: string) => void
) => {
  const moduleUrl = useThreads ? urls.threadedModuleUrl! : urls.moduleUrl
  const wasmUrl = useThreads ? urls.threadedWasmUrl! : urls.wasmUrl
  const mod = await import(/* @vite-ignore */ moduleUrl)
  return (mod.default ?? mod)({
    locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
    print: (text: string) => console.log(text),
    printErr: (text: string) => text.includes('Read error at pos') ? undefined : console.error(text),
  }) as Promise<EmscriptenModule & { Remuxer: RemuxerInstance }>
}

type WASMVector<T> = {
  size: () => number
  get: (index: number) => T
}

const vectorToArray = <T>(vector: WASMVector<T>) =>
  Array(vector.size())
    .fill(undefined)
    .map((_, index) => vector.get(index))

// Copy bytes out of a view into the WASM heap (the heap may move/be overwritten on the next call).
const copyBytes = (view: Uint8Array): Uint8Array => {
  const out = new Uint8Array(view.byteLength)
  out.set(view)
  return out
}

// Copy a TranscodeUnit out of the WASM heap (its `data` is a view into HEAPU8).
// `data` is undefined for eof/cancelled units.
const unitToJs = (result: TranscodeUnit): TranscodeUnit => {
  const src = result.data as Uint8Array | undefined
  const data = new Uint8Array(src ? src.byteLength : 0)
  if (src) data.set(src)
  return {
    type: result.type,
    data,
    width: result.width,
    height: result.height,
    linesize0: result.linesize0,
    linesize1: result.linesize1,
    linesize2: result.linesize2,
    key: result.key,
    pts: result.pts,
    duration: result.duration,
    finished: result.finished,
    cancelled: result.cancelled
  }
}

const resolvers = {
  makeRemuxer: async (
    { moduleUrl, wasmUrl, threadedModuleUrl, threadedWasmUrl, length, bufferSize, threadCount, log }:
    {
      moduleUrl: string
      wasmUrl: string
      threadedModuleUrl?: string
      threadedWasmUrl?: string
      length: number
      bufferSize: number
      threadCount?: number
      log: (isError: boolean, text: string) => Promise<void>
    }
  ) => {
    // Pick the build: multi-threaded only when threads are requested, the mt build URLs were
    // provided, AND the page is cross-origin isolated (otherwise the pthreads build can't even
    // instantiate). Fall back to single-threaded in every other case.
    const wantThreads = (threadCount ?? 1) !== 1
    const haveThreadUrls = !!threadedModuleUrl && !!threadedWasmUrl
    const useThreads = wantThreads && haveThreadUrls && canUseThreads()
    if (wantThreads && !useThreads) {
      const reason = !canUseThreads()
        ? 'the page is not cross-origin isolated (no SharedArrayBuffer)'
        : 'threadedModuleUrl/threadedWasmUrl were not provided'
      log(true, `libav-wasm: multi-threaded decode requested but ${reason}; using the single-threaded build.`)
    }
    const effectiveThreadCount = useThreads ? (threadCount ?? 1) : 1

    // this module should not be destructured as the HEAPU8 variable changes if the heap needs to grow
    const module = await makeModule({ moduleUrl, wasmUrl, threadedModuleUrl, threadedWasmUrl }, useThreads, log)
    const _remuxer = new module.Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize, threadCount: effectiveThreadCount })
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
          }),
      initTranscode: (read) => _remuxer.initTranscode(read).then(result => ({
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
        },
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
          const { isHeader, data, ...subtitle } = _subtitle
          return {
            ...subtitle,
            type: 'header',
            content: data
          }
        }),
        indexes: vectorToArray(result.indexes).map(({ index, timestamp, pos }) => ({ index, timestamp, pos })),
        chapters: vectorToArray(result.chapters).map(({ index, start, end, title }) => ({ index, start, end, title })),
        videoWidth: result.videoWidth,
        videoHeight: result.videoHeight,
        videoFpsNum: result.videoFpsNum,
        videoFpsDen: result.videoFpsDen,
        hasAudio: result.hasAudio,
        audioSampleRate: result.audioSampleRate,
        audioChannels: result.audioChannels,
        audioExtradata: new Uint8Array(vectorToArray(result.audioExtradata)),
        cancelled: result.cancelled
      })) as Promise<TranscodeInit>,
      readTranscode: (read) => _remuxer.readTranscode(read).then(unitToJs),
      seekTranscode: (read, timestamp) => _remuxer.seekTranscode(read, timestamp * 1000).then(unitToJs),
      readKeyframeTranscode: (read, timestamp) => _remuxer.readKeyframeTranscode(read, timestamp).then(unitToJs),
      initTranscodeMux: (videoExtradata, width, height, hasAudio, audioExtradata, sampleRate, channels) =>
        copyBytes(_remuxer.initTranscodeMux(videoExtradata, width, height, hasAudio, audioExtradata, sampleRate, channels)),
      writeTranscodeVideo: (data, pts, dts, duration, keyframe) =>
        copyBytes(_remuxer.writeTranscodeVideo(data, pts, dts, duration, keyframe)),
      writeTranscodeAudio: (data, pts, duration) =>
        copyBytes(_remuxer.writeTranscodeAudio(data, pts, duration)),
      flushTranscodeMux: () => copyBytes(_remuxer.flushTranscodeMux())
    } as Remuxer

    const readToWasmRead = (read: ReadFunction) => (offset: number, size: number) =>
      read(Number(offset), Number(size))
        .then(
          ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
          () => ({ resolved: new Uint8Array(0), rejected: true })
        )

    // Whether this browser can play the given video codec via MSE. MediaSource is the
    // authoritative gate when exposed; fall back to WebCodecs decode support when it isn't.
    //
    // The two-tier check matters: MediaSource.isTypeSupported is honest in worker scope
    // (e.g. Chromium worker returns false for HEVC), but it's a false-positive prone
    // capability claim in *window* scope (Firefox 150 on Linux returns true for hev1 but
    // then errors when its SourceBuffer is fed real bytes). Firefox in particular doesn't
    // expose MediaSource in workers at all, so we land on the VideoDecoder fallback there,
    // which honestly reports HEVC as unsupported. Don't collapse these two arms — without
    // the fallback, Firefox would silently break, and replacing MSE with VideoDecoder on
    // browsers where MSE works fine would lose codecs WebCodecs can't decode (e.g. AV1 on
    // some platforms) even though they'd play via MSE.
    const isVideoCodecSupported = async (videoMimeType: string): Promise<boolean> => {
      const type = `video/mp4; codecs="${videoMimeType}"`
      if (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function') {
        return MediaSource.isTypeSupported(type)
      }
      try {
        const res = await (globalThis as any).VideoDecoder?.isConfigSupported?.({ codec: videoMimeType })
        return !!res?.supported
      } catch {
        return false
      }
    }

    const estimateBitrate = (w: number, h: number): number =>
      Math.min(Math.max(Math.round(w * h * 4), 1_000_000), 20_000_000)

    // A best-guess AVC codec string to configure the encoder with (High profile, level by
    // resolution). The encoder reports the *actual* avc1.PPCCLL string in its first chunk's
    // decoderConfig.codec, which is what we hand to the SourceBuffer.
    const pickAvcCodec = (w: number, h: number): string => {
      let level: number
      if (w <= 1280 && h <= 720) level = 0x1f      // 3.1
      else if (w <= 1920 && h <= 1088) level = 0x28 // 4.0
      else if (w <= 2560 && h <= 1440) level = 0x32 // 5.0
      else level = 0x33                              // 5.1
      return `avc1.6400${level.toString(16).padStart(2, '0')}`
    }

    const toUint8 = (b: AllowSharedBufferSource): Uint8Array =>
      b instanceof ArrayBuffer
        ? new Uint8Array(b)
        : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

    type TranscodeOutChunk = { data: ArrayBuffer; pts: number; duration: number; finished: boolean }

    // Drives the fallback pipeline: WASM decodes HEVC -> I420 (read_transcode), the browser's
    // WebCodecs VideoEncoder encodes I420 -> H264, and the encoded packets (+ passthrough AAC)
    // are pushed back into the WASM mp4 muxer, which emits the same fragmented MP4 the passthrough
    // path produces. No external dependency — only native WebCodecs + the existing ffmpeg muxer.
    const createTranscodePipeline = async (init: TranscodeInit, read: ReadFunction) => {
      const width = init.videoWidth
      const height = init.videoHeight
      const framerate = init.videoFpsDen ? init.videoFpsNum / init.videoFpsDen : 30

      const encoderConfig: VideoEncoderConfig = {
        codec: pickAvcCodec(width, height),
        width,
        height,
        framerate,
        bitrate: estimateBitrate(width, height),
        latencyMode: 'realtime', // disables B-frames, so pts == dts and the muxer never reorders
        avc: { format: 'avc' }   // length-prefixed NAL units + avcC in decoderConfig.description
      }

      let muxInited = false
      let finished = false
      let videoMimeType = encoderConfig.codec
      const audioMimeType = init.info.output.audioMimeType
      const outputChunks: Uint8Array[] = []
      const pendingAudio: TranscodeUnit[] = []           // audio seen before the muxer exists
      const encoded: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = []
      let encoderError: unknown

      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => { encoded.push({ chunk, meta }) },
        error: (e) => { encoderError = e }
      })
      videoEncoder.configure(encoderConfig)

      const collect = (): ArrayBuffer => {
        const total = outputChunks.reduce((n, c) => n + c.byteLength, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const c of outputChunks) { out.set(c, off); off += c.byteLength }
        outputChunks.length = 0
        return out.buffer
      }

      // The muxer can only be created once the encoder reports the H264 avcC (first chunk).
      const ensureMux = (meta?: EncodedVideoChunkMetadata) => {
        if (muxInited) return
        const cfg = meta?.decoderConfig
        if (cfg?.codec) videoMimeType = cfg.codec
        const avcC = cfg?.description ? toUint8(cfg.description) : new Uint8Array(0)
        const initSeg = remuxer.initTranscodeMux(
          avcC, width, height, init.hasAudio, init.audioExtradata, init.audioSampleRate, init.audioChannels
        )
        outputChunks.push(initSeg)
        muxInited = true
        for (const a of pendingAudio) {
          const out = remuxer.writeTranscodeAudio(a.data, Math.round(a.pts * 1e6), Math.round(a.duration * 1e6))
          if (out.byteLength) outputChunks.push(out)
        }
        pendingAudio.length = 0
      }

      // WebCodecs emits chunks in *decode* order; chunk.timestamp is the *presentation*
      // timestamp. Firefox produces B-frames even with latencyMode 'realtime', so pts is not
      // monotonic across consecutive chunks. The mp4 muxer requires monotonically-increasing
      // dts. Track our own monotonic dts.
      let lastDts = -Infinity
      const drainEncoded = () => {
        while (encoded.length) {
          const { chunk, meta } = encoded.shift()!
          ensureMux(meta)
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          const pts = chunk.timestamp
          const dts = lastDts === -Infinity ? pts : Math.max(pts, lastDts + 1)
          lastDts = dts
          const out = remuxer.writeTranscodeVideo(
            data, pts, dts, chunk.duration ?? 0, chunk.type === 'key'
          )
          if (out.byteLength) outputChunks.push(out)
        }
      }

      const encodeFrame = (unit: TranscodeUnit, forceKey: boolean) => {
        const frame = new VideoFrame(unit.data, {
          format: 'I420',
          codedWidth: unit.width,
          codedHeight: unit.height,
          timestamp: Math.round(unit.pts * 1e6),
          duration: Math.round(unit.duration * 1e6)
        })
        videoEncoder.encode(frame, { keyFrame: forceKey || unit.key })
        frame.close()
      }

      // Pull/encode/mux until at least one fragment's worth of bytes is available (or EOF).
      const pump = async (read: ReadFunction): Promise<TranscodeOutChunk> => {
        if (finished) return { data: new Uint8Array(0).buffer, pts: 0, duration: 0, finished: true }
        let firstPts = 0
        let haveFirstPts = false
        while (outputChunks.length === 0 || !muxInited) {
          if (encoderError) throw encoderError
          const unit = await remuxer.readTranscode(readToWasmRead(read))
          if (unit.cancelled) throw new Error('Cancelled')
          if (unit.type === 'eof') {
            await videoEncoder.flush()
            drainEncoded()
            if (muxInited) {
              const tail = remuxer.flushTranscodeMux()
              if (tail.byteLength) outputChunks.push(tail)
            }
            finished = true
            break
          }
          if (unit.type === 'video') {
            if (!haveFirstPts) { firstPts = unit.pts; haveFirstPts = true }
            encodeFrame(unit, false)
            drainEncoded()
          } else if (unit.type === 'audio') {
            if (muxInited) {
              const out = remuxer.writeTranscodeAudio(unit.data, Math.round(unit.pts * 1e6), Math.round(unit.duration * 1e6))
              if (out.byteLength) outputChunks.push(out)
            } else {
              pendingAudio.push(unit)
            }
          }
        }
        return { data: collect(), pts: firstPts, duration: 0, finished }
      }

      // First pump produces the init segment (ftyp+moov) plus the first fragment.
      const initChunk = await pump(read)

      return {
        get videoMimeType() { return videoMimeType },
        audioMimeType,
        initSegment: initChunk.data,
        read: (read: ReadFunction) => pump(read),
        seek: async (read: ReadFunction, timestamp: number): Promise<TranscodeOutChunk> => {
          const seekUnit = await remuxer.seekTranscode(readToWasmRead(read), timestamp)
          if (seekUnit.cancelled) throw new Error('Cancelled')
          // Restart the encoder and muxer so the seek produces a fresh IDR + re-init segment.
          try { await videoEncoder.flush() } catch {}
          encoded.length = 0
          pendingAudio.length = 0
          outputChunks.length = 0
          muxInited = false
          finished = false
          lastDts = -Infinity
          videoEncoder.reset()
          videoEncoder.configure(encoderConfig)
          if (seekUnit.type === 'video') {
            encodeFrame(seekUnit, true)
            drainEncoded()
          } else if (seekUnit.type === 'audio') {
            pendingAudio.push(seekUnit)
          }
          const frag = await pump(read)
          return { data: frag.data, pts: seekUnit.pts, duration: 0, finished: frag.finished }
        },
        readKeyframe: async (read: ReadFunction, timestamp: number) => {
          const unit = await remuxer.readKeyframeTranscode(readToWasmRead(read), timestamp)
          if (unit.cancelled || unit.type !== 'video') throw new Error('Cancelled')
          const frame = new VideoFrame(unit.data, {
            format: 'I420',
            codedWidth: unit.width,
            codedHeight: unit.height,
            timestamp: 0
          })
          offscreenContext!.drawImage(frame, 0, 0, 200 * 16 / 9, 200)
          frame.close()
          return offscreen.convertToBlob().then(blob => blob.arrayBuffer())
        },
        destroy: async () => {
          try { videoEncoder.close() } catch {}
        }
      }
    }

    let transcode: Awaited<ReturnType<typeof createTranscodePipeline>> | undefined

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
      destroy: async () => {
        await transcode?.destroy()
        return remuxer.destroy()
      },
      init: async (read: ReadFunction) => {
        const initResult = await remuxer.init(readToWasmRead(read))

        // If the browser can play the input video codec via MSE, keep the fast passthrough remux.
        if (await isVideoCodecSupported(initResult.info.input.videoMimeType)) {
          if (videoDecoder.state === 'unconfigured') {
            videoDecoder.configure({
              codec: initResult.info.input.videoMimeType,
              description: initResult.videoExtradata,
            })
          }
          return {
            ...initResult,
            data: transfer(initResult.data),
            videoExtradata: transfer(initResult.videoExtradata),
            attachments: initResult.attachments.map(a => ({ ...a, data: transfer(a.data) })),
          }
        }

        // Unsupported (e.g. HEVC on Chrome/Firefox): re-init in transcode mode and build the
        // WASM-decode -> WebCodecs-encode -> WASM-mux pipeline. The returned shape matches the
        // passthrough init so the public API and consumers are unchanged.
        const trInit = await remuxer.initTranscode(readToWasmRead(read))
        transcode = await createTranscodePipeline(trInit, read)
        return {
          data: transfer(transcode.initSegment),
          videoExtradata: transfer(new ArrayBuffer(0)),
          attachments: trInit.attachments.map(a => ({ ...a, data: transfer(a.data) })),
          subtitles: trInit.subtitles,
          indexes: trInit.indexes,
          chapters: trInit.chapters,
          info: {
            input: trInit.info.input,
            output: {
              ...trInit.info.output,
              videoMimeType: transcode.videoMimeType,
              audioMimeType: transcode.audioMimeType
            }
          }
        }
      },
      seek: (read: ReadFunction, timestamp: number) =>
        transcode
          ? transcode.seek(read, timestamp).then(res => ({ ...res, data: transfer(res.data), subtitles: [], offset: 0, cancelled: false }))
          : remuxer.seek(readToWasmRead(read), timestamp).then(res => ({ ...res, data: transfer(res.data) })),
      read: (read: ReadFunction) =>
        transcode
          ? transcode.read(read).then(res => ({ ...res, data: transfer(res.data), subtitles: [], offset: 0, cancelled: false }))
          : remuxer.read(readToWasmRead(read)).then(res => ({ ...res, data: transfer(res.data) })),
      readKeyframe: async (read: ReadFunction, timestamp: number) => {
        if (transcode) return transfer(await transcode.readKeyframe(read, timestamp))
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
        return offscreen.convertToBlob().then(blob => blob.arrayBuffer()).then(transfer)
      }
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { transport: globalThis })
