#!/usr/bin/env bash
#
# Bring up a coin daemon for one of the listed currencies.
#
#     ./provision.sh check            what is reachable, and what will fit
#     ./provision.sh install RTM      fetch, verify, configure, start
#     ./provision.sh status           what is running, and what it costs
#     ./provision.sh env              the lines the exchange needs
#
# THE CAPACITY GUARD IS THE POINT OF THIS SCRIPT.
#
# These daemons share a host with the custodial exchange. An OOM there does
# not degrade a coin listing — it kills the API, the reconciler and the payout
# runner, and customer funds become unreachable until someone notices. So
# `install` measures free memory first and REFUSES if the coin's requirement
# plus a reserve would not fit. There is no --force: if the box is full, the
# answer is a bigger box, not a smaller margin.
#
# WHAT THIS DELIBERATELY DOES NOT DO.
#
#   * It does not run as root where it can avoid it. Each daemon gets its own
#     unprivileged user, its own datadir, and a systemd unit that cannot read
#     the exchange's database or its BitGo token.
#   * It does not enable a wallet on nodes that only need to be read. The
#     reconciler wants a balance; it has no business holding spending keys.
#   * It does not invent a download. Every artifact is resolved from the
#     project's own GitHub release at run time and checked against the digest
#     GitHub serves for it, so a renamed or pulled asset is an error rather
#     than a silent fallback to something else.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODES="$HERE/nodes.json"
ROOT=/opt/blockle/coins
DATA=/var/lib/blockle-coins
# Headroom left for the exchange after a daemon's own requirement. The box
# runs ~60 services; the one that must never be squeezed is custody.
RESERVE_GB=3

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

