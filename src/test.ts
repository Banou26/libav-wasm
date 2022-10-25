import { createFile } from 'mp4box'
import { Readable, Transform } from 'stream'
import { EbmlStreamDecoder, EbmlTagId } from 'ebml-stream'
import JMuxer from 'jmuxer'
// const {  } = Stream
// import * as libav from '../dist/libav'

// console.log('libav', libav)

import { Buffer } from 'buffer'

interface Chunk {
  arrayBuffer: ArrayBuffer
  keyframeIndex: number
  // id: number
  startTime: number
  endTime: number
  // start: number
  // end: number
  buffered: boolean
}

const BUFFER_SIZE = 1_500_000 // 6_000_000 / 2
const PUSH_ARRAY_SIZE = BUFFER_SIZE * 2 // 10_000_000

let libavInstance

/** https://ffmpeg.org/doxygen/trunk/avformat_8h.html#ac736f8f4afc930ca1cda0b43638cc678 */
enum SEEK_FLAG {
  NONE = 0,
  /** seek backward */
  AVSEEK_FLAG_BACKWARD = 1 << 0,
  /** seeking based on position in bytes */
  AVSEEK_FLAG_BYTE = 1 << 1,
  /** seek to any frame, even non-keyframes */
  AVSEEK_FLAG_ANY = 1 << 2,
  /** seeking based on frame number */
  AVSEEK_FLAG_FRAME = 1 << 3
}

enum SEEK_WHENCE_FLAG {
  SEEK_SET = 0,
  SEEK_CUR = 1 << 0,
  SEEK_END = 1 << 1,
  AVSEEK_SIZE = 1 << 16 //0x10000,
}

function equal (buf1, buf2)
{
    if (buf1.byteLength != buf2.byteLength) {
      console.log('wrong byteLength value', buf1.byteLength, buf2.byteLength)
      return false;
    }
    var dv1 = new Int8Array(buf1);
    var dv2 = new Int8Array(buf2);
    for (var i = 0 ; i != buf1.byteLength ; i++)
    {
      
        if (dv1[i] != dv2[i]) {
          console.log('wrong value at offset', i)
          return false;
        }
    }
    return true;
}


var _appendBuffer = function(buffer1, buffer2) {
  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
};

// function readableDefaultStreamToReadableByteStream(stream: ReadableStream<Uint8Array>, DEFAULT_CHUNK_SIZE = BUFFER_SIZE) {
//   let reader: ReadableStreamReader<Uint8Array> = stream.getReader()
//   return new ReadableStream({
//     type: 'bytes',
//     start(controller) {
//       console.log('controller', controller.desiredSize)
//     },
//     async pull(controller) {
//       let position = 0
//       let bufferLeft
//       const view = controller.byobRequest.view as unknown as DataView;
//       const buffer = view.buffer
//       while (position !== DEFAULT_CHUNK_SIZE) {
//         const { value, done } = await reader.read()

//         if (done) {
//           controller.close()
//           if (bufferLeft) {
//             controller.byobRequest.respond(bufferLeft.byteLength)
//           }
//           controller.byobRequest.respond(0)
//         } else {
//           const neededLength = position - Math.min(position + value.byteLength, DEFAULT_CHUNK_SIZE)
//           view.
//           buffer.set(value.slice(0, neededLength))
//           if (value.byteLength > bufferLeft) bufferLeft = value.slice(bufferLeft)
//           else bufferLeft = undefined
//           position = position + neededLength
//         }
//       }
//       controller.byobRequest.respond(buffer.byteLength)
//     },
//     cancel(reason) {
//       return stream.cancel(reason)
//     },
//     autoAllocateChunkSize: DEFAULT_CHUNK_SIZE
//   })
// }

