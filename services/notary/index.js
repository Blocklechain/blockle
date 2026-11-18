// Blockle Notary — B2B API that productizes on-chain anchoring. Businesses
// anchor a document's SHA-256 on the Blockle chain and get a tamper-evident,
// independently-verifiable timestamp. Only the hash is ever sent — never the
// document. Thin metered/auth layer over the anchor service (127.0.0.1:8947).
'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.NOTARY_PORT || 8952);
const ANCHOR = process.env.NOTARY_ANCHOR || 'http://127.0.0.1:8947';
const BASE = process.env.NOTARY_PUBLIC_BASE || 'https://protect.blockle.org';
const DATA = process.env.NOTARY_DATA || '/var/lib/blockle-notary/keys.json';
const FREE_QUOTA = 50;
const FROM = 'Blockle Notary <support@blockle.org>';

let state = { keys: {}, ipHits: {} };
try { state = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
state.keys ||= {}; state.ipHits ||= {};
const save = () => { try { fs.mkdirSync(require('path').dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(state)); } catch (e) { console.error(e.message); } };
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const emailOk = (e) => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 200;
const now = () => Date.now();

function sendMail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const msg = [`From: ${FROM}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
    const p = spawn('/usr/sbin/sendmail', ['-t', '-i']);
    p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('sendmail ' + c))));
    p.stdin.write(msg); p.stdin.end();
  });
}
function json(res, code, body) { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json' }); res.end(s); }
async function readBody(req) { let n = 0; const c = []; for await (const x of req) { n += x.length; if (n > 64 * 1024) throw new Error('too large'); c.push(x); } return Buffer.concat(c).toString('utf8'); }
function keyFromAuth(req) {
  const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!h) return null;
  const rec = state.keys[sha256hex(h)];
  return rec ? { id: sha256hex(h), rec } : null;
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/notary/, '') || '/';

    if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true });

    if (req.method === 'POST' && p === '/signup') {
      const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '') + ':' + Math.floor(now() / 3600000);
      state.ipHits[ip] = (state.ipHits[ip] || 0) + 1;
      if (state.ipHits[ip] > 5) return json(res, 429, { error: 'too many signups, try later' });
      const b = JSON.parse(await readBody(req));
      if (!emailOk(b.email)) return json(res, 400, { error: 'valid email required' });
      const key = 'blk_live_' + crypto.randomBytes(24).toString('hex');
      state.keys[sha256hex(key)] = { email: b.email, org: String(b.org || '').slice(0, 120),
        plan: 'free', quota: FREE_QUOTA, used: 0, createdAt: now() };
      save();
      await sendMail(b.email, 'Your Blockle Notary API key',
        `Welcome to Blockle Notary.\n\nYour API key (store it securely — shown once):\n${key}\n\n`
        + `Anchor a document hash:\n  curl -s ${BASE}/api/notary/anchor -H "Authorization: Bearer ${key}" -H "content-type: application/json" -d '{"hash":"<sha256-hex>"}'\n\n`
        + `Free tier: ${FREE_QUOTA} anchors. Docs: ${BASE}/notary\n\n— Blockle Notary`);
      return json(res, 200, { ok: true, apiKey: key, quota: FREE_QUOTA, note: 'Saved only as a hash on our side; this is the only time it is shown.' });
    }

    if (req.method === 'POST' && p === '/anchor') {
      const auth = keyFromAuth(req);
      if (!auth) return json(res, 401, { error: 'invalid API key' });
      if (auth.rec.used >= auth.rec.quota) return json(res, 402, { error: 'quota exceeded — upgrade for more anchors' });
      const b = JSON.parse(await readBody(req));
      const hex = typeof b.hash === 'string' ? b.hash.toLowerCase() : '';
      if (!/^[0-9a-f]{64}$/.test(hex)) return json(res, 400, { error: 'hash must be a SHA-256 hex (64 chars)' });
      const r = await fetch(ANCHOR + '/api/anchor/hash', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: hex }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.anchored) return json(res, 502, { error: out.error || 'anchor failed' });
      auth.rec.used += 1; save();
      return json(res, 200, { hash: hex, txid: out.txid, verifyUrl: `${BASE}/api/notary/verify/${hex}`, used: auth.rec.used, quota: auth.rec.quota });
    }

    if (req.method === 'GET' && p.startsWith('/verify/')) {
      const hex = p.slice('/verify/'.length).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) return json(res, 400, { error: 'invalid hash' });
      const r = await fetch(ANCHOR + '/api/anchor/root/' + hex);
      const out = await r.json().catch(() => ({}));
      return json(res, 200, { hash: hex, anchored: !!out.anchored, height: out.height || 0, chain: 'blockle' });
    }

    if (req.method === 'GET' && p === '/me') {
      const auth = keyFromAuth(req);
      if (!auth) return json(res, 401, { error: 'invalid API key' });
      const { org, plan, used, quota } = auth.rec;
      return json(res, 200, { org, plan, used, quota });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: e.message }); }
};

http.createServer((req, res) => { void handler(req, res); }).listen(PORT, '127.0.0.1', () =>
  console.error(`[notary] listening on 127.0.0.1:${PORT} -> ${ANCHOR}`));
