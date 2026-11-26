// Harness for the operator console's session check.
//
// WHAT THIS IS GUARDING. On 2026-11-25 admin.blockle.org showed
// "checking session…" and never resolved — not a signed-in console, not a
// sign-in prompt, just the placeholder, indefinitely. The console was being
// served at /admin/ while admin.inline.js sat flat at the static root, so the
// page's relative <script src> 404ed and NONE of this file's code ran. The
// resolver fix lives in exchange/custody (test/staticmounts.test.ts). What is
// tested here is the second half of the brief: that the loading state is
// impossible to get stuck on whatever breaks next.
//
// So every test below is a variation on one question — "the session check did
// not succeed; does the page SAY SO, specifically?" — including the cases that
// have no HTTP status at all, which is the shape the original bug took.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const JS_PATH = 'deploy/exchange/frontpage/admin.inline.js';
const HTML_PATH = 'deploy/exchange/frontpage/admin.html';
const js = fs.readFileSync(JS_PATH, 'utf8');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// The placeholder this whole exercise is about. Written out once so the
// assertions below can all refer to the exact bytes the operator stared at.
const PLACEHOLDER = 'checking session…';

// COMMENTS ARE NOT MARKUP, and every assertion below is about markup. The
// page's own comments discuss `<script>` tags and 404s at length — asserting
// against the raw file would both false-positive on that prose and let a
// commented-out banner satisfy the checks that follow.
const markup = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------------------
// 1. The page must actually load this file, and must not rely on inline JS.
// ---------------------------------------------------------------------------
assert.ok(
  markup.includes('src="admin.inline.js"'),
  'admin.html must load admin.inline.js — otherwise this harness tests a file ' +
    'the page never runs',
);
assert.ok(
  !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(markup),
  'admin.html must have no inline script: this origin serves ' +
    "script-src 'self'",
);
assert.ok(
  !/\son(?:error|load|click)\s*=\s*"/i.test(markup),
  'no inline event-handler attributes either — the same CSP blocks them, so a ' +
    'watchdog built on onerror= would be silently dead',
);

