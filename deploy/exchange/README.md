# Exchange deployment

## Which nginx config to install

| File | Install? | Serves |
|---|---|---|
| `nginx-blockle.org.conf` | **YES** | `blockle.org` (the exchange, at the root), `coin.blockle.org` (the former site), and a 301 for `exchange.blockle.org` → root |
| `nginx-admin.blockle.org.conf` | **YES** | `admin.blockle.org` (admin portal + setup console) |
| `nginx-exchange.blockle.org.conf.superseded` | **NO** | Superseded. Kept for reference only. |

> **Why the `.superseded` rename matters.** That file and
> `nginx-blockle.org.conf` both declare `server_name exchange.blockle.org` on
> port 443. nginx does not error on a duplicate server_name — it emits a
> *warning* and silently serves whichever config it loaded first. So the bug
> would present as "exchange.blockle.org works on some reloads and redirects on
> others", which is miserable to diagnose. The extension keeps it out of any
> `sites-enabled/*.conf` glob.

Install:

```
cp nginx-blockle.org.conf nginx-admin.blockle.org.conf /etc/nginx/sites-available/
cp snippets/*.conf /etc/nginx/snippets/
ln -s /etc/nginx/sites-available/nginx-blockle.org.conf       /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/nginx-admin.blockle.org.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/nginx-exchange.blockle.org.conf   # if previously linked
nginx -t && systemctl reload nginx
```

Certificates must cover all four names:

```
certbot certonly --webroot -w /var/www/acme -m support@blockle.org --agree-tos \
  -d blockle.org -d www.blockle.org -d coin.blockle.org \
  -d exchange.blockle.org -d admin.blockle.org
```

## Paths that must never move

`nginx-blockle.org.conf` carves out a set of paths that are **compiled into
already-shipped wallets** (App Store / Play / Chrome Web Store builds that
cannot be force-upgraded) and serves them in place from the existing site
upstream rather than redirecting:

`/api/` · `/account/api/` · `/px/` · `/tx/` · `/explorer` · `/assets/` ·
`/wallet` · `/logo.png` · `/usdb-token.svg` · `/world-token.svg` · `/done` ·
`/sellers` · `/robots.txt` · `/sitemap.xml` · `/site.webmanifest`

A 301 is not good enough for these: it works in a browser but is not reliably
followed by an HTTP client inside a mobile app, and the failure surfaces to the
user as a broken wallet rather than as a moved page.

**`/account/api/moonpay/webhook` is the sharpest one** — that URL is registered
on MoonPay's side. If it redirects or moves, MoonPay's callbacks stop arriving
and fiat purchases fail with no visible error until a customer complains.

## Other files here

| File | What |
|---|---|
| `SETUP.md` | Hosts, admin account, mail, 2FA, branding — the configuration spec |
| `frontpage/index.html` | The new `blockle.org` front page (exchange + links to everything that moved) |
| `provision-admin.sh` | Creates `alex@blockle.org`; prompts for the password, stores only a bcrypt hash |
| `snippets/exchange-fastcgi.conf` | Shared FastCGI block, so the rate-limited auth path and the general API path cannot drift |
