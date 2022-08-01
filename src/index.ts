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

const BUFFER_SIZE = 10_000_000
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

export type Info = {
  input: {
    formatName: string
    mimeType: string
    duration: number
  }
  output: {
    formatName: string
    mimeType: string
    duration: number
  }
}

export type RemuxResponse = {
  // headerChunks,
  // chunks,
  stream: ReadableStream<Uint8Array>,
  info: Info
}

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
        if (bufferLeft.byteLength > buffer.byteLength) {
          buffer.set(bufferLeft.slice(0, buffer.byteLength))
          position += buffer.byteLength
          bufferLeft = bufferLeft.slice(buffer.byteLength)
          controller.enqueue(buffer)
          return
        } else {
          buffer.set(bufferLeft)
          position += bufferLeft.byteLength
          bufferLeft = undefined
        }
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
          position += neededLength
        }
      }
      controller.enqueue(buffer)
    },
    cancel(reason) {
      return stream.cancel(reason)
    }
  })
}

// todo: currently fix issue with wrong DTS: happening on https://dev.fkn.app/app/616331fa7b57db93f0957a18/watch/mal:50265/mal:50265-1/nyaa:1512518 or http://localhost:1234/app/616331fa7b57db93f0957a18/title/mal:48895/mal:48895-3
// for this issue, looking at the timestamp correction code in https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffmpeg.c#L1858 & https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffmpeg.c#L3914 could be useful
// also maybe https://github.com/mpv-player/mpv/issues/7524

// todo: reimplement this into a ReadableByteStream https://web.dev/streams/ once FF gets support
// todo: impl the mime generator from https://developer.mozilla.org/en-US/docs/Web/Media/Formats/codecs_parameter | https://superuser.com/questions/1494831/extract-mime-type-codecs-for-mediasource-using-ffprobe#comment2431440_1494831
export const remux =
  async (
    { size, stream, autoStart = false, autoProcess = true }:
    { size: number, stream: ReadableStream<Uint8Array>, autoStart?: boolean, autoProcess?: boolean }
  ): Promise<RemuxResponse> => {
    const libav = libavInstance ?? (libavInstance = await (await import('../dist/libav.js'))())
    const sizedChunksStream = bufferStreamChunksToSize(stream, PUSH_ARRAY_SIZE)
    const reader = sizedChunksStream.getReader()
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

    let { value: currentBuffer, done: initDone } = await reader.read()
    let readCount = 0
    let closed = false
    let currentOffset = 0
    const headerChunks = []
    const chunks = []
    let headerChunkEnqueued = false
    const remuxer = new libav.Remuxer({
      length: size,
      bufferSize: BUFFER_SIZE,
      // https://gist.github.com/AlexVestin/15b90d72f51ff7521cd7ce4b70056dff#file-avio_write-c-L51
      seek: (offset: number, whence: SEEK_WHENCE_FLAG) => {
        // prevent seeking for now, once i wanna retry re-implementing seeking i can remove it then
        // maybe https://stackoverflow.com/a/17213878 could be of big help if i manage to unstuck libav from the end of file status
        return -1

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
        if (whence === SEEK_WHENCE_FLAG.AVSEEK_SIZE) {
          return size;
        }
        currentOffset = offset
        const result = currentOffset
        currentBuffer = new Uint8Array(currentBuffer.slice(currentOffset, currentOffset + PUSH_ARRAY_SIZE))
        readCount = 0
        return result
      },
      read: (bufferSize: number) => {
        const buffer =
          readCount === 0
            ? currentBuffer.slice(0, BUFFER_SIZE)
            : currentBuffer.slice(BUFFER_SIZE)
        readCount++
        if (readCount === 2) {
          readCount = 0
        }
        return {
          buffer,
          size: buffer.byteLength
        }
      },
      write: (type, keyframeIndex, size, offset, arrayBuffer, keyframePts, keyframePos, done) => {
        const buffer = new Uint8Array(arrayBuffer.slice())
        if (keyframeIndex < 0) {
          headerChunks.push({ keyframeIndex, size, offset, arrayBuffer: buffer, pts: keyframePts, pos: keyframePos, done })
          return
        } else {
          // chunks.push({ keyframeIndex, size, offset, arrayBuffer: undefined, pts: keyframePts, pos: keyframePos, done })
        }
        if (closed) return
        if (done) {
          closed = true
          if (buffer.byteLength) controller.enqueue(buffer)
          controller.close()
        } else {
          if (!headerChunkEnqueued) {
            const headerChunk = new Uint8Array(headerChunks.map(chunk => chunk.arrayBuffer.byteLength).reduce((acc, length) => acc + length, 0))
            let currentSize = 0
            for (const chunk of headerChunks) {
              headerChunk.set(chunk.arrayBuffer, currentSize)
              currentSize += chunk.arrayBuffer.byteLength
            }
            controller.enqueue(headerChunk)
            headerChunkEnqueued = true
            headerChunks.splice(0, headerChunks.length)
          }
          controller.enqueue(buffer)
        }
      }
    })
    remuxer.init()
    
    // const headerChunks = chunks.splice(0, chunks.length).map((chunk, i) => ({ ...chunk, keyframeIndex: i }))
    const process = async () => {
      readCount = 0
      if (!headerChunkEnqueued) {
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

    const info = remuxer.getInfo()

    return {
      // seek: (timestamp: number, flags: SEEK_FLAG) => {
      //   // currentBuffer = new Uint8Array(fullBuffer.slice(timestamp, timestamp + PUSH_ARRAY_SIZE))
      //   // console.log('JS SEEK TIMESTAMP', timestamp)
      //   // remuxer.seek(timestamp, flags)
      //   // remuxer.process(currentBuffer.byteLength)
      // },
      // headerChunk,
      // headerChunks,
      // chunks,
      stream: resultStream,
      info: {
        input: {
          ...info.input,
          duration: info.input.duration / 1_000_000
        },
        output: {
          ...info.output,
          duration: info.output.duration / 1_000_000
        }
      }
      // getInfo: () => remuxer.getInfo()
    }
  }
