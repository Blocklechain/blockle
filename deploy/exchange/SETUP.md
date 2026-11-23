# Blockle Exchange — hosts, accounts, mail, 2FA, branding

Companion to `docs/CEX-ARCHITECTURE.md`. Everything here is **configuration of
the existing TradeXPro build**, not new code — email verification and TOTP 2FA
already ship with it (`pragmarx/google2fa-laravel`, `TwoFactorController`,
`User2FARepositorie`, and verification in `AuthController`), so these are
settings to point in the right direction rather than features to write.

> **Apply this to TradeXPro 3.2.0, not the copy currently on disk.** The local
> tree is the July 2023 build (Laravel 8.65 / Next 12.3.1); 3.2.0 (16 May 2026)
> is already paid for under the existing Envato licence. See
> `docs/CEX-ARCHITECTURE.md` §0.

---

## 1. Hosts

| Host | Serves | Config |
|---|---|---|
| `exchange.blockle.org` | Customer venue — Next.js UI + Laravel API + market socket | `nginx-exchange.blockle.org.conf` |
| `admin.blockle.org` | Admin portal (Laravel AdminPortal) | `nginx-admin.blockle.org.conf` |
| `blockle.org` | Front page + read-only market widget | widget reads `exchange.blockle.org/api/public/` |

Both vhosts assume separate PHP-FPM pools (`php8.2-fpm-exchange.sock`,
`php8.2-fpm-exchange-admin.sock`) so a request storm on the public venue cannot
starve the admin portal, and a crash in one does not take the other down.

Install:

```
cp nginx-*.conf            /etc/nginx/sites-available/
cp snippets/*.conf         /etc/nginx/snippets/
ln -s /etc/nginx/sites-available/nginx-exchange.blockle.org.conf /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/nginx-admin.blockle.org.conf    /etc/nginx/sites-enabled/
certbot certonly --webroot -w /var/www/acme -d exchange.blockle.org -d admin.blockle.org
nginx -t && systemctl reload nginx
```

DNS: both subdomains `A` → `144.126.133.21` (and `AAAA` if the host has IPv6 —
see the BitGo note in §5).

---

## 2. The admin account

One account: **`alex@blockle.org`**. Provision with
`./provision-admin.sh` from the AdminPortal root. It prompts for the password
rather than taking it as an argument or an environment variable, hashes it with
bcrypt, and writes no plaintext anywhere.

**The password discussed in chat must not be the one used.** It was transmitted
in plaintext and is therefore burned; the script enforces a 16-character floor
for a reason given below.

### Why this account is more sensitive than it looks

Withdrawals are automatic — no operator approves one. But the admin portal can
edit `velocityCap24h` and `maxPerRequest`, **and those caps are now the only
brake on an automated payout path**. Raising a cap is equivalent to authorising
a drain, and with a single operator there is no second admin who would notice.

So:

