import { test, expect, afterEach } from 'vitest'
import PQueue from 'p-queue'
import { makeRemuxer } from '../src'

// Cross-method visual regression: the three rendering paths (H264 passthrough, HEVC->WebCodecs
// re-encode, HEVC decode-render-to-canvas) play the same deterministic content (testsrc2, 1080p),
// so a frame at a given timestamp must look the same across methods. Firefox only (chromium plays
// HEVC natively, so the fallbacks never engage).

const isFirefox = navigator.userAgent.includes('Firefox')
const playsHevcNatively =
  !isFirefox
  && typeof MediaSource !== 'undefined'
  && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')

const CW = 640
const CH = 360
// The burned-in timecode box (top-left) — the only region that changes much frame-to-frame.
const TC = { x: 0, y: 0, w: 210, h: 52 }

const remuxerOpts = (contentLength: number, url: string, threads: number, renderCanvas?: OffscreenCanvas) => ({
  workerUrl: new URL('/build/worker.js', location.origin).toString(),
  workerOptions: { type: 'module' as const },
  moduleUrl: new URL('/dist/libav.js', location.origin).toString(),
  wasmUrl: new URL('/dist/libav.wasm', location.origin).toString(),
  threadedModuleUrl: new URL('/dist/libav-mt.js', location.origin).toString(),
  threadedWasmUrl: new URL('/dist/libav-mt.wasm', location.origin).toString(),
  threadCount: threads,
  bufferSize: 2_500_000,
  length: contentLength,
  renderCanvas,
  read: (offset: number, size: number) => {
    if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
    return fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } }).then((r) => r.arrayBuffer())
  },
})

const contentLengthOf = async (url: string) => {
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  return Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))
}

// Scratch canvas: every frame is downscaled here so comparisons happen at one size (averages noise).
const scratch = new OffscreenCanvas(CW, CH)
const sctx = scratch.getContext('2d', { willReadFrequently: true })!
const toImageData = (src: CanvasImageSource): ImageData => {
  sctx.clearRect(0, 0, CW, CH)
  sctx.drawImage(src, 0, 0, CW, CH)
  return sctx.getImageData(0, 0, CW, CH)
}

// Mean absolute per-channel difference (0-255), RGB only (ignore alpha), over an optional region.
const meanAbsDiff = (a: ImageData, b: ImageData, region?: { x: number; y: number; w: number; h: number }): number => {
  const r = region ?? { x: 0, y: 0, w: a.width, h: a.height }
  let sum = 0
  let n = 0
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * a.width + x) * 4
      sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
      n += 3
    }
  }
  return sum / n
}

// Spread of luma — near 0 means a blank (single-colour) frame, which we should never accept.
const variance = (a: ImageData): number => {
  let mean = 0
  const n = a.data.length / 4
  for (let i = 0; i < a.data.length; i += 4) mean += (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3
  mean /= n
  let v = 0
  for (let i = 0; i < a.data.length; i += 4) { const l = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3; v += (l - mean) ** 2 }
  return v / n
}

// ---- MSE <video> method (passthrough or WebCodecs re-encode) --------------------------------
const mountMse = async (sample: string, threads: number) => {
  const url = new URL('/test-files/' + sample, location.origin).toString()
  const contentLength = await contentLengthOf(url)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  document.body.appendChild(video)

  const remuxer = await makeRemuxer(remuxerOpts(contentLength, url, threads))
  const header = await remuxer.init()
  const mediaSource = new MediaSource()
  video.src = URL.createObjectURL(mediaSource)
  const sb: SourceBuffer = await new Promise((resolve) => {
    mediaSource.addEventListener('sourceopen', () => {
      const s = mediaSource.addSourceBuffer(`video/mp4; codecs="${[header.info.output.videoMimeType, header.info.output.audioMimeType].filter(Boolean).join(',')}"`)
      mediaSource.duration = header.info.input.duration
      s.mode = 'segments'
      resolve(s)
    }, { once: true })
  })
  const queue = new PQueue({ concurrency: 1 })
  const append = (buf: ArrayBuffer) => queue.add(() => new Promise<void>((resolve, reject) => {
    if (!buf.byteLength) return resolve()
    const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', err); resolve() }
    const err = (e: Event) => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', err); reject(e) }
    sb.addEventListener('updateend', done, { once: true })
    sb.addEventListener('error', err, { once: true })
    sb.appendBuffer(buf)
  }))

  await append(header.data)
  const first = await remuxer.read()
  await append(first.data)

  const videoMime = header.info.output.videoMimeType

  const coversT = (t: number) =>
    Array.from({ length: sb.buffered.length }, (_, j) => [sb.buffered.start(j), sb.buffered.end(j)] as [number, number])
      .some(([s, e]) => s <= t + 0.05 && t < e)

  // Seek to `t`, buffer until the fragment covering `t` is appended, then wait for the video to
  // actually decode the frame (readyState >= HAVE_CURRENT_DATA) before sampling it.
  const captureAt = async (t: number): Promise<ImageData> => {
    const res = await remuxer.seek(t)
    sb.timestampOffset = res.pts
    await append(res.data)
    for (let i = 0; i < 40 && !coversT(t); i++) { const r = await remuxer.read(); await append(r.data); if (r.finished) break }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => { if (settled) return; settled = true; clearInterval(poll); video.removeEventListener('seeked', onSeeked); resolve() }
      const ready = () => video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.3
      const onSeeked = () => { if (ready()) finish() }
      video.addEventListener('seeked', onSeeked)
      const poll = setInterval(() => { if (ready()) finish() }, 100)
      video.currentTime = t
      setTimeout(finish, 10_000)
    })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    return toImageData(video)
  }

  return {
    videoMime,
    captureAt,
    destroy: async () => { try { video.pause() } catch {} ; try { await remuxer.destroy() } catch {} ; video.remove() },
  }
}

