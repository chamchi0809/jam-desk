// SVG files are imported as raw markup strings (esbuild `text` loader).
declare module '*.svg' {
  const content: string
  export default content
}