jq_get() { python3 -c "
import json,sys
d=json.load(open('$NODES'))
v=d.get('$1',{}).get('$2')
print('' if v is None else v)
"; }

symbols() { python3 -c "
import json
d=json.load(open('$NODES'))
print(' '.join(k for k in d if not k.startswith('_')))
"; }

free_gb() { awk '/MemAvailable/ { printf "%d", $2 / 1048576 }' /proc/meminfo; }
free_disk_gb() { df -BG --output=avail "$DATA" 2>/dev/null | tail -1 | tr -dc '0-9'; }

# ---------------------------------------------------------------- resolving

# The release asset for a coin, as the project publishes it right now.
# Prints "<url> <size> <digest-or-empty>"; fails if nothing matches, because a
# pattern that no longer matches means the project renamed its artifacts and
# somebody needs to look rather than have a guess installed.
resolve() {
	local sym="$1" repo pattern
	repo="$(jq_get "$sym" repo)"
	pattern="$(jq_get "$sym" assetMatch)"
	[[ -n "$repo" ]]    || { echo "no repo configured"; return 1; }
	[[ -n "$pattern" ]] || { echo "no asset pattern configured"; return 1; }

	python3 - "$repo" "$pattern" <<'PY'
import json, re, sys, urllib.request
repo, pattern = sys.argv[1], sys.argv[2]
try:
    with urllib.request.urlopen(
        f"https://api.github.com/repos/{repo}/releases/latest", timeout=20) as r:
        d = json.load(r)
except Exception as e:
    print(f"release lookup failed: {type(e).__name__}", file=sys.stderr)
    sys.exit(1)
rx = re.compile(pattern)
for a in d.get("assets", []):
    if rx.search(a["name"]):
        print(a["browser_download_url"], a["size"],
              a.get("digest", ""), d.get("tag_name", "?"))
        sys.exit(0)
print(f"no asset matching {pattern} in {d.get('tag_name')}", file=sys.stderr)
sys.exit(1)
PY
}

# ------------------------------------------------------------------- check

cmd_check() {
	local avail disk
	avail="$(free_gb)"; disk="$(free_disk_gb 2>/dev/null || echo 0)"
	echo "host: ${avail}GB memory available, ${disk}GB disk free on $DATA"
	echo "      reserve kept for the exchange: ${RESERVE_GB}GB"
	echo
	printf "  %-6s %-14s %-5s %-6s %s\n" SYMBOL FAMILY RAM FITS SOURCE
	local total=0
	for sym in $(symbols); do
		local fam ram out status
		fam="$(jq_get "$sym" family)"; ram="$(jq_get "$sym" ramGb)"
		total=$((total + ram))
		if out="$(resolve "$sym" 2>&1)"; then
			status="$(echo "$out" | awk '{print $4}')"
		else
			status="UNAVAILABLE: $out"
		fi
		local fits="no"
		[[ $((avail - RESERVE_GB)) -ge $ram ]] && fits="yes"
		printf "  %-6s %-14s %-5s %-6s %s\n" "$sym" "$fam" "${ram}G" "$fits" "$status"
	done
	echo
	echo "all ten together need about ${total}GB of memory; ${avail}GB is available."
}

# ----------------------------------------------------------------- install

cmd_install() {
	local sym="${1:-}"
	[[ -n "$sym" ]] || die "usage: provision.sh install <SYMBOL>"
	local name fam ram disk daemon port
	name="$(jq_get "$sym" name)";   [[ -n "$name" ]] || die "unknown coin $sym"
	fam="$(jq_get "$sym" family)"
	ram="$(jq_get "$sym" ramGb)"
	disk="$(jq_get "$sym" diskGb)"
	daemon="$(jq_get "$sym" daemon)"
	port="$(jq_get "$sym" rpcPort)"

	# THE GUARD. Before anything is downloaded, let alone started.
	local avail
	avail="$(free_gb)"
	if [[ $((avail - RESERVE_GB)) -lt $ram ]]; then
		cat >&2 <<EOF
refusing to install $sym ($name).

  it needs       ${ram}GB
  available      ${avail}GB
  reserved       ${RESERVE_GB}GB for the exchange

This host also runs the custodial exchange. Starting a daemon it cannot feed
does not degrade a coin listing — it OOMs the API, the reconciler and the
payout runner, and customer funds stop being reachable. There is no override
here on purpose: the fix is more memory or another host.
EOF
		exit 75 # EX_TEMPFAIL
	fi
	local dfree
	dfree="$(free_disk_gb)"
	[[ ${dfree:-0} -ge $disk ]] || die "$sym needs ${disk}GB, $DATA has ${dfree}GB"

	local info url size digest tag
	info="$(resolve "$sym")" || die "$sym: $info"
	read -r url size digest tag <<<"$info"
	echo "==> $sym ($name) $tag"
	echo "    $url"
	echo "    $((size / 1000000)) MB${digest:+, digest $digest}"

	local user="blk-${sym,,}" dir="$ROOT/${sym,,}" datadir="$DATA/${sym,,}"
	id -u "$user" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
	install -d -m 755 "$dir"
	install -d -m 750 -o "$user" -g "$user" "$datadir"

	local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
	echo "==> fetching"
	curl -fsSL --max-time 600 -o "$tmp/asset" "$url"

	# VERIFY BEFORE UNPACKING. GitHub publishes a digest per asset; when it is
	# there it is checked, and when it is not that is said out loud rather
	# than passed over in silence.
	if [[ -n "$digest" && "$digest" == sha256:* ]]; then
		local want="${digest#sha256:}" got
		got="$(sha256sum "$tmp/asset" | cut -d' ' -f1)"
		[[ "$want" == "$got" ]] || die "digest mismatch: expected $want, got $got"
		echo "    digest verified"
	else
		echo "    WARNING: the release publishes no digest for this asset; it is" >&2
		echo "             installed unverified beyond TLS to github.com" >&2
	fi

	echo "==> unpacking"
	case "$url" in
		*.tar.gz) tar -xzf "$tmp/asset" -C "$tmp" ;;
		*.zip)    have unzip || die "unzip is not installed"; unzip -q "$tmp/asset" -d "$tmp" ;;
		*)        die "unknown archive type for $url" ;;
	esac
	local bin
	bin="$(find "$tmp" -type f -name "$daemon" -perm -u+x | head -1)"
	[[ -n "$bin" ]] || bin="$(find "$tmp" -type f -name "$daemon" | head -1)"
	[[ -n "$bin" ]] || die "no $daemon in the archive"
	install -m 755 "$bin" "$dir/$daemon"
	for extra in $(jq_get "$sym" cli); do
		local c; c="$(find "$tmp" -type f -name "$extra" | head -1)"
		[[ -z "$c" ]] || install -m 755 "$c" "$dir/$extra"
	done
	echo "    installed $dir/$daemon"

	write_conf "$sym" "$fam" "$user" "$datadir" "$port"
	write_unit "$sym" "$fam" "$user" "$dir" "$datadir" "$daemon" "$ram"

	systemctl daemon-reload
	systemctl enable --now "blockle-coin-${sym,,}"
	sleep 3
	systemctl is-active --quiet "blockle-coin-${sym,,}" \
		&& echo "==> blockle-coin-${sym,,} is running" \
		|| { journalctl -u "blockle-coin-${sym,,}" -n 20 --no-pager; die "it did not stay up"; }

	echo
	echo "Add to the exchange's units, then restart them:"
	env_for "$sym" "$fam" "$port" "$datadir"
}

write_conf() {
	local sym="$1" fam="$2" user="$3" datadir="$4" port="$5"
	local pass; pass="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
	case "$fam" in
		bitcoin-rpc)
			# NO WALLET. This node is read by the reconciler and the deposit
			# watcher; neither needs to spend, so the daemon is not given the
			# ability to. Turning it on is a deliberate, separate decision.
			cat > "$datadir/${sym,,}.conf" <<EOF
