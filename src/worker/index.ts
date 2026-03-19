import { expose } from 'osra'
import type LibAVJS from 'libav.js'

declare let LibAV: LibAVJS.LibAVWrapper

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

type ReadFunction = (offset: number, size: number) => Promise<{
  resolved: ArrayBuffer
  rejected: boolean
}>

type WASMReadFunction = (offset: number, size: number) => Promise<{
  resolved: Uint8Array
  rejected: boolean
}>

// Codec ID constants from FFmpeg
const CODEC_IDS = {
  H264: 27,
  HEVC: 173,
  AAC: 86018,
  MP3: 86017,
  AC3: 86019,
  EAC3: 86056,
  OPUS: 86076,
  FLAC: 86028,
  SUBRIP: 94213,
  ASS: 94212,
  WEBVTT: 94215,
  PCM_S16LE: 65536,
  PCM_S16BE: 65537,
  PCM_F32LE: 65557,
} as const

function buildVideoMimeType(codecId: number, profile: number, level: number, extradata: Uint8Array): string {
  if (codecId === CODEC_IDS.H264) {
    if (extradata.length >= 4) {
      const profileIdc = extradata[1]
      const constraints = extradata[2]
      const levelIdc = extradata[3]
      return `avc1.${profileIdc.toString(16).padStart(2, '0')}${constraints.toString(16).padStart(2, '0')}${levelIdc.toString(16).padStart(2, '0')}`
    }
    return 'avc1.640029'
  }
  if (codecId === CODEC_IDS.HEVC) {
    return 'hev1.1.6.L93.B0'
  }
  return ''
}

function buildAudioMimeType(codecId: number): string {
  if (codecId === CODEC_IDS.AAC) return 'mp4a.40.2'
  if (codecId === CODEC_IDS.MP3) return 'mp4a.40.34'
  if (codecId === CODEC_IDS.AC3) return 'ac-3'
  if (codecId === CODEC_IDS.EAC3) return 'ec-3'
  if (codecId === CODEC_IDS.OPUS) return 'opus'
  if (codecId === CODEC_IDS.FLAC) return 'flac'
  return ''
}

