#!/usr/bin/env bash
# Publish the Blockle Sui HTLC package. TESTNET-FIRST and mainnet-gated, mirroring
# the EVM (deploy.js) and Solana (set_mainnet) legs.
#
# Default target is Sui **testnet**. Publishing to mainnet is refused unless BOTH
#   HTLC_MAINNET_ENABLED=true
#   HTLC_LEGAL_REVIEW_REF=<recorded legal/compliance sign-off reference>
# are set — same contract as the other legs (see ../PROTOCOL.md §7).
#
# No secrets are read, written, or logged here. Publishing uses the active Sui
# CLI keypair (`sui client active-address`); keys never enter this repo.
#
# Usage:
#   ./scripts/deploy.sh                 # -> testnet (default)
#   SUI_ENV=devnet ./scripts/deploy.sh  # -> devnet
#   SUI_ENV=mainnet HTLC_MAINNET_ENABLED=true HTLC_LEGAL_REVIEW_REF=LR-123 ./scripts/deploy.sh
set -euo pipefail

SUI_ENV="${SUI_ENV:-testnet}"
GAS_BUDGET="${SUI_GAS_BUDGET:-100000000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$SUI_ENV" == "mainnet" ]]; then
  if [[ "${HTLC_MAINNET_ENABLED:-}" != "true" || -z "${HTLC_LEGAL_REVIEW_REF:-}" ]]; then
    echo "REFUSING mainnet publish: set HTLC_MAINNET_ENABLED=true and HTLC_LEGAL_REVIEW_REF=<ref>." >&2
    echo "Mainnet money paths require a recorded legal/compliance review (PROTOCOL.md §7)." >&2
    exit 1
  fi
  echo "MAINNET publish authorized by legal review ref: ${HTLC_LEGAL_REVIEW_REF}"
fi

command -v sui >/dev/null 2>&1 || { echo "sui CLI not found on PATH." >&2; exit 1; }

echo "== Building + testing before publish =="
( cd "$HERE" && sui move build && sui move test )

echo "== Switching Sui client env to: $SUI_ENV =="
sui client switch --env "$SUI_ENV" >/dev/null 2>&1 || sui client new-env --alias "$SUI_ENV" --rpc "https://fullnode.${SUI_ENV}.sui.io:443"
sui client switch --env "$SUI_ENV"

echo "Active address: $(sui client active-address)"
echo "Active env:     $(sui client active-env)"

echo "== Publishing package =="
# --json so a caller can parse the created package id; the Move.toml publishes
# blockle_htlc at a fresh on-chain id (named addresses are 0x0 at publish time).
sui client publish --gas-budget "$GAS_BUDGET" --json "$HERE"

cat <<'EOF'

Next steps:
  * Record the published packageId (objectType "package") from the JSON output.
  * Put it in the relay config as the Sui HTLC package id (testnet by default).
  * Clock object id is the well-known 0x6 on every network.
  * Keep the relay's Sui mainnet flag OFF until legal review (PROTOCOL.md §7).
EOF
