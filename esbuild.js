// Build script for the Cate Canvas extension.
// Produces two bundles:
//   dist/extension.js  — the extension host (Node, CommonJS, `vscode` external)
//   dist/webview.js    — the webview app (browser IIFE, no externals)
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

// node-pty's macOS prebuilds ship a `spawn-helper` binary that the native
// pty.fork() execve()s to set up the controlling TTY before launching the
// shell — so it MUST be executable. npm install / archive extraction can land
// it as 0644, which makes every terminal spawn fail with `posix_spawnp failed`
// (EACCES) both in the F5 dev host (runs straight from node_modules) and in the
// packaged .vsix (vsce preserves the stored unix mode). Re-assert the exec bit
// on every build so neither path can regress. Windows executes by extension, so
// its prebuilt .exe/.dll need no bit; pty.node is dlopen'd, not execve'd.
function ensureNativeHelpersExecutable() {
  const prebuilds = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds')
  for (const rel of ['darwin-arm64/spawn-helper', 'darwin-x64/spawn-helper']) {
    const p = path.join(prebuilds, rel)
    try {
      fs.chmodSync(p, 0o755)
    } catch {
      // Absent on this platform or in a pruned tree — nothing to fix.
    }
  }
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
}

const extensionConfig = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // `vscode` is provided by the host; `node-pty` is a native module that must be
  // required from node_modules at runtime (it cannot be bundled).
  external: ['vscode', 'node-pty'],
}

const webviewConfig = {
  ...shared,
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2021',
  // xterm's stylesheet is imported as a string and injected at runtime.
  // Tabler icon SVGs are imported as strings and set via innerHTML.
  loader: { '.css': 'text', '.svg': 'text' },
}

async function main() {
  ensureNativeHelpersExecutable()
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig)
    const ctxWeb = await esbuild.context(webviewConfig)
    await Promise.all([ctxExt.watch(), ctxWeb.watch()])
    console.log('[cate-canvas] watching…')
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)])
    console.log('[cate-canvas] build complete')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
