# Blockle Web Wallet — spec

`blockle.org/wallet` — a **non-custodial**, installable (PWA) web wallet that brings the
full Blockle extension/desktop/mobile feature set to a browser tab, including the agent
+ bots layer, and makes **Pro** meaningfully useful.

Status: first build. This document is the contract; the implementation lives in
`web/wallet/` (SPA) + `web/copilot.html` (Pro landing) + routing in `src/biz.rs`.

## 1. Non-custodial guarantee (the whole point)

The server never sees a private key or seed. Concretely:

- **Keys are generated and held in the browser.** Native BLOCK identity is an ML-DSA-44
  (FIPS-204, post-quantum) keypair generated in WASM; EVM/BTC/LTC/DOGE/Solana derive from
  a single random 256-bit HD seed (secp256k1 + SLIP-0010 ed25519). This is the exact key
  model of the extension — the web wallet imports the same modules (`wallet.js`, `hd.js`,
  `signer.js` + `blockle_wasm`).
- **At rest, only a sealed vault blob is persisted** (`vault.js`: scrypt N=16384 → AES-256-GCM,
  all WebCrypto). It lives in `localStorage` (the `Store` shim's web fallback). The
  plaintext `{secret, seed}` exist only in an **in-memory** session while unlocked and are
  wiped on `Wallet.lock()`, on a 30-minute idle auto-lock, and — because the web `Session`
  is in-memory only — on any full page reload. Reload ⇒ re-unlock. Nothing secret ever
  touches `localStorage`/`IndexedDB`/`sessionStorage` or the network.
- **Signing happens in the page**; only the signed artifact is broadcast (`POST /api/submit`
  for BLOCK, chain RPCs for the rest). The backend is a relay.

### Code integrity (the web-specific hard part)
Because blockle.org serves the wallet's code, "non-custodial" only holds if that code can't
be silently swapped for key-stealing JS. Mitigations in this build:

1. **Installable PWA with a pinned service worker** (`web/wallet/sw.js`): the app shell and
   every vendored crypto module are precached on install and served cache-first with a
   version stamp, so an installed wallet runs pinned code, not a fresh download per visit.
   Updates are explicit (new SW version → "Update available" prompt).
2. **Integrity manifest**: `sw.js` carries the expected list + a build stamp; a mismatch
   surfaces a visible warning rather than running unknown code.
3. **No third-party script origins** in the wallet document (everything is same-origin under
   `/wallet/`), so there is no CDN to compromise.

### Threat model (honest)
- **In scope / mitigated:** passive server, stale CDN, casual XSS of other site pages
  (wallet is same-origin-isolated under `/wallet/` with its own SW), device theft (vault is
  scrypt-sealed; auto-lock), reload leakage (session is memory-only).
- **Residual / not solved by any wallet:** an *active* compromise of blockle.org that ships
  a malicious SW update the user accepts; targeted phishing of a look-alike domain;
  malware on the user's device with JS-injection. For those, the wallet **delegates
  high-value signing to the extension when present** (see §3) and recommends the extension/
  desktop app for large balances. The web wallet is positioned as the convenient hot wallet,
  not the cold store — stated plainly in the UI.

### Optional hardening (passkey)
If the browser supports WebAuthn, the user may **require a passkey to unlock** — a presence
check gating access to the sealed blob before the password KDF runs. (PRF-based key
*wrapping*, where the passkey derives part of the vault key, is the documented next step;
this build ships the presence-gate + password-sealed vault.)

## 2. Feature parity with the other wallets

Every module is the extension's own, imported verbatim (they are UMD globals, pure JS /
WebCrypto). The SPA supplies a web UI + an in-page `ctx` via `global.Wiring`.

- **Multichain accounts**: BLOCK + 7 EVM chains + BTC/LTC/DOGE + Solana (`chains/registry.js`).
- **Assets**: auto-detected tokens (`Wiring.getHoldings`, curated WORLD/USDB + import) and
  NFTs (`nft-indexer.js`: BLOCK-721 via node, EVM via Alchemy, Solana via Helius), with
  bundled logos.
- **Send / Receive**, **Portfolio** (`portfolio.js`), **Activity** (`activity.js`),
  **Address book + ENS/SNS** (`addressbook.js`).
- **Swap / DEX**: native constant-product AMM (`Wiring.amm`) + the hybrid order-book /
  super-exchange relay (`exchange-client.js`), fee-aware routing (`venues.js`).
- **Bridge**: BLOCK↔wBLOCK Solana via `/api/bridge/*`.
- **USDB**: one-click buy/redeem via `/api/usdb/*` (quote → buy → on-chain `redeem()` signed
  in-page).
- **Launch**: BLOCK-20 token + BLOCK-721 NFT deploy+init (`Wiring.launchToken`, Signer builders).
- **WalletConnect v2**: `walletconnect.js` + `wc-relay.js` (pair, approve, sign) — same
  allowlist/gate as the extension.
