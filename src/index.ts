interface Chunk {
  id: number
  start: number
  end: number
  buffered: boolean
}

const BUFFER_SIZE = 5_000_000
const PUSH_ARRAY_SIZE = 10_000_000

let libavInstance

export const remux =
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

    const [resultStream, controller] = await new Promise<[ReadableStream<Uint8Array>, ReadableStreamDefaultController<any>]>(resolve => {
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

      const result = new Uint8Array(remuxer.getInt8Array())
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
