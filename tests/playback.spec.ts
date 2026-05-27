import { test, expect } from '@playwright/test'

/**
 * Cross-browser MSE playback assertions. Tests target a few seconds of motion (not full
 * playback) — the WASM remux/transcode is the bottleneck and we don't need real-time
 * coverage to catch regressions in the codepaths.
 */

const open = async (page, { video, threads = 1 }: { video: string; threads?: number }) => {
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  await page.goto(`/tests/test-page.html?video=${encodeURIComponent(video)}&threads=${threads}`)
  await page.waitForFunction(() => {
    const s = window.__lav?.status?.()
    return s && (s.stage === 'ready' || s.stage === 'error')
  }, undefined, { timeout: 30_000 })
  const status = await page.evaluate(() => window.__lav.status())
  if (status.stage === 'error') throw new Error(`harness error: ${(status as any).message}`)
}

const videoState = (page) =>
  page.evaluate(() => {
    const v = window.__lav.video()
    return {
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      currentTime: v.currentTime,
      duration: v.duration,
      videoWidth: v.videoWidth,
      buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
    }
  })

test.describe('H264 passthrough', () => {
  test('plays', async ({ page }) => {
    await open(page, { video: 'sample-h264.mkv' })
    const info = await page.evaluate(() => (window.__lav.status() as any).info)
    expect(info.input.videoMimeType).toMatch(/^avc1\./)
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().currentTime > 0.5, undefined, { timeout: 10_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.videoWidth).toBe(640)
  })

  test('seeks forward then backward', async ({ page }) => {
    await open(page, { video: 'sample-h264.mkv' })
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().buffered.length > 0)
    await page.evaluate(() => window.__lav.seek(60))
    await page.waitForFunction(() => window.__lav.video().currentTime >= 59, undefined, { timeout: 15_000 })
    expect((await videoState(page)).currentTime).toBeGreaterThanOrEqual(59)
    await page.evaluate(() => window.__lav.seek(10))
    await page.waitForFunction(() => window.__lav.video().currentTime <= 11, undefined, { timeout: 15_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.currentTime).toBeLessThanOrEqual(11)
  })

  test('survives the EOF trailer (no timescale-0 regression)', async ({ page }) => {
    await open(page, { video: 'sample-h264.mkv' })
    const dur = await page.evaluate(() => window.__lav.video().duration)
    await page.evaluate((t) => window.__lav.seek(t), Math.max(dur - 1.5, 0))
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => {
      const v = window.__lav.video()
      return v.ended || v.currentTime > v.duration - 0.2
    }, undefined, { timeout: 15_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    const errs = await page.evaluate(() => window.__lav.logs.filter((l) => l.type === 'error'))
    expect(errs.find((e) => /timescale/i.test(e.text))).toBeUndefined()
  })
})

test.describe('HEVC fallback', () => {
  // WebKit plays HEVC natively (Safari pipeline), so the fallback isn't exercised there.
  test.beforeEach(async ({ page, browserName }) => {
    if (browserName === 'webkit') {
      const native = await page.evaluate(() =>
        typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')
      )
      test.skip(native, 'browser plays HEVC natively')
    }
  })

  test('single-threaded decode plays', async ({ page }) => {
    await open(page, { video: 'sample-hevc.mkv', threads: 1 })
    const info = await page.evaluate(() => (window.__lav.status() as any).info)
    expect(info.input.videoMimeType).toMatch(/^hev1\./)
    expect(info.output.videoMimeType).toMatch(/^avc1\./)
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().currentTime > 0.5, undefined, { timeout: 20_000 })
    expect((await videoState(page)).error).toBeNull()
  })

  test('multi-threaded decode plays (needs cross-origin isolation)', async ({ page }) => {
    await page.goto('/tests/test-page.html?video=sample-h264.mkv&threads=1')
    const { isolated, hasSAB } = await page.evaluate(() => ({
      isolated: (globalThis as any).crossOriginIsolated === true,
      hasSAB: typeof SharedArrayBuffer !== 'undefined',
    }))
    test.skip(!isolated || !hasSAB, 'SAB / crossOriginIsolated not available')
    await open(page, { video: 'sample-hevc.mkv', threads: 0 })
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().currentTime > 0.5, undefined, { timeout: 20_000 })
    expect((await videoState(page)).error).toBeNull()
  })

  test('seeks', async ({ page }) => {
    await open(page, { video: 'sample-hevc.mkv', threads: 1 })
    await page.evaluate(() => window.__lav.video().play())
    await page.waitForFunction(() => window.__lav.video().buffered.length > 0, undefined, { timeout: 15_000 })
    await page.evaluate(() => window.__lav.seek(45))
    await page.waitForFunction(() => window.__lav.video().currentTime >= 44, undefined, { timeout: 20_000 })
    const s = await videoState(page)
    expect(s.error).toBeNull()
    expect(s.currentTime).toBeGreaterThanOrEqual(44)
  })
})
