# blockle-neuron — reference Tier-0 subnet daemon

The honest "useful work" piece of **Blockle Intelligence**. It runs two roles:

- **miner** — serves a deterministic, checkable task over HTTP (answers beacon-derived challenges).
- **validator** — each epoch, fetches the subnet's miners + the epoch beacon from the node RPC,
  scores miners by **recomputing** their answers (proof-of-**correctness**, not just liveness),
  and drives the on-chain `commit → reveal → validate` flow via the `blockle intel` CLI.

Because the task is **Tier-0** (its correctness is a pure function of public inputs), a miner that
fakes answers scores exactly **0** — emission tracks provably-correct output, not mere uptime.

## The task (`src/task.js`)

Iterated SHA-256 over a challenge derived from `(beacon, round, minerUid)` — a lightweight
proof-of-sequential-work. `verify()` recomputes and compares. Swap this one module to define
other Tier-0 tasks (hash-preimage, structured retrieval, etc.).

## Scoring (`src/validator.js`)

`score(beacon, round, miners, ask, iters)` → `{ uids, weights, detail }`. Correct answers earn
`1/(1+latency)`, wrong/absent earn 0; weights are normalized to `SCALE = 1_000_000` (integer,
summing exactly — matches the on-chain fixed-point consensus) and formatted with `weightsArg()`
for `blockle intel commit-weights --weights`.

## Run it

```bash
# prove the task + scoring loop with NO chain and NO network:
npm run self-test          # honest miner → all weight; cheater + offline → 0

# serve the task (a miner):
node src/index.js --role miner --port 8812 --iters 50000

# validator pass against a testnet node (dry-run prints the CLI it WOULD run):
node src/index.js --role validator --subnet 0 --node http://127.0.0.1:8445
# add --submit (and --bin blockle-chain --datadir <dir>) to actually sign + broadcast.
```

Miner discovery (hotkey → URL) is deployment-specific; wire `bytesToUrl` in `src/index.js` to
your registry/DNS. On-chain submission needs a running testnet node with the intel RPC
(`intel_activation_height` reached). Mainnet ships dormant (`u64::MAX`) until the Phase-5 audit.

See `docs/BLOCKLE-INTELLIGENCE.md` §4 (verifiability tiers) and the runbook §C.