function parseAssSubtitle(data: Uint8Array, format: string[]): Record<string, string> {
  const text = new TextDecoder().decode(data)
  const parts = text.split(',')
  const fields: Record<string, string> = {}
  for (let i = 0; i < format.length && i < parts.length; i++) {
    if (i === format.length - 1) {
      fields[format[i].trim()] = parts.slice(i).join(',')
    } else {
      fields[format[i].trim()] = parts[i]
    }
  }
  return fields
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
    const libav: LibAVJS.LibAV = await LibAV.LibAV({ noworker: true })

    const INPUT_DEV = 'input.mkv'
    const OUTPUT_DEV = 'output.mp4'

    let currentRead: WASMReadFunction | null = null

    // Set up block reader device for input (supports seeking)
    await libav.mkblockreaderdev(INPUT_DEV, length)
    libav.onblockread = async (name: string, pos: number, len: number) => {
      if (name === INPUT_DEV && currentRead) {
        const { resolved, rejected } = await currentRead(pos, len)
        if (rejected) {
          await libav.ff_block_reader_dev_send(name, pos, new Uint8Array(0))
        } else {
          await libav.ff_block_reader_dev_send(name, pos, new Uint8Array(resolved))
        }
      }
    }

    // Set up writer device for output
    let outputChunks: Uint8Array[] = []
    await libav.mkwriterdev(OUTPUT_DEV)
    libav.onwrite = (name: string, _pos: number, data: Uint8Array | Int8Array) => {
      if (name === OUTPUT_DEV) {
        outputChunks.push(new Uint8Array(data))
      }
    }

    const collectOutput = (): Uint8Array => {
      if (outputChunks.length === 0) return new Uint8Array(0)
      const totalLength = outputChunks.reduce((acc, c) => acc + c.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of outputChunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      outputChunks = []
      return result
    }

    let fmt_ctx = 0
    let streams: LibAVJS.Stream[] = []
    let pkt = 0
    let oc = 0
    let pb = 0

    let videoStreamIndex = -1
    let audioStreamIndex = -1
    let subtitleStreamIndices: number[] = []
    let streamMap = new Map<number, number>()

    // Subtitle format info per stream
    let subtitleFormats = new Map<number, string[]>()
    let subtitleLanguages = new Map<number, string>()
    let subtitleTitles = new Map<number, string>()
    let dialogueCounters = new Map<number, number>()

    // Track timestamps
    let lastPts = 0
    let lastDuration = 0
    let lastOffset = 0
    let finished = false

    // For readKeyframe: video decoder setup
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
    const offscreen = new OffscreenCanvas(200 * 16 / 9, 200)
    const offscreenContext = offscreen.getContext('2d')
    if (!offscreenContext) throw new Error('OffscreenCanvas not supported')

    const readToWasmRead = (read: ReadFunction) => (offset: number, size: number) =>
      read(Number(offset), Number(size))
        .then(
          ({ resolved, rejected }) => ({ resolved: new Uint8Array(resolved), rejected }),
          () => ({ resolved: new Uint8Array(0), rejected: true })
        )

    const processPackets = (
      allPackets: Record<number, LibAVJS.Packet[]>
    ): { outputPackets: LibAVJS.Packet[], subtitles: SubtitleFragment[] } => {
      const outputPackets: LibAVJS.Packet[] = []
      const subtitles: SubtitleFragment[] = []

      for (const [streamIdxStr, pkts] of Object.entries(allPackets)) {
        const streamIdx = Number(streamIdxStr)
        const outputIdx = streamMap.get(streamIdx)

        if (outputIdx !== undefined) {
          for (const p of pkts) {
            outputPackets.push({
              ...p,
              stream_index: outputIdx
            })
            if (streamIdx === videoStreamIndex) {
              const stream = streams.find(s => s.index === streamIdx)
              if (stream) {
                lastPts = ((p.pts ?? 0) * stream.time_base_num) / stream.time_base_den
                lastDuration = ((p.duration ?? 0) * stream.time_base_num) / stream.time_base_den
              }
            }
          }
        } else if (subtitleStreamIndices.includes(streamIdx)) {
          const format = subtitleFormats.get(streamIdx) ?? []
          for (const p of pkts) {
            const counter = dialogueCounters.get(streamIdx) ?? 0
            dialogueCounters.set(streamIdx, counter + 1)

            const fields = parseAssSubtitle(p.data, format)
            const stream = streams.find(s => s.index === streamIdx)
            const timeBase = stream ? stream.time_base_num / stream.time_base_den : 1 / 1000

            subtitles.push({
              type: 'dialogue',
              streamIndex: streamIdx,
              start: (p.pts ?? 0) * timeBase,
              end: ((p.pts ?? 0) + (p.duration ?? 0)) * timeBase,
              dialogueIndex: counter,
              layer: parseInt(fields['Layer'] ?? '0', 10) || 0,
              content: fields['Text'] ?? new TextDecoder().decode(p.data),
              fields
            })
          }
        }
      }

      return { outputPackets, subtitles }
    }

    return {
      destroy: async () => {
        try { await libav.av_write_trailer(oc) } catch {}
        try { await libav.ff_free_muxer(oc, pb) } catch {}
        try { await libav.av_packet_free(pkt) } catch {}
        libav.terminate()
      },

      init: async (read: ReadFunction) => {
        currentRead = readToWasmRead(read)

        // Initialize demuxer
        ;[fmt_ctx, streams] = await libav.ff_init_demuxer_file(INPUT_DEV)
        pkt = await libav.av_packet_alloc()

        const AVMEDIA_TYPE_VIDEO = libav.AVMEDIA_TYPE_VIDEO
        const AVMEDIA_TYPE_AUDIO = libav.AVMEDIA_TYPE_AUDIO
        const AVMEDIA_TYPE_SUBTITLE = libav.AVMEDIA_TYPE_SUBTITLE
        const AVMEDIA_TYPE_ATTACHMENT = libav.AVMEDIA_TYPE_ATTACHMENT

        // Categorize streams
        const attachments: Attachment[] = []

        for (const stream of streams) {
          if (stream.codec_type === AVMEDIA_TYPE_VIDEO && videoStreamIndex === -1) {
            videoStreamIndex = stream.index
          } else if (stream.codec_type === AVMEDIA_TYPE_AUDIO && audioStreamIndex === -1) {
            audioStreamIndex = stream.index
          } else if (stream.codec_type === AVMEDIA_TYPE_SUBTITLE) {
            subtitleStreamIndices.push(stream.index)
          } else if (stream.codec_type === AVMEDIA_TYPE_ATTACHMENT) {
            // Read attachment data from extradata
            const extradataPtr = await libav.AVCodecParameters_extradata(stream.codecpar)
            const extradataSize = await libav.AVCodecParameters_extradata_size(stream.codecpar)
            if (extradataPtr && extradataSize > 0) {
              const data = await libav.copyout_u8(extradataPtr, extradataSize)
              attachments.push({
                filename: '',
                mimetype: '',
                data: new Uint8Array(data).buffer as ArrayBuffer
              })
            }
          }
        }

        // Set up MP4 muxer with only video + audio streams
        const muxStreams: [number, number, number][] = []
        let outputIndex = 0

        if (videoStreamIndex >= 0) {
          const vs = streams.find(s => s.index === videoStreamIndex)!
          muxStreams.push([vs.codecpar, vs.time_base_num, vs.time_base_den])
          streamMap.set(videoStreamIndex, outputIndex++)
        }
        if (audioStreamIndex >= 0) {
          const as_ = streams.find(s => s.index === audioStreamIndex)!
          muxStreams.push([as_.codecpar, as_.time_base_num, as_.time_base_den])
          streamMap.set(audioStreamIndex, outputIndex++)
        }

        ;[oc, , pb] = await libav.ff_init_muxer({
          format_name: 'mp4',
          filename: OUTPUT_DEV,
          device: true,
          open: true,
          codecpars: true
        }, muxStreams)

        // Set fragmented MP4 flags for MSE compatibility
        const dict = await libav.av_dict_set_js(
          0, 'movflags', 'frag_keyframe+empty_moov+default_base_moof', 0
        )
        await libav.avformat_write_header(oc, dict)
        await libav.av_dict_free(dict)

        const headerData = collectOutput()

        // Get duration (in AV_TIME_BASE units, i.e. microseconds)
        const durationUs = await libav.AVFormatContext_duration(fmt_ctx)
        const duration = durationUs / 1_000_000

        // Get video codec info
        let videoMimeType = ''
        let videoExtradata = new Uint8Array(0)
        if (videoStreamIndex >= 0) {
          const vs = streams.find(s => s.index === videoStreamIndex)!
          const codecId = vs.codec_id
          const profile = await libav.AVCodecParameters_profile(vs.codecpar)
          const level = await libav.AVCodecParameters_level(vs.codecpar)
          const extradataPtr = await libav.AVCodecParameters_extradata(vs.codecpar)
          const extradataSize = await libav.AVCodecParameters_extradata_size(vs.codecpar)
          if (extradataPtr && extradataSize > 0) {
            videoExtradata = new Uint8Array(await libav.copyout_u8(extradataPtr, extradataSize))
          }
          videoMimeType = buildVideoMimeType(codecId, profile, level, videoExtradata)
        }

        // Get audio codec info
        let audioMimeType = ''
        if (audioStreamIndex >= 0) {
          const as_ = streams.find(s => s.index === audioStreamIndex)!
          audioMimeType = buildAudioMimeType(as_.codec_id)
        }

        // Build subtitle headers
        const subtitleHeaders: SubtitleFragment[] = []
        for (const idx of subtitleStreamIndices) {
          const stream = streams.find(s => s.index === idx)!
          const extradataPtr = await libav.AVCodecParameters_extradata(stream.codecpar)
          const extradataSize = await libav.AVCodecParameters_extradata_size(stream.codecpar)
          let headerContent = ''
          let format: string[] = []
          if (extradataPtr && extradataSize > 0) {
            const headerData = await libav.copyout_u8(extradataPtr, extradataSize)
            headerContent = new TextDecoder().decode(headerData)
            // Parse ASS format line
            const formatMatch = headerContent.match(/Format:\s*(.+)/i)
            if (formatMatch) {
              format = formatMatch[1].split(',').map(s => s.trim())
            }
          }
          subtitleFormats.set(idx, format)
          subtitleLanguages.set(idx, '')
          subtitleTitles.set(idx, '')
          dialogueCounters.set(idx, 0)

          subtitleHeaders.push({
            type: 'header',
            streamIndex: idx,
            content: headerContent,
            format,
            language: subtitleLanguages.get(idx) ?? '',
            title: subtitleTitles.get(idx) ?? ''
          })
        }

        // Build keyframe index by scanning the file
        const indexes: Index[] = []
        // We'll build the index by reading through packets
        // For now, do a quick scan to find keyframes
        let indexScanResult = 0
        let indexCount = 0
        while (indexScanResult >= 0 && indexScanResult !== -libav.EAGAIN) {
          const [res, pkts] = await libav.ff_read_frame_multi(fmt_ctx, pkt, { limit: bufferSize * 4 })
          indexScanResult = res

          if (videoStreamIndex >= 0 && pkts[videoStreamIndex]) {
            for (const p of pkts[videoStreamIndex]) {
              if (p.flags && (p.flags & libav.AV_PKT_FLAG_KEY)) {
                const stream = streams.find(s => s.index === videoStreamIndex)!
                const timestampSec = ((p.pts ?? 0) * stream.time_base_num) / stream.time_base_den
                indexes.push({
                  index: indexCount++,
                  timestamp: timestampSec,
                  pos: 0
                })
              }
            }
          }

          if (res < 0 && res !== -libav.EAGAIN) break
        }

        // Seek back to beginning after index scan
        if (videoStreamIndex >= 0) {
          await libav.av_seek_frame(fmt_ctx, videoStreamIndex, 0, 0, libav.AVSEEK_FLAG_BACKWARD)
        }

        // Configure video decoder for readKeyframe
        if (videoStreamIndex >= 0 && videoDecoder.state === 'unconfigured') {
          videoDecoder.configure({
            codec: videoMimeType,
            description: videoExtradata,
          })
        }

        currentRead = null

        const info = {
          input: {
            formatName: 'matroska',
            mimeType: 'video/x-matroska',
            videoMimeType,
            audioMimeType,
            duration
          },
          output: {
            formatName: 'mp4',
            mimeType: 'video/mp4',
            videoMimeType,
            audioMimeType,
            duration
          }
        }

        return {
          data: new Uint8Array(headerData).buffer,
          videoExtradata: new Uint8Array(videoExtradata).buffer,
          attachments,
          subtitles: subtitleHeaders,
          chapters: [] as Chapter[],
          indexes,
          info
        }
      },

      read: async (read: ReadFunction) => {
        currentRead = readToWasmRead(read)

        const [result, allPackets] = await libav.ff_read_frame_multi(fmt_ctx, pkt, { limit: bufferSize })
        const { outputPackets, subtitles } = processPackets(allPackets)

        if (outputPackets.length > 0) {
          await libav.ff_write_multi(oc, pkt, outputPackets)
        }

        const data = collectOutput()
        finished = result < 0 && result !== -libav.EAGAIN

        currentRead = null

        return {
          data: data.buffer as ArrayBuffer,
          subtitles,
          offset: lastOffset,
          pts: lastPts,
          duration: lastDuration,
          cancelled: false,
          finished
        }
      },

      seek: async (read: ReadFunction, timestamp: number) => {
        currentRead = readToWasmRead(read)

        // timestamp comes in milliseconds, convert to stream timebase
        const tsSeconds = timestamp / 1000
        if (videoStreamIndex >= 0) {
          const stream = streams.find(s => s.index === videoStreamIndex)!
          const seekTs = Math.floor(tsSeconds * stream.time_base_den / stream.time_base_num)
          await libav.av_seek_frame(fmt_ctx, videoStreamIndex, seekTs, 0, libav.AVSEEK_FLAG_BACKWARD)
        }

        // Read a batch of packets from the new position
        const [result, allPackets] = await libav.ff_read_frame_multi(fmt_ctx, pkt, { limit: bufferSize })
        const { outputPackets, subtitles } = processPackets(allPackets)

        if (outputPackets.length > 0) {
          await libav.ff_write_multi(oc, pkt, outputPackets)
        }

        const data = collectOutput()
        finished = result < 0 && result !== -libav.EAGAIN

        currentRead = null

        return {
          data: data.buffer as ArrayBuffer,
          subtitles,
          offset: lastOffset,
          pts: lastPts,
          duration: lastDuration,
          cancelled: false,
          finished
        }
      },

      readKeyframe: async (read: ReadFunction, timestamp: number) => {
        currentRead = readToWasmRead(read)

        // Seek to the requested timestamp
        if (videoStreamIndex >= 0) {
          const stream = streams.find(s => s.index === videoStreamIndex)!
          const seekTs = Math.floor(timestamp * stream.time_base_den / stream.time_base_num)
          await libav.av_seek_frame(fmt_ctx, videoStreamIndex, seekTs, 0, libav.AVSEEK_FLAG_BACKWARD)
        }

        // Read packets until we find a video keyframe
        let keyframeData: Uint8Array | null = null
        let keyframePts = 0
        let keyframeDuration = 0

        outer:
        while (true) {
          const [result, allPackets] = await libav.ff_read_frame_multi(fmt_ctx, pkt, { limit: bufferSize })

          if (videoStreamIndex >= 0 && allPackets[videoStreamIndex]) {
            for (const p of allPackets[videoStreamIndex]) {
              if (p.flags && (p.flags & libav.AV_PKT_FLAG_KEY)) {
                keyframeData = new Uint8Array(p.data)
                const stream = streams.find(s => s.index === videoStreamIndex)!
                keyframePts = ((p.pts ?? 0) * stream.time_base_num) / stream.time_base_den
                keyframeDuration = ((p.duration ?? 0) * stream.time_base_num) / stream.time_base_den
                break outer
              }
            }
          }

          if (result < 0) break
        }

        currentRead = null

        if (!keyframeData) {
          return {
            data: new ArrayBuffer(0),
            pts: 0,
            duration: 0,
            offset: 0,
            cancelled: false
          }
        }

        // Decode keyframe and render thumbnail
        const videoFramePromise = new Promise<VideoFrame>((resolve, reject) => {
          videoFrameResolve = resolve
          videoFrameReject = reject
        })

        videoDecoder.decode(new EncodedVideoChunk({
          type: 'key',
          timestamp: keyframePts * 1_000_000,
          duration: keyframeDuration * 1_000_000,
          data: keyframeData
        }))
        await videoDecoder.flush()
        const videoFrame = await videoFramePromise
        offscreenContext.drawImage(videoFrame, 0, 0, 200 * 16 / 9, 200)
        videoFrame.close()

        const blob = await offscreen.convertToBlob()
        const thumbnailBuffer = await blob.arrayBuffer()

        return thumbnailBuffer
      }
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { transport: globalThis })
