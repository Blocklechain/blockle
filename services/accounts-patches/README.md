# Accounts-service patches applied for the exchange sign-in

The accounts service (`/opt/blockle/services/accounts` on the box) is not in
this repository, so the changes made to it are mirrored here. Without this, the
next deploy of that service from wherever its source lives would silently
revert them and the bug would come back.

## Why these exist

A user reported the exchange sign-in being "too quick to say too many
attempts". Three causes compounded, two of them in the accounts service:

1. **An absent 2FA code was counted as a failed attempt.** A client that does
   not yet know an account has 2FA posts the password alone — that response is
   the only way to find out. The handler called `acctRl.recordFailure()` for
   it, so *every* 2FA sign-in burned one against a lockout threshold of four.
   Two typos and the exponential backoff engaged. Reaching that line already
   required the correct password and the 401 reveals 2FA either way, so not
   counting it leaks nothing. A **wrong** code still counts.

2. **The failure count never decayed.** `recordFailure` only reset via
   `reset()` on a successful login, so in a process that stays up for weeks the
   count accumulated for the lifetime of the process: someone who had mistyped
   ten times over a month sat permanently one failure away from a sixteen-minute
   lockout. It now forgets failures older than the window. A burst inside the
   window still gets the full exponential backoff — `ratelimit.test.js` pins
   both halves, including that pacing attempts just under the window still
   locks.

3. The third cause was in the sign-in page itself (a throwaway probe request)
   and is fixed in `deploy/exchange/frontpage/signin.html`.

Also: the lockout response now reports `retryAfter` and a human sentence
instead of a bare "try again later", and the page holds its button for exactly
that long — leaving it live during a lockout is actively harmful, since each
attempt doubles the next delay.

## Files

- `ratelimit.js` — the patched limiter, verbatim from the box.
- `ratelimit.test.js` — 8 tests. This file had **no tests** before.
- `login-2fa-probe.snippet.js` — the patched block from the login handler, for
  reference when reapplying.

## Reapplying

`scratchpad/login2fa.py` and `scratchpad/rl.py` in the session that made these
are idempotent and print "already patched" if run twice. The anchors are exact
source strings, so they fail loudly rather than half-applying if the upstream
file has moved on.

## Note on the test suite

`npm test` in that service had two failures before these changes and still has
the same two: `liquidity.test.js` ("price rose uniformly") and
`postquantum.test.js` flagging `evmsign.js` for secp256k1. Neither references
login or the rate limiter — verified by grep and by reproducing the
postquantum failure against an unmodified copy.
