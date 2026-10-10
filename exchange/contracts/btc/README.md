# BTC leg — native Bitcoin Script HTLC

Hash-timelocked contract for **native BTC**, implemented as a raw Bitcoin
Script and wrapped in **P2WSH** (native SegWit v0). This is the classic
cross-chain atomic-swap leg: the output can only be spent by the receiver (with
the preimage) or refunded to the depositor (after a `OP_CHECKLOCKTIMEVERIFY`
timelock). There is no contract account, no custodian — the swap lives entirely
in the output's spending conditions.

See [`../PROTOCOL.md`](../PROTOCOL.md) for the full swap state machine, timelock
`T2 < T1` rule, and where the 0.1% settlement fee is taken.

## Hash reconciliation (IMPORTANT)

The shared protocol hashlock is **`H = sha256(preimage)`** (same as the EVM and
Solana legs — PROTOCOL.md §4). This leg therefore uses the Script opcode
**`OP_SHA256`**, *not* the more common `OP_HASH160`.

> `OP_HASH160` computes `ripemd160(sha256(x))`, a **different** hashlock. Using
> it here would make the BTC leg's `H` incompatible with the other legs and
> break the single-secret safety argument. We deliberately use `OP_SHA256` so
> the on-chain hashlock is byte-identical to `H = sha256(s)` everywhere.

Result: **BTC ⇄ EVM**, **BTC ⇄ Solana**, and (via a BTC-side `sha256` lock)
**BTC ⇄ BLOCK** when BLOCK gains its `SHA256` opcode (PROTOCOL.md §4) all share
one hashlock. BTC ⇄ anything-on-sha256 is safe today.

## The witness script

```
OP_SHA256 <H> OP_EQUAL
OP_IF
    <receiverPubKey>
OP_ELSE
    <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
    <refundPubKey>
OP_ENDIF
OP_CHECKSIG
```

- `H` = 32-byte `sha256(preimage)`.
- `receiverPubKey` / `refundPubKey` = 33-byte compressed pubkeys.
- `locktime` = CLTV value. **Unix time** (`>= 500000000`) to pair with the
  timestamp-based EVM/Solana legs, or a **block height** (`< 500000000`).

`OP_SHA256 … OP_EQUAL` pushes TRUE/FALSE, which `OP_IF` consumes to pick the
branch; a single trailing `OP_CHECKSIG` serves both. This keeps the script
small and the two spend witnesses symmetric.

### Spend witnesses (P2WSH)

| Path | Who | When | Witness stack (bottom → top) |
|------|-----|------|------------------------------|
| **redeem** | receiver | any time, needs preimage | `[ <sig> , <preimage> , <witnessScript> ]` |
| **refund** | depositor | `nLockTime ≥ locktime` | `[ <sig> , <empty> , <witnessScript> ]` |

The empty element on the refund path makes `OP_EQUAL` push FALSE → the `OP_ELSE`
branch runs, which gates on `OP_CHECKLOCKTIMEVERIFY`. The refund spend sets the
transaction's `nLockTime = locktime` and uses a non-final `nSequence`
(`0xfffffffe`) so CLTV is enforced.

### Addresses

- Each swap produces a fresh **P2WSH address** from `sha256(witnessScript)`:
  - testnet3 / signet → `tb1q…`
  - regtest → `bcrt1q…`
  - mainnet → `bc1q…` (gated)
- The protocol-fee output on redeem pays the configured treasury address
  (`config.json` → `networks.<net>.treasuryFeeAddress`; mainnet is
  `bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm`, shared with `treasury.json`).

## Layout

- `src/htlc.js` — script builder + PSBT builders:
  - `hashlock(preimage)` → `sha256(preimage)`
  - `buildHtlc({ hash, receiverPubkey, refundPubkey, locktime }, network)` →
    `{ witnessScript, address, output, … }`
  - `buildLockPsbt(…)` — fund the P2WSH output
  - `buildRedeemPsbt(…)` — spend with preimage; takes the 0.1% fee (capped 1%)
  - `buildRefundPsbt(…)` — spend after the timelock; **no fee**
  - `finalizeRedeem(psbt, i, preimage)` / `finalizeRefund(psbt, i)` — inject the
    correct witness stack for each branch
- `test/htlc.test.js` — script-template vector, deterministic P2WSH address,
  network prefixes, full lock→redeem and lock→refund lifecycles with **real
  SegWit-v0 sighash signature verification**, fee split, and negative cases.
- `config.json` — `feeBps` (10 = 0.1%), `maxFeeBps` (100 = 1%), per-network
  treasury fee address + Esplora endpoint, timelock defaults, mainnet gate.

## Build & test

```bash
cd exchange/contracts/btc
npm install
npm test        # node --test → 12 passing
```

Pure-JS — no Bitcoin node required to build scripts, derive addresses, or
construct/sign/finalize the lock, redeem, and refund PSBTs. Tests verify each
spend's ECDSA signature against the actual `hashForWitnessV0` sighash for its
branch, so a produced transaction is cryptographically valid, not just
well-shaped.

## What builds vs. what needs an external testnet

| Capability | Status |
|------------|--------|
| HTLC witness-script construction (`OP_SHA256` hashlock + CLTV refund) | ✅ builds + tested |
| P2WSH address derivation (testnet/signet/regtest/mainnet) | ✅ builds + tested |
| Lock / redeem / refund PSBT construction | ✅ builds + tested |
| Signing + custom branch finalizers + tx extraction | ✅ builds + tested |
| Signature validity vs. real SegWit-v0 sighash | ✅ verified in tests |
| **Broadcasting** a real testnet/signet tx | ⚠️ **needs an external node/wallet** — out of scope here |
| **UTXO discovery / fee estimation** from live chain | ⚠️ needs an Esplora/Core RPC endpoint (`config.json` has the URLs) |

