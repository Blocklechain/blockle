#!/usr/bin/env bash
# Copyright (c) 2016-2019 The Blockle Core developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.

export LC_ALL=C
TOPDIR=${TOPDIR:-$(git rev-parse --show-toplevel)}
BUILDDIR=${BUILDDIR:-$TOPDIR}

BINDIR=${BINDIR:-$BUILDDIR/src}
MANDIR=${MANDIR:-$TOPDIR/doc/man}

PALLADIUMD=${PALLADIUMD:-$BINDIR/blockled}
PALLADIUMCLI=${PALLADIUMCLI:-$BINDIR/blockle-cli}
PALLADIUMTX=${PALLADIUMTX:-$BINDIR/blockle-tx}
WALLET_TOOL=${WALLET_TOOL:-$BINDIR/blockle-wallet}
PALLADIUMQT=${PALLADIUMQT:-$BINDIR/qt/blockle-qt}

[ ! -x $PALLADIUMD ] && echo "$PALLADIUMD not found or not executable." && exit 1

# The autodetected version git tag can screw up manpage output a little bit
read -r -a PLMVER <<< "$($PALLADIUMCLI --version | head -n1 | awk -F'[ -]' '{ print $6, $7 }')"

# Create a footer file with copyright content.
# This gets autodetected fine for blockled if --version-string is not set,
# but has different outcomes for blockle-qt and blockle-cli.
echo "[COPYRIGHT]" > footer.h2m
$PALLADIUMD --version | sed -n '1!p' >> footer.h2m

for cmd in $PALLADIUMD $PALLADIUMCLI $PALLADIUMTX $WALLET_TOOL $PALLADIUMQT; do
  cmdname="${cmd##*/}"
  help2man -N --version-string=${PLMVER[0]} --include=footer.h2m -o ${MANDIR}/${cmdname}.1 ${cmd}
  sed -i "s/\\\-${PLMVER[1]}//g" ${MANDIR}/${cmdname}.1
done

rm -f footer.h2m
