import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext'
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
