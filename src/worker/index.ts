import { makeCallListener, registerListener } from 'osra'

// @ts-ignore
import WASMModule from 'libav'

console.log('WASMModule', WASMModule)

import { SEEK_FLAG, SEEK_WHENCE_FLAG } from '../utils'

const makeModule = (publicPath: string) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    env: {
      memoryBase: 0,
      tableBase: 0,
      memory: new WebAssembly.Memory({initial: 256}),
      table: new WebAssembly.Table({initial: 0, element: 'anyfunc'})
    },
    imports: {
        imported_func: function(arg) {
            console.log(arg);
        }
    }
  })

let module: ReturnType<typeof makeModule>

// todo: if seek latency is too slow, because of destroy + init + seek + process, we can use multiple transmuxer already initialized waiting to seek + process
// todo: We can keep in memory all of the chunks needed to initialize the transmuxer

// @ts-ignore
const init = makeCallListener(async (
  { publicPath, length, bufferSize, read, seek, write, attachment, subtitle }:
  {
    publicPath: string
    length: number
    bufferSize: number
    read: (offset: number, size: number) => Promise<ArrayBuffer>
    write: (params: {
      offset: number, arrayBuffer: ArrayBuffer, timebaseNum: number,
      timebaseDen: number, lastFramePts: number, lastFrameDuration: number,
      keyframeDuration: number, keyframePts: number, keyframePos: number,
      bufferIndex: number
    }) => Promise<void> | void
    seek: (currentOffset: number, offset: number, whence: SEEK_WHENCE_FLAG) => Promise<number>
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => Promise<void>
    attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => Promise<void>
  }) => {
  console.log('making module')
  if (!module) module = await makeModule(publicPath)
  console.log('made module')
  let currentOffset = 0
  const makeTransmuxer = () => new module.Transmuxer({
    length,
    bufferSize,
    error: (critical: boolean, message: string) => {
      console.log('worker error', critical, message)
    },
    subtitle: (streamIndex: number, isHeader: boolean, data: string, ...rest: [number, number] | [string, string]) => {
      subtitle(streamIndex, isHeader, data, ...rest)
    },
    attachment: (filename: string, mimetype: string, _buffer: Uint8Array) => {
      const uint8 = structuredClone(_buffer) as Uint8Array
      const arraybuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
      attachment(filename, mimetype, arraybuffer)
    },
    seek: async (offset: number, whence: SEEK_WHENCE_FLAG) => seek(currentOffset, offset, whence),
    read: async (offset: number, bufferSize: number) => {
      const buffer = await read(offset, bufferSize)
      console.log('read buffer', buffer)
      return {
        buffer,
        size: buffer.byteLength
      }
    },
    write: (
      offset: number, buffer: Uint8Array, timebaseNum: number,
      timebaseDen: number, lastFramePts: number, lastFrameDuration: number,
      keyframeDuration: number, keyframePts: number, keyframePos: number,
      bufferIndex: number
    ) => write({
      offset, arrayBuffer: new Uint8Array(structuredClone(buffer)).buffer, timebaseNum,
      timebaseDen, lastFramePts, lastFrameDuration,
      keyframeDuration, keyframePts, keyframePos,
      bufferIndex
    })
  })

  console.log('making transmuxer')
  let transmuxer: ReturnType<typeof makeTransmuxer> = makeTransmuxer()
  console.log('made transmuxer')

  let firstInit = true
  return {
    init: async () => {
      console.log('worker init')
      currentOffset = 0
      module = await makeModule(publicPath)
      transmuxer = makeTransmuxer()
      await transmuxer.init(firstInit)
      if (firstInit) firstInit = false
    },
    destroy: () => {
      transmuxer.destroy()
      transmuxer = undefined
      module = undefined
      currentOffset = 0
    },
    seek: (timestamp: number, flags: SEEK_FLAG) => transmuxer.seek(timestamp, flags),
    process: (size: number) => transmuxer.process(size),
    getInfo: () => transmuxer.getInfo()
  }
})

const resolvers = {
  init
}

export type Resolvers = typeof resolvers

registerListener({
  target: globalThis as unknown as Worker,
  // @ts-ignore
  resolvers
})

globalThis.postMessage('init')
