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
const VIDEO_URL = '../video2.mkv'

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

    const transmuxer = await makeTransmuxer({
      publicPath: '/dist/',
      workerPath: new URL('./worker/index.ts', import.meta.url).toString(),
      bufferSize: BUFFER_SIZE,
      sharedArrayBufferSize: BUFFER_SIZE + 1_000_000,
      length: contentLength,
      read: async (offset, size) =>
        fetch(
          VIDEO_URL,
          {
            headers: {
              Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}`
            }
          }
        )
          .then(res => res.arrayBuffer())
          .then(ab => new Uint8Array(ab)),
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
        // console.log('write', isHeader, offset, pts, duration, pos)
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
    video.playbackRate = 10

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
      await appendBuffer(chunk.buffer.buffer)
      chunk.buffered = true
    }

    
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

    const PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS = 5
    const POST_SEEK_NEEDED_BUFFERS_IN_SECONDS = 15
    const POST_SEEK_REMOVE_BUFFERS_IN_SECONDS = 60

    const processNeededBufferRange = queuedDebounceWithLastCall(0, async (upToTime: number = video.currentTime) => {
      console.log('processNeededBufferRange...', upToTime)
      let lastPts = chunks.sort(({ pts }, { pts: pts2 }) => pts - pts2).at(-1)?.pts
      while (lastPts === undefined || (lastPts < (upToTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS))) {
        console.log('processing...', upToTime, lastPts)
        const newChunks = await process()
        const lastProcessedChunk = newChunks.at(-1)
        console.log('processing 1', lastProcessedChunk, newChunks)
        if (!lastProcessedChunk) break
        lastPts = lastProcessedChunk.pts
      }
      console.log('processNeededBufferRange done')
    })

    const seek = queuedDebounceWithLastCall(500, async (time: number) => {
      console.log('SEEKING', time)
      const p = performance.now()
      const isPlaying = !video.paused
      if (isPlaying) video.pause()
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
      chunks = []
      await transmuxer.seek(Math.max(0, time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS))
      console.log('chunks', chunks)

      await process()
      await process()
      console.log('chunks', chunks)

      await processNeededBufferRange(time)
      await updateBufferedRanges()
      console.log('chunks', chunks)

      if (isPlaying) await video.play()

      await new Promise(resolve => setTimeout(resolve, 100))

      await processNeededBufferRange(time)
      await updateBufferedRanges()
      console.log('chunks', chunks)
      const p2 = performance.now()
      console.log('SEEK TIME:', p2 - p)
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

      for (const shouldBeUnbufferedChunk of shouldBeUnbufferedChunks) {
        await unbufferChunk(shouldBeUnbufferedChunk)
      }
      for (const nonNeededChunk of nonNeededChunks) {
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
    }

    // @ts-ignore
    await appendBuffer(headerChunk.buffer)

    await processNeededBufferRange()
    await updateBufferedRanges()

    video.addEventListener('seeking', () => {
      console.log('call seek')
      seek(video.currentTime)
    })

    video.addEventListener('timeupdate', queuedDebounceWithLastCall(200, async () => {
      console.log('timeupdate run')
      await processNeededBufferRange()
      await updateBufferedRanges()
    }))

    setTimeout(() => {
      video.play()
    }, 2_500)
  })
