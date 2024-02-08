
export enum State {
  Idle = 0,
  Requested = 1,
  Responded = 2
}

/** https://ffmpeg.org/doxygen/trunk/avformat_8h.html#ac736f8f4afc930ca1cda0b43638cc678 */
export enum SEEK_FLAG {
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

export enum SEEK_WHENCE_FLAG {
  SEEK_SET = 0,
  SEEK_CUR = 1 << 0,
  SEEK_END = 1 << 1,
  AVSEEK_SIZE = 1 << 16 //0x10000,
}

export enum AVERROR {
  EOF = -541478725,
  EXIT = 255
}

export const notifyInterface = (sharedArrayBuffer: SharedArrayBuffer, value: State) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  int32Array.set([value], 0)
  return Atomics.notify(int32Array, 0)
}

export const waitForInterfaceNotification = (
  sharedArrayBuffer: SharedArrayBuffer,
  value: State
): Promise<'ok' | 'timed-out'> | 'not-equal' => {
    const int32Array = new Int32Array(sharedArrayBuffer)
    const result = Atomics.waitAsync(int32Array, 0, value as unknown as bigint, 1_000)

    if (result.value === 'not-equal') {
      return result.value
    }
    return result.value as Promise<"ok" | "timed-out">
  }

export const waitSyncForInterfaceNotification = (sharedArrayBuffer: SharedArrayBuffer, value: State) => {
  const int32Array = new Int32Array(sharedArrayBuffer)
  return Atomics.wait(int32Array, 0, value)
}

export const freeInterface = (sharedArrayBuffer: SharedArrayBuffer) => new Uint8Array(sharedArrayBuffer).fill(0)

export const queuedDebounceWithLastCall = <T2 extends any[], T extends (...args: T2) => any>(time: number, func: T) => {
  let runningFunction: Promise<ReturnType<T>> | undefined
  let lastCall: Promise<ReturnType<T>> | undefined
  let lastCallArguments: T2 | undefined

  const checkForLastCall = (
    timeStart: number,
    resolve: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void,
    reject: (reason?: any) => void
  ) =>
    (result: ReturnType<T>) => {
      const currentTime = performance.now()
      setTimeout(() => {
        if (!lastCallArguments) {
          runningFunction = undefined
          lastCall = undefined
          return
        }
        const funcResult = (async () => (func(...lastCallArguments)))()
        lastCallArguments = undefined
        funcResult
          .then(resolve)
          .catch((err) => {
            console.error(err)
            reject(err)
          })

        let _resolve: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void
        let _reject: (reason?: any) => void
        lastCall = new Promise((resolve, reject) => {
          _resolve = resolve
          _reject = reject
        })
  
        runningFunction =
          funcResult
            // @ts-ignore
            .then(checkForLastCall(currentTime, _resolve, _reject))
            // @ts-ignore
            .catch(err => {
              console.error(err)
              return checkForLastCall(timeStart, _resolve, _reject)(err)
            })
      }, time - (currentTime - timeStart))
      return result
    }

  return (...args: Parameters<T>) => {
    lastCallArguments = args
    if (!runningFunction) {
      const timeStart = performance.now()
      const funcResult = (async () => (func(...args)))()
      lastCallArguments = undefined
      let _resolve: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void
      let _reject: (reason?: any) => void
      lastCall = new Promise((resolve, reject) => {
        _resolve = resolve
        _reject = reject
      })

      runningFunction =
        funcResult
            // @ts-ignore
          .then(checkForLastCall(timeStart, _resolve, _reject))
            // @ts-ignore
          .catch(err => {
            console.error(err)
            return checkForLastCall(timeStart, _resolve, _reject)(err)
          })

      return funcResult
  } else {
      return lastCall
    }
  }
}

// todo: reimplement this into a ReadableByteStream https://web.dev/streams/ once Safari gets support
export const toStreamChunkSize = (SIZE: number) => (stream: ReadableStream) =>
  new ReadableStream<Uint8Array>({
    reader: undefined,
    leftOverData: undefined,
    start() {
      this.reader = stream.getReader()
    },
    async pull(controller) {
      // console.log('pull', this.reader, this.leftOverData?.byteLength)
      const { leftOverData }: { leftOverData: Uint8Array | undefined } = this

      const accumulate = async ({ buffer = new Uint8Array(SIZE), currentSize = 0 } = {}): Promise<{ buffer?: Uint8Array, currentSize?: number, done: boolean }> => {
        // console.log('accumulate')
        const { value: newBuffer, done } = await this.reader!.read()
        // console.log('accumulate2', newBuffer, done)
        
        if (currentSize === 0 && leftOverData) {
          buffer.set(leftOverData)
          currentSize += leftOverData.byteLength
          this.leftOverData = undefined
        }
  
        if (done) {
          const finalResult = { buffer: buffer.slice(0, currentSize), currentSize, done }
          this.reader = undefined
          this.leftOverData = undefined
          return finalResult
        }
  
        let newSize
        const slicedBuffer = newBuffer.slice(0, SIZE - currentSize)
        newSize = currentSize + slicedBuffer.byteLength
        buffer.set(slicedBuffer, currentSize)
  
        if (newSize === SIZE) {
          this.leftOverData = newBuffer.slice(SIZE - currentSize)
          return { buffer, currentSize: newSize, done: false }
        }
        
        return accumulate({ buffer, currentSize: newSize })
      }
      const { buffer, done } = await accumulate()
      if (buffer?.byteLength) controller.enqueue(buffer)
      if (done) controller.close()
    },
    cancel() {
      this.reader!.cancel()
      this.leftOverData = undefined
    }
  } as UnderlyingDefaultSource<Uint8Array> & {
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    leftOverData: Uint8Array | undefined
  })

export const toBufferedStream = (SIZE: number) => (stream: ReadableStream) =>
  new ReadableStream<Uint8Array>({
    buffers: [],
    currentPullPromise: undefined,
    reader: undefined,
    leftOverData: undefined,
    start() {
      this.reader = stream.getReader()
    },
    async pull(controller) {
      const pull = async () => {
        if (this.buffers.length >= SIZE) return
        this.currentPullPromise = this.reader!.read()
        const { value: newBuffer, done } = await this.currentPullPromise
        this.currentPullPromise = undefined
        if (done) {
          try {
            controller.close()
          } catch (err) {
            // console.error(err)
          }
          return
        }
        this.buffers.push(newBuffer)
        return newBuffer
      }

      const tryToBuffer = async (): Promise<void> => {
        if (this.buffers.length >= SIZE) return
        
        if (this.buffers.length === 0) {
          const buffer = await pull()
          if (!buffer) return
          return tryToBuffer()
        } else {
          pull().then((buffer) => {
            if (!buffer) return
            tryToBuffer()
          })
        }
      }

      await tryToBuffer()
      controller.enqueue(this.buffers.shift())
      tryToBuffer()
    },
    cancel() {
      this.reader!.cancel()
    }
  } as UnderlyingDefaultSource<Uint8Array> & {
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    leftOverData: Uint8Array | undefined
    buffers: Uint8Array[]
    currentPullPromise: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  })
