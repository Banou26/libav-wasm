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

https://gitlab.freedesktop.org/gstreamer/gstreamer-rs/-/blob/master/examples/src/bin/decodebin.rs

ASYNC SEEK:
https://ffmpeg.org/doxygen/trunk/async_8c_source.html#l00386


ASYNC SEEK ADVICE: https://ffmpeg.org/pipermail/libav-user/2013-March/003928.html

SUBTITLE DECODING IN GO: https://gist.github.com/reusee/7372569
