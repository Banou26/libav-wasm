import { createFile } from 'mp4box'

import { makeTransmuxer, SEEK_FLAG, SEEK_WHENCE_FLAG } from '.'

fetch('../dist/spy13broke.mkv')
  .then(async ({ headers, body }) => {
    const contentLength = Number(headers.get('Content-Length'))
    const buffer = await new Response(body).arrayBuffer()

    let mp4boxfile = createFile()
    mp4boxfile.onError = e => console.error('onError', e)
    mp4boxfile.onSamples = (id, user, samples) => {
      // console.log('onSamples', id, user, samples)
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
        console.log('mp4box sample', {
          firstSample,
          lastSample,
          keyframeIndex: firstSample.moof_number - 1,
          // id: firstSample.moof_number - 1,
          startTime: firstSample.cts / firstSample.timescale,
          endTime: firstSample.cts / firstSample.timescale === lastSample.cts / lastSample.timescale ? lastSample.cts / lastSample.timescale + 0.02 : lastSample.cts / lastSample.timescale,
          // start: firstSample.cts / firstSample.timescale,
          // end: lastSample.cts / lastSample.timescale,
          buffered: false
        })
        mp4boxfile.releaseUsedSamples(1, lastSample.number)
      }
    }

    let _resolveInfo
    const infoPromise = new Promise((resolve) => { _resolveInfo = resolve })

    let mime = 'video/mp4; codecs=\"'
    let info: string | undefined
    mp4boxfile.onReady = (_info) => {
      console.log('mp4box ready info', _info)
      info = _info
      for (let i = 0; i < info.tracks.length; i++) {
        if (i !== 0) mime += ','
        mime += info.tracks[i].codec
      }
      mime += '\"'
      mp4boxfile.setExtractionOptions(1, undefined, { nbSamples: 1000 })
      mp4boxfile.start()
      _resolveInfo(info)
    }

    let currentOffset = 0
    let mp4boxOffset = 0
    const transmuxer = await makeTransmuxer({
      bufferSize: 1_000_000,
      sharedArrayBufferSize: 2_000_000,
      length: contentLength,
      read: async (offset, size) => {
        const buff = new Uint8Array(buffer.slice(Number(offset), offset + size))
        currentOffset = currentOffset + buff.byteLength
        return buff
      },
      seek: async (offset, whence) => {
        if (whence === SEEK_WHENCE_FLAG.SEEK_CUR) {
          currentOffset = currentOffset + offset
          return currentOffset;
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_END) {
          return -1;
        }
        if (whence === SEEK_WHENCE_FLAG.SEEK_SET) {
          currentOffset = offset
          return currentOffset;
        }
        if (whence === SEEK_WHENCE_FLAG.AVSEEK_SIZE) {
          return contentLength;
        }
        return -1
      },
      subtitle: (title, language, subtitle) => {
        // console.log('SUBTITLE HEADER', title, language, subtitle)
      },
      attachment: (filename: string, mimetype: string, buffer: Uint8Array) => {
        // console.log('attachment', filename, mimetype, buffer)
      },
      write: (offset, buffer, pts, duration, pos) => {
        console.log('receive write', offset, pts, duration, pos, new Uint8Array(buffer))
        if (!info) {
          console.log('writing init no info', mp4boxOffset)
          buffer.fileStart = mp4boxOffset
          mp4boxfile.appendBuffer(buffer)
          mp4boxOffset = mp4boxOffset + buffer.byteLength
        }
      }
    })
    console.log('mt transmuxer', transmuxer)

    await transmuxer.init()

    console.log('init finished')

    const duration = (await transmuxer.getInfo()).input.duration / 1_000_000

    await infoPromise

    console.log('DURATION', duration)

    const video = document.createElement('video')
    // video.autoplay = true
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
      console.error(ev.target.error)
    })
    document.body.appendChild(video)
    
    setTimeout(() => {
      video.play()
    }, 5_000)

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

    mediaSource.duration = duration
    sourceBuffer.mode = 'segments'

    



    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.seek(50000, SEEK_FLAG.NONE)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // await new Promise(resolve => setTimeout(resolve, 2000))
    // transmuxer.process(10_000_000)
    // setInterval(() => {
    //   console.log('process')
    //   transmuxer.process()
    // }, 5_000)
  })
