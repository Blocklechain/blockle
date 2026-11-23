#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Put the setup console on the box. Run from a CHECKOUT ON YOUR MAC:
#
#   ./deploy/exchange/install-console.sh
#
# It copies the console and the custody service to the box, builds them,
# generates a bootstrap token, installs the systemd unit and the nginx vhosts,
# and prints the one URL you need.
#
# AFTER THIS, the only thing left that needs a human is the Envato download.
#
# WHY THIS RUNS FROM THE MAC rather than being a thing you clone on the box:
# the repository is not on the box and should not be — a server that holds
# customer funds does not need a full source checkout with git history and
# credentials in it. The box gets built artifacts and nothing else.
# -----------------------------------------------------------------------------
set -euo pipefail

BOX="${BOX:-root@144.126.133.21}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "repo:  $REPO"
echo "box:   $BOX"
echo

# --- 1. sanity: are we actually in the repo? --------------------------------
for p in exchange/bootstrap/package.json exchange/custody/package.json \
         deploy/exchange/nginx-blockle.org.conf; do
	[ -f "$REPO/$p" ] || { echo "error: $p missing — wrong directory?" >&2; exit 1; }
done

# --- 2. build locally, ship the output -------------------------------------
# Building here rather than on the box keeps node_modules and the toolchain off
# a funds-critical host, and fails fast on a type error before anything is
# copied.
echo "==> building bootstrap console"
( cd "$REPO/exchange/bootstrap" && npm install --silent && npm run build >/dev/null )
echo "==> building custody service"
( cd "$REPO/exchange/custody" && npm install --silent && npm run build >/dev/null )

echo "==> running the custody tests before shipping anything"
# Run ONCE and capture. Two separate runs wasted a minute, and the check used
# `| grep -q`, which is broken under `set -o pipefail`:
#
#   grep -q exits the moment it matches -> the pipe closes -> node --test dies
#   with SIGPIPE -> pipefail reports the PIPELINE as failed.
#
# So a SUCCESSFUL match produced a non-zero status, and the guard rejected a
# perfectly green suite ("# fail 0" printed directly above "tests are not
# green"). Capturing first removes the pipe from the decision entirely.
TEST_OUT="$( cd "$REPO/exchange/custody" && node --test dist/test/ 2>&1 )" || true
printf '%s\n' "$TEST_OUT" | grep -E '^# (tests|pass|fail)' || true
case "$TEST_OUT" in
	*"# fail 0"*) : ;;
	*)
		echo "error: custody tests are not green. Not shipping a red money path." >&2
		exit 1
		;;
esac

# --- 3. copy ----------------------------------------------------------------
echo "==> copying to the box"
ssh "$BOX" 'install -d /opt/blockle/exchange-bootstrap /opt/blockle/exchange-custody \
                        /etc/blockle /var/lib/exchange-bootstrap'

# node_modules is needed at runtime (better-sqlite3 is native), so it ships too.
for src in bootstrap custody; do
	rsync -az --delete \
		--exclude '.git' --exclude 'test' \
		"$REPO/exchange/$src/dist" \
		"$REPO/exchange/$src/package.json" \
		"$REPO/exchange/$src/node_modules" \
		"$BOX:/opt/blockle/exchange-$src/"
done
rsync -az "$REPO/exchange/bootstrap/public/" "$BOX:/opt/blockle/exchange-bootstrap/public/"
# The console's step actions reference the deploy tree by absolute path.
rsync -az "$REPO/deploy/" "$BOX:/opt/blockle/deploy/"
# Branding assets the install steps copy into both portals.
ssh "$BOX" 'install -d /opt/blockle/src/assets'
rsync -az "$REPO/src/assets/logo-512.png" "$REPO/src/assets/logo-mark-128.png" \
	"$BOX:/opt/blockle/src/assets/"

# --- 4. token ---------------------------------------------------------------
# Generated ON THE BOX and never printed in full here, so it does not land in
# this terminal's scrollback or your shell history. You read it from the
# root-only file when you need it.
echo "==> generating the bootstrap token (on the box, root-only)"
ssh "$BOX" 'bash -s' <<'REMOTE'
set -e
if [ ! -f /etc/blockle/exchange-bootstrap.env ]; then
	T="$(openssl rand -hex 32)"
	printf 'BOOTSTRAP_TOKEN=%s\nBOOTSTRAP_PORT=8099\nBITGO_ENV=test\n' "$T" \
		> /etc/blockle/exchange-bootstrap.env
	chmod 600 /etc/blockle/exchange-bootstrap.env
	echo "   token generated"
else
	echo "   token already exists — keeping it"
fi
REMOTE

# --- 5. systemd + nginx -----------------------------------------------------
echo "==> installing the systemd unit"
ssh "$BOX" 'install -m644 /opt/blockle/deploy/exchange/exchange-bootstrap.service \
              /etc/systemd/system/ && systemctl daemon-reload \
            && systemctl enable --now exchange-bootstrap && sleep 2 \
            && systemctl is-active exchange-bootstrap'

