#!/usr/bin/env bash
# One-command deploy for the BLOCK leg — the ONE HTLC leg WE can deploy, from
# our own reserve/node. Emits the HTLC assembly with the reserve fee address
# baked in, then deploys it through the `blockle-chain` CLI as a BLOCK-VM
# contract and prints the contract id to put in the relay config.
#
# TESTNET-FIRST and mainnet-gated, mirroring the EVM/Solana/Sui legs. The
# default network is `regtest`; publishing to `mainnet` is refused unless BOTH
#   HTLC_MAINNET_ENABLED=true
#   HTLC_LEGAL_REVIEW_REF=<recorded legal/compliance sign-off reference>
# are set (PROTOCOL.md §7).
#
# NO private key is read, written, or logged here. The deploy tx is funded +
# signed by the wallet in the node's --datadir (the operator's reserve wallet);
# the passphrase comes from BLOCKLE_WALLET_PASSPHRASE or an interactive prompt.
#
# Required:
#   FEE_ADDR   32-byte hex: the PUBLIC reserve/treasury BLOCK address that
#              receives the 0.1% settlement fee.
# Optional:
#   FEE_BPS    settlement fee, default 10 (0.1%; capped at 1% in the VM).
#   NETWORK    regtest (default) | mainnet
#   DATADIR    node data dir holding the reserve wallet (default .blockle)
#   NODE       P2P address of a running node to submit through (else local mempool)
#   GAS        deploy gas limit (default 300000)
#
# Usage:
#   FEE_ADDR=<hex32> ./scripts/deploy.sh
#   FEE_ADDR=<hex32> NETWORK=mainnet HTLC_MAINNET_ENABLED=true HTLC_LEGAL_REVIEW_REF=LR-123 \
#     DATADIR=/var/lib/blockle NODE=1.2.3.4:8444 ./scripts/deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
NETWORK="${NETWORK:-regtest}"
FEE_BPS="${FEE_BPS:-10}"
GAS="${GAS:-300000}"
DATADIR="${DATADIR:-.blockle}"

if [[ -z "${FEE_ADDR:-}" ]]; then
  echo "ERROR: set FEE_ADDR=<32-byte hex reserve/treasury address>." >&2
  exit 1
fi

if [[ "$NETWORK" == "mainnet" ]]; then
  if [[ "${HTLC_MAINNET_ENABLED:-}" != "true" || -z "${HTLC_LEGAL_REVIEW_REF:-}" ]]; then
    echo "REFUSING mainnet deploy: set HTLC_MAINNET_ENABLED=true and HTLC_LEGAL_REVIEW_REF=<ref>." >&2
    echo "Mainnet money paths require a recorded legal/compliance review (PROTOCOL.md §7)." >&2
    exit 1
  fi
  echo "MAINNET deploy authorized by legal review ref: ${HTLC_LEGAL_REVIEW_REF}"
fi

OUT="$(mktemp -t blockle-htlc.XXXXXX.asm)"
trap 'rm -f "$OUT"' EXIT

echo "== Emitting HTLC assembly (fee_addr baked in, FEE_BPS=$FEE_BPS) =="
( cd "$HERE" && FEE_ADDR="$FEE_ADDR" FEE_BPS="$FEE_BPS" \
    cargo run --quiet --bin htlc-asm ) > "$OUT"
echo "   -> $(wc -c <"$OUT") bytes of .asm"

echo "== Deploying via blockle-chain (network=$NETWORK, datadir=$DATADIR, gas=$GAS) =="
NODE_ARGS=()
[[ -n "${NODE:-}" ]] && NODE_ARGS=(--node "$NODE")

# Build the CLI once (bin name is `blockle-chain`, crate blockle-node).
( cd "$REPO_ROOT" && cargo build --quiet -p blockle-node --bin blockle-chain )
BIN="$REPO_ROOT/target/debug/blockle-chain"

"$BIN" --network "$NETWORK" --datadir "$DATADIR" \
  contract deploy "$OUT" --gas "$GAS" "${NODE_ARGS[@]}"

cat <<'EOF'

Next steps:
  * Copy the printed "contract id: <hex>" value.
  * Put it in the relay config as the BLOCK HTLC contract id:
        exchange/server/config.json  ->  htlc.block.contractId
      or env  BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT=<hex>
  * Keep the relay's mainnet gate OFF (mainnetEnabled=false) until legal review.
EOF
