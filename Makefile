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

dist/libav-wasm.js:
	mkdir -p dist && \
	emcc --bind \
	-O3 \
	-g \
	-gsource-map \
	--source-map-base http://localhost:1234/dist/ \
	-s ASSERTIONS=2 \
	-L/opt/ffmpeg/lib \
	-I/opt/ffmpeg/include/ \
	-s INITIAL_MEMORY=150mb \
	-s TOTAL_MEMORY=125mb \
	-s TOTAL_STACK=5mb \
	-s ASYNCIFY \
	-s MODULARIZE=1 \
	-s NO_DYNAMIC_EXECUTION=1 \
	-lavcodec -lavformat -lavfilter -lavdevice -lswresample -lswscale -lavutil -lm -lx264 \
	-o dist/libav.cjs \
	src/main.cpp
