import { defineConfig } from 'vite'
import commonjs from '@rollup/plugin-commonjs'

export default defineConfig((env) => ({
  build: {
    target: 'esnext',
    outDir: 'build',
    lib: {
      fileName: 'index',
      entry: 'src/index.ts',
      formats: ['es']
    },
    rollupOptions: {
      input: {
        index: 'src/index.ts'
      },
      external: ['buffer', 'mp4box', 'osra']
    }
  },
  plugins: [
    ...(
      env.mode === 'development'
        ? []
        : [commonjs()]
    )
  ]
}))
