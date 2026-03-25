import type { MakeTransmuxerOptions } from './index'
import { makeRemuxer } from './index'

export type HlsSegment = {
  index: number
  duration: number
  pts: number
  url: string
  data: ArrayBuffer
}

export type HlsPlaylist = {
  /** The current m3u8 playlist content as a string */
  content: string
  /** Blob URL for the m3u8 playlist, usable by video.js / hls.js */
  url: string
}

export type HlsRemuxerOptions = MakeTransmuxerOptions & {
  /**
   * Target segment duration in seconds. Segments are cut at keyframes,
   * so actual duration may vary. Default: 6
   */
  targetSegmentDuration?: number
}

export type HlsRemuxer = {
  /**
   * Initialize the remuxer — probes the input, returns metadata
   * and prepares the HLS init segment.
   */
  init: () => Promise<{
    /** Media info (codecs, duration, etc.) */
    info: {
      input: { audioMimeType: string; duration: number; formatName: string; mimeType: string; videoMimeType: string }
      output: { audioMimeType: string; duration: number; formatName: string; mimeType: string; videoMimeType: string }
    }
    /** Blob URL for the fMP4 init segment */
    initSegmentUrl: string
    /** Raw init segment data */
    initSegmentData: ArrayBuffer
    /** Attachments (fonts, etc.) */
    attachments: { filename: string; mimetype: string; data: ArrayBuffer }[]
    /** Subtitle headers */
    subtitles: any[]
    /** Chapter list */
    chapters: { index: number; start: number; end: number; title: string }[]
    /** Keyframe index */
    indexes: { index: number; timestamp: number; pos: number }[]
  }>

  /**
   * Read the next segment from the stream. Returns null when finished.
   * Call this in a loop to lazily process the entire file.
   */
  readNextSegment: () => Promise<HlsSegment | null>

  /**
   * Seek to a timestamp (seconds) and read the segment at that position.
   */
  seekToSegment: (timestamp: number) => Promise<HlsSegment | null>

  /**
   * Get the current HLS playlist. The playlist grows as segments are read.
   * For live/event mode, call this after each readNextSegment().
   * For VOD mode, call after all segments have been read.
   */
  getPlaylist: (opts?: { ended?: boolean }) => HlsPlaylist

  /**
   * Get a complete VOD playlist by reading all remaining segments.
   * This processes the entire file lazily but sequentially.
   */
  generateVodPlaylist: () => Promise<HlsPlaylist>

  /**
   * Get all segments read so far.
   */
  getSegments: () => HlsSegment[]

  /**
   * Clean up all blob URLs and destroy the underlying remuxer.
   */
  destroy: () => Promise<void>
}

/**
 * Creates an HLS remuxer that wraps the existing fMP4 remuxer.
 *
 * The underlying remuxer already produces fragmented MP4 with
 * `empty_moov+frag_keyframe+default_base_moof` — which is exactly
 * what HLS with fMP4 segments (RFC 8216bis) requires.
 *
 * This wrapper:
 * - Exposes each read() chunk as a numbered HLS segment with a blob URL
 * - Generates m3u8 playlists (EVENT or VOD) referencing those segments
 * - Preserves the lazy/streaming architecture — segments are produced on demand
 *
 * Usage with video.js:
 * ```js
 * const hls = await makeHlsRemuxer({ ...options })
 * const { initSegmentUrl, info } = await hls.init()
 *
 * // Option A: Read all segments upfront (small files)
 * const { url } = await hls.generateVodPlaylist()
 * videojs(el, { sources: [{ src: url, type: 'application/x-mpegURL' }] })
 *
 * // Option B: Stream segments lazily (large files)
 * while (true) {
 *   const segment = await hls.readNextSegment()
 *   if (!segment) break
 *   const { url } = hls.getPlaylist({ ended: false })
 *   // Update player source or use hls.js programmatic API
 * }
 * ```
 */
