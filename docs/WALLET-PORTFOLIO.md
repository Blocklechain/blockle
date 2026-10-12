# Wallet Portfolio & Activity — spec

One spec, three identical implementations: `blockle-extension` (JS, reference),
`blockle-app/lib` (Dart), `python/blockle` (Python). Shared numeric fixture:
`docs/portfolio-vectors.json` (authored by the extension; ports assert against it).

Three capabilities, all built on the EXISTING chain adapters + price sources (the same
live market source the bots use: exchange book mid/last + the configured USD price map).
Everything here is **read-only**; no new signing/money path. Never fabricate a price or a
balance — a value that can't be sourced is shown as "unknown"/omitted, never guessed.

## 1. Net worth (unified cross-chain)

```
portfolio(accounts, ctx) -> Portfolio   // READ-ONLY, pure given injected balance+price ctx
Portfolio = {
  totalUsd,                       // sum of priced holdings; integer micro-dollars internally
  byChain: [ {chain, usd, pct} ],
  holdings: [ {chain, asset, symbol, amountBase, decimals, priceUsd?, usd?, pricedOk} ],
  unpriced: [ {chain, symbol, amountBase} ],   // held but no USD price (shown, excluded from total)
  asOf,                            // injected timestamp (ms) — never call the clock in pure logic
}
```
- Aggregates balances across every configured chain + account (BLOCK, all EVM networks +
  custom, BTC/LTC/DOGE, Solana) from the existing `getBalance`/token-detect adapters.
- USD from the shared mark source; a holding with no resolvable price goes to `unpriced`
  (NOT counted as 0, NOT guessed). `pct` is each chain's share of `totalUsd`.
- Money math integer/micro-dollar exact (reuse the §8 micro-dollar convention). A canonical
  `portfolio-vectors.json` case pins totalUsd + byChain pct + the unpriced split exactly.
- UI: a net-worth hero (USD) + a 30-point sparkline from the locally-persisted daily snapshot
  history (see §2.1), a by-chain breakdown (dataviz: one hue sequential or the categorical
  theme; table fallback; no dual axis), and the holdings list grouped by chain.

## 2. Activity (aggregated cross-chain history)

```
activity(accounts, ctx, {cursor?, limit?}) -> { items: [Activity], nextCursor? }
Activity = {
  chain, txid, ts, direction:'in'|'out'|'self'|'contract',
  kind,                       // 'transfer'|'token-transfer'|'approval'|'swap'|'contract'|'nft'
  asset?, amountBase?, counterparty?, feeBase?, status:'confirmed'|'pending'|'failed',
  memo?, explorerUrl?,
}
```
- Pulls per-chain history from the adapters' indexers (EVM: Alchemy `getAssetTransfers` /
  logs; Solana: signatures-for-address; UTXO: esplora address txs; BLOCK: node history),
  each injected via `ctx` and mockable. Merges into one time-sorted feed with a stable
  cursor for paging. An indexer that's unavailable contributes nothing + an audited note
  (never a fabricated empty "no activity").
- Decodes each item's `kind` by REUSING the security suite's decoder
  (`inspectTransaction`/decode) so labels match the pre-sign preview exactly. A send that
  the security suite would flag is marked (so past interactions with a flagged counterparty
  are visible in history too).
- **2.1 Daily snapshot history:** a tiny local, append-only store records `{ts, totalUsd}`
  once per day (dedup by day) to drive the net-worth sparkline. No PII beyond chain data the
  wallet already holds; never any key material.

## 3. Address book + name resolution

```
AddressBook: add/edit/remove/list { label, address, chain?, note? }   // local, encrypted-at-rest alongside settings
resolveName(input, chain, ctx) -> { address, source:'ens'|'sns'|'book'|'raw' } | null
```
- A local labeled-contacts store. Send/receive flows show the label when a counterparty is
  known; the §2 activity feed and §1 holdings reuse it for display.
- **Name resolution** (read-only, injected resolvers): ENS (`.eth`) on EVM via the injected
  ENS resolver; SNS (`.sol`) on Solana via the injected SNS resolver; the local book by
  label. `resolveName` returns the resolved address + its source, or null (never a guessed
  address). The send flow resolves a typed name, SHOWS the resolved address for confirmation
  (anti-spoofing), and still runs the §-security pre-sign inspection on the resolved address.
- Reverse: when displaying an address, prefer book label > ENS/SNS reverse (if the resolver
  provides it, and only when forward-verified) > the truncated hex.

## 4. Parity + tests

`docs/portfolio-vectors.json`: canonical net-worth aggregation (mixed chains, a priced +
an unpriced holding, byChain pct, exact micro-dollar total), an activity merge/sort/paging
case (interleaved chains, stable cursor), and name-resolution cases (ens/sns/book/raw + a
null for an unresolvable name). Assert identically in all three languages.

Read-only throughout; no new signing path; integer/BigInt-exact money; reuses the security
decoder for activity labels and the security pre-sign for name-resolved sends. Keep all
existing tests green.
