import { createFile } from 'mp4box'

import { makeTransmuxer, SEEK_FLAG, SEEK_WHENCE_FLAG } from '.'
import PQueue from 'p-queue'
import pThrottle from 'p-throttle'

type Chunk = {
  offset: number
  buffer: Uint8Array
  pts: number
  duration: number
  pos: number
  buffered: boolean
}

fetch('../dist/spy13broke.mkv') // , { headers: { Range: 'bytes=0-100000000' } }
  .then(async ({ headers, body }) => {
    const contentLength = Number(headers.get('Content-Length'))
    const buffer = await new Response(body).arrayBuffer()

    let mp4boxfile = createFile()
    mp4boxfile.onError = e => console.error('onError', e)
    mp4boxfile.onSamples = (id, user, samples) => {
      // console.log('onSamples', id, user, samples)
      const groupBy = (xs, key) => {
        return xs.reduce((rv, x) => {
          (rv[x[key]] = rv[x[key]] || []).push(x)
          return rv
        }, []).filter(Boolean)
      }
      const groupedSamples = groupBy(samples, 'moof_number')
      for (const group of groupedSamples) {
        const firstSample = group[0]
        const lastSample = group.slice(-1)[0]
        console.log('mp4box sample', {
          firstSample,
          lastSample,
          keyframeIndex: firstSample.moof_number - 1,
          // id: firstSample.moof_number - 1,
          startTime: firstSample.cts / firstSample.timescale,
          endTime: firstSample.cts / firstSample.timescale === lastSample.cts / lastSample.timescale ? lastSample.cts / lastSample.timescale + 0.02 : lastSample.cts / lastSample.timescale,
          // start: firstSample.cts / firstSample.timescale,
          // end: lastSample.cts / lastSample.timescale,
          buffered: false
        })
        mp4boxfile.releaseUsedSamples(1, lastSample.number)
      }
    }

    let _resolveInfo
    const infoPromise = new Promise((resolve) => { _resolveInfo = resolve })

    let mime = 'video/mp4; codecs=\"'
    let info: string | undefined
    mp4boxfile.onReady = (_info) => {
      console.log('mp4box ready info', _info)
      info = _info
      for (let i = 0; i < info.tracks.length; i++) {
        if (i !== 0) mime += ','
        mime += info.tracks[i].codec
      }
      mime += '\"'
      mp4boxfile.setExtractionOptions(1, undefined, { nbSamples: 1000 })
      mp4boxfile.start()
      _resolveInfo(info)
    }

    let currentOffset = 0
    let mp4boxOffset = 0
    const chunks: Chunk[] = []

    const transmuxer = await makeTransmuxer({
      bufferSize: 1_000_000,
      sharedArrayBufferSize: 2_000_000,
      length: contentLength,
      read: async (offset, size) => {
        const buff = new Uint8Array(buffer.slice(Number(offset), offset + size))
        currentOffset = currentOffset + buff.byteLength
        return buff
      },
      seek: async (offset, whence) => {
        if (whence === SEEK_WHENCE_FLAG.SEEK_CUR) {
          currentOffset = currentOffset + offset
          return currentOffset;
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_END) {
          return -1;
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_SET) {
          currentOffset = offset
          return currentOffset;
        }
        if (whence === SEEK_WHENCE_FLAG.AVSEEK_SIZE) {
          return contentLength;
        }
        return -1
      },
      subtitle: (title, language, subtitle) => {
        // console.log('SUBTITLE HEADER', title, language, subtitle)
      },
      attachment: (filename: string, mimetype: string, buffer: Uint8Array) => {
        // console.log('attachment', filename, mimetype, buffer)
      },
      write: (offset, buffer, pts, duration, pos) => {
        console.log('receive write', offset, pts, duration, pos, new Uint8Array(buffer))
        if (!info) {
          console.log('writing init no info', mp4boxOffset)
          buffer.fileStart = mp4boxOffset
          mp4boxfile.appendBuffer(buffer)
          mp4boxOffset = mp4boxOffset + buffer.byteLength
        }
        chunks.push({
          offset,
          buffer: new Uint8Array(buffer),
          pts,
          duration,
          pos,
          buffered: false
        })
      }
    })
    console.log('mt transmuxer', transmuxer)

    await transmuxer.init()

    console.log('init finished')

    const duration = (await transmuxer.getInfo()).input.duration / 1_000_000

    await infoPromise

    console.log('DURATION', duration)

    const video = document.createElement('video')
    // video.autoplay = true
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
      console.error(ev.target.error)
    })
    document.body.appendChild(video)
    
    setTimeout(() => {
      video.play()
    }, 5_000)

    const mediaSource = new MediaSource()
    video.src = URL.createObjectURL(mediaSource)

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

    const appendBuffer = (buffer: ArrayBuffer) =>
      queue.add(() =>
        new Promise<Event>((resolve, reject) => {
          setupListeners(resolve, reject)
          sourceBuffer.appendBuffer(buffer)
        })
      )

    const appendChunk = async (chunk: Chunk) => {
      await appendBuffer(chunk.buffer.buffer)
      chunk.buffered = true
    }

    const removeChunk = async (chunk: Chunk) => {
      const chunkIndex = chunks.indexOf(chunk)
      if (chunkIndex === -1) throw new RangeError('No chunk found')
      chunks.slice(chunkIndex, 1)
    }

    const removeRange = ({ start, end, index }: { start: number, end: number, index: number }) =>
      queue.add(() =>
        new Promise((resolve, reject) => {
          setupListeners(resolve, reject)
          sourceBuffer.remove(
            Math.max(sourceBuffer.buffered.start(index), start),
            Math.min(sourceBuffer.buffered.end(index), end)
          )
        })
      )

    const PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS = 15
    const POST_SEEK_NEEDED_BUFFERS_IN_SECONDS = 30

    const throttle = pThrottle({
      limit: 1,
      interval: 1000
    })

    const seek = throttle(async (time: number) => {
      console.log('seeking')
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

      await transmuxer.seek(Math.max(0, time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS), SEEK_FLAG.NONE)
      processingQueue.start()
      await process()
      console.log('seeked')
    })

    const processingQueue = new PQueue({ concurrency: 1 })

    const process = async () => {
      await processingQueue.add(async () => {
        console.log('processing')
        await transmuxer.process(1_000_000)
        console.log('processed')
      })
    }

    const updateBuffers = async () => {
      console.log('updateBuffers', chunks)
      const { currentTime } = video
      const neededChunks =
        chunks
          .filter(({ pts, duration }) =>
            currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS < pts
            && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS > (pts + duration)
          )

      const nonNeededChunks =
        chunks
          .filter((chunk) => !neededChunks.includes(chunk))
      
      const bufferedRanges =
        getTimeRanges()
          .filter(({ start, end }) =>
              currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS > start && currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS > end ||
              currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS < start && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS < end
          )
      for (const nonNeededChunk of nonNeededChunks) {
        await removeChunk(nonNeededChunk)
      }
      for (const range of bufferedRanges) {
        await removeRange(range)
      }
      for (const chunk of neededChunks) {
        if (chunk.buffered) continue
        try {
          await appendChunk(chunk)
        } catch (err) {
          if (!(err instanceof Event)) throw err
          // if (err.message !== 'Failed to execute \'appendBuffer\' on \'SourceBuffer\': This SourceBuffer is still processing an \'appendBuffer\' or \'remove\' operation.') throw err
          break
        }
      }
    }

    await appendBuffer(chunks[0].buffer)

    setInterval(async () => {
      const { currentTime } = video
      await updateBuffers()
      const latestChunk = chunks.sort((chunk, chunk2) => chunk.pts - chunk2.pts).at(-1)
      if (!latestChunk || latestChunk.pts >= currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) return
      for (let i = 0; i < 5; i++) {
        await process()
      }
    }, 1_000)

    video.addEventListener('seeking', () => {
      seek(video.currentTime)
    })
    video.addEventListener('timeupdate', () => {
      // console.log('\n\n\n\n\n\n\n\n\ntimeupdate', video.currentTime)
      // myEfficientFn(...args)
    })

    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.seek(50000, SEEK_FLAG.NONE)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // setInterval(() => {
    //   console.log('process')
    //   transmuxer.process()
    // }, 5_000)
  })
