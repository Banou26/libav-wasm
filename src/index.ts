import PQueue from 'p-queue'
import type { Resolvers } from './worker'
import type { SubtitleFragment } from './worker'

import { expose } from 'osra'
export * from './utils'

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  getStream: (offset: number, size?: number) => Promise<ReadableStream<Uint8Array>>
  length: number
  bufferSize: number
}

const abortSignalToPromise = (abortSignal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (abortSignal.aborted) {
      return reject()
    }
    abortSignal.addEventListener('abort', () => {
      reject()
    })
  })

export const makeRemuxer = async ({
  publicPath,
  workerUrl,
  workerOptions, 
  getStream,
  length,
  bufferSize = 1_000_000
}: MakeTransmuxerOptions) => {
  const worker = new Worker(workerUrl, workerOptions)

  const { makeRemuxer } = await expose<Resolvers>({}, { remote: worker, local: worker })

  let currentStream: ReadableStream<Uint8Array> | undefined
  let currentStreamOffset: number | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined

  const read = async (offset: number, size?: number) => {
    if (
      !currentStream ||
      (currentStreamOffset && currentStreamOffset + bufferSize !== offset)
    ) {
      reader?.cancel()
      currentStream = await getStream(offset)
      reader = currentStream.getReader() as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
    }

    if (!reader) throw new Error('No reader found')

    currentStreamOffset = offset

    return reader.read().then(({ value }) => value?.buffer ?? new ArrayBuffer(0))
  }

  const remuxer = await makeRemuxer({
    publicPath,
    length,
    bufferSize,
    log: async (isError, text) => {
      if (isError) console.error(text)
      else console.log(text)
    }
  })

  
  const queue = new PQueue({ concurrency: 1, timeout: 10_000, throwOnTimeout: true })

  const wasmRead = (abortController: AbortController) => (offset: number, size: number) => {
    if (abortController.signal.aborted) return Promise.resolve({ resolved: new Uint8Array(0).buffer, rejected: true })
    return Promise.race([
      read(Number(offset), Number(size))
        .then(
          buffer => ({ resolved: new Uint8Array(buffer).buffer, rejected: false }),
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true })
        ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true }),
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true })
        )
    ])
  }

  let abortControllers: AbortController[] = []

  const addTask = <T extends (abortController: AbortController) => Promise<any>>(func: T) => {
    const currentAbortControllers = [...abortControllers]
    abortControllers = []
    queue.clear()
    currentAbortControllers.forEach(abortController => abortController.abort())
    const abortController = new AbortController()
    abortControllers = [...abortControllers, abortController]
    return Promise.race([
      queue.add<Awaited<ReturnType<T>>>(
        async () => func(abortController),
        { signal: abortController.signal }
      ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => Promise.reject(new Error('Cancelled')),
          () => Promise.reject(new Error('Cancelled'))
        )
    ])
  }

  return {
    worker,
    init: () => addTask((abortController) => remuxer.init(wasmRead(abortController))),
    destroy: async () => {
      try {
        await reader?.cancel()
      } catch (err) {}
      reader = undefined
      currentStream = undefined
      currentStreamOffset = undefined
      const currentAbortControllers = [...abortControllers]
      abortControllers = []
      queue.clear()
      currentAbortControllers.forEach(abortController => abortController.abort())
      await remuxer.destroy()
      worker.terminate()
    },
    seek: (timestamp: number) => addTask((abortController) => remuxer.seek(wasmRead(abortController), timestamp)),
    read: () => addTask((abortController) => remuxer.read(wasmRead(abortController))),
    extractThumbnail: (timestamp: number, maxWidth: number = 0, maxHeight: number = 0) =>
      console.log('thumbnail start') ||
      addTask((abortController) => 
        remuxer.extractThumbnail(
          wasmRead(abortController), 
          timestamp, 
          maxWidth, 
          maxHeight
        )
      ).then(result => {
        console.log('thumbnail computed')
        // Convert the raw RGB data to a Blob that can be used as an image source
        const { data, width, height } = result
        
        // Create a canvas to convert RGB data to PNG
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        
        if (!ctx) {
          throw new Error('Could not get canvas context')
        }
        
        // Create ImageData from the RGB buffer
        const imgData = ctx.createImageData(width, height)
        const rgbData = new Uint8Array(data)
        
        // Convert RGB to RGBA (canvas requires alpha channel)
        for (let i = 0, j = 0; i < rgbData.length; i += 3, j += 4) {
          imgData.data[j] = rgbData[i]         // R
          imgData.data[j + 1] = rgbData[i + 1] // G
          imgData.data[j + 2] = rgbData[i + 2] // B
          imgData.data[j + 3] = 255            // A (fully opaque)
        }
        
        // Put the image data on the canvas
        ctx.putImageData(imgData, 0, 0)
        console.log('thumbnail rendered')
        
        // Return both the canvas and a promise that resolves to a Blob
        return {
          canvas,
          width,
          height,
          toBlob: (type = 'image/png', quality = 0.9) => new Promise<Blob>((resolve) => {
            canvas.toBlob((blob) => {
              if (blob) resolve(blob)
              else throw new Error('Failed to create blob from canvas')
            }, type, quality)
          }),
          toDataURL: (type = 'image/png', quality = 0.9) => canvas.toDataURL(type, quality)
        }
      })
  }
}
