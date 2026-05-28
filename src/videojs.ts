import type { MakeTransmuxerOptions } from './index'

import { makeRemuxer } from './index'

// Builds a Video.js v10 (@videojs/react) "media" object for the HEVC decode-render fallback. The
// worker draws decoded frames onto a <canvas>; this returns the media object Video.js attaches to via
// setMedia(). For a file with audio it's a hidden <audio> playing the audio-only fMP4 (real seekable
// timeline + sound + A/V clock); for a video-only file it's a synthetic wall-clock so Video.js still
// gets a seekable timeline. Either way the canvas is slaved to media.currentTime — no re-encode, no
// <video> element.

// Synthetic media surface for video-only decode-render: a wall-clock timeline Video.js can drive. It
// implements the slice of the HTMLMediaElement contract Video.js v10's feature detectors read (a real
// <audio> covers the same surface natively for files that have audio).
class CanvasClock extends EventTarget {
  readonly duration: number
  readonly videoWidth: number
  readonly videoHeight: number
  volume = 1
  muted = false
  playbackRate = 1
  // Video.js's isMediaSourceCapable() gates seeking on `"src" in media` (+ currentSrc/readyState/
  // load) — without `src` the seek action bails before writing currentTime. These are just markers.
  readonly src = ''
  readonly currentSrc = ''
  readonly error = null
  readonly textTracks = { length: 0, [Symbol.iterator]: function* () { /* no text tracks */ } }
  readonly readyState = 4 // HAVE_ENOUGH_DATA
  readonly seeking = false
  private t = 0
  private playing = false
  private raf = 0
  private last = 0

  constructor(duration: number, videoWidth: number, videoHeight: number) {
    super()
    this.duration = Math.max(0, duration || 0)
    this.videoWidth = videoWidth
    this.videoHeight = videoHeight
  }

