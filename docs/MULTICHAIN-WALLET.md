# Blockle Multi-Chain Wallet — Shared Architecture

**Status:** PASS 1 contract. This document is the single source of truth for the
multi-chain redesign of all three Blockle wallets. The browser **extension**
(`blockle-extension/`) is the **reference implementation**; the Flutter app
(`blockle-app/`) and the Qt wallet (`python/blockle/qtwallet.py`) are ported
from it in later passes and MUST satisfy the same interfaces and invariants.

The goal: each wallet holds **BLOCK + EVM assets (ETH/ERC-20 USDC/USDT) + BTC +
LTC + DOGE** in one vault, embeds the **non-custodial exchange**
(`exchange.blockle.org`, via `@blockle/agent-sdk`), and offers an optional
**in-wallet AI agent** that executes wallet/exchange actions from natural
language under hard safety rails.

---

## 0. Ground truth — read before implementing

These constraints are non-negotiable. They override convenience.

1. **BLOCK signing is `blockle-wasm` (ML-DSA-44). Never reimplement it.** Keys,
   addresses, signatures, and the bincode tx encoding are produced only by the
   wasm module (`blockle-extension/signer.js` → `blockle_wasm_bg.wasm`). Same as
   today.
2. **"Post-quantum" describes KEY STORAGE and the BLOCK chain only — not the
   other chains.** BTC/LTC/DOGE/EVM sign with **ECDSA / secp256k1**, which is
   *not* post-quantum. The UI and docs MUST say so honestly. Only BLOCK's
   on-chain signatures are PQ (ML-DSA-44). The *vault* that stores every key is
   hardened against offline attack, but that is a storage property, not a
   signature property — do not conflate them, and never claim BTC/LTC/DOGE/EVM
   are quantum-resistant.
3. **The exchange is LIVE and already implemented.** Reuse
   `https://exchange.blockle.org` through the `ExchangeClient` in
   `@blockle/agent-sdk` (`sdk/src/exchange.ts`). The wallet **embeds a client**;
   it does **not** reimplement order matching, the HTLC relay, or listings.
4. **Keys never leave the device.** No seed, secret key, LLM credential, or
   decrypted vault blob is ever sent to any Blockle server or any third party
   except as a signed transaction / signed message broadcast to the relevant
   public chain or the exchange relay (which only ever receives *signatures*,
   never keys).
5. **Keep everything building. Do not break existing wallet features.** The
   multi-chain layer is additive: BLOCK stays the default identity and the
   existing dApp provider (`blockle_*` RPC) keeps working unchanged.

---

## 1. Layered architecture

```
┌──────────────────────────────────────────────────────────────┐
│  UI  (popup.js / Flutter widgets / Qt views)                  │
├──────────────────────────────────────────────────────────────┤
│  AI Agent  (optional) — provider adapter + tool allowlist +   │
│            caps + confirmation + kill switch + audit log      │
├──────────────────────────────────────────────────────────────┤
│  Exchange  — embedded @blockle/agent-sdk ExchangeClient       │
│              (auth, book, orders, atomic-swap HTLC legs)      │
├──────────────────────────────────────────────────────────────┤
│  Chain registry  —  Map<ChainId, ChainAdapter>               │
│     BLOCK   EVM(+ERC20)   BTC   LTC   DOGE                     │
├──────────────────────────────────────────────────────────────┤
│  Accounts  — one HD seed + per-chain derived accounts         │
├──────────────────────────────────────────────────────────────┤
│  Vault  — KDF (argon2id/scrypt) + AEAD (AES-256-GCM)          │
├──────────────────────────────────────────────────────────────┤
│  Storage  — chrome.storage / SharedPreferences+Keystore / QSettings │
└──────────────────────────────────────────────────────────────┘
```

Each box is a module with a stable interface. Only the top two boxes and the
chain adapters change per client; the vault/accounts/chain-registry *contracts*
are identical across all three wallets.

Reference-implementation file map (extension, the files a later pass ports):