export const makeHlsRemuxer = async (options: HlsRemuxerOptions): Promise<HlsRemuxer> => {
  const { targetSegmentDuration = 6, ...remuxerOptions } = options
  const remuxer = await makeRemuxer(remuxerOptions)

  const segments: HlsSegment[] = []
  const blobUrls: string[] = []
  let initSegmentUrl: string | null = null
  let initSegmentData: ArrayBuffer | null = null
  let playlistBlobUrl: string | null = null
  let finished = false
  let segmentIndex = 0
  let totalDuration = 0
  let maxSegmentDuration = 0

  const createSegmentFromResult = (result: {
    data: ArrayBuffer
    pts: number
    duration: number
    finished: boolean
  }): HlsSegment | null => {
    if (result.finished) {
      finished = true
    }

    if (!result.data || result.data.byteLength === 0) {
      return null
    }

    const blob = new Blob([result.data], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)
    blobUrls.push(url)

    // Duration and pts come from the remuxer in seconds
    const durationSecs = result.duration
    const ptsSecs = result.pts

    const segment: HlsSegment = {
      index: segmentIndex++,
      duration: durationSecs,
      pts: ptsSecs,
      url,
      data: result.data
    }

    segments.push(segment)
    totalDuration += durationSecs
    if (durationSecs > maxSegmentDuration) {
      maxSegmentDuration = durationSecs
    }

    return segment
  }

  const buildPlaylist = (ended: boolean): string => {
    // Target duration must be an integer >= max segment duration
    const targetDuration = Math.max(
      Math.ceil(maxSegmentDuration),
      targetSegmentDuration
    )

    let m3u8 = '#EXTM3U\n'
    m3u8 += `#EXT-X-VERSION:7\n` // Version 7 required for fMP4
    m3u8 += `#EXT-X-TARGETDURATION:${targetDuration}\n`
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:0\n`

    if (!ended) {
      m3u8 += `#EXT-X-PLAYLIST-TYPE:EVENT\n`
    } else {
      m3u8 += `#EXT-X-PLAYLIST-TYPE:VOD\n`
    }

    // fMP4 init segment
    if (initSegmentUrl) {
      m3u8 += `#EXT-X-MAP:URI="${initSegmentUrl}"\n`
    }

    for (const segment of segments) {
      m3u8 += `#EXTINF:${segment.duration.toFixed(6)},\n`
      m3u8 += `${segment.url}\n`
    }

    if (ended) {
      m3u8 += '#EXT-X-ENDLIST\n'
    }

    return m3u8
  }

  return {
    init: async () => {
      const result = await remuxer.init()

      // The init() data is the fMP4 init segment (moov box)
      const blob = new Blob([result.data], { type: 'video/mp4' })
      initSegmentUrl = URL.createObjectURL(blob)
      initSegmentData = result.data
      blobUrls.push(initSegmentUrl)

      return {
        info: result.info,
        initSegmentUrl,
        initSegmentData,
        attachments: result.attachments,
        subtitles: result.subtitles,
        chapters: result.chapters,
        indexes: result.indexes
      }
    },

    readNextSegment: async () => {
      if (finished) return null

      try {
        const result = await remuxer.read()
        return createSegmentFromResult(result)
      } catch (err: any) {
        if (err?.message === 'Cancelled') return null
        throw err
      }
    },

    seekToSegment: async (timestamp: number) => {
      try {
        const result = await remuxer.seek(timestamp)
        finished = false // Reset finished state after seek
        return createSegmentFromResult(result)
      } catch (err: any) {
        if (err?.message === 'Cancelled') return null
        throw err
      }
    },

    getPlaylist: (opts?: { ended?: boolean }) => {
      const ended = opts?.ended ?? finished

      // Revoke previous playlist blob URL
      if (playlistBlobUrl) {
        URL.revokeObjectURL(playlistBlobUrl)
      }

      const content = buildPlaylist(ended)
      const blob = new Blob([content], { type: 'application/x-mpegURL' })
      playlistBlobUrl = URL.createObjectURL(blob)

      return { content, url: playlistBlobUrl }
    },

    generateVodPlaylist: async () => {
      while (!finished) {
        const segment = await remuxer.read()
        createSegmentFromResult(segment)
      }

      if (playlistBlobUrl) {
        URL.revokeObjectURL(playlistBlobUrl)
      }

      const content = buildPlaylist(true)
      const blob = new Blob([content], { type: 'application/x-mpegURL' })
      playlistBlobUrl = URL.createObjectURL(blob)

      return { content, url: playlistBlobUrl }
    },

    getSegments: () => [...segments],

    destroy: async () => {
      // Revoke all blob URLs
      for (const url of blobUrls) {
        URL.revokeObjectURL(url)
      }
      if (playlistBlobUrl) {
        URL.revokeObjectURL(playlistBlobUrl)
      }
      blobUrls.length = 0
      segments.length = 0
      playlistBlobUrl = null
      initSegmentUrl = null
      initSegmentData = null
      finished = true

      await remuxer.destroy()
    }
  }
}
