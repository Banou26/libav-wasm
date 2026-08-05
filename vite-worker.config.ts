import { fileURLToPath } from 'node:url'

import { defineConfig, lazyPlugins } from 'vite-plus'
import commonjs from '@rollup/plugin-commonjs'

export default defineConfig((env) => ({
  fmt: { semi: false, singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['tests/**', '**/*.spec.ts', '**/*.test.ts', 'examples/**'],
        rules: {
          'no-floating-promises': 'off',
          'no-unused-vars': 'off',
          'no-unused-expressions': 'off',
        },
      },
    ],
  },
  // the emscripten glue is a build artifact, not a dependency. Resolving it by path is what lets the build
  // stop installing dist/ as a package and then uninstalling it, a dance that rewrote package.json mid-build
  // and left "libav": "file:dist" in released manifests whenever a step in between failed.
  resolve: {
    alias: { libav: fileURLToPath(new URL('./dist/libav.js', import.meta.url)) },
  },
  build: {
    emptyOutDir: false,
    target: 'esnext',
    outDir: 'build',
    lib: {
      fileName: 'worker',
      entry: 'src/worker/index.ts',
      formats: ['es'],
    },
  },
  plugins: lazyPlugins(() => [...(env.mode === 'development' ? [] : [commonjs()])]),
}))
