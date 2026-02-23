import PQueue from 'p-queue'
import { queuedThrottleWithLastCall } from './utils'
import { makeRemuxer } from '.'

const BUFFER_SIZE = 2_500_000
const VIDEO_URL = '../video2.mkv'

const fetchContentLength = async (url: string): Promise<number> => {
  const { headers } = await fetch(url, { headers: { Range: 'bytes=0-1' } })
  const contentRangeContentLength = headers.get('Content-Range')?.split('/').at(1)
  return contentRangeContentLength
    ? Number(contentRangeContentLength)
    : Number(headers.get('Content-Length'))
}

const createWorkerUrl = (): string => {
  const _workerUrl = new URL('../build/worker.js', import.meta.url).toString()
  const blob = new Blob([`importScripts(${JSON.stringify(_workerUrl)})`], { type: 'application/javascript' })
  return URL.createObjectURL(blob)
}

const createReadFunction = (url: string, contentLength: number) =>
  (offset: number, size: number): Promise<ArrayBuffer> => {
    if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
    return fetch(url, {
      headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` }
    }).then(res => res.arrayBuffer())
  }

const createRemuxerInstance = async (contentLength: number) => {
  const workerUrl = createWorkerUrl()
  return makeRemuxer({
    publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
    workerUrl,
    bufferSize: BUFFER_SIZE,
    length: contentLength,
    read: createReadFunction(VIDEO_URL, contentLength)
  })
}

// ──────────────────────────────────────────────
// Main player
// ──────────────────────────────────────────────

const contentLength = await fetchContentLength(VIDEO_URL)
const remuxer = await createRemuxerInstance(contentLength)
const header = await remuxer.init()

const video = document.createElement('video')
video.width = 1440
video.controls = true
video.volume = 0
video.addEventListener('error', (ev) => {
  console.error((ev.target as HTMLVideoElement)?.error)
})
document.body.appendChild(video)

const mediaSource = new MediaSource()
video.src = URL.createObjectURL(mediaSource)

const sourceBuffer: SourceBuffer =
  await new Promise(resolve =>
    mediaSource.addEventListener(
      'sourceopen',
      () => {
        const codecs = [header.info.output.videoMimeType, header.info.output.audioMimeType]
          .filter(Boolean)
          .join(',')
        const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${codecs}"`)
        mediaSource.duration = header.info.input.duration
        sourceBuffer.mode = 'segments'
        resolve(sourceBuffer)
      },
      { once: true }
    )
  )

const setupListeners = (resolve: (value: Event) => void, reject: (reason: Event) => void) => {
  const unregisterListeners = () => {
    sourceBuffer.removeEventListener('updateend', updateEndListener)
    sourceBuffer.removeEventListener('abort', abortListener)
    sourceBuffer.removeEventListener('error', errorListener)
  }
  const updateEndListener = (ev: Event) => {
    resolve(ev)
    unregisterListeners()
  }
  const abortListener = (ev: Event) => {
    resolve(ev)
    unregisterListeners()
  }
  const errorListener = (ev: Event) => {
    console.error(ev)
    reject(ev)
    unregisterListeners()
  }
  sourceBuffer.addEventListener('updateend', updateEndListener, { once: true })
  sourceBuffer.addEventListener('abort', abortListener, { once: true })
  sourceBuffer.addEventListener('error', errorListener, { once: true })
}

const queue = new PQueue({ concurrency: 1 })

const appendBuffer = (buffer: ArrayBuffer) =>
  queue.add(() =>
    new Promise<Event>((resolve, reject) => {
      setupListeners(resolve, reject)
      sourceBuffer.appendBuffer(buffer)
    })
  )

const unbufferRange = async (start: number, end: number) =>
  queue.add(() =>
    new Promise<Event>((resolve, reject) => {
      setupListeners(resolve, reject)
      sourceBuffer.remove(start, end)
    })
  )

await appendBuffer(header.data)

const getTimeRanges = () =>
  Array.from({ length: sourceBuffer.buffered.length }, (_, index) => ({
    index,
    start: sourceBuffer.buffered.start(index),
    end: sourceBuffer.buffered.end(index)
  }))

const MIN_TIME = -30
const MAX_TIME = 75
const BUFFER_TO = 60

const unbuffer = async () => {
  const minTime = video.currentTime + MIN_TIME
  const maxTime = video.currentTime + MAX_TIME
  const bufferedRanges = getTimeRanges()
  for (const { start, end } of bufferedRanges) {
    if (start < minTime) {
      await unbufferRange(start, minTime)
    }
    if (end > maxTime) {
      await unbufferRange(maxTime, end)
    }
  }
}

let currentSeeks: { currentTime: number }[] = []
let lastSeekedPosition = 0

const loadMore = queuedThrottleWithLastCall(100, async () => {
  if (currentSeeks.length) return
  const { currentTime } = video
  const bufferedRanges = getTimeRanges()
  const timeRange = bufferedRanges.find(({ start, end }) => start <= currentTime && currentTime <= end)
  if (!timeRange) return

  const maxTime = video.currentTime + BUFFER_TO
  if (timeRange.end >= maxTime) return

  try {
    const res = await remuxer.read()
    await appendBuffer(res.data)
    await unbuffer()
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Cancelled') return
    console.error(err)
  }
})
setInterval(loadMore, 100)

video.addEventListener('seeking', async () => {
  const { currentTime } = video
  const bufferedRanges = getTimeRanges()
  const timeRange = bufferedRanges.find(({ start, end }) => start <= currentTime && currentTime <= end)
  // Seeking forward in a buffered range — just continue by reading
  if (timeRange && currentTime >= lastSeekedPosition) return

  const seekObject = { currentTime }
  currentSeeks = [...currentSeeks, seekObject]
  lastSeekedPosition = currentTime
  try {
    const res = await remuxer
      .seek(currentTime)
      .finally(() => {
        currentSeeks = currentSeeks.filter(s => s !== seekObject)
      })
    sourceBuffer.timestampOffset = res.pts
    await appendBuffer(res.data)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Cancelled') return
    console.error(err)
  }
  await unbuffer()
})

await appendBuffer((await remuxer.read()).data)

// ──────────────────────────────────────────────
// Thumbnail generation
// ──────────────────────────────────────────────

const thumbnailRemuxer = await createRemuxerInstance(contentLength)
const thumbnailHeader = await thumbnailRemuxer.init()

const thumbnailContainer = document.createElement('div')
document.body.appendChild(thumbnailContainer)
thumbnailContainer.style.display = 'flex'
thumbnailContainer.style.flexWrap = 'wrap'
thumbnailContainer.style.gap = '10px'

const thumbnails: HTMLImageElement[] = []

for (let i = 0; i < thumbnailHeader.indexes.length; i++) {
  const currentIndex = thumbnailHeader.indexes[i]
  if (!currentIndex) break

  const arrayBuffer = await thumbnailRemuxer.readKeyframe(currentIndex.timestamp)
  const thumbnailBlob = new Blob([arrayBuffer], { type: 'image/png' })

  const img = document.createElement('img')
  img.src = URL.createObjectURL(thumbnailBlob)
  thumbnailContainer.appendChild(img)
  thumbnails.push(img)
}