Broadcast + UTXO selection require a funded testnet wallet and a node/Esplora
connection. That thin, node-dependent shell step between a finalized PSBT and a
live spend is now wired in **`src/esplora.js`** (dependency-free, Node 18+
global `fetch`) — documented below, not faked.

## Live spend wiring: funded hot wallet + Esplora (`src/esplora.js`)

The pure builder (`src/htlc.js`) has no network I/O. `src/esplora.js` supplies
the two chain interactions a real swap needs, against the per-network endpoint
in `config.json → networks.<net>.esplora`:

```js
const htlc = require('./src/htlc');
const esplora = require('./src/esplora');

const NET  = 'signet';                       // testnet3 | signet | regtest | mainnet(gated)
const base = esplora.esploraFor(NET);        // -> config.json networks.signet.esplora

// ---- 1. LOCK: fund the P2WSH HTLC from the funded hot wallet ----------------
// UTXO discovery for the depositor's own address (the funded hot wallet). The
// hot-wallet KEY lives in the operator's signer, NEVER in this repo.
const hot = 'tb1q...hotwallet';
const inputs = await esplora.fetchUtxos(base, hot);      // ready buildLockPsbt inputs[]
const feeRate = await esplora.fetchFeeRate(base, 3);     // sat/vB
const h = htlc.buildHtlc({ hash, receiverPubkey, refundPubkey, locktime }, NET);
const lockPsbt = htlc.buildLockPsbt({ htlc: h, amount, inputs, changeAddress: hot, fee });
// ...operator's signer signs + finalizes lockPsbt (standard P2WPKH inputs)...
const lockTxid = await esplora.broadcast(base, lockPsbt.extractTransaction().toHex());
await esplora.waitForConfirmations(base, lockTxid, 2);

// ---- 2. REDEEM: receiver spends with the preimage ---------------------------
const utxo = await esplora.fetchHtlcUtxo(base, h.address);   // { txid, index, value }
const redeem = htlc.buildRedeemPsbt({ htlc: h, utxo, receiverAddress, minerFee,
                                      feeBps: 10, feeAddress });
// ...receiver signs input 0...
htlc.finalizeRedeem(redeem, 0, preimage);
const redeemTxid = await esplora.broadcast(base, redeem.extractTransaction().toHex());

// ---- 3. REFUND: depositor reclaims after the CLTV timelock ------------------
const refund = htlc.buildRefundPsbt({ htlc: h, utxo, refundAddress: hot, minerFee });
// ...depositor signs input 0...
htlc.finalizeRefund(refund, 0);
await esplora.broadcast(base, refund.extractTransaction().toHex());   // no fee on refund
```

### What `src/esplora.js` provides

| Function | Esplora endpoint | Purpose |
|----------|------------------|---------|
| `esploraFor(net)` | — | base URL from `config.json`; refuses `mainnet` unless `mainnet_enabled=true` |
| `fetchUtxos(base, addr)` | `GET /address/:a/utxo` + `GET /tx/:id` | spendable UTXOs mapped to `buildLockPsbt` inputs (with `witnessUtxo`) |
| `fetchHtlcUtxo(base, htlcAddr)` | `GET /address/:a/utxo` | the funded HTLC output as the `utxo` arg for redeem/refund |
| `fetchFeeRate(base, tgt)` | `GET /fee-estimates` | sat/vB estimate |
| `broadcast(base, rawTxHex)` | `POST /tx` | relay a finalized raw tx; returns the txid |
| `confirmations` / `waitForConfirmations` | `GET /tx/:id/status`, `/blocks/tip/height` | confirmation depth / polling |

### The funded BTC hot wallet (what a human must do)

- **Fund it.** Create a bech32 P2WPKH wallet on the target network and fund it
  from a faucet (signet: <https://signet.bc-2.jp/> or
  `bitcoin-cli -signet getnewaddress` + mining; testnet3:
  <https://bitcoinfaucet.uo1.net/> / <https://coinfaucet.eu/en/btc-testnet/>).
- **Record its address** as `htlc.btc.hotWallet` in the relay's `config.json`
  (or env `BLOCKLE_EXCHANGE_HTLC_BTC_HOTWALLET`). The relay only ever reads the
  ADDRESS — the private key stays in the operator's own signer.
- **Point `htlc.btc.esploraUrl`** (relay config, or `BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA`)
  at the same Esplora this package uses. Default testnet:
  `https://blockstream.info/testnet/api`. For a self-hosted node run
  `electrs`/`esplora` and use its URL (regtest default `http://127.0.0.1:3002`).
- BTC is the one leg with **no deployed contract**: the relay's fail-closed
  check for a BTC leg requires `esploraUrl` to be set (without a broadcast
  endpoint the leg cannot settle); see `exchange/server/src/config.ts`.

## Testnet-first and mainnet gating

`config.json → mainnet_enabled` defaults to `false`. The mainnet network entry
exists only so the address format and treasury fee address are documented; any
caller enabling a mainnet money path must satisfy the same gate the other legs
use (recorded legal/compliance sign-off — PROTOCOL.md §7). Dev targets Bitcoin
**testnet3 / signet / regtest**.

## Non-custodial by construction

No private keys live in this package or anywhere in the repo. The builders take
only public keys, an address, a hashlock, and a timelock; signing is done by the
caller's own key through the standard PSBT interface. The relay can match and
broadcast but can never spend a locked output — only the receiver (with the
preimage) or the depositor (after the timelock) can.
