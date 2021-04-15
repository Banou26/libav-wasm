import { createFile } from 'mp4box'

const downloadArrayBuffer = buffer => {
  const videoBlob = new Blob([new Uint8Array(buffer, 0, buffer.length)], { type: 'video/mp4' });
  
  var xhr = new XMLHttpRequest();
  xhr.open("GET", URL.createObjectURL(videoBlob));
  xhr.responseType = "arraybuffer";

  xhr.onload = function () {
      if (this.status === 200) {
          var blob = new Blob([xhr.response], {type: "application/octet-stream"});
          var objectUrl = URL.createObjectURL(blob);
          window.open(objectUrl);
      }
  };
  xhr.send();
}

interface Chunk {
  id: number
  start: number
  end: number
  buffered: boolean
}

const BUFFER_SIZE = 5_000_000
const PUSH_ARRAY_SIZE = 10_000_000
const PUSH_SIZE = Math.round(PUSH_ARRAY_SIZE / BUFFER_SIZE) * BUFFER_SIZE

let libavInstance

const remux =
  async (
    { stream, autoStart = false, autoProcess = true }:
    { stream: ReadableStream<Uint8Array>, autoStart?: boolean, autoProcess?: boolean }
  ) => {
    const remuxer = libavInstance ?? new (libavInstance = await (await import('../dist/libav.js'))()).Remuxer()
    const reader = stream.getReader()

    const buffer = new Uint8Array(PUSH_ARRAY_SIZE)
    let processedBytes = 0
    let currentBufferBytes = 0
    let leftOverData
    let isInitialized = false
    let paused = false

    const [resultStream, controller] = await new Promise(resolve => {
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

    const processData = (initOnly = false) => {
      if (!isInitialized) {
        remuxer.init(BUFFER_SIZE)
        isInitialized = true
        if (initOnly) return
      }
      remuxer.process()
      remuxer.clearInput()

      const result = remuxer.getInt8Array()
      remuxer.clearOutput()
      controller.enqueue(result)
      if (leftOverData) {
        buffer.set(leftOverData, 0)
        currentBufferBytes += leftOverData.byteLength
        leftOverData = undefined
      }
    }

    // todo: change the way leftOverData to handle if arrayBuffers read are bigger than PUSH_ARRAY_SIZE

    const readData = (process = true) =>
      !leftOverData
      && !paused
      && reader
        .read()
        .then(({ value: arrayBuffer, done }) => {
          if (done || !arrayBuffer) return
          // console.log('readData')
          // console.log('buffer', buffer)
          // console.log(
          //   'arrayBuffer', arrayBuffer,
          //   '\ncurrentBufferBytes', currentBufferBytes,
          //   '\nPUSH_ARRAY_SIZE - currentBufferBytes', PUSH_ARRAY_SIZE - currentBufferBytes
          // )
          const slicedArrayBuffer = arrayBuffer.slice(0, PUSH_ARRAY_SIZE - currentBufferBytes)
          // console.log('slicedArrayBuffer', slicedArrayBuffer)
          buffer.set(slicedArrayBuffer, currentBufferBytes)
          currentBufferBytes += slicedArrayBuffer.byteLength
          if (currentBufferBytes === PUSH_ARRAY_SIZE) {
            leftOverData = arrayBuffer.slice(PUSH_ARRAY_SIZE - currentBufferBytes)
            currentBufferBytes = 0
            if (process) {
              remuxer.push(buffer)
              processData()
            }
          }

          if (!paused && !done) readData(autoProcess)
        })

    if (autoStart) readData(autoProcess)

    return {
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

// fetch('./video.mkv')
//   .then(({ body }) => {
//     const { stream } = remux({ stream: body, autoStart: true })
//   })


import('../dist/libav.js').then(async v => {
  // return
  console.log(':)')
  const module = await v()
  console.log(v)
  console.log(module)

  const typedArrayBuffer = new Uint8Array((await (await fetch('./video.mkv')).arrayBuffer()))
  console.log('typedArrayBuffer', typedArrayBuffer, typedArrayBuffer.byteLength)

  const BUFFER_SIZE = 5_000_000
  // const BUFFER_SIZE = 2_000_000
  // const BUFFER_SIZE = 65536

  const PUSH_ARRAY_SIZE = 10_000_000

  const PUSH_SIZE = Math.round(PUSH_ARRAY_SIZE / BUFFER_SIZE) * BUFFER_SIZE
  // const PUSH_SIZE = 2_000_000

  console.log('BUFFER_SIZE', BUFFER_SIZE)
  console.log('PUSH_SIZE', PUSH_SIZE)

  const remuxer = new module.Remuxer(typedArrayBuffer.byteLength)
  console.log('remuxer', remuxer)

  const resultBuffer = new Uint8Array(2_000_000_000)
  let processedBytes = 0
  let outputBytes = 0
  let isInitialized = false
  while (processedBytes !== typedArrayBuffer.byteLength) { // processedBytes !== typedArrayBuffer.byteLength
  // while (processedBytes < 100_000_000) { // processedBytes !== typedArrayBuffer.byteLength
    console.log(
      '============',
      'processedBytes', processedBytes,
      '\noutputBytes', outputBytes
    )
    const bufferToPush = typedArrayBuffer.slice(processedBytes, processedBytes + PUSH_SIZE)
    remuxer.push(bufferToPush)
    processedBytes += bufferToPush.byteLength

    if (!isInitialized) {
      remuxer.init(BUFFER_SIZE)
      isInitialized = true
    }

    remuxer.process()
    remuxer.clearInput()

    const result = remuxer.getInt8Array()
    resultBuffer.set(result, outputBytes)
    outputBytes += result.byteLength
  
    remuxer.clearOutput()
    console.log(
      'processedBytes', processedBytes,
      '\noutputBytes', outputBytes,
      '\nbufferToPush.byteLength', bufferToPush.byteLength,
      '\nresult.byteLength', result.byteLength
    )
  }

  remuxer.close()

  const duration = remuxer.getInfo().input.duration / 1_000_000

  const header = [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D]
  resultBuffer.set(header, 0)
  console.log('resultBuffer', outputBytes.toLocaleString(), resultBuffer)

  // downloadArrayBuffer(resultBuffer)

  const video = document.createElement('video')
  video.autoplay = true
  video.controls = true
  video.volume = 0
  video.addEventListener('error', ev => {
    console.error(ev.target.error)
  })
  document.body.appendChild(video)

  let mp4boxfile = createFile()
  mp4boxfile.onError = e => console.error('onError', e)

  const chunks: Chunk[] = []

  const _buffer = resultBuffer.slice(0, outputBytes).buffer
  _buffer.fileStart = 0
  mp4boxfile.appendBuffer(_buffer)

  mp4boxfile.onSamples = (id, user, samples) => {
    console.log('onSamples', id, user, samples)
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
        id: firstSample.moof_number - 1,
        start: firstSample.cts / firstSample.timescale,
        end: lastSample.cts / lastSample.timescale,
        buffered: false
      }
    }
  }
  mp4boxfile.setExtractionOptions(1)
  mp4boxfile.start()

  const buffer = resultBuffer.slice(0, outputBytes).buffer
  // @ts-ignore
  buffer.fileStart = 0

  const info: any = await new Promise(resolve => {
    mp4boxfile.onReady = resolve
    mp4boxfile.start()
    mp4boxfile.appendBuffer(buffer)
    console.log('APPENDED')
    // mp4boxfile.flush()
    // console.log('FLUSHED')
  })
  console.log('mp4boxfile', mp4boxfile, chunks)

  let mime = 'video/mp4; codecs=\"'
  for (let i = 0; i < info.tracks.length; i++) {
    if (i !== 0) mime += ','
    mime += info.tracks[i].codec
  }
  mime += '\"'

  console.log('info', info, mime)

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
      resolve = _resolve
      reject = _reject
      sourceBuffer.remove(
        Math.max(sourceBuffer.buffered.start(index), start),
        Math.min(sourceBuffer.buffered.end(index), end)
      )
    })

  const appendChunk = async (chunk: Chunk) => {
    await appendBuffer(
      resultBuffer.buffer.slice(
        // segment metadata
        mp4boxfile.moofs[chunk.id].start,
        // segment data
        mp4boxfile.mdats[chunk.id].start + mp4boxfile.mdats[chunk.id].size
      )
    )
    chunk.buffered = true
  }

  const removeChunk = async (chunk: Chunk) => {
    const range = getTimeRange(chunk.start) ?? getTimeRange(chunk.end)
    if (!range) throw new RangeError('No TimeRange found with this chunk')
    await removeRange({ start: chunk.start, end: chunk.end, index: range.index })
    chunk.buffered = false
  }

  const abort = () =>
    new Promise(resolve => {
      abortResolve = resolve
      sourceBuffer.abort()
    })

  sourceBuffer.addEventListener('updateend', ev => resolve(ev))
  sourceBuffer.addEventListener('abort', ev => {
    reject(ev)
    abortResolve(ev)
  })
  sourceBuffer.addEventListener('error', ev => reject(ev))

  const initializationBuffer = resultBuffer.buffer.slice(0, mp4boxfile.moov.start + mp4boxfile.moov.size)
  await appendBuffer(initializationBuffer)

  
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

  let currentSeek
  const myEfficientFn = throttle(async () => {
    const { currentTime } = video
    currentSeek = currentTime
    const neededChunks =
      chunks
        .filter(({ start, end }) =>
          currentTime - PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS < start
          && currentTime + POST_SEEK_NEEDED_BUFFERS_IN_SECONDS > end
        )
    const shouldUnbufferChunks =
      chunks
        .filter(chunk => !neededChunks.includes(chunk))

    if (sourceBuffer.updating) await abort()
    for (const chunk of shouldUnbufferChunks) {
      if (!chunk.buffered) continue
      try {
        await removeChunk(chunk)
      } catch (err) {
        if (err.message !== 'No TimeRange found with this chunk') throw err
      }
    }
    for (const chunk of neededChunks) {
      if (
        chunk.buffered
        || (
          processedBytes !== typedArrayBuffer.byteLength
          && chunk.id + 1 === chunks.length
        )
      ) continue
      await appendChunk(chunk)
    }
    // for (const chunk of neededChunks) {
    //   if (
    //     chunk.buffered
    //     || (
    //       !done
    //       && chunk.id + 1 === chunks.length
    //     )
    //   ) continue
    //   await appendChunk(chunk)
    // }
  }, 10)

  video.addEventListener('seeking', myEfficientFn)

  video.addEventListener('timeupdate', () => {
    // console.log('timeupdate', video.currentTime)
    myEfficientFn()
  })

  await appendChunk(chunks[0])

  // for (const chunk of chunks) {
  //   await appendChunk(chunk)
  // }

  // if (chunks.length) await appendChunk(chunks[0])
  // if (chunks.length) await appendChunk(chunks[1])
})
