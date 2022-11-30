
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
        const funcResult = func(...lastCallArguments)
        lastCallArguments = undefined
        Promise
          .resolve(funcResult)
          .then(resolve)
          .catch(reject)

        let _resolve: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void
        let _reject: (reason?: any) => void
        lastCall = new Promise((resolve, reject) => {
          _resolve = resolve
          _reject = reject
        })
  
        // wrap the result in a promise in case the function doesn't return a promise
        runningFunction =
          Promise
            .resolve(funcResult)
            // @ts-ignore
            .then(checkForLastCall(currentTime, _resolve, _reject))
      }, time - currentTime - timeStart)
      return result
    }

	return (...args: Parameters<T>) => {
    lastCallArguments = args
		if (!runningFunction) {
      const timeStart = performance.now()
      const funcResult = func(...lastCallArguments)
      
      let _resolve: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void
      let _reject: (reason?: any) => void
      lastCall = new Promise((resolve, reject) => {
        _resolve = resolve
        _reject = reject
      })

      // wrap the result in a promise in case the function doesn't return a promise
      runningFunction =
        Promise
          .resolve(funcResult)
          // @ts-ignore
          .then(checkForLastCall(timeStart, _resolve, _reject))

      return Promise.resolve(funcResult)
		} else {
      return lastCall
    }
	}
}

setTimeout(() => {
  let i = 0
  const throttled = queuedDebounceWithLastCall(1000, () => {
    const _i = i
    i = i + 1
    console.log('throttled called', _i)
    // await new Promise(resolve => setTimeout(resolve, 500))
    return _i
  })

  const interval = setInterval(async () => {
    console.log('call throttled', await throttled())
  }, 50)

  setTimeout(() => {
    clearInterval(interval)
  }, 1200)
})

// todo: reimplement this into a ReadableByteStream https://web.dev/streams/ once FF gets support
export const bufferStream = ({ stream, size: SIZE }: { stream: ReadableStream, size: number }) =>
  new ReadableStream<Uint8Array>({
    start() {
      // @ts-ignore
      this.reader = stream.getReader()
    },
    async pull(controller) {
      // @ts-ignore
      const { leftOverData }: { leftOverData: Uint8Array | undefined } = this

      const accumulate = async ({ buffer = new Uint8Array(SIZE), currentSize = 0 } = {}): Promise<{ buffer?: Uint8Array, currentSize?: number, done: boolean }> => {
        // @ts-ignore
        const { value: newBuffer, done } = await this.reader.read()
  
        if (currentSize === 0 && leftOverData) {
          buffer.set(leftOverData)
          currentSize += leftOverData.byteLength
          // @ts-ignore
          this.leftOverData = undefined
        }
  
        if (done) {
          return { buffer: buffer.slice(0, currentSize), currentSize, done }
        }
  
        let newSize
        const slicedBuffer = newBuffer.slice(0, SIZE - currentSize)
        newSize = currentSize + slicedBuffer.byteLength
        buffer.set(slicedBuffer, currentSize)
  
        if (newSize === SIZE) {
          // @ts-ignore
          this.leftOverData = newBuffer.slice(SIZE - currentSize)
          return { buffer, currentSize: newSize, done: false }
        }
        
        return accumulate({ buffer, currentSize: newSize })
      }
      const { buffer, done } = await accumulate()
      if (buffer?.byteLength) controller.enqueue(buffer)
      if (done) controller.close()
    }
  })
