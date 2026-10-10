#!/usr/bin/env bash
# One-command deploy for the Blockle Solana HTLC leg. TESTNET-FIRST and
# mainnet-gated, mirroring the EVM (deploy.js) and Sui (deploy.sh) legs.
#
# Default target is Solana **devnet**. Deploying to mainnet-beta is refused
# unless BOTH
#   HTLC_MAINNET_ENABLED=true
#   HTLC_LEGAL_REVIEW_REF=<recorded legal/compliance sign-off reference>
# are set (PROTOCOL.md §7) — the same contract as the other legs.
#
# NO secrets are read, written, or logged here. The deployer keypair is read
# from ANCHOR_WALLET (a path to a Solana keypair json); keys never enter this
# repo. RPC + cluster come from deploy.config.json (overridable by env).
#
# Usage:
#   ANCHOR_WALLET=~/.config/solana/id.json ./scripts/deploy.sh                 # -> devnet (default)
#   SOLANA_CLUSTER=localnet ./scripts/deploy.sh                                # -> local validator
#   SOLANA_CLUSTER=mainnet-beta HTLC_MAINNET_ENABLED=true \
#     HTLC_LEGAL_REVIEW_REF=LR-123 ANCHOR_WALLET=... ./scripts/deploy.sh       # -> mainnet (gated)
#
# After a successful deploy the program id is written to
# deployments/<cluster>.json and printed as a ready-to-paste relay-config snippet.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$HERE/deploy.config.json"

jqget() { # jqget <jq-filter> ; reads $CFG. Falls back to node if jq is absent.
  if command -v jq >/dev/null 2>&1; then jq -r "$1 // empty" "$CFG"; else
    node -e 'const c=require(process.argv[1]);const p=process.argv[2].replace(/^\./,"").split(".").map(k=>k.replace(/^"|"$/g,""));let v=c;for(const k of p){if(k==="")continue;v=v&&v[k];}process.stdout.write(v==null?"":String(v));' "$CFG" "$1";
  fi
}

CLUSTER="${SOLANA_CLUSTER:-$(jqget '.defaultCluster')}"
CLUSTER="${CLUSTER:-devnet}"
RPC_URL="${SOLANA_RPC_URL:-$(jqget ".clusters.\"$CLUSTER\"")}"
RELAY_KEY="$(jqget ".relayKey.\"$CLUSTER\"")"; RELAY_KEY="${RELAY_KEY:-$CLUSTER}"

if [[ -z "$RPC_URL" ]]; then
  echo "No RPC URL for cluster '$CLUSTER' (set SOLANA_RPC_URL or add it to deploy.config.json)." >&2
  exit 1
fi

# --- mainnet gate -----------------------------------------------------------
if [[ "$CLUSTER" == "mainnet-beta" || "$CLUSTER" == "mainnet" ]]; then
  if [[ "${HTLC_MAINNET_ENABLED:-}" != "true" || -z "${HTLC_LEGAL_REVIEW_REF:-}" ]]; then
    echo "REFUSING mainnet deploy: set HTLC_MAINNET_ENABLED=true and HTLC_LEGAL_REVIEW_REF=<ref>." >&2
    echo "Mainnet money paths require a recorded legal/compliance review (PROTOCOL.md §7)." >&2
    exit 1
  fi
  echo "MAINNET deploy authorized by legal review ref: ${HTLC_LEGAL_REVIEW_REF}"
fi

# --- toolchain + keypair ----------------------------------------------------
command -v anchor >/dev/null 2>&1 || { echo "anchor CLI not found on PATH." >&2; exit 1; }
command -v solana >/dev/null 2>&1 || { echo "solana CLI not found on PATH." >&2; exit 1; }

WALLET="${ANCHOR_WALLET:-}"
if [[ -z "$WALLET" ]]; then
  echo "ANCHOR_WALLET is unset. Point it at the deployer keypair json, e.g." >&2
  echo "  export ANCHOR_WALLET=~/.config/solana/id.json" >&2
  exit 1
fi
if [[ ! -f "$WALLET" ]]; then echo "ANCHOR_WALLET='$WALLET' is not a file." >&2; exit 1; fi
export ANCHOR_WALLET="$WALLET"

DEPLOYER="$(solana address -k "$WALLET")"
echo "== Target: cluster=$CLUSTER rpc=$RPC_URL =="
echo "   Deployer: $DEPLOYER"

