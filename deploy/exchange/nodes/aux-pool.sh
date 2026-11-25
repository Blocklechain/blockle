#!/usr/bin/env bash
#
# Stand up a mining pool on one of the exchange's coin nodes that merge-mines
# BLOCK alongside it.
#
#     aux-pool.sh plan                 what can and cannot merge-mine, and why
#     aux-pool.sh create <SYM> <solo|pplns>
#     aux-pool.sh gate                 start any pool whose parent has synced
#     aux-pool.sh status
#
# WHICH COINS CAN DO THIS, AND WHY IT IS NOT A MATTER OF OPINION.
#
# Merged mining needs ONE hash to satisfy two chains' targets. The parent chain
# needs no AuxPoW support at all — the pool just puts BLOCK's commitment in the
# parent's coinbase, the way Namecoin rides Bitcoin. What it does need is for
# the parent's proof-of-work function to be one BLOCK also accepts:
#
#     sha256d  scrypt  x11  blake2b  blake2s  blake3  eaglesong  kheavyhash
#
# So the only question per coin is "what is its PoW?", and `plan` answers it by
# measurement rather than from a marketing page. Two traps cost a wrong answer
# each on the way to getting that measurement right:
#
#   1. A coin's BLOCK HASH is not its PoW HASH. In the Litecoin and Dogecoin
#      lineage the block identifier is sha256d of the header while mining is
#      scrypt — so "which hash reproduces the block id?" answers sha256d for
#      PEP, RTM and DINGO alike, and is the wrong question. The right one is
#      which hash lands under the block's own difficulty target.
#
#   2. Even that must not be asked of one block. PEP and DINGO are themselves
#      AuxPoW chains, so on a merge-mined block the work sits in an embedded
#      parent header and the coin's own header hashes to nothing useful. DINGO
#      measured as scrypt at height 1,888 and as "unsupported" a few thousand
#      blocks later, purely by how its tip happened to be mined. `plan` walks
#      back through a sample of blocks and takes the first that resolves.
#
# As measured on this host:
#
#     PEP    scrypt    -> can merge-mine BLOCK
#     DINGO  scrypt    -> can merge-mine BLOCK
#     RTM    other     -> GhostRider, no BLOCK lane
#     MEWC   other     -> MeowPow, no BLOCK lane
#     NEOX   other     -> KawPow, no BLOCK lane
#     ZEPH   other     -> RandomX, and not bitcoin-family anyway
#
# `plan` re-runs this rather than trusting the table.
#
# NO WALLET ON THE SERVING NODE. These same daemons are what the exchange
# reconciles against, and chains.ts reads a bitcoin-family balance from the
# WALLET (`getbalances` -> mine.trusted). Put a pool hot wallet on one of them
# and mining income becomes indistinguishable from customer custody — a
# shortfall in custody would hide behind pool earnings. So the coinbase pays a
# `payout_script` for an address whose keys live in a detached wallet that no
# running service attaches to, and the nodes stay `disablewallet=1`.
#
# That costs nothing in function: per ledger.rs, the pool engine computes and
# freezes payout ATTRIBUTION, and "executing payouts is chain-specific and left
# to the operator" — exactly as it already is for the dash, dogecoin and perbug
# pools.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODES="$HERE/nodes.json"
COINS=/opt/blockle/coins
DATA=/var/lib/blockle-coins
POOLS=/var/lib/blockle-pools
WALLETS=/var/lib/blockle-pool-wallets
BLOCKLE=/opt/blockle/target/release/blockle
BIZ=http://127.0.0.1:8900
BLOCK_AUX_RPC=http://127.0.0.1:8445/
BLOCK_CHAIN_ID=16972

die() { echo "error: $*" >&2; exit 1; }

# The lanes BLOCK will accept aux work on. Read from the chain source, not
# retyped: a lane added or removed there must not silently diverge from here.
LANES="sha256d scrypt x11 blake2b blake2s blake3 eaglesong kheavyhash"