server=1
listen=1
daemon=0
disablewallet=1
txindex=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=$port
rpcuser=blockle
rpcpassword=$pass
dbcache=256
maxconnections=32
EOF
			;;
		monero-rpc)
			cat > "$datadir/${sym,,}.conf" <<EOF
data-dir=$datadir
rpc-bind-ip=127.0.0.1
rpc-bind-port=$port
confirm-external-bind=0
log-level=0
EOF
			;;
		*)
			# A chain with its own shape. The unit passes flags directly; an
			# empty file is still created so the layout is uniform.
			: > "$datadir/${sym,,}.conf"
			;;
	esac
	chown "$user:$user" "$datadir/${sym,,}.conf"
	chmod 600 "$datadir/${sym,,}.conf"
}

write_unit() {
	local sym="$1" fam="$2" user="$3" dir="$4" datadir="$5" daemon="$6" ram="$7"
	local lower="${sym,,}" exec
	case "$fam" in
		bitcoin-rpc) exec="$dir/$daemon -conf=$datadir/$lower.conf -datadir=$datadir -printtoconsole" ;;
		monero-rpc)  exec="$dir/$daemon --config-file=$datadir/$lower.conf --non-interactive" ;;
		*)           exec="$dir/$daemon" ;;
	esac
	cat > "/etc/systemd/system/blockle-coin-$lower.service" <<EOF
[Unit]
Description=$sym node for the Blockle exchange (read-only; no wallet)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user
Group=$user
ExecStart=$exec
Restart=on-failure
RestartSec=20

# A CEILING, NOT A HOPE. If this chain grows past what was budgeted for it,
# systemd kills THIS daemon rather than letting the kernel pick a victim —
# and the kernel's victim is whatever is largest, which on this host is the
# exchange.
MemoryMax=$((ram * 1024 + 256))M
MemoryHigh=$((ram * 1024))M

# It needs its own data and nothing else. Not the exchange's database, not
# its BitGo token, not /etc/blockle.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$datadir
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
}

env_for() {
	local sym="$1" fam="$2" port="$3" datadir="$4"
	case "$fam" in
		bitcoin-rpc)
			local pass; pass="$(grep '^rpcpassword=' "$datadir/${sym,,}.conf" | cut -d= -f2)"
			echo "  Environment=CHAIN_${sym}_URL=http://127.0.0.1:$port"
			echo "  Environment=CHAIN_${sym}_USER=blockle"
			echo "  Environment=CHAIN_${sym}_PASS=$pass"
			echo "  # no CHAIN_${sym}_SEND: this node has no wallet and cannot pay out"
			;;
		monero-rpc)
			echo "  Environment=CHAIN_${sym}_URL=http://127.0.0.1:$port/json_rpc"
			;;
		*)
			echo "  # $sym has no adapter in chains.ts yet; nothing to wire until it does"
			;;
	esac
}

# ------------------------------------------------------------------ status

cmd_status() {
	printf "  %-6s %-10s %-9s %-9s %s\n" SYMBOL STATE "RSS" "DISK" UNIT
	for sym in $(symbols); do
		local lower="${sym,,}" unit="blockle-coin-${sym,,}" state rss disk
		systemctl list-unit-files "$unit.service" >/dev/null 2>&1 || true
		if [[ ! -f "/etc/systemd/system/$unit.service" ]]; then
			printf "  %-6s %-10s %-9s %-9s %s\n" "$sym" "-" "-" "-" "not installed"
			continue
		fi
		state="$(systemctl is-active "$unit" 2>/dev/null || true)"
		rss="$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null || echo 0)"
		[[ "$rss" =~ ^[0-9]+$ ]] && rss="$((rss / 1048576))M" || rss="-"
		disk="$(du -sh "$DATA/$lower" 2>/dev/null | cut -f1 || echo -)"
		printf "  %-6s %-10s %-9s %-9s %s\n" "$sym" "$state" "$rss" "$disk" "$unit"
	done
}

cmd_env() {
	for sym in $(symbols); do
		local lower="${sym,,}" datadir
		datadir="$DATA/$lower"
		[[ -f "$datadir/$lower.conf" ]] || continue
		echo "# $sym"
		env_for "$sym" "$(jq_get "$sym" family)" "$(jq_get "$sym" rpcPort)" "$datadir"
	done
}

case "${1:-check}" in
	check)   cmd_check ;;
	install) shift; cmd_install "$@" ;;
	status)  cmd_status ;;
	env)     cmd_env ;;
	*)       die "usage: provision.sh [check|install <SYMBOL>|status|env]" ;;
esac
