# Blockle Beacon

A new x402 product suite at **blockle.org/api/beacon** that turns BLOCK proof-of-work
into useful services (separate from the exchange rail).

## Products

### 1. `POST /api/beacon/random` — verifiable randomness (x402)
Commit-reveal anchored to BLOCK PoW:
- On payment, the server **commits** a `roundId` + a 32-byte `salt` to a **future**
  block height (`tip + confirmDelay`) and returns them immediately.
- Once that block is mined, `GET /api/beacon/round/:id` reveals
  `randomness = sha256( salt [‖ clientSeed] ‖ blockHash@targetHeight )`
  as hex / uint256 / float.
- **Trustless + verifiable:** the salt is published before the block exists (operator
  can't grind), the block hash is PoW-fixed (requester can't grind), and anyone
  recomputes the sha256 from public inputs. Pass an optional `clientSeed` (hex) to add
  your own entropy to the mix.

### 2. `POST /api/beacon/infer` — beacon-seeded inference (x402)
Paid generation on the hosted model (`blockle-agent` via Ollama). Optionally bind a
beacon round (`seedRound`) or raw `seedHex`; the derived value is injected as a
**public, tamper-proof seed**.

> **Honest limitation:** the SEED is verifiable, but the **OUTPUT is not**. This CPU
> inference backend is **not bit-reproducible** (same seed/prompt can differ by a
> token), so a third party cannot cryptographically replay the exact bytes. This is
> **provably-fair-seeded** generation, **not** verifiable inference. True verifiable
> inference would need a deterministic runtime, a TEE attestation, or ZKML.

## Free endpoints
- `GET /api/beacon/round/:id` — reveal / status of a round
- `GET /api/beacon/health`
- `GET /api/beacon/.well-known/x402` — discovery manifest

## Config (env / `/opt/blockle/secrets/beacon.env`)
`BEACON_NETWORK` (base-sepolia default; `base` + `BEACON_MAINNET_OK=1` for mainnet),
`BEACON_PAYTO` (USDC recipient), `BEACON_FACILITATOR`, `BEACON_EXPLORER`,
`BEACON_OLLAMA`, `BEACON_MODEL`, `BEACON_CONFIRM_DELAY`, `BEACON_PRICE_RANDOM`,
`BEACON_PRICE_INFER`. The x402 npm SDK is resolved via `NODE_PATH` →
`services/x402-buy/node_modules`.
