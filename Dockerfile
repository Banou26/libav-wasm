FROM emscripten/emsdk:3.1.8 as build

ARG X264_VERSION=20191217-2245-stable
ARG FFMPEG_VERSION=5.1

ARG PREFIX=/opt/ffmpeg
ARG MAKEFLAGS="-j4"

RUN apt-get update && apt-get install -y autoconf libtool build-essential

# libx264
RUN cd /tmp && \
  wget https://download.videolan.org/pub/videolan/x264/snapshots/x264-snapshot-${X264_VERSION}.tar.bz2 && \
  tar xvfj x264-snapshot-${X264_VERSION}.tar.bz2

RUN cd /tmp/x264-snapshot-${X264_VERSION} && \
  emconfigure ./configure \
  --prefix=${PREFIX} \
  --host=i686-gnu \
  --enable-static \
  --disable-cli \
  --disable-asm \
  --extra-cflags="-s USE_PTHREADS=1"

RUN cd /tmp/x264-snapshot-${X264_VERSION} && \
  emmake make && emmake make install 

# Get ffmpeg source.
RUN cd /tmp/ && \
  wget http://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz && \
  tar zxf ffmpeg-${FFMPEG_VERSION}.tar.gz && rm ffmpeg-${FFMPEG_VERSION}.tar.gz

ARG CFLAGS="-s USE_PTHREADS=1 -O3 -I${PREFIX}/include"
ARG LDFLAGS="$CFLAGS -L${PREFIX}/lib -s INITIAL_MEMORY=1GB"

ARG CACHE_BUST

# Compile ffmpeg.
RUN cd /tmp/ffmpeg-${FFMPEG_VERSION} && \
  emconfigure ./configure \
  --prefix=${PREFIX} \
  --target-os=none \
  --arch=x86_32 \
  --enable-cross-compile \
  --disable-debug \
  --disable-x86asm \
  --disable-inline-asm \
  --disable-stripping \
  --disable-programs \
  --disable-doc \
  --disable-all \
  --enable-avcodec \
  --enable-avformat \
  --enable-avfilter \
  --enable-avdevice \
  --enable-avutil \
  --enable-swresample \
  --enable-postproc \
  --enable-swscale \
  --enable-protocol=file \
  --enable-decoder=h264,aac,pcm_s16le \
  --enable-demuxer=mov,matroska \
  --enable-muxer=mp4 \
  --enable-gpl \
  --enable-libx264 \
  --extra-cflags="$CFLAGS" \
  --extra-cxxflags="$CFLAGS" \
  --extra-ldflags="$LDFLAGS" \
  --nm="llvm-nm -g" \
  --ar=emar \
  --as=llvm-as \
  --ranlib=llvm-ranlib \
  --cc=emcc \
  --cxx=em++ \
  --objcc=emcc \
  --dep-cc=emcc
  # --prefix=${PREFIX} \
  # --disable-autodetect --disable-all --disable-doc --disable-everything --disable-static --disable-debug \
  # --disable-amd3dnow --disable-amd3dnowext --disable-avx512 --disable-aesni --enable-stripping --disable-network \
  # --disable-programs \
  # --enable-static --enable-small \
  # --enable-avutil --enable-avfilter --enable-avcodec \
  # --enable-avformat --enable-demuxer=matroska --enable-muxer=mp4 \
  # --enable-avdevice \
  # --enable-swresample \
  # # --enable-postproc \
  # --enable-swscale \
  # # --enable-protocol=file \
  # # --enable-decoder=h264,aac,pcm_s16le \
  # # --enable-demuxer=mov,matroska \
  # # --enable-muxer=mp4 \
  # # --enable-gpl \
  # # --enable-libx264 \
  # # emscripten flags, probably?
  # --disable-stripping \
  # --disable-inline-asm \
  # --enable-cross-compile \
  # --target-os=none \
  # --disable-x86asm \
  # --arch=x86_32 \
  # --extra-cflags="$CFLAGS" \
  # --extra-cxxflags="$CFLAGS" \
  # --extra-ldflags="$LDFLAGS" \
  # --nm="llvm-nm -g" \
  # --ar=emar \
  # --as=llvm-as \
  # --ranlib=llvm-ranlib \
  # --cc=emcc \
  # --cxx=em++ \
  # --objcc=emcc \
  # --dep-cc=emcc

RUN cd /tmp/ffmpeg-${FFMPEG_VERSION} && \
  emmake make -j4 && \
  emmake make install


COPY ./src/main.cpp /build/src/main.cpp
COPY ./Makefile /build/Makefile

WORKDIR /build

RUN make