  get currentTime() { return this.t }
  set currentTime(v: number) {
    this.t = Math.max(0, Math.min(this.duration, v || 0))
    this.dispatchEvent(new Event('seeking'))
    this.dispatchEvent(new Event('timeupdate'))
    this.dispatchEvent(new Event('seeked'))
  }
  get paused() { return !this.playing }
  get ended() { return this.t >= this.duration }
  // Pretend fully buffered/seekable — the worker can decode any time on demand.
  get buffered() { return { length: 1, start: () => 0, end: () => this.duration } as unknown as TimeRanges }
  get seekable() { return this.buffered }
  load() { /* nothing to load — frames are decoded on demand */ }
  play() {
    if (this.playing) return Promise.resolve()
    this.playing = true
    this.last = performance.now()
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    const tick = (now: number) => {
      this.t = Math.min(this.duration, this.t + (now - this.last) / 1000)
      this.last = now
      this.dispatchEvent(new Event('timeupdate'))
      if (this.t >= this.duration) { this.playing = false; this.dispatchEvent(new Event('ended')); return }
      if (this.playing) this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    return Promise.resolve()
  }
  pause() {
    if (!this.playing) return
    this.playing = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.dispatchEvent(new Event('pause'))
  }
}

export type DecodeRenderMediaOptions = Omit<MakeTransmuxerOptions, 'renderCanvas'> & {
  /** A <canvas> in the app's DOM; its control is transferred to the worker. */
  canvas: HTMLCanvasElement
}

export type DecodeRenderMedia = {
  /** Hand this to Video.js v10 as the media element. A real <audio> when the file has an audio track,
   *  otherwise a synthetic wall-clock so video-only files still get a Video.js timeline. */
  media: HTMLMediaElement
  videoWidth: number
  videoHeight: number
  stats: () => { decoded: number; skipped: number; presentedPts: number }
  destroy: () => Promise<void>
}

export const createDecodeRenderMedia = async (opts: DecodeRenderMediaOptions): Promise<DecodeRenderMedia> => {
  const { canvas, ...remuxerOpts } = opts
  const offscreen = canvas.transferControlToOffscreen()
  // forceTranscode: calling this opts into the canvas decode-render path, so engage it even when the
  // browser could play the codec natively (otherwise init() would passthrough and report no canvas).
  const remuxer = await makeRemuxer({ ...remuxerOpts, renderCanvas: offscreen, forceTranscode: true })

  const init = await remuxer.init() as any
  if (init.renderMode !== 'canvas') {
    throw new Error(`createDecodeRenderMedia: expected decode-render (canvas) mode, got ${init.renderMode}`)
  }
  const videoWidth: number = init.videoWidth
  const videoHeight: number = init.videoHeight
  const duration: number = init.info?.input?.duration ?? 0
  const hasAudio: boolean = !!init.hasAudio

  let media: HTMLMediaElement
  let cleanupMedia: () => void

  if (hasAudio) {
    // Audio track present: a hidden <audio> playing the audio-only fMP4 is the timeline + sound + clock.
    const audio = document.createElement('audio')
    audio.preload = 'auto'
    const mediaSource = new MediaSource()
    audio.src = URL.createObjectURL(mediaSource)
    await new Promise<void>((resolve) => mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }))
    const sb = mediaSource.addSourceBuffer(`audio/mp4; codecs="${init.audioMimeType ?? ''}"`)
    const append = (buf: ArrayBuffer) =>
      new Promise<void>((resolve, reject) => {
        sb.addEventListener('updateend', () => resolve(), { once: true })
        sb.addEventListener('error', () => reject(new Error('SourceBuffer error')), { once: true })
        sb.appendBuffer(buf)
      })
    await append(init.audioInitSegment)
    // extractAudio() demuxes the whole audio track without decoding video, then rewinds the demuxer.
    const allAudio = await remuxer.extractAudio()
    if (allAudio.byteLength) await append(allAudio)
    // endOfStream finalizes duration; setting mediaSource.duration directly throws InvalidStateError.
    if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    await remuxer.seek(0)
    media = audio
    cleanupMedia = () => { try { audio.pause() } catch {} ; if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src) }
  } else {
    // No audio track: a synthetic wall-clock so Video.js still has a seekable timeline.
    const clock = new CanvasClock(duration, videoWidth, videoHeight)
    media = clock as unknown as HTMLMediaElement
    cleanupMedia = () => { try { clock.pause() } catch {} }
  }

  let totalDecoded = 0
  let totalSkipped = 0
  let presentedPts = 0

  let rafId = 0
  let drawing = false
  const drawForCurrentTime = async () => {
    if (drawing) return
    drawing = true
    try {
      const r = await remuxer.renderFrame(media.currentTime) as any
      totalDecoded = r.totalDecoded
      totalSkipped = r.totalSkipped
      presentedPts = r.presentedPts
    } catch { /* cancelled (e.g. a seek superseded this); ignore */ } finally {
      drawing = false
    }
  }
  const loop = () => {
    void drawForCurrentTime()
    if (!media.paused && !media.ended) rafId = requestAnimationFrame(loop)
    else rafId = 0
  }
  const startLoop = () => { if (!rafId) rafId = requestAnimationFrame(loop) }

  media.addEventListener('play', startLoop)
  media.addEventListener('playing', startLoop)
  // Reposition the decoder then draw the new frame. Only 'seeking' drives this — a separate 'seeked'
  // handler would fire a second renderFrame that aborts this seek via addTask (the decoder then never
  // repositions, so only the first forward seek appears to work). A superseded seek rejects with
  // "Cancelled"; swallow it.
  media.addEventListener('seeking', () => { void remuxer.seek(media.currentTime).then(() => drawForCurrentTime()).catch(() => {}) })

  await drawForCurrentTime() // first frame, so the canvas isn't blank before play

  return {
    media,
    videoWidth,
    videoHeight,
    stats: () => ({ decoded: totalDecoded, skipped: totalSkipped, presentedPts }),
    destroy: async () => {
      if (rafId) cancelAnimationFrame(rafId)
      cleanupMedia()
      await remuxer.destroy()
    },
  }
}
