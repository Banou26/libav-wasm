import { test, expect } from '@playwright/test'

/**
 * Not part of the suite: run with LIBAV_BENCH=1.
 *
 * Skipped on the `no-jspi` project too. That project exists so the normal tests run a second time against
 * the Asyncify build, but this file selects its build per call via `workerUrl`, so letting it run twice
 * would only measure the same two arms again under a page flag that no longer decides anything.
 */
const BENCH = !!process.env.LIBAV_BENCH
const ROUNDS = Number(process.env.LIBAV_BENCH_ROUNDS ?? 7)

/**
 * The arms are alternated round by round, and the order within a round is flipped on odd rounds.
 *
 * Running every repetition of one arm and then every repetition of the other cannot separate the arm from
 * whatever else drifted between the two blocks (thermal state, another process, a JIT tier-up). One run of
 * each per round, in both orders, is what makes the comparison mean anything.
 */
const ARMS = [
  { key: 'jspi', workerUrl: '/build/worker.js' },
  { key: 'asyncify', workerUrl: '/no-jspi-worker.js' },
]

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const fmt = (n, digits = 1) => Number(n).toFixed(digits)

const summarise = (label, runs, pick) => {
  const values = runs.map(pick)
  return {
    label,
    n: values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

const table = (rows, columns) => {
  const head = ['arm', ...columns.map(c => c.title)]
  const body = rows.map(r => [r.label, ...columns.map(c => c.cell(r))])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => String(b[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  return [line(head), line(widths.map(w => '-'.repeat(w))), ...body.map(line)].join('\n')
}

test.describe('bench', () => {
  test.skip(!BENCH, 'set LIBAV_BENCH=1')
  test.setTimeout(600_000)

  test.beforeEach(async ({ page }) => {
    page.on('pageerror', e => console.log('pageerror:', e.message))
    await page.goto('/bench.html')
    await page.waitForFunction(() => window.benchReady)
  })

  /**
   * The build comparison, on an in-memory source so nothing but the wasm and the osra hop is being timed.
   *
   * Two buffer sizes rather than one: 2.5 MB gives a handful of reads and 32 KB gives hundreds, so the
   * slope between them is the marginal cost of a read and the intercept is everything else. One buffer
   * size can only ever report a total, which cannot tell a per-read cost from a fixed one.
   */
  test('jspi against asyncify, in memory', async ({ page }) => {
    const NAME = 'local/video-only.mp4'
    const SEEKS = [5, 20, 2]
    const results = { jspi: { wide: [], narrow: [] }, asyncify: { wide: [], narrow: [] } }

    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 ? [...ARMS].reverse() : ARMS
      for (const arm of order) {
        for (const [key, bufferSize] of [['wide', undefined], ['narrow', 32768]]) {
          const run = await page.evaluate(
            ([name, workerUrl, bufferSize, seeks]) =>
              window.bench.session(name, { workerUrl, bufferSize, seeks, source: 'memory', segments: 3 }),
            [NAME, arm.workerUrl, bufferSize, SEEKS]
          )
          results[arm.key][key].push(run)
        }
      }
    }

    const rows = []
    for (const arm of ARMS) {
      for (const key of ['wide', 'narrow']) {
        const runs = results[arm.key][key]
        rows.push({
          ...summarise(`${arm.key}/${key}`, runs, r => r.totalMs),
          reads: runs[0].reads,
          boot: median(runs.map(r => r.bootMs)),
        })
      }
    }

    console.log('\n=== jspi vs asyncify, in-memory source, ' + NAME + ' ===')
    console.log(table(rows, [
      { title: 'reads', cell: r => r.reads },
      { title: 'total ms (median)', cell: r => fmt(r.median) },
      { title: 'min', cell: r => fmt(r.min) },
      { title: 'max', cell: r => fmt(r.max) },
      { title: 'boot ms', cell: r => fmt(r.boot) },
    ]))

    for (const arm of ARMS) {
      const wide = results[arm.key].wide
      const narrow = results[arm.key].narrow
      const dReads = narrow[0].reads - wide[0].reads
      const dMs = median(narrow.map(r => r.totalMs)) - median(wide.map(r => r.totalMs))
      console.log(`${arm.key}: +${dReads} reads costs ${fmt(dMs)} ms => ${fmt((dMs / dReads) * 1000)} us per read`)
    }

    const floor = []
    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 ? [...ARMS].reverse() : ARMS
      for (const arm of order) {
        const r = await page.evaluate(
          ([name, workerUrl]) => window.bench.roundTrip(name, { workerUrl, iterations: 500 }),
          [NAME, arm.workerUrl]
        )
        floor.push({ arm: arm.key, ...r })
      }
    }
    for (const arm of ARMS) {
      const us = floor.filter(f => f.arm === arm.key).map(f => f.perCallUs)
      console.log(`${arm.key}: non-suspending round trip ${fmt(median(us))} us per call`)
    }

    expect(rows.every(r => r.median > 0)).toBe(true)
  })

  /**
   * What the structured clone on the osra hop costs.
   *
   * In memory and at the real 2.5 MB buffer, so the whole payload crosses the worker boundary on every
   * read with no network to hide behind: 382 reads of 2.5 MB is near a gigabyte of cloning per session.
   * Both sources here hand back a freshly allocated buffer, which is what makes them safe to transfer.
   */
  test('transferring the read instead of cloning it', async ({ page }) => {
    const NAME = 'local/multi-audio.mp4'
    const SEEKS = [30, 90, 10]
    const cloned = []
    const moved = []

    for (let round = 0; round < ROUNDS; round++) {
      const arms = round % 2 ? [['moved', true], ['cloned', false]] : [['cloned', false], ['moved', true]]
      for (const [key, transferReads] of arms) {
        const run = await page.evaluate(
          ([name, seeks, transferReads]) =>
            window.bench.session(name, { seeks, transferReads, source: 'memory', segments: 3 }),
          [NAME, SEEKS, transferReads]
        )
        ;(key === 'cloned' ? cloned : moved).push(run)
      }
    }

    const rows = [
      { ...summarise('cloned', cloned, r => r.totalMs), runs: cloned },
      { ...summarise('transferred', moved, r => r.totalMs), runs: moved },
    ]

    console.log('\n=== osra clone vs transfer, in-memory source, ' + NAME + ' ===')
    console.log(table(rows, [
      { title: 'reads', cell: r => r.runs[0].reads },
      { title: 'MB across the hop', cell: r => fmt(median(r.runs.map(x => x.bytesReturned / 1e6))) },
      { title: 'total ms (median)', cell: r => fmt(r.median) },
      { title: 'min', cell: r => fmt(r.min) },
      { title: 'max', cell: r => fmt(r.max) },
    ]))

    const gain = median(cloned.map(r => r.totalMs)) - median(moved.map(r => r.totalMs))
    const mb = median(cloned.map(r => r.bytesReturned / 1e6))
    console.log(`transfer saves ${fmt(gain)} ms over ${fmt(mb)} MB => ${fmt((gain / mb) * 1000, 2)} us per MB`)

    // a transferred read that arrived detached would show up as different output, not as an error
    const shape = r => ({ initBytes: r.initBytes, segmentBytes: r.segmentBytes, videoMimeType: r.videoMimeType })
    for (const run of moved) expect(shape(run)).toEqual(shape(cloned[0]))

    expect(rows.every(r => r.median > 0)).toBe(true)
  })

  /**
   * Route 1: the same library, the same file, the only change being a window cache in the caller. Over
   * HTTP, because what this is meant to remove is refetching, and an in-memory source has nothing to
   * refetch.
   */
  test('caller-side window cache, over http', async ({ page }) => {
    const NAME = 'local/multi-audio.mp4'
    const SEEKS = [30, 90, 10]

    /**
     * The window size is swept, not fixed, because over HTTP it looks free and over a torrent it is not.
     * A read there waits for its PIECES, and ripple sizes the deadlined band from one 2.5 MB read, so a
     * window wider than that blocks the player on pieces nothing marked urgent. 2.5 MB is the size that
     * asks the engine for exactly what it asks for today; the question is what that costs against 5 MB.
     */
    const ARMS_BY_KEY = {
      plain: null,
      'cached 3x2.5MB': { windows: 3, windowBytes: 2_500_000 },
      'cached 3x5MB': { windows: 3, windowBytes: 5_000_000 },
    }
    const keys = Object.keys(ARMS_BY_KEY)
    const collected = Object.fromEntries(keys.map(k => [k, []]))

    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 ? [...keys].reverse() : keys
      for (const key of order) {
        const run = await page.evaluate(
          ([name, seeks, cache]) =>
            window.bench.session(name, { seeks, cache, source: 'http', segments: 3 }),
          [NAME, SEEKS, ARMS_BY_KEY[key]]
        )
        collected[key].push(run)
      }
    }

    const plain = collected.plain
    const cached = collected['cached 3x5MB']
    const rows = keys.map(key => ({ ...summarise(key, collected[key], r => r.totalMs), runs: collected[key] }))

    console.log('\n=== caller-side cache, http source, ' + NAME + ' ===')
    console.log(table(rows, [
      { title: 'reads', cell: r => r.runs[0].reads },
      { title: 'fetches', cell: r => r.runs[0].cache ? r.runs[0].cache.fetches : r.runs[0].reads },
      { title: 'MB off the wire', cell: r => fmt(median(r.runs.map(x => (x.cache ? x.cache.fetchedBytes : x.bytesReturned) / 1e6))) },
      { title: 'total ms (median)', cell: r => fmt(r.median) },
      { title: 'min', cell: r => fmt(r.min) },
      { title: 'max', cell: r => fmt(r.max) },
    ]))

    // A cache that answered with the wrong bytes would show up here as a speed win and nowhere else, so
    // the output has to be compared before any of the timings above mean anything.
    const shape = r => ({
      initBytes: r.initBytes,
      segmentBytes: r.segmentBytes,
      videoMimeType: r.videoMimeType,
      audioMimeType: r.audioMimeType,
    })
    for (const run of cached) expect(shape(run)).toEqual(shape(plain[0]))
    for (const run of plain) expect(shape(run)).toEqual(shape(plain[0]))

    expect(rows.every(r => r.median > 0)).toBe(true)
  })
})
