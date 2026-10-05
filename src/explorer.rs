//! A block explorer for any Bitcoin-family chain, served over HTTP and
//! backed by the node's JSON-RPC (`getblock`, `getrawtransaction`, …).
//!
//! Built for Perbug (perbug.com) but chain-agnostic: pass `--rpc`, a coin
//! ticker, and a domain. Blocks, transactions (with resolved inputs when
//! `txindex=1`), mempool, chain stats, and search by height/hash/txid.
//! Address indexing isn't available from a stock node, so address lookup
//! is intentionally omitted rather than faked.

use std::net::TcpListener;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::http;
use crate::rpc::{RpcClient, RpcOutcome};

pub struct ExplorerConfig {
    pub rpc: String,
    pub listen: String,
    pub coin: String,
    pub domain: String,
}

struct Explorer {
    rpc: RpcClient,
    coin: String,
    domain: String,
}

pub fn serve(cfg: ExplorerConfig) -> Result<()> {
    let listener = TcpListener::bind(&cfg.listen)
        .map_err(|e| anyhow!("explorer cannot listen on {}: {e}", cfg.listen))?;
    println!("[{} explorer] http://{}/  (rpc {})", cfg.coin, cfg.listen, redact(&cfg.rpc));
    let ex = Arc::new(Explorer {
        rpc: RpcClient::new(&cfg.rpc),
        coin: cfg.coin,
        domain: cfg.domain,
    });
    for stream in listener.incoming().flatten() {
        let ex = ex.clone();
        thread::spawn(move || {
            let mut stream = stream;
            let Ok(req) = http::read_request(&mut stream) else { return };
            let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
            let (status, ctype, body) = ex.route(path, query);
            http::respond(&mut stream, status, ctype, &body);
        });
    }
    Ok(())
}

fn redact(url: &str) -> String {
    match (url.find("//"), url.find('@')) {
        (Some(s), Some(a)) if a > s => format!("{}//…@{}", &url[..s], &url[a + 1..]),
        _ => url.to_string(),
    }
}

