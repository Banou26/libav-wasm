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
  initAudioOnlyMux: (audioExtradata: Uint8Array, sampleRate: number, channels: number) => Uint8Array;
  setVideoDecodeSkipNonref: (on: boolean) => void;
  setSkipVideoDecode: (on: boolean) => void;
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
  initAudioOnlyMux: (audioExtradata: Uint8Array, sampleRate: number, channels: number) => Uint8Array
  setVideoDecodeSkipNonref: (on: boolean) => void
  setSkipVideoDecode: (on: boolean) => void
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
  // Filter out noisy-but-harmless ffmpeg log lines. "Read error at pos" fires on every
  // EOF probe. "Unknown profile bitstream" is emitted by the HEVC parser on every
  // profile_tier_level NAL because our build uses --enable-small, which compiles out the
  // profile-name lookup table (mainline ffmpeg shows it too on -enable-small builds).
  const NOISE = /Read error at pos|Unknown profile bitstream/
  return (mod.default ?? mod)({
    locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
    print: (text: string) => console.log(text),
    printErr: (text: string) => NOISE.test(text) ? undefined : console.error(text),
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
    { moduleUrl, wasmUrl, threadedModuleUrl, threadedWasmUrl, length, bufferSize, threadCount, renderCanvas, forceTranscode, log }:
    {
      moduleUrl: string
      wasmUrl: string
      threadedModuleUrl?: string
      threadedWasmUrl?: string
      length: number
      bufferSize: number
      threadCount?: number
      renderCanvas?: OffscreenCanvas
      forceTranscode?: boolean
      log: (isError: boolean, text: string) => Promise<void>
    }
  ) => {
    // renderCanvas (transferred via osra, when set): the HEVC fallback draws decoded frames onto it;
    // the app drives it via renderFrame(time).
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
    // Cap thread auto-detect (threadCount=0) at 8. Past ~8 threads, HEVC frame threading
    // on high-resolution content (1440p+) regresses badly — per-thread frame buffers blow
    // out caches and the synchronization overhead exceeds the parallelism win. Measured
    // on a 16-core box: 8 threads gave 0.68× realtime at 4K, 16 threads collapsed to
    // 0.00× (couldn't even produce a second fragment in 127s). Users can still pass an
    // explicit threadCount > 8 if they really want it.
    const hwConcurrency = (globalThis as any).navigator?.hardwareConcurrency ?? 4
    const requested = threadCount ?? 1
    const effectiveThreadCount = useThreads
      ? (requested === 0 ? Math.min(hwConcurrency, 8) : requested)
      : 1
    log(false, `libav-wasm: loaded ${useThreads ? 'multi-threaded' : 'single-threaded'} build (thread_count=${effectiveThreadCount}, hardwareConcurrency=${hwConcurrency})`)

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
      initAudioOnlyMux: (audioExtradata, sampleRate, channels) =>
        copyBytes(_remuxer.initAudioOnlyMux(audioExtradata, sampleRate, channels)),
      setVideoDecodeSkipNonref: (on) => _remuxer.setVideoDecodeSkipNonref(on),
      setSkipVideoDecode: (on) => _remuxer.setSkipVideoDecode(on),
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

      // Firefox produces B-frames even with `latencyMode: 'realtime'`, so chunk.timestamp
      // (presentation time) is not monotonic across the encoder's output callbacks (which
      // arrive in decode/coding order). The fragmented MP4 muxer needs DTS to be strictly
      // monotonic AND ≤ PTS for every frame, which our previous `dts = max(pts, lastDts+1)`
      // hack broke for B-frames — the muxer rejected them and the dropped frames showed up
      // as stutters on playback.
      //
      // Strategy: assign DTS in coding order with a fixed back-offset so DTS lands before
      // the corresponding PTS by enough to absorb the encoder's max reorder distance. The
      // first chunk's DTS is set to `pts - REORDER_OFFSET_US`; each subsequent chunk's DTS
      // is `firstDts + codingIndex * frameDurationUs`. As long as REORDER_OFFSET_US is at
      // least max(pts_seen_so_far - current_pts) across the stream, every frame satisfies
      // dts ≤ pts.
      const frameDurationUs = Math.max(1, Math.round(1_000_000 / framerate))
      const REORDER_OFFSET_US = frameDurationUs * 8  // tolerate up to 8 frames of B-reorder
      let firstDts = -Infinity
      let codingIndex = 0
      const drainEncoded = () => {
        while (encoded.length) {
          const { chunk, meta } = encoded.shift()!
          ensureMux(meta)
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          const pts = chunk.timestamp
          if (firstDts === -Infinity) firstDts = pts - REORDER_OFFSET_US
          const dts = firstDts + codingIndex * frameDurationUs
          codingIndex++
          const out = remuxer.writeTranscodeVideo(
            data, pts, dts, chunk.duration ?? frameDurationUs, chunk.type === 'key'
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

      // WebCodecs VideoEncoder.output is dispatched as a macrotask, so the pump loop must
      // yield to macrotasks for the encoder to actually deliver encoded chunks. Without this
      // yield, pump runs decode → encode → drainEncoded (sees nothing) in a tight microtask
      // loop, builds up the entire encoder queue, and only gets output on the final EOF flush.
      // The MessageChannel trick is ~0.5ms per yield vs ~4ms for setTimeout(0).
      const yieldMacrotask = () => new Promise<void>((resolve) => {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => resolve()
        ch.port2.postMessage(null)
      })

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
            // Apply backpressure: don't queue more frames if the encoder is far behind.
            // The encoder's output callback is a macrotask, so we yield until the queue
            // depth drops (or we hit a cap, just in case the encoder hangs). Without this,
            // a fast decoder (e.g. the multi-threaded build at any resolution, or the
            // single-threaded build on small frames) outruns the encoder by the entire
            // file's worth of frames before any output arrives, and pump returns one giant
            // fragment containing everything.
            await yieldMacrotask()
            drainEncoded()
            let guard = 0
            while (videoEncoder.encodeQueueSize > 8 && guard++ < 1_000) {
              await yieldMacrotask()
              drainEncoded()
            }
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
          firstDts = -Infinity
          codingIndex = 0
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

    // Decode-render fallback: decode HEVC -> I420 and draw frames onto the canvas (no re-encode/MSE).
    // The app drives it via renderFrame(time) against its own clock; superseded frames count skipped.
    const createDecodeRenderPipeline = async (init: TranscodeInit, canvas: OffscreenCanvas) => {
      // The worker owns the OffscreenCanvas, so size its bitmap to the video here — the caller can't
      // (setting width/height throws once a canvas is transferred). CSS scales it for display.
      canvas.width = init.videoWidth
      canvas.height = init.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('render canvas: 2d context unavailable')

      // Set up the audio-only fMP4 sink (the app feeds it to MSE as the seekable timeline + clock).
      const initAudioMux = (): Uint8Array =>
        init.hasAudio
          ? remuxer.initAudioOnlyMux(init.audioExtradata, init.audioSampleRate, init.audioChannels)
          : new Uint8Array(0)
      let audioInitSegment = initAudioMux()

      let pendingUnit: TranscodeUnit | undefined // decoded frame whose pts overshot the last target
      let finished = false
      let totalDecoded = 0
      let totalSkipped = 0
      let lastPresentedPts = -1
      let skipNonref = false // whether we've told the decoder to drop B-frames to catch up
      const audioChunks: Uint8Array[] = []

      const draw = (unit: TranscodeUnit) => {
        const frame = new VideoFrame(unit.data, {
          format: 'I420', codedWidth: unit.width, codedHeight: unit.height, timestamp: Math.round(unit.pts * 1e6),
        })
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
        frame.close()
        lastPresentedPts = unit.pts
      }

      const muxAudio = (unit: TranscodeUnit) => {
        const out = remuxer.writeTranscodeAudio(unit.data, Math.round(unit.pts * 1e6), Math.round(unit.duration * 1e6))
        if (out.byteLength) audioChunks.push(out)
      }

      const collectAudio = (): ArrayBuffer => {
        if (!audioChunks.length) return new Uint8Array(0).buffer
        const total = audioChunks.reduce((n, c) => n + c.byteLength, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const c of audioChunks) { out.set(c, off); off += c.byteLength }
        audioChunks.length = 0
        return out.buffer
      }

      // Advance decoding to `time` (seconds) and draw the frame with the largest pts <= time;
      // an earlier frame superseded before display counts as skipped.
      const renderFrame = async (read: ReadFunction, time: number) => {
        let toShow: TranscodeUnit | undefined
        let decoded = 0
        let skipped = 0
        if (pendingUnit && pendingUnit.pts <= time) { toShow = pendingUnit; pendingUnit = undefined }
        while (!finished && !pendingUnit) {
          const unit = await remuxer.readTranscode(readToWasmRead(read))
          if (unit.cancelled) throw new Error('Cancelled')
          if (unit.type === 'eof') { finished = true; break }
          if (unit.type !== 'video') continue // audio is handled separately by extractAudio()
          decoded++
          if (unit.pts <= time) {
            if (toShow) skipped++
            toShow = unit
          } else {
            pendingUnit = unit // overshot the target; hold for a later renderFrame
          }
        }
        totalDecoded += decoded
        totalSkipped += skipped
        if (toShow) draw(toShow)
        // Adaptive catch-up: decoding many frames per call means the clock outran the decoder (4K) —
        // drop B-frames to cut cost, restore once caught up. Hysteresis (6/2) avoids flapping.
        if (!skipNonref && decoded >= 6) { skipNonref = true; remuxer.setVideoDecodeSkipNonref(true) }
        else if (skipNonref && decoded <= 2) { skipNonref = false; remuxer.setVideoDecodeSkipNonref(false) }
        return { decoded, skipped, totalDecoded, totalSkipped, presentedPts: lastPresentedPts, finished, skippingNonref: skipNonref }
      }

      // Extract the whole audio track to fMP4 without decoding video, then rewind for video.
      // Returns all fragments concatenated — append after the audio init segment.
      const extractAudio = async (read: ReadFunction): Promise<ArrayBuffer> => {
        remuxer.setSkipVideoDecode(true)
        audioChunks.length = 0
        try {
          for (;;) {
            const unit = await remuxer.readTranscode(readToWasmRead(read))
            if (unit.cancelled) throw new Error('Cancelled')
            if (unit.type === 'eof') break
            if (unit.type === 'audio') muxAudio(unit)
          }
        } finally {
          remuxer.setSkipVideoDecode(false)
        }
        const all = collectAudio()
        const su = await remuxer.seekTranscode(readToWasmRead(read), 0) // rewind for video playback
        if (su.cancelled) throw new Error('Cancelled')
        finished = false
        pendingUnit = undefined
        return all
      }

      // Read the presented frame back as RGBA at w×h (visual tests) — exact, no screenshot needed.
      const captureFrame = (w: number, h: number): Uint8Array => {
        const rc = new OffscreenCanvas(w, h)
        const rctx = rc.getContext('2d', { willReadFrequently: true })!
        rctx.drawImage(canvas, 0, 0, w, h)
        return new Uint8Array(rctx.getImageData(0, 0, w, h).data.buffer)
      }

      return {
        videoWidth: init.videoWidth,
        videoHeight: init.videoHeight,
        framerate: init.videoFpsDen ? init.videoFpsNum / init.videoFpsDen : 30,
        hasAudio: init.hasAudio,
        audioMimeType: init.info.output.audioMimeType,
        get audioInitSegment() { return audioInitSegment },
        renderFrame,
        extractAudio,
        captureFrame,
        // Video-only seek (the app seeks the audio MSE timeline itself); presents the keyframe.
        seek: async (read: ReadFunction, time: number) => {
          const seekUnit = await remuxer.seekTranscode(readToWasmRead(read), time)
          if (seekUnit.cancelled) throw new Error('Cancelled')
          finished = false
          pendingUnit = undefined
          if (seekUnit.type === 'video') draw(seekUnit)
          return { data: new ArrayBuffer(0), subtitles: [] as SubtitleFragment[], offset: 0, pts: seekUnit.pts, duration: 0, cancelled: false, finished: false }
        },
        destroy: async () => {},
      }
    }

    let transcode: Awaited<ReturnType<typeof createTranscodePipeline>> | undefined
    let decodeRender: Awaited<ReturnType<typeof createDecodeRenderPipeline>> | undefined

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
        await decodeRender?.destroy()
        return remuxer.destroy()
      },
      // Decode-render mode only (decodeRender set); reject / no-op otherwise.
      renderFrame: (read: ReadFunction, time: number) =>
        decodeRender
          ? decodeRender.renderFrame(read, time)
          : Promise.reject(new Error('renderFrame: not in decode-render mode (no renderCanvas)')),
      extractAudio: (read: ReadFunction) =>
        decodeRender ? decodeRender.extractAudio(read).then((buf) => transfer(buf)) : Promise.resolve(transfer(new ArrayBuffer(0))),
      captureRenderedFrame: (w: number, h: number) =>
        decodeRender ? transfer(decodeRender.captureFrame(w, h)) : new Uint8Array(0),
      setSkipVideoDecode: (on: boolean) => remuxer.setSkipVideoDecode(on),
      setVideoDecodeSkipNonref: (on: boolean) => remuxer.setVideoDecodeSkipNonref(on),
      init: async (read: ReadFunction) => {
        const initResult = await remuxer.init(readToWasmRead(read))

        // If the browser can play the input video codec via MSE, keep the fast passthrough remux.
        // forceTranscode skips this so the transcode/decode-render path engages regardless.
        if (!forceTranscode && await isVideoCodecSupported(initResult.info.input.videoMimeType)) {
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

        // Preferred fallback: decode + render directly to the canvas (no re-encode).
        if (renderCanvas) {
          log(false, 'libav-wasm: HEVC fallback via decode-render (canvas)')
          decodeRender = await createDecodeRenderPipeline(trInit, renderCanvas)
          return {
            renderMode: 'canvas' as const,
            // Video goes to the canvas; `data` empty for shape parity. Feed audioInitSegment +
            // extractAudio() to an MSE SourceBuffer for the timeline.
            data: transfer(new ArrayBuffer(0)),
            videoExtradata: transfer(new ArrayBuffer(0)),
            videoWidth: decodeRender.videoWidth,
            videoHeight: decodeRender.videoHeight,
            framerate: decodeRender.framerate,
            hasAudio: decodeRender.hasAudio,
            audioMimeType: decodeRender.audioMimeType,
            audioInitSegment: transfer(decodeRender.audioInitSegment.slice().buffer),
            attachments: trInit.attachments.map(a => ({ ...a, data: transfer(a.data) })),
            subtitles: trInit.subtitles,
            indexes: trInit.indexes,
            chapters: trInit.chapters,
            info: trInit.info,
          }
        }

        // Safety-net fallback: WASM-decode -> WebCodecs-encode -> WASM-mux into MSE fMP4.
        log(false, 'libav-wasm: HEVC fallback via WebCodecs re-encode (no render canvas)')
        transcode = await createTranscodePipeline(trInit, read)
        return {
          renderMode: 'mse' as const,
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
        decodeRender
          ? decodeRender.seek(read, timestamp)
          : transcode
            ? transcode.seek(read, timestamp).then(res => ({ ...res, data: transfer(res.data), subtitles: [], offset: 0, cancelled: false }))
            : remuxer.seek(readToWasmRead(read), timestamp).then(res => ({ ...res, data: transfer(res.data) })),
      read: (read: ReadFunction) =>
        decodeRender
          // Decode-render delivers video via renderFrame; read() is a no-op.
          ? Promise.resolve({ data: transfer(new ArrayBuffer(0)), subtitles: [], offset: 0, pts: 0, duration: 0, cancelled: false, finished: false })
          : transcode
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
