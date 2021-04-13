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
  console.log(':)')
  const module = await v()
  console.log(v)
  console.log(module)

  const typedArrayBuffer = new Uint8Array((await (await fetch('./video.mkv')).arrayBuffer()))
  console.log('typedArrayBuffer', typedArrayBuffer, typedArrayBuffer.byteLength)

  const BUFFER_SIZE = 2_000_000
  // const BUFFER_SIZE = 65536

  const PUSH_ARRAY_SIZE = 5_000_000

  const PUSH_SIZE = Math.round(PUSH_ARRAY_SIZE / BUFFER_SIZE) * BUFFER_SIZE
  // const PUSH_SIZE = 2_000_000

  console.log('BUFFER_SIZE', BUFFER_SIZE)
  console.log('PUSH_SIZE', PUSH_SIZE)

  const remuxer = new module.Remuxer()
  console.log('remuxer', remuxer)

  const resultBuffer = new Uint8Array(300_000_000)
  let processedBytes = 0
  let outputBytes = 0
  let isInitialized = false
  while (processedBytes < 100_000_000) { // processedBytes !== typedArrayBuffer.byteLength
    const bufferToPush = typedArrayBuffer.slice(processedBytes, processedBytes + PUSH_SIZE)
    remuxer.push(bufferToPush)
    processedBytes += bufferToPush.byteLength

    if (!isInitialized) {
      remuxer.init(BUFFER_SIZE)
      isInitialized = true
    }

    remuxer.process()
    remuxer.clearInput()

    const result = remuxer.getInt8Array()
    resultBuffer.set(result, outputBytes)
    outputBytes += result.byteLength
  
    remuxer.clearOutput()
    console.log(
      'processedBytes', processedBytes,
      '\noutputBytes', outputBytes,
      '\nbufferToPush.byteLength', bufferToPush.byteLength,
      '\nresult.byteLength', result.byteLength
    )
  }

  const duration = remuxer.getInfo().input.duration / 1_000_000

  const header = [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36, 0x6D]
  resultBuffer.set(header, 0)
  console.log('resultBuffer', outputBytes.toLocaleString(), resultBuffer)

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

  const chunks = []

  mp4boxfile.onSamples = (id, user, samples) => {
    console.log('onSamples', id, user, samples)
    const groupBy = (xs, key) => {
      return xs.reduce((rv, x) => {
        (rv[x[key]] = rv[x[key]] || []).push(x)
        return rv
      }, []).filter(Boolean)
    }
    const groupedSamples = groupBy(samples, 'moof_number')
    for (const group of groupedSamples) {
      const firstSample = group[0]
      const lastSample = group.slice(-1)[0]

      if (chunks[firstSample.moof_number - 1]) continue

      chunks[firstSample.moof_number - 1] = {
        id: firstSample.moof_number - 1,
        start: firstSample.cts / firstSample.timescale,
        end: lastSample.cts / lastSample.timescale,
        buffered: false
      }
    }
  }
  mp4boxfile.setExtractionOptions(1)

  const buffer = resultBuffer.slice(0, outputBytes).buffer
  // @ts-ignore
  buffer.fileStart = 0

  const info: any = await new Promise(resolve => {
    mp4boxfile.onReady = info => {
      console.log('READY', info)
      resolve(info)
    }
    mp4boxfile.start()
    mp4boxfile.appendBuffer(buffer)
    console.log('APPENDED')
    mp4boxfile.flush()
    console.log('FLUSHED')
  })
  console.log('mp4boxfile', mp4boxfile, chunks)

  let mime = 'video/mp4; codecs=\"'
  for (let i = 0; i < info.tracks.length; i++) {
    if (i !== 0) mime += ','
    mime += info.tracks[i].codec
  }
  mime += '\"'

  console.log('info', info, mime)

  const mediaSource = new MediaSource()
  video.src = URL.createObjectURL(mediaSource)

  const sourceBuffer: SourceBuffer =
    await new Promise(resolve =>
      mediaSource.addEventListener(
        'sourceopen',
        () => resolve(mediaSource.addSourceBuffer(mime)), // mime: video/mp4; codecs="avc1.640029,mp4a.40.2"; profiles="iso5,iso6,mp41"
        { once: true }
      )
    )

  mediaSource.duration = duration
  // const buffer = resultBuffer.slice(0, 80_000_000).buffer
  console.log('buffer', outputBytes.toLocaleString(), buffer)
  sourceBuffer.appendBuffer(buffer)
  // sourceBuffer.appendBuffer(resultBuffer.slice(0, 80_000_000).buffer)

  // setTimeout(() => {
  //   video.currentTime = 4.5 * 60
  //   sourceBuffer.appendBuffer(resultBuffer.slice(80_000_000, outputBytes).buffer)
  // }, 1000)
})
