#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Reclaim disk on the blockle box.
#
# Run as root on 144.126.133.21. Takes one argument so each stage is a
# deliberate act:
#
#   ./reclaim-space.sh safe                  ~4 GB,  zero risk, nothing stops
#   ./reclaim-space.sh root-cruft            dry run: old deploy tarballs + .bak
#   ./reclaim-space.sh root-cruft --apply    ...and actually delete them
#   ./reclaim-space.sh doge-stage            repoint Doge at a 3rd-party RPC + VERIFY
#   ./reclaim-space.sh doge-purge            ~295 GB, IRREVERSIBLE — needs a
#                                            verified replacement indexer
#   ./reclaim-space.sh doge-purge --accept-doge-offline
#                                            ~295 GB with NO replacement; sets
#                                            the shim to an honest 503 so no
#                                            wallet ever shows a false "0 DOGE"
#
# WHY THE DOGE WORK IS SPLIT IN TWO.
#
# The 295 GB is `/var/lib/dogecoin-full` (225 GB) plus `/var/lib/doge-index`
# (70 GB). Those back the Esplora shim that the four non-custodial wallets use
# for Dogecoin address lookups.
#
# The space is being reclaimed to make room for many smaller coin nodes, which
# is a sound trade — 295 GB is a great many 1-30 GB chains, and one coin should
# not hold 46% of the disk. But the deletion is irreversible (a resync is days
# and 225 GB of bandwidth), so staging exists to make the switchover provable
# first WHERE A REPLACEMENT EXISTS.
#
# Where one does not, `--accept-doge-offline` purges anyway and puts the shim
# into a 503 "temporarily unavailable" state. That flag is about honesty rather
# than caution: with the index gone, a shim that returns an empty UTXO set
# makes every wallet display "0 DOGE", and a holder reads that as their coins
# having disappeared. An error is recoverable; a confident wrong zero is a
# support incident that looks like a theft.
#
# WHAT IS DELIBERATELY NOT TOUCHED:
#
#   /var/lib/dogecoin   (18 GB)  the PRUNED node behind both Doge mining pools.
#                                Merge-mining needs getblocktemplate, which no
#                                public RPC offers. Deleting this kills Doge
#                                merge-mining and its BLOCK aux contribution.
#   /var/lib/perbug              Perbug core. Also now a listed exchange asset.
#   /var/lib/blockle-*           Blockle core: mainnet, testnet, pool, send.
#   /opt/perbug  /opt/blockle    Source and binaries for both chains.
#   /var/lib/dash  /var/lib/hush  /var/lib/ecash   other live coin nodes.
# -----------------------------------------------------------------------------
set -euo pipefail

if [ "$(id -u)" != "0" ]; then echo "run as root" >&2; exit 1; fi

STAGE="${1:-}"
# Avail in MB, for arithmetic. `df -h` rounds to 3 significant figures, so
# reclaiming ~4 GB from a 483 GB disk prints "132G free" BEFORE and AFTER and
# the stage reads as a no-op when it in fact worked. That is how the first real
# run of this script looked like it had done nothing.
avail_mb() { df -BM --output=avail / | tail -1 | tr -dc '0-9'; }
free_now() { df -h / | awk 'NR==2 {print $4" free ("$5" used)"}'; }

# Print before/after with the delta spelled out, so "it worked" and "there was
# nothing to do" are distinguishable.
BEFORE_MB=""
mark_before() { BEFORE_MB="$(avail_mb)"; echo "=== before: $(free_now)"; }
mark_after() {
	a="$(avail_mb)"
	d=$(( a - BEFORE_MB ))
	echo "=== after:  $(free_now)"
	if [ "$d" -gt 0 ]; then
		echo "=== freed:  ${d} MB ($((d / 1024)) GB)"
	elif [ "$d" -lt 0 ]; then
		echo "=== note:   ${d} MB — the disk grew during the run (services are writing)"
	else
		echo "=== freed:  nothing — already clean, or nothing matched"
	fi
}

# The third-party Doge endpoint the shim will use. Override when running.
DOGE_RPC="${DOGE_RPC:-}"

case "$STAGE" in

safe)
	mark_before

	# WORLD is shut down (compliance). 210 MB.
	rm -rf /opt/world

	# Stale Android build artifacts in /tmp. The one served from the website
	# (/opt/blockle/web/downloads/BlockleWallet-android.apk) is NOT touched.
	rm -f /tmp/BW9*.apk

	# The Flutter installer tarball; the extracted SDK at /opt/sdk/flutter stays.
	rm -f /opt/sdk/flutter.tar.xz

	rm -f /root/stuck-mempool-*.json.bak

	# Truncate rather than delete: mongod holds the fd, so deleting frees
	# nothing until the process restarts.
	truncate -s 0 /var/log/mongodb/mongod.log || true

	journalctl --vacuum-size=200M >/dev/null 2>&1 || true
	apt-get clean

	mark_after
	;;

