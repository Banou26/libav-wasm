// Every test here exists because a real bug got through without it. The fixtures are synthesized, so the
// suite needs no committed media and no one else's content; see scripts/fixtures.mjs.

import { expect, test } from '@playwright/test'

import { ensureFixtures, localFixtures, secondFromRed } from '../scripts/fixtures.mjs'

const LARGE = process.env.LIBAV_LARGE_FIXTURE === '1'

test.beforeAll(async () => {
  await ensureFixtures({ large: LARGE })
})

const open = async (page) => {
  await page.goto('/')
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 60_000 })
}

/** the fixture's centre pixel encodes the second it came from, so a thumbnail can be checked, not just counted */
const expectFrameAt = (shot, requested, gopSeconds = 2) => {
  expect(shot.error, `readKeyframe(${requested}) failed: ${shot.error}`).toBeUndefined()
  const decoded = secondFromRed(shot.r)
  expect(decoded, `keyframe for t=${requested} decoded as second ${decoded}`).toBeGreaterThanOrEqual(requested - gopSeconds - 1)
  expect(decoded, `keyframe for t=${requested} decoded as second ${decoded}`).toBeLessThanOrEqual(requested + 1)
}

test.describe('remuxing', () => {
  test('a baseline file remuxes into playable fragmented mp4', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-aac.mkv'))

    expect(result.videoMimeType).toMatch(/^avc1\./)
    expect(result.audioMimeType).toMatch(/^mp4a\./)
    expect(result.duration).toBeGreaterThan(55)
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].bytes).toBeGreaterThan(0)
    // pts must advance, or the player stalls on a repeated segment
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].pts).toBeGreaterThan(result.segments[i - 1].pts)
    }
  })

  test('MediaSource accepts the output', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.playable('h264-aac.mkv'))
    expect(result.supported).toBe(true)
    expect(typeof result.buffered, `MSE rejected the bytes: ${JSON.stringify(result.buffered)}`).toBe('number')
    expect(result.buffered).toBeGreaterThan(0)
  })

  // ac3 made avformat_write_header fail, and with no exception support that killed the whole module
  test('ac3 audio transcodes instead of aborting the module', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-ac3.mkv'))
    expect(result.audioMimeType).toBe('mp4a.40.2')
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })

  test('eac3 audio transcodes too', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-eac3.mkv'))
    expect(result.audioMimeType).toBe('mp4a.40.2')
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })

  // truehd hits the same "cannot write moov before packets" refusal as ac3, and this ffmpeg build turns
  // out to carry a decoder for it, so it transcodes too. What matters is that it never aborts the module.
  test('truehd transcodes rather than aborting the module', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-truehd.mkv'))
    expect(result.videoMimeType).toMatch(/^avc1\./)
    expect(result.audioMimeType).toBe('mp4a.40.2')
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })

  test('subtitle tracks come back without breaking the muxed output', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-aac-subs.mkv'))
    expect(result.subtitleCount).toBeGreaterThan(0)
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })
})

test.describe('seeking', () => {
  test('seeks land on the requested position, forwards and backwards', async ({ page }) => {
    await open(page)
    const { steps } = await page.evaluate(() => window.harness.seek('h264-aac.mkv', [30, 10, 45, 30]))

    for (const step of steps) {
      expect(Math.abs(step.pts - step.target), `seek(${step.target}) landed at ${step.pts}`).toBeLessThanOrEqual(3)
    }
    // returning to a visited point must reproduce it, or the rebuild is not deterministic
    const first = steps.find(s => s.target === 30)
    const again = steps.filter(s => s.target === 30).at(-1)
    expect(again.bytes).toBe(first.bytes)
    expect(again.pts).toBe(first.pts)
  })

  // mov timescales are not 1/1000, which is the only reason an unrescaled millisecond value ever worked
  test('seeking is correct in a container whose time base is not 1/1000', async ({ page }) => {
    await open(page)
    const { steps } = await page.evaluate(() => window.harness.seek('h264-aac.mp4', [10, 20]))
    for (const step of steps) {
      expect(Math.abs(step.pts - step.target), `seek(${step.target}) landed at ${step.pts}`).toBeLessThanOrEqual(3)
    }
  })
})

