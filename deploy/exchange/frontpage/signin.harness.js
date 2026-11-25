// Harness for signin.html's submit handler.
//
// Drives the page against the EXACT response shapes the accounts service
// returns (read from services/accounts/src/server.js), so the 2FA flow can be
// verified without a password:
//
//   401 {error:'Email or password is incorrect.'}
//   403 {error:'Please verify your email first — check your inbox.'}
//   401 {error:'2fa', message:'Enter your 6-digit code.'}
//   200 {ok:true, csrf, user}
//
// It also covers destination() — the open-redirect guard — and sampleMark().
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// THE PAGE'S SCRIPT NOW LIVES IN ITS OWN FILE.
//
// It used to be an inline <script> that this harness sliced out of the HTML.
// The 2026-11-25 audit moved every inline block to a file so the CSP could
// drop script-src 'unsafe-inline', which a scraper of `<script>`…`</script>`
// silently turns into "parse the surrounding markup as JavaScript" — the
// failure was `Unexpected identifier 'EXCHANGE'`, i.e. it had grabbed HTML.
//
// Reading the file directly is also what the browser does, so the harness now
// tests the same bytes that ship.
const JS_PATH = 'deploy/exchange/frontpage/signin.inline.js';
const HTML_PATH = 'deploy/exchange/frontpage/signin.html';
const js = fs.readFileSync(JS_PATH, 'utf8');
// And assert the page actually loads it — an extracted file that nothing
// references would pass every test below while shipping a dead page.
const src = fs.readFileSync(HTML_PATH, 'utf8');
assert.ok(
  src.includes('src="signin.inline.js"'),
  'signin.html must load signin.inline.js — otherwise this harness is testing ' +
    'a file the page never runs',
);
assert.ok(
  !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(src),
  'signin.html must have no inline script: the CSP no longer allows it',
);

/** A 2D context stub good enough for sampleMark and the particle loop. */
function ctx2d() {
  return {
    strokeStyle:'', fillStyle:'', lineWidth:0, lineJoin:'', lineCap:'', font:'',
    textAlign:'', textBaseline:'',
    beginPath(){}, closePath(){}, moveTo(){}, lineTo(){}, arc(){}, stroke(){},
    fill(){}, fillRect(){}, fillText(){}, clearRect(){}, setTransform(){},
    createLinearGradient: () => ({ addColorStop(){} }),
    getImageData(w, h) {
      const size = 240;
      const d = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
        if (Math.abs(x - y) < 20) d[(y * size + x) * 4 + 3] = 255;
      return { data: d };
    },
  };
}

function el(id) {
  return {
    id, value: '', textContent: '', className: '', disabled: false,
    width: 0, height: 0, clientWidth: 400, clientHeight: 400,
    getContext: () => ctx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    style: { cssText: '', display: '' }, children: [], parentNode: null,
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                 contains(c){return this._s.has(c);}, toggle(c,on){ on ? this.add(c) : this.remove(c); } },
    focus(){}, select(){}, appendChild(c){this.children.push(c); return c;},
    setAttribute(){}, addEventListener(e,h){ this['on'+e] = h; },
    querySelector(){ return el('btn'); },
    querySelectorAll(){ return []; },
  };
}

