// Bundle the anchor service into one plain-node JS file (no tsx needed on the
// box). The wasm module is required at runtime via a variable path, so esbuild
// leaves it external automatically; @noble/* and the core are bundled in.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/server.mjs',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
})
console.log('built dist/server.mjs')
