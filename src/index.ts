import('../dist/libav.js').then(async v => {
  const module = await v()
  console.log(v)
  console.log(module)
  // console.log(module._demux(1))

  const typedArrayBuffer = new Uint8Array((await (await fetch('./video.mkv')).arrayBuffer()))
  console.log('typedArrayBuffer', typedArrayBuffer, typedArrayBuffer.byteLength)

  // const typedArrayBuffer2 = typedArrayBuffer
  // const typedArrayBuffer2 = typedArrayBuffer.slice(0, 6_000_000)
  const typedArrayBuffer2 = typedArrayBuffer.slice(0, 10_000_000)
  const typedArrayBuffer3 = typedArrayBuffer.slice(10_000_000, 20_000_000)
  // const typedArrayBuffer2 = typedArrayBuffer.slice(0, 6_000_000)
  // const typedArrayBuffer3 = typedArrayBuffer.slice(1_000_000, 6_000_000)
  // const buf = module._malloc(typedArrayBuffer.byteLength * typedArrayBuffer.BYTES_PER_ELEMENT);
  // module.HEAPU8.set(typedArrayBuffer, buf);
  // // console.log(module.ccall('initTransmux', 'number', ['number'], [buf]));
  // console.log(module._initTransmux(buf, typedArrayBuffer.byteLength))
  // module._free(buf);

  // console.log('call 1')
  // const result = module.initTransmux(typedArrayBuffer2)
  // console.log('res 1', await result)
  // console.log('call 2')
  // const result2 = module.test(result.pointer, typedArrayBuffer3)
  // console.log('res 2', await result2)


  const remuxer = new module.Remuxer(typedArrayBuffer2)
  console.log('remuxer', remuxer)
  remuxer.push(typedArrayBuffer3)
  console.log('video formats: ', remuxer.getInfo())
  const resultBuffer: Int8Array = remuxer.getInt8Array()
  console.log('OOOOOF', resultBuffer)

  const videoBlob = new Blob([new Uint8Array(resultBuffer, 0, resultBuffer.length)], { type: 'video/mp4' });
  const videoElement = document.createElement('video')
  videoElement.controls = true
  videoElement.autoplay = true
  videoElement.addEventListener('error', ev => {
    console.error(ev.target.error)
  })
  videoElement.src = URL.createObjectURL(videoBlob)
  document.body.appendChild(videoElement)

  

  // // const result = module.ccall(
  // //   'initTransmux',
  // //   'number',
  // //   ['array', 'number'],
  // //   [
  // //     typedArrayBuffer2,
  // //     typedArrayBuffer2.byteLength
  // //   ]
  // // )
  // console.log('res 1', await result)
  // console.log('call 2')
  // const result2 = module.demux(typedArrayBuffer2)
  // const result2 = module.ccall(
  //   'demux',
  //   'struct',
  //   ['number', 'array', 'number'],
  //   [
  //     await result,
  //     typedArrayBuffer3,
  //     typedArrayBuffer3.byteLength
  //   ]
  // )
  // console.log('res 2', await result2)
  // module.ccall('demux', 'number', ['number'], [buf]);
})

