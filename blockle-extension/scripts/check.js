// scripts/check.js — `node --check` every JS source file in the extension (the
// "build" step for a no-bundler MV3 extension). Portable across CI runners: no
// shell globbing. Exits non-zero if any file fails to parse.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'icons', 'demo', '.git']);
// wasm-bindgen output is machine-generated; still parseable, so we check it too.

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, out); }
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []).sort();
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    failed++;
    process.stderr.write('FAIL --check ' + path.relative(ROOT, f) + '\n' + (e.stderr ? e.stderr.toString() : '') + '\n');
  }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
