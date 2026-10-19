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
.brand{text-decoration:none;color:var(--ink)}.brand b{color:var(--accent)}
.brand .logo{width:22px;height:22px;vertical-align:middle;margin-right:7px;border-radius:6px;object-fit:contain}
.card.dash{max-width:560px}
.dhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.badge{font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:6px;border:1px solid var(--line);color:var(--mut)}
.badge.admin{color:var(--accent);border-color:var(--accent)}
.sec{border-top:1px solid var(--line);margin-top:18px;padding-top:16px}
.sec h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:0 0 12px}
.links{display:flex;flex-wrap:wrap;gap:8px}
.links a{display:inline-flex;align-items:center;gap:6px;padding:9px 13px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);font-size:14px;text-decoration:none}
.links a:hover{border-color:var(--accent);color:var(--accent)}
.statusline{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:14px;margin:8px 0}
.statusline .on{color:var(--gain)}.statusline .off{color:var(--mut)}
.device{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px}
.device:last-child{border-bottom:0}.device .d{min-width:0}.device .ua{color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.device .meta{color:var(--mut);font-size:12px}.device .here{color:var(--gain);font-size:12px}
button.danger,.wbtn.danger{background:transparent;border:1px solid rgba(255,93,106,.4);color:var(--loss)}
button.danger:hover{background:rgba(255,93,106,.12)}
.danger-zone h2{color:var(--loss)}
.codeblock{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px;margin:8px 0;display:flex;flex-direction:column;gap:4px;font-family:ui-monospace,Menlo,monospace;font-size:13px;overflow-x:auto}
.codeblock span{white-space:nowrap}
.row2{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn-sm-link{font-size:13px;padding:5px 10px;border:1px solid var(--line);border-radius:9px;color:var(--accent);text-decoration:none}
.codes .note b{color:var(--ink)}
.tabnav{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:4px 0 18px}
.tabnav button{background:none;border:0;border-bottom:2px solid transparent;color:var(--mut);font:inherit;font-size:14px;padding:10px 12px;cursor:pointer;margin-bottom:-1px}
.tabnav button.on{color:var(--ink);border-bottom-color:var(--accent)}
.tabpane.hidden{display:none}
.pf-hero{padding:6px 0 14px}.pf-hero .k{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
.pf-hero .n{font-size:34px;font-weight:700;font-family:ui-monospace,Menlo,monospace;letter-spacing:-.5px}
.pill{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--gold);border:1px solid color-mix(in srgb,var(--gold) 40%,var(--line));border-radius:999px;padding:1px 8px;vertical-align:middle}
.mkrow,.botrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px}
.mkrow:last-child,.botrow:last-child{border-bottom:0}
.mkrow .sym{font-weight:600}.mkrow .px{font-family:ui-monospace,Menlo,monospace}
.chg.up{color:var(--gain)}.chg.down{color:var(--loss)}
.botrow .meta{color:var(--mut);font-size:12px}
.pnl.up{color:var(--gain)}.pnl.down{color:var(--loss)}.pnl{font-family:ui-monospace,Menlo,monospace;font-weight:600}
.hold{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);font-size:14px}.hold:last-child{border-bottom:0}
/* --- dashboard polish --- */
.card.dash{padding:0;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.card.dash .dhead{padding:18px 22px 0}
.card.dash>.sub{padding:0 22px;color:var(--mut)}
.card.dash .tabnav{padding:0 22px;margin:10px 0 0;position:sticky;top:0;background:var(--panel);z-index:2}
.card.dash .tabpane{padding:18px 22px 22px}
.card.dash .tabnav button{font-weight:600}
.pf-hero{background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 14%,var(--panel)),var(--panel));border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:14px}
.grid{gap:10px}
.stat{transition:border-color .15s,transform .15s}.stat:hover{border-color:color-mix(in srgb,var(--accent) 50%,var(--line))}
.mkrow,.botrow{padding:13px 12px;border-radius:10px;margin-bottom:6px;border-bottom:0;background:var(--bg);border:1px solid transparent;transition:border-color .15s}
.mkrow:hover,.botrow:hover{border-color:var(--line)}
.sec h2{display:flex;align-items:center;gap:8px}
button.sm,.btn.sm{padding:8px 14px;border-radius:9px}
input,select,textarea{transition:border-color .15s}
@media(max-width:560px){.card.dash .tabnav{overflow-x:auto}.card.dash .tabpane{padding:16px 16px 20px}.card.dash .dhead{padding:16px 16px 0}.card.dash>.sub{padding:0 16px}}
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
.theme-toggle{position:fixed;top:14px;right:16px;z-index:10;width:36px;height:36px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font-size:15px;cursor:pointer;line-height:1}
.theme-toggle:hover{border-color:var(--accent)}
.dots{display:flex;gap:7px;justify-content:center;margin-bottom:20px}
.dots i{width:7px;height:7px;border-radius:50%;background:var(--line);transition:background .2s}
.dots i.on{background:var(--accent)}
.slide h2{font-size:22px;margin:0 0 10px;text-wrap:balance}
.slide .ico{font-size:40px;margin-bottom:10px}
.slide p{color:var(--mut);margin:0;font-size:15px;line-height:1.6}
`;

function shell(page, title, bodyHtml, cfg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Blockle</title><style>${CSS}</style></head>
<body data-page="${page}" data-plan="${cfg.planName}" data-price="${cfg.planPrice}" data-ccy="${cfg.planCurrency}">
<button class="theme-toggle" id="theme-toggle" aria-label="Toggle light/dark theme" title="Toggle theme">☾</button>
<div class="wrap">${bodyHtml}</div>
<script src="/account/app.js"></script></body></html>`;
}

