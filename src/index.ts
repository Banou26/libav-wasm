import { createFile } from 'mp4box'

import('../dist/libav.js').then(async v => {
  console.log(':)')
  const module = await v()
  console.log(v)
  console.log(module)

  const typedArrayBuffer = new Uint8Array((await (await fetch('./video.mkv')).arrayBuffer()))
  console.log('typedArrayBuffer', typedArrayBuffer, typedArrayBuffer.byteLength)

  const BUFFER_SIZE = 500_000

  const PUSH_ARRAY_SIZE = 1_000_000

  // const PUSH_SIZE = Math.round(PUSH_ARRAY_SIZE / BUFFER_SIZE) * BUFFER_SIZE
  const PUSH_SIZE = 1_000_000

  console.log('PUSH_SIZE', PUSH_SIZE)

  // const remuxer = new module.Remuxer()
  // console.log('remuxer', remuxer)

  const resultBuffer = new Uint8Array(300_000_000)
  let processedBytes = 0
  let outputBytes = 0

  // while (processedBytes < 6_000_000) { // processedBytes !== typedArrayBuffer.byteLength

  //   const bufferToPush = typedArrayBuffer.slice(processedBytes, processedBytes + PUSH_SIZE)
  //   remuxer.push(bufferToPush)

  //   if (processedBytes === 0) {
  //     remuxer.init(BUFFER_SIZE)
  //   }
  //   processedBytes += bufferToPush.byteLength

  //   remuxer.process()

  //   const result = remuxer.getInt8Array()
  //   resultBuffer.set(result, outputBytes)
  //   outputBytes += result.byteLength
  
  //   remuxer.clearInput()
  //   remuxer.clearOutput()
  //   console.log(
  //     'processedBytes', processedBytes,
  //     '\noutputBytes', outputBytes,
  //     '\nbufferToPush.byteLength', bufferToPush.byteLength,
  //     '\nresult.byteLength', result.byteLength
  //   )
  // }

  let duration = 0

  ;(() => {
    const BUFFER_SIZE = 500_000

    const PUSH_ARRAY_SIZE = 2_000_000
  
    const PUSH_SIZE = Math.round(PUSH_ARRAY_SIZE / BUFFER_SIZE) * BUFFER_SIZE
  
    const FIRST_ARRAY_SIZE = PUSH_SIZE
    const SECOND_ARRAY_SIZE = FIRST_ARRAY_SIZE + PUSH_SIZE
    const THIRD_ARRAY_SIZE = SECOND_ARRAY_SIZE + PUSH_SIZE
    const FOURTH_ARRAY_SIZE = THIRD_ARRAY_SIZE + PUSH_SIZE
    const FIFTH_ARRAY_SIZE = FOURTH_ARRAY_SIZE + PUSH_SIZE
  
    const typedArrayBuffer2 = typedArrayBuffer.slice(0, FIRST_ARRAY_SIZE) // 5s
    const typedArrayBuffer3 = typedArrayBuffer.slice(FIRST_ARRAY_SIZE, SECOND_ARRAY_SIZE) // 14s
    const typedArrayBuffer4 = typedArrayBuffer.slice(SECOND_ARRAY_SIZE, THIRD_ARRAY_SIZE) // 22s
    const typedArrayBuffer5 = typedArrayBuffer.slice(THIRD_ARRAY_SIZE, FOURTH_ARRAY_SIZE) // 22s
    console.log('PUSH_SIZE', PUSH_SIZE)
  
    const remuxer = new module.Remuxer()
    remuxer.push(typedArrayBuffer2)
    remuxer.init(BUFFER_SIZE)
    console.log('remuxer', remuxer)
    remuxer.push(typedArrayBuffer3)
    remuxer.process()
    const buff1 = new Uint8Array(remuxer.getInt8Array())
    remuxer.clearInput()
    remuxer.clearOutput()
    remuxer.push(typedArrayBuffer4)
    remuxer.push(typedArrayBuffer5)
    remuxer.process()
    // remuxer.close()
    console.log('video formats: ', remuxer.getInfo())
    duration = remuxer.getInfo().input.duration / 1_000_000
    const buff2 = new Uint8Array(remuxer.getInt8Array())
    const _resultBuffer = new Uint8Array(buff1.byteLength + buff2.byteLength)
    _resultBuffer.set(buff1, 0)
    _resultBuffer.set(buff2, buff1.byteLength)
    resultBuffer.set(_resultBuffer, 0)
  })()


  const header = [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D]
  resultBuffer.set(header, 0)

  // remuxer.push(typedArrayBuffer3)
  // remuxer.process()
  // const buff1 = new Uint8Array(remuxer.getInt8Array())
  // remuxer.clearInput()
  // remuxer.clearOutput()
  // remuxer.push(typedArrayBuffer4)
  // remuxer.push(typedArrayBuffer5)
  // remuxer.process()
  // console.log('video formats: ', remuxer.getInfo())
  // const buff2 = new Uint8Array(remuxer.getInt8Array())
  // const resultBuffer = new Uint8Array(buff1.byteLength + buff2.byteLength)
  // resultBuffer.set(buff1, 0)
  // resultBuffer.set(buff2, buff1.byteLength)

  // const header = [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D]
  // resultBuffer.set(header, 0)

  // console.log('OOOOOF', resultBuffer, new TextDecoder().decode(resultBuffer))

  const video = document.createElement('video')
  video.autoplay = true
  video.controls = true
  video.volume = 0
  video.playbackRate = 2
  video.addEventListener('error', ev => {
    console.error(ev.target.error)
  })
  document.body.appendChild(video)

  let mp4boxfile = createFile()
  mp4boxfile.onError = e => console.error('onError', e)

  const buff = resultBuffer.slice(0, 6_000_000).buffer
  // @ts-ignore
  // buff.fileStart = 0
  console.log('buff', buff)

  // const info: any = await new Promise(resolve => {
  //   mp4boxfile.onReady = info => {
  //     console.log('READY', info)
  //     resolve(info)
  //   }
  //   mp4boxfile.start()
  //   mp4boxfile.appendBuffer(buff)
  //   console.log('APPENDED')
  //   mp4boxfile.flush()
  //   console.log('FLUSHED')
  // })
  // console.log('mp4boxfile', mp4boxfile)

  // let mime = 'video/mp4; codecs=\"'
  // for (let i = 0; i < info.tracks.length; i++) {
  //   if (i !== 0) mime += ','
  //   mime += info.tracks[i].codec
  // }
  // mime += '\"'

  // console.log('info', info)

  const mediaSource = new MediaSource()
  video.src = URL.createObjectURL(mediaSource)

  const sourceBuffer: SourceBuffer =
    await new Promise(resolve =>
      mediaSource.addEventListener(
        'sourceopen',
        () => resolve(mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640029,mp4a.40.2"; profiles="iso5,iso6,mp41"')), // mime: video/mp4; codecs="avc1.640029,mp4a.40.2"; profiles="iso5,iso6,mp41"
        { once: true }
      )
    )

  mediaSource.duration = duration
  sourceBuffer.appendBuffer(buff)
})
