import { expose } from 'osra'
import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  VideoSampleSource,
  EncodedAudioPacketSource,
  VideoSample,
  EncodedPacket
} from 'mediabunny'
import type { StreamTargetChunk } from 'mediabunny'

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
      readKeyframeTranscode: (read, timestamp) => _remuxer.readKeyframeTranscode(read, timestamp).then(unitToJs)
    } as Remuxer

    const readToWasmRead = (read: ReadFunction) => (offset: number, size: number) =>
      read(Number(offset), Number(size))
        .then(
          ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
          () => ({ resolved: new Uint8Array(0), rejected: true })
        )

    // Whether this browser can play the given video codec via MSE. MediaSource is the
    // authoritative gate; fall back to WebCodecs decode support when MSE isn't exposed in
    // the worker (e.g. Firefox), which is fine because those browsers lack HEVC anyway.
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

    type TranscodeOutChunk = { data: ArrayBuffer; pts: number; duration: number; finished: boolean }

    // Builds the JS-side encode+mux pipeline that turns WASM-decoded I420 frames + passthrough
    // AAC into a fragmented MP4 stream consumable by MSE.
    const createTranscodePipeline = async (init: TranscodeInit, read: ReadFunction) => {
      let pendingOutput: Uint8Array[] = []
      let output!: Output
      let videoSource!: VideoSampleSource
      let audioSource: EncodedAudioPacketSource | undefined
      let audioConfigSent = false
      let finished = false

      const drainOutput = (): ArrayBuffer => {
        const total = pendingOutput.reduce((n, c) => n + c.byteLength, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const c of pendingOutput) { out.set(c, off); off += c.byteLength }
        pendingOutput = []
        return out.buffer
      }

      const buildOutput = async () => {
        pendingOutput = []
        audioConfigSent = false
        finished = false
        const writable = new WritableStream<StreamTargetChunk>({
          write: (chunk) => { pendingOutput.push(chunk.data) }
        })
        output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
          target: new StreamTarget(writable)
        })
        videoSource = new VideoSampleSource({
          codec: 'avc',
          bitrate: estimateBitrate(init.videoWidth, init.videoHeight)
        })
        output.addVideoTrack(videoSource)
        if (init.hasAudio) {
          audioSource = new EncodedAudioPacketSource('aac')
          output.addAudioTrack(audioSource)
        }
        await output.start()
      }

      const feedUnit = async (unit: TranscodeUnit) => {
        if (unit.type === 'video') {
          const sample = new VideoSample(unit.data, {
            format: 'I420',
            codedWidth: unit.width,
            codedHeight: unit.height,
            timestamp: unit.pts,
            duration: unit.duration
          })
          await videoSource.add(sample, { keyFrame: unit.key })
          sample.close()
        } else if (unit.type === 'audio' && audioSource) {
          const packet = new EncodedPacket(unit.data, 'key', unit.pts, unit.duration)
          if (!audioConfigSent) {
            await audioSource.add(packet, {
              decoderConfig: {
                codec: 'mp4a.40.2',
                numberOfChannels: init.audioChannels,
                sampleRate: init.audioSampleRate,
                ...(init.audioExtradata.byteLength ? { description: init.audioExtradata } : {})
              }
            })
            audioConfigSent = true
          } else {
            await audioSource.add(packet)
          }
        }
      }

      // Pull WASM units and feed the muxer until at least one fragment is flushed, or EOF.
      const pump = async (read: ReadFunction): Promise<TranscodeOutChunk> => {
        if (finished) return { data: new Uint8Array(0).buffer, pts: 0, duration: 0, finished: true }
        let firstPts = 0
        let haveFirstPts = false
        while (pendingOutput.length === 0) {
          const unit = await remuxer.readTranscode(readToWasmRead(read))
          if (unit.cancelled) throw new Error('Cancelled')
          if (unit.type === 'eof') {
            await output.finalize()
            finished = true
            break
          }
          if (!haveFirstPts && unit.type === 'video') { firstPts = unit.pts; haveFirstPts = true }
          await feedUnit(unit)
        }
        return { data: drainOutput(), pts: firstPts, duration: 0, finished }
      }

      // In fragmented mode the moov is only emitted once the first frame has been encoded (so the
      // exact avc profile/level is known), so pump the first bytes here: they contain ftyp+moov
      // plus the first fragment and serve as the MSE init segment.
      await buildOutput()
      const initChunk = await pump(read)

      // Resolve the precise codec string mediabunny actually produced (avc1.PPCCLL + mp4a.*),
      // which is what the SourceBuffer must be created with.
      let videoMimeType = `avc1.640028`
      let audioMimeType = init.info.output.audioMimeType
      try {
        const fullMime = await output.getMimeType()
        const codecs = /codecs="([^"]+)"/.exec(fullMime)?.[1]?.split(',').map(s => s.trim()) ?? []
        const v = codecs.find(c => /^(avc1|avc3|hev1|hvc1)\./.test(c))
        const a = codecs.find(c => /^mp4a\./.test(c))
        if (v) videoMimeType = v
        if (a) audioMimeType = a
      } catch {}

      return {
        videoMimeType,
        audioMimeType,
        initSegment: initChunk.data,
        read: (read: ReadFunction) => pump(read),
        seek: async (read: ReadFunction, timestamp: number): Promise<TranscodeOutChunk> => {
          const seekUnit = await remuxer.seekTranscode(readToWasmRead(read), timestamp)
          if (seekUnit.cancelled) throw new Error('Cancelled')
          // Timestamps jump on seek, so start a fresh fragmented stream. pump() then yields a new
          // ftyp+moov (re-initialization segment) followed by the first fragment.
          await buildOutput()
          if (seekUnit.type !== 'eof') await feedUnit(seekUnit)
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
        destroy: async () => { try { await output?.finalize() } catch {} }
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
          return initResult
        }

        // Unsupported (e.g. HEVC on Chrome/Firefox): re-init in transcode mode and build the
        // WASM-decode -> WebCodecs-encode -> mediabunny-mux pipeline. The returned shape matches
        // the passthrough init so the public API and consumers are unchanged.
        const trInit = await remuxer.initTranscode(readToWasmRead(read))
        transcode = await createTranscodePipeline(trInit, read)
        return {
          data: transcode.initSegment,
          videoExtradata: new Uint8Array(0).buffer,
          attachments: trInit.attachments,
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
          ? transcode.seek(read, timestamp).then(res => ({ ...res, subtitles: [], offset: 0, cancelled: false }))
          : remuxer.seek(readToWasmRead(read), timestamp),
      read: (read: ReadFunction) =>
        transcode
          ? transcode.read(read).then(res => ({ ...res, subtitles: [], offset: 0, cancelled: false }))
          : remuxer.read(readToWasmRead(read)),
      readKeyframe: async (read: ReadFunction, timestamp: number) => {
        if (transcode) return transcode.readKeyframe(read, timestamp)
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

expose(resolvers, { transport: globalThis })
