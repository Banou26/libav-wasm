import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'

export type SubtitleFragment =
  | {
    type: 'header'
    streamIndex: number
    data: string
    format: string[]
    language: string
    title: string
  }
  | {
    type: 'dialogue'
    streamIndex: any
    startTime: number
    endTime: number
    dialogueIndex: number
    layer: number
    dialogue: string
    fields: Record<string, string>
  }


export type RemuxerOptions = {
  promise: Promise<void>
  length: number
  bufferSize: number
  subtitle: (streamIndex: number, isHeader: T, data: string, ...rest: T extends true ? [string, string] : [number, number]) => void
  attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => void
  read: (offset: string) => Promise<{ buffer: Uint8Array | undefined, done: boolean, cancelled: boolean }>
  write: (buffer: ArrayBuffer) => void
  flush: (offset: number, position: number, pts: number, duration: number, isTrailer: boolean) => void
}

export interface RemuxerInstance {
  new(options: RemuxerOptions): RemuxerInstance
  init: () => Promise<void>
  destroy: () => void
  seek: (timestamp: number) => Promise<void>
  read: () => Promise<void>
  getInfo: () => ({
    input: {
      formatName: string
      mimeType: string
      duration: number
      video_mime_type: string
      audio_mime_type: string
    },
    output: {
      formatName: string
      mimeType: string
      duration: number
      video_mime_type: string
      audio_mime_type: string
    }
  })
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    printErr: (text: string) => log(true, text),
  }) as Promise<{ Remuxer: RemuxerInstance }>

type Fragment = {
  buffer: ArrayBuffer
  offset: number
  position: number
  pts: number
  duration: number
  isTrailer: boolean
}

// converts ms to 'h:mm:ss.cc' format
const convertTimestamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .slice(11, 22)
    .replace(/^00/, '0')

const resolvers = {
  makeRemuxer: async (
    { publicPath, length, bufferSize, log, read, attachment, subtitle, fragment }:
    {
      publicPath: string
      length: number
      bufferSize: number
      log: (isError: boolean, text: string) => Promise<void>
      read: (offset: number) => Promise<{ buffer: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>
      subtitle: (subtitleFragment: SubtitleFragment) => Promise<void>
      // subtitle: <T extends boolean>(streamIndex: number, isHeader: T, data: string, ...rest: T extends true ? [string, string] : [number, number]) => void
      attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
      fragment: (fragment: Fragment) => Promise<void>
    }
  ) => {
    const { Remuxer } = await makeModule(publicPath, log)

    let writeBuffer = new Uint8Array(0)
    const subtitleHeaders = new Map<number, SubtitleFragment & { type: 'header' }>()

    const remuxer = new Remuxer({
      promise: Promise.resolve(),
      length,
      bufferSize,
      subtitle: (streamIndex, isHeader, data, ...rest) => {
        if (isHeader) {
          const lines = data.split('\n')
          const eventsFormatStartIndex = lines.findIndex((line) => line.startsWith('[Events]'))
          const format =
            lines
              .slice(eventsFormatStartIndex)
              .find((line) => line.startsWith('Format:'))
              ?.split(':')
              [1]
              .split(',')
              .map((value) => value.trim())

          if (!format) throw new Error('Subtitle format not found')

          const header = {
            type: 'header',
            streamIndex,
            data,
            format,
            language: rest[0] as string,
            title: rest[1] as string
          } as const

          subtitleHeaders.set(streamIndex, header)

          subtitle(header)
        } else {
          const header = subtitleHeaders.get(streamIndex)
          if (!header) throw new Error('Subtitle header not found')
          const dialogueContent =
            [
              // layer
              data.split(',')[1],
              // start time
              convertTimestamp(rest[0] as number),
              // end time
              convertTimestamp(rest[1] as number),
              // dialogue content, generally [Style, Name, MarginL, MarginR, MarginV, Effect, Text]
              data.replace(`${data.split(',')[0]},${data.split(',')[1]},`, '')
            ]
              .join(',')

          const separatorIndexes =
            [...dialogueContent]
              .map((char, index) => char === ',' ? index : undefined)
              .filter((value): value is number => value !== undefined)

          const formatSlices =
            [0, ...separatorIndexes]
              .map((charIndex, index, indexArr) =>
                dialogueContent.slice(
                  index === 0 ? 0 : charIndex + 1,
                  indexArr.length - 2 === index ? undefined : indexArr[index + 1]
                )
              )
              .filter((value): value is string => value !== undefined)
              .filter((value) => value.length)

          const fields = Object.fromEntries(
            header
              .format
              .map((key, index) => [key, formatSlices[index]])
              .filter(([key, value]) => key && value)
          )

          subtitle({
            type: 'dialogue',
            streamIndex,
            startTime: rest[0] as number,
            endTime: rest[1] as number,
            dialogueIndex: Number(data.split(',')[0]),
            layer: Number(data.split(',')[1]),
            dialogue: `Dialogue: ${dialogueContent}`,
            fields
          })
        }
      },
      attachment: (filename, mimetype, buffer) => {
        // We need to create a new buffer since the argument buffer is attached to the WASM's memory
        const uint8 = new Uint8Array(buffer)
        attachment(filename, mimetype, uint8.buffer)
      },
      read: (offset) =>
        read(Number(offset))
          .then(({ buffer, done, cancelled }) => ({
            buffer: buffer ? new Uint8Array(buffer) : undefined,
            done,
            cancelled
          }))
          .catch(() => ({
            cancelled: true,
            done: false,
            buffer: undefined
          })),
      write: (buffer) => {
        const newBuffer = new Uint8Array(writeBuffer.byteLength + buffer.byteLength)
        newBuffer.set(writeBuffer)
        newBuffer.set(new Uint8Array(buffer), writeBuffer.byteLength)
        writeBuffer = newBuffer
      },
      flush: async (_offset, _position, pts, duration, isTrailer) => {
        const offset = Number(_offset)
        const position = Number(_position)
        if (!writeBuffer.byteLength) return true
        fragment({
          isTrailer,
          offset,
          buffer: writeBuffer.buffer,
          position,
          pts,
          duration
        })
        writeBuffer = new Uint8Array(0)
      }
    })

    return {
      init: () => remuxer.init(),
      destroy: async () => remuxer.destroy(),
      seek: (timestamp: number) => remuxer.seek(timestamp),
      read: () => remuxer.read(),
      getInfo: async () => remuxer.getInfo()
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { remote: globalThis, local: globalThis })
