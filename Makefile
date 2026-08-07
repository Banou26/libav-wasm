	# -pthread \
	# -s EXPORTED_FUNCTIONS="['_main', '_demux', '_initTransmux']" \
	# -g4 --source-map-base http://localhost:1234/ \
	# -s EXTRA_EXPORTED_RUNTIME_METHODS="[cwrap, ccall, getValue, setValue, writeAsciiToMemory]" \

	# -pthread \
	# -s PROXY_TO_PTHREAD \
	# -s PTHREAD_POOL_SIZE=1 \
	# -sEXPORT_NAME=worker \

	# disable for build
	# -g \
	# -gsource-map \
	# --source-map-base http://localhost:1234/dist/ \
	# -s ASSERTIONS=2 \

DEBUG =
DEBUG_FLAGS = -g -gsource-map --source-map-base http://localhost:1234/dist/ -s ASSERTIONS=2

# ASYNCIFY_REMOVE: functions that make an indirect call which can never reach the JS read.
#
# Asyncify instruments every function that might be on the stack during an unwind, and it treats any
# indirect call as able to reach anywhere. ffmpeg dispatches through function pointers everywhere, so
# bare -s ASYNCIFY instrumented 5744 of 13754 functions, which is 82.6% of the CODE, and every one of
# them pays the state check and the local spill on every call. Only the avio read path can actually
# unwind: fill_buffer -> AVIOContext.read_packet -> Remuxer::avio_read -> val::await().
#
# Each name below is a place that calls a pointer which is never the JS read: av_vlog calls the log
# callback, buffer_replace and ff_refstruct_unref call free callbacks, ff_get_buffer and
# ff_get_encode_buffer call get_buffer2, __pthread_once calls an init routine, __vfprintf_internal
# calls its output sink, ff_tx_init_subtx calls a transform's init. Removing av_vlog alone drops 1077
# functions, because av_log is called from nearly every function in ffmpeg.
#
# Measured: instrumented code share 82.6% -> 66.9%, wasm 13139757 -> 11817023 bytes (-10.1%), and a
# full remux of h264-pcm.mkv 737.7ms -> 634.7ms median over 12 runs (-14.0%, ranges not overlapping).
#
# ASYNCIFY_IGNORE_INDIRECT is NOT usable here, however tempting the numbers are (it reaches 22.0% of
# code and -21.6% size). It means "indirect calls can never be on the stack during an unwind", and in
# this module one always is: the read callback is reached only through AVIOContext.read_packet. Builds
# using it link cleanly, pass no test, and hang rather than fail. No ASYNCIFY_ADD list can fix that.
#
# A wrong name here is silent at runtime but loud at build time: emcc prints "Asyncify removelist
# contained a non-existing function name". Watch for it after any ffmpeg upgrade.

dist/libav-wasm.js:
	mkdir -p dist && \
	emcc --bind \
	-Oz \
	$(if $(DEBUG),$(DEBUG_FLAGS)) \
	-L/opt/ffmpeg/lib \
	-I/opt/ffmpeg/include/ \
	-I/tmp/ffmpeg-7.1/ \
	-s FILESYSTEM=0 \
	-s ENVIRONMENT=web \
	-s INITIAL_MEMORY=125mb \
	-s STACK_SIZE=50mb \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s ASYNCIFY \
	-s ASYNCIFY_REMOVE="['av_vlog','buffer_replace','__pthread_once','__vfprintf_internal','ff_refstruct_unref','ff_get_buffer','ff_get_encode_buffer','ff_tx_init_subtx']" \
	-fexceptions \
	-s EXPORTED_RUNTIME_METHODS=getExceptionMessage \
	-s MODULARIZE=1 \
	-lavcodec -lavformat -lavfilter -lavdevice -lswresample -lswscale -lavutil -lm -lx264 \
	-o dist/libav.js \
	src/main.cpp
