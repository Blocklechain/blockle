import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'esm',
  target: 'node20', outfile: 'dist/server.mjs', legalComments: 'none' })
console.log('built dist/server.mjs')