- **Security suite**: every value-moving action runs through `SecurityGate.gate({action, ctx,
  confirm})` — tx decode + scam/danger warnings + a mandatory confirm sheet. This is the
  single non-bypassable approval path, shared with the agent.
- **Backup/restore**: encrypt-locally cloud backup (`backup-crypto.js`/`backup-client.js`),
  plus file export/import and seed/key export (`wallet-export.js`).

## 3. The agent + bots

Ported from `agent/*` (all UMD, browser-ready) — no new backend:

- **Conversational command bar** (`agent/command.js`): NL → the model proposes tool-calls
  from `agent/tools.js`; every value-moving call is dispatched through the one gate. Query
  mode is read-only (net-worth / bots-pnl engine tools only).
- **Bots** (`agent/bots.js` + `bot-runner.js`): DCA / grid / smarttrade / signal / scanner,
  **paper by default**, `allocationUsd` hard cap, "fully-auto within allocation" via the
  shared gate, kill-all. Export/import templates.
- **Arena** (`agent/arena.js`): play-money sandbox, XP/levels/missions, isolated from the gate.
- **Brain**: the keyless hosted gateway `agent.blockle.org` (`agent/providers.js`
  `hostedSession` — sign a challenge with the BLOCK key, get a 900s session token; the page
  holds no LLM key). BYO Claude/OpenAI keys also supported (stored in the vault).
- **Trades**: the non-custodial `exchange.blockle.org` relay; orders signed in-page.
- **Delegation**: when `window.blockle` (the extension) is present, the wallet can route
  signing to it for high-value actions; otherwise it self-custodies.

## 4. Pro — and making it worth buying

Entitlement is the accounts service's `user.sub` read from `GET /account/api/me`
(`credentials:'include'`; SSO cookie `blk_sess` on `.blockle.org` means a user signed into
the portal is already signed into the wallet). `tier = sub.active ? (sub.tier||'free') :
'free'`; tiers `free → pro/copilot → copilot_pro`. No client-trusted claim — the server
re-checks.

Today only the agent engine gates on tier (paper-only + 1 bot on free; live + 3 on paid;
unlimited on copilot_pro) and **nothing else does**, and the `/copilot` upsell page the CTAs
point at **does not exist**. This build changes that:

- **Builds the missing `/copilot` landing + checkout page** (`web/copilot.html`): the three
  plans from `GET /account/api/plans`, a clear feature matrix, and `POST
  /account/api/subscribe` → PayPal `approveUrl` redirect. Resolves every existing upsell link
  across the extension/Flutter.
- **Surfaces tier in the wallet** (plan badge) and gates a concrete, visible set of web-wallet
  perks, each with an inline upgrade CTA rather than a dead end:
  - **Live trading bots & agent count** (the real existing gate) — free = paper + 1; Pro = live
    + 3; Copilot Pro = unlimited.
  - **Higher hosted-agent quota** for the command bar (free = anon rate-limited; Pro = signed
    session, larger budget) — the planned `docs/ACCOUNTS.md` quota, now wired client-side.
  - **Pro bot templates**: a curated strategy library (the `docs/ACCOUNTS.md` "pro bot
    templates") exposed in the bots tab, paper-previewable by all, live-deployable by Pro.
  - **Portfolio analytics**: advanced P&L / allocation views for Pro (free sees the summary).
  - **Priority features**: price alerts, CSV export, more WalletConnect sessions, custom RPC.
- **Fail-closed**: unknown/expired tier ⇒ `free`; gates re-checked at arm-time, mirroring
  `agent/channels.js`.

## 5. Routing & serving (`src/biz.rs`)

- Reclaim `/wallet` (currently the downloads page) → serve the SPA shell `wallet.html`; move
  downloads into a tab of the wallet (and keep `/download`).
- New prefix handler `p.starts_with("/wallet")`: serve static assets from
  `/opt/blockle/web/wallet/<path>` with MIME-by-extension (the file's first generic static
  handler), reject `..`, and fall back to the SPA shell for unknown sub-paths (client router).
- `<base href="/wallet/">` in the shell so relative asset + WASM URLs resolve under the SPA.
- Serve the pinned SW at `/wallet/sw.js` (scope `/wallet/`, since `respond()` can't emit
  `Service-Worker-Allowed`) and the manifest at `/wallet/manifest.webmanifest`.
- `/copilot` (+ `?plan=`) → `web/copilot.html`.
- All data stays same-origin: `/api/*` fans out via nginx (biz/bridge/usdb/accounts).

## 6. Deploy

`web/` → `/opt/blockle/web/` on the VPS; rebuild `blockle-biz` for the new routes; reload.
Keep secrets box-only. No new nginx backend needed (SPA is served by biz; `/account/*`,
`/api/bridge/*`, `/api/usdb/*` already proxied).
