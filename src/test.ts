import PQueue from 'p-queue'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

import { makeRemuxer, createDecodeRenderMedia } from '.'
import { queuedThrottleWithLastCall } from './utils'
import { VideoJsPlayer } from './videojs-player'

// Manual playground: pick a test file + rendering mode + thread count, hit Load, and play with it.
// `npm run dev` serves this at http://localhost:1234.
//
//   - MSE <video>     : H264 passthrough, or HEVC re-encoded to H264 via WebCodecs (worker picks
//                       by codec). Native <video> controls.
//   - decode-render   : HEVC decoded to I420 and drawn onto a <canvas> (no re-encode). When the
//                       file has audio, an <audio> element is the clock + sound; otherwise a manual
//                       play/seek transport drives renderFrame() on a wall clock.

const TEST_FILES = [
  'sample-hevc-audio.mkv',
  'sample-h264.mkv',
  'sample-hevc.mkv',
  'sample-hevc-720p.mkv',
  'sample-hevc-1440p.mkv',
  'sample-hevc-2160p.mkv',
]

const origin = location.origin
const urls = {
  workerUrl: new URL('/build/worker.js', origin).toString(),
  workerOptions: { type: 'module' as const },
  moduleUrl: new URL('/dist/libav.js', origin).toString(),
  wasmUrl: new URL('/dist/libav.wasm', origin).toString(),
  threadedModuleUrl: new URL('/dist/libav-mt.js', origin).toString(),
  threadedWasmUrl: new URL('/dist/libav-mt.wasm', origin).toString(),
}
const BUFFER_SIZE = 2_500_000

