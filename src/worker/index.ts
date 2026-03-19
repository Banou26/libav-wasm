import { expose } from 'osra'
// @ts-ignore
import LibAVFactory from '@libav.js/variant-webcodecs'

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

type LibAVInstance = any

// MIME type helpers
function parseH264MimeType(extradata: Uint8Array): string {
  if (!extradata || extradata.length < 4 || extradata[0] !== 1) return 'avc1.000000'
  const profile = extradata[1]
  const constraints = extradata[2]
  const level = extradata[3]
  return `avc1.${profile.toString(16).padStart(2, '0')}${constraints.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`
}

function parseH265MimeType(extradata: Uint8Array): string {
  if (!extradata || extradata.length < 13 || extradata[0] !== 1) return 'hev1.1.0.L93.00'
  const multi = extradata[1]
  const profileSpace = multi >> 6
  const tierFlag = (multi & 0x20) >> 5
  const profileIdc = multi & 0x1F
  let compat = (extradata[2] << 24) | (extradata[3] << 16) | (extradata[4] << 8) | extradata[5]
  const constraint = extradata[6]
  const levelIdc = extradata[12]
  const spaceStr = ['', 'A', 'B', 'C'][profileSpace] || ''
  let reversed = 0
  for (let i = 0; i < 32; i++) {
    reversed |= compat & 1
    if (i < 31) { reversed <<= 1; compat >>= 1 }
  }
  const tierStr = tierFlag === 0 ? 'L' : 'H'
  return `hev1.${spaceStr}${profileIdc}.${reversed}.${tierStr}${levelIdc}.${constraint.toString(16).padStart(2, '0')}`
}

