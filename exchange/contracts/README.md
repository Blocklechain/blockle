# exchange/contracts — atomic-swap HTLCs

Non-custodial, cross-chain atomic swaps for the Blockle exchange. One shared
protocol (a single preimage `s`, hashlock `H = hash(s)`, paired timelocks
`T2 < T1`), implemented as a hash-timelocked contract (HTLC) on each chain.

**Read [`PROTOCOL.md`](./PROTOCOL.md) first** — it defines the state machine,
the per-chain hash choice (and the one honest VM limitation), timelock deltas,
every refund path, and exactly where the 0.1% settlement fee is taken.

| Leg | Dir | Assets | Hash | Builds | Tests |
|-----|-----|--------|------|--------|-------|
| EVM | [`evm/`](./evm) | ETH, any ERC-20 (USDC, USDT) | SHA-256 | ✅ Hardhat | ✅ 10 passing (ETH + USDC-style + USDT-style) |
| Solana | [`solana/`](./solana) | SOL, any SPL (USDC, USDT) | SHA-256 | ✅ `anchor build` → `htlc.so` | ✅ 5 passing on local validator (SOL + SPL) |
| BLOCK | [`block/`](./block) | native BLOCK | BLAKE2B | ✅ `cargo build` | ✅ regtest claim + refund |

All money paths are **testnet-first and mainnet-gated**. Operators must obtain
legal/compliance sign-off before enabling any mainnet money path (see each
README and `PROTOCOL.md §7`).

Non-custodial by construction: funds move wallet-to-wallet; no relay, operator,
or contract owner can seize a locked swap — only the receiver (with `s`) or the
depositor (after the timelock) can move it.