const fileUrl = (name: string) => new URL('/test-files/' + name, origin).toString()
const contentLengthOf = async (url: string) => {
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  return Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))
}
const readFn = (url: string, length: number) => (offset: number, size: number) =>
  offset >= length
    ? Promise.resolve(new Uint8Array(0).buffer)
    : fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, length) - 1}` } }).then((r) => r.arrayBuffer())

type Teardown = () => Promise<void>

// ---- MSE <video> (passthrough / WebCodecs re-encode) -----------------------------------------
const mountMse = async (file: string, threadCount: number, mount: HTMLElement, log: (s: string) => void): Promise<Teardown> => {
  const url = fileUrl(file)
  const length = await contentLengthOf(url)
  const remuxer = await makeRemuxer({ ...urls, threadCount, bufferSize: BUFFER_SIZE, length, read: readFn(url, length) })
  const header: any = await remuxer.init()
  log(`MSE — ${header.info.input.videoMimeType} → ${header.info.output.videoMimeType} (${header.renderMode === 'mse' ? 'WebCodecs re-encode' : 'passthrough'}), ${header.info.input.duration.toFixed(1)}s`)

  // Same Video.js v10 skin as canvas mode, but here the media element is the <video> itself — it
  // renders the picture and is what the skin controls; the transparent skin sits on top.
  const video = document.createElement('video')
  video.playsInline = true
  video.addEventListener('error', () => console.error('video error', video.error))
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;width:100%;max-width:960px;margin-top:6px'
  // In-flow video: its intrinsic aspect drives the wrap's height (no aspect-ratio guessing).
  video.style.cssText = 'display:block;width:100%;height:auto;background:#000'
  const skinHost = document.createElement('div')
  skinHost.style.cssText = 'position:absolute;inset:0'
  wrap.append(video, skinHost)
  mount.appendChild(wrap)

  const mediaSource = new MediaSource()
  video.src = URL.createObjectURL(mediaSource)
  const sb: SourceBuffer = await new Promise((resolve) => mediaSource.addEventListener('sourceopen', () => {
    const s = mediaSource.addSourceBuffer(`video/mp4; codecs="${[header.info.output.videoMimeType, header.info.output.audioMimeType].filter(Boolean).join(',')}"`)
    mediaSource.duration = header.info.input.duration // total duration up front, not derived from buffered
    s.mode = 'segments'
    resolve(s)
  }, { once: true }))

  // All SourceBuffer ops go through one queue — appends/removes can't overlap.
  const queue = new PQueue({ concurrency: 1 })
  const sbOp = (op: () => void) => queue.add(() => new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(new Error('SourceBuffer error')) }
    const cleanup = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail) }
    sb.addEventListener('updateend', done, { once: true })
    sb.addEventListener('error', fail, { once: true })
    op()
  }))
  const append = (buf: ArrayBuffer) => buf.byteLength ? sbOp(() => sb.appendBuffer(buf)) : Promise.resolve()
  const remove = (s: number, e: number) => s < e ? sbOp(() => sb.remove(s, e)) : Promise.resolve()
  const ranges = () => Array.from({ length: sb.buffered.length }, (_, i) => [sb.buffered.start(i), sb.buffered.end(i)] as [number, number])

  await append(header.data)
  await append((await remuxer.read()).data)

  const BUFFER_AHEAD = 30
  const KEEP_BEHIND = 30
  let finished = false
  let seeks = 0 // in-flight seeks; loadMore must not read while seeking (it would abort the seek's read)

  const trim = async () => {
    const t = video.currentTime
    for (const [s, e] of ranges()) if (e < t - KEEP_BEHIND) await remove(s, e)
  }

  // queuedThrottleWithLastCall serializes + throttles: reads never overlap. (Overlapping reads each
  // abort the previous via addTask, which stalls buffering — the bug this replaced.)
  const loadMore = queuedThrottleWithLastCall(100, async () => {
    if (seeks > 0 || finished) return
    const t = video.currentTime
    const r = ranges().find(([s, e]) => s <= t && t <= e)
    if (!r || r[1] >= t + BUFFER_AHEAD) return
    try {
      const res = await remuxer.read()
      await append(res.data)
      if (res.finished) finished = true
      await trim()
    } catch (e: any) { if (e?.message !== 'Cancelled') console.error(e) }
  })
  const interval = setInterval(loadMore, 100)

  video.addEventListener('seeking', async () => {
    const t = video.currentTime
    if (ranges().some(([s, e]) => s <= t && t <= e)) return // already buffered — let it play
    seeks++
    try {
      const res = await remuxer.seek(t)
      sb.timestampOffset = res.pts
      await append(res.data)
      finished = false
    } catch (e: any) { if (e?.message !== 'Cancelled') console.error(e) } finally { seeks-- }
  })

  const root = createRoot(skinHost)
  root.render(createElement(VideoJsPlayer, { media: video }))

  return async () => {
    root.unmount()
    clearInterval(interval)
    try { video.pause() } catch {}
    try { await remuxer.destroy() } catch {}
    wrap.remove()
  }
}

// ---- decode-render -> canvas, played through Video.js v10 -------------------------------------
const mountDecodeRender = async (file: string, threadCount: number, mount: HTMLElement, log: (s: string) => void): Promise<Teardown> => {
  const url = fileUrl(file)
  const length = await contentLengthOf(url)

  // The worker draws decoded frames onto this canvas; the transparent Video.js skin sits on top.
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;width:100%;max-width:960px;background:#000;margin-top:6px'
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
  const skinHost = document.createElement('div')
  skinHost.style.cssText = 'position:absolute;inset:0'
  wrap.append(canvas, skinHost)
  mount.appendChild(wrap)

  let media: Awaited<ReturnType<typeof createDecodeRenderMedia>>
  try {
    media = await createDecodeRenderMedia({ canvas, ...urls, threadCount, bufferSize: BUFFER_SIZE, length, read: readFn(url, length) })
  } catch (e: any) {
    log(`decode-render unavailable: ${e?.message ?? e} (does the browser play this codec natively?)`)
    wrap.remove()
    throw e
  }
  wrap.style.aspectRatio = `${media.videoWidth} / ${media.videoHeight}`

  // createDecodeRenderMedia gives a Video.js media object for every file — a real <audio> when there's
  // an audio track, a synthetic wall-clock otherwise — so video-only files get the player too.
  const root = createRoot(skinHost)
  root.render(createElement(VideoJsPlayer, { media: media.media }))
  log(`decode-render → Video.js v10 — ${media.videoWidth}x${media.videoHeight}, ${media.media.duration.toFixed(1)}s`)

  return async () => {
    root.unmount()
    await media.destroy()
    wrap.remove()
  }
}

// ---- UI ---------------------------------------------------------------------------------------
const labelled = (text: string, el: HTMLElement) => {
  const wrap = document.createElement('label')
  wrap.style.cssText = 'display:flex;gap:4px;align-items:center;font:13px sans-serif'
  const span = document.createElement('span'); span.textContent = text
  wrap.append(span, el)
  return wrap
}

const fileSelect = document.createElement('select')
for (const f of TEST_FILES) { const o = document.createElement('option'); o.value = f; o.textContent = f; fileSelect.appendChild(o) }

const modeSelect = document.createElement('select')
for (const [v, t] of [['mse', 'MSE → Video.js v10 (passthrough / re-encode)'], ['decode-render', 'decode-render → Video.js v10']] as const) {
  const o = document.createElement('option'); o.value = v; o.textContent = t; modeSelect.appendChild(o)
}

const threadsSelect = document.createElement('select')
for (const [v, t] of [['0', 'auto'], ['1', '1 (single)'], ['2', '2'], ['4', '4'], ['8', '8']] as const) {
  const o = document.createElement('option'); o.value = v; o.textContent = t; threadsSelect.appendChild(o)
}

const loadBtn = document.createElement('button'); loadBtn.textContent = 'Load'
const status = document.createElement('div'); status.style.cssText = 'font:13px monospace;margin:8px 0;min-height:1.2em'
const player = document.createElement('div')

const controls = document.createElement('div')
controls.style.cssText = 'display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px;border-bottom:1px solid #444'
controls.append(labelled('file', fileSelect), labelled('mode', modeSelect), labelled('threads', threadsSelect), loadBtn)
// The dev entry (index.html) uses a dark background — make our text legible on it.
document.body.style.color = '#ddd'
document.body.style.margin = '0'
document.body.append(controls, status, player)

let teardown: Teardown | undefined
const log = (s: string) => { status.textContent = s }

const load = async () => {
  loadBtn.disabled = true
  const prev = teardown; teardown = undefined
  try { await prev?.() } catch (e) { console.error('teardown', e) }
  player.replaceChildren()
  const file = fileSelect.value
  const mode = modeSelect.value
  const threadCount = Number(threadsSelect.value)
  log(`loading ${file} (${mode}, threads=${threadsSelect.value})…`)
  try {
    teardown = mode === 'mse'
      ? await mountMse(file, threadCount, player, log)
      : await mountDecodeRender(file, threadCount, player, log)
  } catch (e: any) {
    console.error(e)
    log(`error: ${e?.message ?? e}`)
  } finally {
    loadBtn.disabled = false
  }
}

loadBtn.addEventListener('click', () => void load())
void load() // auto-load the default selection
