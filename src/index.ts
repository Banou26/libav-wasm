import { createFile } from 'mp4box'

const downloadArrayBuffer = buffer => {
  const videoBlob = new Blob([new Uint8Array(buffer, 0, buffer.length)], { type: 'video/mp4' });
  
  var xhr = new XMLHttpRequest();
  xhr.open("GET", URL.createObjectURL(videoBlob));
  xhr.responseType = "arraybuffer";

  xhr.onload = function () {
      if (this.status === 200) {
          var blob = new Blob([xhr.response], {type: "application/octet-stream"});
          var objectUrl = URL.createObjectURL(blob);
          window.open(objectUrl);
      }
  };
  xhr.send();
}

import('../dist/libav.js').then(async v => {
  const module = await v()
  console.log(v)
  console.log(module)
  // console.log(module._demux(1))

  const typedArrayBuffer = new Uint8Array((await (await fetch('./video.mkv')).arrayBuffer()))
  // const mp4 = new Uint8Array((await (await fetch('./video.mp4')).arrayBuffer()))
  console.log('typedArrayBuffer', typedArrayBuffer, typedArrayBuffer.byteLength)

  // const typedArrayBuffer2 = typedArrayBuffer
  // const typedArrayBuffer2 = typedArrayBuffer.slice(0, 6_000_000)
  const typedArrayBuffer2 = typedArrayBuffer.slice(0, 30_000_000)
  // const typedArrayBuffer3 = typedArrayBuffer.slice(10_000_000, 20_000_000)
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
  // remuxer.push(typedArrayBuffer3)
  console.log('video formats: ', remuxer.getInfo())
  const resultBuffer = new Uint8Array(remuxer.getInt8Array())

  // const header = [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D]
  // resultBuffer.set(header, 0)
  // downloadArrayBuffer(resultBuffer)
  // return

  console.log('OOOOOF', resultBuffer, new TextDecoder().decode(resultBuffer))



  // const videoBlob = new Blob([new Uint8Array(resultBuffer, 0, resultBuffer.length)], { type: 'video/mp4' });
  // const video = document.createElement('video')
  // video.controls = true
  // video.autoplay = true
  // video.addEventListener('error', ev => {
  //   console.error(ev.target.error)
  // })
  // video.src = URL.createObjectURL(videoBlob)
  // document.body.appendChild(video)

  // const video2 = document.createElement('video')
  // video2.autoplay = true
  // video2.controls = true
  // video2.volume = 0
  // video2.addEventListener('error', ev => {
  //   console.error(ev.target.error)
  // })
  // video2.src = '/video.mp4'
  // document.body.appendChild(video2)

  

  const video = document.createElement('video')
  video.autoplay = true
  video.controls = true
  video.volume = 0
  video.addEventListener('error', ev => {
    console.error(ev.target.error)
  })
  document.body.appendChild(video)

  let mp4boxfile = createFile()
  mp4boxfile.onError = e => console.error('onError', e)

  const buff = resultBuffer.slice(0).buffer
  // @ts-ignore
  buff.fileStart = 0
  console.log('buff', buff)
  // console.log('mp4', mp4)

  // return

  const info: any = await new Promise(resolve => {
    mp4boxfile.onReady = info => {
      console.log('READY', info)
      resolve(info)
    }
    mp4boxfile.start()
    mp4boxfile.appendBuffer(buff)
    console.log('APPENDED')
    mp4boxfile.flush()
    console.log('FLUSHED')
  })
  console.log('mp4boxfile', mp4boxfile)

  let mime = 'video/mp4; codecs=\"'
  for (let i = 0; i < info.tracks.length; i++) {
    if (i !== 0) mime += ','
    mime += info.tracks[i].codec
  }
  mime += '\"'

  console.log('info', info)

  const mediaSource = new MediaSource()
  video.src = URL.createObjectURL(mediaSource)

  const sourceBuffer: SourceBuffer =
    await new Promise(resolve =>
      mediaSource.addEventListener(
        'sourceopen',
        () => resolve(mediaSource.addSourceBuffer(mime)),
        { once: true }
      )
    )
  
  sourceBuffer.appendBuffer(buff)
  

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

