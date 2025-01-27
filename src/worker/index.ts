import { expose } from 'osra'

// @ts-ignore
import WASMModule from 'libav'
import PQueue from 'p-queue'
import Mutex from 'p-mutex'
import { createStateMachine } from './state-machine'

export type RemuxerInstanceSubtitleFragment =
  | {
    isHeader: true
    streamIndex: number
    data: Uint8Array
    format: string[]
    language: string
    title: string
    start: string
    end: string
  }

export type SubtitleFragment =
  | {
    type: 'header'
    streamIndex: number
    content: string
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
    content: string
    fields: Record<string, string>
  }

export type RemuxerInstanceAttachment = {
  filename: string
  mimetype: string
  data: Uint8Array
}

export type Attachment = {
  filename: string
  mimetype: string
  data: ArrayBuffer
}

export type RemuxerInstanceOptions = {
  resolvedPromise: Promise<void>
  length: number
  bufferSize: number
}

type WASMReadFunction = (offset: number, size: number) => Promise<{
  resolved: Uint8Array
  rejected: boolean
}>

export interface RemuxerInstance {
  new(options: RemuxerInstanceOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{
    data: Uint8Array
    attachments: WASMVector<RemuxerInstanceAttachment>
    subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
    info: {
      input: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
      output: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
    }
  }>
  destroy: () => void
  seek: (read: WASMReadFunction, timestamp: number) => Promise<void>
  read: (read: WASMReadFunction) => Promise<{
    data: Uint8Array
    subtitles: WASMVector<RemuxerInstanceSubtitleFragment>
    offset: number
    pts: number
    duration: number
    cancelled: boolean
    finished: boolean
  }>
}

export type Remuxer = {
  new(options: RemuxerInstanceOptions): RemuxerInstance
  init: (read: WASMReadFunction) => Promise<{
    data: ArrayBuffer
    attachments: Attachment[]
    subtitles: SubtitleFragment[]
    info: {
      input: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
      output: {
        audioMimeType: string
        duration: number
        formatName: string
        mimeType: string
        videoMimeType: string
      }
    }
  }>
  destroy: () => void
  seek: (read: WASMReadFunction, timestamp: number) => Promise<void>
  read: (read: WASMReadFunction) => Promise<{
    data: ArrayBuffer
    subtitles: SubtitleFragment[]
    offset: number
    pts: number
    duration: number
    cancelled: boolean
    finished: boolean
  }>
}

const makeModule = (publicPath: string, log: (isError: boolean, text: string) => void) =>
  WASMModule({
    locateFile: (path: string) => `${publicPath}${path.replace('/dist', '')}`,
    print: (text: string) => console.log(text),
    printErr: (text: string) => console.error(text),
    // print: (text: string) => log(false, text),
    // printErr: (text: string) => log(true, text),
  }) as Promise<{ Remuxer: RemuxerInstance }>

// converts ms to 'h:mm:ss.cc' format
const convertTimestamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .slice(11, 22)
    .replace(/^00/, '0')

const abortSignalToPromise = (abortSignal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (abortSignal.aborted) return reject()
  abortSignal.addEventListener('abort', () => {
    reject()
  })
})

type WASMVector<T> = {
  size: () => number
  get: (index: number) => T
}

const vectorToArray = <T>(vector: WASMVector<T>) =>
  Array(vector.size())
    .fill(undefined)
    .map((_, index) => vector.get(index))