root-cruft)
	# /root has accumulated years of deploy tarballs, nginx config backups and
	# .bak source files. DRY RUN BY DEFAULT — pass --apply to actually delete.
	#
	# THE KEEP LIST IS THE IMPORTANT PART OF THIS STAGE. Several things in
	# /root are irreplaceable and sit right next to things that are pure
	# litter:
	#
	#   pool-wallet-backups/        pool payout wallets — KEY MATERIAL
	#   wallet-backup-*.tgz         a wallet backup — KEY MATERIAL
	#   chain-backups-*/            chain state backups
	#   chain-src-backup/           source snapshot
	#   blockle-src-backup/
	#   accounts-users.bak.*.json   the accounts user table
	#   genesis-block.json          the genesis block
	#   mainnet.json.dev-backup     mainnet config
	#   perbug-auxpow-untracked-bak untracked Perbug AuxPoW work
	#
	# Losing any of those is unrecoverable, and "it was in a directory called
	# backups" is exactly how it happens. So this stage deletes only an
	# explicit pattern list and refuses anything matching the keep patterns,
	# rather than deleting broadly and hoping the keep list caught everything.
	# An `if` rather than `[ cond ] && APPLY=1`. Both work here — bash exempts a
	# failing test from `set -e` when it is not the last command in an && list,
	# so the dry-run path is safe either way. The `if` is used because the
	# `&&` form DOES exit under `set -e` when it lands as the final statement
	# of a function or script, which is an easy trap to fall into later.
	APPLY=0
	if [ "${2:-}" = "--apply" ]; then APPLY=1; fi

	KEEP='pool-wallet-backups|wallet-backup-|chain-backups|chain-src-backup|blockle-src-backup|accounts-users|genesis|mainnet\.json|perbug-auxpow-untracked-bak|Blocklelogo|pool-wallet'

	cd /root || exit 1
	total=0
	list=""
	for f in *.tgz *.tar.gz nginx-blockle.bak.* blockle.nginx.bak* blockle.nginx.pre-* \
	         blockle.bak.* blockle.bak-gas biz.rs.bak* *.vhost.bak* \
	         blocklings-server.js.bak.* social-*.bak* accounts-config.js.bak.* \
	         demo.conf.bak-usdb sitemap.xml.bak perbug-index.html.bak \
	         perbug-index.html.pre-* stuck-mempool-*.json.bak \
	         blockle-node.service.bak nginx-decommissioned-backups \
	         v028-release.log v029-release.log v0210-release.log; do
		[ -e "$f" ] || continue
		# `grep -E ... >/dev/null`, never `grep -q`: under `set -o pipefail`,
		# grep -q closes the pipe on first match, the producer takes SIGPIPE,
		# and the pipeline reports FAILURE despite having matched. Here that
		# would mean a protected file falling through to deletion — and the
		# protected files are wallet keys.
		if printf '%s' "$f" | grep -E "$KEEP" >/dev/null; then
			echo "KEEP (protected): $f"
			continue
		fi
		sz=$(du -sk "$f" 2>/dev/null | cut -f1)
		total=$((total + sz))
		list="$list $f"
		printf '  delete  %-46s %s\n' "$f" "$(du -sh "$f" 2>/dev/null | cut -f1)"
	done

	echo
	if [ -z "${list// /}" ]; then
		echo "nothing to delete — /root is already clean of these patterns"
		echo "(if you expected tarballs here, a previous run already removed them)"
		exit 0
	fi
	echo "would free: $((total / 1024)) MB"
	if [ "$APPLY" = "1" ]; then
		mark_before
		echo "deleting ..."
		# shellcheck disable=SC2086
		rm -rf -- $list
		mark_after
	else
		echo "DRY RUN. Re-run with: ./reclaim-space.sh root-cruft --apply"
	fi
	;;

doge-stage)
	if [ -z "$DOGE_RPC" ]; then
		cat >&2 <<'EOF'
error: set DOGE_RPC to the third-party endpoint first, e.g.

  DOGE_RPC=https://api.blockcypher.com/v1/doge/main ./reclaim-space.sh doge-stage

IT MUST BE AN INDEXER, NOT A NODE. Plain dogecoind JSON-RPC cannot answer
"what are this address's UTXOs" — Dogecoin Core has no address index at all,
which is the entire reason the 225 GB node exists.

Tested 2026-11-23:

  WORKS    BlockCypher  https://api.blockcypher.com/v1/doge/main/addrs/<a>/balance
  WORKS    Blockchair   https://api.blockchair.com/dogecoin/dashboards/address/<a>
  NO GOOD  GetBlock shared NODE endpoint (shared.*.getblock.io/<key>) — node RPC
           only, no address index. It passes a naive check because every GET
           path returns HTTP 200 with a JSON-RPC error body.

