import { describe, test, expect, afterEach } from 'vitest'
import PQueue from 'p-queue'
import { makeRemuxer } from '../src'

const mount = async (videoPath: string, threads = 1) => {
  const url = new URL('/test-files/' + videoPath.replace(/^\/+/, ''), location.origin).toString()
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  if (!head.ok && head.status !== 206) throw new Error(`fetch ${url} failed: ${head.status}`)
  const contentLength = Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  document.body.appendChild(video)

  const remuxer = await makeRemuxer({
    workerUrl: new URL('/build/worker.js', location.origin).toString(),
    workerOptions: { type: 'module' },
    moduleUrl: new URL('/dist/libav.js', location.origin).toString(),
    wasmUrl: new URL('/dist/libav.wasm', location.origin).toString(),
    threadedModuleUrl: new URL('/dist/libav-mt.js', location.origin).toString(),
    threadedWasmUrl: new URL('/dist/libav-mt.wasm', location.origin).toString(),
    threadCount: threads,
    bufferSize: 2_500_000,
    length: contentLength,
    read: (offset, size) => {
      if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
      return fetch(url, {
        headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` },
      }).then((r) => r.arrayBuffer())
    },
  })

  const header = await remuxer.init()
  const mediaSource = new MediaSource()
  video.src = URL.createObjectURL(mediaSource)
  const sourceBuffer: SourceBuffer = await new Promise((resolve) => {
    mediaSource.addEventListener('sourceopen', () => {
      const sb = mediaSource.addSourceBuffer(
        `video/mp4; codecs="${[header.info.output.videoMimeType, header.info.output.audioMimeType].filter(Boolean).join(',')}"`,
      )
      mediaSource.duration = header.info.input.duration
      sb.mode = 'segments'
      resolve(sb)
    }, { once: true })
  })

  const queue = new PQueue({ concurrency: 1 })
  const wireSb = (action: () => void) =>
    queue.add(() => new Promise<void>((resolve, reject) => {
      const done = () => { sourceBuffer.removeEventListener('updateend', done); sourceBuffer.removeEventListener('error', err); resolve() }
      const err = (e: Event) => { sourceBuffer.removeEventListener('updateend', done); sourceBuffer.removeEventListener('error', err); reject(e) }
      sourceBuffer.addEventListener('updateend', done, { once: true })
      sourceBuffer.addEventListener('error', err, { once: true })
      action()
    }))
  const appendBuffer = (buf: ArrayBuffer) => wireSb(() => sourceBuffer.appendBuffer(buf))

  await appendBuffer(header.data)
  const first = await remuxer.read()
  if (first.data.byteLength > 0) await appendBuffer(first.data)

  let finished = false
  const BUFFER_TO = 60
  const topUp = async () => {
    if (finished) return
    const ranges = Array.from({ length: sourceBuffer.buffered.length }, (_, i) => [sourceBuffer.buffered.start(i), sourceBuffer.buffered.end(i)] as [number, number])
    const inRange = ranges.find(([s, e]) => s <= video.currentTime && video.currentTime <= e)
    if (!inRange) return
    if (inRange[1] >= video.currentTime + BUFFER_TO) return
    try {
      const res = await remuxer.read()
      if (res.data.byteLength > 0) await appendBuffer(res.data)
      if (res.finished) finished = true
    } catch (e) {
      if ((e as Error).message !== 'Cancelled') throw e
    }
  }
  const interval = setInterval(topUp, 100)

  video.addEventListener('seeking', async () => {
    try {
      const res = await remuxer.seek(video.currentTime)
      sourceBuffer.timestampOffset = res.pts
      if (res.data.byteLength > 0) await appendBuffer(res.data)
      finished = false
    } catch (e) {
      if ((e as Error).message !== 'Cancelled') console.error('seek error:', e)
    }
  })

  return {
    video,
    info: header.info,
    remuxer,
    destroy: async () => {
      clearInterval(interval)
      video.pause()
      try { video.src = '' } catch {}
      try { await remuxer.destroy() } catch {}
      video.remove()
    },
  }
}

const waitFor = (predicate: () => boolean, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'))
      requestAnimationFrame(tick)
    }
    tick()
  })

let ctx: Awaited<ReturnType<typeof mount>> | undefined
afterEach(async () => { await ctx?.destroy(); ctx = undefined })

describe('H264 passthrough', () => {
  test('plays', async () => {
    ctx = await mount('sample-h264.mkv')
    expect(ctx.info.input.videoMimeType).toMatch(/^avc1\./)
    await ctx.video.play()
    await waitFor(() => ctx!.video.currentTime > 0.5, 10_000)
    expect(ctx.video.error).toBeNull()
    expect(ctx.video.videoWidth).toBeGreaterThan(0)
  })

  test('seeks forward then backward', async () => {
    ctx = await mount('sample-h264.mkv')
    await ctx.video.play()
    await waitFor(() => ctx!.video.buffered.length > 0, 5_000)
    ctx.video.currentTime = 15
    await waitFor(() => ctx!.video.currentTime >= 14, 15_000)
    expect(ctx.video.currentTime).toBeGreaterThanOrEqual(14)
    ctx.video.currentTime = 5
    await waitFor(() => ctx!.video.currentTime <= 6, 15_000)
    expect(ctx.video.error).toBeNull()
    expect(ctx.video.currentTime).toBeLessThanOrEqual(6)
  })

  test('survives the EOF trailer (no timescale-0 regression)', async () => {
    ctx = await mount('sample-h264.mkv')
    const dur = ctx.video.duration
    ctx.video.currentTime = Math.max(dur - 1.5, 0)
    await ctx.video.play()
    await waitFor(() => ctx!.video.ended || ctx!.video.currentTime > ctx!.video.duration - 0.2, 15_000)
    expect(ctx.video.error).toBeNull()
  })
})

// Skip the fallback suite on browsers that actually play HEVC natively — there's no fallback
// to exercise there. Firefox is the exception: its window-context isTypeSupported is a
// false-positive prone capability claim (reports true for hev1 on Linux but the SourceBuffer
// errors when fed real bytes), AND Firefox doesn't expose MediaSource in workers anyway, so
// the worker's codec gate falls through to VideoDecoder.isConfigSupported which honestly
// reports HEVC unsupported and triggers the fallback. So on Firefox the fallback always runs.
const isFirefox = navigator.userAgent.includes('Firefox')
const playsHevcNatively =
  !isFirefox
  && typeof MediaSource !== 'undefined'
  && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')

describe.skipIf(playsHevcNatively)('HEVC fallback', () => {
  test('single-threaded decode plays', async () => {
    ctx = await mount('sample-hevc.mkv', 1)
    expect(ctx.info.input.videoMimeType).toMatch(/^hev1\./)
    expect(ctx.info.output.videoMimeType).toMatch(/^avc1\./)
    await ctx.video.play()
    await waitFor(() => ctx!.video.currentTime > 0.5, 80_000)
    expect(ctx.video.error).toBeNull()
  })

  test.skipIf(!(globalThis as any).crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')(
    'multi-threaded decode plays',
    async () => {
      ctx = await mount('sample-hevc.mkv', 0)
      await ctx.video.play()
      await waitFor(() => ctx!.video.currentTime > 0.5, 80_000)
      expect(ctx.video.error).toBeNull()
    },
  )

  test('seeks', async () => {
    ctx = await mount('sample-hevc.mkv', 1)
    await ctx.video.play()
    await waitFor(() => ctx!.video.buffered.length > 0, 80_000)
    ctx.video.currentTime = 15
    await waitFor(() => ctx!.video.currentTime >= 14, 60_000)
    expect(ctx.video.error).toBeNull()
    expect(ctx.video.currentTime).toBeGreaterThanOrEqual(14)
  })
})