impl Explorer {
    fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        match self.rpc.call(method, params) {
            RpcOutcome::Ok(v) => Ok(v),
            RpcOutcome::MethodNotFound => Err(anyhow!("{method}: not supported by this node")),
            RpcOutcome::Error(e) => Err(anyhow!("{method}: {e}")),
        }
    }

    fn route(&self, path: &str, query: &str) -> (&'static str, &'static str, Vec<u8>) {
        let html = |s: String| ("200 OK", "text/html; charset=utf-8", s.into_bytes());
        let json_ok = |v: Value| ("200 OK", "application/json", v.to_string().into_bytes());
        match path {
            "/" => html(self.page_home()),
            "/favicon.png" | "/favicon.ico" => ("200 OK", "image/png", FAVICON.to_vec()),
            "/search" => {
                let q = query_get(query, "q").unwrap_or("").trim().to_string();
                match self.resolve_search(&q) {
                    Some(loc) => (
                        "302 Found",
                        "text/html; charset=utf-8",
                        format!("<meta http-equiv=\"refresh\" content=\"0;url={loc}\">").into_bytes(),
                    ),
                    None => (
                        "404 Not Found",
                        "text/html; charset=utf-8",
                        self.page_notfound("result", &q).into_bytes(),
                    ),
                }
            }
            p if p.starts_with("/block/") => match self.page_block(&p["/block/".len()..]) {
                Ok(s) => html(s),
                Err(_) => (
                    "404 Not Found",
                    "text/html; charset=utf-8",
                    self.page_notfound("block", &p["/block/".len()..]).into_bytes(),
                ),
            },
            p if p.starts_with("/tx/") => match self.page_tx(&p["/tx/".len()..]) {
                Ok(s) => html(s),
                Err(_) => (
                    "404 Not Found",
                    "text/html; charset=utf-8",
                    self.page_notfound("transaction", &p["/tx/".len()..]).into_bytes(),
                ),
            },
            "/mempool" => html(self.page_mempool()),
            "/api/stats" => match self.chain_stats() {
                Ok(v) => json_ok(v),
                Err(e) => ("503 Service Unavailable", "application/json", json!({"error": e.to_string()}).to_string().into_bytes()),
            },
            _ => (
                "404 Not Found",
                "text/html; charset=utf-8",
                self.page_notfound("page", path).into_bytes(),
            ),
        }
    }

    fn chain_stats(&self) -> Result<Value> {
        let info = self.rpc("getblockchaininfo", json!([]))?;
        let mining = self.rpc("getmininginfo", json!([])).unwrap_or(Value::Null);
        Ok(json!({
            "coin": self.coin,
            "chain": info.get("chain"),
            "blocks": info.get("blocks"),
            "headers": info.get("headers"),
            "bestblockhash": info.get("bestblockhash"),
            "difficulty": info.get("difficulty"),
            "mediantime": info.get("mediantime"),
            "size_on_disk": info.get("size_on_disk"),
            "networkhashps": mining.get("networkhashps"),
            "pooledtx": mining.get("pooledtx"),
        }))
    }

    fn block_by_id(&self, id: &str) -> Result<Value> {
        let hash = if id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()) {
            id.to_string()
        } else {
            let height: u64 = id.parse().map_err(|_| anyhow!("bad id"))?;
            self.rpc("getblockhash", json!([height]))?
                .as_str()
                .ok_or_else(|| anyhow!("no block"))?
                .to_string()
        };
        // verbosity 2 includes full transaction data.
        self.rpc("getblock", json!([hash, 2]))
    }

    fn resolve_search(&self, q: &str) -> Option<String> {
        if q.is_empty() {
            return None;
        }
        if q.chars().all(|c| c.is_ascii_digit()) {
            return self.rpc("getblockhash", json!([q.parse::<u64>().ok()?])).ok().map(|_| format!("/block/{q}"));
        }
        if q.len() == 64 && q.chars().all(|c| c.is_ascii_hexdigit()) {
            if self.rpc("getblock", json!([q, 1])).is_ok() {
                return Some(format!("/block/{q}"));
            }
            if self.rpc("getrawtransaction", json!([q, true])).is_ok() {
                return Some(format!("/tx/{q}"));
            }
        }
        None
    }

    // ---------- pages ----------

    fn page_home(&self) -> String {
        let stats = match self.chain_stats() {
            Ok(s) => s,
            Err(e) => {
                return shell(
                    &self.coin,
                    &self.domain,
                    format!(
                        r#"<h1>{} Explorer</h1><p class="note">Node unavailable: {}</p>"#,
                        self.coin, e
                    ),
                )
            }
        };
        let tip = stats["blocks"].as_u64().unwrap_or(0);
        let mut rows = String::new();
        for h in (0..=tip).rev().take(25) {
            if let Ok(hash) = self.rpc("getblockhash", json!([h])) {
                if let Some(hs) = hash.as_str() {
                    if let Ok(b) = self.rpc("getblock", json!([hs, 1])) {
                        rows.push_str(&format!(
                            r#"<tr><td class="mono"><a href="/block/{h}">{h}</a></td><td class="mono"><a href="/block/{hash}">{short}…</a></td><td class="mono">{txs}</td><td class="mono">{size}</td><td class="mono">{age}</td></tr>"#,
                            h = h,
                            hash = hs,
                            short = &hs[..16.min(hs.len())],
                            txs = b["nTx"].as_u64().or_else(|| b["tx"].as_array().map(|a| a.len() as u64)).unwrap_or(0),
                            size = b["size"].as_u64().unwrap_or(0),
                            age = ago(b["time"].as_u64().unwrap_or(0)),
                        ));
                    }
                }
            }
        }
        let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
        let hashps = stats["networkhashps"].as_f64().unwrap_or(0.0);
        let body = format!(
            r##"<h1>{coin} Explorer</h1>
<form class="search" method="get" action="/search"><input name="q" placeholder="block height · block hash · txid" autofocus><button type="submit">Search</button></form>
<div class="cards">{c1}{c2}{c3}{c4}</div>
<h2>Latest blocks</h2>
<table><tr><th>height</th><th>hash</th><th>txs</th><th>size</th><th>age</th></tr>{rows}</table>
<p class="sub"><a href="/mempool">Mempool</a> · <a href="/api/stats">API</a></p>"##,
            coin = self.coin,
            c1 = card("Height", tip.to_string()),
            c2 = card("Difficulty", fmt_sci(stats["difficulty"].as_f64().unwrap_or(0.0))),
            c3 = card("Network hashrate", fmt_hashrate(hashps)),
            c4 = card("Mempool tx", stats["pooledtx"].as_u64().unwrap_or(0).to_string()),
            rows = rows,
        );
        shell(&self.coin, &self.domain, body)
    }

    fn page_block(&self, id: &str) -> Result<String> {
        let b = self.block_by_id(id)?;
        let height = b["height"].as_u64().unwrap_or(0);
        let txs = b["tx"].as_array().cloned().unwrap_or_default();
        let mut tx_rows = String::new();
        for t in txs.iter().take(200) {
            let txid = t["txid"].as_str().unwrap_or("");
            let vout_total: f64 = t["vout"].as_array().map(|vs| vs.iter().map(|v| v["value"].as_f64().unwrap_or(0.0)).sum()).unwrap_or(0.0);
            let is_cb = t["vin"].as_array().map(|vs| vs.iter().any(|v| v.get("coinbase").is_some())).unwrap_or(false);
            tx_rows.push_str(&format!(
                r#"<tr><td class="mono"><a href="/tx/{txid}">{short}…</a></td><td>{kind}</td><td class="mono">{nin}</td><td class="mono">{nout}</td><td class="mono">{val:.8} {coin}</td></tr>"#,
                txid = txid,
                short = &txid[..20.min(txid.len())],
                kind = if is_cb { "coinbase" } else { "tx" },
                nin = t["vin"].as_array().map(|a| a.len()).unwrap_or(0),
                nout = t["vout"].as_array().map(|a| a.len()).unwrap_or(0),
                val = vout_total,
                coin = self.coin,
            ));
        }
        let body = format!(
            r##"<h1>Block {height}</h1>
<p class="sub mono">{hash}</p>
{meta}
<h2>Transactions ({ntx})</h2>
<table><tr><th>txid</th><th>kind</th><th>in</th><th>out</th><th>value</th></tr>{tx_rows}</table>
<p class="sub"><a href="/block/{prev}">← block {prev}</a> · <a href="/">explorer home</a></p>"##,
            height = height,
            hash = b["hash"].as_str().unwrap_or(""),
            meta = kv(&[
                ("confirmations", b["confirmations"].as_i64().unwrap_or(0).to_string()),
                ("time", format!("{} ({})", b["time"].as_u64().unwrap_or(0), ago(b["time"].as_u64().unwrap_or(0)))),
                ("transactions", txs.len().to_string()),
                ("size", format!("{} bytes", b["size"].as_u64().unwrap_or(0))),
                ("weight", b["weight"].as_u64().unwrap_or(0).to_string()),
                ("difficulty", fmt_sci(b["difficulty"].as_f64().unwrap_or(0.0))),
                ("bits", b["bits"].as_str().unwrap_or("?").to_string()),
                ("nonce", b["nonce"].as_u64().unwrap_or(0).to_string()),
                ("merkle root", b["merkleroot"].as_str().unwrap_or("?").to_string()),
                ("previous block", b["previousblockhash"].as_str().unwrap_or("—").to_string()),
            ]),
            ntx = txs.len(),
            tx_rows = tx_rows,
            prev = height.saturating_sub(1),
        );
        Ok(shell(&self.coin, &self.domain, body))
    }

    fn page_tx(&self, txid: &str) -> Result<String> {
        let tx = self.rpc("getrawtransaction", json!([txid, true]))?;
        let mut in_rows = String::new();
        let mut in_total = 0.0f64;
        for vin in tx["vin"].as_array().cloned().unwrap_or_default() {
            if let Some(cb) = vin.get("coinbase").and_then(|c| c.as_str()) {
                in_rows.push_str(&format!(
                    r#"<tr><td colspan="2" style="color:var(--muted)">newly generated coins (coinbase)</td><td class="mono">{}…</td></tr>"#,
                    &cb[..24.min(cb.len())]
                ));
                continue;
            }
            let ptxid = vin["txid"].as_str().unwrap_or("");
            let pv = vin["vout"].as_u64().unwrap_or(0);
            // Resolve the spent output (requires txindex=1).
            let (addr, val) = self
                .rpc("getrawtransaction", json!([ptxid, true]))
                .ok()
                .and_then(|pt| pt["vout"].as_array().and_then(|vs| vs.get(pv as usize).cloned()))
                .map(|o| {
                    (
                        o["scriptPubKey"]["address"].as_str().unwrap_or("?").to_string(),
                        o["value"].as_f64().unwrap_or(0.0),
                    )
                })
                .unwrap_or(("?".into(), 0.0));
            in_total += val;
            in_rows.push_str(&format!(
                r#"<tr><td class="mono"><a href="/tx/{ptxid}">{short}…</a>:{pv}</td><td class="mono">{addr}</td><td class="mono">{val:.8}</td></tr>"#,
                ptxid = ptxid,
                short = &ptxid[..16.min(ptxid.len())],
                pv = pv,
                addr = addr,
                val = val,
            ));
        }
        let mut out_rows = String::new();
        let mut out_total = 0.0f64;
        for o in tx["vout"].as_array().cloned().unwrap_or_default() {
            let val = o["value"].as_f64().unwrap_or(0.0);
            out_total += val;
            out_rows.push_str(&format!(
                r#"<tr><td class="mono">{n}</td><td class="mono">{addr}</td><td class="mono">{val:.8} {coin}</td></tr>"#,
                n = o["n"].as_u64().unwrap_or(0),
                addr = o["scriptPubKey"]["address"].as_str().unwrap_or("(non-standard)"),
                val = val,
                coin = self.coin,
            ));
        }
        let fee = if in_total > 0.0 { format!("{:.8} {}", (in_total - out_total).max(0.0), self.coin) } else { "—".into() };
        let body = format!(
            r##"<h1>Transaction</h1>
<p class="sub mono">{txid}</p>
{meta}
<h2>Inputs</h2>
<table><tr><th>outpoint</th><th>address</th><th>amount</th></tr>{in_rows}</table>
<h2>Outputs</h2>
<table><tr><th>#</th><th>address</th><th>amount</th></tr>{out_rows}</table>"##,
            txid = txid,
            meta = kv(&[
                ("in block", tx["blockhash"].as_str().map(|h| format!("<a href=\"/block/{h}\">{}…</a>", &h[..16.min(h.len())])).unwrap_or_else(|| "mempool".into())),
                ("confirmations", tx["confirmations"].as_i64().unwrap_or(0).to_string()),
                ("total output", format!("{out_total:.8} {}", self.coin)),
                ("fee", fee),
                ("size", format!("{} bytes", tx["size"].as_u64().unwrap_or(0))),
            ]),
            in_rows = in_rows,
            out_rows = out_rows,
        );
        Ok(shell(&self.coin, &self.domain, body))
    }

    fn page_mempool(&self) -> String {
        let txids = self.rpc("getrawmempool", json!([])).unwrap_or(Value::Null);
        let list = txids.as_array().cloned().unwrap_or_default();
        let rows: String = list
            .iter()
            .take(100)
            .filter_map(|t| t.as_str())
            .map(|id| format!(r#"<tr><td class="mono"><a href="/tx/{id}">{id}</a></td></tr>"#))
            .collect();
        let body = format!(
            r##"<h1>Mempool <span class="badge">{} unconfirmed</span></h1>
<table><tr><th>txid</th></tr>{rows}</table>
<p class="sub"><a href="/">← explorer</a></p>"##,
            list.len(),
            rows = rows,
        );
        shell(&self.coin, &self.domain, body)
    }

    fn page_notfound(&self, what: &str, id: &str) -> String {
        shell(
            &self.coin,
            &self.domain,
            format!(
                r##"<h1>Not found</h1><p class="note">No {what} <span class="mono">{id}</span>.</p><p class="sub"><a href="/">← {coin} explorer</a></p>"##,
                what = what,
                id = clean(id),
                coin = self.coin,
            ),
        )
    }
}

fn query_get<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').take(80).collect()
}