const brand = `<a class="brand" href="/"><img class="logo" src="/logo-mark.png" alt=""><b>Blockle</b></a>`;
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
<label>Username</label><input name="username" autocomplete="username" placeholder="yourname" pattern="[A-Za-z0-9_]{3,20}">
<p class="note">Optional — your public @handle (3–20 letters, numbers, underscore). You can set or change it later.</p>
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

  verifyEmail: () => `<div class="card">${brand}<h1>Confirming email…</h1><p class="sub" id="status">Checking your link.</p>${msg}
<a class="row" href="/account">Go to your account</a></div>`,

  support: () => `<div class="card">${brand}<h1>Contact support</h1><p class="sub">We'll reply by email. Never share your seed phrase or backup passphrase with anyone — support will never ask.</p>
<form id="f"><label>Email</label><input name="email" type="email" autocomplete="email" required>
<label>Subject</label><input name="subject" required>
<label>Message</label><input name="body" required>
<button type="submit">Send</button></form>${msg}</div>`,

  account: () => `<div class="card dash" style="max-width:720px">
<div class="dhead">${brand}<span class="badge" id="role" style="display:none"></span></div>
<p class="sub" id="email"></p>
<div class="tabnav" id="tabnav">
  <button data-tab="portfolio" class="on">Portfolio</button>
  <button data-tab="markets">Markets</button>
  <button data-tab="bots">Bots</button>
  <button data-tab="account">Account</button>
</div>

<div class="tabpane" id="tab-portfolio">
  <div class="pf-hero"><div class="k">Portfolio value</div><div class="n" id="pf-total">—</div></div>
  <div class="grid" id="stats"></div>
  <div class="sec"><h2>Holdings</h2><div id="pf-holdings"><p class="muted">Loading…</p></div></div>
  <div class="sec"><h2>Deposit</h2><p class="note">Send funds to your receive address — they stay in your self-custody vault; we only read the public balance.</p>
    <pre class="codeblock" id="pf-address"><span class="muted">Loading…</span></pre>
    <div class="row2"><button class="ghost sm" id="pf-copy">Copy address</button></div></div>
  <div class="sec"><h2>Send</h2><p class="note">Sending is signed on your device in the Blockle wallet — your keys never leave it. <a href="/#download">Open your wallet →</a></p></div>
</div>

<div class="tabpane hidden" id="tab-markets">
  <div class="sec" style="border:0;padding-top:0"><h2>Markets</h2><div id="mk-list"><p class="muted">Loading…</p></div></div>
</div>

<div class="tabpane hidden" id="tab-bots">
  <div class="sec" style="border:0;padding-top:0"><h2>Trading bots <span class="pill">paper</span></h2>
    <p class="note">Test strategies risk-free with play money. Live bots run in your wallet, where every trade is signed by you.</p>
    <div id="bots-list"><p class="muted">Loading…</p></div>
    <div id="bot-create"></div>
    <button class="ghost sm" id="bot-new" style="margin-top:12px;max-width:150px">+ New paper bot</button>
  </div>
</div>

<div class="tabpane hidden" id="tab-account">
  <h1 id="hi" style="font-size:18px;margin-top:4px">Account</h1>
  <div class="sec"><h2>Security</h2><div id="twofaBox"></div><div id="backupBox"></div>
    <div class="statusline"><span id="sessLine" class="off">Active sessions: —</span><button class="ghost sm" id="logoutAll" style="max-width:170px">Sign out everywhere</button></div></div>
  <div class="sec"><h2>Devices</h2><div id="devices"><p class="muted">Loading…</p></div></div>
  <div class="sec"><h2>Plan</h2><div id="subBox"></div></div>
  <div class="sec"><h2>Quick links</h2><div class="links" id="links"></div></div>
  <div class="sec"><h2>Username</h2>
    <div class="statusline"><span id="unameLine" class="off"></span></div>
    <input id="uname-new" autocomplete="username" placeholder="username (3–20: a–z0–9_)" pattern="[A-Za-z0-9_]{3,20}">
    <button class="ghost sm" id="uname-save" style="margin-top:8px;max-width:160px">Save username</button></div>
  <div class="sec"><h2>Email</h2>
    <div class="statusline"><span id="emailLine" class="off"></span><button class="ghost sm" id="email-open" style="max-width:150px">Change email</button></div>
    <div id="email-area" class="hidden"></div></div>
  <div class="sec"><h2>Change password</h2>
    <input id="pw-current" type="password" placeholder="Current password" autocomplete="current-password">
    <input id="pw-next" type="password" placeholder="New password (10+ chars)" autocomplete="new-password" minlength="10">
    <button class="ghost sm" id="pw-save" style="margin-top:8px;max-width:180px">Update password</button></div>
  <div class="sec danger-zone"><h2>Danger zone</h2>
    <button class="ghost sm danger" id="del-open" style="max-width:180px">Delete account</button>
    <div id="del-area" class="hidden"></div></div>
  <button class="ghost" id="logout" style="margin-top:18px">Sign out</button>
  <div class="row"><a href="/">← blockle.org</a><a href="/account/support">Support</a></div>
</div>
${msg}</div>`,

  admin: () => `<div class="card admin">${brand}<h1>Admin</h1><p class="sub" id="who"></p>
<div class="grid" id="stats"></div>
<h1 style="font-size:16px;margin-top:22px">Traffic — blockle.org</h1>
<div class="grid" id="traffic-stats"></div>
<div style="position:relative;margin-top:10px"><canvas id="traffic-chart" height="200" style="width:100%;display:block"></canvas>
<div id="traffic-tip" style="position:absolute;pointer-events:none;display:none;background:var(--card,#1a1d24);border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:12px;white-space:nowrap;transform:translate(-50%,-115%)"></div></div>
<div id="traffic-top" class="note" style="margin-top:8px"></div>
<h1 style="font-size:16px;margin-top:22px">Support inbox (webmail)</h1>
<iframe src="/webmail/" title="support@blockle.org webmail"></iframe>
<h1 style="font-size:16px;margin-top:22px">Tickets</h1>
<div id="tickets"></div>${msg}
<button class="ghost" id="logout" style="max-width:160px">Sign out</button></div>`,

  welcome: () => `<div class="card" style="max-width:520px">${brand}
<div id="tour">
  <div class="dots" id="dots"></div>
  <div id="slide"></div>
  <div class="row" style="margin-top:22px">
    <button class="ghost" id="back" style="max-width:110px">Back</button>
    <button id="next" style="max-width:160px">Next</button>
  </div>
</div>${msg}</div>`,
};

const TITLES = { login: 'Sign in', register: 'Create account', forgot: 'Reset', reset: 'Reset',
  verify: 'Verify', verifyEmail: 'Confirm email', support: 'Support', account: 'Account', admin: 'Admin', welcome: 'Welcome' };

export function renderPage(name, cfg) {
  const body = (BODIES[name] || BODIES.login)();
  return shell(name, TITLES[name] || 'Account', body, cfg);
}