If your provider sells a separate "Blockbook" or "indexer" product alongside
the shared node, that is the one to use here.
EOF
		exit 1
	fi

	echo "1/5 probing reachability of $DOGE_RPC ..."
	# Fail now, loudly, rather than after the data is gone.
	if ! curl -fsS -4 --max-time 20 -o /dev/null "$DOGE_RPC"; then
		echo "error: cannot reach that endpoint over IPv4. Not proceeding." >&2
		exit 1
	fi

	# ------------------------------------------------------------------------
	# 2/5 CAPABILITY PROBE — reachability is not sufficiency.
	#
	# This check exists because a GetBlock shared-node endpoint was offered as
	# a replacement and it CANNOT do the job: it is plain Dogecoin Core
	# JSON-RPC, and Dogecoin Core has no address index. getaddressutxos and
	# getaddressbalance do not exist in it, so the Esplora shim's one question
	# — "what are this address's UTXOs?" — is unanswerable.
	#
	# Two ways that endpoint fools a casual test:
	#   * every GET path returns HTTP 200 with a JSON-RPC error envelope
	#     ("method must be POST"), so a status-code check passes
	#   * the node RPC itself works fine, so getblockchaininfo succeeds
	#
	# So this probes for the ADDRESS capability specifically, with a real
	# funded address, and refuses anything that cannot answer.
	# ------------------------------------------------------------------------
	echo "2/5 probing ADDRESS-index capability (not just reachability) ..."
	PROBE_ADDR="DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L"
	CAPABLE=0

	# Blockbook / Esplora style REST.
	if curl -fsS --max-time 20 "${DOGE_RPC%/}/api/v2/address/$PROBE_ADDR" 2>/dev/null \
		| grep -E '"(balance|txids|totalReceived)"' >/dev/null; then
		CAPABLE=1; echo "  -> Blockbook-style REST address API: yes"
	fi
	# Address-index JSON-RPC (Dash/Zcash/ABC-style patched nodes).
	if [ "$CAPABLE" = "0" ] && curl -fsS --max-time 20 -X POST "$DOGE_RPC" \
		-H 'Content-Type: application/json' \
		-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getaddressutxos\",\"params\":[{\"addresses\":[\"$PROBE_ADDR\"]}]}" \
		2>/dev/null | grep -E '"result"' >/dev/null; then
		CAPABLE=1; echo "  -> getaddressutxos JSON-RPC: yes"
	fi

	if [ "$CAPABLE" = "0" ]; then
		cat >&2 <<'EOF'

error: that endpoint is reachable but CANNOT serve address history.

It answers node RPC but has no address index, so it cannot replace
/var/lib/dogecoin-full. Pointing the Esplora shim at it would break Dogecoin
address and balance lookups in all four wallets — and this script would then
have deleted the only other source of that data.

You need an INDEXER endpoint, not a node endpoint. Verified working:

  BlockCypher   https://api.blockcypher.com/v1/doge/main/addrs/<addr>/balance
  Blockchair    https://api.blockchair.com/dogecoin/dashboards/address/<addr>
  Blockbook     any provider's doge Blockbook host (/api/v2/address/<addr>)

If your provider sells a separate "Blockbook" or "indexer" product alongside
the shared node, that is the one you want.

Nothing has been changed. dogecoin-full is untouched.
EOF
		exit 1
	fi

	echo "3/5 writing the shim's new upstream ..."
	install -d -m 755 /etc/blockle
	printf 'DOGE_UPSTREAM=%s\n' "$DOGE_RPC" > /etc/blockle/doge-esplora.env
	chmod 600 /etc/blockle/doge-esplora.env   # may contain an API key

	echo "4/5 restarting the shim against the third party ..."
	systemctl restart doge-esplora.service
	sleep 5

	echo "5/5 verifying the shim still answers ..."
	# A known-funded Dogecoin address; any non-empty answer proves the path.
	PROBE="DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L"
	if curl -fsS --max-time 20 "http://127.0.0.1:3061/address/$PROBE" | head -c 200; then
		echo
		echo "OK — the shim is serving from the third-party upstream."
		echo "Leave it running for a while under real traffic, THEN run doge-purge."
		echo "Nothing has been deleted yet; dogecoin-full is still on disk."
	else
		echo "FAILED — the shim is not answering. Reverting to the local node." >&2
		rm -f /etc/blockle/doge-esplora.env
		systemctl restart doge-esplora.service
		echo "reverted; nothing deleted" >&2
		exit 1
	fi
	;;

