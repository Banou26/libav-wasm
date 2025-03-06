import PQueue from 'p-queue'
import { queuedThrottleWithLastCall, toBufferedStream, toStreamChunkSize } from './utils'
import { makeRemuxer } from '.'
import { createFile, DataStream } from 'mp4box'
import type { MP4File } from './mp4box'

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

    const thumbnailContainer = document.createElement('div')
    document.body.appendChild(thumbnailContainer)
    thumbnailContainer.style.display = 'flex'
    thumbnailContainer.style.flexWrap = 'wrap'
    thumbnailContainer.style.gap = '10px'

    let info: any
    let samples: any

    const mp4boxfile = createFile() as MP4File

    mp4boxfile.onError = err => console.error(err)
    mp4boxfile.onReady = _info => {
      info = _info
      console.log(info)
      // mp4boxfile.onSegment = (...args) => {
      //   console.log('onSegment', args)
      // }
      // // mp4boxfile.setSegmentOptions(info.tracks[0].id, sb, options)  
      // var initSegs = mp4boxfile.initializeSegmentation()
      mp4boxfile.start()
    }
    // mp4boxfile.onSamples = _samples => {
    //   if (!samples) samples = _samples
    //   console.log('samples', samples)
    // }
    const headerBuffer = header.data
    // console.log('headerBuffer', headerBuffer)
    headerBuffer.fileStart = 0
    mp4boxfile.appendBuffer(headerBuffer)
    console.log(mp4boxfile)
    mp4boxfile.flush()

    // const track = info.videoTracks[0]
    // console.log('track', track)
    // mp4boxfile.setExtractionOptions(track.id)
    // mp4boxfile.start()


    const read = await remuxer.read()
    console.log('read', read)
    const readBuffer = read.data
    // readBuffer.fileStart = read.offset
    // console.log('readBuffer', readBuffer)
    // mp4boxfile.appendBuffer(readBuffer)

    // const read2 = await remuxer.read()
    // console.log('read2', read2)
    // const read2Buffer = read2.data
    // read2Buffer.fileStart = read2.offset
    // console.log('read2Buffer', read2Buffer)
    // mp4boxfile.appendBuffer(read2Buffer)
    // mp4boxfile.flush()

    // return

    // const track = mp4boxfile.getTrackById(1)
    const track = info.videoTracks[0];

    const toDescription = (track) => {
      const trak = mp4boxfile.getTrackById(track.id);
      console.log('trak', trak)
      for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        console.log('box', box)
        if (box) {
          const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
          box.write(stream);
          return new Uint8Array(stream.buffer, 8);  // Remove the box header.
        }
      }
      throw new Error("avcC, hvcC, vpcC, or av1C box not found");
    }


    const config = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedHeight: track.video.height,
      codedWidth: track.video.width,
      description: toDescription(track),
    }

    console.log('config', config)


    const videoDecoder = new VideoDecoder({
      output: (output) => {
        console.log('time: ', performance.now() - p1)
        console.log('videoFrame', output)
        videoFrameToImage(output)
      },
      error: (err) => {
        console.error(err)
      }
    })

    console.log('header', header)

    console.log(
      'isConfigSupported',
      await VideoDecoder.isConfigSupported(config)
    )

    videoDecoder.configure(config)

    function videoFrameToImage(frame) {
      // Create a canvas with the same dimensions as the frame
      const canvas = document.createElement('canvas');
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      const ctx = canvas.getContext('2d');
      
      // Draw the VideoFrame to the canvas
      ctx.drawImage(frame, 0, 0);
      
      // Create an image element
      const img = document.createElement('img');
      
      // Convert to data URL and set as src
      img.src = canvas.toDataURL('image/jpeg', 0.9); // Use jpeg for better compression

      document.body.appendChild(img);
      
      return img
    }

    const p1 = performance.now()
    videoDecoder.decode(new EncodedVideoChunk({
      type: "key",
      timestamp: read.pts,
      duration: read.duration,
      data: read.thumbnailData
    }))

    // for (const sample of samples) {
    //   videoDecoder.decode(new EncodedVideoChunk({
    //     type: sample.is_sync ? "key" : "delta",
    //     timestamp: 1e6 * sample.cts / sample.timescale,
    //     duration: 1e6 * sample.duration / sample.timescale,
    //     data: sample.data
    //   }))
    // }
    return

    const thumbnails = []
    const readThumbnail = async () => {
      const currentIndex = header.indexes.at(thumbnails.length)
      if (!currentIndex) return

      console.log('thumbnail...', currentIndex.timestamp)

      const p1 = performance.now()
      const read = await remuxer.read()
      await appendBuffer(read.data)
      const encodedVideoChunk = new EncodedVideoChunk({
        type: 'key',
        timestamp: read.pts,
        duration: read.duration,
        data: read.data
      })
      videoDecoder.decode(encodedVideoChunk)
      console.log('encodedVideoChunk', encodedVideoChunk)
      video.currentTime = currentIndex.timestamp
      console.log('thumbnail', performance.now() - p1)
      await unbufferRange(read.pts, read.pts + read.duration)

      // Create an image element to display the thumbnail
      const thumbnail = document.createElement('img')
      // thumbnail.src = thumbnailData

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
