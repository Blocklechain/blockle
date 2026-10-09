// scripts/test.js — discover and run every *.test.js in the extension, each in
// its own `node` process, and aggregate the results. Portable (no shell globs).
// Exits non-zero if any suite fails.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'icons', 'demo', '.git', 'scripts']);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, out); }
    else if (name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const suites = walk(ROOT, []).sort();
if (!suites.length) { console.log('no test suites found'); process.exit(0); }

let failed = 0;
for (const s of suites) {
  const rel = path.relative(ROOT, s);
  const r = spawnSync(process.execPath, [s], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error('SUITE FAILED: ' + rel); }
  else console.log('SUITE OK: ' + rel);
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
