// Test media, synthesized rather than committed. Nothing here is anyone's content, so there is no
// copyright question and no multi-megabyte blob in git history. What matters for a remuxer is a file's
// STRUCTURE, and every fixture below exists because a real bug needed exactly that structure to show up.
//
// The trick that makes decoded frames assertable: each frame's colour is a function of its timestamp, so
// a thumbnail can be checked back to the second it came from. Without it the only available assertion is
// "some bytes came back", which is how hevc thumbnails silently returned frame one for every timestamp.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** red channel carries the second, in steps of 4 so h264 on a flat colour cannot blur two seconds together */
export const SECOND_STEP = 4
export const secondFromRed = (red) => Math.round(red / SECOND_STEP)

const WIDTH = 320
const HEIGHT = 240
const FPS = 10
/** keyframe every 2s, so a 60s fixture has 30 of them to seek between */
const GOP = FPS * 2

const colourByTime = `geq=r='mod(floor(T)*${SECOND_STEP},256)':g='mod(floor(T)*16,256)':b='mod(floor(T)*64,256)'`

/** ffmpeg wants every input before any output option, so the two halves are kept apart deliberately */
const inputs = (size = `${WIDTH}x${HEIGHT}`, fps = FPS) => [
  '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${fps}`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
]

const encode = (gop = GOP) => [
  '-filter:v', colourByTime,
  '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
]

/**
 * Each entry names the bug it exists to catch. `strict` is for encoders ffmpeg marks experimental.
 */
export const FIXTURES = [
  {
    name: 'h264-aac.mkv',
    why: 'baseline remux, thumbnails and seeking',
    seconds: 60,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-ac3.mkv',
    why: 'ac3 used to abort the whole module inside avformat_write_header',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'ac3'],
  },
  {
    name: 'h264-eac3.mkv',
    why: 'the eac3 transcode path that ac3 now shares',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'eac3'],
  },
  {
    name: 'hevc10-aac.mkv',
    why: 'hevc offers no prefer-software WebCodecs decoder, and a hardware one repeats frame one',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none', '-crf', '18', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac'],
  },
  {
    name: 'h264-aac.mp4',
    why: 'mov time_base is not 1/1000, which is the only thing that made the unrescaled seek look correct',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-video_track_timescale', '90000'],
  },
  {
    name: 'h264-aac-subs.mkv',
    why: 'the subtitle packet path, which leaked one AVPacket per dialogue line',
    seconds: 30,
    subtitles: true,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-truehd.mkv',
    why: 'audio the mp4 muxer cannot write must drop to video only, not abort',
    seconds: 10,
    strict: true,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'truehd'],
  },
]

/**
 * Over 4 GB, so byte offsets exceed 2^32. Opt in with LIBAV_LARGE_FIXTURE=1.
 *
 * Uncompressed rather than encoded, because the only thing this fixture has to be is BIG: the test reads
 * index positions and never decodes a frame, so it needs no timestamp colour coding. Trying to reach 4 GB
 * by raising an encoder's bitrate does not work, since a flat colour compresses to nothing whatever the
 * target says. Raw yuv420p at 1080p is 3.1 MB per frame, so this is bytes on disk at write speed.
 */
export const LARGE_FIXTURE = {
  name: 'raw-large.mkv',
  why: 'Index::pos was 32 bits, so every keyframe past 4 GB reported a wrapped position',
  seconds: 50,
  inputs: inputs('1920x1080', 30),
  args: ['-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
}

const SUBTITLE_TRACK = `1
00:00:01,000 --> 00:00:05,000
first line

2
00:00:06,000 --> 00:00:10,000
second line

3
00:00:11,000 --> 00:00:15,000
third line
`

/** the spec decides the bytes, so its hash decides whether a cached fixture is still valid */
const specHash = (fixture) =>
  createHash('sha256').update(JSON.stringify([fixture.inputs, fixture.args, fixture.seconds, fixture.subtitles, SECOND_STEP])).digest('hex').slice(0, 16)

const build = async (fixture) => {
  const target = join(FIXTURE_DIR, fixture.name)
  const stampPath = `${target}.spec`
  const hash = specHash(fixture)

  const cached = await readFile(stampPath, 'utf8').catch(() => null)
  if (cached === hash && await stat(target).then(s => s.size > 0, () => false)) return { ...fixture, path: target, cached: true }

  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  if (fixture.subtitles) {
    const subPath = join(FIXTURE_DIR, `${fixture.name}.srt`)
    await writeFile(subPath, SUBTITLE_TRACK)
    args.push(...fixture.inputs, '-i', subPath, ...fixture.args, '-t', String(fixture.seconds), '-c:s', 'ass', '-map', '0:v', '-map', '1:a', '-map', '2:s')
  } else {
    args.push(...fixture.inputs, ...fixture.args, '-t', String(fixture.seconds), '-map', '0:v', '-map', '1:a')
  }
  if (fixture.strict) args.push('-strict', '-2')
  args.push(target)

  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  await writeFile(stampPath, hash)
  return { ...fixture, path: target, cached: false }
}

export const ensureFixtures = async ({ large = false } = {}) => {
  await mkdir(FIXTURE_DIR, { recursive: true })
  const wanted = [...FIXTURES, ...(large ? [LARGE_FIXTURE] : [])]
  const built = []
  for (const fixture of wanted) {
    const result = await build(fixture)
    built.push(result)
  }
  return built
}

/**
 * Whatever the owner dropped in fixtures/local. Real world files never enter git, so this tier is empty in
 * CI and rich on a machine that has actual releases sitting in it.
 */
export const localFixtures = async () => {
  const dir = join(FIXTURE_DIR, 'local')
  const names = await readdir(dir).catch(() => [])
  return names
    .filter(name => /\.(mkv|mp4|webm|mov)$/i.test(name))
    .map(name => ({ name, path: join(dir, name), local: true }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const large = process.env.LIBAV_LARGE_FIXTURE === '1'
  const built = await ensureFixtures({ large })
  for (const fixture of built) {
    const { size } = await stat(fixture.path)
    console.log(`${fixture.cached ? 'cached ' : 'built  '} ${fixture.name.padEnd(22)} ${(size / 1e6).toFixed(1)} MB   ${fixture.why}`)
  }
  const local = await localFixtures()
  console.log(local.length ? `\n${local.length} local fixture(s) in fixtures/local` : '\nno local fixtures (drop real files in fixtures/local to widen coverage)')
}