function parseMp4aMimeType(profile: number): string {
  // FF_PROFILE_AAC_LOW = 1, HE = 4, HE_V2 = 28, LD = 22, ELD = 38
  switch (profile) {
    case 1: return 'mp4a.40.2'
    case 4: return 'mp4a.40.5'
    case 28: return 'mp4a.40.29'
    case 22: return 'mp4a.40.23'
    case 38: return 'mp4a.40.39'
    default: return 'mp4a.40.2'
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
    const libav: LibAVInstance = await LibAVFactory.LibAV({ noworker: true, base: publicPath })

    const INPUT_FILE = 'input.mkv'
    const OUTPUT_FILE = 'output.mp4'

    // State
    let inputFmtCtx = 0
    let inputStreams: Array<{
      ptr: number; index: number; codecpar: number
      codec_type: number; codec_id: number
      time_base_num: number; time_base_den: number
      duration_time_base: number; duration: number
    }> = []
    let outputFmtCtx = 0
    let outputPb = 0
    let outputStreamPtrs: number[] = []
    let pktPtr = 0
    let streamMapping = new Map<number, number>()
    let videoStreamIndex = -1

    let currentRead: ReadFunction | null = null
    let writeChunks: Uint8Array[] = []
    let wrote = false

    // Fragment tracking
    let prevDuration = 0
    let prevPts = 0
    let prevPos = 0
    let fragmentDuration = 0
    let fragmentPts = 0
    let fragmentPos = 0

    let videoMimeType = ''
    let audioMimeType = ''
    let inputDuration = 0

    // Set up input block reader device
    await libav.mkblockreaderdev(INPUT_FILE, length)
    libav.onblockread = (filename: string, readPos: number, readLen: number) => {
      if (filename !== INPUT_FILE || !currentRead) {
        libav.ff_block_reader_dev_send(filename, readPos, null)
        return
      }
      currentRead(readPos, readLen)
        .then(({ resolved, rejected }: { resolved: ArrayBuffer, rejected: boolean }) => {
          if (rejected || !resolved || resolved.byteLength === 0) {
            libav.ff_block_reader_dev_send(filename, readPos, null)
          } else {
            libav.ff_block_reader_dev_send(filename, readPos, new Uint8Array(resolved))
          }
        })
        .catch(() => {
          libav.ff_block_reader_dev_send(filename, readPos, null)
        })
    }

    // Output writer callback (set before ff_init_muxer creates the device)
    libav.onwrite = (filename: string, _writePos: number, buffer: Uint8Array | Int8Array) => {
      if (filename !== OUTPUT_FILE) return
      wrote = true
      writeChunks.push(new Uint8Array(buffer))
    }

    function collectOutput(): ArrayBuffer {
      if (writeChunks.length === 0) return new ArrayBuffer(0)
      const total = writeChunks.reduce((s, b) => s + b.length, 0)
      const result = new Uint8Array(total)
      let off = 0
      for (const chunk of writeChunks) {
        result.set(chunk, off)
        off += chunk.length
      }
      writeChunks = []
      return result.buffer
    }

    async function openDemuxer() {
      const [fmtCtx, streams] = await libav.ff_init_demuxer_file(INPUT_FILE)
      inputFmtCtx = fmtCtx
      inputStreams = streams
      const durLo = await libav.AVFormatContext_duration(fmtCtx)
      const durHi = await libav.AVFormatContext_durationhi(fmtCtx)
      inputDuration = libav.i64tof64(durLo, durHi) / libav.AV_TIME_BASE
    }

    async function closeDemuxer() {
      if (inputFmtCtx) {
        await libav.avformat_close_input_js(inputFmtCtx)
        inputFmtCtx = 0
      }
    }

    async function openMuxer() {
      streamMapping.clear()
      const streamCtxs: [number, number, number][] = []
      let outIdx = 0

      for (const stream of inputStreams) {
        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO ||
            stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
          streamCtxs.push([stream.codecpar, stream.time_base_num, stream.time_base_den])
          streamMapping.set(stream.index, outIdx++)
          if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            videoStreamIndex = stream.index
          }
        }
      }

      const [oc, , pb, osts] = await libav.ff_init_muxer({
        format_name: 'mp4',
        filename: OUTPUT_FILE,
        device: true,
        codecpars: true
      }, streamCtxs)

      outputFmtCtx = oc
      outputPb = pb
      outputStreamPtrs = osts

      // Set fragmented MP4 flags via av_opt_set (avoids dict pointer complexity)
      await libav.av_opt_set(outputFmtCtx, 'movflags', 'frag_keyframe+empty_moov+default_base_moof', libav.AV_OPT_SEARCH_CHILDREN)
      await libav.avformat_write_header(outputFmtCtx, 0)
    }

    async function closeMuxer() {
      if (outputFmtCtx && outputPb) {
        await libav.ff_free_muxer(outputFmtCtx, outputPb)
        outputFmtCtx = 0
        outputPb = 0
      }
    }

    async function detectMimeTypes() {
      videoMimeType = ''
      audioMimeType = ''
      for (const stream of inputStreams) {
        const codecName: string = await libav.avcodec_get_name(stream.codec_id)
        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
          const cp = await libav.ff_copyout_codecpar(stream.codecpar)
          if (codecName === 'h264' && cp.extradata) {
            videoMimeType = parseH264MimeType(cp.extradata)
          } else if (codecName === 'hevc' && cp.extradata) {
            videoMimeType = parseH265MimeType(cp.extradata)
          }
        }
        if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
          if (codecName === 'aac') {
            const profile = await libav.AVCodecParameters_profile(stream.codecpar)
            audioMimeType = parseMp4aMimeType(profile)
          } else if (codecName === 'eac3') {
            audioMimeType = 'ec-3'
          }
        }
      }
    }

    // Allocate a reusable packet
    pktPtr = await libav.av_packet_alloc()

    // Video decoder for thumbnails
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

    async function readFragment(): Promise<{
      data: ArrayBuffer
      subtitles: SubtitleFragment[]
      offset: number
      pts: number
      duration: number
      cancelled: boolean
      finished: boolean
    }> {
      writeChunks = []
      wrote = false
      const subtitles: SubtitleFragment[] = []
      let finished = false
      fragmentDuration = 0

      while (true) {
        const ret = await libav.av_read_frame(inputFmtCtx, pktPtr)

        if (ret === libav.AVERROR_EOF) {
          await libav.av_write_trailer(outputFmtCtx)
          finished = true
          break
        }

        if (ret < 0) {
          // Error or cancellation
          throw new Error('Cancelled')
        }

        const streamIdx: number = await libav.AVPacket_stream_index(pktPtr)
        const stream = inputStreams.find(s => s.index === streamIdx)
        if (!stream) {
          await libav.av_packet_unref(pktPtr)
          continue
        }

        // Handle subtitle packets
        if (stream.codec_type === libav.AVMEDIA_TYPE_SUBTITLE) {
          const pkt = await libav.ff_copyout_packet(pktPtr)
          subtitles.push({
            type: 'dialogue',
            streamIndex: streamIdx,
            start: pkt.pts || 0,
            end: (pkt.pts || 0) + (pkt.duration || 0),
            dialogueIndex: 0,
            layer: 0,
            content: new TextDecoder().decode(pkt.data),
            fields: {}
          })
          await libav.av_packet_unref(pktPtr)
          continue
        }

        // Skip non-mapped streams (attachments, etc.)
        const outIdx = streamMapping.get(streamIdx)
        if (outIdx === undefined) {
          await libav.av_packet_unref(pktPtr)
          continue
        }

        // Get packet info before rescaling
        const flags: number = await libav.AVPacket_flags(pktPtr)
        const pktPts: number = await libav.AVPacket_pts(pktPtr)
        const pktDur: number = await libav.AVPacket_duration(pktPtr)
        const pktPos: number = await libav.AVPacket_pos(pktPtr)

        // Rescale timestamps from input to output time base
        const outStreamPtr = outputStreamPtrs[outIdx]
        const outTbNum = await libav.AVStream_time_base_num(outStreamPtr)
        const outTbDen = await libav.AVStream_time_base_den(outStreamPtr)
        await libav.av_packet_rescale_ts_js(
          pktPtr,
          stream.time_base_num, stream.time_base_den,
          outTbNum, outTbDen
        )
        await libav.AVPacket_stream_index_s(pktPtr, outIdx)

        // Track video keyframes for fragment boundaries
        const isKeyframe = (flags & libav.AV_PKT_FLAG_KEY) !== 0
        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
          const durSecs = pktDur * stream.time_base_num / stream.time_base_den
          fragmentDuration += durSecs

          if (isKeyframe) {
            prevDuration = fragmentDuration
            prevPts = fragmentPts
            prevPos = fragmentPos

            fragmentDuration = 0
            fragmentPts = pktPts * stream.time_base_num / stream.time_base_den
            fragmentPos = pktPos
          }
        }

        // Write packet to muxer
        const writeRet = await libav.av_interleaved_write_frame(outputFmtCtx, pktPtr)
        if (writeRet < 0) {
          console.error('Error writing frame:', writeRet)
        }

        await libav.av_packet_unref(pktPtr)

        // Check if the muxer produced output (fragment boundary crossed)
        if (wrote) {
          wrote = false
          break
        }
      }

      const data = collectOutput()
      currentRead = null

      return {
        data,
        subtitles,
        offset: prevPos,
        pts: prevPts,
        duration: prevDuration,
        cancelled: false,
        finished
      }
    }

    return {
      destroy: async () => {
        try { await libav.av_write_trailer(outputFmtCtx) } catch {}
        await closeMuxer()
        if (pktPtr) {
          await libav.av_packet_free_js(pktPtr)
          pktPtr = 0
        }
        await closeDemuxer()
        libav.terminate()
      },

      init: async (read: ReadFunction) => {
        currentRead = read
        writeChunks = []

        await openDemuxer()
        await detectMimeTypes()
        await openMuxer()

        const headerData = collectOutput()

        // Extract subtitle headers and attachments from stream metadata
        const subtitles: SubtitleFragment[] = []
        const attachments: Attachment[] = []
        let videoExtradata = new ArrayBuffer(0)

        for (const stream of inputStreams) {
          const cp = await libav.ff_copyout_codecpar(stream.codecpar)

          if (stream.codec_type === libav.AVMEDIA_TYPE_SUBTITLE) {
            subtitles.push({
              type: 'header',
              streamIndex: stream.index,
              content: cp.extradata ? new TextDecoder().decode(cp.extradata) : '',
              format: [],
              language: '',
              title: ''
            })
          }

          if (stream.codec_type === libav.AVMEDIA_TYPE_ATTACHMENT && cp.extradata) {
            attachments.push({
              filename: '',
              mimetype: '',
              data: cp.extradata.buffer
            })
          }

          if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO && cp.extradata) {
            videoExtradata = cp.extradata.buffer
          }
        }

        // Configure video decoder for thumbnail extraction
        if (videoMimeType && videoExtradata.byteLength > 0) {
          if (videoDecoder.state === 'unconfigured') {
            videoDecoder.configure({
              codec: videoMimeType,
              description: new Uint8Array(videoExtradata),
            })
          }
        }

        currentRead = null
        wrote = false

        return {
          data: headerData,
          videoExtradata,
          attachments,
          subtitles,
          indexes: [] as Index[],
          chapters: [] as Chapter[],
          info: {
            input: {
              audioMimeType,
              duration: inputDuration,
              formatName: 'matroska,webm',
              mimeType: 'video/x-matroska',
              videoMimeType,
            },
            output: {
              audioMimeType,
              duration: 0,
              formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
              mimeType: 'video/mp4',
              videoMimeType,
            }
          }
        }
      },

      seek: async (read: ReadFunction, timestamp: number) => {
        currentRead = read
        writeChunks = []
        wrote = false

        // Close old muxer
        try { await libav.av_write_trailer(outputFmtCtx) } catch {}
        await closeMuxer()

        // Close and reopen demuxer for clean state
        await closeDemuxer()

        // Clean up old output device
        try { await libav.unlink(OUTPUT_FILE) } catch {}

        // Reinitialize
        await openDemuxer()
        await openMuxer()
        writeChunks = []
        wrote = false

        // Reset fragment tracking
        prevDuration = 0
        prevPts = 0
        prevPos = 0
        fragmentDuration = 0
        fragmentPts = 0
        fragmentPos = 0

        // Seek to timestamp (convert seconds to stream time base)
        const videoStream = inputStreams.find(s => s.index === videoStreamIndex)
        const seekTs = videoStream
          ? Math.round(timestamp * 1000 * videoStream.time_base_den / videoStream.time_base_num)
          : Math.round(timestamp * 1000)
        const [lo, hi] = libav.f64toi64(seekTs)
        await libav.av_seek_frame(inputFmtCtx, videoStreamIndex, lo, hi, libav.AVSEEK_FLAG_BACKWARD)

        // Read first fragment after seek
        return readFragment()
      },

      read: async (read: ReadFunction) => {
        currentRead = read
        return readFragment()
      },

      readKeyframe: async (read: ReadFunction, timestamp: number) => {
        currentRead = read

        // Seek to timestamp
        const seekTs = timestamp * libav.AV_TIME_BASE
        const [lo, hi] = libav.f64toi64(seekTs)
        await libav.av_seek_frame(inputFmtCtx, videoStreamIndex, lo, hi, libav.AVSEEK_FLAG_BACKWARD)

        // Read packets until we find a video keyframe
        while (true) {
          const ret = await libav.av_read_frame(inputFmtCtx, pktPtr)
          if (ret < 0) throw new Error('Failed to read keyframe')

          const streamIdx = await libav.AVPacket_stream_index(pktPtr)
          const flags = await libav.AVPacket_flags(pktPtr)

          if (streamIdx !== videoStreamIndex || !(flags & libav.AV_PKT_FLAG_KEY)) {
            await libav.av_packet_unref(pktPtr)
            continue
          }

          // Found keyframe - extract data
          const packet = await libav.ff_copyout_packet(pktPtr)

          const videoFramePromise = new Promise<VideoFrame>((resolve, reject) => {
            videoFrameResolve = resolve
            videoFrameReject = reject
          })

          videoDecoder.decode(new EncodedVideoChunk({
            type: 'key',
            timestamp: packet.pts || 0,
            duration: packet.duration || 0,
            data: packet.data
          }))
          videoDecoder.flush()

          const videoFrame = await videoFramePromise
          offscreenContext.drawImage(videoFrame, 0, 0, 200 * 16 / 9, 200)
          videoFrame.close()

          await libav.av_packet_unref(pktPtr)
          currentRead = null

          return offscreen.convertToBlob().then(blob => blob.arrayBuffer())
        }
      }
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { transport: globalThis })
