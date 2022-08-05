## Intellisense 
To have C++ autocompletion, put a ffmpeg repo clone folder in the root
`git clone https://github.com/FFmpeg/FFmpeg`



## Issues to fix / features to implement

- Transcoding
- Decoding + canvas rendering
- Transmux seeking
- Async/Await
- Issues with Monotonically increasing DTS
    worker.js:72610 [mp4 @ 0x6468c0] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 773280 >= 349110
    http://localhost:1234/app/616331fa7b57db93f0957a18/watch/mal:50265/mal:50265-1/nyaa:1512518
- Thumbnail extraction
- Output DASH format to re-use the dash reference player impl instead of my scuffed one https://github.com/Dash-Industry-Forum/dash.js

try using 
```
./configure --prefix=${PREFIX} --target-os=none --arch=x86_32 --enable-cross-compile \
    --disable-autodetect --disable-all --disable-doc --disable-everything --disable-static --disable-debug \
    --disable-amd3dnow --disable-amd3dnowext --disable-avx512 --disable-avx512icl --disable-aesni --enable-stripping --disable-network \
    --enable-static --enable-small \
    --enable-avutil --enable-avfilter --enable-avcodec \
    --enable-avformat --enable-demuxer=matroska --enable-muxer=mp4 \
    --enable-avdevice --enable-protocol=file
```
to build ffmpeg to reduce bundle size
