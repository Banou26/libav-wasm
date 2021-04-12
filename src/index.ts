import { createFile } from 'mp4box'

import('../dist/libav.js').then(async v => {
  const module = await v()
  console.log(v)
  console.log(module)

  const typedArrayBuffer = new Uint8Array((await (await fetch('./video.mkv')).arrayBuffer()))
  console.log('typedArrayBuffer', typedArrayBuffer, typedArrayBuffer.byteLength)

  const typedArrayBuffer2 = typedArrayBuffer.slice(0, 2_000_000) // 5
  const typedArrayBuffer3 = typedArrayBuffer.slice(2_000_000, 4_000_000) // 14s
  const typedArrayBuffer4 = typedArrayBuffer.slice(4_000_000, 6_000_000)

  const remuxer = new module.Remuxer(typedArrayBuffer2)
  console.log('remuxer', remuxer)
  remuxer.push(typedArrayBuffer3)
  remuxer.process()
  remuxer.push(typedArrayBuffer4)
  remuxer.process()
  console.log('video formats: ', remuxer.getInfo())
  const resultBuffer = new Uint8Array(remuxer.getInt8Array())

  const header = [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D]
  resultBuffer.set(header, 0)

  console.log('OOOOOF', resultBuffer, new TextDecoder().decode(resultBuffer))

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
})

