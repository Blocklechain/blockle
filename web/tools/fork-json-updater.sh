#!/usr/bin/env bash
# Refresh /opt/blockle/web/fork.json from the live BLOCK node so the site's
# fork-countdown banner always shows the real block height. Run once a minute
# from cron. Degrades gracefully: if the node is the pre-fork binary (no
# cross_algo_* fields yet) it still computes blocks-remaining from the height
# against the known activation height 53,000.
set -euo pipefail

OUT="${FORK_JSON_OUT:-/opt/blockle/web/fork.json}"
RPC="${BLOCKLE_RPC:-http://127.0.0.1:9790/}"
ACT_DEFAULT=53000

RESP="$(curl -s --max-time 8 -H 'content-type: application/json' \
  -d '{"jsonrpc":"1.0","id":"fork","method":"getblockchaininfo","params":[]}' \
  "$RPC" 2>/dev/null || true)"

python3 - "$RESP" "$ACT_DEFAULT" > "$OUT.tmp" <<'PY' && mv "$OUT.tmp" "$OUT"
import sys, json, time
raw = sys.argv[1]
act_default = int(sys.argv[2])
d = {}
try:
    d = json.loads(raw).get("result", {}) or {}
except Exception:
    d = {}
height = d.get("blocks")
act = d.get("cross_algo_activation_height", act_default)
rem = d.get("cross_algo_blocks_remaining")
active = d.get("cross_algo_active")
if height is not None:
    if rem is None:
        rem = max(0, act - height)
    if active is None:
        active = height >= act
print(json.dumps({
    "height": height,
    "activation_height": act,
    "blocks_remaining": rem,
    "active": active,
    "updated": int(time.time()),
}))
PY
