# BLOCK ↔ wBLOCK bridge — environment & config reference

**Secrets rule:** non-secret settings come from env vars or a non-secret config file. **Secrets
(private keys, mint authority, auth tokens) are never in source, config, or any committed file** —
they come from an env var injected at runtime or a secret manager / the loopback signer. Every
example value below is a **placeholder**. Following the repo pattern (see
`services/settlement/src/config.ts` and `services/reserve-signer/index.js`), precedence is
**env var → config file → built-in default**, and money switches default to OFF / dry-run.

---

## 1. Bridge service

| Variable | Secret? | Default | Meaning |
|---|---|---|---|
| `BRIDGE_PORT` | no | `8796` | HTTP bind port (loopback). |
| `BRIDGE_HOST` | no | `127.0.0.1` | Bind address. Keep loopback; never `0.0.0.0`. |
| `BRIDGE_CONFIG` | no | `/etc/blockle-bridge/config.json` | Path to the non-secret config file. |
| `BRIDGE_NODE_URL` | no | `http://127.0.0.1:8445` | BLOCK node aux-http base (reads `/explorer/*`). |
| `BRIDGE_DEPOSIT_ADDR` | no | *(empty)* | BLOCK `block1…` deposit address users send to. Public, not a secret. |
| `BRIDGE_CONFIRMATION_DEPTH` | no | `100` | Confirmations required before mint (reorg safety). |
| `BRIDGE_STORE_PATH` | no | `/var/lib/blockle-bridge/store` | Durable store dir (atomic file store + write queue). |
| `BRIDGE_MAINNET_ENABLED` | no | `false` | Master switch for real mainnet operation. |
| `BRIDGE_LEGAL_REVIEW_COMPLETED` | no | `false` | Gates mainnet; only true after sign-off is recorded. |
| `BRIDGE_DRY_RUN` | no | `true` | When true, records intent and performs no real mint/release. |
| `BRIDGE_FEE_BPS` | no | `0` | Bridge fee in basis points (0 = no fee). See `FEES.md`. |
| `BRIDGE_FEE_MIN_BASE` | no | `0` | Fixed minimum fee in base units. |
| `BRIDGE_RECOVER_NETWORK_FEE` | no | `false` | Deduct actual on-chain network fees from the amount. |
| `BRIDGE_TREASURY_BPS` | no | `0` | Portion of fee routed to the treasury bucket. |
| `BRIDGE_DAILY_CAP_BLOCK` | no | `1000` | Rolling 24h cap on BLOCK released via redemptions (blast radius). |

Real mint/release happens only when
`BRIDGE_MAINNET_ENABLED && BRIDGE_LEGAL_REVIEW_COMPLETED && !BRIDGE_DRY_RUN`.

---

## 2. Relayer

| Variable | Secret? | Default | Meaning |
|---|---|---|---|
| `RELAYER_POLL_MS` | no | `15000` | Poll interval for inbound BLOCK + Solana burns. |
| `RELAYER_SOLANA_RPC` | no | `https://api.devnet.solana.com` | Solana RPC URL (devnet default; testnet-first). |
| `RELAYER_SOLANA_CLUSTER` | no | `devnet` | `localnet` \| `devnet` \| `mainnet-beta`. |
| `RELAYER_wBLOCK_MINT` | no | *(empty)* | wBLOCK SPL mint address (public). |
| `RELAYER_MINT_AUTHORITY` | **yes** | *(unset)* | **Mint-authority secret** — inject via env/secret manager ONLY, never a file. Prefer a signing service over a raw key. |
| `RELAYER_RESERVE_SIGNER_URL` | no | `http://127.0.0.1:8795` | Loopback reserve-signer base URL. |
| `RELAYER_RESERVE_AUTH_TOKEN` | **yes** | *(unset)* | Optional bearer token for the signer (defense-in-depth). |
| `RELAYER_CONFIRMATION_DEPTH` | no | `100` | Overrides bridge depth for the relayer if needed. |
| `RELAYER_BURN_MIN_CONFIRMATIONS` | no | `32` | Solana commitment/confirmations before honoring a burn. |

