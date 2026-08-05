// Serves the built library, the harness page and the fixtures, with real HTTP range support because that
// is exactly how a consumer feeds this library: a `read(offset, size)` backed by partial requests.

import { createServer } from 'node:http'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BUILD = resolve(HERE, '../build')
const FIXTURES = resolve(HERE, '../fixtures')

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

const sendFile = (res, path) => {
  try {
    const body = readFileSync(path)
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}

const sendRange = (req, res, path) => {
  let info
  try { info = statSync(path) } catch { return res.writeHead(404).end('no such fixture') }

  const range = req.headers.range
  if (!range) {
    res.writeHead(200, { 'content-length': info.size, 'accept-ranges': 'bytes' })
    return createReadStream(path).pipe(res)
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  const start = match?.[1] ? Number(match[1]) : 0
  const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
  if (start >= info.size || start > end) {
    return res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
  }
  res.writeHead(206, {
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
  })
  createReadStream(path, { start, end }).pipe(res)
}

export const startServer = (port = 0) => new Promise((ready) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/media') {
      const name = url.searchParams.get('name')
      // the fixture name is a path segment from the test, never from the page, but keep it inside the dir
      if (!name || name.includes('..')) return res.writeHead(400).end('bad fixture name')
      return sendRange(req, res, join(FIXTURES, name))
    }
    if (url.pathname === '/size') {
      const name = url.searchParams.get('name')
      if (!name || name.includes('..')) return res.writeHead(400).end('bad fixture name')
      try {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ length: statSync(join(FIXTURES, name)).size }))
      } catch {
        return res.writeHead(404).end('{}')
      }
    }
    if (url.pathname.startsWith('/build/')) return sendFile(res, join(BUILD, url.pathname.slice('/build/'.length)))
    if (url.pathname === '/') return sendFile(res, join(HERE, 'harness.html'))
    return sendFile(res, join(HERE, url.pathname.slice(1)))
  })
  server.listen(port, '127.0.0.1', () => ready({ server, port: server.address().port }))
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2]) || 4599)
  console.log(`libav test rig on http://127.0.0.1:${port}`)
}
