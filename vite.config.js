import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
    outDir: 'build',
    lib: {
      name: '@banou26/oz-libav',
      fileName: 'index',
      entry: 'src/index.ts',
      formats: ['es']
    },
    worker: {
      format: 'es',
    },
    rollupOptions: {
      external: ['@bufbuild/protobuf', 'buffer', 'mp4box', 'osra']
    }
  },
  optimizeDeps: {
    include: ['libav']
  },
  plugins: [
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      }
    }
  ]
})
