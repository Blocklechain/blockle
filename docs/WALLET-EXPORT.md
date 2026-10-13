# Wallet export — every key type, incl. Core-importable BTC/LTC/DOGE

Let the user export everything needed to recover funds elsewhere, from all 3 wallets
(`blockle-extension`, `blockle-app`, `python/blockle`), behind the security gate.

## What's exportable

1. **Seed / mnemonic** — the BIP-39 mnemonic (+ optional passphrase note) and the raw
   seed hex. This alone restores every derived chain.
2. **Per-chain private keys** — for the active account and a chosen index range:
   - UTXO (BTC/LTC/DOGE): **WIF** (chain-correct version byte: BTC 0x80, LTC 0xb0, DOGE 0x9e).
   - EVM: 0x-hex private key.
   - Solana: base58 secret key.
   - BLOCK: the native key export the Qt wallet already supports.
3. **Core-importable key file for BTC/LTC/DOGE** — a Bitcoin-Core `importwallet`-format
   dump: a text file of `WIF <label> # addr=<address> hdkeypath=...` lines with the
   standard `# Wallet dump` header. The user drops it into Core with
   `bitcoin-cli importwallet <file>` (or `litecoin-cli` / `dogecoin-cli`) and Core
   rebuilds its **wallet.dat** from it — the reliable, non-custodial path to a Core
   wallet.dat. (A literal BDB `wallet.dat` is a Berkeley-DB blob tied to Core's
   version; generating one correctly in-app is fragile and omitted — the importwallet
   dump achieves the same recovery and is what Core itself reads. If a raw `.dat` is
   ever required we add a tested BDB writer as its own task.) File is named
   `<chain>-blockle-import.txt`; one per BTC/LTC/DOGE on request.

## Safety

- Every export path is **gated**: the vault must be unlocked and the user must pass an
  explicit confirm with a plain-language warning ("anyone with this can take your
  funds; never share it; Blockle support will never ask for it"). Export is **read-only**
  key material — it never moves funds and never leaves the device (no network).
- The exported secrets are shown/offered for download locally only; not logged, not
  sent to any gateway/telemetry. Clipboard copies warn + (where supported) auto-clear.
- In hosted-agent mode none of this is ever put in the agent conversation.

## Parity + tests

Shared `docs/wallet-export-vectors.json`: a fixed seed → the exact derived WIF/hex/base58
keys per chain + the exact `importwallet` dump lines for BTC/LTC/DOGE, identical across
all three wallets. Tests: WIF round-trips (decode back to the same key + address); the
dump file imports cleanly (validate format + that each WIF matches its stated address);
the gate blocks export while locked / on declined confirm; no secret is logged or sent.
