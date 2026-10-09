# Blockle Exchange — frontend (`exchange/web/`)

Static, dependency-free HTML/CSS/JS for the **non-custodial** Blockle super-exchange.
No build step, no framework, no bundler. The relay (a sibling deliverable that
implements the SHARED EXCHANGE API CONTRACT) serves these files and answers the
API/WebSocket calls on the same origin.

## Non-custodial, by design

- **You sign every move with your own wallet.** The site never holds funds or keys.
- Connect **MetaMask** (`window.ethereum`, EVM/ETH/Base), **Phantom** (`window.solana`, Solana), or the **Blockle extension** (`window.blockle`, BLOCK).
- Sign-in = signing the relay's nonce (EVM `personal_sign`, Solana ed25519, BLOCK ML-DSA via the extension). No passwords, no custody.
- Trades settle as **atomic HTLC swaps** you execute yourself: you lock → counterparty locks → you reveal/claim → done, with refund after the timelock. The relay only coordinates the hashlock and order book.
- **0.1% protocol fee** is shown on the order ticket.
- **Testnet/demo by default.** A prominent banner says so. Real money paths are gated server-side by the relay's `mainnet_enabled` flag. **The operator must obtain legal/compliance sign-off before enabling mainnet.**

## Fastest path (people)

1. Open `/` → click a wallet button to connect + sign in.
2. Pick a market, type an amount (and a limit price), click **Sign & place order**.
3. Watch the fill appear under **My swaps** and click **Continue swap** to drive each HTLC step — your wallet prompts for each on-chain signature.

Listing an asset: open `/list.html`, type a symbol + contract address, see the live price (**$5 + $1 per extra pair**, BLOCK pair pre-checked and locked), click **Pay & list**. Your wallet sends the fee to the treasury; the relay verifies it and flips the markets live.

> Agents do all of the above programmatically via the SDK (`listAsset`, `placeOrder`, `swap`) and the MCP tools — both settle fees over x402 by default. This frontend is the human-facing client of the exact same relay contract.

## Files

| File | Purpose |
|------|---------|
| `index.html` + `trade.js` | Trading view: market selector, live book + trades (WS), signed limit/market orders, cancel, my orders, my-swaps HTLC stepper. |
| `list.html` + `list.js` | Self-serve listing: one form, live quote, mandatory locked BLOCK pair, non-custodial fee payment. |
| `core.js` | Shared runtime: config, wallet providers + signing, HTTP client for the contract, WebSocket stream, base-unit math, canonical JSON signing (matches the SDK), toast + wallet bar. `window.EX`. |
| `styles.css` | On-brand dark violet/teal theme (mirrors `web/dex.html`). |
| `config.js` | Public runtime config only — `apiBase` / `wsBase`. **No secrets.** Default: same origin. |

## Contract endpoints used (all relative to `apiBase`)

`POST /auth/nonce` · `POST /auth/verify` · `GET /markets` · `GET /book/{market}` ·
`GET /trades/{market}` · `POST /orders` · `DELETE /orders/{id}` · `GET /orders/mine` ·
`GET /swaps/mine` · `POST /swaps/{id}/step` · `POST /listings/quote` · `POST /listings` ·
`GET /listings` · `WS /stream?markets=…`

## Conventions

- **Amounts are base units on the wire** (strings); converted to human units only at display edges (`EX.toHuman` / `EX.toBase`).
- Order intents are signed over **canonical JSON** (sorted keys, no whitespace) — byte-identical to the SDK's `canonical()` so the relay verifies one scheme for both humans and agents.
- `config.js` holds **public URLs only**. Keys never touch this code.

## Local dev

Serve the directory with any static server and point `config.js` at your relay:

```js
window.EXCHANGE_CONFIG = { apiBase: 'http://127.0.0.1:8900', wsBase: '' };
```

```sh
cd exchange/web && python3 -m http.server 8080
# open http://127.0.0.1:8080
```

In production (`https://exchange.blockle.org`) the relay serves these files, so
`apiBase` stays `''` (same origin).