# --- balance / faucet -------------------------------------------------------
BAL="$(solana balance -k "$WALLET" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')"
echo "   Balance:  ${BAL:-unknown} SOL"
if [[ "$CLUSTER" == "devnet" ]] && awk "BEGIN{exit !(${BAL:-0} < 2)}"; then
  echo "   (devnet) requesting an airdrop to cover program rent + fees..."
  solana airdrop 2 "$DEPLOYER" --url "$RPC_URL" || \
    echo "   airdrop failed (rate-limited?) — fund $DEPLOYER via https://faucet.solana.com and re-run." >&2
fi

# --- optional operator-supplied program keypair -----------------------------
# By default `anchor build` generates a fresh program keypair (fresh program
# id) the first time. To deploy at a KNOWN/vanity id, point PROGRAM_KEYPAIR at
# your own keypair json; it is copied into place and never read from the repo.
if [[ -n "${PROGRAM_KEYPAIR:-}" ]]; then
  [[ -f "$PROGRAM_KEYPAIR" ]] || { echo "PROGRAM_KEYPAIR='$PROGRAM_KEYPAIR' is not a file." >&2; exit 1; }
  mkdir -p "$HERE/target/deploy"
  cp "$PROGRAM_KEYPAIR" "$HERE/target/deploy/htlc-keypair.json"
  echo "   Using operator-supplied program keypair."
fi

# --- build + sync declared id + deploy --------------------------------------
# CRITICAL: `anchor deploy` deploys the program AT the program-keypair address,
# but the on-chain program enforces that this equals the `declare_id!` baked
# into the .so. A fresh checkout's keypair will NOT match the committed
# declare_id, so every instruction would fail with DeclaredProgramIdMismatch.
# Sequence: build once (materialize the program keypair) -> keys sync (rewrite
# declare_id! + Anchor.toml to that keypair) -> build again (bake the synced id)
# -> deploy. This makes the deployed id == declared id on ANY machine.
echo "== Building (BPF) =="
( cd "$HERE" && anchor build )
echo "== Syncing declare_id! to the program keypair =="
( cd "$HERE" && anchor keys sync )
echo "== Rebuilding with the synced id =="
( cd "$HERE" && anchor build )

PROGRAM_ID="$(solana address -k "$HERE/target/deploy/htlc-keypair.json")"
DECLARED="$(grep -oE 'declare_id!\("[^"]+"\)' "$HERE/programs/htlc/src/lib.rs" | sed -E 's/.*"(.*)".*/\1/')"
if [[ "$PROGRAM_ID" != "$DECLARED" ]]; then
  echo "declare_id ($DECLARED) still != program keypair ($PROGRAM_ID) after sync; aborting." >&2
  exit 1
fi
echo "== Deploying program $PROGRAM_ID to $CLUSTER (declare_id matches) =="
( cd "$HERE" && anchor deploy \
    --provider.cluster "$RPC_URL" \
    --provider.wallet "$WALLET" )

# --- capture deployment -----------------------------------------------------
mkdir -p "$HERE/deployments"
OUT="$HERE/deployments/$CLUSTER.json"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$OUT" <<EOF
{
  "cluster": "$CLUSTER",
  "rpcUrl": "$RPC_URL",
  "programId": "$PROGRAM_ID",
  "deployer": "$DEPLOYER",
  "deployedAt": "$DEPLOYED_AT",
  "relayConfigPath": "exchange/server/config.json -> htlc.solana.$RELAY_KEY",
  "note": "initialize(fee_bps, fee_wallet) must still be called once; mainnet_enabled stays false until set_mainnet after legal review."
}
EOF
echo "== Wrote $OUT =="

cat <<EOF

Next steps:
  1. One-time config init (idempotent per program):
       initialize(fee_bps=$(jqget '.fee.feeBps'), fee_wallet=<PUBLIC fee address>)
     Leave Config.mainnet_enabled = false. (SPL/SOL money paths run on $CLUSTER.)
  2. Wire the relay — set in exchange/server/config.json:
       { "htlc": { "solana": { "$RELAY_KEY": "$PROGRAM_ID" } } }
     The relay holds NO key; this is the public program id each wallet calls.
  3. Keep the relay's Solana mainnet leg OFF until a recorded legal review
     (PROTOCOL.md §7). On mainnet, flip on-chain via set_mainnet(true) only then.
EOF
