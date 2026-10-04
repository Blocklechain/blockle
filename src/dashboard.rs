//! Web dashboard: pool stats as JSON (`/stats.json`, `/payouts.json`) and a
//! small HTML page at `/`.

use std::net::TcpListener;
use std::sync::Arc;
use std::thread;

use anyhow::{anyhow, Result};
use serde_json::json;

use crate::http;
use crate::stratum::Engine;

const LOGO_MARK_PNG: &[u8] = include_bytes!("assets/logo-mark-128.png");

pub fn serve(engine: Arc<Engine>, listen: &str) -> Result<()> {
    let listener = TcpListener::bind(listen)
        .map_err(|e| anyhow!("dashboard cannot listen on {listen}: {e}"))?;
    println!("[pool] dashboard http://{listen}/");
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let engine = engine.clone();
            thread::spawn(move || {
                let mut stream = stream;
                let Ok(req) = http::read_request(&mut stream) else { return };
                match req.path.as_str() {
                    "/logo.png" | "/favicon.png" | "/favicon.ico" => {
                        http::respond(&mut stream, "200 OK", "image/png", LOGO_MARK_PNG);
                    }
                    "/stats.json" => {
                        let ledger = engine.ledger.lock().unwrap();
                        let body = json!({
                            "chain": engine.chain_name,
                            "stratum": engine.stratum_listen,
                            "height": engine.current_height(),
                            "miners_connected": engine.session_count(),
                            "hashrate_est": ledger.hashrate(),
                            "scheme": ledger.scheme_name(),
                            "pool_balance": ledger.pool_balance,
                            "workers": ledger.workers,
                            "blocks_found": ledger.blocks,
                        });
                        http::respond(&mut stream, "200 OK", "application/json", body.to_string().as_bytes());
                    }
                    "/payouts.json" => {
                        let ledger = engine.ledger.lock().unwrap();
                        let body = json!({
                            "scheme": ledger.scheme_name(),
                            "balances": ledger.balances(),
                            "pool_balance": ledger.pool_balance,
                            "blocks": ledger.blocks.len(),
                        });
                        http::respond(&mut stream, "200 OK", "application/json", body.to_string().as_bytes());
                    }
                    _ => {
                        let ledger = engine.ledger.lock().unwrap();
                        let mut workers = String::new();
                        for (name, w) in &ledger.workers {
                            workers.push_str(&format!(
                                "<tr><td>{name}</td><td>{}</td><td>{}</td><td>{:.0}</td></tr>",
                                w.accepted, w.rejected, w.weight
                            ));
                        }
                        let mut blocks = String::new();
                        for b in ledger.blocks.iter().rev().take(20) {
                            blocks.push_str(&format!(
                                "<tr><td>{}</td><td><code>{}</code></td><td>{}</td></tr>",
                                b.height, b.hash, b.finder
                            ));
                        }
                        let html = format!(
                            r##"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>{chain} · Blockle pool</title><style>
:root{{--bg:#0a0b0e;--surface:#13151a;--border:#23262e;--ink:#f2f4f8;--muted:#7d8495;--accent:#3987e5}}
*{{box-sizing:border-box}}body{{background:var(--bg);color:var(--ink);font:15px/1.65 system-ui,sans-serif;margin:0;padding:2rem clamp(1rem,4vw,3rem)}}
h1{{font-size:1.6rem;letter-spacing:-.02em;margin:.2rem 0 .3rem}}h1 .hex{{color:var(--accent)}}
.sub{{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:.85rem}}
h2{{font-size:1rem;margin:2.2rem 0 .8rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}}
table{{border-collapse:collapse;width:100%;max-width:64rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;font-size:.88rem}}
td,th{{border-bottom:1px solid var(--border);padding:.6rem .85rem;text-align:left}}
th{{color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.07em}}
tr:last-child td{{border-bottom:none}}tr:hover td{{background:rgba(255,255,255,.02)}}
td{{font-variant-numeric:tabular-nums}}code{{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:#8ebcf2}}
@media(max-width:700px){{body{{padding:1.2rem .9rem}}table{{display:block;overflow-x:auto;white-space:nowrap}}td,th{{padding:.5rem .6rem}}.sub{{font-size:.76rem;word-break:break-all}}}}
</style></head><body>
<h1><img src="/logo.png" style="width:26px;height:26px;border-radius:6px;vertical-align:-4px"> {chain} pool</h1>
<p class="sub">stratum+tcp://{stratum} · height {height} · {miners} miner(s) · ≈{hr:.0} H/s · <a style="color:#6da7ec" href="/stats.json">stats.json</a></p>
<h2>Workers</h2><table><tr><th>worker</th><th>accepted</th><th>rejected</th><th>weight</th></tr>{workers}</table>
<h2>Blocks found ({nblocks})</h2><table><tr><th>height</th><th>hash</th><th>finder</th></tr>{blocks}</table>
</body></html>"##,
chain = engine.chain_name,
                            stratum = engine.stratum_listen,
                            height = engine.current_height().map(|h| h.to_string()).unwrap_or_else(|| "?".into()),
                            miners = engine.session_count(),
                            hr = ledger.hashrate(),
                            nblocks = ledger.blocks.len(),
                        );
                        http::respond(&mut stream, "200 OK", "text/html; charset=utf-8", html.as_bytes());
                    }
                }
            });
        }
    });
    Ok(())
}
