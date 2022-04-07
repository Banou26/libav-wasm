import { createFile } from 'mp4box'
// const {  } = Stream
interface Chunk {
  keyframeIndex: number
  // id: number
  startTime: number
  endTime: number
  // start: number
  // end: number
  buffered: boolean
}

const BUFFER_SIZE = 5_000_000
const PUSH_ARRAY_SIZE = 10_000_000

let libavInstance

const remux =
  async (
    { size, stream, autoStart = false, autoProcess = true }:
    { size:number, stream: ReadableStream<Uint8Array>, autoStart?: boolean, autoProcess?: boolean }
  ) => {
    const remuxer = libavInstance ?? new (libavInstance = await (await import('../dist/libav.js'))()).Remuxer(size)
    const reader = stream.getReader()

    const buffer = new Uint8Array(PUSH_ARRAY_SIZE)
    let processedBytes = 0
    let currentBufferBytes = 0
    let leftOverData
    let isInitialized = false
    let paused = false

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
    const headerChunks = []

    // todo: (THIS IS A REALLY UNLIKELY CASE OF IT ACTUALLY HAPPENING) change the way leftOverData works to handle if arrayBuffers read are bigger than PUSH_ARRAY_SIZE
    const processData = (initOnly = false) => {
      if (!isInitialized) {
        let previousTimes
        let correctedFirstChunk
        remuxer.init(BUFFER_SIZE, (type, keyframeIndex, startTime, endTime, size, offset, arrayBuffer, ended) => {
          if (keyframeIndex < 0) {
          const buffer = arrayBuffer.slice()
          headerChunks.push({ keyframeIndex, startTime, endTime, size, offset, arrayBuffer: buffer, ended })
            return controller.enqueue(new Uint8Array(arrayBuffer))
          }
          if (type === 'keyframeTimestampCorrection') {
            correctedFirstChunk = { startTime, endTime }
            return
          }
          const buffer = arrayBuffer.slice()
          // const buffer = new ArrayBuffer(arrayBuffer.byteLength)
          // new Uint8Array(buffer).set(new Uint8Array(arrayBuffer))
          const newChunk =
            !keyframeIndex
              ? { keyframeIndex, ...correctedFirstChunk, size, offset, arrayBuffer: buffer, ended }
              : { keyframeIndex, ...previousTimes ?? {}, size, offset, arrayBuffer: buffer, ended }

          chunks.push(newChunk)
          // console.log('new chunk', newChunk)
          previousTimes = { startTime, endTime }
          controller.enqueue(new Uint8Array(buffer))
        })
        if (initOnly) {
          isInitialized = true
          return
        }
      }
      remuxer.process()
      remuxer.clearInput()

      // const result = new Uint8Array(remuxer.getInt8Array())
      // todo: handle if initOnly is true, it won't apply the mp4 header
      if (!isInitialized) {
        // result.set([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D], 0)
        isInitialized = true
      }
      remuxer.clearOutput()
      // controller.enqueue(result)
      if (leftOverData) {
        // console.log('leftOverData', buffer, leftOverData)
        buffer.set(leftOverData, 0)
        currentBufferBytes += leftOverData.byteLength
        leftOverData = undefined
      }
      if (processedBytes === size) {
        remuxer.close()
        controller.close()
        console.log('libav chunks', chunks)
      }
    }

    const readData = async (process = true) => {
      if (leftOverData || paused) return
      const { value: arrayBuffer, done } = await reader.read()
      if (done || !arrayBuffer) {
        const lastChunk = buffer.slice(0, size - processedBytes)
        remuxer.push(lastChunk)
        processedBytes += lastChunk.byteLength
        processData()
        return
      }
      const _currentBufferBytes = currentBufferBytes
      const slicedArrayBuffer = arrayBuffer.slice(0, PUSH_ARRAY_SIZE - currentBufferBytes)
      buffer.set(slicedArrayBuffer, currentBufferBytes)
      currentBufferBytes += slicedArrayBuffer.byteLength
      if (currentBufferBytes === PUSH_ARRAY_SIZE) {
        leftOverData = arrayBuffer.slice(PUSH_ARRAY_SIZE - _currentBufferBytes)
        processedBytes += currentBufferBytes
        currentBufferBytes = 0
        if (process) {
          remuxer.push(buffer)
          processData()
        }
      }
      // if (!paused && !done) readData(autoProcess)
      if (!paused && !done) setTimeout(() => readData(autoProcess), 1)
    }

    if (autoStart) readData(autoProcess)

    return {
      headerChunks,
      chunks,
      stream: resultStream,
      pause: () => {
        paused = true
      },
      resume: () => {
        paused = false
      },
      start: () => {
        if (!isInitialized) readData()
      },
      stop: () => {
        paused = true
        remuxer.clearInput()
        remuxer.clearOutput()
      },
      setAutoProcess: (value: boolean) => {
        autoProcess = value
      },
      getAutoProcess: () => autoProcess,
      getInfo: () => remuxer.getInfo()
    }
  }