The relayer calls the reserve-signer; it **never holds the reserve BLOCK key**. The mint authority
is the only key material the relayer may touch, and only via injected secret, never from disk in
the repo.

---

## 3. Reserve-signer (BLOCK release — existing service)

These already exist (`services/reserve-signer`); the bridge reuses them unchanged. Secrets note:
**the reserve key lives in the node wallet datadir, never in this service or its config.**

| Variable | Secret? | Default | Meaning |
|---|---|---|---|
| `RESERVE_SIGNER_PORT` | no | `8795` | Loopback port. Never proxied publicly. |
| `RESERVE_SIGNER_CONFIG` | no | `./config.json` | Config path. |
| `RESERVE_CHAIN_BIN` | no | `/opt/blockle/chain/target/release/blockle-chain` | Chain CLI used to send. |
| `RESERVE_DATADIR` | no | `/var/lib/blockle-mainnet` | Node wallet datadir holding the reserve key. |
| `RESERVE_NODE_ADDR` | no | `127.0.0.1:18444` | Node address to submit via. |
| `RESERVE_NETWORK` | no | `mainnet` | Network name. |
| `RESERVE_MAINNET_ENABLED` | no | `false` | Gate: no real send unless true. |
| `RESERVE_LEGAL_REVIEW_COMPLETED` | no | `false` | Gate: no real send unless true. |
| `RESERVE_DRY_RUN` | no | `true` | When true, records intent, sends nothing. |
| `RESERVE_DAILY_CAP_BLOCK` | no | `1000` | Hard daily BLOCK dispense cap. |
| `RESERVE_MAX_AMOUNT_BLOCK` | no | `200` | Per-dispense BLOCK cap. |
| `RESERVE_AUTH_TOKEN` | **yes** | *(unset)* | Optional shared bearer token (env, not committed). |
| `RESERVE_AUDIT_LOG` | no | `/var/lib/blockle-reserve-signer/audit.jsonl` | Append-only audit log. |
| `RESERVE_LEDGER` | no | `/var/lib/blockle-reserve-signer/dispensed.jsonl` | Dispense ledger for the daily cap. |

---

## 4. Solana tooling (SPL mint creation / devnet rehearsal)

| Variable | Secret? | Default | Meaning |
|---|---|---|---|
| `SOLANA_CLUSTER` | no | `devnet` | Target cluster (testnet-first). |
| `SOLANA_RPC_URL` | no | per-cluster default | Override RPC endpoint. |
| `ANCHOR_WALLET` | **yes** | *(unset)* | Path to the deployer/authority keypair. **Never in the repo**; a local path outside version control, injected at run time. |
| `wBLOCK_DECIMALS` | no | `8` | Must stay 8 to match BLOCK base units. |
| `SOLANA_DEPLOY_ENABLED` | no | `false` | Gate: tooling refuses to touch a real cluster unless explicitly true AND human-authorized. |

---

## 5. Example config file (non-secret, placeholders only)

Copy to `BRIDGE_CONFIG` and fill the public values. **Do not put any key here.**
```jsonc
{
  "_note": "Non-secret bridge config. LOOPBACK ONLY. Secrets (mint authority, reserve key, auth tokens) come from env/secret-manager, never this file. Real mint/release needs mainnetEnabled && legalReviewCompleted && dryRun:false.",
  "host": "127.0.0.1",
  "port": 8796,
  "nodeUrl": "http://127.0.0.1:8445",
  "depositAddr": "block1theBridgeDepositAddressUsersSendBLOCKto",
  "confirmationDepth": 100,
  "storePath": "/var/lib/blockle-bridge/store",
  "mainnetEnabled": false,
  "legalReviewCompleted": false,
  "dryRun": true,
  "fee": { "bps": 0, "minBase": 0, "recoverNetworkFee": false, "treasuryBps": 0 },
  "dailyCapBlock": 1000,
  "solana": {
    "cluster": "devnet",
    "rpc": "https://api.devnet.solana.com",
    "solblockMint": "",
    "mintAuthorityRef": "secret://bridge/mint-authority"
  },
  "reserveSigner": { "url": "http://127.0.0.1:8795" }
}
```
