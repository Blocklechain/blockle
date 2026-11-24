#!/usr/bin/env bash
#
# Ship the exchange's static pages.
#
# THERE IS ONE SERVED DIRECTORY AND IT IS NOT THE OBVIOUS ONE.
#
# The box also has /var/www/exchange, which is an older copy that nothing
# serves. An rsync to it succeeds, reports every file transferred, and changes
# nothing about the live site — which is exactly what happened and cost a round
# of "the deploy worked but the page is the same". The served directory is
# PUBLIC_STATIC_DIR from exchange-public-api.service:
#
#     /var/www/exchange-frontpage
#
# So this script reads that value off the box rather than hard-coding it, and
# refuses to copy anything if it cannot determine it. A deploy that cannot name
# its target must not pick one.
set -euo pipefail

BOX="${BOX:-blockle-box}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/deploy/exchange/frontpage"

[[ -f "$SRC/app.html" ]] || { echo "no app.html in $SRC" >&2; exit 1; }

echo "==> asking the box where the pages are served from"
DEST="$(ssh "$BOX" "awk -F= '/^Environment=PUBLIC_STATIC_DIR=/{print \$3}' \
	/etc/systemd/system/exchange-public-api.service" | tr -d '\r')"

if [[ -z "$DEST" ]]; then
	echo "could not read PUBLIC_STATIC_DIR from the unit on $BOX." >&2
	echo "Refusing to guess — a wrong guess is a deploy that silently does" >&2
	echo "nothing. Check the unit file and fix it there." >&2
	exit 2
fi
case "$DEST" in
	/var/www/*) : ;;
	*) echo "PUBLIC_STATIC_DIR=$DEST is not under /var/www; aborting" >&2; exit 2 ;;
esac

# --- content-hash the asset urls -------------------------------------------
#
# WHY THIS EXISTS. A broken coins.js was fixed, shipped, and verified by curl —
# and browsers kept running the old copy, because the server had told them they
# could for an hour. The headers now say `no-cache` for code, which fixes it
# going forward, but a header change cannot reach a browser that is not asking.
#
# So the HTML references `exchange.js?v=<hash of exchange.js>`. A changed file
# is a changed URL, which no cache can satisfy from a stale entry — and an
# unchanged file keeps its URL, so the cache still works for everyone.
#
# Done HERE and not in the repo: a version string committed into app.html is a
# merge conflict on every deploy, and it would be wrong the moment someone
# edited the asset without re-running this.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$SRC/." "$STAGE/"
# WORLD-READABLE, EXPLICITLY. `mktemp -d` creates a 0700 directory, rsync -a
# preserves that mode, and the staged root therefore replaced the served
# directory's permissions with 0700 — which took the whole site to 404 for a
# minute, because the service could no longer read its own static root. The
# files are about to be public; their modes should say so here.
chmod -R a+rX "$STAGE"

hash_of() { shasum -a 256 "$1" | cut -c1-10; }

declare -a STAMPED=()
for asset in exchange.js coins.js exchange.css; do
	[[ -f "$STAGE/$asset" ]] || continue
	v="$(hash_of "$STAGE/$asset")"
	STAMPED+=("$asset?v=$v")
	# Rewrite references in every HTML file, including the generated coin pages.
	# The pattern is anchored to a quote so a mention in a comment is untouched,
	# and `?v=` is stripped first so re-running is idempotent.
	while IFS= read -r -d '' html; do
		perl -0pi -e "s{\Q$asset\E(\?v=[0-9a-f]+)?(?=[\"'])}{$asset?v=$v}g" "$html"
	done < <(find "$STAGE" -name '*.html' -print0)
done
echo "==> stamped: ${STAMPED[*]}"

echo "==> $STAGE -> $BOX:$DEST"
# NOT --delete. The box holds assets this tree does not (logo.png is placed by
# the install steps), and deleting them would blank the branding on every page.
rsync -az "$STAGE/" "$BOX:$DEST/"

# PROVE IT OVER HTTPS, not by trusting the rsync. The failure this exists to
# catch looks like a successful copy.
echo "==> verifying what the site actually serves"
for f in app.html exchange.js exchange.css coins.js signin.html; do
	# AGAINST THE STAGED COPY, not the repo one — the HTML was rewritten with
	# hashed asset urls, so its size differs from what is checked in.
	local_size=$(wc -c <"$STAGE/$f" | tr -d ' ')
	served=$(curl -fsS -o /dev/null -w '%{size_download}' \
		"https://exchange.blockle.org/$f" || echo 0)
	if [[ "$local_size" == "$served" ]]; then
		printf '    %-14s %s bytes\n' "$f" "$served"
	else
		printf '    %-14s MISMATCH: local %s, served %s\n' "$f" "$local_size" "$served"
		echo "The served copy is not what was just shipped. Likely a cache in" >&2
		echo "front, or the unit's PUBLIC_STATIC_DIR is not what nginx roots at." >&2
		exit 3
	fi
done
echo "==> live"