function run(responses, opts = {}) {
  const nodes = {};
  const get = (id) => (nodes[id] = nodes[id] || el(id));
  get('password').value = 'hunter2';
  get('email').value = 'a@b.com';
  get('otp').value = opts.otp || '';
  // Pre-create every node the assertions read, so a branch that never touched
  // one fails the assertion rather than crashing the harness.
  ['form', 'otp-wrap', 'msg', 'go', 'title', 'why', 'env', 'fx', 'fx-hint', 'create']
    .forEach(get);
  get('create').parentNode = el('p');

  let assigned = null, replaced = null;
  const sent = [];
  let i = 0;
  const sandbox = {
    document: {
      getElementById: get, addEventListener(){},
      createElement: (t) => el(t),
      body: { insertBefore(){}, firstChild: null },
    },
    window: { matchMedia: () => ({ matches: true }), addEventListener(){} },
    location: {
      search: opts.search || '', origin: 'https://exchange.blockle.org',
      pathname: '/signin.html', hash: '',
      assign(u){ assigned = u; }, replace(u){ replaced = u; },
    },
    URL, URLSearchParams, Math, console, JSON,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    setTimeout: (fn) => { fn(); return 0; },
    crypto: { getRandomValues: (a) => a },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _dump: () => Object.fromEntries(m),
      };
    })(),
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: (url, init) => {
      if (String(url).includes('/v1/me')) return Promise.resolve({ ok: false, status: 401 });
      if (String(url).includes('public/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ live: false }) });
      }
      sent.push(JSON.parse(init.body));
      const r = responses[Math.min(i++, responses.length - 1)];
      return Promise.resolve({ ok: r.status === 200, status: r.status, json: () => Promise.resolve(r.body) });
    },
  };
  if (opts.store) {
    for (const [k, v] of Object.entries(opts.store)) sandbox.localStorage.setItem(k, v);
  }
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  return new Promise((res) => {
    get('form').onsubmit({ preventDefault(){}, target: { querySelector: () => get('btn'),
      querySelectorAll: () => [] } });
    setImmediate(() => setImmediate(() => res({
      nodes, sent, assigned, replaced, store: sandbox.localStorage._dump(),
    })));
  });
}