jq_get() { python3 -c "
import json,sys
d=json.load(open('$NODES'))
v=d.get(sys.argv[1],{}).get(sys.argv[2],'')
print('' if v is None else v)
" "$1" "$2"; }

# The next unbound TCP port at or after $1.
#
# WHY THIS IS NOT JUST ARITHMETIC. The first version computed a port from the
# coin's index and trusted it. That put Dingocoin's solo pool on 3362 — which
# the BLOCK node itself already binds, as one of its eight
# stratum-direct-pplns lanes (3360-3367) — and the pool restart-looped 528
# times on "Address already in use" before anyone looked.
#
# This is the SECOND time a computed port collided in this stack; the first was
# two Ravencoin forks sharing a P2P default. A formula that does not check is a
# formula that is wrong eventually, so now it checks.
free_port() {
	local p="$1" limit=$(( $1 + 200 ))
	while [[ $p -lt $limit ]]; do
		if ! ss -tlnH "sport = :$p" 2>/dev/null | grep -q .; then
			echo "$p"; return 0
		fi
		p=$(( p + 1 ))
	done
	die "no free port found at or after $1"
}

cli_for() {
	local c="$1"
	ls "$COINS/$c"/*-cli 2>/dev/null | head -1
}

# ---------------------------------------------------------------- measurement

# Which PoW does this coin actually use? Answered from a live header and its
# own difficulty target. Prints a lane name, or "unsupported".
measure_algo() {
	local c="$1" exe d
	exe="$(cli_for "$c")" || true
	d="$DATA/$c"
	[[ -n "${exe:-}" && -x "$exe" ]] || { echo "no-cli"; return; }
	python3 - "$exe" "$d" "$c" <<'PYEOF'
import binascii, hashlib, struct, subprocess, sys
exe, d, c = sys.argv[1], sys.argv[2], sys.argv[3]

def cli(*a):
    # A DAEMON THAT DOES NOT ANSWER MUST NOT TAKE THE REPORT WITH IT.
    #
    # Meowcoin, busy with initial block download, blocked past the timeout and
    # the raised TimeoutExpired aborted the whole `plan` run — so Dingocoin,
    # listed after it, was never measured at all. One slow node silently cost
    # the answer for another.
    try:
        r = subprocess.run([exe, f"-conf={d}/{c}.conf", f"-datadir={d}", *a],
                           capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return ""
    except OSError:
        return ""
    return r.stdout.strip()

def val(b):
    # A PoW hash is compared to the target as a little-endian integer.
    return int.from_bytes(b[::-1], "big")

def sha256d(b):
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()

def candidates(hdr80):
    yield "sha256d", sha256d(hdr80)
    try:
        yield "scrypt", hashlib.scrypt(hdr80, salt=hdr80, n=1024, r=1, p=1, dklen=32)
    except Exception:
        pass

tip = cli("getblockcount")
if not tip.isdigit():
    print("no-rpc"); sys.exit()
tip = int(tip)

# SAMPLE RECENT BLOCKS, THEN EARLY ONES.
#
# PEP and DINGO are Dogecoin-lineage chains, which means they are themselves
# AuxPoW-capable: on a merge-mined block the proof-of-work is carried in a
# PARENT chain's header embedded in the coinbase, so hashing the coin's OWN
# header does not land under the target.
#
# TWO BUGS LIVED HERE, both found by this answering wrongly in production.
#
# The first was testing only the tip: the same chain answered scrypt at height
# 1,888 and unsupported a few thousand blocks later, purely by how that one
# block happened to be mined.
#
# The second was the fix for the first. It strode backwards by `tip // 200`
# over a 4,000-block window — which at Dingocoin's height of 2.85M is a stride
# of 14,252, so the loop ran exactly ONCE, on the tip, and reported
# "unsupported" for a chain that had been correctly measured as scrypt an hour
# earlier. A sampling window smaller than its own stride samples one point.
#
# So: walk back one block at a time over a short window, and if every one of
# those is merge-mined, fall back to the chain's EARLIEST blocks. Those predate
# AuxPoW activation on any chain that has it, so they are natively mined and
# reveal the real algorithm. A chain that is 100% merge-mined today still has a
# native beginning.
def scan(heights):
    for h in heights:
        bh = cli("getblockhash", str(h))
        if not bh:
            continue
        hdr_hex = cli("getblockheader", bh, "false")
        if not hdr_hex:
            continue
        hdr = binascii.unhexlify(hdr_hex)
        if len(hdr) < 80:
            continue
        bits = struct.unpack("<I", hdr[72:76])[0]
        exp, mant = bits >> 24, bits & 0xffffff
        if exp < 3:
            continue
        target = mant * (1 << (8 * (exp - 3)))
        for nm, dig in candidates(hdr[:80]):
            if val(dig) <= target:
                return nm
    return None

recent = range(tip, max(0, tip - 60), -1)
early = range(1, min(tip, 60))
found = scan(recent) or scan(early)
if found:
    print(found)
else:
    print("unsupported")
PYEOF
}

cmd_plan() {
	printf "%-7s %-10s %-9s %s\n" COIN POW MERGEABLE WHY
	local sym c algo
	for sym in $(python3 -c "
import json; print(' '.join(k for k in json.load(open('$NODES')) if not k.startswith('_')))"); do
		c="${sym,,}"
		[[ -d "$DATA/$c" ]] || continue
		algo="$(measure_algo "$c")"
		case "$algo" in
			no-cli|no-rpc|no-header)
				printf "%-7s %-10s %-9s %s\n" "$sym" "?" "unknown" \
					"daemon not answering yet ($algo) — re-run once it is synced" ;;
			unsupported)
				printf "%-7s %-10s %-9s %s\n" "$sym" "other" "no" \
					"PoW is not one of: $LANES" ;;
			*)
				if [[ " $LANES " == *" $algo "* ]]; then
					printf "%-7s %-10s %-9s %s\n" "$sym" "$algo" "YES" \
						"BLOCK accepts aux work on the $algo lane"
				else
					printf "%-7s %-10s %-9s %s\n" "$sym" "$algo" "no" "no BLOCK $algo lane"
				fi ;;
		esac
	done
}

# ------------------------------------------------------------------ the wallet

# An address for the coinbase, minted by the chain's OWN code so the encoding
# is authoritative rather than a version byte copied off a wiki. The daemon is
# run with no network and no listener: it exists to create a keypair, nothing
# else, and is stopped immediately.
ensure_pool_address() {
	local c="$1" d daemon rpcport W out
	W="$WALLETS/$c"
	if [[ -s "$W/address" && -s "$W/script" ]]; then
		return 0 # already minted; never mint twice, that orphans coins
	fi
	daemon="$(ls "$COINS/$c"/*d 2>/dev/null | head -1)" || die "$c: no daemon"
	rpcport="$(( $(jq_get "${c^^}" rpcPort) + 900 ))"
	install -d -m 700 "$WALLETS" "$W"
	"$daemon" -datadir="$W" -listen=0 -connect=0 -dnsseed=0 \
		-rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport="$rpcport" \
		-rpcuser=gen -rpcpassword=gen -daemon >/dev/null 2>&1 || true
	local cli addr spk i
	cli="$(cli_for "$c")"
	for i in $(seq 1 30); do
		addr="$("$cli" -rpcport="$rpcport" -rpcuser=gen -rpcpassword=gen getnewaddress 2>/dev/null || true)"
		[[ -n "$addr" ]] && break
		sleep 2
	done
	[[ -n "${addr:-}" ]] || die "$c: could not mint a pool address"
	spk="$("$cli" -rpcport="$rpcport" -rpcuser=gen -rpcpassword=gen validateaddress "$addr" \
		| python3 -c 'import sys,json; print(json.load(sys.stdin).get("scriptPubKey",""))')"
	"$cli" -rpcport="$rpcport" -rpcuser=gen -rpcpassword=gen stop >/dev/null 2>&1 || true
	sleep 3
	[[ "$spk" =~ ^76a914[0-9a-f]{40}88ac$ ]] || die "$c: unexpected script $spk"
	printf '%s\n' "$addr" > "$W/address"
	printf '%s\n' "$spk" > "$W/script"
	chmod -R go-rwx "$WALLETS"
	echo "    minted $addr"
	cat >"$W/README" <<EOF
BACK THIS DIRECTORY UP, THEN TAKE THE BACKUP OFF THIS HOST.

wallet.dat here holds the only key to $addr, which is where the $c pool's
coinbase is paid. Lose it and every coin the pool has ever mined becomes
unspendable; there is no second copy and no recovery path.

No service attaches to this wallet. It is deliberately detached: the $c daemon
the exchange reconciles against runs with disablewallet=1, because a bitcoin-
family balance is read from the wallet and pool income sitting in the same
wallet as customer custody would let a custody shortfall hide behind it.

Paying miners out of here is an operator action (see ledger.rs: attribution is
computed and frozen by the pool, executing payment is not).
EOF
}

# ------------------------------------------------------------------- create

cmd_create() {
	local sym="${1:-}" scheme="${2:-solo}"
	[[ -n "$sym" ]] || die "usage: aux-pool.sh create <SYMBOL> <solo|pplns>"
	[[ "$scheme" == solo || "$scheme" == pplns ]] || die "scheme must be solo or pplns"
	local c="${sym,,}" name algo
	name="$(jq_get "$sym" name)"; [[ -n "$name" ]] || die "unknown coin $sym"

	# THE GATE. A pool on a chain BLOCK cannot accept aux work for would mine
	# the parent and quietly produce no BLOCK at all, which is worse than
	# refusing: miners would point hashrate at it expecting both.
	algo="$(measure_algo "$c")"
	[[ " $LANES " == *" $algo "* ]] \
		|| die "$sym PoW is '$algo'; BLOCK has no such aux lane, so it cannot merge-mine"
	echo "==> $sym ($name) $scheme, $algo lane"

	ensure_pool_address "$c"
	local script addr
	script="$(cat "$WALLETS/$c/script")"
	addr="$(cat "$WALLETS/$c/address")"

	# RPC credentials come from the node's own conf; they are never stored here.
	local rpcuser rpcpass rpcport
	rpcport="$(jq_get "$sym" rpcPort)"
	rpcuser="$(sed -n 's/^rpcuser=//p' "$DATA/$c/$c.conf")"
	rpcpass="$(sed -n 's/^rpcpassword=//p' "$DATA/$c/$c.conf")"
	[[ -n "$rpcpass" ]] || die "$c: no rpcpassword in $DATA/$c/$c.conf"

	# Ports follow the convention already on this host: solo 335x/485x,
	# pplns 337x/487x, keyed off the coin's own assigned index.
	local idx base_s base_d
	idx=$(( rpcport - 19000 ))
	if [[ "$scheme" == solo ]]; then base_s=$(( 3357 + idx )); base_d=$(( 4857 + idx ));
	else base_s=$(( 3377 + idx )); base_d=$(( 4877 + idx )); fi
	# The convention gives a STARTING point, not a guarantee — see free_port.
	base_s="$(free_port "$base_s")"
	base_d="$(free_port "$base_d")"
	local pool_id="$c"; [[ "$scheme" == pplns ]] && pool_id="$c-2"

	local block_addr
	block_addr="$(sed -n 's/^blockle_address *= *"\(.*\)"/\1/p' "$POOLS/dogecoin-solo.toml" | head -1)"
	[[ -n "$block_addr" ]] || die "could not read the pool's BLOCK address from an existing pool"

	local toml="$POOLS/$c-$scheme.toml"
	cat > "$toml" <<EOF
# $name $scheme pool, merge-mining BLOCK on the $algo lane.
#
# The coinbase pays $addr, whose key is in
# $WALLETS/$c (detached — see its README).
# The $c daemon itself has no wallet: it is also what the exchange reconciles
# against, and pool income in the same wallet as custody would mask a shortfall.

[chain]
name = "$name"
rpc = "http://$rpcuser:$rpcpass@127.0.0.1:$rpcport/"
adapter = "bitcoin-family"
algorithm = "$algo"

[chain.field_map]
template_method = "getblocktemplate"
submit_method = "submitblock"
prev_hash = "previousblockhash"
height = "height"
bits = "bits"
curtime = "curtime"
version = "version"
coinbase_value = "coinbasevalue"
transactions = "transactions"
tx_id_field = "txid"
tx_data_field = "data"

[[chain.aux]]
name = "BLOCK"
rpc = "$BLOCK_AUX_RPC"
chain_id = $BLOCK_CHAIN_ID
create_method = "createauxblock"
submit_method = "submitauxblock"
payout_address = "$block_addr"
algorithm = "$algo"

[pool]
stratum = "0.0.0.0:$base_s"
dashboard = "127.0.0.1:$base_d"
payout_script = "$script"
hot_address = ""
payout_address = "$addr"
blockle_address = "$block_addr"
scheme = "$scheme"
fee_percent = 1.0
pplns_window = 10000
heartbeat_secs = 60

[biz]
url = "$BIZ"
pool_id = "$pool_id"
token = "PENDING"
EOF
	chmod 600 "$toml"

	# Register for a dashboard token. Done after the config exists so a failed
	# registration leaves a config that can be retried, not a token with no home.
	local token
	token="$(curl -fsS --max-time 15 "$BIZ/api/register" \
		-H 'content-type: application/json' \
		-d "{\"pool_id\":\"$pool_id\",\"name\":\"$name $scheme\",\"chain\":\"$name\",\"algorithm\":\"$algo\",\"fee_percent\":1.0,\"stratum\":\"blockle.org:$base_s\"}" \
		| python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
	if [[ -n "$token" ]]; then
		sed -i "s/^token = \"PENDING\"/token = \"$token\"/" "$toml"
		echo "    registered with biz as $pool_id"
	else
		echo "    WARNING: biz registration failed; token left PENDING" >&2
		echo "             the pool mines regardless, it just will not report stats" >&2
	fi

	cat > "/etc/systemd/system/blockle-pool-$c-$scheme.service" <<EOF
[Unit]
Description=$name $scheme pool (+BLOCK aux on $algo, 1% fee)
After=network-online.target blockle-coin-$c.service blockle-node.service
Wants=blockle-coin-$c.service blockle-node.service

[Service]
ExecStart=$BLOCKLE serve $toml
Restart=on-failure
RestartSec=15

# The pool talks to two local RPCs and holds no keys. It does not need
# anything else on this host.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$POOLS
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload
	echo "    wrote $toml and blockle-pool-$c-$scheme.service"
	echo "    NOT started: \`aux-pool.sh gate\` starts it once $c has finished syncing"
}

# --------------------------------------------------------------------- gate

# A pool on a syncing parent cannot build a template. Rather than let systemd
# restart-loop it in front of miners, pools are created stopped and started
# here, once their parent says it is done with initial block download.
cmd_gate() {
	local unit toml c started=0 waiting=0
	for toml in "$POOLS"/*-solo.toml "$POOLS"/*-pplns.toml; do
		[[ -e "$toml" ]] || continue
		c="$(basename "$toml")"; c="${c%%-*}"
		[[ -d "$DATA/$c" ]] || continue        # not one of the exchange's coins
		unit="blockle-pool-$(basename "${toml%.toml}")"
		systemctl is-active --quiet "$unit" && continue
		local exe ibd
		exe="$(cli_for "$c")" || continue
		ibd="$("$exe" -conf="$DATA/$c/$c.conf" -datadir="$DATA/$c" getblockchaininfo 2>/dev/null \
			| python3 -c 'import sys,json; print(json.load(sys.stdin).get("initialblockdownload"))' 2>/dev/null || echo True)"
		if [[ "$ibd" == "False" ]]; then
			systemctl enable --now "$unit" && { echo "started $unit"; started=$((started+1)); }
		else
			echo "waiting: $c still syncing, $unit held"; waiting=$((waiting+1))
		fi
	done
	echo "gate: $started started, $waiting waiting"
}

cmd_status() {
	printf "%-26s %-9s %-7s %s\n" POOL STATE STRATUM PARENT
	local toml c unit
	for toml in "$POOLS"/*-solo.toml "$POOLS"/*-pplns.toml; do
		[[ -e "$toml" ]] || continue
		c="$(basename "$toml")"; c="${c%%-*}"
		[[ -d "$DATA/$c" ]] || continue
		unit="blockle-pool-$(basename "${toml%.toml}")"
		printf "%-26s %-9s %-7s %s\n" "$(basename "${toml%.toml}")" \
			"$(systemctl is-active "$unit" 2>/dev/null)" \
			"$(sed -n 's/.*stratum = "0.0.0.0:\([0-9]*\)".*/\1/p' "$toml")" \
			"$(systemctl is-active "blockle-coin-$c" 2>/dev/null)"
	done
}

case "${1:-plan}" in
	plan)   cmd_plan ;;
	create) shift; cmd_create "$@" ;;
	gate)   cmd_gate ;;
	status) cmd_status ;;
	*) die "usage: aux-pool.sh [plan|create <SYM> <solo|pplns>|gate|status]" ;;
esac