// ---------------------------------------------------------------------------
// 2. THE CSS-ONLY BOOT WATCHDOG.
//
// This is the only thing that can report "the script never ran", because by
// definition no script is available to report it. It must survive in the
// markup, and it must be cancelled by the class the script sets.
// ---------------------------------------------------------------------------
assert.ok(
  markup.includes('id="bootfail"'),
  'admin.html must carry a #bootfail banner: when admin.inline.js 404s, the ' +
    'page itself is the only thing left that can explain the blank console',
);
assert.match(
  markup,
  /#bootfail\s*\{[^}]*animation:\s*bootfail-reveal/,
  'the #bootfail banner must be revealed by a delayed CSS animation, not by JS',
);
assert.match(
  markup,
  /@keyframes\s+bootfail-reveal\s*\{[^}]*visibility:\s*visible/,
  'the reveal keyframe must actually make it visible',
);
assert.match(
  markup,
  /html\.booted\s+#bootfail\s*\{[^}]*animation:\s*none/,
  'a booted page must cancel the watchdog, or every healthy load grows a ' +
    'false alarm after six seconds',
);
// And the message has to be actionable, not just present.
assert.ok(
  markup.includes('admin.inline.js') && /404/.test(markup),
  'the #bootfail text must name the file and the status to look for — an ' +
    'alarm that does not say what to check is a nicer-looking spinner',
);
// The script's FIRST statement is what makes the watchdog mean "code ran".
const firstStatement = js.replace(/^\s*"use strict";\s*/, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .trim()
  .split('\n')[0];
assert.match(
  firstStatement,
  /classList\.add\("booted"\)/,
  'marking the document booted must be the FIRST thing this script does, or a ' +
    'throw above it reads as a healthy boot. Got: ' + firstStatement,
);

// ---------------------------------------------------------------------------
// 3. A DOM thin enough to run the console in, and rich enough to read it back.
// ---------------------------------------------------------------------------
function el(id) {
  const node = {
    id, value: '', textContent: '', className: '', disabled: false, title: '',
    type: '', href: '', colSpan: 0,
    style: { cssText: '', maxWidth: '', color: '' },
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    // Text nodes accumulate into textContent the way a real node's do, so an
    // assertion can read a built card as the operator would read it.
    appendChild(c) {
      this.children.push(c);
      if (c && c.__text) this.textContent += c.textContent;
      return c;
    },
    insertRow() { const r = el('tr'); this.children.push(r); return r; },
    insertCell() { const c = el('td'); this.children.push(c); return c; },
    remove() {},
    setAttribute() {},
    addEventListener(e, h) { this['on' + e] = h; },
    querySelector() { return el('btn'); },
    querySelectorAll() { return []; },
  };
  return node;
}

/**
 * Run the console once.
 *
 * `scenario.me` decides what GET api/me does: an {status, body} pair, the
 * string 'hang' (headers never arrive — the original spinner), or the string
 * 'offline' (the request rejects before any response).
 */
async function run(scenario) {
  const nodes = {};
  const byId = (id) => (nodes[id] = nodes[id] || el(id));
  // Pre-create the nodes the assertions read so a branch that never touched
  // one fails an assertion instead of crashing the harness.
  ['who', 'banner', 'bootfail', 'cust-out', 'cust-more', 'profit-note'].forEach(byId);
  // The real markup ships the placeholder; reproduce that exactly.
  byId('who').textContent = PLACEHOLDER;

  const docEl = el('html');
  const timers = new Map();
  let nextTimer = 1;
  // An OBJECT, not a primitive: the retry button is clicked after run()
  // returns, so a copied boolean would never show the reload.
  const state = { reloaded: false };
  const requested = [];

  const sandbox = {
    console,
    document: {
      documentElement: docEl,
      getElementById: byId,
      createElement: (t) => el(t),
      // The console builds every message with createTextNode — it never
      // assigns innerHTML. Omitting this from the stub made the whole banner
      // construction throw, which the boot catch then swallowed: exactly the
      // silent-failure shape under test, reproduced by accident in the test.
      createTextNode: (s) => ({ __text: true, textContent: String(s), nodeValue: String(s) }),
      querySelector: () => el('tbody'),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {} },
    location: {
      href: 'https://exchange.blockle.org/admin/',
      origin: 'https://exchange.blockle.org',
      reload() { state.reloaded = true; },
    },
    crypto: { getRandomValues: (a) => a },
    AbortController,
    // Timers are MANUAL. The deadline under test is 15s of wall clock; a
    // harness that actually waited for it would be a harness nobody runs.
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval() {},
    fetch: (url, init) => {
      requested.push(url);
      const me = String(url).endsWith('me');
      const spec = me ? scenario.me : { status: 200, body: scenario.other || {} };

      if (spec === 'hang') {
        // Accepted and then silent. The signal is the ONLY way out, which is
        // the whole point: without it this promise is a permanent spinner.
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      if (spec === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      if (spec === 'stalled-body') {
        // Headers landed, body never did. Two traps here: a timer cleared on
        // the status line leaves the body read awaiting forever, and a
        // `.catch` around the parse turns the abort into a plausible-looking
        // 200 body. Both have to be survived.
        return Promise.resolve({
          ok: true, status: 200, statusText: 'OK',
          text: () => new Promise((_r, reject) => {
            init.signal.addEventListener('abort', () => {
              const e = new Error('The operation was aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
        });
      }
      if (spec === 'html-error-page') {
        // nginx answered instead of the service. Not JSON, and the page must
        // report the status rather than a parse error.
        return Promise.resolve({
          ok: false, status: 502, statusText: 'Bad Gateway',
          text: () => Promise.resolve('<html><body>502 Bad Gateway</body></html>'),
        });
      }
      return Promise.resolve({
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        statusText: 'Status ' + spec.status,
        text: () => Promise.resolve(JSON.stringify(spec.body)),
      });
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'admin.inline.js' });

  // Let the boot IIFE reach its first await.
  await new Promise((r) => setImmediate(r));

  // Fire the request deadline if one is pending, then drain.
  const fire = () => {
    for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
  };
  for (let i = 0; i < 8; i++) {
    fire();
    await new Promise((r) => setImmediate(r));
  }

  return { nodes, docEl, requested, state, timers, who: byId('who').textContent };
}

// ---------------------------------------------------------------------------
// 4. The scenarios.
// ---------------------------------------------------------------------------
(async () => {
  // THE INVARIANT, asserted on every single scenario below.
  const cases = [];
  const check = async (name, scenario, expect) => {
    const r = await run(scenario);
    assert.notStrictEqual(
      r.who, PLACEHOLDER,
      `[${name}] the page is STILL showing "${PLACEHOLDER}". That is the bug: ` +
        `whatever happened, the operator must be told what.`,
    );
    assert.ok(
      r.who && r.who.trim() !== '',
      `[${name}] the session line was blanked rather than explained`,
    );
    assert.match(r.who, expect, `[${name}] wrong explanation: "${r.who}"`);
    cases.push(name);
    return r;
  };

  // 1. Signed in and an operator.
  const ok = await check(
    'signed in',
    { me: { status: 200, body: { email: 'alex@blockle.org', canAct: true } } },
    /alex@blockle\.org/,
  );
  assert.ok(
    ok.docEl.classList.contains('booted'),
    'the document must be marked booted, or the CSS watchdog fires over a ' +
      'perfectly healthy console',
  );

  // 2. Allowlisted but no authenticator: read-only, and it says so.
  await check(
    'view only',
    { me: { status: 200, body: { accountId: 'acct_1', canAct: false } } },
    /view only/,
  );

  // 3. No session at all.
  await check('401', { me: { status: 401, body: { error: 'not signed in' } } },
    /not signed in/);

  // 4. Valid session, not on the allowlist. NOT "not signed in" — that advice
  //    sends the operator round the same loop forever.
  const notOp = await check('404',
    { me: { status: 404, body: { error: 'not found' } } },
    /not an operator/);
  assert.ok(
    !/not signed in/.test(notOp.who),
    'a non-operator must not be told to sign in again with the same account',
  );

  // 5. The accounts service is down and the SERVER said so. publicapi forwards
  //    the session to a separate service; unreachable is a 503, never an
  //    anonymous session.
  await check('503', { me: { status: 503, body: { error: 'account service did not respond' } } },
    /account service unreachable/);

  // 6. THE ORIGINAL SHAPE: no response at all, forever. There is no status to
  //    switch on, so before the deadline existed there was no message either.
  const hung = await check('hung request', { me: 'hang' }, /timed out/i);
  assert.match(
    hung.nodes.banner.children[0].children[1].textContent || '',
    /deadline|did not answer|exchange-public-api/i,
    'a timeout must point somewhere — which service, and what to look at',
  );

  // 7. Headers arrived, body never did. Proves the deadline spans the body
  //    read and is not cleared when the status line lands.
  await check('stalled body', { me: 'stalled-body' }, /timed out/i);

  // 8. The request never left the browser: offline, TLS, or a CSP refusal.
  await check('offline', { me: 'offline' }, /unreachable|could not reach/i);

  // 9. A status nobody enumerated still produces a specific sentence rather
  //    than falling through to the 401 wording.
  const odd = await check('502 from a gateway',
    { me: { status: 502, body: { error: 'Bad Gateway' } } },
    /502/);
  assert.ok(
    !/not signed in/.test(odd.who),
    'HTTP 502 is not "not signed in" — the generic fallthrough was itself a bug',
  );

  // 10. nginx answered instead of the service, in HTML. A parse failure must
  //     not hide the status — the status is the only useful fact in that body.
  const htmlErr = await check('nginx HTML error page', { me: 'html-error-page' }, /502/);
  assert.ok(
    !/JSON|SyntaxError|Unexpected token/i.test(htmlErr.who),
    'a non-JSON body must surface as its status, not as a parse error: ' +
      htmlErr.who,
  );

  // 11. NO TIMER IS LEFT RUNNING once a request has settled. A deadline that
  //     outlives its request aborts the next one.
  assert.equal(
    ok.timers.size, 0,
    'request deadlines must be cleared in a finally; leaked timers abort ' +
      'later requests at random',
  );

  // 12. The unrecoverable cases offer a retry, because reloading is the only
  //     move left and the operator should not have to guess that.
  const retry = await run({ me: 'hang' });
  const card = retry.nodes.banner.children[0];
  const button = card.children.find((c) => c.id === 'button');
  assert.ok(button, 'a transport failure must offer "Try again"');
  button.onclick();
  assert.ok(retry.state.reloaded, 'the retry button must actually retry');

  // 13. Only ONE request is made for identity before the page gives up. A
  //     retry loop against a wedged service is how an incident gets worse.
  assert.equal(
    hung.requested.filter((u) => String(u).endsWith('me')).length, 1,
    'the session check must not silently retry against a wedged service',
  );

  console.log(
    `admin: ${cases.length} session-check outcomes all explained, none left on ` +
      `the placeholder — ${cases.join(', ')}`,
  );
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
