// Blockle Protect — accountability-buddy email service.
//
// Sends progress / relapse updates from support@blockle.org to a user's chosen
// accountability partner during a gambling-blocking commitment. Built ethically:
//   • DOUBLE OPT-IN — the buddy must click a confirm link before anything else
//     is sent (prevents using the service to spam arbitrary addresses).
//   • UNSUBSCRIBE link in every email; honored immediately.
//   • Owner-token auth on notify (only the user's app can trigger sends), a
//     separate buddy-token for confirm/unsubscribe.
//   • Rate limited per IP (invites) and per invite (notifies).
// No gambling specifics or personal data beyond a short alias the user chooses.
'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.ACCT_PORT || 8951);
const BASE = process.env.ACCT_PUBLIC_BASE || 'https://protect.blockle.org';
const FROM = 'Blockle Protect <support@blockle.org>';
const DATA = process.env.ACCT_DATA || '/var/lib/blockle-accountability/state.json';
const MIN_NOTIFY_MS = 60 * 1000;          // per-invite min spacing
const MAX_INVITES_PER_IP_HOUR = 12;

let state = { invites: {}, households: {}, ipHits: {} };
try { state = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
state.invites ||= {}; state.households ||= {}; state.ipHits ||= {};
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const inviteCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
function save() { try { fs.mkdirSync(require('path').dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(state)); } catch (e) { console.error('save', e.message); } }
const tok = () => crypto.randomBytes(16).toString('hex');
const now = () => Date.now();
const emailOk = (e) => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 200;
const esc = (s) => String(s || '').replace(/[<>]/g, '').slice(0, 80);

function sendMail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const msg = [`From: ${FROM}`, `To: ${to}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
    const p = spawn('/usr/sbin/sendmail', ['-t', '-i']);
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('sendmail exit ' + c))));
    p.stdin.write(msg); p.stdin.end();
  });
}

function json(res, code, body) { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json' }); res.end(s); }
function page(res, title, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font-family:-apple-system,system-ui,sans-serif;background:#0A0A0E;color:#FBEEF1;margin:0;display:grid;place-items:center;height:100vh">`
    + `<div style="max-width:420px;padding:24px;text-align:center"><h2 style="color:#FF3B4E">${title}</h2><p style="color:#D8C7CF">${body}</p></div>`);
}
async function readBody(req) {
  let n = 0; const ch = [];
  for await (const c of req) { n += c.length; if (n > 64 * 1024) throw new Error('too large'); ch.push(c); }
  return Buffer.concat(ch).toString('utf8');
}
function ipOf(req) { return (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString(); }
function rateIp(ip) {
  const h = Math.floor(now() / 3600000);
  const k = ip + ':' + h;
  state.ipHits = Object.fromEntries(Object.entries(state.ipHits).filter(([key]) => key.endsWith(':' + h)));
  state.ipHits[k] = (state.ipHits[k] || 0) + 1;
  return state.ipHits[k] <= MAX_INVITES_PER_IP_HOUR;
}

const bodyFor = (ev, alias, detail) => {
  const who = alias ? `${alias}` : 'Someone you know';
  switch (ev) {
    case 'relapse': return `${who} just turned OFF their gambling-site block during an active commitment.\n\nThis is the moment they asked you to check in. A short, kind message can make a real difference right now.`;
    case 'progress': return `Good news — ${who} is staying strong. ${detail || ''}\n\nA word of encouragement goes a long way.`;
    case 'completed': return `${who} completed their gambling-blocking commitment. That's a real milestone — consider celebrating it with them.`;
    case 'started': return `${who} started a gambling-blocking commitment and chose you as their accountability partner. You'll get a note if they turn the block off, and the occasional progress update.`;
    default: return `${who} sent an accountability update.`;
  }
};

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/accountability/, '') || '/';

    if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true });

    if (req.method === 'POST' && p === '/invite') {
      if (!rateIp(ipOf(req))) return json(res, 429, { error: 'too many invites, try later' });
      const b = JSON.parse(await readBody(req));
      if (!emailOk(b.buddyEmail)) return json(res, 400, { error: 'valid buddyEmail required' });
      const id = tok(), ownerToken = tok(), buddyToken = tok();
      const alias = esc(b.userAlias) || 'Your friend';
      state.invites[id] = { buddyEmail: b.buddyEmail, buddyName: esc(b.buddyName), alias,
        ownerToken, buddyToken, confirmed: false, unsub: false, createdAt: now(), lastSentAt: 0 };
      save();
      const confirm = `${BASE}/api/accountability/confirm?token=${buddyToken}`;
      const unsub = `${BASE}/api/accountability/unsubscribe?token=${buddyToken}`;
      await sendMail(b.buddyEmail, `${alias} asked you to be their accountability partner`,
        `${alias} is using Blockle Protect to block gambling sites and chose you as their accountability partner.\n\n`
        + `If you're willing to support them — getting a heads-up if they turn the block off, plus occasional progress updates — confirm here:\n${confirm}\n\n`
        + `If you'd rather not, just ignore this email, or opt out: ${unsub}\n\n— Blockle Protect`);
      return json(res, 200, { inviteId: id, ownerToken });
    }

    if (req.method === 'GET' && p === '/confirm') {
      const token = url.searchParams.get('token');
      const inv = Object.values(state.invites).find((i) => i.buddyToken === token);
      const hh = Object.values(state.households).find((h) => h.hoHToken === token);
      const t = inv || hh;
      if (!t) return page(res, 'Link not found', 'This confirmation link is invalid or expired.');
      t.confirmed = true; t.unsub = false; save();
      const who = inv ? inv.alias : 'your household';
      return page(res, "You're all set", `Thanks for looking out for ${who}. You'll get a note if a gambling block is turned off, plus occasional progress updates. You can opt out any time from a link in those emails.`);
    }

    if (req.method === 'GET' && p === '/unsubscribe') {
      const token = url.searchParams.get('token');
      const t = Object.values(state.invites).find((i) => i.buddyToken === token)
        || Object.values(state.households).find((h) => h.hoHToken === token);
      if (t) { t.unsub = true; save(); }
      return page(res, 'Unsubscribed', 'You will no longer receive accountability emails.');
    }

    // ---- Household (family plan): one head-of-household, many members via code ----
    if (req.method === 'POST' && p === '/household/create') {
      if (!rateIp(ipOf(req))) return json(res, 429, { error: 'too many requests, try later' });
      const b = JSON.parse(await readBody(req));
      if (!emailOk(b.hoHEmail)) return json(res, 400, { error: 'valid hoHEmail required' });
      const id = tok(), ownerToken = tok(), hoHToken = tok();
      let code = inviteCode();
      while (Object.values(state.households).some((h) => h.code === code)) code = inviteCode();
      const alias = esc(b.hoHAlias) || 'your household';
      state.households[id] = { hoHEmail: b.hoHEmail, hoHAlias: alias, hoHToken, ownerToken, code,
        confirmed: false, unsub: false, createdAt: now(), lastSentAt: 0, members: {} };
      save();
      const confirm = `${BASE}/api/accountability/confirm?token=${hoHToken}`;
      const unsub = `${BASE}/api/accountability/unsubscribe?token=${hoHToken}`;
      await sendMail(b.hoHEmail, `You're the head of household on Blockle Protect`,
        `You set up a Blockle Protect family household. Confirm to receive alerts if a family member turns their gambling/adult block off, plus progress updates:\n${confirm}\n\n`
        + `Your family invite code is:  ${code}\nFamily members enter it in Blockle Protect (or open ${BASE}/api/accountability/join/${code}) to join.\n\n`
        + `Opt out of alerts: ${unsub}\n\n— Blockle Protect`);
      return json(res, 200, { householdId: id, ownerToken, code, joinUrl: `${BASE}/api/accountability/join/${code}` });
    }

    if (req.method === 'GET' && p.startsWith('/join/')) {
      const code = p.slice('/join/'.length).toUpperCase();
      const hh = Object.values(state.households).find((h) => h.code === code);
      if (!hh) return page(res, 'Invite not found', 'This family invite code is invalid or expired.');
      return page(res, `Join ${hh.hoHAlias} on Blockle Protect`,
        `You've been invited to a Blockle Protect family. Install Blockle Protect, open Family Protection, choose “Join a household”, and enter this code:<br><br>`
        + `<b style="font-size:28px;letter-spacing:4px;color:#FF3B4E">${code}</b><br><br>`
        + `Your head of household will be alerted if a gambling or adult block is turned off.`);
    }

    if (req.method === 'POST' && p === '/household/join') {
      const b = JSON.parse(await readBody(req));
      const hh = Object.values(state.households).find((h) => h.code === String(b.code || '').toUpperCase());
      if (!hh) return json(res, 404, { error: 'invalid invite code' });
      const memberId = tok(), memberToken = tok();
      hh.members[memberId] = { alias: esc(b.memberAlias) || 'A family member', memberToken, joinedAt: now() };
      save();
      return json(res, 200, { householdId: Object.keys(state.households).find((k) => state.households[k] === hh), memberId, memberToken, hoHAlias: hh.hoHAlias });
    }

    // Shared custom blocklist — any family member can add sites; all members
    // pull the merged list and block them in Safari.
    if (req.method === 'POST' && p === '/household/custom') {
      const b = JSON.parse(await readBody(req));
      const hh = state.households[b.householdId];
      if (!hh) return json(res, 404, { error: 'household not found' });
      const authed = hh.ownerToken === b.token || Object.values(hh.members).some((m) => m.memberToken === b.token);
      if (!authed) return json(res, 401, { error: 'unauthorized' });
      hh.customDomains = hh.customDomains || [];
      const clean = (Array.isArray(b.domains) ? b.domains : []).map((d) =>
        String(d).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
        .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && d.length < 200);
      if (b.action === 'add') hh.customDomains = [...new Set([...hh.customDomains, ...clean])];
      else if (b.action === 'remove') hh.customDomains = hh.customDomains.filter((d) => !clean.includes(d));
      else if (b.action === 'set') hh.customDomains = [...new Set(clean)];
      // 'get' (or anything else) just returns the current list
      hh.customDomains = hh.customDomains.slice(0, 5000);
      save();
      return json(res, 200, { domains: hh.customDomains });
    }

    if (req.method === 'POST' && p === '/household/alert') {
      const b = JSON.parse(await readBody(req));
      const hh = state.households[b.householdId];
      const m = hh && hh.members[b.memberId];
      if (!hh || !m || m.memberToken !== b.memberToken) return json(res, 401, { error: 'unauthorized' });
      if (!hh.confirmed || hh.unsub) return json(res, 200, { sent: false, reason: 'head of household not confirmed / opted out' });
      if (now() - hh.lastSentAt < MIN_NOTIFY_MS) return json(res, 200, { sent: false, reason: 'rate limited' });
      const ev = String(b.event || '').slice(0, 20);
      const unsub = `${BASE}/api/accountability/unsubscribe?token=${hh.hoHToken}`;
      await sendMail(hh.hoHEmail,
        ev === 'relapse' ? `${m.alias} turned off a block` : `Family update: ${m.alias}`,
        `${bodyFor(ev, m.alias, esc(b.detail))}\n\n— Blockle Protect (family)\n\nStop these emails: ${unsub}`);
      hh.lastSentAt = now(); save();
      return json(res, 200, { sent: true });
    }

    if (req.method === 'POST' && p === '/notify') {
      const b = JSON.parse(await readBody(req));
      const inv = state.invites[b.inviteId];
      if (!inv || inv.ownerToken !== b.ownerToken) return json(res, 401, { error: 'unauthorized' });
      if (!inv.confirmed) return json(res, 200, { sent: false, reason: 'buddy has not confirmed yet' });
      if (inv.unsub) return json(res, 200, { sent: false, reason: 'buddy unsubscribed' });
      if (now() - inv.lastSentAt < MIN_NOTIFY_MS) return json(res, 200, { sent: false, reason: 'rate limited' });
      const ev = String(b.event || '').slice(0, 20);
      const unsub = `${BASE}/api/accountability/unsubscribe?token=${inv.buddyToken}`;
      await sendMail(inv.buddyEmail,
        ev === 'relapse' ? `${inv.alias} needs a check-in` : `Accountability update for ${inv.alias}`,
        `${bodyFor(ev, inv.alias, esc(b.detail))}\n\n— Blockle Protect\n\nStop these emails: ${unsub}`);
      inv.lastSentAt = now(); save();
      return json(res, 200, { sent: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
};

http.createServer((req, res) => { void handler(req, res); }).listen(PORT, '127.0.0.1', () =>
  console.error(`[accountability] listening on 127.0.0.1:${PORT}`));
