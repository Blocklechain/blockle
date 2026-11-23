#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Provision the single exchange admin account.
#
# WHY THIS IS A SCRIPT AND NOT A SEEDER COMMITTED TO THE REPO.
#
# The obvious implementation is a Laravel seeder with the credentials in it.
# That puts a live admin password for a venue holding customer funds into git,
# where it survives in history forever even after it is "removed", and gets
# copied to every clone, CI runner, and backup. So: the password is read from
# the environment at run time, hashed by Laravel's own bcrypt, and never
# written anywhere in plaintext — not to a file, not to shell history, not to
# the script's own output.
#
# USAGE (on the box, as the deploy user):
#
#   cd /var/www/exchange-admin
#   ADMIN_EMAIL=alex@blockle.org ./provision-admin.sh
#
# It will PROMPT for the password rather than take it on the command line,
# because a command line is visible in `ps` to every other user on the host and
# is recorded in shell history.
# -----------------------------------------------------------------------------
set -euo pipefail

ADMIN_EMAIL="${ADMIN_EMAIL:-alex@blockle.org}"
ARTISAN="${ARTISAN:-php artisan}"

if [ ! -f artisan ]; then
	echo "error: run this from the AdminPortal root (no ./artisan here)" >&2
	exit 1
fi

# Read the password without echoing it, and never put it in a variable that
# gets exported to a child process's environment (readable via /proc on some
# configurations).
printf 'Password for %s (not echoed): ' "$ADMIN_EMAIL" >&2
IFS= read -rs ADMIN_PASSWORD
printf '\n' >&2
printf 'Confirm: ' >&2
IFS= read -rs ADMIN_PASSWORD_CONFIRM
printf '\n' >&2

if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
	echo "error: passwords do not match" >&2
	exit 1
fi
unset ADMIN_PASSWORD_CONFIRM

# A LENGTH FLOOR, NOT A CHARACTER-CLASS RULE. Composition rules ("one capital,
# one symbol") push people toward Password1! and measurably do not help; length
# does. 16 is the floor here because this one account can edit the velocity
# caps that are the only brake on an automated withdrawal path.
if [ "${#ADMIN_PASSWORD}" -lt 16 ]; then
	echo "error: that password is ${#ADMIN_PASSWORD} characters; this account can" >&2
	echo "       change the withdrawal velocity caps, which are the only limit on" >&2
	echo "       an automated payout path. Use at least 16 characters." >&2
	exit 1
fi

# Hand the password to PHP on STDIN — not as an argument, not via the
# environment. Laravel hashes it with bcrypt; the plaintext never leaves this
# pipe.
printf '%s' "$ADMIN_PASSWORD" | $ARTISAN tinker --execute='
$email = getenv("ADMIN_EMAIL") ?: "alex@blockle.org";
$plain = trim(stream_get_contents(STDIN));
if ($plain === "") { fwrite(STDERR, "no password on stdin\n"); exit(1); }

$user = \App\User::where("email", $email)->first();
if ($user === null) {
    $user = new \App\User();
    $user->email = $email;
    $user->created_at = now();
    $action = "created";
} else {
    $action = "updated";
}
$user->name = "Alex";
$user->password = bcrypt($plain);
$user->email_verified_at = now();
$user->status = 1;
$user->save();

echo "admin {$action}: {$email}\n";
echo "2FA enrolled: " . ($user->two_fa_status ?? 0 ? "yes" : "NO — enrol before going live\n");
' ADMIN_EMAIL="$ADMIN_EMAIL"

unset ADMIN_PASSWORD

cat >&2 <<'NOTE'

--------------------------------------------------------------------------
DONE. Two things remain, and neither is optional for a funds-critical panel:

1. ENROL TOTP on this account immediately, in the portal's own 2FA screen.
   TradeXPro ships pragmarx/google2fa-laravel, so this is a UI step, not a
   build. A single-operator portal has no "another admin would notice"
   property — the second factor is the only thing a stolen password hits.

2. CONFIRM the IP allowlist in nginx-admin.blockle.org.conf is filled in and
   uncommented. It ships commented out deliberately: an allowlist that is
   present but wide open reads as a control while being decorative.
--------------------------------------------------------------------------
NOTE
