import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/verify.ts'],
  bundle: true, format: 'esm', target: 'es2020', minify: true, sourcemap: false,
  outfile: 'dist/verify.js', legalComments: 'none'
})
for (const f of ['index.html', 'verify.html', 'style.css', 'icon.png', 'icon-1024.png', 'site.js']) cpSync(f, `dist/${f}`)
console.log('built dist/')
