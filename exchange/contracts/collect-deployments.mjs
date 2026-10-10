#!/usr/bin/env node
// Collect the per-leg deploy outputs into the ONE block the relay consumes:
// exchange/server/config.json -> "htlc". This closes the only manual step
// between a successful deploy and a wired relay.
//
// It reads each leg's deploy artifact (written by that leg's deploy script):
//   evm    -> evm/deployments.json         (keyed by network;  .address)
//   solana -> solana/deployments/*.json     (keyed by cluster;  .programId)
//   sui    -> sui/deployments.json          (keyed by env;      .packageId)
//   block  -> env BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT (hex id from the CLI)
//   btc    -> env BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA / _BTC_HOTWALLET
// and prints a ready-to-paste `htlc` config block. Nothing secret is read.
//
// Usage:
//   node exchange/contracts/collect-deployments.mjs            # print the htlc block
//   node exchange/contracts/collect-deployments.mjs --write    # merge into ../server/config.json
//
// Keys stay where the deploy scripts put them; this only moves PUBLIC ids.
// It NEVER enables mainnet and NEVER touches mainnetEnabled / legalReview.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

// --- EVM: deployments.json keyed by network name, each has .address --------
function collectEvm() {
  const d = readJson(path.join(HERE, "evm", "deployments.json")) || {};
  const out = {};
  for (const [net, rec] of Object.entries(d)) {
    if (rec && typeof rec === "object" && rec.address) out[net] = rec.address;
  }
  return out;
}

// --- Solana: deployments/<cluster>.json, each has .programId ----------------
// The relay key is `devnet` or `mainnet` (localnet/devnet both map to devnet;
// see solana/deploy.config.json -> relayKey).
function collectSolana() {
  const dir = path.join(HERE, "solana", "deployments");
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "README.md"); } catch { /* none */ }
  for (const f of files) {
    const rec = readJson(path.join(dir, f));
    if (!rec || !rec.programId) continue;
    const cluster = rec.cluster || path.basename(f, ".json");
    const relayKey = cluster === "mainnet-beta" || cluster === "mainnet" ? "mainnet" : "devnet";
    out[relayKey] = rec.programId;
  }
  return out;
}

// --- Sui: deployments.json keyed by env, each has .packageId ----------------
function collectSui() {
  const d = readJson(path.join(HERE, "sui", "deployments.json")) || {};
  const out = {};
  for (const [env, rec] of Object.entries(d)) {
    if (rec && typeof rec === "object" && rec.packageId) out[env] = rec.packageId;
  }
  return out;
}

// --- BLOCK + BTC: no committed artifact; take the public ids from env -------
function collectBlock() {
  const id = process.env.BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT || "";
  return id ? { contractId: id } : {};
}
function collectBtc() {
  const esplora = process.env.BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA || "";
  const hot = process.env.BLOCKLE_EXCHANGE_HTLC_BTC_HOTWALLET || "";
  const btc = {};
  if (hot) btc.hotWallet = hot;
  if (esplora) btc.esploraUrl = esplora;
  return btc;
}

const htlc = {
  evm: collectEvm(),
  solana: collectSolana(),
  sui: collectSui(),
  btc: collectBtc(),
  block: collectBlock(),
};

const found =
  Object.keys(htlc.evm).length +
  Object.keys(htlc.solana).length +
  Object.keys(htlc.sui).length +
  (htlc.block.contractId ? 1 : 0) +
  (htlc.btc.esploraUrl ? 1 : 0);

if (process.argv.includes("--write")) {
  const cfgPath = path.join(HERE, "..", "server", "config.json");
  const cfg = readJson(cfgPath) || {};
  const prev = cfg.htlc || {};
  cfg.htlc = {
    ...prev,
    evm: { ...(prev.evm || {}), ...htlc.evm },
    solana: { ...(prev.solana || {}), ...htlc.solana },
    sui: { ...(prev.sui || {}), ...htlc.sui },
    btc: { ...(prev.btc || {}), ...htlc.btc },
    block: { ...(prev.block || {}), ...htlc.block },
  };
  // Never touch the mainnet gate from here.
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  console.error(`Merged ${found} deployed id(s) into ${path.relative(path.join(HERE, "..", ".."), cfgPath)} (htlc.*). mainnetEnabled left untouched.`);
} else {
  process.stdout.write(JSON.stringify({ htlc }, null, 2) + "\n");
  console.error(
    found
      ? `\nFound ${found} deployed id(s). Paste the "htlc" block into exchange/server/config.json, or re-run with --write.`
      : `\nNo deploy artifacts found yet. Run each leg's deploy script first (see DEPLOY.md), then re-run.`,
  );
}
