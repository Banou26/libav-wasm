import { defineConfig } from 'vite'
import commonjs from '@rollup/plugin-commonjs'

export default defineConfig((env) => ({
  build: {
    emptyOutDir: false,
    target: 'esnext',
    outDir: 'build',
    lib: {
      fileName: 'worker',
      entry: 'src/worker/index.ts',
      formats: ['es']
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
