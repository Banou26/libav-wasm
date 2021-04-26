mkdir -p dist
docker build -t libav-wasm .
docker create -ti --name libav-wasm-container libav-wasm
docker cp libav-wasm-container:/build/dist/ www
docker rm -fv libav-wasm-container