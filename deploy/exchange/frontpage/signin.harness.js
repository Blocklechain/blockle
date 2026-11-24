// Verify the particle sampler produces a real mark (not an empty canvas) and
// that the redirect validator closes the open-redirect hole.
const fs = require('fs');
const src = fs.readFileSync('deploy/exchange/frontpage/signin.html','utf8');
const js = src.slice(src.indexOf('<script>')+8, src.lastIndexOf('</script>'));
const assert = require('assert');

// --- sampleMark: run it against a tiny fake 2D context that records ops and
// returns a plausible alpha field, to prove it samples and returns points.
let fillTextCalled = false, strokeCount = 0;
const SIZE = 240;
const alpha = new Uint8Array(SIZE*SIZE);
const fakeCtx = {
  strokeStyle:'', fillStyle:'', lineWidth:0, lineJoin:'', lineCap:'', font:'',
  textAlign:'', textBaseline:'',
  beginPath(){}, closePath(){}, moveTo(){}, lineTo(){},
  stroke(){ strokeCount++; },
  fillText(){ fillTextCalled = true; },
  getImageData(){
    // Mark a diagonal band as opaque so sampling has something to find.
    const d = new Uint8Array(SIZE*SIZE*4);
    for (let y=0;y<SIZE;y++) for (let x=0;x<SIZE;x++)
      if (Math.abs(x-y) < 20) d[(y*SIZE+x)*4+3] = 255;
    return { data: d };
  },
};
const sandbox = {
  document: {
    createElement: () => ({ width:0, height:0, getContext: () => fakeCtx }),
    getElementById: () => null, addEventListener(){},
  },
  window: { matchMedia: () => ({matches:false}), addEventListener(){} },
  location: { search:'', origin:'https://exchange.blockle.org', pathname:'/signin.html' },
  URL, URLSearchParams, Math, console,
  requestAnimationFrame: () => 0, performance: { now: () => 0 },
  fetch: () => Promise.reject(new Error('no network in harness')),
};
// Extract just sampleMark and destination for direct testing.
const pick = (name) => {
  const i = js.indexOf('function ' + name);
  assert.ok(i > 0, name + ' not found');
  // Balance braces from the first {
  let d = 0, start = js.indexOf('{', i), j = start;
  for (; j < js.length; j++) { if (js[j]==='{') d++; else if (js[j]==='}') { d--; if (!d) break; } }
  return js.slice(i, j+1);
};
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(pick('sampleMark') + '\n' + pick('destination'), sandbox);

const pts = sandbox.sampleMark(SIZE);
assert.ok(pts.length > 500, `sampleMark returned only ${pts.length} points`);
assert.ok(strokeCount >= 2, 'the cube outline and inner edges are both stroked');
assert.ok(fillTextCalled, 'the B is drawn');
console.log(`sampleMark: ${pts.length} particle targets, cube stroked ${strokeCount}x, B drawn`);

// --- destination(): the open-redirect guard.
const cases = [
  ['', 'app.html'],
  ['?return=%2Fapp.html%23%2Fbalances', '/app.html#/balances'],
  ['?return=https%3A%2F%2Fevil.example%2Fsteal', 'app.html'],
  ['?return=%2F%2Fevil.example%2Fsteal', 'app.html'],
  ['?return=javascript%3Aalert(1)', 'app.html'],
];
for (const [search, want] of cases) {
  sandbox.location.search = search;
  const got = sandbox.destination();
  assert.equal(got, want, `return=${search} -> ${got}, wanted ${want}`);
}
console.log(`destination(): ${cases.length} cases correct, including 3 open-redirect attempts`);
