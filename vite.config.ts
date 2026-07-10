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
  build: {
    target: 'esnext',
    outDir: 'build',
    minify: false,
    lib: {
      fileName: 'index',
      entry: 'src/index.ts',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['buffer', 'mp4box'],
    },
  },
  plugins: lazyPlugins(() => [
    ...(env.mode === 'development' ? [] : [commonjs()]),
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cache-Control', 'no-store')
          next()
        })
      },
    },
  ]),
  server: {
    fs: {
      allow: ['../..'],
    },
  },
}))
