import type { MakeTransmuxerOptions } from './index'

import { makeRemuxer } from './index'

// Builds a Video.js v10 (@videojs/react) "media" object for the HEVC decode-render fallback: a
// hidden <audio> playing the audio-only fMP4 is the seekable timeline + A/V master clock, and the
// worker draws decoded video frames onto a <canvas> slaved to audio.currentTime — no re-encode, no
// <video> element. Hand `audio` to setMedia() and place `canvas` behind the skin.

export type DecodeRenderMediaOptions = Omit<MakeTransmuxerOptions, 'renderCanvas'> & {
  /** A <canvas> in the app's DOM; its control is transferred to the worker. */
  canvas: HTMLCanvasElement
}

export type DecodeRenderMedia = {
  /** The <audio> backing the timeline/clock — hand this to Video.js v10 as the media element. */
  audio: HTMLAudioElement
  videoWidth: number
  videoHeight: number
  stats: () => { decoded: number; skipped: number; presentedPts: number }
  destroy: () => Promise<void>
}

export const createDecodeRenderMedia = async (opts: DecodeRenderMediaOptions): Promise<DecodeRenderMedia> => {
  const { canvas, ...remuxerOpts } = opts
  const offscreen = canvas.transferControlToOffscreen()
  const remuxer = await makeRemuxer({ ...remuxerOpts, renderCanvas: offscreen })

  const init = await remuxer.init() as any
  if (init.renderMode !== 'canvas') {
    throw new Error(`createDecodeRenderMedia: expected decode-render (canvas) mode, got ${init.renderMode}`)
  }
  const videoWidth: number = init.videoWidth
  const videoHeight: number = init.videoHeight
  const audioMimeType: string = init.audioMimeType ?? ''
  const hasAudio: boolean = !!init.hasAudio

  const audio = document.createElement('audio')
  audio.preload = 'auto'

  let totalDecoded = 0
  let totalSkipped = 0
  let presentedPts = 0

  // Audio: an MSE audio-only fMP4 is the seekable timeline + master clock.
  if (hasAudio) {
    const mediaSource = new MediaSource()
    audio.src = URL.createObjectURL(mediaSource)
    await new Promise<void>((resolve) => mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }))
    const sb = mediaSource.addSourceBuffer(`audio/mp4; codecs="${audioMimeType}"`)
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
  }

  let rafId = 0
  let drawing = false
  const drawForCurrentTime = async () => {
    if (drawing) return
    drawing = true
    try {
      const r = await remuxer.renderFrame(audio.currentTime) as any
      totalDecoded = r.totalDecoded
      totalSkipped = r.totalSkipped
      presentedPts = r.presentedPts
    } catch { /* cancelled (e.g. a seek superseded this); ignore */ } finally {
      drawing = false
    }
  }
  const loop = () => {
    void drawForCurrentTime()
    if (!audio.paused && !audio.ended) rafId = requestAnimationFrame(loop)
    else rafId = 0
  }
  const startLoop = () => { if (!rafId) rafId = requestAnimationFrame(loop) }

  audio.addEventListener('play', startLoop)
  audio.addEventListener('playing', startLoop)
  // A superseded seek/render rejects with "Cancelled" (addTask aborts the previous op) — swallow it.
  audio.addEventListener('seeking', () => { void remuxer.seek(audio.currentTime).then(() => drawForCurrentTime()).catch(() => {}) })
  audio.addEventListener('seeked', () => { void drawForCurrentTime() })

  await drawForCurrentTime() // first frame, so the canvas isn't blank before play

  return {
    audio,
    videoWidth,
    videoHeight,
    stats: () => ({ decoded: totalDecoded, skipped: totalSkipped, presentedPts }),
    destroy: async () => {
      if (rafId) cancelAnimationFrame(rafId)
      try { audio.pause() } catch {}
      if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src)
      await remuxer.destroy()
    },
  }
}
