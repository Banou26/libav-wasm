import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    {
      name: 'serve-prebuilt-raw',
      configureServer: (server) => {
        const serveRaw = (rootDir: string) => (req: any, res: any, next: any) => {
          const filePath = join(process.cwd(), rootDir, (req.url || '/').split('?')[0])
          try {
            const stat = statSync(filePath)
            if (!stat.isFile()) return next()
            const ext = extname(filePath)
            const type = ext === '.js' ? 'text/javascript'
              : ext === '.wasm' ? 'application/wasm'
              : ext === '.map' ? 'application/json'
              : 'application/octet-stream'
            res.setHeader('Content-Type', type)
            res.setHeader('Content-Length', String(stat.size))
            res.setHeader('Cache-Control', 'public, max-age=300')
            createReadStream(filePath).pipe(res)
          } catch { next() }
        }
        server.middlewares.use('/dist', serveRaw('dist'))
        server.middlewares.use('/build', serveRaw('build'))
      },
    },
  ],
  test: {
    include: ['tests/**/*.spec.ts'],
    // Firefox single-threaded HEVC decode (especially at 1080p+) is CPU-bound in WASM and
    // can take a while to produce the first fragment. Give every test enough headroom to
    // actually complete the worst case.
    testTimeout: 90_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: false,
      instances: [
        { browser: 'chromium' },
        { browser: 'firefox' },
      ],
    },
  },
})
