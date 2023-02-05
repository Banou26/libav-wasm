import { defineConfig } from 'vite'
import commonjs from '@rollup/plugin-commonjs'

export default defineConfig((env) => ({
  build: {
    emptyOutDir: false,
    target: 'esnext',
    outDir: 'build',
    minify: false
  },
  plugins: [
    ...(
      env.mode === 'development'
        ? []
        : [commonjs()]
    )
  ],
  optimizeDeps: {
    include: ['libav']
  }
}))
