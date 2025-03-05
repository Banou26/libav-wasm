import PQueue from 'p-queue'
import { queuedThrottleWithLastCall, toBufferedStream, toStreamChunkSize } from './utils'
import { makeRemuxer } from '.'

const BACKPRESSURE_STREAM_ENABLED = !navigator.userAgent.includes("Firefox")
const BUFFER_SIZE = 2_500_000
const VIDEO_URL = '../video.mkv'
// const VIDEO_URL = '../spidey.mkv'

export default async function saveFile(plaintext: ArrayBuffer, fileName: string, fileType: string) {
  return new Promise((resolve, reject) => {
    const dataView = new DataView(plaintext);
    const blob = new Blob([dataView], { type: fileType });

    // @ts-ignore
    if (navigator.msSaveBlob) {
    // @ts-ignore
      navigator.msSaveBlob(blob, fileName);
    // @ts-ignore
      return resolve();
    } else if (/iPhone|fxios/i.test(navigator.userAgent)) {
      // This method is much slower but createObjectURL
      // is buggy on iOS
      const reader = new FileReader();
      reader.addEventListener('loadend', () => {
        if (reader.error) {
          return reject(reader.error);
        }
        if (reader.result) {
          const a = document.createElement('a');
          // @ts-ignore
          a.href = reader.result;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
        }
        // @ts-ignore
        resolve();
      });
      reader.readAsDataURL(blob);
    } else {
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(downloadUrl);
      setTimeout(resolve, 100);
    }
  });
}