const resolvers = {
  makeRemuxer: async (
    { publicPath, length, bufferSize, log, read }:
    {
      publicPath: string
      length: number
      bufferSize: number
      log: (isError: boolean, text: string) => Promise<void>
      read: (offset: number, size: number) => Promise<ArrayBuffer>
    }
  ) => {
    const { Remuxer } = await makeModule(publicPath, log)
    const _remuxer = new Remuxer({ resolvedPromise: Promise.resolve(), length, bufferSize })
    const remuxer = {
      init: (read) => _remuxer.init(read).then(result => {
        const typedArray = new Uint8Array(result.data.byteLength)
        typedArray.set(new Uint8Array(result.data))
        return {
          data: typedArray.buffer,
          attachments: vectorToArray(result.attachments).map(attachment => ({
            filename: attachment.filename,
            mimetype: attachment.mimetype,
            data: new Uint8Array(attachment.data).buffer
          })),
          subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
            if (!_subtitle.isHeader) throw new Error('Subtitle type is not header')
            const { isHeader, data, ...subtitle } = _subtitle
            return {
              ...subtitle,
              type: 'header',
              content: new TextDecoder().decode(data)
            }
          }),
          info: {
            input: {
              audioMimeType: result.info.input.audioMimeType,
              duration: result.info.input.duration,
              formatName: result.info.input.formatName,
              mimeType: result.info.input.mimeType,
              videoMimeType: result.info.input.videoMimeType
            },
            output: {
              audioMimeType: result.info.output.audioMimeType,
              duration: result.info.output.duration,
              formatName: result.info.output.formatName,
              mimeType: result.info.output.mimeType,
              videoMimeType: result.info.output.videoMimeType
            }
          }
        }
      }),
      destroy: () => _remuxer.destroy(),
      seek: (read, timestamp) => console.log('ACTUAL SEEK', timestamp) || _remuxer.seek(read, timestamp * 1000),
      read: (read) => _remuxer.read(read).then(result => {
        if (result.cancelled) throw new Error('Cancelled')
        const typedArray = new Uint8Array(result.data.byteLength)
        typedArray.set(new Uint8Array(result.data))
        return {
          data: typedArray.buffer,
          subtitles: vectorToArray(result.subtitles).map((_subtitle) => {
            if (_subtitle.isHeader) throw new Error('Subtitle type is header')
            const { isHeader, data, ...subtitle } = _subtitle
            return {
              ...subtitle,
              type: 'dialogue',
              content: new TextDecoder().decode(data)
            }
          }),
          offset: result.offset,
          pts: result.pts,
          duration: result.duration,
          cancelled: result.cancelled,
          finished: result.finished
        }
      })
    } as Remuxer

    const stateMachine =
      createStateMachine({
        initialState: 'IDLE',
        transitions: {
          IDLE: ['PROCESSING'],
          PROCESSING: ['CANCELLING', 'IDLE'],
          CANCELLING: ['IDLE'],
        },
        context: {
          seekTo: undefined as number | undefined,
          abortController: undefined as AbortController | undefined
        },
        onExit: (state) => console.log(`Exiting ${state}`),
        onEnter: (state) => console.log(`Entering ${state}`)
      })

    const wasmRead = (abortController: AbortController) => (offset: number, size: number) => {
      if (abortController.signal.aborted) return Promise.resolve({ resolved: new Uint8Array(0), rejected: true })
      return Promise.race([
        read(offset, size)
          .then(
            buffer => ({ resolved: new Uint8Array(buffer), rejected: false }),
            () => ({ resolved: new Uint8Array(0), rejected: true })
          ),
        abortSignalToPromise(abortController.signal)
          .then(
            () => ({ resolved: new Uint8Array(0), rejected: true }),
            () => ({ resolved: new Uint8Array(0), rejected: true })
          )
      ])
    }

    (async () => {
      const _read = (cancel: boolean = false) => async (offset: number, size: number) =>
        cancel
          ? ({ resolved: new Uint8Array(0), rejected: true })
          : ({ resolved: new Uint8Array(await read(offset, size)), rejected: false })
      const header = await remuxer.init(_read())
      console.log('header', header)
      const firstChunk = await remuxer.read(_read())
      console.log('first chunk', firstChunk)
      let readCount = 0
      const cancelledChunk = await remuxer.read(async (offset, size) => {
        console.log('READ ON CANCEL')
        const cancelOnReads = [0, 1, 2]
        const result = await _read(cancelOnReads.includes(readCount))(offset, size)
        readCount++
        return result
      }).catch((err) => { console.error(err) })
      console.log('cancelledChunk', cancelledChunk)
      // await remuxer.destroy()
      // await remuxer.init(_read())
      console.log('SEEKING')
      // await remuxer.seek(_read(), 30)
      // console.log('seeked')

      await remuxer.seek(async (offset, size) => {
        console.log('SEEK ON CANCEL')
        return _read(true)(offset, size)
      }, 30).catch((err) => { console.error(err) })

      const chunkAfterSeek = await remuxer.read(_read())
      console.log('chunkAfterSeek', chunkAfterSeek)
    })();

    return {
      destroy: async () => remuxer.destroy(),
      init: () => {
        console.log('initing')
        const abortController = new AbortController()
        stateMachine.transitionTo('PROCESSING', context => ({ ...context, abortController }))
        return (
          remuxer
            .init(wasmRead(abortController))
            .finally(() => {
              stateMachine.transitionTo('IDLE', context => ({ ...context, abortController: undefined }))
            })
        )
      },
      seek: async (timestamp: number) => {
        console.log('seeking', timestamp)
        const state = stateMachine.getState()
        if (state === 'CANCELLING') {
          stateMachine.setContext({ ...stateMachine.getContext(), seekTo: timestamp })
          return
        }
        if (state === 'PROCESSING') {
          const abortController = stateMachine.getContext().abortController
          if (!abortController) throw new Error('No abortController found when processing')
          stateMachine.transitionTo('CANCELLING', context => ({ ...context, seekTo: timestamp }))
          abortController.abort()
          return
        }
        const abortController = new AbortController()
        stateMachine.transitionTo('PROCESSING', context => ({ ...context, abortController }))
        return (
          remuxer
            .seek(wasmRead(abortController), timestamp)
            .finally(() => {
              stateMachine.transitionTo('IDLE', context => ({ ...context, abortController: undefined }))
            })
        )
      },
      read: () => {
        console.log('reading')
        const state = stateMachine.getState()
        if (state === 'PROCESSING' || state === 'CANCELLING') {
          throw new Error('Cannot read while processing or cancelling')
        }
        const abortController = new AbortController()
        stateMachine.transitionTo('PROCESSING', context => ({ ...context, abortController }))
        return (
          remuxer
            .read(wasmRead(abortController))
            .finally(() => {
              stateMachine.transitionTo('IDLE', context => ({ ...context, abortController: undefined }))
            })
        )
      }
    }
  }
}

export type Resolvers = typeof resolvers

expose(resolvers, { remote: globalThis, local: globalThis })
