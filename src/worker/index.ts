import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'

export type RemuxerOptions = {
  promise: Promise<void>
  length: number
  bufferSize: number
  subtitle: <T extends boolean>(streamIndex: number, isHeader: T, data: string, ...rest: T extends true ? [string, string] : [number, number]) => void
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

const resolvers = {
  makeRemuxer: async (
    { publicPath, length, bufferSize, log, read, attachment, subtitle, fragment }:
    {
      publicPath: string
      length: number
      bufferSize: number
      log: (isError: boolean, text: string) => Promise<void>
      read: (offset: number) => Promise<{ buffer: ArrayBuffer | undefined, done: boolean, cancelled: boolean }>
      subtitle: <T extends boolean>(streamIndex: number, isHeader: T, data: string, ...rest: T extends true ? [string, string] : [number, number]) => void
      attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
      fragment: (fragment: Fragment) => Promise<void>
    }
  ) => {
    const { Remuxer } = await makeModule(publicPath, log)

    let writeBuffer = new Uint8Array(0)

    const remuxer = new Remuxer({
      promise: Promise.resolve(),
      length,
      bufferSize,
      subtitle: (streamIndex, isHeader, data, ...rest) => subtitle(streamIndex, isHeader, data, ...rest),
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
