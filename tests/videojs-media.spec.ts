import { test, expect } from 'vitest'
import { createDecodeRenderMedia } from '../src/videojs'

// Video.js v10 media factory for the decode-render fallback: the worker draws HEVC frames onto a
// canvas, and createDecodeRenderMedia returns the media object Video.js attaches to — a real <audio>
// (timeline + clock) for files with audio, a synthetic wall-clock for video-only files. Firefox only
// (chromium plays HEVC natively).
const playsHevcNatively =
  typeof MediaSource !== 'undefined'
  && !navigator.userAgent.includes('Firefox')
  && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')

const make = async (sample: string) => {
  const url = new URL('/test-files/' + sample, location.origin).toString()
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  const contentLength = Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const media = await createDecodeRenderMedia({
    canvas,
    workerUrl: new URL('/build/worker.js', location.origin).toString(),
    workerOptions: { type: 'module' },
    moduleUrl: new URL('/dist/libav.js', location.origin).toString(),
    wasmUrl: new URL('/dist/libav.wasm', location.origin).toString(),
    threadedModuleUrl: new URL('/dist/libav-mt.js', location.origin).toString(),
    threadedWasmUrl: new URL('/dist/libav-mt.wasm', location.origin).toString(),
    threadCount: 0,
    bufferSize: 2_500_000,
    length: contentLength,
    read: (offset, size) =>
      offset >= contentLength
        ? Promise.resolve(new Uint8Array(0).buffer)
        : fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } }).then((r) => r.arrayBuffer()),
  })
  return { ...media, canvas }
}

// play() muted (so headless autoplay isn't blocked) and assert the render loop keeps advancing.
const expectPlayAdvances = async (m: { media: HTMLMediaElement; stats: () => { decoded: number } }) => {
  m.media.currentTime = 0
  await new Promise((r) => setTimeout(r, 300))
  const before = m.stats().decoded
  m.media.muted = true
  await m.media.play().catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  expect(m.media.paused).toBe(false) // play() started
  expect(m.stats().decoded).toBeGreaterThan(before) // render loop advanced during playback
}

test.skipIf(playsHevcNatively)('decode-render: audio file → <audio> timeline + canvas + seek + play', async () => {
  const m = await make('sample-hevc-audio.mkv')
  expect(m.videoWidth).toBe(1280)
  expect(m.videoHeight).toBe(720)
  expect(m.media.duration).toBeGreaterThan(4) // ~5s clip; proves audio extraction + MSE timeline
  expect(m.media.duration).toBeLessThan(10) // NOT inflated by the audio-timebase bug (would be ~114s)

  // Seek to 2s: fires 'seeking', repositions the decoder, presents that frame.
  m.media.currentTime = 2.0
  await new Promise((r) => setTimeout(r, 800))
  expect(m.stats().decoded).toBeGreaterThan(0)
  expect(m.stats().presentedPts).toBeGreaterThan(1.0)

  await expectPlayAdvances(m)
  await m.destroy()
  m.canvas.remove()
}, 60_000)

test.skipIf(playsHevcNatively)('decode-render: video-only file → synthetic clock + canvas + play', async () => {
  const m = await make('sample-hevc-720p.mkv')
  expect(m.videoWidth).toBeGreaterThan(0)
  // The synthetic wall-clock gives Video.js a real, finite, seekable timeline despite no audio track.
  expect(Number.isFinite(m.media.duration)).toBe(true)
  expect(m.media.duration).toBeGreaterThan(0)
  // Video.js gates seeking on isMediaSourceCapable: needs src + currentSrc + readyState + load().
  // Missing `src` silently blocks the seek controls — guard the whole source-capable surface.
  expect('src' in m.media && 'currentSrc' in m.media && 'readyState' in m.media && typeof m.media.load === 'function').toBe(true)

  // Each seek must reposition to (near) the target — not land short by brute-force decoding forward.
  // Forward, then backward, then mid on a 30s clip exercises the seek_transcode timebase rescale and
  // the single-seeking-listener fix (a prior seeked handler aborted the seek, so only the 1st worked).
  // Poll for the landing: repositioning is immediate, but decoding the GOP to the exact frame varies.
  for (const t of [m.media.duration * 0.8, m.media.duration * 0.2, m.media.duration * 0.5]) {
    m.media.currentTime = t
    let pts = 0
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 200)); pts = m.stats().presentedPts; if (Math.abs(pts - t) < 1.5) break }
    expect(Math.abs(pts - t), `seek to ${t.toFixed(1)}s presented ${pts.toFixed(1)}s`).toBeLessThan(1.5)
  }

  await expectPlayAdvances(m)
  await m.destroy()
  m.canvas.remove()
}, 60_000)
