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

## Deploy — one command per network

The deployer key is read from env; the RPC/network from `hardhat.config.js`.
**Nothing is ever committed.** Each run prints the deployed address and writes
it to `deployments.json` (keyed by network) — the file the relay reads to learn
the live HTLC address.

### What the key-holder must provide (env)
| Var | Purpose | Notes |
|-----|---------|-------|
| `PRIVATE_KEY` | funded deployer key | `0x`-prefixed. `DEPLOYER_PRIVATE_KEY` also accepted. **Never commit it.** |
| `SEPOLIA_RPC_URL` | Sepolia RPC | Alchemy/Infura/public node. Required for `deploy:sepolia`. |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC | Optional — defaults to `https://sepolia.base.org`. |
| `BASE_RPC_URL` | Base mainnet RPC | Required for `deploy:base`. |
| `ETHEREUM_RPC_URL` | Ethereum mainnet RPC | Required for `deploy:ethereum`. |
| `HTLC_FEE_ADDRESS` | protocol-fee receiver | Optional — overrides `config.json`. |
| `HTLC_FEE_BPS` | fee basis points | Optional — overrides `config.json` (≤100 = 1%). |
| `ETHERSCAN_API_KEY` / `BASESCAN_API_KEY` | source verification | Only for the `verify` step. |

### Testnet (do this first)
```bash
cd exchange/contracts/evm
npm install
export PRIVATE_KEY=0x...                      # funded Sepolia deployer
export SEPOLIA_RPC_URL=https://...            # your RPC
npm run deploy:sepolia                        # prints address + writes deployments.json

# Base Sepolia (RPC default baked in):
export PRIVATE_KEY=0x...
npm run deploy:baseSepolia
```
**Funding:** a deploy costs ~0.002–0.01 test ETH of gas. Get Sepolia ETH from a
faucet (e.g. `sepoliafaucet.com`, Alchemy, or the Google Cloud faucet); bridge a
little to Base Sepolia via `superbridge.app` or use a Base Sepolia faucet.

### Mainnet (gated — key-holder + recorded legal review only)
```bash
export PRIVATE_KEY=0x...                      # funded mainnet deployer (REAL gas)
export BASE_RPC_URL=https://...               # or ETHEREUM_RPC_URL
export HTLC_MAINNET_ENABLED=true
export HTLC_LEGAL_REVIEW_REF="<sign-off ref>" # recorded compliance sign-off
npm run deploy:base                           # or: npm run deploy:ethereum
```
`scripts/deploy.js` **refuses** any non-testnet network unless BOTH
`HTLC_MAINNET_ENABLED=true` and `HTLC_LEGAL_REVIEW_REF` are set. Mainnet gas is
real ETH — budget a few USD on Base, more on Ethereum L1 depending on gas price.

### Verify source (optional, recommended)
```bash
npm i -D @nomicfoundation/hardhat-verify      # one-time
export ETHERSCAN_API_KEY=...                  # or BASESCAN_API_KEY for Base
npx hardhat verify --network sepolia <ADDRESS> <FEE_BPS> <FEE_ADDRESS>
```
The deploy output prints the exact `verify` command with the constructor args
filled in.

### deployments.json → relay
Example written entry:
```json
{ "sepolia": { "chainId": 11155111, "address": "0x…", "feeBps": 10,
  "feeAddress": "0x…", "deployer": "0x…", "txHash": "0x…", "contract": "HTLC" } }
```
It is git-ignored by default so testnet runs don't churn the tree; commit a real
mainnet address deliberately with `git add -f deployments.json`. The relay
(`exchange/server`) loads this per-network address when building EVM swap legs.

> **Testnet-first.** Mainnet networks are configured so the deploy is one
> command for the key-holder, but every mainnet path stays gated on a recorded
> legal/compliance review. KYC/geo screening belongs at the off-chain
> fiat/custody boundary, not in this contract.
