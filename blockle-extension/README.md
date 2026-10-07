# Blockle Wallet — browser extension

A stylish, password-locked wallet for **BLOCK** (the universal auxiliary chain),
built as a Manifest V3 browser extension with a complete **dApp connection**
system and an interactive particle logo.

## Features

- 🎆 **Interactive particle logo** — tiny blocks settle into a “B”, drift, scatter
  from the pointer, and burst on click/tap.
- 🛡️ **Post‑quantum keys (ML‑DSA‑44)** — real, consensus‑correct keys and
  `block1…` addresses, produced by a WASM build of `blockle-core` (the same code
  the chain uses). Generate, sign, and **send real transactions**.
- 🔒 **Password vault** — your key is encrypted with your password
  (PBKDF2‑SHA256 → AES‑256‑GCM) and never leaves the device. Auto‑locks after
  30 minutes.
- 📁 **Import / export wallet JSON** — export an encrypted `blockle-wallet.json`
  and restore it anywhere; a desktop `wallet.json` imports as watch‑only.
- 🔗 **Full dApp connections** — a real `window.blockle` provider with connect,
  accounts, balance, height, ML‑DSA message signing, and live events, gated by a
  per‑site approval flow.
- 💸 **Real send** — builds and ML‑DSA‑signs the transfer in WASM and broadcasts
  it through the node (UTXO fetch + submit).
- 📊 **Live chain data** — balance, height, and activity from the public BLOCK API.
- 🎨 Modern dark UI (receive, send, connected apps, settings).

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select this `blockle-extension/` folder.
4. Pin “Blockle Wallet” and open it.

> Preview without installing: open `popup.html` directly in a browser — the
> storage layer falls back to `localStorage`/`sessionStorage`, so onboarding,
> the vault, and the particle logo all work (live chain fetches are blocked by
> page CSP and degrade gracefully).

## Using it in a dApp

The extension injects `window.blockle` into every page:

```js
// connect (prompts the user to approve this site)
const [address] = await window.blockle.connect();

// read
const { balanceFmt } = await window.blockle.getBalance();
const height = await window.blockle.getHeight();

// sign a message (prompts the user to approve + unlock)
const sig = await window.blockle.signMessage('Sign in to my app');
// sig = { scheme, address, publicKey, signature }  — verify with WebCrypto

// events
window.blockle.on('accountsChanged', (accts) => { /* … */ });
window.blockle.on('disconnect', () => { /* … */ });

// generic
await window.blockle.request({ method: 'blockle_chainInfo' });
```

A working sample is in **`demo/dapp.html`** — open it in a tab with the
extension installed to connect, read balance, and sign + verify a message.

## Architecture

| file | role |
|---|---|
| `manifest.json` | MV3 manifest |
| `popup.html/.css/.js` | wallet UI + dApp approval views |
| `particles.js` | the interactive particle logo |
| `vault.js` | password → AES‑GCM encryption of the secret |
| `wallet.js` | keypair, `block1…` address, signing, JSON import/export, session |
| `bech32.js` | address encoding |
| `chain.js` | read‑only chain API client |
| `storage.js` | `chrome.storage` ⇄ `localStorage`/`sessionStorage` shim |
| `inpage.js` | injected `window.blockle` provider |
| `content.js` | page ⇄ background bridge |
| `background.js` | engine: permissions, approval routing, events |
| `demo/dapp.html` | sample dApp |

### dApp request flow

```
page  window.blockle.connect()
  → inpage.js  (postMessage)
  → content.js (chrome.runtime)
  → background.js  → opens an approval window (popup.html?view=approve)
                   → user approves → stores the site, returns [address]
  → content.js → inpage.js → page
background also broadcasts accountsChanged / connect / disconnect to the site's tabs.
```

## Security notes

- The private key is stored **only** inside the password‑sealed vault; the
  unlocked session lives in ephemeral `storage.session` and clears on browser
  close or after 30 minutes.
- Connecting a site shares your **address** and lets it **request** signatures
  — every signature is a separate approval. A site can never move funds.
- Keys are post‑quantum **ML‑DSA‑44** (FIPS 204) via `blockle-wasm` (built from
  `blockle-core`), so addresses, signatures, and transactions are identical to
  what the chain produces. Signatures are ~2.4 KB and can't be verified with
  browser WebCrypto — verify them on‑chain or with the WASM verifier.

### Build the WASM module

```
cd ../blockle-wasm
wasm-pack build --target no-modules --release
cp pkg/blockle_wasm.js pkg/blockle_wasm_bg.wasm ../blockle-extension/
```

(The prebuilt `blockle_wasm.js` + `blockle_wasm_bg.wasm` are already included.)

v0.1.0
