// moduleResolution "Node" ignores the package "exports" map, so point TS at the dist paths for the
// @videojs subpath imports. Vite resolves the real subpaths fine at runtime.
declare module '@videojs/core/dom' {
  export * from '@videojs/core/dist/dev/dom'
}

declare module '@videojs/react/video' {
  export * from '@videojs/react/dist/dev/presets/video'
}
