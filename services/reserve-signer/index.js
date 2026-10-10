// Blockle reserve signer — the ONLY process that moves premine BLOCK.
//
// The exchange relay and other services are non-custodial: they hold NO
// reserve key. When a gated money path needs to dispense premine BLOCK (the
// listing-liquidity seed, a curve release, etc.) they POST here over LOOPBACK.
// This process shells the reserve wallet CLI (blockle-chain), which holds the
// key in the node wallet datadir — the key never enters this file or any other
// service. We bind 127.0.0.1 ONLY (never public; nginx must not proxy it),
// gate every real send behind mainnetEnabled, enforce a daily BLOCK cap,
// validate the recipient + amount, optionally require a bearer token, and
// append every attempt to an audit log.
//
// Contract (matches exchange/server/src/seed.ts HttpReserveSigner):
//   GET  /healthz            -> { ok, address }               (reserve reachable?)
//   POST /reserve/dispense   { purpose, amountBase, asset:"BLOCK", to?, ... }
//                            -> { txid, detail, dryRun }
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ---- config (env overrides file overrides defaults) ------------------------
function loadConfig() {
  const cfgPath = process.env.RESERVE_SIGNER_CONFIG || path.join(__dirname, "config.json");
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    /* defaults */
  }
  const envBool = (k, d) => {
    const v = process.env[k];
    if (v == null || v === "") return d;
    return v === "1" || v.toLowerCase() === "true";
  };
  const envNum = (k, d) => {
    const v = process.env[k];
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const envStr = (k, d) => process.env[k] || file[camel(k)] || d;
  function camel(ENV) {
    // RESERVE_DATADIR -> reserveDatadir
    return ENV.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  return {
    host: "127.0.0.1", // LOOPBACK ONLY — never 0.0.0.0
    port: envNum("RESERVE_SIGNER_PORT", file.port || 8795),
    chainBin: envStr("RESERVE_CHAIN_BIN", file.chainBin || "/opt/blockle/chain/target/release/blockle-chain"),
    reserveDatadir: envStr("RESERVE_DATADIR", file.reserveDatadir || "/var/lib/blockle-mainnet"),
    nodeAddr: envStr("RESERVE_NODE_ADDR", file.nodeAddr || "127.0.0.1:18444"),
    network: envStr("RESERVE_NETWORK", file.network || "mainnet"),
    // GATING: no real send unless mainnetEnabled && legalReviewCompleted.
    mainnetEnabled: envBool("RESERVE_MAINNET_ENABLED", file.mainnetEnabled ?? false),
    legalReviewCompleted: envBool("RESERVE_LEGAL_REVIEW_COMPLETED", file.legalReviewCompleted ?? false),
    // Even when enabled, dryRun=true records intent and sends nothing.
    dryRun: envBool("RESERVE_DRY_RUN", file.dryRun ?? true),
    // Per-purpose default recipient (e.g. where listing-liquidity seeds go)
    // and a hard per-day BLOCK cap across all dispenses.
    seedDestination: envStr("RESERVE_SEED_DESTINATION", file.seedDestination || ""),
    dailyCapBlock: envNum("RESERVE_DAILY_CAP_BLOCK", file.dailyCapBlock || 1000),
    // Optional shared bearer token (defense-in-depth beyond loopback).
    authToken: envStr("RESERVE_AUTH_TOKEN", file.authToken || ""),
    maxAmountBlock: envNum("RESERVE_MAX_AMOUNT_BLOCK", file.maxAmountBlock || 200),
    feeBlock: envStr("RESERVE_FEE_BLOCK", file.feeBlock || "0.0001"),
    auditLog: envStr("RESERVE_AUDIT_LOG", file.auditLog || "/var/lib/blockle-reserve-signer/audit.jsonl"),
    ledger: envStr("RESERVE_LEDGER", file.ledger || "/var/lib/blockle-reserve-signer/dispensed.jsonl"),
  };
}

const BLOCK_ADDR = /^block1[0-9a-z]{20,}$/i;

function baseToBlock(amountBase) {
  // 1 BLOCK = 1e8 base units; produce a plain decimal string (<=8 dp).
  const n = BigInt(amountBase);
  const whole = n / 100000000n;
  const frac = (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function audit(cfg, entry) {
  try {
    fs.mkdirSync(path.dirname(cfg.auditLog), { recursive: true });
    fs.appendFileSync(cfg.auditLog, JSON.stringify({ t: Math.floor(Date.now() / 1000), ...entry }) + "\n");
  } catch {
    /* never block a dispense on audit IO */
  }
}

// Sum today's real dispenses (BLOCK) from the ledger for the daily cap.
function dispensedTodayBlock(cfg) {
  try {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const since = Math.floor(dayStart.getTime() / 1000);
    let sum = 0;
    for (const line of fs.readFileSync(cfg.ledger, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.t >= since && r.block) sum += Number(r.block);
    }
    return sum;
  } catch {
    return 0;
  }
}

function recordDispense(cfg, rec) {
  try {
    fs.mkdirSync(path.dirname(cfg.ledger), { recursive: true });
    fs.appendFileSync(cfg.ledger, JSON.stringify({ t: Math.floor(Date.now() / 1000), ...rec }) + "\n");
  } catch {
    /* ledger best-effort; cap check degrades safe (under-counts) */
  }
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${err.message} ${stderr || ""}`.trim()));
      resolve(String(stdout || ""));
    });
  });
}

function parseTxid(stdout) {
  try {
    const j = JSON.parse(stdout);
    return j.txid || j.txId || j.hash || (j.result && j.result.txid) || null;
  } catch {
    const m = stdout.match(/[0-9a-fA-F]{64}/);
    return m ? m[0] : null;
  }
}

/** The single money-moving primitive. Returns { txid, dryRun, detail } or throws. */
async function dispense(cfg, { to, amountBase, purpose, meta }) {
  if (!BLOCK_ADDR.test(String(to || ""))) throw new Error("invalid or missing recipient (block1…)");
  let amt;
  try {
    amt = BigInt(amountBase);
  } catch {
    throw new Error("amountBase must be an integer string (base units)");
  }
  if (amt <= 0n) throw new Error("amountBase must be positive");
  const block = Number(baseToBlock(amountBase));
  if (block > cfg.maxAmountBlock) throw new Error(`amount ${block} exceeds per-dispense cap ${cfg.maxAmountBlock} BLOCK`);
  if (dispensedTodayBlock(cfg) + block > cfg.dailyCapBlock) {
    throw new Error(`daily dispense cap of ${cfg.dailyCapBlock} BLOCK reached`);
  }

  const live = cfg.mainnetEnabled && cfg.legalReviewCompleted && !cfg.dryRun;
  if (!live) {
    const crypto = require("crypto");
    const txid = "dryrun-" + crypto.createHash("sha256").update(`${to}:${amountBase}:${purpose}`).digest("hex").slice(0, 56);
    audit(cfg, { kind: "dispense", mode: "dryrun", purpose, to, amountBase, block, meta });
    return { txid, dryRun: true, detail: "dry-run (mainnet dispense disabled)" };
  }

  const amount = baseToBlock(amountBase);
  const args = [
    "--json",
    "--datadir",
    cfg.reserveDatadir,
    "--network",
    cfg.network,
    "send",
    "--to",
    to,
    "--amount",
    amount,
    "--fee",
    cfg.feeBlock,
    "--node",
    cfg.nodeAddr,
  ];
  const stdout = await run(cfg.chainBin, args, 60000);
  const txid = parseTxid(stdout);
  if (!txid) throw new Error(`dispense produced no txid: ${stdout.slice(0, 160)}`);
  recordDispense(cfg, { txid, to, amountBase, block, purpose });
  audit(cfg, { kind: "dispense", mode: "sent", purpose, to, amountBase, block, txid, meta });
  return { txid, dryRun: false, detail: "dispensed" };
}

// ---- HTTP (loopback only) --------------------------------------------------
function createServer(cfg) {
  return http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === "GET" && req.url.startsWith("/healthz")) {
      run(cfg.chainBin, ["--datadir", cfg.reserveDatadir, "--network", cfg.network, "address"], 8000)
        .then((out) => send(200, { ok: true, address: out.trim(), mainnet: cfg.mainnetEnabled && cfg.legalReviewCompleted, dryRun: cfg.dryRun }))
        .catch((e) => send(503, { ok: false, error: String(e.message) }));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/reserve/dispense")) {
      // optional bearer token
      if (cfg.authToken) {
        const got = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
        if (got !== cfg.authToken) return send(401, { error: "unauthorized" });
      }
      let raw = "";
      let tooBig = false;
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 8192) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (tooBig) return;
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return send(400, { error: "invalid JSON" });
        }
        if (body.asset && String(body.asset).toUpperCase() !== "BLOCK") {
          return send(400, { error: "this signer dispenses BLOCK only" });
        }
        // recipient: explicit `to`, else the configured seed destination for
        // the listing-liquidity-seed purpose.
        const to = body.to || (body.purpose === "listing-liquidity-seed" ? cfg.seedDestination : "");
        if (!to) {
          audit(cfg, { kind: "dispense", mode: "reject", reason: "no recipient", purpose: body.purpose });
          return send(400, { error: "no recipient: provide `to`, or configure seedDestination for listing-liquidity-seed" });
        }
        try {
          const r = await dispense(cfg, { to, amountBase: body.amountBase, purpose: body.purpose, meta: { intentId: body.intentId, market: body.market, symbol: body.symbol } });
          return send(200, r);
        } catch (e) {
          audit(cfg, { kind: "dispense", mode: "fail", purpose: body.purpose, to, amountBase: body.amountBase, error: String(e.message) });
          return send(500, { error: String(e.message) });
        }
      });
      return;
    }

    send(404, { error: "not found" });
  });
}

module.exports = { loadConfig, createServer, dispense, baseToBlock, BLOCK_ADDR, parseTxid };

if (require.main === module) {
  const cfg = loadConfig();
  createServer(cfg).listen(cfg.port, cfg.host, () => {
    const live = cfg.mainnetEnabled && cfg.legalReviewCompleted && !cfg.dryRun;
    // eslint-disable-next-line no-console
    console.log(
      `[reserve-signer] ${cfg.host}:${cfg.port} datadir=${cfg.reserveDatadir} ` +
        `mode=${live ? "LIVE(real dispense)" : "dry-run/gated"} dailyCap=${cfg.dailyCapBlock} BLOCK`,
    );
  });
}
