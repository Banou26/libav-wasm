import { defineConfig } from 'vite'
import commonjs from '@rollup/plugin-commonjs'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export default defineConfig((env) => ({
  build: {
    target: 'esnext',
    outDir: 'build',
    minify: false,
    lib: {
      fileName: 'index',
      entry: 'src/index.ts',
      formats: ['es']
    },
    rollupOptions: {
      external: ['buffer', 'mp4box', 'osra']
    }
  },
  plugins: [
    ...(
      env.mode === 'development'
        ? []
        : [commonjs()]
    ),
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cache-Control', 'no-store')
          // Cross-origin isolation -> SharedArrayBuffer available -> multi-threaded wasm works.
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          next()
        })
      }
    },
    {
      // Serve /dist/* and /build/* as raw static, bypassing vite's source transforms. Both
      // contain prebuilt outputs that must not be HMR-rewritten:
      //  - /dist/libav*.js: emscripten glue with dynamic Worker(...) calls vite can't analyze
      //  - /build/worker.js: bundled worker; vite-dev injects a top-level `import "/@vite/client"`
      //    when it sees dynamic import(), which is illegal in classic workers AND breaks module
      //    workers in Firefox (client expects DOM APIs).
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
            createReadStream(filePath).pipe(res)
          } catch { next() }
        }
        server.middlewares.use('/dist', serveRaw('dist'))
        server.middlewares.use('/build', serveRaw('build'))
      }
    }
  ],
  server: {
    fs: {
      allow: ['../..']
    }
  }
}))