fn kv(rows: &[(&str, String)]) -> String {
    let body: String = rows
        .iter()
        .map(|(k, v)| format!(r#"<tr><td style="color:var(--muted)">{k}</td><td class="mono">{v}</td></tr>"#))
        .collect();
    format!("<table class=\"kv\">{body}</table>")
}

fn ago(ts: u64) -> String {
    if ts == 0 {
        return "—".into();
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(ts);
    let d = now.saturating_sub(ts);
    match d {
        0..=59 => format!("{d}s ago"),
        60..=3599 => format!("{}m ago", d / 60),
        3600..=86399 => format!("{}h ago", d / 3600),
        _ => format!("{}d ago", d / 86400),
    }
}

fn fmt_sci(v: f64) -> String {
    if v == 0.0 {
        "0".into()
    } else if v >= 1e6 || v < 1e-3 {
        format!("{v:.3e}")
    } else {
        format!("{v:.3}")
    }
}

fn fmt_hashrate(h: f64) -> String {
    const U: &[&str] = &["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
    let mut v = h;
    let mut i = 0;
    while v >= 1000.0 && i < U.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    format!("{v:.2} {}", U[i])
}

fn shell(coin: &str, domain: &str, body: String) -> String {
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>{coin} Explorer · {domain}</title><style>{CSS}</style></head><body>
<nav><a class="brand" href="/">{coin} <span class="ex">explorer</span></a><span class="spacer"></span><a href="/mempool">Mempool</a><a href="/api/stats">API</a></nav>
<main>{body}</main>
<footer>{domain} — {coin} block explorer. Powered by <a href="https://blockle.org">Blockle</a>.</footer>
</body></html>"##,
        coin = coin,
        domain = domain,
        CSS = CSS,
        body = body,
    )
}

const CSS: &str = r#"
:root{--bg:#0a0b0e;--bg2:#0e1014;--surface:#13151a;--surface2:#181b21;--border:#23262e;--border2:#2e323c;--ink:#f2f4f8;--ink2:#b7bcc8;--muted:#7d8495;--accent:#3987e5;--accent2:#6da7ec;--mono:ui-monospace,'SF Mono',Menlo,monospace;--r:12px}
*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);margin:0;font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent2);text-decoration:none}a:hover{color:#8ebcf2}
h1{font-size:clamp(1.6rem,3vw,2.1rem);letter-spacing:-.02em;margin:.2rem 0 .8rem}
h2{font-size:1rem;font-weight:600;margin:2.2rem 0 .8rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);color:var(--ink)}
nav{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:.5rem;padding:.7rem clamp(1rem,4vw,2.5rem);background:rgba(10,11,14,.8);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
nav .brand{font-weight:700;color:var(--ink);font-size:1.05rem}nav .brand .ex{color:var(--accent);font-weight:600}
nav .spacer{flex:1}nav a:not(.brand){color:var(--muted);font-size:.86rem;font-weight:500;padding:.35rem .7rem;border-radius:7px}nav a:not(.brand):hover{color:var(--ink);background:var(--surface)}
main{max-width:1060px;margin:0 auto;padding:2rem clamp(1rem,4vw,2.5rem) 3rem}
.search{display:flex;gap:.6rem;margin:1.2rem 0 1.8rem}
.search input{flex:1;background:var(--surface);border:1px solid var(--border2);color:var(--ink);padding:.7rem 1rem;border-radius:9px;font-size:.95rem;outline:none}
.search input:focus{border-color:var(--accent)}
.search button{background:#2a6fc4;border:none;color:#fff;font-weight:600;padding:.7rem 1.3rem;border-radius:9px;cursor:pointer}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.8rem;margin:1.2rem 0}
.card{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--border);border-radius:var(--r);padding:1rem 1.1rem}
.card .v{font-size:1.4rem;font-weight:700;letter-spacing:-.02em}.card .k{color:var(--muted);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-top:.3rem}
table{border-collapse:collapse;width:100%;margin:.8rem 0;font-size:.88rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
th{color:var(--muted);text-align:left;font-weight:600;text-transform:uppercase;font-size:.7rem;letter-spacing:.07em;background:var(--bg2)}
td,th{border-bottom:1px solid var(--border);padding:.6rem .85rem}tr:last-child td{border-bottom:none}table tr:hover td{background:rgba(255,255,255,.02)}
.mono{font-family:var(--mono);font-size:.84rem;font-variant-numeric:tabular-nums}
table.kv td:first-child{width:11rem}
.sub{color:var(--ink2)}.badge{display:inline-block;border:1px solid var(--border2);border-radius:6px;padding:.08rem .5rem;font-size:.72rem;font-weight:600;color:var(--muted)}
.note{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--surface);padding:.8rem 1rem;color:var(--ink2);margin:1.2rem 0}
@media(max-width:700px){table{display:block;overflow-x:auto;white-space:nowrap}main{padding:1.3rem .9rem}}
footer{color:var(--muted);border-top:1px solid var(--border);margin-top:3rem;padding:1.6rem clamp(1rem,4vw,2.5rem);font-size:.83rem;max-width:1060px;margin-left:auto;margin-right:auto}
"#;

const FAVICON: &[u8] = include_bytes!("assets/favicon-32.png");