fetch('./video2.mkv')
  .then(async ({ headers, body }) => {
    const [stream1, stream2] = body.tee()

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
    // const { stream, getInfo } = await remux({ size: fileSize, stream: stream2, autoStart: true })
    const { headerChunks, chunks, stream, getInfo } = await remux({ size: fileSize, stream: stream2, autoStart: true })
    const reader = stream.getReader()
    console.log('fileSize', fileSize)
    // let resultBuffer = new Uint8Array(fileSize + (fileSize * 0.01))
    let processedBytes = 0

    let mp4boxfile = createFile()
    mp4boxfile.onError = e => console.error('onError', e)
    // const chunks: Chunk[] = []
    console.log('mp4box chunks', chunks)
    console.log('mp4boxfile', mp4boxfile)
    // mp4boxfile.onSamples = (id, user, samples) => {
    //   const groupBy = (xs, key) => {
    //     return xs.reduce((rv, x) => {
    //       (rv[x[key]] = rv[x[key]] || []).push(x)
    //       return rv
    //     }, []).filter(Boolean)
    //   }
    //   const groupedSamples = groupBy(samples, 'moof_number')
    //   for (const group of groupedSamples) {
    //     const firstSample = group[0]
    //     const lastSample = group.slice(-1)[0]

    //     if (chunks[firstSample.moof_number - 1]) continue

    //     // chunks[firstSample.moof_number - 1] = {
    //     //   firstSample,
    //     //   lastSample,
    //     //   keyframeIndex: firstSample.moof_number - 1,
    //     //   // id: firstSample.moof_number - 1,
    //     //   startTime: firstSample.cts / firstSample.timescale,
    //     //   endTime: lastSample.cts / lastSample.timescale,
    //     //   // start: firstSample.cts / firstSample.timescale,
    //     //   // end: lastSample.cts / lastSample.timescale,
    //     //   buffered: false
    //     // }
    //   }
    // }

    let mime = 'video/mp4; codecs=\"'
    let info

    mp4boxfile.onReady = (_info) => {
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
      const { value: arrayBuffer } = await reader.read()
      // const { value: arrayBuffer, done } = await reader.read()
      // console.log('arrayBuffer', arrayBuffer)
      if (i > 5) done = true
      if (done) {
        // resultBuffer = resultBuffer.slice(0, processedBytes)
        const el = document.createElement('div')
        el.innerText = 'Done'
        document.body.appendChild(el)
        // console.log('mp4box chunks', chunks)
        console.log('mp4boxfile', mp4boxfile)
        return
      }

      i++

      const buffer = arrayBuffer.slice(0).buffer
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
      await appendBuffer(chunks[chunk.keyframeIndex].arrayBuffer.buffer)
      
      console.log('appendChunk',
        chunks[chunk.keyframeIndex],
        chunk.keyframeIndex,
        chunks[chunk.keyframeIndex].arrayBuffer.buffer,
        // resultBuffer.buffer.slice(
        //   chunks[chunk.keyframeIndex + 2].offset,
        //   chunks[chunk.keyframeIndex + 2].offset + chunks[chunk.keyframeIndex + 2].size,
        //   // segment metadata
        //   // mp4boxfile.moofs[chunk.keyframeIndex].start,
        //   // // segment data
        //   // mp4boxfile.mdats[chunk.keyframeIndex].start + mp4boxfile.mdats[chunk.keyframeIndex].size
        // ),
        chunks.filter(({ buffered }) => buffered)
      )
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
      console.log('removeChunk', chunk, range?.index, range)
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
  
      console.log('bufferedRanges', getTimeRanges())

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
          const buffer =
            [
              chunk.keyframeIndex,
              chunk.keyframeIndex + 1,
              chunk.keyframeIndex + 2
            ]
              .map(index => chunks[index])
              .filter(Boolean)
              .reduce((accBuffer, chunk) => {
                chunk.buffered = true
                const newAccBuffer = new Uint8Array(accBuffer.byteLength + chunk.arrayBuffer.byteLength);
                newAccBuffer.set(new Uint8Array(accBuffer), 0);
                newAccBuffer.set(new Uint8Array(chunk.arrayBuffer), accBuffer.byteLength);
                return newAccBuffer
              }, new ArrayBuffer(0))


          // const headerBuffer = new Uint8Array(headerChunks[0].arrayBuffer.byteLength + headerChunks[1].arrayBuffer.byteLength);
          // headerBuffer.set(new Uint8Array(headerChunks[0].arrayBuffer), 0);
          // headerBuffer.set(new Uint8Array(headerChunks[1].arrayBuffer), headerChunks[0].arrayBuffer.byteLength);
          await appendBuffer(buffer)
          // await appendChunk(chunk)
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
        for (const range of getTimeRanges()) {
          await removeRange(range)
        }
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
    await appendChunk(chunks[1])
    await appendChunk(chunks[2])
    // await appendChunk(chunks[0])
    // await appendChunk(chunks[1])
  })