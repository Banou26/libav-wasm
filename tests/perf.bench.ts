import { test, expect } from 'vitest'
import { makeRemuxer } from '../src'

// Raw HEVC fallback throughput probe — no <video>, no MSE pacing. For each (resolution,
// thread mode) combination, this measures:
//   - Cold start: wall time for init() + first fragment
//   - Steady-state throughput: how many seconds of muxed content per second of wall time
// Results are printed in a single summary table at the end so they're easy to compare.
//
// Only meaningful on browsers that don't play HEVC natively (otherwise the fallback path
// never runs). Run with: npm run test:perf

const playsHevcNatively =
  typeof MediaSource !== 'undefined'
  && !navigator.userAgent.includes('Firefox')
  && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')

const measure = async (sample: string, threads: number, log: (s: string) => void) => {
  const url = new URL('/test-files/' + sample, location.origin).toString()
  const head = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  if (!head.ok && head.status !== 206) throw new Error(`fetch ${url} failed: ${head.status}`)
  const contentLength = Number(head.headers.get('Content-Range')?.split('/')[1] ?? head.headers.get('Content-Length'))

  let workerLog = ''
  const tInit = Date.now()
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
      return fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } }).then((r) => r.arrayBuffer())
    },
  })

  await remuxer.init()
  const tFirstFragmentStart = Date.now()
  const first = await remuxer.read()
  const tFirstFragmentDone = Date.now()
  const coldStartMs = tFirstFragmentDone - tInit
  const firstFragmentMs = tFirstFragmentDone - tFirstFragmentStart

  // Steady-state: pump fragments until EOF or a wall budget, measure muxed seconds / wall
  const WALL_BUDGET_MS = 25_000
  const tStream = Date.now()
  let fragments = 1  // count the first one we already pulled
  let lastPts = first.pts ?? 0
  let firstPts = first.pts ?? 0
  let hitEof = false
  while (Date.now() - tStream < WALL_BUDGET_MS) {
    const res = await remuxer.read()
    if (res.data.byteLength === 0) break
    fragments++
    if (typeof res.pts === 'number') lastPts = res.pts
    if (res.finished) { hitEof = true; break }
  }
  const streamMs = Date.now() - tStream
  // Estimate produced seconds: lastPts is the start of the final fragment we received;
  // add one average fragment-worth so we don't undercount.
  const avgFragS = fragments > 1 ? (lastPts - firstPts) / (fragments - 1) : 0
  const producedS = lastPts - firstPts + avgFragS
  const realtimeRatio = (producedS * 1000) / streamMs

  log(`  cold start (init+first frag): ${coldStartMs}ms`)
  log(`  first fragment alone        : ${firstFragmentMs}ms`)
  log(`  steady-state                : ${producedS.toFixed(2)}s of content in ${streamMs}ms (${realtimeRatio.toFixed(2)}x realtime${hitEof ? ', EOF' : ''})`)
  log(`  fragments produced          : ${fragments}`)

  try { await remuxer.destroy() } catch {}

  return { sample, threads, coldStartMs, firstFragmentMs, producedS, streamMs, realtimeRatio, fragments }
}

const results: Awaited<ReturnType<typeof measure>>[] = []

const CONFIGS: Array<{ res: string; threads: number; name: string }> = [
  { res: '720p',  threads: 1, name: 'single' },
  { res: '720p',  threads: 0, name: 'multi-auto' },
  { res: '1080p', threads: 1, name: 'single' },
  { res: '1080p', threads: 0, name: 'multi-auto' },
  { res: '1440p', threads: 1, name: 'single' },
  { res: '1440p', threads: 0, name: 'multi-auto' },
  { res: '2160p', threads: 1, name: 'single' },
  // Sweep thread counts at 2160p — the auto (=cores) case can regress vs single, so check
  // whether moderate thread counts (2/4/8) hit a sweet spot.
  { res: '2160p', threads: 2, name: 'multi-2' },
  { res: '2160p', threads: 4, name: 'multi-4' },
  { res: '2160p', threads: 8, name: 'multi-8' },
  { res: '2160p', threads: 0, name: 'multi-auto' },
]

for (const cfg of CONFIGS) {
  test.skipIf(playsHevcNatively)(`HEVC ${cfg.res} ${cfg.name}`, async () => {
    const sample = cfg.res === '1080p' ? 'sample-hevc.mkv' : `sample-hevc-${cfg.res}.mkv`
    const log = (s: string) => console.log(`[perf ${cfg.res} ${cfg.name}] ${s}`)
    log(`measuring on ${sample}, threads=${cfg.threads}, cores=${navigator.hardwareConcurrency}`)
    const r = await measure(sample, cfg.threads, log)
    results.push(r)
    expect(r.realtimeRatio).toBeGreaterThanOrEqual(0)
  }, 240_000)
}

test('SUMMARY', () => {
  if (results.length === 0) return
  console.log('\n=== HEVC fallback perf summary ===')
  console.log('resolution  mode    cold(ms)  1st-frag(ms)  produced(s)  wall(ms)  realtime')
  for (const r of results) {
    const res = r.sample.match(/(\d+p)/)?.[1] ?? '????'
    const mode = r.threads === 1 ? 'single' : 'multi '
    console.log(
      `${res.padEnd(11)} ${mode}  ${String(r.coldStartMs).padStart(8)}  ${String(r.firstFragmentMs).padStart(12)}  ${r.producedS.toFixed(2).padStart(11)}  ${String(r.streamMs).padStart(8)}  ${r.realtimeRatio.toFixed(2).padStart(7)}x`
    )
  }
})
