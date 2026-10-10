#!/usr/bin/env bash
# One-command, gated testnet/mainnet publish for the Blockle Sui HTLC leg.
# TESTNET-FIRST and mainnet-gated, mirroring the EVM (deploy.js) and Solana
# (set_mainnet) legs.
#
#   ./scripts/deploy.sh                 # -> Sui testnet (default)
#   SUI_ENV=devnet  ./scripts/deploy.sh # -> Sui devnet
#   SUI_ENV=mainnet HTLC_MAINNET_ENABLED=true HTLC_LEGAL_REVIEW_REF=LR-123 \
#       ./scripts/deploy.sh             # -> Sui mainnet (GATED, see below)
#
# KEYS: none are read, written, or logged here. Publishing uses the ACTIVE Sui
# CLI keypair from the local keystore (`sui client active-address`); the key
# never enters this repo. Fund that address first (see README).
#
# RPC/NETWORK: taken from the Sui client env (`sui client switch --env`). If the
# env alias is missing it is created pointing at the public fullnode
# https://fullnode.<env>.sui.io:443. Override with SUI_RPC_URL.
#
# OUTPUT: on success the published packageId is PRINTED and written to
# deployments.json (keyed by env) so the relay can consume it. deployments.json
# is git-ignored by default — commit a real id deliberately with
#   git add -f deployments.json
#
# MAINNET IS GATED. A mainnet publish is refused unless BOTH
#   HTLC_MAINNET_ENABLED=true
#   HTLC_LEGAL_REVIEW_REF=<recorded legal/compliance sign-off reference>
# are set — same contract as the other legs (see ../PROTOCOL.md §7).
set -euo pipefail

SUI_ENV="${SUI_ENV:-testnet}"
GAS_BUDGET="${SUI_GAS_BUDGET:-100000000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${SUI_RPC_URL:-https://fullnode.${SUI_ENV}.sui.io:443}"
# Sui system Clock object; the well-known 0x6 on every network.
CLOCK_OBJECT_ID="0x0000000000000000000000000000000000000000000000000000000000000006"

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

echo "== Switching Sui client env to: $SUI_ENV ($RPC_URL) =="
sui client switch --env "$SUI_ENV" >/dev/null 2>&1 \
  || sui client new-env --alias "$SUI_ENV" --rpc "$RPC_URL"
sui client switch --env "$SUI_ENV"

ACTIVE_ADDR="$(sui client active-address)"
echo "Active address: $ACTIVE_ADDR"
echo "Active env:     $(sui client active-env)"

# Fail early with a clear message if the active address can't pay for gas,
# rather than deep inside the publish tx. (Testnet: use `sui client faucet`.)
if ! sui client gas --json >/dev/null 2>&1; then
  echo "WARNING: could not read gas coins for $ACTIVE_ADDR on $SUI_ENV." >&2
  echo "         Fund it first (testnet/devnet: 'sui client faucet'; mainnet: send SUI)." >&2
fi

echo "== Publishing package =="
RAW_JSON="$(mktemp -t blockle-sui-publish.XXXXXX.json)"
trap 'rm -f "$RAW_JSON"' EXIT
# --json so the packageId can be parsed; Move.toml publishes blockle_htlc at a
# fresh on-chain id (the named address is 0x0 at publish time).
sui client publish --gas-budget "$GAS_BUDGET" --json "$HERE" | tee "$RAW_JSON"

# --- capture the packageId -------------------------------------------------
# The published package appears in objectChanges as {"type":"published", ...}.
extract_pkg() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.objectChanges[]? | select(.type=="published") | .packageId' "$RAW_JSON" | head -n1
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$RAW_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for c in d.get("objectChanges", []) or []:
    if c.get("type") == "published":
        print(c.get("packageId", "")); break
PY
  fi
}
extract_digest() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.digest // empty' "$RAW_JSON"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$RAW_JSON" <<'PY'
import json, sys
print(json.load(open(sys.argv[1])).get("digest", "") or "")
PY
  fi
}

PACKAGE_ID="$(extract_pkg || true)"
TX_DIGEST="$(extract_digest || true)"

if [[ -z "${PACKAGE_ID:-}" ]]; then
  echo "Could not auto-parse the packageId (install jq or python3 to persist it)." >&2
  echo 'Find it manually: objectChanges[] where type=="published" -> packageId.' >&2
  exit 0
fi

echo ""
echo "Published packageId: $PACKAGE_ID"

# --- persist for the relay (merge, keyed by env) ---------------------------
OUT="$HERE/deployments.json"
python3 - "$OUT" "$SUI_ENV" "$PACKAGE_ID" "$ACTIVE_ADDR" "$RPC_URL" "$CLOCK_OBJECT_ID" "$TX_DIGEST" <<'PY'
import json, sys, datetime, os
out, env, pkg, addr, rpc, clock, digest = sys.argv[1:8]
try:
    all = json.load(open(out))
except Exception:
    all = {}
all[env] = {
    "network": env,
    "packageId": pkg,
    "module": "htlc",
    "clockObjectId": clock,
    "rpcUrl": rpc,
    "publisher": addr,
    "txDigest": digest or None,
    "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
with open(out, "w") as f:
    json.dump(all, f, indent=2); f.write("\n")
print("Wrote", os.path.relpath(out, os.path.dirname(os.path.dirname(out))))
PY

cat <<EOF

Next steps:
  * packageId is recorded in deployments.json under "$SUI_ENV".
  * Point the relay's Sui HTLC package id at it (relay reads deployments.json).
  * Clock object id is the well-known 0x6 (recorded above) on every network.
  * Keep the relay's Sui mainnet flag OFF until legal review (PROTOCOL.md §7).
EOF
