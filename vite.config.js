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
      formats: ['es']
    },
    rollupOptions: {
      input: {
        index: 'src/index.ts',
        worker: 'src/worker/index.ts'
      },
      external: ['buffer', 'mp4box', 'osra']
    }
  },
  optimizeDeps: {
    include: ['libav']
  }
})
