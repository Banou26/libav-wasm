import { createFile } from 'mp4box'
// const {  } = Stream
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

const BUFFER_SIZE = 5_000_000
const PUSH_ARRAY_SIZE = BUFFER_SIZE * 2 // 10_000_000

let libavInstance

/** https://ffmpeg.org/doxygen/trunk/avformat_8h.html#ac736f8f4afc930ca1cda0b43638cc678 */
enum SEEK_FLAG {
  /** seek backward */
  AVSEEK_FLAG_BACKWARD = 1,
  /** seeking based on position in bytes */
  AVSEEK_FLAG_BYTE = 2,
  /** seek to any frame, even non-keyframes */
  AVSEEK_FLAG_ANY = 4,
  /** seeking based on frame number */
  AVSEEK_FLAG_FRAME = 8
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

// console.log('BUFFER EQ', equal)

const remux =
  async (
    { size, stream, autoStart = false, autoProcess = true }:
    { size:number, stream: ReadableStream<Uint8Array>, autoStart?: boolean, autoProcess?: boolean }
  ) => {
    console.log('size', size)
    const libav = libavInstance ?? (libavInstance = await (await import('../dist/libav.js'))())
    const reader = stream.getReader()
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
    console.log('libav', libav)

    let leftOverData: Uint8Array
    const accumulate = async ({ buffer = new Uint8Array(PUSH_ARRAY_SIZE), currentSize = 0 } = {}): Promise<{ buffer?: Uint8Array, currentSize?: number, done: boolean }> => {
      const { value: newBuffer, done } = await reader.read()

      if (currentSize === 0 && leftOverData) {
        buffer.set(leftOverData)
        currentSize += leftOverData.byteLength
        leftOverData = undefined
      }

      if (done) {
        return { buffer: buffer.slice(0, currentSize), currentSize, done }
      }

      let newSize
      const slicedBuffer = newBuffer.slice(0, PUSH_ARRAY_SIZE - currentSize)
      newSize = currentSize + slicedBuffer.byteLength
      buffer.set(slicedBuffer, currentSize)

      if (newSize === PUSH_ARRAY_SIZE) {
        leftOverData = newBuffer.slice(PUSH_ARRAY_SIZE - currentSize)
        return { buffer, currentSize: newSize, done: false }
      }
      
      return accumulate({ buffer, currentSize: newSize })
    }

    let { buffer: currentBuffer, done: initDone } = await accumulate()
    let readCount = 0
    let done = false
    let closed = false
    let seeking = false
    const remuxer = new libav.Remuxer({
      length: size,
      bufferSize: BUFFER_SIZE,
      seek: (offset: number, flags: number) => {
        console.log('JS seek', offset, flags)
        return -1
      },
      read: () => {
        const buffer =
          readCount === 0
            ? currentBuffer.slice(0, BUFFER_SIZE)
            : currentBuffer.slice(BUFFER_SIZE)
        readCount++
        if (readCount === 2) {
          readCount = 0
        }
        if (done || buffer.byteLength === 0) {
          done = true
          return {
            buffer: new Uint8Array(0),
            size: 0
          }
        }
        if (seeking) console.log('read', buffer)
        return {
          buffer,
          size: buffer.byteLength
        }
        // const { buffer, currentSize: size } = await accumulate()
        // return {
        //   buffer,
        //   size: size
        // }
      },
      write: (type, keyframeIndex, size, offset, arrayBuffer) => {
        if (seeking) console.log('callback', offset, size, arrayBuffer)
        const buffer = new Uint8Array(arrayBuffer.slice())
        chunks.push({ keyframeIndex, size, offset, arrayBuffer: buffer })
        if (done && !closed) {
          closed = true
          controller.enqueue(buffer)
          controller.close()
        } else if (!closed) {
          controller.enqueue(buffer)
        }
      }
    })
    remuxer.init()
    const headerChunks = chunks.splice(0, chunks.length)
    console.log('LIBAV headerChunks', headerChunks)
    console.log('LIBAV chunks', chunks)

    const process = async () => {
      readCount = 0
      if (!chunks.length) {
        readCount = 1
        remuxer.process(currentBuffer.byteLength)
        if (!initDone) process()
        return
      }
      const { buffer, done } = await accumulate()
      currentBuffer = buffer
      remuxer.process(currentBuffer.byteLength)
      if (!done) process()
    }

    await process()

    const fullBuffer = await (await fetch('./video.mkv')).arrayBuffer()

    return {
      seek: (timestamp: number, flags: SEEK_FLAG) => {
        seeking = true
        done = false
        currentBuffer = new Uint8Array(fullBuffer.slice(timestamp, timestamp + PUSH_ARRAY_SIZE))
        remuxer.seek(timestamp, flags)
        remuxer.process(currentBuffer.byteLength)
      },
      headerChunks,
      chunks,
      stream: resultStream,
      getInfo: () => remuxer.getInfo()
    }

    // const buffer = new Uint8Array(PUSH_ARRAY_SIZE)
    // let processedBytes = 0
    // let currentBufferBytes = 0
    // let leftOverData
    // let isInitialized = false
    // let paused = false

    // const chunks = []
    // const headerChunks = []

    // // todo: (THIS IS A REALLY UNLIKELY CASE OF IT ACTUALLY HAPPENING) change the way leftOverData works to handle if arrayBuffers read are bigger than PUSH_ARRAY_SIZE
    // const processData = (initOnly = false) => {
    //   if (!isInitialized) {
    //     remuxer.init()
    //     if (initOnly) {
    //       isInitialized = true
    //       return
    //     }
    //   }
    //   remuxer.process()
    //   remuxer.clearInput()

    //   // const result = new Uint8Array(remuxer.getInt8Array())
    //   // todo: handle if initOnly is true, it won't apply the mp4 header
    //   if (!isInitialized) {
    //     // result.set([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D], 0)
    //     isInitialized = true
    //   }
    //   remuxer.clearOutput()
    //   // controller.enqueue(result)
    //   if (leftOverData) {
    //     // console.log('leftOverData', buffer, leftOverData)
    //     buffer.set(leftOverData, 0)
    //     currentBufferBytes += leftOverData.byteLength
    //     leftOverData = undefined
    //   }
    //   if (processedBytes === size) {
    //     remuxer.close()
    //     controller.close()
    //     console.log('libav chunks', chunks)
    //   }
    // }

    // const readData = async (process = true) => {
    //   if (leftOverData || paused) return
    //   const { value: arrayBuffer, done } = await reader.read()
    //   if (done || !arrayBuffer) {
    //     const lastChunk = buffer.slice(0, size - processedBytes)
    //     remuxer.push(lastChunk)
    //     processedBytes += lastChunk.byteLength
    //     processData()
    //     return
    //   }
    //   const _currentBufferBytes = currentBufferBytes
    //   const slicedArrayBuffer = arrayBuffer.slice(0, PUSH_ARRAY_SIZE - currentBufferBytes)
    //   buffer.set(slicedArrayBuffer, currentBufferBytes)
    //   currentBufferBytes += slicedArrayBuffer.byteLength
    //   if (currentBufferBytes === PUSH_ARRAY_SIZE) {
    //     leftOverData = arrayBuffer.slice(PUSH_ARRAY_SIZE - _currentBufferBytes)
    //     processedBytes += currentBufferBytes
    //     currentBufferBytes = 0
    //     if (process) {
    //       remuxer.push(buffer)
    //       processData()
    //     }
    //   }
    //   if (!paused && !done) readData(autoProcess)
    //   // if (!paused && !done) setTimeout(() => readData(autoProcess), 1)
    // }

    // if (autoStart) readData(autoProcess)

    // return {
    //   headerChunks,
    //   chunks,
    //   stream: resultStream,
    //   seek: (timestamp: number, flag: SEEK_FLAG) => {
    //     remuxer.seek(timestamp, flag)
    //   },
    //   pause: () => {
    //     paused = true
    //   },
    //   resume: () => {
    //     paused = false
    //   },
    //   start: () => {
    //     if (!isInitialized) readData()
    //   },
    //   stop: () => {
    //     paused = true
    //     remuxer.clearInput()
    //     remuxer.clearOutput()
    //   },
    //   setAutoProcess: (value: boolean) => {
    //     autoProcess = value
    //   },
    //   getAutoProcess: () => autoProcess,
    //   getInfo: () => remuxer.getInfo()
    // }
  }

fetch('./video.mkv')
  .then(async ({ headers, body }) => {
    const stream2 = body
    // const [stream1, stream2] = body.tee()

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
    const { headerChunks, chunks: _chunks, stream, getInfo, seek } = await remux({ size: fileSize, stream: stream2, autoStart: true })
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

        console.log('set time', _chunks[150], chunks[150])
        // seek(0, SEEK_FLAG.AVSEEK_FLAG_BYTE)
        seek(_chunks[10].offset, SEEK_FLAG.AVSEEK_FLAG_BYTE)
        // seek(_chunks[150].offset, SEEK_FLAG.AVSEEK_FLAG_BYTE)
        // seek(chunks[150].startTime, SEEK_FLAG.AVSEEK_FLAG_BYTE)
        // video.currentTime = 600

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
    video.autoplay = true
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
      console.error(ev.target.error)
    })
    document.body.appendChild(video)

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
      console.log('chunk', chunk)
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

    video.addEventListener('waiting', (...args) => {
      console.log('waiting', chunks)
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