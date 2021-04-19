import { createFile } from 'mp4box'

interface Chunk {
  id: number
  start: number
  end: number
  buffered: boolean
}

enum MediaBufferOperation {
  APPEND = 'APPEND',
  REMOVE = 'REMOVE'
}

const REMOVE_BUFFER_NO_TIMERANGE_FOUND = 'No TimeRange found with this chunk'

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

    // todo: (THIS IS A REALLY UNLIKELY CASE OF IT ACTUALLY HAPPENING) change the way leftOverData works to handle if arrayBuffers read are bigger than PUSH_ARRAY_SIZE
    const processData = (initOnly = false) => {
      if (!isInitialized) {
        remuxer.init(BUFFER_SIZE)
        isInitialized = true
        if (initOnly) return
      }
      remuxer.process()
      remuxer.clearInput()

      const result = remuxer.getInt8Array()
      // todo: handle if initOnly is true, it won't apply the mp4 header
      if (!isInitialized) {
        result.set([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D], 0)
      }
      remuxer.clearOutput()
      controller.enqueue(result)
      if (leftOverData) {
        buffer.set(leftOverData, 0)
        currentBufferBytes += leftOverData.byteLength
        leftOverData = undefined
      }
      if (processedBytes === size) {
        remuxer.close()
        controller.close()
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
      if (!paused && !done) readData(autoProcess)
    }

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

function throttleDebounce(cb, timeout) {
  let lastRun = -timeout
  let timeoutId

  const runCb = (...args) => {
    lastRun = performance.now()
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = undefined
    }
    cb(...args)
  }
  return (...args) => {
    if (lastRun + timeout <= performance.now()) {
      runCb(...args)
      return
    }
    if (timeoutId) return
    timeoutId = setTimeout(() => runCb(...args), lastRun + timeout - performance.now())
  }
}

fetch('./video2.mkv')
  .then(async ({ headers, body }) => {
    const fileSize = Number(headers.get('Content-Length'))
    const { stream, getInfo } = await remux({ size: fileSize, stream: body, autoStart: true })
    const reader = stream.getReader()
    let resultBuffer = new Uint8Array(fileSize + (fileSize * 0.01))
    let processedBytes = 0

    let mp4boxfile = createFile()
    mp4boxfile.onError = e => console.error('onError', e)
    const chunks: Chunk[] = []

    mp4boxfile.onSamples = (id, user, samples) => {
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
    const read = async () => {
      const { value: arrayBuffer, done } = await reader.read()
      if (done) {
        resultBuffer = resultBuffer.slice(0, processedBytes)
        const el = document.createElement('div')
        el.innerText = 'Done'
        document.body.appendChild(el)
        return
      }

      const buffer = arrayBuffer.slice(0).buffer
      // @ts-ignore
      buffer.fileStart = processedBytes
      mp4boxfile.appendBuffer(buffer)

      resultBuffer.set(arrayBuffer, processedBytes)
      processedBytes += arrayBuffer.byteLength
      if (!first) {
        first = true
        return read()
      }
      read()
    }

    await read()

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

    let resolve, reject, abortResolve, operation

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
        operation = MediaBufferOperation.APPEND
        resolve = _resolve
        reject = _reject
        sourceBuffer.appendBuffer(buffer)
      }).finally(() => {
        operation = undefined
      })

    const removeRange = ({ start, end, index }: { start: number, end: number, index: number }) =>
      new Promise((_resolve, _reject) => {
        resolve = _resolve
        reject = _reject
        const maxStart = Math.max(sourceBuffer.buffered.start(index), start)
        const minEnd = Math.min(sourceBuffer.buffered.end(index), end)
        operation = MediaBufferOperation.REMOVE
        sourceBuffer.remove(
          maxStart,
          minEnd
        )
      }).finally(() => {
        operation = undefined
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
      if (!range) throw new RangeError(REMOVE_BUFFER_NO_TIMERANGE_FOUND)
      await removeRange({ start: chunk.start, end: chunk.end, index: range.index })
      chunk.buffered = false
    }

    const abort = () =>
      new Promise(resolve => {
        abortResolve = resolve
        sourceBuffer.abort()
      })

    sourceBuffer.addEventListener('updateend', ev => {
      resolve(ev)
      resolve = undefined
      reject = undefined
      abortResolve = undefined
    })
    sourceBuffer.addEventListener('abort', ev => {
      reject(ev)
      abortResolve(ev)
      resolve = undefined
      reject = undefined
      abortResolve = undefined
    })
    sourceBuffer.addEventListener('error', ev => reject(ev))

    const initializationBuffer = resultBuffer.buffer.slice(0, mp4boxfile.moov.start + mp4boxfile.moov.size)
    await appendBuffer(initializationBuffer)

    const PRE_SEEK_NEEDED_BUFFERS_IN_SECONDS = 15
    const POST_SEEK_NEEDED_BUFFERS_IN_SECONDS = 30


    // todo: Just replace seek's throttling function with a function that never skips an input and just abort the last operations
    // todo: also free mp4box's memory


    let currentSeek
    let seekIdCounter = 0
    const seek = throttleDebounce(async (...args) => {
      seekIdCounter++
      const id = seekIdCounter
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
        if (seekIdCounter !== id) return
        if (!chunk.buffered) continue
        try {
          await removeChunk(chunk)
        } catch (err) {
          if (err.message !== REMOVE_BUFFER_NO_TIMERANGE_FOUND) throw err
        }
      }
      for (const chunk of neededChunks) {
        if (seekIdCounter !== id) return
        if (
          chunk.buffered
          || (
            processedBytes !== fileSize
            && chunk.id + 1 === chunks.length
          )
        ) continue
        // try {
          await appendChunk(chunk)
        // } catch (err) {
        //   console.error('APPEND CHUNK ERROR')
        //   // if (!(err instanceof Event)) throw err
        //   // if (err.message !== 'Failed to execute \'appendBuffer\' on \'SourceBuffer\': This SourceBuffer is still processing an \'appendBuffer\' or \'remove\' operation.') throw err
        //   break
        // }
      }
    }, 100)

    video.addEventListener('seeking', (...args) => {
      seek(...args)
    })
    video.addEventListener('timeupdate', (...args) => {
      seek(...args)
    })

    await appendChunk(chunks[0])
  })
