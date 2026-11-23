#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Put TradeXPro under git with a PRISTINE VENDOR BASELINE.
#
# THIS IS THE STEP THAT DECIDES WHETHER FORKING IS MAINTAINABLE OR MISERABLE,
# and it has to happen before a single line is changed.
#
# The tree at /Volumes/ExtremePro/tradexpro is not a git repository. If the
# Laravel upgrade starts from there, then when TradeXPro 3.3.0 ships you will be
# holding a tree with thousands of your own edits and no record of what upstream
# originally looked like. Merging becomes a manual diff of two trees that have
# both moved. People abandon forks at exactly that point.
#
# The fix is cheap and permanent: commit the UNTOUCHED vendor release on its own
# branch, and do all your work on another. Then every future vendor release is a
# normal three-way merge:
#
#     vendor   A ───────── B(3.3.0)
#               \           \
#     main       A' ── A'' ── merge
#
# git knows what upstream changed (A→B) and what you changed (A→A''), so it can
# merge them and show you only the genuine conflicts.
#
# USAGE (from the blockle repo root):
#
#     ./deploy/exchange/vendor-baseline.sh /Volumes/ExtremePro/tradexpro/extracted
#
# It creates /Volumes/ExtremePro/tradexpro-fork as a new repo. The original
# extracted tree is READ ONLY as far as this script is concerned — nothing is
# modified or deleted there.
# -----------------------------------------------------------------------------
set -euo pipefail

SRC="${1:-/Volumes/ExtremePro/tradexpro/extracted}"
DEST="${DEST:-/Volumes/ExtremePro/tradexpro-fork}"
VENDOR_VERSION="${VENDOR_VERSION:-3.2.0}"

for app in Tradexpro-AdminPortal Tradexpro-UserPortal Tradexpro-NodeWallet; do
	[ -d "$SRC/$app" ] || { echo "error: $SRC/$app not found" >&2; exit 1; }
done

if [ -e "$DEST" ]; then
	echo "error: $DEST already exists. Remove it or set DEST= to somewhere else." >&2
	echo "       (refusing to overwrite — it may already be your fork)" >&2
	exit 1
fi

echo "==> creating $DEST"
mkdir -p "$DEST"
cd "$DEST"
git init -q -b vendor

# .gitignore FIRST, so the baseline commit never contains build output or
# secrets. A vendor baseline polluted with node_modules is useless for merging
# and enormous.
cat > .gitignore <<'EOF'
# Build output and dependencies — regenerated, never merged.
/*/vendor/
/*/node_modules/
/*/.next/
/*/public/build/
/*/public/hot/
/*/storage/*.key
/*/storage/framework/cache/
/*/storage/framework/sessions/
/*/storage/framework/views/
/*/storage/logs/
/*/bootstrap/cache/

# SECRETS. A fork of a payment application must never carry these.
.env
.env.*
!.env.example
*.pem
*.p12
*.key

.DS_Store
EOF

echo "==> copying the pristine vendor tree"
for app in Tradexpro-AdminPortal Tradexpro-UserPortal Tradexpro-NodeWallet; do
	rsync -a \
		--exclude 'vendor/' --exclude 'node_modules/' --exclude '.next/' \
		--exclude 'storage/framework/cache/' --exclude 'storage/framework/sessions/' \
		--exclude 'storage/framework/views/' --exclude 'storage/logs/' \
		--exclude 'bootstrap/cache/' --exclude '.env' --exclude '.DS_Store' \
		"$SRC/$app" "$DEST/"
done

git add -A
git -c user.name="TradeXPro (vendor)" -c user.email="vendor@localhost" \
	commit -q -m "vendor: TradeXPro ${VENDOR_VERSION} (pristine, unmodified)

Untouched upstream release, as downloaded from CodeCanyon item 39228546.

DO NOT COMMIT OUR CHANGES TO THIS BRANCH. Its only job is to be an accurate
record of what upstream shipped, so that a future release can be dropped here
and merged into main as a three-way merge.

To take a future vendor release:
    git checkout vendor
    (replace the trees with the new release, same excludes)
    git commit -m 'vendor: TradeXPro 3.3.0 (pristine, unmodified)'
    git checkout main && git merge vendor

Recorded at baseline time:
  laravel/framework  ^8.65   (security support ended January 2023)
  next               ^12.3.1
  react              17.0.2
  php                ^8.0
  migrations         163
  blade templates    356   (11 use laravelcollective Form::/Html::)
  test files         7     <-- the real risk in any upgrade
  Modules/           absent (nwidart/laravel-modules 6.0 is pinned but UNUSED)"

git tag -a "vendor-${VENDOR_VERSION}" -m "pristine TradeXPro ${VENDOR_VERSION}"

echo "==> branching main off the baseline"
git checkout -q -b main

cat > FORK.md <<EOF
# TradeXPro fork — Blockle

Forked from **TradeXPro ${VENDOR_VERSION}** (CodeCanyon item 39228546), licensed
to Alienbeing LLC.

## Branches

| Branch | Contains | Rule |
|---|---|---|
| \`vendor\` | pristine upstream releases, nothing else | **never commit our work here** |
| \`main\` | our fork | all our changes |

## Taking a future vendor release

\`\`\`
git checkout vendor
# replace the three app trees with the new release (same excludes as
# vendor-baseline.sh), then:
git commit -am "vendor: TradeXPro 3.3.0 (pristine, unmodified)"
git tag vendor-3.3.0
git checkout main
git merge vendor          # three-way: upstream's changes vs ours
\`\`\`

Because \`vendor\` holds an accurate baseline, git can tell what upstream changed
from what we changed, and surfaces only real conflicts. Without that baseline
this is a manual diff of two independently-moved trees — which is where forks
get abandoned.

## Why we forked

TradeXPro ${VENDOR_VERSION} ships \`laravel/framework: ^8.65\`. Laravel 8 stopped
receiving **security** patches in January 2023, and the vendor has shipped three
years of releases without upgrading it. There is no upstream fix, so the
framework upgrade is ours to do. See \`docs/LARAVEL-UPGRADE.md\` in the blockle
repo.

## Licence

One **Regular License**. Modification is permitted; redistribution is not.
Do not make this repository public — it contains the vendor's source.
EOF

git add FORK.md
git -c user.name="Blockle" -c user.email="dev@blockle.org" \
	commit -q -m "docs: how this fork tracks vendor releases"

echo
echo "============================================================"
echo "done. $DEST"
git --no-pager log --oneline --graph --all | head -6
echo
echo "branches:"; git branch | sed 's/^/  /'
echo
echo "NEXT: characterization tests on the money paths BEFORE touching the"
echo "framework. There are 7 test files for 2,661 — an upgrade without a"
echo "safety net is 'change everything and hope'."
echo "============================================================"
