
export function debounceImmediateAndLatest<T extends (...args: unknown[]) => unknown>(
  wait: number,
  func: T
): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const debouncedFunction = function(this: unknown, ...args: Parameters<T>) {
    if (timeoutId === null) {
      func.apply(this, args);
    } else {
      lastArgs = args;
    }

    clearTimeout(timeoutId!);

    timeoutId = setTimeout(() => {
      if (lastArgs) {
        func.apply(this, lastArgs);
        lastArgs = null;
      }
      timeoutId = null;
    }, wait);
  };

  return debouncedFunction as unknown as T;
}

export const queuedThrottleWithLastCall = <TArgs extends unknown[], T extends (...args: TArgs) => unknown>(time: number, func: T) => {
  let runningFunction: Promise<ReturnType<T>> | undefined
  let lastCall: Promise<ReturnType<T>> | undefined
  let lastCallArguments: TArgs | undefined

  const checkForLastCall = (
    timeStart: number,
    resolve: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void,
    reject: (reason?: unknown) => void
  ) =>
    (result: ReturnType<T>) => {
      const currentTime = performance.now()
      setTimeout(() => {
        if (!lastCallArguments) {
          runningFunction = undefined
          lastCall = undefined
          return
        }
        const funcResult = (async () => (func(...lastCallArguments) as ReturnType<T>))()
        lastCallArguments = undefined
        funcResult
          .then(resolve)
          .catch((err: unknown) => {
            console.error(err)
            reject(err)
          })

        let _resolve!: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void
        let _reject!: (reason?: unknown) => void
        lastCall = new Promise<ReturnType<T>>((res, rej) => {
          _resolve = res
          _reject = rej
        })

        runningFunction =
          funcResult
            .then(checkForLastCall(currentTime, _resolve, _reject) as (value: ReturnType<T>) => ReturnType<T>)
            .catch((err: unknown) => {
              console.error(err)
              return checkForLastCall(timeStart, _resolve, _reject)(err as ReturnType<T>)
            }) as Promise<ReturnType<T>>
      }, time - (currentTime - timeStart))
      return result
    }

  return (...args: Parameters<T>) => {
    lastCallArguments = args as TArgs
    if (!runningFunction) {
      const timeStart = performance.now()
      const funcResult = (async () => (func(...args) as ReturnType<T>))()
      lastCallArguments = undefined
      let _resolve!: (value: ReturnType<T> | PromiseLike<ReturnType<T>>) => void
      let _reject!: (reason?: unknown) => void
      lastCall = new Promise<ReturnType<T>>((res, rej) => {
        _resolve = res
        _reject = rej
      })

      runningFunction =
        funcResult
          .then(checkForLastCall(timeStart, _resolve, _reject) as (value: ReturnType<T>) => ReturnType<T>)
          .catch((err: unknown) => {
            console.error(err)
            return checkForLastCall(timeStart, _resolve, _reject)(err as ReturnType<T>)
          }) as Promise<ReturnType<T>>

      return funcResult
    } else {
      return lastCall
    }
  }
}

interface ChunkSizeStreamState {
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  leftOverData: Uint8Array | undefined
}

// TODO: reimplement as ReadableByteStream (https://web.dev/streams/) once Safari gets support
export const toStreamChunkSize = (SIZE: number) => (stream: ReadableStream<Uint8Array>) => {
  const state: ChunkSizeStreamState = {
    reader: undefined,
    leftOverData: undefined,
  }

  return new ReadableStream<Uint8Array>({
    start() {
      state.reader = stream.getReader()
    },
    async pull(controller) {
      const accumulate = async ({ buffer = new Uint8Array(SIZE), currentSize = 0 } = {}): Promise<{ buffer?: Uint8Array, currentSize?: number, done: boolean }> => {
        const { value: newBuffer, done } = await state.reader!.read()
        if (currentSize === 0 && state.leftOverData) {
          buffer.set(state.leftOverData)
          currentSize += state.leftOverData.byteLength
          state.leftOverData = undefined
        }

        if (done) {
          state.reader = undefined
          state.leftOverData = undefined
          return { buffer: buffer.slice(0, currentSize), currentSize, done }
        }

        const slicedBuffer = newBuffer.slice(0, SIZE - currentSize)
        const newSize = currentSize + slicedBuffer.byteLength
        buffer.set(slicedBuffer, currentSize)

        if (newSize === SIZE) {
          state.leftOverData = newBuffer.slice(SIZE - currentSize)
          return { buffer, currentSize: newSize, done: false }
        }

        return accumulate({ buffer, currentSize: newSize })
      }

      const { buffer, done } = await accumulate()
      if (buffer?.byteLength) controller.enqueue(buffer)
      if (done) controller.close()
    },
    cancel() {
      state.reader?.cancel()
      state.leftOverData = undefined
    }
  })
}

interface BufferedStreamState {
  buffers: Uint8Array[]
  currentPullPromise: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined
}

export const toBufferedStream = (SIZE: number) => (stream: ReadableStream<Uint8Array>) => {
  const state: BufferedStreamState = {
    buffers: [],
    currentPullPromise: undefined,
    reader: undefined,
  }

  return new ReadableStream<Uint8Array>({
    start() {
      state.reader = stream.getReader()
    },
    async pull(controller) {
      const pull = async () => {
        if (state.buffers.length >= SIZE) return
        state.currentPullPromise = state.reader!.read()
        const { value: newBuffer, done } = await state.currentPullPromise
        state.currentPullPromise = undefined
        if (done) {
          for (const buffer of state.buffers) controller.enqueue(buffer)
          controller.close()
          return
        }
        state.buffers.push(newBuffer)
        return newBuffer
      }

      const tryToBuffer = async (): Promise<void> => {
        if (state.buffers.length >= SIZE) return

        if (state.buffers.length === 0) {
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
      const chunk = state.buffers.shift()
      if (chunk) {
        try {
          controller.enqueue(chunk)
        } catch (err) {
          // Stream may have been closed between the check and enqueue
          if (!(err instanceof TypeError && err.message.includes('enqueue'))) {
            throw err
          }
        }
      }
      tryToBuffer()
    },
    cancel() {
      state.reader?.cancel()
    }
  })
}
