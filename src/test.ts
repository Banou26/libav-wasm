// @ts-ignore
import { createFile } from 'mp4box'
import PQueue from 'p-queue'

import { SEEK_WHENCE_FLAG, queuedDebounceWithLastCall } from './utils'
import { makeTransmuxer } from '.'
import { MP4Info } from './mp4box'

type Chunk = {
  offset: number
  buffer: Uint8Array
  pts: number
  duration: number
  pos: number
  buffered: boolean
}

const BUFFER_SIZE = 5_000_000
const VIDEO_URL = '../video3.mkv'

fetch(VIDEO_URL, { headers: { Range: `bytes=0-1` } })
  .then(async ({ headers, body }) => {
    if (!body) throw new Error('no body')
    const contentRangeContentLength = headers.get('Content-Range')?.split('/').at(1)
    const contentLength =
      contentRangeContentLength
        ? Number(contentRangeContentLength)
        : Number(headers.get('Content-Length'))

    let mp4boxfile = createFile()
    mp4boxfile.onError = (error: Error) => console.error('mp4box error', error)

    let _resolveInfo: (value: unknown) => void
    const infoPromise = new Promise((resolve) => { _resolveInfo = resolve })

    let mime = 'video/mp4; codecs=\"'
    let info: any | undefined
    mp4boxfile.onReady = (_info: MP4Info) => {
      info = _info
      for (let i = 0; i < info.tracks.length; i++) {
        if (i !== 0) mime += ','
        mime += info.tracks[i].codec
      }
      mime += '\"'
      _resolveInfo(info)
    }

    let headerChunk: Chunk
    let chunks: Chunk[] = []
    let initDone = false

    const workerUrl2 = new URL('../build/worker.js', import.meta.url).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(workerUrl2)})`], { type: 'application/javascript' })
    const workerUrl = URL.createObjectURL(blob)

    const transmuxer = await makeTransmuxer({
      publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
      workerUrl,
      bufferSize: BUFFER_SIZE,
      length: contentLength,
      read: async (offset, size) =>
        console.log('read', offset, size) ||
        fetch(
          VIDEO_URL,
          {
            headers: {
              Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}`
            }
          }
        )
          .then(res => res.arrayBuffer()),
      seek: async (currentOffset, offset, whence) => {
        if (whence === SEEK_WHENCE_FLAG.SEEK_CUR) {
          return currentOffset + offset;
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_END) {
          return -1
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_SET) {
          // little trick to prevent libav from requesting end of file data on init that might take a while to fetch
          if (!initDone && offset > (contentLength - 1_000_000)) return -1
          return offset;
        }
        if (whence === SEEK_WHENCE_FLAG.AVSEEK_SIZE) {
          return contentLength;
        }
        return -1
      },
      subtitle: (title, language, subtitle) => {
        // console.log('SUBTITLE HEADER', title, language, subtitle)
      },
      attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => {
        // console.log('attachment', filename, mimetype, buffer)
      },
      write: ({ isHeader, offset, buffer, pts, duration, pos }) => {
        console.log('write', { isHeader, offset, buffer, pts, duration, pos })
        if (isHeader) {
          if (!headerChunk) {
            headerChunk = {
              offset,
              buffer: new Uint8Array(buffer),
              pts,
              duration,
              pos,
              buffered: false
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
            duration,
            pos,
            buffered: false
          }
        ]
      }
    })

    await transmuxer.init()
    initDone = true

    // @ts-ignore
    if (!headerChunk) throw new Error('No header chunk found after transmuxer init')

    // @ts-ignore
    headerChunk.buffer.buffer.fileStart = 0
    mp4boxfile.appendBuffer(headerChunk.buffer.buffer)

    const duration = (await transmuxer.getInfo()).input.duration / 1_000_000

    await infoPromise

    const video = document.createElement('video')

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

    for (const event of allVideoEvents) {
      video.addEventListener(event, ev => {
        console.log('video event', event, ev)
      })
    }

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
    // video.playbackRate = 10

    const sourceBuffer: SourceBuffer =
      await new Promise(resolve =>
        mediaSource.addEventListener(
          'sourceopen',
          () => resolve(mediaSource.addSourceBuffer(mime)),
          { once: true }
        )
      )

    mediaSource.duration = duration
    sourceBuffer.mode = 'segments'

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
        reject(ev),
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

    const bufferChunk = async (chunk: Chunk) => {
      console.log('buffering chunk', chunk)
      await appendBuffer(chunk.buffer.buffer)
      chunk.buffered = true
    }

    console.log('sourceBuffer', sourceBuffer)

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
    
    const unbufferChunk = async (chunk: Chunk) =>
      queue.add(() =>
        new Promise((resolve, reject) => {
          setupListeners(resolve, reject)

          const chunkIndex = chunks.indexOf(chunk)
          if (chunkIndex === -1) return reject('No chunk found')
          sourceBuffer.remove(chunk.pts, chunk.pts + chunk.duration)
          chunk.buffered = false
        })
      )

    const removeChunk = async (chunk: Chunk) => {
      const chunkIndex = chunks.indexOf(chunk)
      if (chunkIndex === -1) throw new RangeError('No chunk found')
      await unbufferChunk(chunk)
      chunks = chunks.filter(_chunk => _chunk !== chunk)
    }

    const PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS = 15
    const POST_SEEK_NEEDED_BUFFERS_IN_SECONDS = 25
    const POST_SEEK_REMOVE_BUFFERS_IN_SECONDS = 60

    const processNeededBufferRange = queuedDebounceWithLastCall(0, async (maxPts?: number) => {
      const currentTime = video.currentTime
      let lastPts = chunks.sort(({ pts }, { pts: pts2 }) => pts - pts2).at(-1)?.pts
      while (
        (maxPts === undefined ? true : (lastPts ?? 0) < maxPts)
        && (lastPts === undefined || (lastPts < (currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS)))
      ) {
        const newChunks = await process()
        const lastProcessedChunk = newChunks.at(-1)
        if (!lastProcessedChunk && ((lastPts ?? 0) + 10) >= duration) break
        if (lastProcessedChunk) {
          lastPts = lastProcessedChunk.pts
        }
      }
    })

    // todo: add error checker & retry to seek a bit earlier
    const seek = queuedDebounceWithLastCall(500, async (time: number, shouldResume = false) => {
      // await new Promise((resolve, reject) => {
      //   const unregisterListeners = () => {
      //     video.removeEventListener('seeked', seekedListener)
      //     video.removeEventListener('error', errorListener)
      //   }
      //   const seekedListener = () => {
      //     unregisterListeners()
      //     resolve(undefined)
      //   }
      //   const errorListener = (ev: Event) => {
      //     unregisterListeners()
      //     reject(ev)
      //   }
      //   video.addEventListener('seeked', seekedListener, { once: true })
      //   video.addEventListener('error', errorListener, { once: true })
      // })
      console.log('SEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEK', time)
      const ranges = getTimeRanges()
      if (ranges.some(({ start, end }) => time >= start && time <= end)) {
        return
      }
      for (const range of ranges) {
        await unbufferRange(range.start, range.end)
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
      if (seekTime > POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) {
        chunks = []
        await transmuxer.seek(seekTime)
      } else {
        chunks = []
        await transmuxer.destroy()
        await transmuxer.init()
        await process()
        await process()
      }

      await new Promise(resolve => setTimeout(resolve, 0))

      await processNeededBufferRange(time + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS)
      await updateBufferedRanges()
      
      mediaSource.duration = duration

      await new Promise((resolve, reject) => {
        video.addEventListener('canplaythrough', async (event) => {
          if (shouldResume) await video.play()
          resolve(undefined)
        }, { once: true })
        setTimeout(() => {
          reject('timeout')
        }, 1_000)
      })

      // if (isPlaying) await video.play()
      // setTimeout(async () => {
      //   console.log('SEEK FIX CHECK', time, video.currentTime)
      //   if (!video.paused) return
      //   video.currentTime = time + 0.01
      //   console.log('APPLY SEEK FIX')
      //   if (isPlaying) await video.play()
      // }, 100)
    })

    const processingQueue = new PQueue({ concurrency: 1 })

    const process = () =>
      processingQueue.add(() =>
        transmuxer.process(BUFFER_SIZE)
      )

    const updateBufferedRanges = async () => {
      const { currentTime } = video
      const neededChunks =
        chunks
          .filter(({ pts, duration }) =>
            ((currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) < pts)
            && ((currentTime + POST_SEEK_REMOVE_BUFFERS_IN_SECONDS) > (pts + duration))
          )

      const shouldBeBufferedChunks =
        neededChunks
          .filter(({ pts, duration }) =>
            ((currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) < pts)
            && ((currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) > (pts + duration))
          )

      const shouldBeUnbufferedChunks = 
        chunks
          .filter(({ buffered }) => buffered)
          .filter((chunk) => !shouldBeBufferedChunks.includes(chunk))

      const nonNeededChunks =
        chunks
          .filter((chunk) => !neededChunks.includes(chunk))

      // console.log('updateBufferedRanges', chunks, neededChunks, getTimeRanges(), nonNeededChunks, shouldBeUnbufferedChunks)

      for (const shouldBeUnbufferedChunk of shouldBeUnbufferedChunks) {
        await unbufferChunk(shouldBeUnbufferedChunk)
      }
      for (const nonNeededChunk of nonNeededChunks) {
        // if (nonNeededChunk.buffered) await unbufferChunk(nonNeededChunk)
        await removeChunk(nonNeededChunk)
      }
      for (const chunk of shouldBeBufferedChunks) {
        if (chunk.buffered) continue
        try {
          await bufferChunk(chunk)
        } catch (err) {
          if (!(err instanceof Event)) throw err
          break
        }
      }
      const firstChunk = neededChunks.sort(({ pts }, { pts: pts2 }) => pts - pts2).at(0)
      const lastChunk = neededChunks.sort(({ pts, duration }, { pts: pts2, duration: duration2 }) => (pts + duration) - (pts2 + duration2)).at(-1)
      const lowestAllowedStart =
        firstChunk
          ? Math.max(firstChunk?.pts - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS, 0)
          : undefined
      const highestAllowedEnd =
        lastChunk
          ? Math.min(lastChunk.pts + lastChunk.duration + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS, duration)
          : undefined
      const ranges = getTimeRanges()
      console.log('ranges', ranges, lowestAllowedStart, highestAllowedEnd, neededChunks, chunks)
      for (const { start, end } of ranges) {
        if (!lowestAllowedStart || !highestAllowedEnd) continue
        if (lowestAllowedStart !== undefined && start < lowestAllowedStart) {
          await unbufferRange(start, lowestAllowedStart)
        }
        if (highestAllowedEnd !== undefined && end > highestAllowedEnd) {
          await unbufferRange(highestAllowedEnd, end)
        }
      }
    }

    // @ts-ignore
    await appendBuffer(headerChunk.buffer)

    await processNeededBufferRange()
    await updateBufferedRanges()

    video.addEventListener('seeking', () => {
      const isPlaying = !video.paused
      video.pause()
      seek(video.currentTime, isPlaying)
    })

    const timeUpdateWork = queuedDebounceWithLastCall(500, async (time: number) => {
      await processNeededBufferRange(time + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS)
      await updateBufferedRanges()
    })

    video.addEventListener('timeupdate', () => {
      timeUpdateWork(video.currentTime)
    })
    
    setInterval(() => {
      // console.log('chunks', chunks)
      console.log('timeRanges', getTimeRanges())
    }, 1_000)

    video.addEventListener('canplaythrough', () => {
      video.playbackRate = 1
      video.play()
    }, { once: true })

    // setTimeout(() => {
    //   video.play()
    //   video.playbackRate = 1
    //   // setTimeout(() => {
    //   //   video.currentTime = 10
    //   //   setTimeout(() => {
    //   //     video.currentTime = 15
    //   //   }, 1_000)
    //   // }, 1_000)

    //   // setTimeout(() => {
    //   //   video.pause()
    //   //   setTimeout(() => {
    //   //     video.currentTime = 600
    //   //     // video.currentTime = 300
    //   //     setTimeout(() => {
    //   //       video.currentTime = 10
    //   //       // video.currentTime = 300
    //   //       // video.play()
    //   //     }, 5_000)
    //   //   }, 2_500)
    //   // }, 2_500)
    // }, 1_000)
  })
