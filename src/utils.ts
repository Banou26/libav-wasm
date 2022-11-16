
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

export const throttleWithLastCall = <T extends (...args: any[]) => any>(time: number, func: T) => {
	let runningFunction: T | undefined
  let lastCall: Promise<any> | undefined
  let lastArguments: any[] | undefined

	return async (...args: Parameters<T>) => {
    lastArguments = args
		if (!runningFunction) {
			try {
        runningFunction = await func(...args)
				return runningFunction
			} finally {
        await new Promise(resolve => setTimeout(resolve, time))
        if (!lastCall) return
        try {
          lastCall = await func(...lastArguments)
        } finally {
          lastCall = undefined
          runningFunction = undefined
        }
        return lastCall
			}
		} else {
      return lastCall
    }
	}
}

// todo: reimplement this into a ReadableByteStream https://web.dev/streams/ once FF gets support
export const bufferStream = ({ stream, size: SIZE }: { stream: ReadableStream, size: number }) =>
  new ReadableStream<Uint8Array>({
    start() {
      this.reader = stream.getReader()
    },
    async pull(controller) {
      const { leftOverData }: { leftOverData: Uint8Array | undefined } = this

      const accumulate = async ({ buffer = new Uint8Array(SIZE), currentSize = 0 } = {}): Promise<{ buffer?: Uint8Array, currentSize?: number, done: boolean }> => {
        const { value: newBuffer, done } = await this.reader.read()
  
        if (currentSize === 0 && leftOverData) {
          buffer.set(leftOverData)
          currentSize += leftOverData.byteLength
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
