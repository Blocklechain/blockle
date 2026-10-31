# BLOCK-402 — Inference Oracle Standard

**Status:** draft v0.1 · **Layer:** Blockle Script (VM) convention + off-chain fulfiller ·
**Depends on:** Blockle Intelligence tier-2 inference subnet (`services/inference`), the x402 rail.

BLOCK-402 lets any **Blockle Script contract request AI inference** and receive the result in a
later callback. The number nods to **HTTP 402 Payment Required**: inference is paid work, so the
standard is payment-gated by construction.

**BLOCK-402 spends native BLOCK.** On-chain requests escrow and pay in **BLOCK** (base units) —
the miner earns BLOCK and the protocol fee is BLOCK to the treasury. (The separate
`blockle.org/api/inference` HTTP product is paid in USDC over x402, for external web/agent
buyers; that is the off-chain face. On-chain scripting uses BLOCK.)

Inference is **not** computable inside the deterministic VM (an LLM is neither deterministic nor
cheap), so BLOCK-402 is an **asynchronous request → off-chain fulfill → on-chain callback**
oracle — the only honest design. It never pretends the VM ran a model.

## Flow

```
 requester ──request(){ escrow maxFee BLOCK } ─▶ BLOCK-402 escrow contract
                                                      │ emits LOG(InferenceRequest, tag=2)
 Blockle Inference Gateway/fulfiller ◀────────────────┘  (watches tag-2 logs)
     │ runs inference via the tier-2 miner network (services/inference)
     └─ fulfill(requestId, resultHash, resultUri, feeUsedBLOCK) ─▶ escrow contract:
            • pay miner        = feeUsed − protocolFee   (BLOCK → miner address)
            • pay treasury     = protocolFee             (BLOCK → Alienbeing)
            • refund requester = maxFee − feeUsed        (BLOCK back)
            • call requester.fulfillInference(requestId, resultHash, resultUri)
```

## On-chain request — log tag `2`

A contract requests inference by emitting a `LOG` with this layout (mirrors the tag-1 NFT log
convention). All integers big-endian.

```
[ tag=2 (1) ‖ requestId(32) ‖ requester(32) ‖ callbackSelector(1) ‖ model/tier(1) ‖
  maxFeeBlock(8) ‖ promptHash(32) ‖ promptLen(2) ‖ prompt(promptLen) ]
```

- `requestId`     caller-chosen unique id (keys the result + escrow).
- `requester`     the contract that gets the callback + the refund.
- `callbackSelector`  the contract function the fulfiller calls back (see below).
- `model/tier`    requested model class (0 = any / cheapest that fits; else a `models.js` tier index).
- `maxFeeBlock`   **configurable fee** — BLOCK base units the requester escrowed and will pay at
  most. The fulfiller must refuse (and the escrow refund 100%) if the job's cost exceeds it.
- `promptHash`    `sha256(prompt)` — lets the callback prove which prompt produced the result.
- `prompt`        inline for short prompts; for long prompts emit `promptLen=0` and publish the
  prompt off-chain keyed by `promptHash` (the gateway accepts it via `/oracle/prompt`).

The escrow is attached as the request call's BLOCK **value** (`maxFeeBlock`), held by the
escrow contract until `fulfill` (which pays out + refunds) or an expiry refund.

## On-chain callback — the requester implements

```
fulfillInference(requestId(32), ok(1), resultHash(32), resultUriLen(2), resultUri(...))
```

- `resultHash`  `sha256(result)` — the contract can commit to / compare the answer on-chain.
- `resultUri`   `https://blockle.org/api/inference/result/<requestId>` — full text off-chain
  (results are large; chains store the hash, not the paragraphs).
- Only the registered **fulfiller address** may call `fulfillInference` (the requester checks
  `caller == BLOCK402_FULFILLER`). One fulfillment per `requestId` (idempotent).

## Fees ("configurable fees and proper stuff")

Three knobs, all explicit, all denominated in **BLOCK**:

| Fee | Who sets it | Where |
|---|---|---|
| `maxFeeBlock` | the **requester**, per call | escrowed as the request's BLOCK value |
| `feeBps` (protocol cut → treasury/Alienbeing) | operator | gateway `INFERENCE_FEE_BPS` |
| `feeUsedBlock` (actual charge ≤ maxFee) | the fulfiller, from the job cost | `fulfill` arg |
| miner share = `feeUsed − protocolFee` | derived | escrow contract |

On `fulfill` the escrow pays the miner (BLOCK) + the treasury protocol fee (BLOCK) and **refunds
`maxFee − feeUsed`** to the requester. If the fulfiller never answers before `expiryHeight`, the
requester can `reclaim(requestId)` for a full refund. Emission for the tier-2 inference subnet
remains **capped** (subjective tier) regardless of fee size.

## Implementation path (honest)

The on-chain escrow needs per-request mapping storage, byte-array logs, and
caller-based access control — none of which the minimal Blockle Script language
(`.bs`: u64-only state/args, scalar `log`) expresses. So, exactly like **BLOCK-20 / BLOCK-721 /
BLOCK-20S**, BLOCK-402 is implemented as a **Rust consensus action**, not a `.bs` script:

- `ContractAction::InferenceRequest { request_id, model, max_fee, prompt_hash, callback }`
  (payable — locks `max_fee` BLOCK in escrow, like a pool bond), and
- `ContractAction::InferenceFulfill { request_id, result_hash, result_uri, fee_used }`
  (fulfiller-only — pays miner + treasury, refunds the remainder, fires the callback), and
- `InferenceReclaim { request_id }` after `expiry_height`.

This ships **height-gated and dormant** (mainnet `u64::MAX`) in a FUTURE consensus upgrade with
its own activation height + tests — it is **not** retrofitted into the 18888 fork. That mirrors
how Blockle Intelligence itself was built ahead of activation. `chain/crates/vm/examples/block402.bs`
is a minimal *illustrative* escrow (single pending request, no access control) showing the
request→escrow→payout shape within today's language — not the production path.

## Fulfiller — live now (off-chain)

The Blockle Inference Gateway (`services/inference/src/server.js`) already provides the
off-chain half, usable today:
- `GET /api/inference/quote?tier=<n>` — price a job in BLOCK (from the tier cost and the
  operator `INFERENCE_BLOCK_USD` rate); the on-chain requester sets `max_fee ≥ quote`.
- `GET /api/inference/result/<requestId>` — the full result text (chains store only the hash).

When the consensus action lands, the fulfiller daemon watches `InferenceRequest`s, runs the job
on the tier-2 miner network, and submits `InferenceFulfill` from a dedicated fulfiller wallet;
the miner is paid in BLOCK from escrow and that BLOCK also feeds the tier-2 demand signal.

## Security notes

- Prompt/result integrity is via `promptHash`/`resultHash`; the chain never trusts the
  fulfiller's text blindly — a contract can require the hash to match.
- The fulfiller is a trusted oracle in v0.1 (single gateway). v0.2: N-of-M fulfiller quorum +
  the tier-2 validator's demand/quality scoring to slash a lying fulfiller.
- Never put secrets in a prompt — request logs and results are public.