| Layer            | Today                         | PASS-1 target                                    |
|------------------|-------------------------------|--------------------------------------------------|
| Storage          | `storage.js` (`Store`,`Session`) | unchanged                                      |
| Vault            | `vault.js` (`Vault`)          | `vault.js` v2 (KDF upgrade, versioned)           |
| Accounts         | `wallet.js` (`Wallet`)        | `wallet.js` + `accounts.js` (HD seed)            |
| BLOCK signer     | `signer.js` (`Signer`)        | unchanged (ML-DSA-44 wasm)                       |
| Chain registry   | `chain.js` (BLOCK-only `Chain`) | `chains/` (`block.js`,`evm.js`,`utxo.js`) + `registry.js` |
| Exchange         | — (dApp swap only)            | `exchange.js` wrapping `@blockle/agent-sdk`      |
| AI agent         | —                             | `agent/` (`runner.js`,`providers.js`,`tools.js`,`policy.js`,`audit.js`) |
| dApp provider    | `background.js`,`inpage.js`,`content.js` | extended with `eth_*` passthrough (later) |

---

## 2. The chain abstraction (`ChainAdapter`)

Every supported chain implements the **same five-method interface**. This is the
central contract of PASS 1. The registry holds one adapter per `ChainId`; the UI,
the exchange layer, and the AI agent all talk to adapters only — never to a
chain's RPC directly.

```ts
type ChainId = "block" | "ethereum" | "base" | "bitcoin" | "litecoin" | "dogecoin";

interface AssetRef {
  chain: ChainId;
  kind: "native" | "erc20" | "block20";
  address?: string;   // ERC-20 contract / BLOCK-20 contract id; omitted for native
  symbol: string;     // "BLOCK" | "ETH" | "USDC" | "BTC" | ...
  decimals: number;
}

interface DerivedAccount {
  chain: ChainId;
  index: number;              // HD account index (usually 0)
  address: string;            // chain-canonical display address
  publicKey: string;          // hex (compressed secp256k1) or ML-DSA pubkey hex
  // NOTE: the private key / secret is NEVER returned here. Signing happens
  // inside the adapter against the unlocked in-memory key material only.
  scheme: "ml-dsa-44" | "secp256k1";
  path?: string;              // BIP32 derivation path for secp256k1 chains
}

interface Balance {
  asset: AssetRef;
  confirmed: string;          // base units, decimal string (BigInt-safe)
  spendable?: string;         // mature/spendable subset (UTXO chains)
  display: string;            // human units, for UI only
}

interface SendRequest {
  asset: AssetRef;            // native coin or a token on this chain
  to: string;
  amount: string;             // base units, decimal string
  feeRate?: string;           // sat/vB (UTXO) | maxFeePerGas (EVM) | fee (BLOCK)
  memo?: string;
}

interface BuiltTx {
  chain: ChainId;
  raw: string;                // signed, broadcast-ready payload (hex)
  txid: string;               // expected/display txid
  fee: string;                // base units
  summary: SendRequest;       // echoed, for the confirmation screen & audit log
}

interface ChainAdapter {
  readonly id: ChainId;
  readonly native: AssetRef;

  /** Derive this chain's account(s) from the unlocked root secret. Pure
   *  derivation — no network. For BLOCK the "root secret" is the ML-DSA
   *  keypair; for secp256k1 chains it is the BIP39 seed + BIP44 path. */
  deriveAccount(root: RootSecret, index?: number): Promise<DerivedAccount>;

  /** Read balances for `address`. Best-effort: on network failure return a
   *  Balance with confirmed:"0" and a flagged error — never throw into the UI.
   *  `tokens` lists extra assets (ERC-20 / BLOCK-20) to include. */
  getBalance(address: string, tokens?: AssetRef[]): Promise<Balance[]>;

  /** Build + SIGN a transaction. Signing uses the unlocked key material held
   *  in the account session; keys never leave the adapter. Returns a signed
   *  BuiltTx ready to broadcast. Does NOT broadcast. */
  buildSend(account: DerivedAccount, req: SendRequest): Promise<BuiltTx>;

  /** Broadcast a signed BuiltTx via this chain's configured endpoint.
   *  Returns the accepted txid. */
  broadcast(tx: BuiltTx): Promise<{ txid: string; accepted: boolean }>;

  /** A public explorer URL for a txid (UI deep-link + audit log). */
  explorerTx(txid: string): string;

  /** Optional: HTLC signer for the exchange's atomic swaps (see §6). Present
   *  on every adapter that can be a swap leg. */
  htlcSigner?(account: DerivedAccount): import("@blockle/agent-sdk").HtlcSigner;
}
```

Design rules for adapters:

- **All amounts are base-unit decimal strings** (BigInt-safe), converted to
  human units only at the display edge. This matches the SDK (`sdk/src/money.ts`)
  and the extension's existing base-unit handling.
