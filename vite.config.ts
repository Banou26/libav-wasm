import { defineConfig } from 'vite'
import commonjs from '@rollup/plugin-commonjs'

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
          next()
        })
      }
    }
  ],
  server: {
    fs: {
      allow: ['../..']
    }
  }
}))
