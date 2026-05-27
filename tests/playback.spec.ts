import { test, expect } from '@playwright/test'

/**
 * Drives the harness at /tests/test-page.html and asserts MSE playback works.
 * Cases:
 *  - H264/AAC passthrough (every browser)
 *  - HEVC fallback single-threaded (browsers without native HEVC)
 *  - HEVC fallback multi-threaded (needs SAB; only when crossOriginIsolated)
 *  - Seeking forward + backward inside a 2-minute sample
 *  - Trailer-after-EOF (regression for "Movie header's timescale must not be 0")
 */

const open = async (page, { video, threads = 1 }: { video: string; threads?: number }) => {
  // Forward page-side errors to playwright test output so failures self-explain.
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  await page.goto(`/tests/test-page.html?video=${encodeURIComponent(video)}&threads=${threads}`)
  // Cold init can be slow (WASM compile + decode first HEVC frame); be generous.
  await page.waitForFunction(() => {
    const s = window.__lav?.status?.()
    return s && (s.stage === 'ready' || s.stage === 'error')
  }, undefined, { timeout: 90_000 })
  const status = await page.evaluate(() => window.__lav.status())
  if (status.stage === 'error') throw new Error(`harness error: ${(status as any).message}`)
}

const errorEvents = async (page) =>
  await page.evaluate(() => window.__lav.logs.filter((l) => l.type === 'error'))

const videoState = async (page) =>
  await page.evaluate(() => {
    const v = window.__lav.video()
    return {
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      currentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      readyState: v.readyState,
      buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
    }
  })

test.describe('H264 passthrough', () => {
  test('plays a 2-minute file end to end', async ({ page }) => {
    await open(page, { video: 'sample-h264.mkv' })

    // Codec was identified
    const info = await page.evaluate(() => (window.__lav.status() as any).info)
    expect(info.input.videoMimeType).toMatch(/^avc1\./)
    expect(info.output.videoMimeType).toMatch(/^avc1\./)

    // Playback works
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForTimeout(1500)
    let s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.currentTime).toBeGreaterThan(0.5)
    expect(s.videoWidth).toBe(640)

    // Buffer continues to grow
    await page.waitForFunction(() => window.__lav.video().buffered.end(0) > 30, undefined, { timeout: 20_000 })
    s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.buffered[0][1]).toBeGreaterThan(30)
  })

  test('seek forward then backward', async ({ page }) => {
    await open(page, { video: 'sample-h264.mkv' })
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().buffered.end(0) > 5)

    await page.evaluate(() => window.__lav.seek(60))
    await page.waitForFunction(() => window.__lav.video().currentTime >= 59, undefined, { timeout: 20_000 })
    let s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.currentTime).toBeGreaterThanOrEqual(59)

    await page.evaluate(() => window.__lav.seek(10))
    await page.waitForFunction(() => window.__lav.video().currentTime <= 11, undefined, { timeout: 20_000 })
    s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.currentTime).toBeLessThanOrEqual(11)
  })

  test('finishes cleanly (no timescale-0 trailer regression)', async ({ page }) => {
    await open(page, { video: 'sample-h264.mkv' })
    // Seek near the end so the muxer trailer is exercised (the original bug: subsequent reads
    // after EOF re-called av_write_trailer, emitting garbage moov bytes that broke MSE).
    const duration: number = await page.evaluate(() => window.__lav.video().duration)
    await page.evaluate((t) => window.__lav.seek(t), Math.max(duration - 3, 0))
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => {
      const v = window.__lav.video()
      return v.ended || v.currentTime > v.duration - 0.2
    }, undefined, { timeout: 30_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    const errs = await errorEvents(page)
    expect(errs.find((e) => /timescale/i.test(e.text))).toBeUndefined()
  })
})

test.describe('HEVC fallback', () => {
  // Skip when the browser plays HEVC natively (Safari/WebKit): the passthrough path is taken
  // and the transcode fallback isn't exercised.
  test.beforeEach(async ({ page, browserName }) => {
    if (browserName === 'webkit') {
      const native = await page.evaluate(() =>
        typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')
      )
      test.skip(native, 'browser plays HEVC natively; transcode fallback not exercised')
    }
  })

  test('single-threaded decode plays', async ({ page }) => {
    await open(page, { video: 'sample-hevc.mkv', threads: 1 })

    const info = await page.evaluate(() => (window.__lav.status() as any).info)
    expect(info.input.videoMimeType).toMatch(/^hev1\./)
    expect(info.output.videoMimeType).toMatch(/^avc1\./) // transcoded to H264

    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().currentTime > 1, undefined, { timeout: 30_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.videoWidth).toBeGreaterThan(0)
  })

  test('multi-threaded decode plays (requires SAB / cross-origin isolation)', async ({ page }) => {
    // Probe with a barebones page to check isolation before opening the harness.
    await page.goto('/tests/test-page.html?video=sample-h264.mkv&threads=1')
    const { isolated, hasSAB } = await page.evaluate(() => ({
      isolated: (globalThis as any).crossOriginIsolated === true,
      hasSAB: typeof SharedArrayBuffer !== 'undefined',
    }))
    test.skip(!isolated || !hasSAB, `SharedArrayBuffer / crossOriginIsolated not available (isolated=${isolated}, SAB=${hasSAB})`)

    await open(page, { video: 'sample-hevc.mkv', threads: 0 })
    const info = await page.evaluate(() => (window.__lav.status() as any).info)
    expect(info.output.videoMimeType).toMatch(/^avc1\./)
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().currentTime > 1, undefined, { timeout: 30_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
  })

  test('seek in HEVC fallback', async ({ page }) => {
    await open(page, { video: 'sample-hevc.mkv', threads: 1 })
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().buffered.end(0) > 2, undefined, { timeout: 30_000 })

    await page.evaluate(() => window.__lav.seek(45))
    await page.waitForFunction(() => window.__lav.video().currentTime >= 44, undefined, { timeout: 30_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.currentTime).toBeGreaterThanOrEqual(44)
  })
})
