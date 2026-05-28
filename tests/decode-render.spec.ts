import { test, expect } from 'vitest'
import { makeRemuxer } from '../src'

// Decode-render fallback: when the browser can't play HEVC, libav-wasm decodes frames and draws
// them straight onto an OffscreenCanvas (no re-encode). Only meaningful where HEVC isn't native
// (Firefox); chromium plays HEVC, so the fallback never engages there.
const playsHevcNatively =
  typeof MediaSource !== 'undefined'
  && !navigator.userAgent.includes('Firefox')
  && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')

// 720p HEVC + AAC, so the decode-render path + audio fMP4 + adaptive skip all get exercised.
const SAMPLE = 'sample-hevc-audio.mkv'

const makeRenderRemuxer = async () => {
  const url = new URL('/test-files/' + SAMPLE, location.origin).toString()
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  const contentLength = Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))

  const canvas = new OffscreenCanvas(1280, 720)
  const remuxer = await makeRemuxer({
    workerUrl: new URL('/build/worker.js', location.origin).toString(),
    workerOptions: { type: 'module' },
    moduleUrl: new URL('/dist/libav.js', location.origin).toString(),
    wasmUrl: new URL('/dist/libav.wasm', location.origin).toString(),
    threadedModuleUrl: new URL('/dist/libav-mt.js', location.origin).toString(),
    threadedWasmUrl: new URL('/dist/libav-mt.wasm', location.origin).toString(),
    threadCount: 0,
    bufferSize: 2_500_000,
    length: contentLength,
    renderCanvas: canvas,
    read: (offset, size) => {
      if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
      return fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } }).then((r) => r.arrayBuffer())
    },
  })
  return remuxer
}

test.skipIf(playsHevcNatively)('decode-render draws HEVC frames to an OffscreenCanvas', async () => {
  const remuxer = await makeRenderRemuxer()
  const init: any = await remuxer.init()
  expect(init.renderMode).toBe('canvas')
  expect(init.videoWidth).toBe(1280)
  expect(init.videoHeight).toBe(720)
  // Audio-only fMP4 init segment for the MSE timeline (sample has audio).
  expect(init.audioInitSegment?.byteLength ?? 0).toBeGreaterThan(0)

  // Extract the whole audio track (no video decode) for the timeline, then rewind for video.
  const audio = await (remuxer as any).extractAudio() as ArrayBuffer
  expect(audio.byteLength).toBeGreaterThan(0)

  // Drive the render loop forward like a player would, requesting the frame for each timestamp.
  let stats: any
  for (const t of [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]) {
    stats = await (remuxer as any).renderFrame(t)
  }
  console.log(`[decode-render] totalDecoded=${stats.totalDecoded} totalSkipped=${stats.totalSkipped} presentedPts=${stats.presentedPts} audioInit=${init.audioInitSegment?.byteLength} audioBytes=${audio.byteLength}`)
  expect(stats.totalDecoded).toBeGreaterThan(0)
  expect(stats.presentedPts).toBeGreaterThanOrEqual(0)

  // Seeking should flush + present a fresh keyframe near the target.
  const seekStats: any = await remuxer.seek(1.0)
  expect(typeof seekStats.pts).toBe('number')

  await remuxer.destroy()
}, 60_000)

// 4K catch-up: dropping B-frames at decode (AVDISCARD_NONREF) must yield fewer frames for the same
// range. One full-clip pass decodes skip-off (adaptive flips it on at the end); seek(0) keeps it
// engaged, so the second pass decodes skip-on and yields strictly fewer.
test.skipIf(playsHevcNatively)('AVDISCARD_NONREF decode-skip reduces decoded frame count', async () => {
  const remuxer = await makeRenderRemuxer()
  await remuxer.init()

  // Pass 1: decode the whole clip in one call with B-frames kept (skip is off during the decode;
  // the adaptive check only flips it on once the call returns).
  const full: any = await (remuxer as any).renderFrame(1e6)
  const decodedAllFrames = full.decoded
  expect(decodedAllFrames).toBeGreaterThan(6) // enough frames that the adaptive logic engaged
  expect(full.skippingNonref).toBe(true) // adaptive turned B-frame dropping on for the next pass

  // Rewind to the start (seek keeps the skip engaged) and decode the whole clip again — now with
  // B-frames dropped at the decoder.
  await remuxer.seek(0)
  const skipped: any = await (remuxer as any).renderFrame(1e6)
  const decodedRefOnly = skipped.decoded

  console.log(`[decode-render] AVDISCARD_NONREF: keptAll=${decodedAllFrames} refOnly=${decodedRefOnly} dropped=${decodedAllFrames - decodedRefOnly}`)
  expect(decodedRefOnly).toBeLessThan(decodedAllFrames) // B-frames were dropped at decode
  // ...but reference frames still decode (guard against a "decoded nothing" false pass).
  expect(decodedRefOnly).toBeGreaterThan(decodedAllFrames / 4)
  expect(skipped.presentedPts).toBeGreaterThanOrEqual(0) // and a frame still made it to the canvas

  await remuxer.destroy()
}, 60_000)

// The defensive half: under normal 720p pacing the decoder keeps up, so B-frame dropping must never
// engage. Drive renderFrame like a 60Hz loop (small clock steps) and assert skip stays off.
test.skipIf(playsHevcNatively)('adaptive skip stays off under realtime pacing at 720p', async () => {
  const remuxer = await makeRenderRemuxer()
  await remuxer.init()

  const step = 1 / 60 // a 60Hz render loop on 24fps content: most ticks decode 0–1 new frames
  let maxDecoded = 0
  let lastPresentedPts = 0
  for (let t = 0; t <= 2.0; t += step) {
    const r: any = await (remuxer as any).renderFrame(t)
    expect(r.skippingNonref).toBe(false) // never falls behind, so never drops B-frames
    expect(r.decoded).toBeLessThan(6) // i.e. the adaptive trigger condition is never met
    maxDecoded = Math.max(maxDecoded, r.decoded)
    lastPresentedPts = r.presentedPts
  }

  console.log(`[decode-render] realtime-pacing: maxDecodedPerTick=${maxDecoded} lastPresentedPts=${lastPresentedPts.toFixed(3)}`)
  expect(maxDecoded).toBeLessThanOrEqual(3) // steady state is ~1 frame/tick, not "barely under the trigger"
  expect(lastPresentedPts).toBeGreaterThan(1.5) // and we genuinely advanced through the content

  await remuxer.destroy()
}, 60_000)