1. **Enrol TOTP immediately** (portal's own 2FA screen — already built).
2. **Fill in the IP allowlist** in the admin vhost. It ships commented out
   deliberately: an allowlist that is present but wide open reads as a control
   while being decorative. Keep a second route in (`ssh -L` to the box) so a
   changed home IP cannot lock the only admin out.
3. **Policy changes must require a fresh 2FA challenge and be journaled** to
   the append-only audit log. This is the one genuine code change in this
   document, and it is small.

---

## 3. Mail — verification from `support@blockle.org`

The box already runs Postfix/Dovecot/OpenDKIM. Point both apps' mail config at
it:

```
MAIL_MAILER=smtp
MAIL_HOST=127.0.0.1
MAIL_PORT=25
MAIL_ENCRYPTION=null
MAIL_FROM_ADDRESS=support@blockle.org
MAIL_FROM_NAME="Blockle Exchange"
```

Relaying over loopback to the local Postfix means no SMTP credentials live in
`.env` at all.

### Deliverability is the actual work here

A verification email that lands in spam is a signup funnel that silently fails,
and crypto-exchange mail is filtered aggressively. Confirm all four before
launch, because a missing one is usually enough on its own:

- **SPF** — `v=spf1 ip4:144.126.133.21 -all` on `blockle.org`
- **DKIM** — OpenDKIM signing for `blockle.org`; publish the selector TXT
- **DMARC** — start `p=none; rua=mailto:dmarc@blockle.org`, read the reports,
  then tighten to `quarantine`
- **PTR** — reverse DNS for `144.126.133.21` → a `blockle.org` hostname.
  Set at the VPS provider, not in DNS, and the single most common omission.

Then send a real test to a Gmail and an Outlook address and read the received
headers for `spf=pass dkim=pass dmarc=pass`. "It worked when I tested to my own
domain" proves nothing — your own server trusts itself.

---

## 4. 2FA for customers — optional, as asked

TOTP (Google Authenticator, Authy, 1Password, etc.) is already built. Settings:

- **Optional per user**, opt-in from account settings — as specified.
- Present it during onboarding rather than burying it in settings; an optional
  control nobody is shown has an adoption rate near zero.
- **Recovery codes at enrolment**, shown once. Without them, every lost phone
  becomes a manual identity-recovery request — and manual account recovery by a
  single operator is a social-engineering target that bypasses 2FA entirely.

### One thing to turn ON that currently is not

`app/Http/Requests/Api/User/WithdrawalRequest.php` **does not require 2FA**. I
checked.

With withdrawals fully automatic, a stolen customer session is the top
remaining risk to customer funds, and a withdrawal-time TOTP challenge is the
control that actually addresses it. Note this is a **user** control, not admin
oversight — the customer proves it is them; no operator reviews anything — so
it does not conflict with the automatic-withdrawal decision.

Recommended: require TOTP at withdrawal **for accounts that have it enrolled**,
and require enrolment above a per-asset value. That keeps 2FA optional for
signup and for small withdrawals, while not leaving large automated payouts
resting on a password alone.

---

## 5. BitGo, on this host

Observed live on 2026-11-23:

- The access token is a **test-environment** token. `app.bitgo.com` returns
  `{"error":"No access token"}`; `app.bitgo-test.com` recognises it. Test and
  production hold separate tokens. `BITGO_ENV=test` is correct.
- The token is **IP-restricted and was rejected even from the box**. Likely
  cause: the request left over **IPv6** while the whitelist holds the IPv4
  address `144.126.133.21`. Confirm with `curl -4`; if the host has IPv6
  egress, either add that address to the token's whitelist or pin the custody
  service to IPv4.

Also set **BitGo's own wallet policy limits** at the custodian. Not operator
oversight — no human approves anything — but it is the only enforcement point
that survives this service being compromised.

---

## 6. Branding

The venue should read as Blockle, not as a white-label script.

**Canonical assets in this repo:**

| Asset | Path | Use |
|---|---|---|
| Logo (512) | `src/assets/logo-512.png` | app icon, email header, OG image |
| Logo mark (128) | `src/assets/logo-mark-128.png` | favicon, nav mark, compact header |
| 3D logo | `web/assets/blockle_logo_3d.png` | hero / marketing only (1.7 MB — never in the app shell) |

**Where the branding has to be applied** (TradeXPro theming surfaces):

- `Tradexpro-UserPortal` — logo, favicon, theme tokens, `<title>`/OG tags
- `Tradexpro-AdminPortal/public/assets/admin/` — login screen and sidebar mark
- Mail templates — the header logo, and the from-name `Blockle Exchange`
- Remove every `itech-theme` reference, demo asset, and placeholder support link
  from the shipped UI (the package `README.md` is nothing but a vendor support
  URL)

**Two notes before this gets done:**

1. **Do it in the 3.2.0 tree.** Theming the 2023 build means redoing it.
2. **The front page is not in this repo.** `web/` has no `index.html` and
   `blockle-web/` is empty — `blockle.org`'s front page lives only on the box.
   Pull it into git before editing it to add the hero widget, or the change will
   be unreviewable and unrecoverable.

The widget itself must contain **no TradeXPro code** — first-party markup
against `/api/public/`. That is a licence constraint (one end product) as well
as the right engineering call; see `docs/CEX-ARCHITECTURE.md` §0 and §8.
