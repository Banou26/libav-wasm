// A browser without WebCodecs, from the inside. Firefox for Android is the real one; blanking the globals
// before the worker module evaluates reproduces it exactly, because makeRemuxer decides which decoder to
// use by feature-detecting them. Dynamic import, since a static one would hoist above these assignments.
globalThis.VideoDecoder = undefined
globalThis.EncodedVideoChunk = undefined
globalThis.VideoFrame = undefined

await import('/build/worker.js')
