import { defineConfig } from 'vite'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill'
import rollupNodePolyFill from 'rollup-plugin-node-polyfills'
// import wasm from "vite-plugin-wasm"

export default defineConfig({
  resolve: {
    alias: {
      util: 'rollup-plugin-node-polyfills/polyfills/util',
      sys: 'util',
      events: 'rollup-plugin-node-polyfills/polyfills/events',
      stream: 'rollup-plugin-node-polyfills/polyfills/stream',
      path: 'rollup-plugin-node-polyfills/polyfills/path',
      querystring: 'rollup-plugin-node-polyfills/polyfills/qs',
      punycode: 'rollup-plugin-node-polyfills/polyfills/punycode',
      url: 'rollup-plugin-node-polyfills/polyfills/url',
      string_decoder: 'rollup-plugin-node-polyfills/polyfills/string-decoder',
      http: 'rollup-plugin-node-polyfills/polyfills/http',
      https: 'rollup-plugin-node-polyfills/polyfills/http',
      os: 'rollup-plugin-node-polyfills/polyfills/os',
      assert: 'rollup-plugin-node-polyfills/polyfills/assert',
      constants: 'rollup-plugin-node-polyfills/polyfills/constants',
      _stream_duplex:
        'rollup-plugin-node-polyfills/polyfills/readable-stream/duplex',
      _stream_passthrough:
        'rollup-plugin-node-polyfills/polyfills/readable-stream/passthrough',
      _stream_readable:
        'rollup-plugin-node-polyfills/polyfills/readable-stream/readable',
      _stream_writable:
        'rollup-plugin-node-polyfills/polyfills/readable-stream/writable',
      _stream_transform:
        'rollup-plugin-node-polyfills/polyfills/readable-stream/transform',
      timers: 'rollup-plugin-node-polyfills/polyfills/timers',
      console: 'rollup-plugin-node-polyfills/polyfills/console',
      vm: 'rollup-plugin-node-polyfills/polyfills/vm',
      zlib: 'rollup-plugin-node-polyfills/polyfills/zlib',
      tty: 'rollup-plugin-node-polyfills/polyfills/tty',
      domain: 'rollup-plugin-node-polyfills/polyfills/domain'
    }
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      include: ['libav'],
      transformMixedEsModules: true
    }
  },
  optimizeDeps: {
    include: ['libav'],
      esbuildOptions: {
          define: {
              global: "globalThis",
          },
          plugins: [
            NodeGlobalsPolyfillPlugin({
                  process: true,
                  buffer: true,
              }),
          ],
      },
  },
  server: {
    fs: {
      allow: ['..'],
    }
  },
  plugins: [
    {
      name: "configure-response-headers",
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          next();
        });
      },
    },
  ]
})

// export default defineConfig({
//   resolve: {
//     alias: {
//       util: 'rollup-plugin-node-polyfills/polyfills/util',
//       sys: 'util',
//       events: 'rollup-plugin-node-polyfills/polyfills/events',
//       stream: 'rollup-plugin-node-polyfills/polyfills/stream',
//       path: 'rollup-plugin-node-polyfills/polyfills/path',
//       querystring: 'rollup-plugin-node-polyfills/polyfills/qs',
//       punycode: 'rollup-plugin-node-polyfills/polyfills/punycode',
//       url: 'rollup-plugin-node-polyfills/polyfills/url',
//       string_decoder: 'rollup-plugin-node-polyfills/polyfills/string-decoder',
//       http: 'rollup-plugin-node-polyfills/polyfills/http',
//       https: 'rollup-plugin-node-polyfills/polyfills/http',
//       os: 'rollup-plugin-node-polyfills/polyfills/os',
//       assert: 'rollup-plugin-node-polyfills/polyfills/assert',
//       constants: 'rollup-plugin-node-polyfills/polyfills/constants',
//       _stream_duplex:
//         'rollup-plugin-node-polyfills/polyfills/readable-stream/duplex',
//       _stream_passthrough:
//         'rollup-plugin-node-polyfills/polyfills/readable-stream/passthrough',
//       _stream_readable:
//         'rollup-plugin-node-polyfills/polyfills/readable-stream/readable',
//       _stream_writable:
//         'rollup-plugin-node-polyfills/polyfills/readable-stream/writable',
//       _stream_transform:
//         'rollup-plugin-node-polyfills/polyfills/readable-stream/transform',
//       timers: 'rollup-plugin-node-polyfills/polyfills/timers',
//       console: 'rollup-plugin-node-polyfills/polyfills/console',
//       vm: 'rollup-plugin-node-polyfills/polyfills/vm',
//       zlib: 'rollup-plugin-node-polyfills/polyfills/zlib',
//       tty: 'rollup-plugin-node-polyfills/polyfills/tty',
//       domain: 'rollup-plugin-node-polyfills/polyfills/domain'
//     }
//   },
//   define: {
//     global: 'globalThis',
//     process: {
//       env: {

//       }
//     }
//   },
//   // build: {
//   //   target: 'esnext',
//   //   commonjsOptions: {
//   //     // include: ['buffer'],
//   //     transformMixedEsModules: true
//   //   }
//   // },
//   optimizeDeps: {
//     // include: ['buffer'],
//     esbuildOptions: {
//       define: {
//         global: 'globalThis',
//       },
//       plugins: [
//         NodeGlobalsPolyfillPlugin({
//           process: true,
//           buffer: true,
//           define: {
//             global: 'globalThis'
//           }
//         }),
//         NodeModulesPolyfillPlugin()
//       ]
//     }
//   },
//   plugins: [
//     // wasm(),
//     rollupNodePolyFill()
//   ],
//   server: {
//     fs: {
//       allow: ['..'],
//     }
//   }
// })
