// Test harness page driven by URL query params:
//   ?video=sample-h264.mkv     (path to a media file under project root)
//   ?threads=N                  (decoder thread count; 0 = auto, 1 = single, N = explicit)
//
// Exposes window.__lav as a synchronous API for Playwright tests to drive playback and read
// state without racing the dynamic init.
import PQueue from 'p-queue'
import { makeRemuxer } from '../src'

type Status =
  | { stage: 'init' }
  | { stage: 'ready'; info: any }
  | { stage: 'error'; message: string }

declare global {
  interface Window {
    __lav: {
      status: () => Status
      video: () => HTMLVideoElement
      // Wait for `predicate(video)` to be true (polls every 50ms, default 5s timeout).
      waitFor: (predicate: (v: HTMLVideoElement) => boolean, timeoutMs?: number) => Promise<void>
      seek: (t: number) => Promise<void>
      // Range descriptions for assertions
      buffered: () => [number, number][]
      // Worker logs captured for assertions
      logs: { type: 'log' | 'warn' | 'error'; text: string }[]
    }
  }
}

const params = new URLSearchParams(location.search)
// Video param is resolved relative to the origin root (so /sample-h264.mkv works regardless of
// the page being served from /tests/...).
const VIDEO_URL = new URL('/' + (params.get('video') ?? 'sample-h264.mkv').replace(/^\/+/, ''), location.origin).toString()
const threadCount = Number(params.get('threads') ?? '1')

const statusEl = document.getElementById('status') as HTMLDivElement
const video = document.getElementById('video') as HTMLVideoElement
let status: Status = { stage: 'init' }
const setStatus = (s: Status) => { status = s; statusEl.textContent = JSON.stringify(s) }

const logs: { type: 'log' | 'warn' | 'error'; text: string }[] = []
;(['log', 'warn', 'error'] as const).forEach((type) => {
  const orig = console[type].bind(console)
  console[type] = (...args: unknown[]) => {
    logs.push({ type, text: args.map(String).join(' ') })
    orig(...args)
  }
})

window.__lav = {
  status: () => status,
  video: () => video,
  waitFor: (predicate, timeoutMs = 5000) => new Promise<void>((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (predicate(video)) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 50)
    }
    tick()
  }),
  seek: (t) => new Promise<void>((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve() }
    video.addEventListener('seeked', onSeeked)
    video.currentTime = t
  }),
  buffered: () => Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
  logs,
}

const main = async () => {
  // Probe content length
  const head = await fetch(VIDEO_URL, { headers: { Range: 'bytes=0-1' } })
  if (!head.ok && head.status !== 206) throw new Error(`fetch ${VIDEO_URL} failed: ${head.status}`)
  const contentLength = Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))

  const origin = new URL(import.meta.url).origin
  const remuxer = await makeRemuxer({
    workerUrl: new URL('../build/worker.js', import.meta.url).toString(),
    workerOptions: { type: 'module' },
    moduleUrl: new URL('/dist/libav.js', origin).toString(),
    wasmUrl: new URL('/dist/libav.wasm', origin).toString(),
    threadedModuleUrl: new URL('/dist/libav-mt.js', origin).toString(),
    threadedWasmUrl: new URL('/dist/libav-mt.wasm', origin).toString(),
    threadCount,
    bufferSize: 2_500_000,
    length: contentLength,
    read: (offset, size) => {
      if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
      return fetch(VIDEO_URL, {
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
        `video/mp4; codecs="${[header.info.output.videoMimeType, header.info.output.audioMimeType].filter(Boolean).join(',')}"`
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
  // Append the first media fragment so the video is actually playable (readyState reaches
  // HAVE_FUTURE_DATA). Without this the loadMore loop never triggers because currentTime=0
  // isn't in any buffered range yet.
  try {
    const first = await remuxer.read()
    if (first.data.byteLength > 0) await appendBuffer(first.data)
  } catch (e) {
    if ((e as Error).message !== 'Cancelled') throw e
  }

  // Release the worker + WebCodecs encoder on navigation away, so consecutive Playwright tests
  // don't accumulate hardware encoder/decoder resources that Chrome rate-limits.
  window.addEventListener('pagehide', () => { remuxer.destroy().catch(() => {}) })

  setStatus({ stage: 'ready', info: header.info })

  // Top up the buffer up to ~60s ahead of currentTime
  const BUFFER_TO = 60
  let finished = false
  const loadMore = async () => {
    if (finished) return
    const ranges = Array.from({ length: sourceBuffer.buffered.length }, (_, i) => [sourceBuffer.buffered.start(i), sourceBuffer.buffered.end(i)] as [number, number])
    const cur = video.currentTime
    const inRange = ranges.find(([s, e]) => s <= cur && cur <= e)
    if (!inRange) return
    if (inRange[1] >= cur + BUFFER_TO) return
    try {
      const res = await remuxer.read()
      if (res.data.byteLength > 0) await appendBuffer(res.data)
      if (res.finished) finished = true
    } catch (e) {
      if ((e as Error).message !== 'Cancelled') console.error('loadMore error:', e)
    }
  }
  setInterval(loadMore, 100)

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
}

main().catch((e) => {
  setStatus({ stage: 'error', message: String(e?.stack ?? e) })
  console.error(e)
})
