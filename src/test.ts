// @ts-ignore
import PQueue from 'p-queue'

import { SEEK_WHENCE_FLAG, queuedDebounceWithLastCall } from './utils'
import { makeTransmuxer } from '.'

type Chunk = {
  offset: number
  buffer: Uint8Array
  pts: number
  duration: number
  pos: number
}

const BUFFER_SIZE = 5_000_000
const VIDEO_URL = '../video5.mkv'
// const VIDEO_URL = '../spidey.mkv'
const PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS = 10
const POST_SEEK_NEEDED_BUFFERS_IN_SECONDS = 30
const POST_SEEK_REMOVE_BUFFERS_IN_SECONDS = 60

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

    let headerChunk: Chunk
    let ended = false
    let chunks: Chunk[] = []

    const workerUrl2 = new URL('../build/worker.js', import.meta.url).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(workerUrl2)})`], { type: 'application/javascript' })
    const workerUrl = URL.createObjectURL(blob)

    const transmuxer = await makeTransmuxer({
      publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
      workerUrl,
      bufferSize: BUFFER_SIZE,
      length: contentLength,
      read: (offset, size) =>
        // console.log('read', offset, size) ||
        offset >= Math.min(offset + size, contentLength)
          ? Promise.resolve(new ArrayBuffer(0))
          : (
            fetch(
              VIDEO_URL,
              {
                headers: {
                  Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}`
                }
              }
            )
              .then(res => res.arrayBuffer())
          ),
      seek: async (currentOffset, offset, whence) => {
        // console.log('seek', { currentOffset, offset, whence })
        if (whence === SEEK_WHENCE_FLAG.SEEK_CUR) {
          return currentOffset + offset
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_END) {
          return -1
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_SET) {
          // little trick to prevent libav from requesting end of file data on init that might take a while to fetch
          // if (!initDone && offset > (contentLength - 1_000_000)) return -1
          return offset
        }
        if (whence === SEEK_WHENCE_FLAG.AVSEEK_SIZE) {
          return contentLength
        }
        return -1
      },
      subtitle: (title, language, subtitle) => {
        // console.log('SUBTITLE HEADER', title, language, subtitle)
      },
      attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => {
        // console.log('attachment', filename, mimetype, buffer)
      },
      write: ({ isHeader, offset, buffer, pts, duration: chunkDuration, pos }) => {
        // console.log('write', { isHeader, offset, buffer, pts, chunkDuration, pos })
        if (offset === contentLength) {
          const lastChunk = chunks.at(-1)
          if (!lastChunk) throw new Error('No last chunk found')
          chunks = [
            ...chunks,
            {
              offset,
              buffer: new Uint8Array(buffer),
              pts: lastChunk.pts + lastChunk.duration,
              duration: duration - lastChunk.pts,
              pos
            }
          ]
          ended = true
          // console.log('THATS A TRAILER CHUNK', chunks)
          return
        }
        if (isHeader) {
          if (!headerChunk) {
            headerChunk = {
              offset,
              buffer: new Uint8Array(buffer),
              pts,
              duration: chunkDuration,
              pos
            }
          }
          return
        }
        chunks = [
          ...chunks,
          {
            offset,
            buffer: new Uint8Array(buffer),
            pts,
            duration: chunkDuration,
            pos
          }
        ]
        // console.log('chunks', chunks)
        // if (chunks.length === 2) {
        //   const buffer =
        //     chunks
        //       .map(({ buffer }) => buffer)
        //       .reduce(
        //         (acc, buffer) =>  {
        //           const ab = new Uint8Array(acc.byteLength + buffer.byteLength)
        //           ab.set(new Uint8Array(acc), 0)
        //           ab.set(new Uint8Array(buffer), acc.byteLength)
        //           return ab
        //         },
        //         headerChunk.buffer
        //       )
        //       .buffer
        //   console.log('buffer', buffer)
        //   saveFile(
        //     buffer,
        //     'test.mp4',
        //     'video/mp4'
        //   )
        // }
      }
    })

    const processingQueue = new PQueue({ concurrency: 1 })

    const process = (timeToProcess = POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) =>
      processingQueue.add(
        () => ended ? Promise.resolve(undefined) : transmuxer.process(timeToProcess),
        { throwOnTimeout: true }
      )

    await transmuxer.init()

    // @ts-ignore
    if (!headerChunk) throw new Error('No header chunk found after transmuxer init')

    const mediaInfo = await transmuxer.getInfo()
    const duration = mediaInfo.input.duration / 1_000_000

    const video = document.createElement('video')
    video.width = 1440

    const allVideoEvents = [
      'abort',
      'canplay',
      'canplaythrough',
      'durationchange',
      'emptied',
      'encrypted',
      'ended',
      'error',
      'interruptbegin',
      'interruptend',
      'loadeddata',
      'loadedmetadata',
      'loadstart',
      'mozaudioavailable',
      'pause',
      'play',
      'playing',
      'progress',
      'ratechange',
      'seeked',
      'seeking',
      'stalled',
      'suspend',
      'timeupdate',
      'volumechange',
      'waiting'
    ]

    // for (const event of allVideoEvents) {
    //   video.addEventListener(event, ev => {
    //     console.log('video event', event, ev)
    //   })
    // }

    const seconds = document.createElement('div')
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
      // @ts-ignore
      console.error(ev.target?.error)
    })
    document.body.appendChild(video)
    document.body.appendChild(seconds)
    
    setInterval(() => {
      seconds.textContent = video.currentTime.toString()
    }, 100)

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

    // const bufferChunk = (chunk: Chunk) => appendBuffer(chunk.buffer.buffer)
    const bufferChunk = async (chunk: Chunk) => {
      // console.log('bufferChunk', getTimeRanges().map(range => `${range.start}-${range.end}`).join(' '), chunk)
      try {
        await appendBuffer(chunk.buffer.buffer)
      } catch (err) {
        console.error(err)
        throw err
      }
      // console.log('bufferedChunk', getTimeRanges().map(range => `${range.start}-${range.end}`).join(' '))
    }

    const getTimeRanges = () =>
      Array(sourceBuffer.buffered.length)
        .fill(undefined)
        .map((_, index) => ({
          index,
          start: sourceBuffer.buffered.start(index),
          end: sourceBuffer.buffered.end(index)
        }))

    const getTimeRange = (time: number) =>
      getTimeRanges()
        .find(({ start, end }) => time >= start && time <= end)
    
    const unbufferRange = async (start: number, end: number) =>
      queue.add(() =>
        new Promise((resolve, reject) => {
          setupListeners(resolve, reject)
          sourceBuffer.remove(start, end)
        })
      )
    
    const unbufferChunk = (chunk: Chunk) => unbufferRange(chunk.pts, chunk.pts + chunk.duration)

    const removeChunk = async (chunk: Chunk) => {
      const chunkIndex = chunks.indexOf(chunk)
      if (chunkIndex === -1) throw new RangeError('No chunk found')
      await unbufferChunk(chunk)
      // chunks = chunks.filter(_chunk => _chunk !== chunk)
    }

    // todo: add error checker & retry to seek a bit earlier
    const seek = queuedDebounceWithLastCall(500, async (time: number) => {
      ended = false
      const ranges = getTimeRanges()
      if (ranges.some(({ start, end }) => time >= start && time <= end)) {
        return
      }
      const allTasksDone = new Promise(resolve => {
        processingQueue.size && processingQueue.pending
          ? (
            processingQueue.on(
              'next',
              () =>
                processingQueue.pending === 0
                  ? resolve(undefined)
                  : undefined
            )
          )
          : resolve(undefined)
      })
      processingQueue.pause()
      processingQueue.clear()
      await allTasksDone
      processingQueue.start()

      const seekTime = Math.max(0, time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS)
      await transmuxer.seek(seekTime)
      await process(POST_SEEK_NEEDED_BUFFERS_IN_SECONDS + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS)
      for (const range of ranges) {
        await unbufferRange(range.start, range.end)
      }
      for (const chunk of chunks) {
        if (chunk.pts <= seekTime) continue
        await bufferChunk(chunk)
      }
      video.currentTime = time
    })

    const updateBufferedRanges = async (time: number) => {
      const ranges1 = getTimeRanges()
      // console.log('updateBufferedRanges', ranges1, chunks)
      const neededChunks =
        chunks
          .filter(({ pts, duration }) =>
            ((time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) < pts)
            && ((time + POST_SEEK_REMOVE_BUFFERS_IN_SECONDS) > (pts + duration))
          )

      const shouldBeBufferedChunks =
        neededChunks
          .filter(({ pts, duration }) =>
            ((time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) < pts)
            && ((time + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) > (pts + duration))
          )

      const shouldBeUnbufferedChunks =
        chunks
          .filter(({ pts, duration }) => ranges1.some(({ start, end }) => start < (pts + (duration / 2)) && (pts + (duration / 2)) < end))
          .filter((chunk) => !shouldBeBufferedChunks.includes(chunk))

      const nonNeededChunks =
        chunks
          .filter((chunk) => !neededChunks.includes(chunk))

      for (const shouldBeUnbufferedChunk of shouldBeUnbufferedChunks) {
        await unbufferChunk(shouldBeUnbufferedChunk)
      }
      for (const nonNeededChunk of nonNeededChunks) {
        await removeChunk(nonNeededChunk)
      }
      const firstChunk = neededChunks.sort(({ pts }, { pts: pts2 }) => pts - pts2).at(0)
      const lastChunk = neededChunks.sort(({ pts, duration }, { pts: pts2, duration: duration2 }) => (pts + duration) - (pts2 + duration2)).at(-1)
      
      // if (firstChunk && lastChunk) {
      //   console.log('firstChunk & lastChunk', firstChunk.pts, lastChunk.pts + lastChunk.duration)
      //   sourceBuffer.appendWindowStart = Math.max(time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS, 0)
      //   sourceBuffer.appendWindowEnd = Math.min(time + PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS, duration)
      // } else {
      //   sourceBuffer.appendWindowStart = 0
      //   sourceBuffer.appendWindowEnd = Infinity
      // }
      // console.log('shouldBeBufferedChunks', shouldBeBufferedChunks)
      for (const chunk of shouldBeBufferedChunks) {
        // if (chunk.buffered) continue
        try {
          // console.log('RANGES', getTimeRanges().map(({ start, end }) => `${start} - ${end}`))
          await bufferChunk(chunk)
          // console.log('RANGES 2', getTimeRanges().map(({ start, end }) => `${start} - ${end}`))
        } catch (err) {
          console.error(err)
          if (!(err instanceof Event)) throw err
          break
        }
      }

      const lowestAllowedStart =
        firstChunk
          ? Math.max(firstChunk?.pts - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS, 0)
          : undefined
      const highestAllowedEnd =
        lastChunk
          ? Math.min(lastChunk.pts + lastChunk.duration + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS, duration)
          : undefined
      const ranges = getTimeRanges()
      // console.log('ranges', ranges, lowestAllowedStart, highestAllowedEnd, neededChunks, chunks)
      for (const { start, end } of ranges) {
        if (!lowestAllowedStart || !highestAllowedEnd) continue
        // console.log('range', start, end)
        if (lowestAllowedStart !== undefined && start < lowestAllowedStart) {
          await unbufferRange(start, lowestAllowedStart)
        }
        if (highestAllowedEnd !== undefined && end > highestAllowedEnd) {
          await unbufferRange(highestAllowedEnd, end)
        }
      }
    }

    await appendBuffer(headerChunk.buffer)
    await new Promise(resolve => {
      video.addEventListener('loadedmetadata', () => resolve(undefined), { once: true })
    })

    // console.log('ranges', getTimeRanges())
    // console.groupCollapsed('process 30')
    await process(30)
    // console.groupEnd()
    await updateBufferedRanges(0)
    // console.log('ranges', getTimeRanges())

    // console.groupCollapsed('process 10')
    // await process(10)
    // console.groupEnd()

    // console.groupCollapsed('seek 30')
    // await transmuxer.seek(30)
    // console.groupEnd()
    // console.groupCollapsed('process 10')
    // await process(10)
    // console.groupEnd()
    // await updateBufferedRanges(0)

    // setInterval(() => {
    //   console.log('ranges', getTimeRanges())
    // }, 5_000)

    const timeUpdateWork = queuedDebounceWithLastCall(500, async (time: number) => {
      const lastChunk = chunks.sort(({ pts }, { pts: pts2 }) => pts - pts2).at(-1)
      if (lastChunk && lastChunk.pts < time + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) {
        await process()
      }
      await updateBufferedRanges(time)
    })

    video.addEventListener('timeupdate', () => {
      timeUpdateWork(video.currentTime)
    })

    video.addEventListener('canplaythrough', () => {
      video.playbackRate = 1
      video.play()
    }, { once: true })

    video.addEventListener('seeking', () => {
      // console.log('SEEKING', video.currentTime)
      seek(video.currentTime)
    })

    video.pause()
    await seek(1370)
    video.play()


    // video.currentTime = 1360
    // await new Promise(resolve => setTimeout(resolve, 1000))
    video.playbackRate = 5
  })