echo "==> issuing certificates (ACME vhost first — see nginx-acme-bootstrap.conf)"
ssh "$BOX" 'bash -s' <<'REMOTE'
set -e
install -d /etc/nginx/snippets /var/www/acme
install -m644 /opt/blockle/deploy/exchange/snippets/*.conf /etc/nginx/snippets/

# ORDER MATTERS, and getting it wrong is a hard failure rather than a warning.
# The real admin vhost names a certificate file; nginx cannot PARSE the config
# if that file is absent ("cannot load certificate ... BIO_new_file() failed"),
# and certbot cannot create it without nginx already answering :80 for the
# hostname. So: TLS-less ACME vhost -> reload -> certbot -> real vhost.
NEED=""
for h in admin.blockle.org coin.blockle.org; do
	[ -f "/etc/letsencrypt/live/$h/fullchain.pem" ] || NEED="$NEED -d $h"
done

if [ -n "$NEED" ]; then
	echo "   missing certs for:$NEED"
	install -m644 /opt/blockle/deploy/exchange/nginx-acme-bootstrap.conf \
		/etc/nginx/sites-available/
	ln -sf /etc/nginx/sites-available/nginx-acme-bootstrap.conf /etc/nginx/sites-enabled/
	if ! nginx -t >/dev/null 2>&1; then
		nginx -t 2>&1 | tail -4 >&2
		rm -f /etc/nginx/sites-enabled/nginx-acme-bootstrap.conf
		echo "   error: the ACME vhost itself does not load; aborting." >&2
		exit 1
	fi
	systemctl reload nginx
	echo "   ACME vhost live; requesting certificates ..."
	# shellcheck disable=SC2086
	if ! certbot certonly --non-interactive --agree-tos --webroot -w /var/www/acme \
		-m support@blockle.org $NEED 2>&1 | tail -6; then
		echo "   error: certbot failed. The ACME vhost is left in place so you can" >&2
		echo "   retry; DNS for these names already points here, so the usual cause" >&2
		echo "   is rate limiting or port 80 being filtered." >&2
		exit 1
	fi
	rm -f /etc/nginx/sites-enabled/nginx-acme-bootstrap.conf
	echo "   certificates issued"
else
	echo "   certificates already present"
fi
REMOTE

echo "==> installing the nginx vhosts"
ssh "$BOX" 'bash -s' <<'REMOTE'
set -e
install -m644 /opt/blockle/deploy/exchange/nginx-admin.blockle.org.conf /etc/nginx/sites-available/
install -m644 /opt/blockle/deploy/exchange/nginx-blockle.org.conf       /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/nginx-admin.blockle.org.conf /etc/nginx/sites-enabled/
# The superseded exchange.blockle.org vhost would collide on server_name.
rm -f /etc/nginx/sites-enabled/nginx-exchange.blockle.org.conf

# nginx-blockle.org.conf is NOT enabled here. It takes over the live front page
# and needs its certificate first; enabling it blind would take blockle.org
# down. The console's own steps handle it once certs exist.

# TEST THE CONFIG PROPERLY, AND UNLINK IT IF IT IS BAD.
#
# The previous version was `if nginx -t 2>&1 | tail -2; then reload; fi`, which
# is worthless: a pipeline's exit status is its LAST command's, and `tail`
# always succeeds. So the reload ran even though nginx -t had failed, and —
# far worse — a config that cannot parse was left symlinked in sites-enabled.
# nginx keeps serving the old config after a failed RELOAD, so nothing looks
# broken; but the next genuine restart (a reboot, say) would fail to start
# nginx at all and take every site on the box down.
#
# So: capture the output, branch on the real status, and remove the symlink on
# failure rather than leaving a loaded gun for the next reboot.
if NGINX_OUT="$(nginx -t 2>&1)"; then
	echo "$NGINX_OUT" | tail -1
	systemctl reload nginx
	echo "   nginx reloaded"
else
	echo "$NGINX_OUT" | tail -5 >&2
	echo >&2
	echo "   nginx -t FAILED — unlinking the admin vhost so that a reboot cannot" >&2
	echo "   fail to start nginx and take the whole box's sites down." >&2
	rm -f /etc/nginx/sites-enabled/nginx-admin.blockle.org.conf
	if nginx -t >/dev/null 2>&1; then
		echo "   config is valid again without it; nginx left untouched and serving." >&2
	else
		echo "   WARNING: nginx -t still fails with it removed — a PRE-EXISTING" >&2
		echo "   problem, not one this script introduced. Investigate before any" >&2
		echo "   reboot." >&2
	fi
	exit 1
fi
REMOTE

# --- 6. the one URL ---------------------------------------------------------
echo
echo "============================================================"
ssh "$BOX" 'echo "Open this once to authenticate, then bookmark /setup/:"
echo
echo "  https://admin.blockle.org/setup/auth?t=$(grep -oP "(?<=BOOTSTRAP_TOKEN=).*" /etc/blockle/exchange-bootstrap.env)"
echo
echo "If admin.blockle.org has no certificate yet, tunnel instead:"
echo "  ssh -L 8099:127.0.0.1:8099 '"$BOX"'"
echo "  then http://127.0.0.1:8099/auth?t=<token from /etc/blockle/exchange-bootstrap.env>"'
echo "============================================================"
echo
echo "Then: log in to Envato -> Downloads -> item 39228546, download the main"
echo "files, and DRAG THE ZIP onto that page. Everything else runs itself."
