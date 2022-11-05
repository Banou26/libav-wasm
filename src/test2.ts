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
// , { headers: { Range: 'bytes=0-200000000' } }

fetch('../dist/spy13broke.mkv') // , { headers: { Range: 'bytes=0-100000000' } }
  .then(async ({ headers, body }) => {
    const contentLength = Number(headers.get('Content-Length'))
    const buffer = await new Response(body).arrayBuffer()

    let mp4boxfile = createFile()
    mp4boxfile.onError = (error: Error) => console.error('mp4box error', error)

    let _resolveInfo: (value: unknown) => void
    const infoPromise = new Promise((resolve) => { _resolveInfo = resolve })

    let mime = 'video/mp4; codecs=\"'
    let info: any | undefined
    mp4boxfile.onReady = (_info) => {
      console.log('mp4box ready info', _info)
      info = _info
      for (let i = 0; i < info.tracks.length; i++) {
        if (i !== 0) mime += ','
        mime += info.tracks[i].codec
      }
      mime += '\"'
      _resolveInfo(info)
    }

    let currentOffset = 0
    let headerBuffer: Uint8Array | undefined
    let headerChunk: Chunk
    let chunks: Chunk[] = []

    const transmuxer = await makeTransmuxer({
      bufferSize: 4_000_000,
      sharedArrayBufferSize: 5_000_000,
      length: contentLength,
      read: async (offset, size) => {
        const buff = new Uint8Array(buffer.slice(Number(offset), offset + size))
        currentOffset = currentOffset + buff.byteLength
        console.log('read', offset, size, buff)
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
      write: ({ isHeader, offset, buffer, pts, duration, pos }) => {
        console.log('receive write', isHeader, offset, pts, duration, pos, new Uint8Array(buffer))
        if (!info && isHeader) {
          if (!headerBuffer) {
            headerBuffer = buffer
          } else {
            const _headerBuffer = headerBuffer
            headerBuffer = new Uint8Array(headerBuffer.byteLength + buffer.byteLength)
            headerBuffer.set(_headerBuffer)
            headerBuffer.set(buffer, _headerBuffer.byteLength)
          }
          if (headerChunk) headerChunk.buffer = headerBuffer
        }
        if (!headerChunk && isHeader) {
          headerChunk = {
            offset,
            buffer: new Uint8Array(buffer),
            pts,
            duration,
            pos,
            buffered: false
          }
        }
        if (!isHeader) {
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
          // chunks.push({
          //   offset,
          //   buffer: new Uint8Array(buffer),
          //   pts,
          //   duration,
          //   pos,
          //   buffered: false
          // })
        }
      }
    })
    console.log('mt transmuxer', transmuxer)

    await transmuxer.init()

    console.log('init finished')

    if (!headerBuffer) throw new Error('No header buffer found after transmuxer init')

    headerBuffer.buffer.fileStart = 0
    console.log('APPEND MP4BOX', buffer)
    mp4boxfile.appendBuffer(headerBuffer.buffer)

    const duration = (await transmuxer.getInfo()).input.duration / 1_000_000

    await infoPromise

    console.log('DURATION', duration)

    const video = document.createElement('video')
    const seconds = document.createElement('div')
    // video.autoplay = true
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
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
      chunk.buffered = false
      chunks = chunks.filter(_chunk => _chunk !== chunk)
      // chunks.splice(chunkIndex, 1)
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
    const POST_SEEK_REMOVE_BUFFERS_IN_SECONDS = 60

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

      const latestChunk = chunks.sort((chunk, chunk2) => chunk.pts - chunk2.pts).at(-1)
      console.log('seeking pts time', latestChunk?.pts, time, (latestChunk?.pts ?? 0) > time)
      if ((latestChunk?.pts ?? 0) > time) currentOffset = 0
      await transmuxer.seek(
        Math.max(0, time - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) * 1000,
        (latestChunk?.pts ?? 0) > time
          ? SEEK_FLAG.AVSEEK_FLAG_BACKWARD
          : SEEK_FLAG.NONE
      )
      processingQueue.start()
      console.group('Processing call')
      for (let i = 0; i < 5; i++) {
        await process()
      }
      console.groupEnd()
      const bufferedRanges = getTimeRanges()
      for (const range of bufferedRanges) {
        await removeRange(range)
      }
      await updateBuffers()
      console.log('seeked pts time', latestChunk?.pts, time, (latestChunk?.pts ?? 0) > time)
    })

    const processingQueue = new PQueue({ concurrency: 1 })

    const process = async () => {
      await processingQueue.add(async () => {
        await transmuxer.process(1_000_000)
      })
    }

    const updateBuffers = async () => {
      console.log('updateBuffers', chunks)
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

      const nonNeededChunks =
        chunks
          .filter((chunk) => !neededChunks.includes(chunk))
      
      const bufferedRanges =
        getTimeRanges()
          .filter(({ start, end }) =>
              ((currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) > start) && ((currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS) > end) ||
              ((currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) < start) && ((currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS) < end)
          )

      
      console.log('neededChunks', neededChunks)
      console.log('nonNeededChunks', nonNeededChunks)
      console.log('bufferedRanges', bufferedRanges)
      for (const nonNeededChunk of nonNeededChunks) {
        await removeChunk(nonNeededChunk)
      }
      for (const range of bufferedRanges) {
        await removeRange(range)
      }
      for (const chunk of shouldBeBufferedChunks) {
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

    // @ts-ignore
    await appendBuffer(headerChunk.buffer)


    let previousTime = -1
    setInterval(async () => {
      const { currentTime } = video
      if (previousTime === currentTime) return
      previousTime = currentTime
      await updateBuffers()
      const latestChunk = chunks.sort((chunk, chunk2) => chunk.pts - chunk2.pts).at(-1)
      console.log('latestChunk', latestChunk, currentTime)
      if (latestChunk && (latestChunk.pts >= (currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS))) return
      console.group('Processing call')
      for (let i = 0; i < 5; i++) {
        await process()
      }
      console.groupEnd()
      await updateBuffers()
    }, 500)


    video.addEventListener('seeking', () => {
      seek(video.currentTime)
    })
    video.addEventListener('timeupdate', () => {
      // console.log('\n\n\n\n\n\n\n\n\ntimeupdate', video.currentTime)
      // myEfficientFn(...args)
    })


    

    setTimeout(() => {
      video.play()

      setTimeout(() => {
        video.pause()

        setTimeout(() => {
          video.currentTime = 500

          setTimeout(() => {
            video.currentTime = 1000
            setTimeout(() => {
              video.currentTime = 500
              // setTimeout(() => {
              //   video.currentTime = 750
              // }, 2_500)
            }, 2_500)
          }, 2_500)
        }, 2_500)
      }, 2_500)


    }, 2_500)


    // await new Promise(resolve => setTimeout(resolve, 2000))
    // for (let i = 0; i < 10; i++) {
    //   await process()
    // }
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // for (let i = 0; i < 10; i++) {
    //   await process()
    // }
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // await seek(50)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // for (let i = 0; i < 10; i++) {
    //   await process()
    // }
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // for (let i = 0; i < 10; i++) {
    //   await process()
    // }
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // for (let i = 0; i < 10; i++) {
    //   await process()
    // }
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // for (let i = 0; i < 10; i++) {
    //   await process()
    // }

    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.process(4_000_000)
    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.process(4_000_000)
    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.seek(100_000, SEEK_FLAG.NONE)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(4_000_000)
    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.process(4_000_000)
    // transmuxer.seek(30_000, SEEK_FLAG.AVSEEK_FLAG_BACKWARD)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(4_000_000)
    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.process(4_000_000)
    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.process(4_000_000)
    // await new Promise(resolve => setTimeout(resolve, 1000))
    // transmuxer.process(4_000_000)
    // setInterval(() => {
    //   console.log('process')
    //   transmuxer.process()
    // }, 5_000)
  })