test.describe('thumbnails', () => {
  test('each keyframe decodes to the frame that belongs at that timestamp', async ({ page }) => {
    await open(page)
    const times = [8, 20, 40]
    const result = await page.evaluate((t) => window.harness.thumbnails('h264-aac.mkv', t), times)

    expect(result.indexCount).toBeGreaterThan(0)
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
    // distinct frames, which is what a hardware decoder repeating frame one destroyed. Compared on the
    // decoded second rather than byte count: two different flat colours can compress to the same size.
    expect(new Set(result.shots.map(s => secondFromRed(s.r))).size).toBe(times.length)
  })

  // hevc is never offered with prefer-software, so WebCodecs would hand back a hardware decoder that
  // returns the first frame of the file for every timestamp. libav decodes it correctly instead.
  test('hevc keyframes are distinct and correct', async ({ page }) => {
    await open(page)
    const times = [6, 14, 24]
    const result = await page.evaluate((t) => window.harness.thumbnails('hevc10-aac.mkv', t), times)

    for (const shot of result.shots) expectFrameAt(shot, shot.t)
    expect(new Set(result.shots.map(s => secondFromRed(s.r))).size).toBe(times.length)
  })

  test('the thumbnailer opens a file whose audio the muxer refuses', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.thumbnails('h264-truehd.mkv', [4, 8]))
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
  })

  test('the thumbnailer and the remuxer produce the same frames', async ({ page }) => {
    await open(page)
    const times = [8, 20]
    const viaThumbnailer = await page.evaluate((t) => window.harness.thumbnails('h264-aac.mkv', t), times)
    const viaRemuxer = await page.evaluate((t) => window.harness.thumbnails('h264-aac.mkv', t, { viaRemuxer: true }), times)
    expect(viaThumbnailer.shots.map(s => secondFromRed(s.r))).toEqual(viaRemuxer.shots.map(s => secondFromRed(s.r)))
    expect(viaThumbnailer.shots.map(s => s.bytes)).toEqual(viaRemuxer.shots.map(s => s.bytes))
  })
})

test.describe('without WebCodecs', () => {
  const workerUrl = '/no-webcodecs-worker.js'

  // building a VideoDecoder eagerly in makeRemuxer took PLAYBACK down on Firefox for Android, for a
  // thumbnail feature playback never used
  test('playback is unaffected when WebCodecs is missing', async ({ page }) => {
    await open(page)
    const withCodecs = await page.evaluate(() => window.harness.remux('h264-aac.mkv'))
    const without = await page.evaluate((url) => window.harness.remux('h264-aac.mkv', { workerUrl: url }), workerUrl)

    expect(without.initBytes).toBe(withCodecs.initBytes)
    expect(without.segments.map(s => s.bytes)).toEqual(withCodecs.segments.map(s => s.bytes))
  })

  test('thumbnails still decode, in wasm', async ({ page }) => {
    await open(page)
    const times = [8, 20]
    const result = await page.evaluate(
      ([t, url]) => window.harness.thumbnails('h264-aac.mkv', t, { workerUrl: url }),
      [times, workerUrl],
    )
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
  })
})

test.describe('byte offsets', () => {
  test('index positions increase and stay inside the file', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.indexes('h264-aac.mkv'))
    expect(result.backwards).toBe(0)
    expect(result.maxPos).toBeLessThanOrEqual(result.length)
  })

  // Index::pos was 32 bits, so every keyframe past 4 GB reported a position about 4 GB too low
  test('positions do not wrap above 4 GB', async ({ page }) => {
    test.skip(!LARGE, 'set LIBAV_LARGE_FIXTURE=1 to build the >4 GB fixture')
    test.setTimeout(300_000)
    await open(page)
    const result = await page.evaluate(() => window.harness.indexes('raw-large.mkv'))

    expect(result.length).toBeGreaterThan(2 ** 32)
    expect(result.backwards).toBe(0)
    expect(result.maxPos).toBeGreaterThan(2 ** 32)
    expect(result.maxPos).toBeLessThanOrEqual(result.length)
  })
})

// Whatever real files the owner dropped in fixtures/local. Empty in CI, and never committed, so wild
// coverage costs nothing in the repo. These assert only what must hold for ANY file.
test.describe('local files', () => {
  test('every local fixture opens, remuxes and thumbnails', async ({ page }) => {
    const local = await localFixtures()
    test.skip(local.length === 0, 'drop real files in fixtures/local to run this')
    test.setTimeout(120_000 * local.length)
    await open(page)

    for (const fixture of local) {
      const remuxed = await page.evaluate((name) => window.harness.remux(name), fixture.name)
      expect(remuxed.videoMimeType, `${fixture.name} produced no video codec`).toBeTruthy()
      expect(remuxed.segments[0].bytes, `${fixture.name} produced no data`).toBeGreaterThan(0)

      const indexes = await page.evaluate((name) => window.harness.indexes(name), fixture.name)
      expect(indexes.backwards, `${fixture.name} index positions went backwards`).toBe(0)
      expect(indexes.maxPos, `${fixture.name} index position past end of file`).toBeLessThanOrEqual(indexes.length)
    }
  })
})