fetch(VIDEO_URL, { headers: { Range: `bytes=0-1` } })
  .then(async ({ headers, body }) => {
    if (!body) throw new Error('no body')
    const contentRangeContentLength = headers.get('Content-Range')?.split('/').at(1)
    const contentLength =
      contentRangeContentLength
        ? Number(contentRangeContentLength)
        : Number(headers.get('Content-Length'))

    const workerUrl2 = new URL('../build/worker.js', import.meta.url).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(workerUrl2)})`], { type: 'application/javascript' })
    const workerUrl = URL.createObjectURL(blob)

    const remuxer = await makeRemuxer({
      publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
      workerUrl,
      bufferSize: BUFFER_SIZE,
      length: contentLength,
      getStream: async (offset, size) => {
        return fetch(
          VIDEO_URL,
          {
            headers: {
              Range: `bytes=${offset}-${(size ? Math.min(offset + size, contentLength) - 1 : undefined) ?? (!BACKPRESSURE_STREAM_ENABLED ? Math.min(offset + BUFFER_SIZE, size!) : '')}`
            }
          }
        ).then(res =>
          size
            ? res.body!
            : (
              toBufferedStream(3)(
                toStreamChunkSize(BUFFER_SIZE)(
                  res.body!
                )
              )
            )
        )
      }
    })

    const header = await remuxer.init()
    console.log('header', header.indexes)

    const video = document.createElement('video')
    video.width = 1440

    const seconds = document.createElement('div')
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
      // @ts-expect-error
      console.error(ev.target?.error)
    })
    document.body.appendChild(video)
    document.body.appendChild(seconds)

    const mediaSource = new MediaSource()
    video.src = URL.createObjectURL(mediaSource)

    const sourceBuffer: SourceBuffer =
      await new Promise(resolve =>
        mediaSource.addEventListener(
          'sourceopen',
          () => {
            const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${header.info.input.videoMimeType},${header.info.input.audioMimeType}"`)
            mediaSource.duration = header.info.input.duration
            sourceBuffer.mode = 'segments'
            resolve(sourceBuffer)
          },
          { once: true }
        )
      )

    const setupListeners = (resolve: (value: Event) => void, reject: (reason: Event) => void) => {
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
      const unregisterListeners = () => {
        sourceBuffer.removeEventListener('updateend', updateEndListener)
        sourceBuffer.removeEventListener('abort', abortListener)
        sourceBuffer.removeEventListener('error', errorListener)
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
        new Promise((resolve, reject) => {
          setupListeners(resolve, reject)
          sourceBuffer.remove(start, end)
        })
      )

    await appendBuffer(header.data)
    
    const getTimeRanges = () =>
      Array(sourceBuffer.buffered.length)
        .fill(undefined)
        .map((_, index) => ({
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
          await unbufferRange(
            start,
            minTime
          )
        }
        if (end > maxTime) {
          await unbufferRange(
            maxTime,
            end
          )
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
      if (!timeRange) {
        return
      }
      const end = timeRange.end
      const maxTime = video.currentTime + BUFFER_TO
      if (end >= maxTime) {
        return
      }
      try {
        const p1 = performance.now()
        const res = await remuxer.read()
        console.log('read', performance.now() - p1)
        await appendBuffer(res.data)
        await unbuffer()
      } catch (err: any) {
        if (err.message === 'Cancelled') return
        console.error(err)
      }
    })
    // setInterval(loadMore, 100)

    // video.addEventListener('seeking', async () => {
    //   const { currentTime } = video
    //   const bufferedRanges = getTimeRanges()
    //   const timeRange = bufferedRanges.find(({ start, end }) => start <= currentTime && currentTime <= end)
    //   // seeking forward in a buffered range, can just continue by reading
    //   if (timeRange && currentTime >= lastSeekedPosition) {
    //     return
    //   }
    //   const seekObject = { currentTime }
    //   currentSeeks = [...currentSeeks, seekObject]
    //   lastSeekedPosition = currentTime
    //   try {
    //     const p1 = performance.now()
    //     const res =
    //       await remuxer
    //         .seek(currentTime)
    //         .finally(() => {
    //           currentSeeks = currentSeeks.filter(seekObj => seekObj !== seekObject)
    //         })
    //     console.log('seek', performance.now() - p1)
    //     sourceBuffer.timestampOffset = res.pts
    //     await appendBuffer(res.data)
    //   } catch (err: any) {
    //     if (err.message === 'Cancelled') return
    //     console.error(err)
    //   }
    //   await unbuffer()
    // })

    // await appendBuffer(
    //   (await remuxer.read()).data
    // )

    const thumbnailRatio = 16 / 9

    const thumbnailCanvas = document.createElement('canvas')
    const thumbnailCtx = thumbnailCanvas.getContext('2d')
    if (!thumbnailCtx) throw new Error('Could not get canvas context')
    thumbnailCanvas.width = thumbnailRatio * 200
    thumbnailCanvas.height = 200

    document.body.appendChild(thumbnailCanvas)

    const thumbnailContainer = document.createElement('div')
    document.body.appendChild(thumbnailContainer)
    thumbnailContainer.style.display = 'flex'
    thumbnailContainer.style.flexWrap = 'wrap'
    thumbnailContainer.style.gap = '10px'

    const thumbnails = []
    const readThumbnail = async () => {
      const currentIndex = header.indexes.at(thumbnails.length)
      if (!currentIndex) return

      console.log('thumbnail...', currentIndex.timestamp)

      const p1 = performance.now()
      const read = await remuxer.read()
      await appendBuffer(read.data)
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (video.readyState >= 2) {
            clearInterval(interval)
            resolve(undefined)
          }
        }, 10)
      })
      video.currentTime = currentIndex.timestamp
      await new Promise(resolve =>
        video.requestVideoFrameCallback(() => {
          resolve(undefined)
        })
      )
      thumbnailCtx.fillRect(0, 0, thumbnailCanvas.width, thumbnailCanvas.height)
      thumbnailCtx.drawImage(video, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height)
      const thumbnailData = thumbnailCanvas.toDataURL('image/png')
      console.log('thumbnail', performance.now() - p1)
      await unbufferRange(read.pts, read.pts + read.duration)

      // Create an image element to display the thumbnail
      const thumbnail = document.createElement('img')
      thumbnail.src = thumbnailData

      thumbnailContainer.appendChild(thumbnail)

      thumbnails.push(thumbnail)
    }

    setTimeout(async() => {
      while (true) {
        await readThumbnail()
        if (thumbnails.length >= header.indexes.length) break
      }
      // console.log('thumbnail done')
      // await readThumbnail(header.indexes[7].timestamp)
    }, 1_000)
  })