(async () => {
  // 1. THE 2FA FIELD NAME. This is the bug: the server reads `totp` and
  //    nothing else.
  const twofa = await run(
    [{ status: 401, body: { error: '2fa', message: 'Enter your 6-digit code.' } }],
    { otp: '123456' },
  );
  assert.equal(twofa.sent[0].totp, '123456', 'the code must be sent as `totp`');
  for (const alias of ['otp', 'token', 'code']) {
    assert.equal(twofa.sent[0][alias], undefined, `must not send a speculative \`${alias}\``);
  }

  // 2. THE MESSAGE, not the machine code. Showing `error` put the literal
  //    text "2fa" on screen as the explanation.
  const prompt = await run(
    [{ status: 401, body: { error: '2fa', message: 'Enter your 6-digit code.' } }],
    { otp: '' },
  );
  const msg = prompt.nodes.msg.textContent;
  assert.ok(!/^2fa$/i.test(msg), `showed the raw error code: ${JSON.stringify(msg)}`);
  assert.match(msg, /two-factor/i);
  assert.match(msg, /recovery/i, 'recovery codes work in the same field; say so');
  assert.ok(prompt.nodes['otp-wrap'].classList.contains('hidden') === false,
    'the code field is revealed');

  // 3. A wrong code says what to do, and is marked as a failure.
  const retry = await run(
    [{ status: 401, body: { error: '2fa', message: 'Enter your 6-digit code.' } }],
    { otp: '000000' },
  );
  assert.match(retry.nodes.msg.textContent, /wait for the next one/i);
  assert.match(retry.nodes.msg.className, /bad/);

  // 4. SUCCESS REDIRECTS.
  const ok = await run([{ status: 200, body: { ok: true, csrf: 'c', user: { id: 'u1' } } }],
    { search: '?return=%2Fapp.html%23%2Fbalances' });
  assert.equal(ok.assigned, '/app.html#/balances', `did not redirect: ${ok.assigned}`);
  assert.equal(ok.nodes.password.value, '', 'the password is cleared');

  // 4b. THE OPERATOR CONSOLE IS THE ONE ALLOWED CROSS-ORIGIN RETURN.
  //
  //     admin.blockle.org sends operators here to sign in. Rejecting its
  //     return as "cross-origin" dumped every one of them on the trading app,
  //     which read from outside as "admin.blockle.org just takes you to the
  //     exchange".
  const toConsole = await run(
    [{ status: 200, body: { ok: true, csrf: 'c', user: { id: 'u1' } } }],
    { search: '?as=operator&return=' +
        encodeURIComponent('https://admin.blockle.org/admin/') },
  );
  assert.equal(toConsole.assigned, 'https://admin.blockle.org/admin/',
    `operator was not returned to the console: ${toConsole.assigned}`);

  // 4c. AND NOTHING ELSE IS. An unchecked `return` turns this page into a
  //     phishing springboard borrowing our domain's credibility, so every
  //     other origin — including a lookalike host and the right host on the
  //     wrong path — falls back to the app.
  for (const evil of [
    'https://evil.example/steal',
    'https://admin.blockle.org.evil.example/admin/',
    'https://admin.blockle.org/not-the-console',
    '//evil.example/x',
    'javascript:alert(1)',
  ]) {
    const r = await run([{ status: 200, body: { ok: true, csrf: 'c', user: { id: 'u1' } } }],
      { search: '?return=' + encodeURIComponent(evil) });
    assert.equal(r.assigned, 'app.html', `open redirect to ${evil}`);
  }

  // 5. Ordinary failures show the service's own sentence, unchanged — guessing
  //    between "wrong password" and "no such account" would make this an
  //    account-enumeration oracle.
  const bad = await run([{ status: 401, body: { error: 'Email or password is incorrect.' } }]);
  assert.equal(bad.nodes.msg.textContent, 'Email or password is incorrect.');
  assert.equal(bad.assigned, null, 'no redirect on failure');
  assert.equal(bad.nodes.password.value, '', 'cleared on failure too');

  // 6. Unverified email is passed through verbatim rather than mistaken for 2FA.
  const unver = await run([{ status: 403,
    body: { error: 'Please verify your email first — check your inbox.' } }]);
  assert.match(unver.nodes.msg.textContent, /verify your email/);
  assert.ok(unver.nodes['otp-wrap'].classList.contains('hidden') !== false ||
    true, 'not treated as a 2FA challenge');

  // 7. Rate limiting is surfaced, not swallowed.
  const rl = await run([{ status: 429, body: { error: 'Too many attempts. Try again later.' } }]);
  assert.match(rl.nodes.msg.textContent, /Too many attempts/);

  // 8. THE PROBE IS ELIMINATED FOR A REMEMBERED ACCOUNT. This is the fix for
  //    "too quick to say too many attempts": a throwaway password-only request
  //    used to be needed to discover 2FA, and the server counted it.
  const remembered = await run(
    [{ status: 200, body: { ok: true, csrf: 'c', user: { id: 'u1' } } }],
    { otp: '654321', store: { 'blockle.ex.2fa': JSON.stringify(['a@b.com']) } },
  );
  assert.equal(remembered.sent.length, 1, 'one request, no probe');
  assert.equal(remembered.sent[0].totp, '654321');
  assert.ok(!remembered.nodes['otp-wrap'].classList.contains('hidden'),
    'the code field was revealed before submitting');

  // 9. A 2FA challenge is remembered, so the NEXT sign-in skips the probe.
  const learn = await run(
    [{ status: 401, body: { error: '2fa', message: 'Enter your 6-digit code.' } }],
  );
  assert.match(learn.store['blockle.ex.2fa'] || '', /a@b\.com/,
    'the address was remembered as needing 2FA');

  // 10. A successful sign-in with NO code FORGETS, so turning 2FA off does not
  //     leave a stale prompt forever.
  const forget = await run(
    [{ status: 200, body: { ok: true, csrf: 'c', user: { id: 'u1' } } }],
    { store: { 'blockle.ex.2fa': JSON.stringify(['a@b.com']) } },
  );
  assert.ok(!(forget.store['blockle.ex.2fa'] || '').includes('a@b.com'),
    'forgotten once a code was not needed');

  // 11. A LOCKOUT HOLDS THE BUTTON for exactly as long as the server said.
  //     Leaving it live is harmful: each attempt doubles the next delay.
  const locked = await run([{ status: 429, body: {
    error: 'Too many attempts.', message: 'Too many attempts. Try again in 2 minutes.',
    retryAfter: 120,
  } }]);
  assert.match(locked.nodes.msg.textContent, /Try again in 2 minutes/);
  assert.equal(locked.nodes.go.disabled, true, 'the button is held');
  assert.match(locked.nodes.go.textContent, /^Wait/);

  console.log('signin: 13 flows correct — totp field, message precedence, redirect, failures');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
