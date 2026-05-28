import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'

// Separate config for perf benchmarks (tests/perf.bench.ts). Run via `npm run test:perf`.
// Differences from the standard config:
//   - matches `*.bench.ts` instead of `*.spec.ts`
//   - longer testTimeout (the per-resolution probes can each take a minute or two)
//   - only firefox — chromium plays HEVC natively so the fallback path doesn't even run
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
            // no-store: iterative wasm rebuilds must never be served stale from the browser
            // HTTP cache. A stale glue/wasm pairing surfaces as "indirect call signature mismatch".
            res.setHeader('Cache-Control', 'no-store')
            createReadStream(filePath).pipe(res)
          } catch { next() }
        }
        server.middlewares.use('/dist', serveRaw('dist'))
        server.middlewares.use('/build', serveRaw('build'))
      },
    },
  ],
  test: {
    include: ['tests/**/*.bench.ts'],
    testTimeout: 240_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: false,
      instances: [{ browser: 'firefox' }],
    },
  },
})
