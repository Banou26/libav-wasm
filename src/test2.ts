import { makeTransmuxer } from '.'



fetch('../dist/spy13broke.mkv')
  .then(async ({ headers, body }) => {
    const contentLength = Number(headers.get('Content-Length'))
    const buffer = await new Response(body).arrayBuffer()

    const transmuxer = makeTransmuxer({
      bufferSize: 1_000_000,
      sharedArrayBufferSize: 2_000_000,
      length: contentLength,
      read: async (offset, size) => {
        console.log('read', offset, size)
        return new Uint8Array(buffer.slice(Number(offset), size))
      },
      seek: async (offset, whence) => {
        console.log('seek', offset, whence)
        return -1n
      }
    })
  })
