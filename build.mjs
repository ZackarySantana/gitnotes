import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')

const common = {
  bundle: true,
  sourcemap: true,
  target: 'chrome110',
  logLevel: 'info',
  outdir: 'dist',
}

// The service worker is a module ("type": "module" in the manifest); content
// script and options page must be classic scripts.
const builds = [
  { ...common, entryPoints: { background: 'src/background/index.ts' }, format: 'esm' },
  {
    ...common,
    entryPoints: {
      content: 'src/content/index.ts',
      options: 'src/options/options.ts',
      hub: 'src/hub/index.ts',
      sandbox: 'src/sandbox/index.ts',
    },
    format: 'iife',
  },
]

function copyStatic() {
  mkdirSync('dist', { recursive: true })
  cpSync('src/manifest.json', 'dist/manifest.json')
  cpSync('src/options/options.html', 'dist/options.html')
  cpSync('src/content/content.css', 'dist/content.css')
  cpSync('src/hub/hub.html', 'dist/hub.html')
  cpSync('src/hub/hub.css', 'dist/hub.css')
  cpSync('src/sandbox/sandbox.html', 'dist/sandbox.html')
}

if (watch) {
  copyStatic()
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('watching…')
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)))
  copyStatic()
}
