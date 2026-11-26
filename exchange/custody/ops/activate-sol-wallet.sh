#!/usr/bin/env bash
#
# VERIFY THE SOLANA CUSTODY WALLET'S ACTIVATION. READ-ONLY BY DEFAULT.
#
# This script NEVER moves funds and cannot. There is no signing key here and no
# transfer endpoint is called. Funding is a manual transfer you make from a
# wallet you control, and the exact amount and destination are printed below.
#
# Run it twice:
#
#   1. BEFORE funding  — confirms the destination address against live BitGo,
#                        so you are not trusting a copied string in a runbook,
#                        and prints the amount.
#   2. AFTER funding    — confirms `pendingChainInitialization` has flipped to
#                        false, then (only with --mint-test) makes the one POST
#                        that proves BitGo will now mint per-customer addresses.
#
# --mint-test IS A MUTATION, and the only one here. It creates a receive address
# on OUR OWN exchange SOL wallet, which is the production behaviour we are
# trying to restore; it costs nothing and moves nothing. It is behind a flag
# rather than default because a read-only script should stay read-only until you
# say otherwise.
#
# WHY IPv4 PINNING IS NOT OPTIONAL. The BitGo token is IP-restricted and this box
# has IPv6. A request that egresses over IPv6 gets a 401 that looks EXACTLY like
# a bad token, and that misdiagnosis has already cost time once. So every call
# goes through pinAndVerify() from dist/src/ipv4.js, and the script refuses to
# run if that module is missing rather than producing a misleading 401.
#
# See ops/bitgo-deposit-rails.md for the full account of why this is needed.

set -euo pipefail

MINT_TEST=0
for arg in "$@"; do
	case "$arg" in
		--mint-test) MINT_TEST=1 ;;
		-h|--help)
			sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "unknown argument: $arg (try --help)" >&2
			exit 2
			;;
	esac
done

APP_DIR="${APP_DIR:-/opt/blockle/exchange-custody}"
IPV4_MOD="$APP_DIR/dist/src/ipv4.js"

if [ ! -f "$IPV4_MOD" ]; then
	cat >&2 <<EOF
refusing to run: $IPV4_MOD is missing.

Every call must egress over IPv4 or the IP-restricted token returns a 401 that
reads as a bad token. Build the service first (npm run build in exchange/custody,
then deploy dist/), or set APP_DIR to a tree that has dist/src/ipv4.js.
EOF
	exit 1
fi

# Credentials. Presence only is ever reported; no value is printed anywhere in
# this script.
if [ -z "${BITGO_ACCESS_TOKEN:-}" ]; then
	for f in /etc/blockle/secrets/bitgo.env /etc/blockle/exchange-bitgo.env; do
		if [ -r "$f" ]; then
			set -a
			# shellcheck disable=SC1090
			. "$f"
			set +a
		fi
	done
fi

if [ -z "${BITGO_ACCESS_TOKEN:-}" ]; then
	cat >&2 <<'EOF'
refusing to run: BITGO_ACCESS_TOKEN is not set and could not be read.

  sudo bash -c 'set -a; . /etc/blockle/secrets/bitgo.env; \
    . /etc/blockle/exchange-bitgo.env; set +a; \
    exec exchange/custody/ops/activate-sol-wallet.sh'

The secrets files are root-only, which is why this needs sudo.
EOF
	exit 1
fi

export IPV4_MOD MINT_TEST
exec node "$(dirname "$0")/activate-sol-wallet.js"
