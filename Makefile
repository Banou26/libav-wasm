	# -pthread \
	# -s EXPORTED_FUNCTIONS="['_main', '_demux', '_initTransmux']" \
	# -g4 --source-map-base http://localhost:1234/ \

dist/libav-wasm.js:
	mkdir -p dist && \
	emcc --bind \
	-O3 \
	-g4 --source-map-base http://localhost:1234/ \
	-L/opt/ffmpeg/lib \
	-I/opt/ffmpeg/include/ \
	-s EXTRA_EXPORTED_RUNTIME_METHODS="[cwrap, ccall, getValue, setValue, writeAsciiToMemory]" \
	-s INITIAL_MEMORY=1500mb \
	-s TOTAL_MEMORY=1250mb \
	-s TOTAL_STACK=50mb \
	-s ASYNCIFY \
	-s MODULARIZE=1 \
	-s NO_DYNAMIC_EXECUTION=1 \
	-lavcodec -lavformat -lavfilter -lavdevice -lswresample -lswscale -lavutil -lm -lx264 \
	-o dist/libav.js \
	-s SINGLE_FILE=1 \
	src/main.cpp
