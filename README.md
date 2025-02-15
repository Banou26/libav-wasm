# LibAV WASM

This library can be used to remux from MKV -> MP4, it could technically do any remux but i haven't had the need for it, create an issue if you'd like it.

[src/test.ts](https://github.com/Banou26/libav-wasm/blob/main/src/test.ts)
Contains a full example of a MKV video player

Basic usage
```ts
const remuxer = await makeRemuxer({
  // the path at which the wasm file is getting served
  publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
  // url of the worker file of libavWASM
  workerUrl: new URL('../build/worker.js', import.meta.url).toString(),
  // reads are done in 2.5mb chunks
  bufferSize: 2_500_000,
  // byte length of the video file
  length: contentLength,
  // fetch returning a ReadableStream
  getStream: async (offset, size) =>
    fetch(
      VIDEO_URL,
      {
        headers: {
          Range: `bytes=${offset}-${size ? Math.min(offset + size, contentLength) - 1 : ''}`
        }
      }
    ).then(res => res.body)
  ,
  // callback where you'll receive the subtitle chunks
  subtitle: (title, language, subtitle) => {
    // console.log('SUBTITLE HEADER', title, language, subtitle)
  },
  // callback where you'll receive the attachments
  attachment: (filename: string, mimetype: string, buffer: ArrayBuffer) => {
    // console.log('attachment', filename, mimetype, buffer)
  }
})

// Returns a chunk that looks like {
//   isHeader: boolean,
//   offset: number,
//   buffer: Uint8Array,
//   pos: number,
//   pts: number, // timestamp
//   duration: number
// }
// buffer can be appended to the MediaSource API(MSE API)
const chunk = await remuxer.read()

// allows you to seek to timestamp and start reading from there
await remuxer.seek(number)

await remuxer.read()
```



## Intellisense 
To have C++ autocompletion, put a ffmpeg repo clone folder in the root
`git clone https://github.com/FFmpeg/FFmpeg` & `git clone https://github.com/emscripten-core/emscripten`



## Issues to fix / features to implement
- Transcoding
- Decoding + canvas rendering
- Thumbnail extraction

Apparently creating contexts and sending transferable streams breaks chrome.
```ts
const dothething = async (i: number) => {
  const workerUrl = new URL('/build/libav.js', new URL(window.location.toString()).origin).toString()
  const blob = new Blob([`importScripts(${JSON.stringify(workerUrl)})`], { type: 'application/javascript' })
  const libavWorkerUrl = URL.createObjectURL(blob)
  console.log('creating', i)
  const remuxer = await makeRemuxer({
    publicPath: new URL('/build/', new URL(import.meta.url).origin).toString(),
    workerUrl: libavWorkerUrl,
    bufferSize: BASE_BUFFER_SIZE,
    length,
    getStream: (offset, size) =>
      fetch(
        '/video.mkv',
        {
          headers: {
            Range: `bytes=${offset}-${size ?? (!BACKPRESSURE_STREAM_ENABLED ? Math.min(offset + BASE_BUFFER_SIZE, size!) : '')}`
          }
        }
      )
        .then(response => toStreamChunkSize(BASE_BUFFER_SIZE)(response.body!))
  })
  console.log('created', i)
  console.log('initing', i)
  await remuxer.init()
  console.log('inited', i)
  console.log('destroying', i)
  await remuxer.destroy()
  console.log('destroyed', i)
  console.log('terminating', i)
  remuxer.worker.terminate()
  console.log('terminated', i)
  URL.revokeObjectURL(libavWorkerUrl)
}

for (let i = 0; i < 8; i++) {
  setTimeout(() => dothething(i), i * 1000)
}

setTimeout(() => {
  console.log('aaaa')
  fetch(
    '/video.mkv',
    {
      headers: {
        Range: `bytes=${0}-${5000}`
      }
    }
  ).then(response => response.arrayBuffer())
}, 10_000)
```


<!-- https://www.ffmpeg.org/doxygen/trunk/remuxing_8c-example.html -->
<!-- https://github.com/leandromoreira/ffmpeg-libav-tutorial -->
