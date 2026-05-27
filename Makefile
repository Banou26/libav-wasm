# Two build variants, selected at runtime by the worker:
#   dist/libav.js     - single-threaded, no SharedArrayBuffer required (works everywhere)
#   dist/libav-mt.js  - pthreads build for multi-threaded HEVC decode. Built with -pthread, so its
#                       wasm memory is shared (SharedArrayBuffer-backed) and it can ONLY be
#                       instantiated on a cross-origin-isolated page (COOP/COEP). Emitted as an ES
#                       module (EXPORT_ES6) and loaded as a real file so emscripten can spawn its
#                       pthread workers from the module's own URL.

EMCC := emcc

# Flags shared by both variants.
COMMON := --bind \
	-O3 \
	-msimd128 \
	-g \
	-gsource-map \
	--source-map-base http://localhost:1234/dist/ \
	-s ASSERTIONS=2 \
	-fexceptions \
	-L/opt/ffmpeg/lib \
	-I/opt/ffmpeg/include/ \
	-I/tmp/ffmpeg-7.1/ \
	-s FILESYSTEM=0 \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s ASYNCIFY \
	-s MODULARIZE=1

LIBS := -lavcodec -lavformat -lavfilter -lavdevice -lswresample -lswscale -lavutil -lm -lx264

all: dist/libav.js dist/libav-mt.js

dist/libav.js:
	mkdir -p dist && \
	$(EMCC) $(COMMON) \
	-s EXPORT_ES6=1 \
	-s ENVIRONMENT=web,worker \
	-s INITIAL_MEMORY=150mb \
	-s TOTAL_MEMORY=125mb \
	-s STACK_SIZE=50mb \
	$(LIBS) \
	-o dist/libav.js \
	src/main.cpp

dist/libav-mt.js:
	mkdir -p dist && \
	$(EMCC) $(COMMON) \
	-pthread \
	-s EXPORT_ES6=1 \
	-s PTHREAD_POOL_SIZE='navigator.hardwareConcurrency' \
	-s ENVIRONMENT=web,worker \
	-s INITIAL_MEMORY=150mb \
	-s MAXIMUM_MEMORY=2gb \
	-s STACK_SIZE=50mb \
	$(LIBS) \
	-o dist/libav-mt.js \
	src/main.cpp
