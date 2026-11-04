#!/usr/bin/env bash
# Create the wBLOCK devnet mint with the operator key, wire it into the bridge
# env, enable the relayer, and restart. Idempotent-ish: refuses if a mint is
# already set. Run only after the operator keypair has devnet SOL.
set -euo pipefail
cd /opt/blockle/services/bridge
if grep -q "^BRIDGE_wBLOCK_MINT=..*" /opt/blockle/secrets/bridge.env; then
  echo "mint already configured; aborting"; exit 0
fi
echo "creating wBLOCK devnet mint…"
MINT=$(BRIDGE_SOLANA_CLUSTER=devnet BRIDGE_SOLANA_SENDS_ENABLED=1 \
  BRIDGE_SOLANA_RPC_URL=https://api.devnet.solana.com \
  BRIDGE_SOLANA_KEYPAIR=/opt/blockle/secrets/bridge-solana.json \
  node --input-type=module -e "
import { createSolblockMint, loadSolanaConfig } from \"./solana/mint.js\";
const r = await createSolblockMint({ cfg: loadSolanaConfig(), execute: true });
if (r.dryRun || !r.mint) { console.error(\"FAILED: \"+(r.note||\"no mint\")); process.exit(1); }
console.log(r.mint);
")
echo "mint=$MINT"
# wire into env + enable relayer
sed -i "s|^# BRIDGE_wBLOCK_MINT=.*|BRIDGE_wBLOCK_MINT=$MINT|" /opt/blockle/secrets/bridge.env
sed -i "s|^# BRIDGE_RELAYER_ENABLED=1|BRIDGE_RELAYER_ENABLED=1|" /opt/blockle/secrets/bridge.env
systemctl restart bridge
sleep 3
echo "--- /info ---"
curl -s --max-time 8 http://127.0.0.1:8797/api/bridge/info