doge-purge)
	# ------------------------------------------------------------------------
	# TWO WAYS IN, because the space is wanted for other coins regardless of
	# whether a Doge indexer replacement exists yet:
	#
	#   doge-purge                        requires a VERIFIED replacement
	#                                     (doge-stage ran and the shim answers)
	#
	#   doge-purge --accept-doge-offline  purges with NO replacement, and puts
	#                                     the shim into an honest 503 state
	#
	# The second form exists because 225 GB for one coin is a bad trade when
	# the plan is to list many smaller ones — 295 GB is a lot of 1-30 GB nodes.
	# It still demands an explicit flag so it cannot happen by accident.
	#
	# WHY THE 503 MATTERS MORE THAN THE DELETION.
	#
	# Once the index is gone the shim cannot answer address queries. If it
	# returns an empty UTXO set or a zero balance, every wallet renders
	# "0 DOGE" — and a user who holds Dogecoin will reasonably conclude their
	# coins are gone. That is a far worse outcome than an error, and it is a
	# support nightmare that looks exactly like a theft.
	#
	# So the shim is switched to returning 503 with a plain-language reason.
	# The wallets then show "temporarily unavailable" instead of a confident,
	# wrong zero. Fail visibly, never silently.
	# ------------------------------------------------------------------------
	ACCEPT_OFFLINE=0
	if [ "${2:-}" = "--accept-doge-offline" ]; then ACCEPT_OFFLINE=1; fi

	if [ "$ACCEPT_OFFLINE" = "1" ]; then
		echo "=== purging WITHOUT a replacement indexer (explicitly accepted)"
		echo "    Doge address lookups will return 503 until an indexer is wired."

		# Put the shim into the honest-unavailable state BEFORE deleting, so
		# there is never a window where it serves wrong answers from a
		# half-deleted index.
		install -d -m 755 /etc/blockle
		cat > /etc/blockle/doge-esplora.env <<'ENVEOF'
# No Dogecoin address indexer is configured. The local full node and its
# address index were removed to free 295 GB for additional coin nodes.
#
# The shim MUST return 503 for address and UTXO queries while this is set.
# It must NOT return an empty result: an empty UTXO set renders as "0 DOGE"
# in every wallet, and a user holding Dogecoin will read that as their coins
# having vanished.
DOGE_UPSTREAM=
DOGE_UNAVAILABLE=1
DOGE_UNAVAILABLE_REASON=Dogecoin balance lookups are temporarily unavailable while we move to a hosted indexer. Your coins are safe and your keys are unchanged.
ENVEOF
		chmod 600 /etc/blockle/doge-esplora.env
		systemctl restart doge-esplora.service 2>/dev/null || true
		echo "    shim set to 503 (DOGE_UNAVAILABLE=1)"
		echo
		echo "    NOTE: the shim must honour DOGE_UNAVAILABLE. If it does not yet,"
		echo "    stop it entirely rather than letting it serve empty results:"
		echo "      systemctl disable --now doge-esplora.service"
	else
		# REFUSE unless the switchover is in place and verified.
		if [ ! -f /etc/blockle/doge-esplora.env ]; then
			echo "error: no /etc/blockle/doge-esplora.env — run doge-stage first," >&2
			echo "       or purge deliberately with --accept-doge-offline." >&2
			exit 1
		fi
		if ! curl -fsS --max-time 20 -o /dev/null "http://127.0.0.1:3061/health" 2>/dev/null \
			&& ! curl -fsS --max-time 20 -o /dev/null "http://127.0.0.1:3061/" 2>/dev/null; then
			echo "error: the Esplora shim is not responding. Fix that before deleting" >&2
			echo "       the only other source of this data, or use" >&2
			echo "       --accept-doge-offline if you intend Doge to go dark." >&2
			exit 1
		fi
	fi

	mark_before
	echo "stopping the full node and its indexer (NOT the pruned pool node) ..."
	systemctl disable --now dogecoin-full.service doge-indexer.service

	# Belt and braces: never let a wildcard or a variable typo reach rm -rf.
	for d in /var/lib/dogecoin-full /var/lib/doge-index; do
		case "$d" in
			/var/lib/dogecoin-full|/var/lib/doge-index) ;;
			*) echo "refusing to delete unexpected path: $d" >&2; exit 1 ;;
		esac
		[ -d "$d" ] || { echo "skip (absent): $d"; continue; }
		echo "deleting $d ($(du -sh "$d" 2>/dev/null | cut -f1)) ..."
		rm -rf -- "$d"
	done

	mark_after
	echo
	echo "Still running, as intended:"
	systemctl is-active dogecoin.service \
		blockle-pool-dogecoin-pplns.service \
		blockle-pool-dogecoin-solo.service \
		| paste -sd' ' -
	echo "  (pruned node + both Doge pools — merge-mining unaffected)"
	;;

*)
	sed -n '3,30p' "$0"
	exit 1
	;;
esac
