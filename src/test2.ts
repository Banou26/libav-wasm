import { makeTransmuxer, SEEK_WHENCE_FLAG } from '.'



fetch('../dist/spy13broke.mkv')
  .then(async ({ headers, body }) => {
    const contentLength = Number(headers.get('Content-Length'))
    const buffer = await new Response(body).arrayBuffer()

    let currentOffset = 0
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
      }
    })
    console.log('mt transmuxer', transmuxer)

    transmuxer.init()

    // setInterval(() => {
    //   console.log('process')
    //   transmuxer.process()
    // }, 5_000)
  })
