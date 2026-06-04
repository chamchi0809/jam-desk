// Ambient module declarations for non-code imports handled by esbuild loaders.

// xterm's stylesheet is imported as a raw string (esbuild `text` loader) and
// injected into a <style> element at runtime.
declare module '*.css' {
  const content: string
  export default content
}