// ---- decode-render-to-canvas method ----------------------------------------------------------
const mountCanvas = async (sample: string, threads: number) => {
  const url = new URL('/test-files/' + sample, location.origin).toString()
  const contentLength = await contentLengthOf(url)
  const canvas = document.createElement('canvas')
  canvas.width = 1920 // match the 1080p source so the timecode region aligns with the <video> methods
  canvas.height = 1080
  document.body.appendChild(canvas)
  const offscreen = canvas.transferControlToOffscreen()
  const remuxer = await makeRemuxer(remuxerOpts(contentLength, url, threads, offscreen))
  const init = await remuxer.init() as any
  if (init.renderMode !== 'canvas') throw new Error(`expected canvas mode, got ${init.renderMode}`)

  const captureAt = async (t: number): Promise<ImageData> => {
    await (remuxer as any).renderFrame(t)
    // Read the exact rendered pixels back from the worker (no screenshot / page chrome).
    const bytes = await remuxer.captureRenderedFrame(CW, CH)
    return new ImageData(new Uint8ClampedArray(bytes), CW, CH)
  }
  return { captureAt, destroy: async () => { try { await remuxer.destroy() } catch {} ; canvas.remove() } }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

test.skipIf(playsHevcNatively)('rendering methods agree frame-for-frame', async () => {
  const TIMESTAMPS = [1, 3, 6]

  const h264 = await mountMse('sample-h264.mkv', 1); cleanups.push(h264.destroy)
  const hevcMse = await mountMse('sample-hevc.mkv', 0); cleanups.push(hevcMse.destroy)
  const hevcCanvas = await mountCanvas('sample-hevc.mkv', 0); cleanups.push(hevcCanvas.destroy)
  expect(h264.videoMime).toMatch(/^avc1\./)
  expect(hevcMse.videoMime).toMatch(/^avc1\./) // HEVC re-encoded to H264

  const frames: Record<string, ImageData[]> = { h264: [], hevcMse: [], hevcCanvas: [] }
  for (const t of TIMESTAMPS) {
    frames.h264.push(await h264.captureAt(t))
    frames.hevcMse.push(await hevcMse.captureAt(t))
    frames.hevcCanvas.push(await hevcCanvas.captureAt(t))
  }

  // Every captured frame must have real content (never blank).
  for (const [name, list] of Object.entries(frames)) {
    list.forEach((f, i) => expect(variance(f), `${name}@${TIMESTAMPS[i]}s blank`).toBeGreaterThan(50))
  }

  // Same timestamp across methods must match on the whole frame. HEVC methods read the identical
  // file (tight bound); H264 is a separate encode (looser bound).
  for (let i = 0; i < TIMESTAMPS.length; i++) {
    const t = TIMESTAMPS[i]
    const hevcWhole = meanAbsDiff(frames.hevcMse[i], frames.hevcCanvas[i])
    const crossWhole = meanAbsDiff(frames.h264[i], frames.hevcCanvas[i])
    console.log(`[visual] t=${t}s whole hevc=${hevcWhole.toFixed(1)} cross=${crossWhole.toFixed(1)}`)
    expect(hevcWhole, `HEVC re-encode vs decode-render whole @${t}s`).toBeLessThan(18)
    expect(crossWhole, `H264 passthrough vs HEVC decode-render whole @${t}s`).toBeLessThan(28)
  }

  // Informational only: timecode-box delta between timestamps (not gated — testsrc2 is near-static).
  for (let i = 1; i < TIMESTAMPS.length; i++) {
    console.log(`[visual] decode-render timecode change ${TIMESTAMPS[i - 1]}s→${TIMESTAMPS[i]}s = ${meanAbsDiff(frames.hevcCanvas[i - 1], frames.hevcCanvas[i], TC).toFixed(1)}`)
  }
}, 120_000)
