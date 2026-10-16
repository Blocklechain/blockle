// Self-contained account pages. One shell + per-page body; all behavior lives in /account/app.js
// (served separately so the strict CSP `script-src 'self'` holds — no inline script). Styling is
// inline (style-src allows 'unsafe-inline'); palette matches the blockle.org "Instrument" landing.
const CSS = `
:root{--bg:#0b0e14;--panel:#111622;--ink:#e6ecf5;--mut:#8a97ad;--line:#1e2838;--accent:#4d8bff;--gain:#2fc08a;--loss:#ff5d6a;--radius:12px}
@media (prefers-color-scheme:light){:root{--bg:#f5f7fb;--panel:#fff;--ink:#0d1420;--mut:#55617a;--line:#e4e9f2;--accent:#2f6bff}}
:root[data-theme=light]{--bg:#f5f7fb;--panel:#fff;--ink:#0d1420;--mut:#55617a;--line:#e4e9f2;--accent:#2f6bff}
:root[data-theme=dark]{--bg:#0b0e14;--panel:#111622;--ink:#e6ecf5;--mut:#8a97ad;--line:#1e2838;--accent:#4d8bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.wrap{min-height:100vh;display:grid;place-items:center;padding:32px}
.card{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:28px}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:18px;font-weight:700;letter-spacing:.2px}
.brand b{color:var(--accent)}
h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 20px;font-size:14px}
label{display:block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin:14px 0 6px}
input{width:100%;padding:11px 12px;background:var(--bg);border:1px solid var(--line);border-radius:9px;color:var(--ink);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.08)}button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;font-size:13px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.msg{margin-top:16px;padding:10px 12px;border-radius:9px;font-size:13px;display:none}
.msg.err{display:block;background:rgba(255,93,106,.12);color:var(--loss);border:1px solid rgba(255,93,106,.3)}
.msg.ok{display:block;background:rgba(47,192,138,.12);color:var(--gain);border:1px solid rgba(47,192,138,.3)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.note{font-size:12px;color:var(--mut);margin-top:14px;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat .n{font-size:24px;font-weight:700;font-family:ui-monospace,monospace}.stat .k{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.admin{max-width:960px}.ticket{border:1px solid var(--line);border-radius:10px;padding:14px;margin-top:10px;background:var(--bg)}
iframe{width:100%;height:520px;border:1px solid var(--line);border-radius:10px;margin-top:14px;background:#fff}
.hidden{display:none}
`;

function shell(page, title, bodyHtml, cfg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Blockle</title><style>${CSS}</style></head>
<body data-page="${page}" data-plan="${cfg.planName}" data-price="${cfg.planPrice}" data-ccy="${cfg.planCurrency}">
<div class="wrap">${bodyHtml}</div>
<script src="/account/app.js"></script></body></html>`;
}

const brand = `<div class="brand"><span>◆ <b>Blockle</b></span></div>`;
const msg = `<div class="msg" id="msg"></div>`;

const BODIES = {
  login: () => `<div class="card">${brand}<h1>Sign in</h1><p class="sub">Your account syncs preferences, bots and encrypted backups. It never holds your keys.</p>
<form id="f"><label>Email</label><input name="email" type="email" autocomplete="email" required>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<div id="totpWrap" class="hidden"><label>Two-factor code</label><input name="totp" class="mono" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></div>
<button type="submit">Sign in</button></form>${msg}
<div class="row"><a href="/account/forgot">Forgot password?</a><a href="/account/register">Create account</a></div></div>`,

  register: () => `<div class="card">${brand}<h1>Create account</h1><p class="sub">Self-custody stays self-custody — we store credentials and an encrypted backup blob we can't read.</p>
<form id="f"><label>Email</label><input name="email" type="email" autocomplete="email" required>
<label>Password</label><input name="password" type="password" autocomplete="new-password" minlength="10" required>
<p class="note">At least 10 characters. Use a passphrase you don't use elsewhere.</p>
<button type="submit">Create account</button></form>${msg}
<div class="row"><span></span><a href="/account/login">Have an account? Sign in</a></div></div>`,

  forgot: () => `<div class="card">${brand}<h1>Reset password</h1><p class="sub">We'll email you a link that expires in 15 minutes.</p>
<form id="f"><label>Email</label><input name="email" type="email" autocomplete="email" required>
<button type="submit">Send reset link</button></form>${msg}
<div class="row"><a href="/account/login">Back to sign in</a><span></span></div></div>`,

  reset: () => `<div class="card">${brand}<h1>Choose a new password</h1><p class="sub">This signs out every device.</p>
<form id="f"><label>New password</label><input name="password" type="password" autocomplete="new-password" minlength="10" required>
<button type="submit">Update password</button></form>${msg}
<div class="row"><a href="/account/login">Back to sign in</a><span></span></div></div>`,

  verify: () => `<div class="card">${brand}<h1>Verifying…</h1><p class="sub" id="status">Checking your link.</p>${msg}
<a class="row" href="/account/login">Continue to sign in</a></div>`,

  support: () => `<div class="card">${brand}<h1>Contact support</h1><p class="sub">We'll reply by email. Never share your seed phrase or backup passphrase with anyone — support will never ask.</p>
<form id="f"><label>Email</label><input name="email" type="email" autocomplete="email" required>
<label>Subject</label><input name="subject" required>
<label>Message</label><input name="body" required>
<button type="submit">Send</button></form>${msg}</div>`,

  account: () => `<div class="card">${brand}<h1 id="hi">Your account</h1><p class="sub" id="email"></p>
<div class="grid" id="stats"></div>
<div id="subBox"></div>
<div id="twofaBox"></div>
<p class="note" id="backupNote">Encrypted wallet backup is managed from inside the Blockle wallet app — it encrypts your vault on your device with a backup passphrase and uploads only ciphertext we can't read.</p>
<button class="ghost" id="logout">Sign out</button>${msg}
<div class="row"><a href="/account/support">Support</a><a href="/">blockle.org</a></div></div>`,

  admin: () => `<div class="card admin">${brand}<h1>Admin</h1><p class="sub" id="who"></p>
<div class="grid" id="stats"></div>
<h1 style="font-size:16px">Support inbox (webmail)</h1>
<iframe src="/webmail/" title="support@blockle.org webmail"></iframe>
<h1 style="font-size:16px;margin-top:22px">Tickets</h1>
<div id="tickets"></div>${msg}
<button class="ghost" id="logout" style="max-width:160px">Sign out</button></div>`,
};

const TITLES = { login: 'Sign in', register: 'Create account', forgot: 'Reset', reset: 'Reset',
  verify: 'Verify', support: 'Support', account: 'Account', admin: 'Admin' };

export function renderPage(name, cfg) {
  const body = (BODIES[name] || BODIES.login)();
  return shell(name, TITLES[name] || 'Account', body, cfg);
}
