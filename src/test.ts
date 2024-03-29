// @ts-ignore
import PQueue from 'p-queue'

import { debounceImmediateAndLatest, queuedDebounceWithLastCall, toBufferedStream, toStreamChunkSize } from './utils'
import { makeRemuxer } from '.'

type Chunk = {
  offset: number
  buffer: Uint8Array
  pts: number
  duration: number
  pos: number
}

const BACKPRESSURE_STREAM_ENABLED = !navigator.userAgent.includes("Firefox")
const BUFFER_SIZE = 2_500_000
const VIDEO_URL = '../video12.mkv'
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

    // let headerChunk: Chunk
    let ended = false

    const workerUrl2 = new URL('../build/worker.js', import.meta.url).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(workerUrl2)})`], { type: 'application/javascript' })
    const workerUrl = URL.createObjectURL(blob)

    let slow = false

    const remuxer = await makeRemuxer({
      publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
      workerUrl,
      bufferSize: BUFFER_SIZE,
      length: contentLength,
      getStream: async (offset, size) => {
        // if (slow && size !== BUFFER_SIZE) {
        //   await new Promise(resolve => setTimeout(resolve, 5000))
        // }

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
      },
      subtitle: (title, language, subtitle) => {
        // console.log('SUBTITLE HEADER', title, language, subtitle)
      },
      attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => {
        // console.log('attachment', filename, mimetype, buffer)
      }
    })

    const headerChunk = await remuxer.init()

    if (!headerChunk) throw new Error('No header chunk found after remuxer init')

    const mediaInfo = await remuxer.getInfo()
    const duration = mediaInfo.input.duration / 1_000_000

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
            const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${mediaInfo.input.video_mime_type},${mediaInfo.input.audio_mime_type}"`)
            mediaSource.duration = duration
            sourceBuffer.mode = 'segments'
            resolve(sourceBuffer)
          },
          { once: true }
        )
      )

    const queue = new PQueue({ concurrency: 1 })

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

    const getTimeRanges = () =>
      Array(sourceBuffer.buffered.length)
        .fill(undefined)
        .map((_, index) => ({
          index,
          start: sourceBuffer.buffered.start(index),
          end: sourceBuffer.buffered.end(index)
        }))

    video.addEventListener('canplaythrough', () => {
      video.playbackRate = 1
      video.play()
    }, { once: true })

    let chunks: Chunk[] = []

    const PREVIOUS_BUFFER_COUNT = 1
    const NEEDED_TIME_IN_SECONDS = 15

    await appendBuffer(headerChunk.buffer)

    let reachedEnd = false

    const pull = async () => {
      if (reachedEnd) throw new Error('end')
      const chunk = await remuxer.read()
      if (chunk.isTrailer) reachedEnd = true
      chunks = [...chunks, chunk]
      return chunk
    }

    let seeking = false

    const updateBuffers = queuedDebounceWithLastCall(250, async () => {
      if (seeking) return
      const { currentTime } = video
      const currentChunkIndex = chunks.findIndex(({ pts, duration }) => pts <= currentTime && pts + duration >= currentTime)
      const sliceIndex = Math.max(0, currentChunkIndex - PREVIOUS_BUFFER_COUNT)

      const getLastChunkEndTime = () => {
        const lastChunk = chunks.at(-1)
        if (!lastChunk) return 0
        return lastChunk.pts + lastChunk.duration
      }

      // pull and append buffers up until the needed time
      while (getLastChunkEndTime() < currentTime + NEEDED_TIME_IN_SECONDS){
        const chunk = await pull()
        await appendBuffer(chunk.buffer)
      }

      if (sliceIndex) chunks = chunks.slice(sliceIndex)

      const bufferedRanges = getTimeRanges()

      const firstChunk = chunks.at(0)
      const lastChunk = chunks.at(-1)
      if (!firstChunk || !lastChunk || firstChunk === lastChunk) return
      const minTime = firstChunk.pts

      for (const { start, end } of bufferedRanges) {
        const chunkIndex = chunks.findIndex(({ pts, duration }) => start <= (pts + (duration / 2)) && (pts + (duration / 2)) <= end)
        if (chunkIndex === -1) {
          await unbufferRange(start, end)
        } else {
          if (start < minTime) {
            await unbufferRange(
              start,
              minTime
            )
          }
        }
      }
    })

    let firstSeekPaused: boolean | undefined

    const seek = debounceImmediateAndLatest(250, async (seekTime: number) => {
      try {
        reachedEnd = false
        if (firstSeekPaused === undefined) firstSeekPaused = video.paused
        seeking = true
        chunks = []
        await remuxer.seek(seekTime)
        const chunk1 = await pull()
        // todo: FIX firefox sometimes throws "Uncaught (in promise) DOMException: An attempt was made to use an object that is not, or is no longer, usable"
        sourceBuffer.timestampOffset = chunk1.pts
        await appendBuffer(chunk1.buffer)
        if (firstSeekPaused === false) {
          await video.play()
        }
        seeking = false
        await updateBuffers()
        if (firstSeekPaused === false) {
          await video.play()
        }
        firstSeekPaused = undefined
      } catch (err: any) {
        if (err.message !== 'exit') throw err
      }
    })

    const firstChunk = await pull()
    appendBuffer(firstChunk.buffer)

    video.addEventListener('timeupdate', () => {
      updateBuffers()
    })

    video.addEventListener('waiting', () => {
      updateBuffers()
    })

    video.addEventListener('seeking', (ev) => {
      seek(video.currentTime)
    })

    updateBuffers()

    setInterval(() => {
      seconds.textContent = video.currentTime.toString()
    }, 100)

    setTimeout(async () => {
      video.playbackRate = 1
      video.currentTime = 290

      // slow = true
      // video.currentTime = 400
      // await new Promise(resolve => setTimeout(resolve, 1000))
      // slow = false
      // video.currentTime = 300
    }, 2_000)
  })
