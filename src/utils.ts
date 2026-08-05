
export function debounceImmediateAndLatest<T extends (...args: any[]) => any>(
  wait: number,
  func: T
): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;

  const debouncedFunction = function(...args: any[]) {
    // @ts-expect-error
    const context = this;

    if (timeoutId === null) {
      func.apply(context, args);
    } else {
      lastArgs = args;
    }

    clearTimeout(timeoutId as ReturnType<typeof setTimeout>);

    timeoutId = setTimeout(() => {
      if (lastArgs) {
        func.apply(context, lastArgs);
        lastArgs = null;
      }
      timeoutId = null;
    }, wait);
  };

  return debouncedFunction as T;
}

export const queuedThrottleWithLastCall = <T2 extends any[], T extends (...args: T2) => any>(time: number, func: T) => {
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
