import { test, expect } from 'vitest'
import { createDecodeRenderMedia } from '../src/videojs'

// Exercises the Video.js v10 media factory end-to-end on the decode-render fallback: audio-only
// fMP4 -> MSE <audio> timeline (duration + seekable clock) + a canvas the worker draws decoded
// HEVC frames onto, slaved to the audio clock. Firefox only (chromium plays HEVC natively).
const playsHevcNatively =
  typeof MediaSource !== 'undefined'
  && !navigator.userAgent.includes('Firefox')
  && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')

test.skipIf(playsHevcNatively)('decode-render media object: audio timeline + canvas video + seek', async () => {
  const sample = 'sample-hevc-audio.mkv'
  const url = new URL('/test-files/' + sample, location.origin).toString()
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  const contentLength = Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))

  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  document.body.appendChild(canvas)

  const { audio, videoWidth, videoHeight, stats, destroy } = await createDecodeRenderMedia({
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
    read: (offset, size) => {
      if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
      return fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } }).then((r) => r.arrayBuffer())
    },
  })

  // Right video dimensions + a real audio-backed seekable timeline (a normal HTMLMediaElement).
  expect(videoWidth).toBe(1280)
  expect(videoHeight).toBe(720)
  expect(audio.duration).toBeGreaterThan(4) // ~5s clip; proves audio extraction + MSE timeline

  // Seek to 2s: fires 'seeking' on the audio, repositions the decoder, presents that frame.
  audio.currentTime = 2.0
  await new Promise((r) => setTimeout(r, 800))
  const s = stats()
  console.log(`[videojs-media] duration=${audio.duration} decoded=${s.decoded} skipped=${s.skipped} presentedPts=${s.presentedPts}`)
  expect(s.decoded).toBeGreaterThan(0)
  expect(s.presentedPts).toBeGreaterThan(1.0) // presented a frame at/after the 2s seek target

  await destroy()
  canvas.remove()
}, 60_000)
