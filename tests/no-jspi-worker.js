// A browser without JSPI, from the inside. Safari is the real one, and iOS is every browser on it; blanking
// the constructor before the worker module evaluates is what makes makeModule take the Asyncify build,
// because it feature-detects WebAssembly.Suspending rather than sniffing a UA. Dynamic import, since a
// static one would hoist above this assignment and the detection would already have run.
try {
  delete WebAssembly.Suspending
} catch {
  WebAssembly.Suspending = undefined
}

await import('/build/worker.js')
