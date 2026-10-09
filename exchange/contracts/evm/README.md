# EVM leg — Solidity HTLC

Hash-timelocked contract for **native ETH** and **arbitrary ERC-20** tokens.
USDC and USDT are first-class legs — the token is a per-swap argument
(`address(0)` = ETH), never hardcoded. USDT-style tokens that return no value
from `transfer`/`transferFrom` are handled.

See [`../PROTOCOL.md`](../PROTOCOL.md) for the swap state machine. Protocol hash
is **SHA-256** (`sha256(preimage) == hashlock`), matching the Solana leg.

## Layout
- `contracts/HTLC.sol` — `lock` / `withdraw` / `refund`; 0.1% (configurable,
  capped at 1%) settlement fee to a configurable `feeAddress`, taken only in
  `withdraw`. `refund` takes no fee.
- `contracts/mocks/ERC20Mock.sol` — standard ERC-20 (stands in for USDC).
- `contracts/mocks/NoReturnERC20Mock.sol` — USDT-style no-return token.
- `test/htlc.test.js` — ETH + ERC-20 + USDT-style; happy path, wrong preimage,
  refund, timelock windows, double-withdraw.
- `scripts/deploy.js` — **gated** testnet deploy.
- `config.json` — `feeBps`, `feeAddress`, reference testnet token addresses.

## Build & test
```bash
cd exchange/contracts/evm
npm install
npx hardhat compile      # or: npm run build
npx hardhat test         # or: npm test  → 10 passing
```

## Deploy (testnet only, gated)
```bash
# Base Sepolia (default RPC baked in; set a deployer key)
export DEPLOYER_PRIVATE_KEY=0x...
export HTLC_FEE_ADDRESS=0x...          # overrides config.json
npm run deploy:baseSepolia
```
`scripts/deploy.js` **refuses** any non-testnet network unless BOTH
`HTLC_MAINNET_ENABLED=true` and `HTLC_LEGAL_REVIEW_REF=<sign-off ref>` are set.

> **Testnet-first.** Mainnet networks are intentionally not configured in
> `hardhat.config.js`. Enabling a mainnet money path requires a recorded
> legal/compliance review. KYC/geo screening belongs at the off-chain
> fiat/custody boundary, not in this contract.