- **Reads are best-effort and never throw into the UI** — mirrors the current
  `chain.js` pattern (timeout + `null`/`—`).
- **Every network endpoint is CONFIG**, resolved from the vault/settings, with a
  sane public default. No secrets are ever hardcoded. (Today: `apiBase` in
  `Store`. Target: a `endpoints` map keyed by `ChainId`.)
- `buildSend` **signs**; `broadcast` is a separate call so the confirmation
  screen (and the AI-agent confirmation gate) can inspect the fully-built,
  summarized tx before anything hits the network.

### Registry

```ts
interface ChainRegistry {
  get(id: ChainId): ChainAdapter;
  enabled(): ChainId[];                 // chains the user has turned on
  endpoints(id: ChainId): EndpointCfg;  // user-supplied or public default
}
```

The registry is the only place that knows the concrete adapter classes. BLOCK is
always enabled (it is the wallet's native identity); the others are opt-in.

---

## 3. Supported chains — key & address schemes

| Chain    | ChainId      | Scheme       | Derivation (BIP44)         | Address format                 | Balance/broadcast source        |
|----------|--------------|--------------|----------------------------|--------------------------------|---------------------------------|
| Blockle  | `block`      | **ML-DSA-44**| none (wasm keypair)        | `block1…` (bech32)             | `blockle.org/api/explorer` + `/api/submit` |
| Ethereum | `ethereum`   | secp256k1    | `m/44'/60'/0'/0/0`         | `0x` + keccak256(pub)[-20:]    | JSON-RPC (configurable)         |
| Base     | `base`       | secp256k1    | `m/44'/60'/0'/0/0` (same key) | `0x…`                       | JSON-RPC (configurable)         |
| Bitcoin  | `bitcoin`    | secp256k1    | `m/84'/0'/0'/0/0` (P2WPKH) | `bc1…` (bech32) / P2PKH legacy | Electrum/Esplora (configurable) |
| Litecoin | `litecoin`   | secp256k1    | `m/84'/2'/0'/0/0`          | `ltc1…` / `L…`                 | Electrum/Esplora (configurable) |
| Dogecoin | `dogecoin`   | secp256k1    | `m/44'/3'/0'/0/0` (P2PKH)  | `D…`                           | Electrum/Esplora (configurable) |

### 3.1 BLOCK (native identity) — unchanged

- Keys, address (`block1…` bech32, see `bech32.js`), signatures, and all tx
  building are produced by `blockle-wasm` via `signer.js`. **Do not touch this.**
- UTXO model. Balance + spendable UTXOs from `/api/explorer/utxos/{addr}`;
  broadcast via `/api/submit {raw}` (see `chain.js` `submit()`).
- The BLOCK adapter wraps the existing `Wallet`/`Signer`/`Chain` globals; its
  `buildSend` delegates to `Signer.buildTransfer`, `broadcast` to `Chain.submit`.
- BLOCK-20 tokens (`kind:"block20"`) are read via `Chain.token()` and spent via
  the existing pool/transfer builders.

### 3.2 EVM (Ethereum + Base) + ERC-20

- One secp256k1 account derived at `m/44'/60'/0'/0/0`; the **same key** serves
  every EVM chain (Ethereum, Base, …) — they differ only by `chainId` and RPC
  endpoint.
- Address = `0x` + last 20 bytes of `keccak256(uncompressedPubKey[1:])`.
- Native ETH: balance via `eth_getBalance`; send via a signed EIP-1559 tx
  (`eth_sendRawTransaction`). Nonce via `eth_getTransactionCount`, gas via
  `eth_maxPriorityFeePerGas` + `eth_feeHistory` / `eth_gasPrice`.
- **ERC-20 (USDC, USDT):** balance via `balanceOf(address)` (eth_call); send via
  `transfer(to, amount)` calldata. Token list is config (contract address +
  decimals per chain). USDC/USDT are first-class (they are the exchange's quote
  assets and the x402 settlement asset).
- Signing: secp256k1 ECDSA. **Not post-quantum** — state this in the UI.
- RPC endpoint is user-supplied or a public default; configurable per chain.

### 3.3 BTC / LTC / DOGE (UTXO, secp256k1)

- BIP39 mnemonic → BIP32 HD → BIP44/BIP84 account per the table above.
- UTXO model identical in shape to BLOCK: fetch UTXOs, select coins, build
  inputs/outputs, sign each input (ECDSA), serialize, broadcast.
  - **BTC/LTC default to P2WPKH** (native segwit, `bc1…`/`ltc1…`); legacy P2PKH
    supported for import/compatibility.
  - **DOGE is P2PKH** (`D…`); no segwit.
- Balance, UTXO set, fee estimation, and broadcast via a configurable
  **Electrum or Esplora-style** endpoint per chain (public default, user can
  override). Same best-effort read discipline as BLOCK.
- Signing: secp256k1 ECDSA. **Not post-quantum** — state this in the UI.
- A shared `UtxoAdapter` base handles coin selection + change; BTC/LTC/DOGE are
  thin subclasses parameterized by network magic bytes, address prefixes, and
  derivation path.

### 3.4 Honesty requirement in the UI

Wherever the wallet advertises "post-quantum," it MUST scope the claim. The
required framing:

> **BLOCK** is signed with post-quantum **ML-DSA-44**. **BTC, LTC, DOGE, and
> all EVM assets use ECDSA (secp256k1) and are *not* post-quantum.** Every
> private key — PQ and ECDSA alike — is stored in a vault encrypted with a
> strong KDF and authenticated encryption, and never leaves this device.

---

## 4. Encrypted vault

### 4.1 What is stored

The vault holds the entire secret state as **one encrypted blob**, sealed under
the user's password. Plaintext (before sealing):

```ts
interface VaultPlaintext {
  version: 2;
  // The HD root for all secp256k1 chains (EVM + BTC/LTC/DOGE):
  mnemonic: string;                 // BIP39 (or a stored 256-bit entropy seed)
  // The BLOCK identity (ML-DSA-44) is NOT derivable from the BIP39 seed — it is
  // its own keypair, stored alongside it:
  block: { secret: string; public: string };   // hex, from blockle-wasm keygen
  // Per-chain derived account cache (public data only — convenience, re-derivable):
  accounts?: DerivedAccount[];
  // AI-agent LLM credential, if the user enabled the agent (see §7):
  agent?: { provider: "claude" | "openai" | "copilot"; apiKey: string };
  // User settings that must stay private:
  endpoints?: Record<ChainId, EndpointCfg>;
  tokens?: AssetRef[];              // imported ERC-20 / BLOCK-20 token list
}
```

Note on multi-wallet: the existing extension stores an **array** of sealed
wallet records (`wallets[]` in `wallet.js`), each independently sealed. PASS 1
keeps that model — each record's `crypto` blob now contains a `VaultPlaintext`
(mnemonic + BLOCK keypair + agent cred) instead of just the BLOCK secret. The
active wallet's decrypted plaintext lives only in the ephemeral session
(`Session`, `chrome.storage.session`) with auto-lock, exactly as today.

### 4.2 KDF + AEAD

- **AEAD:** AES-256-GCM (authenticated; tamper-evident). Keep the current
  WebCrypto primitive — it is already correct in `vault.js`.
- **KDF — upgrade target:** **argon2id** (preferred) or **scrypt** as the
  password → key derivation, replacing the current PBKDF2-SHA256/310k. Rationale:
  the vault now protects *spendable BTC/LTC/DOGE/ETH and an LLM API key*, so the
  offline-attack cost must be memory-hard, not just iteration-hard.
  - Suggested argon2id params: `t=3, m=64 MiB, p=1` (tune per platform; store
    the params in the blob so they can evolve).
  - **Versioned + backward-compatible:** the sealed blob carries
    `{ v, kdf: { name, params }, salt, iv, data }`. `v:1` (existing PBKDF2 blobs)
    still open; on the next successful unlock the wallet **re-seals as `v:2`
    (argon2id)** transparently. No user ever loses access.
- Salt: 16 random bytes per seal. IV: 12 random bytes per seal. Never reused.

Sealed blob shape (extends today's `{v,salt,iv,data}`):

```ts
interface SealedVault {
  v: 2;
  kdf: { name: "argon2id" | "scrypt" | "pbkdf2"; params: Record<string, number> };
  salt: string;  // base64
  iv: string;    // base64
  data: string;  // base64 AES-256-GCM ciphertext of VaultPlaintext
}
```

### 4.3 Unlock flow

1. User enters password in the popup/app.
2. `Vault.open(sealed, password)` derives the key with the blob's declared KDF +
   params, AES-GCM-decrypts, parses `VaultPlaintext`. Wrong password → GCM auth
   failure → thrown "wrong password" (no oracle beyond that).
3. The decrypted plaintext is placed in the **ephemeral session** only
   (`chrome.storage.session` / in-memory; never `Store`/disk). Auto-lock timer
   (currently 30 min) clears it.
4. Adapters derive their accounts from the in-session root on demand; derived
   secrets live only for the duration of a `buildSend`/HTLC call.
5. If the blob was `v:1`, re-seal as `v:2` and persist the upgraded blob.

**Lock / kill:** clearing the session wipes all decrypted key material and the
AI-agent credential from memory. Nothing spendable survives a lock.

Platform storage for the three clients:

| Wallet     | Persistent store         | Ephemeral session           |
|------------|--------------------------|-----------------------------|
| Extension  | `chrome.storage.local`   | `chrome.storage.session`    |
| Flutter    | `flutter_secure_storage` (Keychain/Keystore) for the sealed blob | in-memory, cleared on background/timeout |
| Qt         | `QSettings` / app-data file | in-memory process state  |

The sealed blob is portable across all three (same `SealedVault` JSON) — a
wallet exported from one opens in another with the same password.

---

## 5. Accounts module

Sits between the vault and the chain registry. Responsibilities:

- Hold the unlocked `VaultPlaintext` in session.
- Lazily derive and cache `DerivedAccount` per enabled chain via each adapter's
  `deriveAccount(root)`.
- Expose the active account per chain to the UI, exchange, and agent.
- Preserve the existing BLOCK-centric API (`Wallet.address`, `Wallet.sign…`) so
  the dApp provider and current UI keep working; add `accountFor(chainId)`.

```ts
interface Accounts {
  isUnlocked(): boolean;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;                        // wipes session (kill switch too)
  accountFor(chain: ChainId): Promise<DerivedAccount>;
  balances(chain: ChainId): Promise<Balance[]>; // via adapter.getBalance
  // BLOCK compatibility shims (unchanged behavior):
  address: string;                              // BLOCK address
  signMessage(msg: string): Promise<Signature>; // ML-DSA
}
```

---

## 6. Embedded exchange

The wallet **embeds the SDK's `ExchangeClient`** (`sdk/src/exchange.ts`) pointed
at `https://exchange.blockle.org`. It does **not** reimplement the exchange. The
relay is non-custodial: it only coordinates the HTLC hashlock/preimage/timelocks;
the wallet performs **every on-chain leg with its own adapters** (keys stay on
device).

### 6.1 Wiring

The SDK already defines the exact seam we need — `AuthSigner` and `HtlcSigner`
(`sdk/src/signers.ts`). Each `ChainAdapter` exposes `htlcSigner(account)`
returning an `HtlcSigner` for its chain. The wallet constructs the exchange
client with:

- `block`: the BLOCK signer (always present), via `signer.js`.
- `legSigners`: `{ ethereum, base, bitcoin, litecoin, dogecoin }` → each
  adapter's `htlcSigner`. (BTC/LTC/DOGE legs are the "next pass" on the exchange
  side per the backlog, but the adapter seam is defined now.)

```ts
import { ExchangeClient } from "@blockle/agent-sdk";

const exchange = new ExchangeClient({
  exchangeUrl: "https://exchange.blockle.org",
  block: blockSigner,                       // ML-DSA auth + sign
  blockHtlc: blockAdapter.htlcSigner(acct), // BLOCK leg = relay-instructed transfer
  legSigners: {
    base:     evmAdapter.htlcSigner(evmAcct),
    ethereum: evmAdapter.htlcSigner(evmAcct),
    bitcoin:  btcAdapter.htlcSigner(btcAcct),
    // …
  },
});
```

The **API contract** the client speaks (documented, already live): `/auth/nonce`,
`/auth/verify`, `/markets`, `/book/:market`, `/trades/:market`, `/orders`
(POST/DELETE/`/mine`), `/swaps/mine`, `/swaps/:id/step`, `/listings`,
`/listings/quote`, WS `/stream`, and the x402 rail `/x402/buy|list|pay`. The
wallet uses the client methods — never raw fetch to these — so a relay change is
absorbed by bumping the SDK.

### 6.2 What the wallet UI exposes

- **Sign in**: `exchange.signIn("block")` (ML-DSA nonce signature). Session token
  held in memory only.
- **Markets / book / trades**: read-only, live via WS `/stream`.
- **Trade**: `exchange.swap(from, to, amount, { slippage })` — one call signs in,
  takes/posts the best order, and drives the atomic swap to completion, invoking
  the right adapter's `htlcSigner` for each leg. Every leg's lock/withdraw/refund
  is a real on-chain action by the wallet's own key.
- **Place / cancel limit orders**: `placeOrder` / `cancelOrder` (signed intents;
  the relay only verifies signatures).
- **Buy BLOCK with USDC**: x402 rail via the SDK's `X402Client`, settled by the
  EVM adapter's USDC signer (the x402 payer). `sellBlock` sends BLOCK to the
  reserve and the settlement service pays USDC to the EVM account's address.
- **List an asset**: `exchange.listAsset(...)` — quote, pay the fee
  non-custodially to the relay treasury, register. Fee payable in BLOCK (plain
  transfer) or another chain's injected signer.

### 6.3 Safety carried from the SDK

The SDK's mainnet money paths are gated by the relay's `mainnet_enabled` flag and
default to testnets; KYC/geo hooks live at the fiat boundaries. The wallet does
not bypass these — it surfaces whatever the relay reports.

---

## 7. In-wallet AI agent

**Optional, off by default.** The user flips it on and pastes an LLM credential.
The agent turns natural-language instructions into wallet/exchange/SDK actions —
under **mandatory, non-bypassable** safety rails.

### 7.1 Components (`agent/`)

```
agent/
  providers.js   — provider adapters: Claude / OpenAI / Copilot  (one interface)
  tools.js       — the tool allowlist: typed, named wallet/exchange actions
  policy.js      — spending caps, confirmation gate, kill switch, allowlist check
  runner.js      — the loop: prompt → tool calls → policy → execute → observe
  audit.js       — append-only action log
```

### 7.2 Provider adapters

One interface, three implementations. The credential comes from the **vault
only** (`VaultPlaintext.agent.apiKey`); it is never written to disk unencrypted
and never sent anywhere except directly to the chosen LLM provider's API over
TLS.

```ts
interface LlmProvider {
  readonly name: "claude" | "openai" | "copilot";
  /** One turn of tool-use. Given the running message history + the tool
   *  schemas, return either text or a set of tool calls to run. */
  turn(input: {
    system: string;
    messages: Message[];
    tools: ToolSchema[];
  }): Promise<{ text?: string; toolCalls?: ToolCall[] }>;
}
```

- **Claude** — Anthropic Messages API, native `tools` / `tool_use` /
  `tool_result`. (Use the `claude-api` skill / current model IDs when
  implementing; do not hardcode a stale model.)
- **OpenAI** — Chat Completions / Responses with function-calling.
- **Copilot** — GitHub Copilot chat completions (OpenAI-compatible tool calls).

The adapter normalizes each provider's tool-call format to the internal
`ToolCall`/`ToolResult` shape so `runner.js` is provider-agnostic.

### 7.3 Tool allowlist (`tools.js`)

The agent can call **only** tools on this explicit allowlist. Each tool has a
typed schema, a `valueMoving` flag, and a handler that routes to an adapter or
the embedded `ExchangeClient`. This mirrors the MCP tool catalog (`mcp/src/tools.ts`)
so the in-wallet agent and the external MCP agent expose the same capabilities.

| Tool                     | Value-moving | Routes to                          |
|--------------------------|:------------:|------------------------------------|
| `get_balance`            | no           | `adapter.getBalance`               |
| `get_address`            | no           | `accounts.accountFor`              |
| `list_assets`            | no           | registry / token list              |
| `get_markets` / `get_book` / `get_trades` | no | `ExchangeClient` reads      |
| `quote`                  | no           | adapter / SDK quote math           |
| `send`                   | **yes**      | `adapter.buildSend` → `broadcast`  |
| `swap` (exchange)        | **yes**      | `ExchangeClient.swap`              |
| `place_order` / `cancel_order` | **yes** | `ExchangeClient`                  |
| `buy_block` / `sell_block` | **yes**    | SDK x402 / settlement              |
| `launch_token`           | **yes**      | SDK `launchToken`                  |
| `create_pool` / `add_liquidity` / `remove_liquidity` | **yes** | SDK AMM |
| `list_asset`             | **yes**      | `ExchangeClient.listAsset`         |

Anything not on the list is rejected by `policy.js` before execution. There is
no "shell" / "eval" / "arbitrary RPC" tool.

### 7.4 Mandatory safety rails (`policy.js`) — do NOT build a bypass

1. **Per-session spending caps.** Before the agent runs, the user sets an
   explicit cap (e.g. "max 50 USDC-equivalent this session", plus optional
   per-asset caps). `policy.js` tracks cumulative value-moving spend and **hard-
   rejects** any tool call that would exceed it. Caps reset only by explicit user
   action, never by the agent.
2. **Confirmation gate (default-on).** Every `valueMoving` tool call pauses for
   an **explicit human confirm** showing the fully-built, summarized tx (`BuiltTx.summary`,
   destination, amount, fee, chain, explorer-preview). The agent cannot
   auto-approve. A per-session "auto-approve under $X" opt-in MAY exist but is
   off by default and still bounded by the cap.
3. **Tool allowlist** (§7.3) — enforced on every call.
4. **Kill switch.** A single always-visible control that (a) aborts the running
   agent loop, (b) revokes the in-memory session token, and (c) **locks the
   vault** (wipes decrypted keys + the LLM credential from memory). One tap,
   everything stops.
5. **Full audit log (`audit.js`).** Append-only, local, tamper-evident record of
   every prompt, every tool call (args + result + decision), every confirmation,
   every cap check, and every broadcast txid (with `explorerTx` link). The user
   can review and export it. This is the accountability backstop.

Credential handling: the LLM API key lives only in the encrypted vault; it is
loaded into memory on unlock, used only to call the chosen provider, and wiped on
lock/kill. It is **never** sent to any Blockle server.

### 7.5 Runner loop

```
unlock → user sets session cap → user prompt
  └─ provider.turn(system, history, allowlisted tool schemas)
       ├─ text → show to user
       └─ toolCall →
            policy.check(toolCall)            // allowlist + cap pre-check
            if valueMoving → build tx, show summary, AWAIT user confirm
            execute (adapter / ExchangeClient)
            audit.record(call, result)
            feed tool_result back to provider.turn
  └─ repeat until the model returns a final text answer or the user hits kill
```

`system` prompt states the rails explicitly (allowlist, caps, that confirmation
is enforced by the host and not the model's discretion) so the model cooperates
with — rather than fights — the safety layer. But the rails are enforced in code;
the prompt is not the control.

---

## 8. Build / compatibility checklist (PASS 1 exit criteria)

- [ ] Extension still loads; BLOCK create/unlock/send/swap + dApp provider work
      unchanged (no regression).
- [ ] `ChainAdapter` interface + registry landed; BLOCK adapter wraps existing
      `Signer`/`Chain`.
- [ ] EVM adapter (ETH + Base, ERC-20 USDC/USDT) behind config RPC.
- [ ] UTXO adapter + BTC/LTC/DOGE subclasses behind config Electrum/Esplora.
- [ ] Vault v2 (argon2id/scrypt + AES-GCM, versioned, transparent v1→v2 re-seal).
- [ ] Honest PQ framing in the UI (BLOCK=ML-DSA; others=ECDSA).
- [ ] Embedded `ExchangeClient` wired with per-chain `htlcSigner`s.
- [ ] AI agent behind a flag: provider adapters, allowlist, caps, confirmation,
      kill switch, audit log — all enforced in code.
- [ ] No key, seed, or LLM credential ever leaves the device.

---

## 9. Porting notes for Flutter & Qt (later passes)

- **BLOCK signing:** reuse `blockle-wasm` — Flutter via FFI / a Dart-wasm bridge,
  Qt via the Python bindings or the same wasm through a runtime. Never reimplement
  ML-DSA in Dart or Python.
- **secp256k1 chains:** Flutter → `bip39`/`bip32`/`bitcoindart`/`web3dart`;
  Qt → `bip_utils` + `eth-account` + `coincurve`. Same derivation paths and
  address formats as §3.
- **Vault:** identical `SealedVault` JSON so blobs are portable across all three
  clients. Argon2id via platform libs (`cryptography`/`argon2` in Dart,
  `argon2-cffi` in Python).
- **Exchange:** the TS `ExchangeClient` is the contract; Flutter/Qt either embed
  a thin port speaking the same documented HTTP/WS API, or (preferred) reuse the
  SDK via a bridge. Do not fork the relay contract.
- **AI agent:** same five rails, same allowlist, same audit-log shape. The
  `LlmProvider` interface ports verbatim.

This document is the contract. The Build phase implements it in the extension;
Flutter and Qt follow.
