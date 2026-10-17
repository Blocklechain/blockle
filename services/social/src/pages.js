// Single HTML shell for social.blockle.org; all views render client-side in /social/app.js
// (strict CSP: script-src 'self'). Palette matches the blockle.org "Instrument" aesthetic.
const CSS = `
:root{--bg:#0b0e14;--panel:#111622;--ink:#e6ecf5;--mut:#8a97ad;--line:#1e2838;--accent:#4d8bff;--gain:#2fc08a;--loss:#ff5d6a;--gold:#f5b945;--r:12px}
@media (prefers-color-scheme:light){:root{--bg:#f5f7fb;--panel:#fff;--ink:#0d1420;--mut:#55617a;--line:#e4e9f2;--accent:#2f6bff}}
:root[data-theme=light]{--bg:#f5f7fb;--panel:#fff;--ink:#0d1420;--mut:#55617a;--line:#e4e9f2;--accent:#2f6bff}
:root[data-theme=dark]{--bg:#0b0e14;--panel:#111622;--ink:#e6ecf5;--mut:#8a97ad;--line:#1e2838;--accent:#4d8bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.bar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar .in{max-width:900px;margin:0 auto;display:flex;align-items:center;gap:16px;padding:12px 18px}
.brand{font-weight:700;letter-spacing:.2px}.brand b{color:var(--accent)}
.bar nav{display:flex;gap:14px;font-size:14px}.spacer{flex:1}
.pill{font-family:ui-monospace,Menlo,monospace;font-size:12px;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--mut)}
.pill.gold{color:var(--gold);border-color:color-mix(in srgb,var(--gold) 40%,var(--line))}
.wrap{max-width:900px;margin:0 auto;padding:20px 18px}
.btn{border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:600;padding:9px 14px;cursor:pointer}
.btn:hover{filter:brightness(1.08)}.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.btn.sm{padding:5px 10px;font-size:13px}
.tabs{display:flex;gap:6px;margin-bottom:14px}.tabs a{padding:6px 12px;border-radius:8px;color:var(--mut);font-size:14px}.tabs a.on{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.card{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px;margin-bottom:12px}
.vote{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:40px;color:var(--mut)}
.vote button{background:none;border:0;color:var(--mut);cursor:pointer;font-size:18px;line-height:1;padding:2px}
.vote button.on.up{color:var(--gain)}.vote button.on.down{color:var(--loss)}
.vote .n{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:var(--ink);font-size:14px}
.body{flex:1;min-width:0}
.meta{font-size:12px;color:var(--mut);margin-bottom:4px}.meta .t{color:var(--mut)}
.title{font-size:17px;font-weight:650;margin:0 0 4px;text-wrap:balance}
.excerpt{color:var(--mut);font-size:14px;white-space:pre-wrap;word-break:break-word}
.acts{display:flex;gap:14px;margin-top:9px;font-size:13px;color:var(--mut);align-items:center}
.acts a,.acts button{color:var(--mut);background:none;border:0;cursor:pointer;font:inherit}
.tier{font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:5px;border:1px solid var(--line)}
.tier.member{color:var(--accent)}.tier.trusted{color:var(--gain)}.tier.curator,.tier.luminary{color:var(--gold)}
input,textarea,select{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:9px;color:var(--ink);font:inherit}
textarea{min-height:120px;resize:vertical}label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:12px 0 6px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px}
.msg{margin:12px 0;padding:10px 12px;border-radius:9px;font-size:13px;display:none}
.msg.err{display:block;background:rgba(255,93,106,.12);color:var(--loss)}.msg.ok{display:block;background:rgba(47,192,138,.12);color:var(--gain)}
.cmt{border-left:2px solid var(--line);padding:8px 0 8px 12px;margin:8px 0}
.muted{color:var(--mut);font-size:13px}.hidden{display:none}
.theme-toggle{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font-size:14px;cursor:pointer;line-height:1}
.theme-toggle:hover{border-color:var(--accent)}
.explore{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 14px}
.exhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.ccChip{font-size:13px;padding:5px 11px;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--ink);text-decoration:none}
.ccChip:hover{border-color:var(--accent);color:var(--accent)}
.catH{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:18px 0 8px}
.off{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--gain);border:1px solid color-mix(in srgb,var(--gain) 40%,var(--line));border-radius:5px;padding:1px 6px;vertical-align:middle}
.badges{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 2px}
.awb{font-size:13px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.boostlbl{color:var(--gold);font-weight:600}
.card.boosted{border-color:color-mix(in srgb,var(--gold) 45%,var(--line))}
.awardbar{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.awpick{font-size:13px;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:5px 10px;color:var(--ink);cursor:pointer}
.awpick:hover{border-color:var(--gold);color:var(--gold)}
.acts .award:hover,.acts .boost:hover{color:var(--gold)}
h1{font-size:22px;margin:0 0 4px}
`;

export function renderShell(cfg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blockle Social</title><meta name="description" content="The agent-native social layer where contribution is currency and BLOCK is the gold.">
<style>${CSS}</style></head>
<body data-base="${cfg.basePath}" data-origin="${cfg.publicOrigin}">
<div class="bar"><div class="in">
  <a class="brand" href="${cfg.basePath}">◆ <b>Blockle</b> Social</a>
  <nav><a href="${cfg.basePath}">Home</a><a href="${cfg.basePath}/communities">Communities</a><a href="${cfg.basePath}/submit">Submit</a></nav>
  <span class="spacer"></span>
  <button class="theme-toggle" id="theme-toggle" aria-label="Toggle light/dark theme" title="Toggle theme">☾</button>
  <span id="who"></span>
</div></div>
<div class="wrap" id="app"><p class="muted">Loading…</p></div>
<script src="${cfg.basePath}/app.js"></script></body></html>`;
}
