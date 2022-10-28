import { makeTransmuxer } from '.'



fetch('../dist/spy13broke.mkv')
  .then(async ({ headers, body }) => {
    const contentLength = Number(headers.get('Content-Length'))
    const buffer = await new Response(body).arrayBuffer()

    const transmuxer = await makeTransmuxer({
      bufferSize: 1_000_000,
      sharedArrayBufferSize: 1_500_000,
      length: contentLength,
      read: async (offset, size) => {
        const buff = new Uint8Array(buffer.slice(Number(offset), size))
        console.log('mt read', offset, size, buff)
        return buff
      },
      seek: async (offset, whence) => {
        console.log('mt seek', offset, whence)
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