// todo: update types once typescript supports bytestreams again https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1362
// todo: make this a BYOB stream to improve perf
function bufferStreamChunksToSize(stream: ReadableStream<Uint8Array>, DEFAULT_CHUNK_SIZE = PUSH_ARRAY_SIZE) {
  let reader: ReadableStreamReader<Uint8Array> = stream.getReader()
  let bufferLeft: Uint8Array | undefined
  return new ReadableStream({
    async pull(controller) {
      let position = 0
      const buffer = new Uint8Array(DEFAULT_CHUNK_SIZE)
      if (bufferLeft) {
        buffer.set(bufferLeft, 0)
        position = position + bufferLeft.byteLength
        bufferLeft = undefined
      }
      while (position !== DEFAULT_CHUNK_SIZE) {
        const { value, done } = await reader.read()
        if (done) {
          if (bufferLeft) controller.enqueue(bufferLeft)
          controller.close()
        } else {
          const neededLength = Math.min(DEFAULT_CHUNK_SIZE - position, value.byteLength)
          buffer.set(value.slice(0, neededLength), position)
          if (value.byteLength > neededLength) bufferLeft = value.slice(neededLength)
          else bufferLeft = undefined
          position = position + neededLength
        }
      }
      controller.enqueue(buffer)
    },
    cancel(reason) {
      return stream.cancel(reason)
    }
  })
}

// todo: impl the mime generator from https://developer.mozilla.org/en-US/docs/Web/Media/Formats/codecs_parameter | https://superuser.com/questions/1494831/extract-mime-type-codecs-for-mediasource-using-ffprobe#comment2431440_1494831
const remux =
  async (
    { buffer, size, stream, autoStart = false, autoProcess = true }:
    { buffer: ArrayBuffer, size: number, stream: ReadableStream<Uint8Array>, autoStart?: boolean, autoProcess?: boolean }
  ) => {
    const libav = libavInstance ?? (libavInstance = await (await import('libav')).default({
      locateFile: (path: string, scriptDirectory: string) => console.log('locateFile', path, scriptDirectory) || `/dist/${path.replace('/dist', '')}`
    }))
    const sizedChunksStream = bufferStreamChunksToSize(stream, PUSH_ARRAY_SIZE)
    const reader = sizedChunksStream.getReader()
    // // todo: replace this with a stream that handles backpressure
    const [resultStream, controller] = await new Promise<[ReadableStream<Uint8Array>, ReadableStreamController<any>]>(resolve => {
      let controller
      resolve([
        new ReadableStream({
          start: _controller => {
            controller = _controller
          }
        }),
        controller
      ])
    })
    const chunks = []
    let { value: currentBuffer, done: initDone } = await reader.read()
    let readCount = 0
    let closed = false
    let currentOffset = 0
    const remuxer = new libav.Transmuxer({
      length: size,
      bufferSize: BUFFER_SIZE,
      error: (critical, message) => {
        console.log('error', critical, message)
      },
      // https://gist.github.com/AlexVestin/15b90d72f51ff7521cd7ce4b70056dff#file-avio_write-c-L51
      seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
        // prevent seeking for now, once i wanna retry re-implementing seeking i can remove it then
        // maybe https://stackoverflow.com/a/17213878 could be of big help if i manage to unstuck libav from the end of file status
        console.log('seek', offset, whence)
        // return -1

        // if (whence === SEEK_WHENCE_FLAG.SEEK_SET) {
        //   bd->ptr = bd->buf + offset;
        //   return bd->ptr;
        // }
        // if (whence === SEEK_WHENCE_FLAG.SEEK_CUR) {
        //   bd->ptr += offset;
        //   return 1
        // }
        // if (whence === SEEK_WHENCE_FLAG.SEEK_END) {
        //   bd->ptr = (bd->buf + bd->size) + offset;
        //   return bd->ptr;
        // }
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
          return size;
        }
        // currentOffset = offset
        // const result = currentOffset
        // currentBuffer = new Uint8Array(currentBuffer.slice(currentOffset, currentOffset + PUSH_ARRAY_SIZE))
        // readCount = 0
        // return result
      },
      read: (bufferSize: number) => {
        console.log('reading from ', currentOffset, currentOffset + bufferSize)
        const _buffer = buffer.slice(currentOffset, currentOffset + bufferSize)
        currentOffset = currentOffset + bufferSize
        return {
          buffer: _buffer,
          size: _buffer.byteLength
        }
      },
      write: (type, keyframeIndex, size, offset, arrayBuffer, keyframePts, keyframePos, done) => {
        const buffer = new Uint8Array(arrayBuffer.slice())
        chunks.push({ keyframeIndex, size, offset, arrayBuffer: buffer, pts: keyframePts, pos: keyframePos, done })
        if (closed) return
        if (done) {
          closed = true
          if (buffer.byteLength) controller.enqueue(buffer)
          controller.close()
        } else {
          controller.enqueue(buffer)
        }
      }
    })
    remuxer.init()
    const headerChunks = chunks.splice(0, chunks.length)
    const process = async () => {
      // console.log('process')
      readCount = 0
      if (!chunks.length) {
        readCount = 1
        remuxer.process(currentBuffer.byteLength)
        if (!initDone) process()
        return
      }
      const { value: buffer, done } = await reader.read()
      currentBuffer = new Uint8Array(buffer)
      remuxer.process(currentBuffer.byteLength)
      if (!done) process()
    }

    await process()

    return {
      // seek: (timestamp: number, flags: SEEK_FLAG) => {
      //   // currentBuffer = new Uint8Array(fullBuffer.slice(timestamp, timestamp + PUSH_ARRAY_SIZE))
      //   // console.log('JS SEEK TIMESTAMP', timestamp)
      //   // remuxer.seek(timestamp, flags)
      //   // remuxer.process(currentBuffer.byteLength)
      // },
      headerChunks,
      chunks,
      stream: resultStream,
      getInfo: () => remuxer.getInfo()
    }
  }

