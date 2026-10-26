# Blockle Launchpad service

A **paid developer / listing service** that gates BLOCK-20 token launches and sells
Featured/Boost placement. The PayPal charge is a *service fee* — it is **not** a
sale of BLOCK or of the launched token. Users deploy their own token and seed their
own pool liquidity by signing in their own (non-custodial) wallet.

Loopback HTTP on `127.0.0.1:8808`; nginx proxies `/api/launch/*` → it.

## Economics (env-tunable in `launchpad.service`)
- Launches **1..1000** (`LAUNCHPAD_PROMO_CAP`): fee **$5** (`FEE_PROMO_USD`), optional
  free **50 BLOCK** preseed (`PRESEED_BLOCK`) sent to the launcher's address.
- Launches **1001+**: fee **$1** (`FEE_STD_USD`), no preseed.
- Add-ons (advertising): Featured $10/24h, $25/7d; Boost $5/24h, $15/7d.
- LP lock is the chain's fixed **1 week** today (longer, user-selectable locks need a
  consensus/node upgrade — see the chain `pools.rs` `LP_LOCK_BLOCKS`).

## Endpoints
- `GET  /api/launch/config`   — phase, fee, preseed availability, prices, payments on/off.
- `POST /api/launch/order`    — `{tier:'launch'|'featured'|'boost', address?, preseed?, token?, duration?}` → `{orderId, approveUrl, usd}`.
- `POST /api/launch/capture`  — `{orderId}` → poll after PayPal approval; captures, applies add-on / sends preseed.
- `POST /api/launch/register` — `{orderId, token, logo}` → registers logo + listing, advances launch counter.
- `GET  /api/launch/listings` — `{featured:[], boosted:[]}` (DEX pins/ranks by these).

## Safety
- The preseed is a **transfer** from the platform wallet — never a mint. Bounded by
  `PROMO_CAP`, `PRESEED_MAX_PER_ADDR`, `PRESEED_DAILY_CAP`, and the wallet balance.
- If PayPal creds or the preseed wallet are missing, the service serves `/config`
  honestly (payments off / preseed unavailable) and refuses orders — it never fakes
  a charge or a txid.

## Operator wiring (box)
1. **PayPal (done):** live creds in `/opt/blockle/secrets/launchpad.env`
   (`PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_ENV=live`), chmod 600.
2. **Preseed wallet (needs funding):** key at `/opt/blockle/secrets/launch-block.json`
   (generated empty). Address:
   `block1fva7qp2t8vtfk2hay2crngxr0m3dwjhuyfem5jrlfzgrxlvgfr3q6zrw5u`
   Send premine BLOCK to it — up to **50,000 BLOCK** funds all 1000 promo preseeds.
   Until funded, `preseedAvailable=false` and launches proceed **without** the free
   preseed (the $5 fee + launch still work).
3. `systemctl restart blockle-launchpad` after any env change.

Vendored `./wasm` (the ML-DSA signer / tx builder) must be present for the preseed
transfer — copied from the faucet service at deploy time.
