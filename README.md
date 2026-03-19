# LibAV WASM

This library can be used to remux from MKV -> MP4 using [libav.js](https://github.com/Yahweasel/libav.js) (FFmpeg compiled to WebAssembly).

[src/test.ts](https://github.com/Banou26/libav-wasm/blob/main/src/test.ts)
Contains a full example of a MKV video player

## Setup

Install the package and its peer dependency:
```sh
npm install libav-wasm @libav.js/variant-webcodecs
```

You need to serve the libav.js WASM files from a public directory. Copy the contents of `@libav.js/variant-webcodecs/dist/` to your public path (e.g. `/libav/`).

## Basic usage
```ts
const remuxer = await makeRemuxer({
  // base path where libav.js WASM files are served
  publicPath: new URL('/libav/', new URL(import.meta.url).origin).toString(),
  // url of the worker file
  workerUrl: new URL('../build/worker.js', import.meta.url).toString(),
  // reads will be done in 2.5mb chunks
  bufferSize: 2_500_000,
  // byte length of the video file
  length: contentLength,
  // read function for fetching file chunks
  read: async (offset, size) =>
    fetch(
      VIDEO_URL,
      {
        headers: {
          Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}`
        }
      }
    ).then(res => res.arrayBuffer())
})

// returns the header of the video with all the metadata
const header = await remuxer.init()

// Returns a chunk with {
//   offset: number,
//   data: ArrayBuffer,
//   pts: number, // timestamp
//   duration: number
// }
// data can be appended to the MediaSource API (MSE API)
const chunk = await remuxer.read()

// allows you to seek to timestamp and start reading from there
const seekChunk = await remuxer.seek(number)
// ...
```

## Issues to fix / features to implement
- Try to play around with `sourceBuffer.timestampOffset = res.pts` and always increasing timestamps to not have to re-init on backwards seeks
- Audio transcoding (EAC3 → AAC) - requires a libav.js variant with audio codecs
- Chapter and keyframe index extraction
- Base transcoding off of https://cconcolato.github.io/media-mime-support/#audio_codecs