fetch('../dist/spy13broke.mkv')
// fetch('./wrong-dts-3-3.mkv')
// fetch('./wrong-dts-3.mkv')
// fetch('./fucked-subtitles-and-FF-playback.mkv')
// fetch('./wrong-dts-2.mkv')
// fetch('./video15.mkv')
  .then(async ({ headers, body }) => {
    if (!body) return
    // const stream2 = body
    const [stream1, stream2] = body.tee()
    const buffer = await new Response(stream1).arrayBuffer()
    
    // const parser = new MatroskaSubtitles.SubtitleParser()
    
    // // first an array of subtitle track information is emitted
    // parser.once('tracks', (tracks) => console.log(tracks))
    
    // // afterwards each subtitle is emitted
    // parser.on('subtitle', (subtitle, trackNumber) =>
    // console.log('Track ' + trackNumber + ':', subtitle))

    // const streamReader = stream1.getReader()
    // const readStream = async () => {
    //   const { value, done } = await streamReader.read()
    //   if (done) {
    //     parser.end()
    //     return
    //   }
    //   parser.write(value)
    //   readStream()
    // }
    // readStream()
  
    // console.log(parser)
    
    const fileSize = Number(headers.get('Content-Length'))
    // const { headerChunks, stream, getInfo } = await remux({ size: fileSize, stream: stream2, autoStart: true })
    const { headerChunks, chunks: _chunks, stream, getInfo, seek } = await remux({ size: fileSize, stream: stream2, buffer,  autoStart: true })
    const reader = stream.getReader()
    console.log('fileSize', fileSize)
    // let resultBuffer = new Uint8Array(fileSize + (fileSize * 0.01))
    let processedBytes = 0

    let mp4boxfile = createFile()
    mp4boxfile.onError = e => console.error('onError', e)
    const chunks: Chunk[] = []
    console.log('mp4box chunks', chunks)
    console.log('mp4boxfile', mp4boxfile)
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

        if (chunks[firstSample.moof_number - 1]) continue

        chunks[firstSample.moof_number - 1] = {
          firstSample,
          lastSample,
          keyframeIndex: firstSample.moof_number - 1,
          // id: firstSample.moof_number - 1,
          startTime: firstSample.cts / firstSample.timescale,
          endTime: firstSample.cts / firstSample.timescale === lastSample.cts / lastSample.timescale ? lastSample.cts / lastSample.timescale + 0.02 : lastSample.cts / lastSample.timescale,
          // start: firstSample.cts / firstSample.timescale,
          // end: lastSample.cts / lastSample.timescale,
          buffered: false
        }
        mp4boxfile.releaseUsedSamples(1, lastSample.number)
      }
    }

    let mime = 'video/mp4; codecs=\"'
    let info

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
    }

    let first = false
    let i = 0
    let done = false
    const read = async () => {
      // const { value: arrayBuffer } = await reader.read()
      const { value: arrayBuffer, done } = await reader.read()
      // console.log('arrayBuffer', arrayBuffer)
      // if (i > 5) done = true
      if (done) {
        // resultBuffer = resultBuffer.slice(0, processedBytes)
        const el = document.createElement('div')
        el.innerText = 'Done'
        document.body.appendChild(el)
        return
      }

      i++
      const buffer = arrayBuffer.buffer
      // const buffer = arrayBuffer.slice(0).buffer
      // @ts-ignore
      buffer.fileStart = processedBytes
      mp4boxfile.appendBuffer(buffer)
      // resultBuffer.set(arrayBuffer, processedBytes)
      processedBytes += arrayBuffer.byteLength
      if (!first) {
        first = true
        return read()
      }
      read()
    }

    await read()

    console.log('mime', mime)

    const duration = getInfo().input.duration / 1_000_000

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

    let resolve, reject, abortResolve

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
      new Promise((_resolve, _reject) => {
        resolve = _resolve
        reject = _reject
        sourceBuffer.appendBuffer(buffer)
      })

    const removeRange = ({ start, end, index }: { start: number, end: number, index: number }) =>
      new Promise((_resolve, _reject) => {
        // console.log('removeRange', start, end, index)
        resolve = _resolve
        reject = _reject
        // console.log(
        //   'removeRange',
        //   start, end, index,
        //   Math.max(sourceBuffer.buffered.start(index), start),
        //   Math.min(sourceBuffer.buffered.end(index), end)
        // )
        sourceBuffer.remove(
          Math.max(sourceBuffer.buffered.start(index), start),
          Math.min(sourceBuffer.buffered.end(index), end)
        )
      })

    const appendChunk = async (chunk: Chunk) => {
      // console.log('appendChunk', chunks[chunk.keyframeIndex + 2])
      // console.log('appendChunk', chunk)
      console.log('chunk', chunk, _chunks[chunk.keyframeIndex])
      await appendBuffer(_chunks[chunk.keyframeIndex].arrayBuffer.buffer)
      
      // console.log('appendChunk',
      //   chunks[chunk.keyframeIndex],
      //   chunk.keyframeIndex,
      //   _chunks[chunk.keyframeIndex].arrayBuffer.buffer,
      //   // resultBuffer.buffer.slice(
      //   //   chunks[chunk.keyframeIndex + 2].offset,
      //   //   chunks[chunk.keyframeIndex + 2].offset + chunks[chunk.keyframeIndex + 2].size,
      //   //   // segment metadata
      //   //   // mp4boxfile.moofs[chunk.keyframeIndex].start,
      //   //   // // segment data
      //   //   // mp4boxfile.mdats[chunk.keyframeIndex].start + mp4boxfile.mdats[chunk.keyframeIndex].size
      //   // ),
      //   chunks.filter(({ buffered }) => buffered)
      // )
      // await appendBuffer(
      //   // chunks[chunk.keyframeIndex].arrayBuffer.buffer
      //   resultBuffer.buffer.slice(
      //     chunks[chunk.keyframeIndex + 2].offset,
      //     chunks[chunk.keyframeIndex + 2].offset + chunks[chunk.keyframeIndex + 2].size,
      //     // segment metadata
      //     // mp4boxfile.moofs[chunk.keyframeIndex].start,
      //     // // segment data
      //     // mp4boxfile.mdats[chunk.keyframeIndex].start + mp4boxfile.mdats[chunk.keyframeIndex].size
      //   )
      // )
      chunk.buffered = true
    }

    const removeChunk = async (chunk: Chunk) => {
      if (chunk.keyframeIndex < 0) return console.log('skipped remove', chunk)
      const range = getTimeRange(chunk.startTime) ?? getTimeRange(chunk.endTime)
      // console.log('removeChunk', chunk, range?.index, range)
      if (!range) throw new RangeError('No TimeRange found with this chunk')
      await removeRange({ start: chunk.startTime, end: chunk.endTime, index: range.index })
      chunk.buffered = false
    }

    const abort = () =>
      new Promise(resolve => {
        // console.log('abort')
        abortResolve = resolve
        sourceBuffer.abort()
      })

    sourceBuffer.addEventListener('updateend', ev => resolve(ev))
    sourceBuffer.addEventListener('abort', ev => {
      reject(ev)
      abortResolve(ev)
    })
    sourceBuffer.addEventListener('error', ev => reject(ev))

    // const initializationBuffer = resultBuffer.buffer.slice(0, mp4boxfile.moov.start + mp4boxfile.moov.size)
    const headerBuffer = new Uint8Array(headerChunks[0].arrayBuffer.byteLength + headerChunks[1].arrayBuffer.byteLength);
    headerBuffer.set(new Uint8Array(headerChunks[0].arrayBuffer), 0);
    headerBuffer.set(new Uint8Array(headerChunks[1].arrayBuffer), headerChunks[0].arrayBuffer.byteLength);
    await appendBuffer(headerBuffer)
    
    const throttle = (func, limit) => {
      let inThrottle
      return function() {
        const args = arguments
        const context = this
        if (!inThrottle) {
          func.apply(context, args)
          inThrottle = true
          setTimeout(() => inThrottle = false, limit)
        }
      }
    }

    const PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS = 15
    const POST_SEEK_NEEDED_BUFFERS_IN_SECONDS = 30

    // let currentSeek
    // const myEfficientFn = throttle(async (...args) => {
    //   // console.log('myEfficientFn', args)
    //   const { currentTime } = video
    //   currentSeek = currentTime
    //   const neededChunks =
    //     chunks
    //       .filter(({ startTime, endTime }) =>
    //         currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS < startTime
    //         && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS > endTime
    //       )
    //   // console.log('neededChunks', neededChunks)
    //   const shouldUnbufferChunks =
    //     chunks
    //       .filter(chunk => !neededChunks.includes(chunk))
    //   // console.log('shouldUnbufferChunks', shouldUnbufferChunks)

    //   if (sourceBuffer.updating) await abort()
    //   for (const chunk of shouldUnbufferChunks) {
    //     if (!chunk.buffered) continue
    //     try {
    //       await removeChunk(chunk)
    //     } catch (err) {
    //       if (err.message !== 'No TimeRange found with this chunk') throw err
    //     }
    //   }
    //   for (const chunk of neededChunks) {
    //     if (
    //       chunk.buffered
    //       || (
    //         processedBytes !== fileSize
    //         && chunk.keyframeIndex + 1 === chunks.length
    //         // && chunk.keyframeIndex + 2 === chunks.length
    //       )
    //     ) continue
    //     try {
    //       await appendChunk(chunk)
    //     } catch (err) {
    //       if (!(err instanceof Event)) throw err
    //       // if (err.message !== 'Failed to execute \'appendBuffer\' on \'SourceBuffer\': This SourceBuffer is still processing an \'appendBuffer\' or \'remove\' operation.') throw err
    //       break
    //     }
    //   }
    //   // for (const chunk of neededChunks) {
    //   //   if (
    //   //     chunk.buffered
    //   //     || (
    //   //       !done
    //   //       && chunk.id + 1 === chunks.length
    //   //     )
    //   //   ) continue
    //   //   await appendChunk(chunk)
    //   // }
    // }, 10)

    const updateBufferTime = 250
    console.log('sourceBuffer', sourceBuffer)
    let currentSeek
    const myEfficientFn = throttle(async () => {
      const { currentTime } = video
      currentSeek = currentTime
      const neededChunks =
        chunks
          .filter(({ startTime, endTime }) =>
            currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS < startTime
            && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS > endTime
          )
  
      const shouldUnbufferChunks =
        chunks
          .filter(chunk => !neededChunks.includes(chunk))
  
      // console.log('bufferedRanges', getTimeRanges())

      if (sourceBuffer.updating) await abort()
      for (const chunk of shouldUnbufferChunks) {
        if (!chunk.buffered) continue
        try {
          await removeChunk(chunk)
        } catch (err) {
          if (err.message === 'No TimeRange found with this chunk') chunk.buffered = false
          if (err.message !== 'No TimeRange found with this chunk') throw err
        }
      }
      const bufferedRanges = 
        getTimeRanges()
          .filter(({ start, end }) =>
              currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS > start && currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS > end ||
              currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS < start && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS < end
            )
      for (const range of bufferedRanges) {
        await removeRange(range)
      }
      for (const chunk of neededChunks) {
        if (
          chunk.buffered
          || (
            processedBytes !== fileSize
            && chunk.id + 1 === chunks.length
          )
        ) continue
        try {
          await appendChunk(chunk)
        } catch (err) {
          if (!(err instanceof Event)) throw err
          // if (err.message !== 'Failed to execute \'appendBuffer\' on \'SourceBuffer\': This SourceBuffer is still processing an \'appendBuffer\' or \'remove\' operation.') throw err
          break
        }
      }
    }, updateBufferTime)

    video.addEventListener('waiting', async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 1000))
      console.log('waiting', chunks, sourceBuffer)
      const { currentTime } = video
      const getBufferedRanges = async () => {
        const ranges = getTimeRanges()
        const filteredRanges = ranges
          .filter(({ start, end }) =>
              currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS > start && currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS > end ||
              currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS < start && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS < end
            )
        console.log('getBufferedRanges ranges', ranges, currentTime, filteredRanges)
        if (ranges.length) {
          return ranges
        }
        await new Promise(resolve => setTimeout(resolve, 250))
        return getBufferedRanges()
      }
      const bufferedRanges = await getBufferedRanges()
      console.log('waiting', bufferedRanges, removeRange)
      for (const range of bufferedRanges.slice(1)) {
        console.log('REMOVING RANGE', range)
        await removeRange(range)
      }
      setTimeout(async () => {
        myEfficientFn(...args)
      }, updateBufferTime)
    })

    video.addEventListener('seeking', (...args) => {
      // console.log('\n\n\n\n\n\n\n\n\nseeking', video.currentTime)
      myEfficientFn(...args)
    })
    video.addEventListener('timeupdate', (...args) => {
      // console.log('\n\n\n\n\n\n\n\n\ntimeupdate', video.currentTime)
      myEfficientFn(...args)
    })

    // video.addEventListener('timeupdate', () => {
      // console.log('timeupdate', video.currentTime)
    //   myEfficientFn()
    // })

    await appendChunk(chunks[0])
    // await appendChunk(chunks[1])
    // await appendChunk(chunks[2])
    // await appendChunk(chunks[0])
    // await appendChunk(chunks[1])
  })