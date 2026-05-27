# LibAV WASM

This library can be used to remux from MKV -> MP4, it could technically do any remux but i haven't had the need for it, create an issue if you'd like it.

[src/test.ts](https://github.com/Banou26/libav-wasm/blob/main/src/test.ts)
Contains a full example of a MKV video player

Basic usage
```ts
const remuxer = await makeRemuxer({
  // url of the worker file of libavWASM
  workerUrl: new URL('../build/worker.js', import.meta.url).toString(),
  // url of the single-threaded ES module glue + its wasm binary
  moduleUrl: new URL('/dist/libav.js', new URL(import.meta.url).origin).toString(),
  wasmUrl: new URL('/dist/libav.wasm', new URL(import.meta.url).origin).toString(),
  // OPTIONAL: urls of the multi-threaded build, to enable threadCount > 1.
  // Also requires a cross-origin-isolated page (COOP/COEP) for SharedArrayBuffer.
  threadedModuleUrl: new URL('/dist/libav-mt.js', new URL(import.meta.url).origin).toString(),
  threadedWasmUrl: new URL('/dist/libav-mt.wasm', new URL(import.meta.url).origin).toString(),
  // OPTIONAL: HEVC-fallback decoder threads. 1 = single (default), 0 = auto (all cores), N = explicit
  threadCount: 1,
  // reads will be done in 2.5mb chunks
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
})

// returns the header of the video with all the metadata
const header = await remuxer.init()

// Returns a chunk that looks like {
//   offset: number,
//   buffer: Uint8Array,
//   pos: number,
//   pts: number, // timestamp
//   duration: number
// }
// buffer can be appended to the MediaSource API(MSE API)
const chunk = await remuxer.read()

// allows you to seek to timestamp and start reading from there
const seekChunk = await remuxer.seek(number)
// ...
```


## Intellisense
To have C++ autocompletion, put a ffmpeg repo clone folder in the root
`git clone https://github.com/FFmpeg/FFmpeg` & `git clone https://github.com/emscripten-core/emscripten`



## Issues to fix / features to implement
- Try to play around with `sourceBuffer.timestampOffset = res.pts` and always increasing timestamps to not have to re-init on backwards seeks
- Transcoding
- Base transcoding off of https://cconcolato.github.io/media-mime-support/#audio_codecs
<!-- https://www.ffmpeg.org/doxygen/trunk/remuxing_8c-example.html -->
<!-- https://github.com/leandromoreira/ffmpeg-libav-tutorial -->
