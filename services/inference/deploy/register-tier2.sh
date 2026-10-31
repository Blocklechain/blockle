#!/usr/bin/env bash
# One-shot watcher: wait until the mainnet chain reaches the Blockle Intelligence
# activation height, then register the Tier-2 inference subnet in the very next block.
# Idempotent via a marker file; safe to restart.
set -euo pipefail

BIN="${BLK_BIN:-/opt/blockle/chain/target/release/blockle-chain}"
DATADIR="${BLK_DATADIR:-/var/lib/blockle-pool}"      # the mining pool wallet (funded)
NODE="${BLK_NODE:-127.0.0.1:18444}"                  # pool node P2P (submit target)
RPC="${BLK_RPC:-http://127.0.0.1:9790/}"
ACT="${BLK_ACT_HEIGHT:-18888}"                        # intel_activation_height (mainnet)
MARKER="${BLK_MARKER:-/var/lib/blockle-inference/tier2-registered}"

mkdir -p "$(dirname "$MARKER")"
if [ -f "$MARKER" ]; then echo "tier-2 subnet already registered ($(cat "$MARKER")); nothing to do"; exit 0; fi

echo "waiting for mainnet height >= $ACT to register the tier-2 inference subnet…"
while true; do
  H=$(curl -s --data '{"method":"getblockcount","params":[],"id":1}' "$RPC" | grep -o '"result":[0-9]*' | cut -d: -f2 || true)
  if [ -n "${H:-}" ] && [ "$H" -ge "$ACT" ] 2>/dev/null; then
    echo "height $H >= $ACT — registering Tier-2 (subjective/inference) subnet"
    if "$BIN" --network mainnet --datadir "$DATADIR" intel register-subnet --tier 2 --node "$NODE"; then
      date -u +"%Y-%m-%dT%H:%M:%SZ height=$H" > "$MARKER"
      echo "registered; marker written to $MARKER"
      exit 0
    fi
    echo "register-subnet failed; retrying in 30s"
  fi
  sleep 30
done
