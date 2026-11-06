"""blockle.moonpay — MoonPay fiat on-ramp URL builder for the wallet clients.

MoonPay's "buy" flow is just a hosted URL: open it in a browser and MoonPay
runs its own KYC + card/bank payment and delivers crypto to ``walletAddress``.
We never see cards or PII.

Security model (HARD RULES):
  * The PUBLISHABLE key (``pk_test_…`` / ``pk_live_…``) is client-side and safe
    to embed/commit. It is the only key this module defaults to.
  * The SECRET key is NEVER hardcoded, committed or logged. It only ever lives
    server-side. :func:`sign_url` accepts a secret the *caller* supplies (e.g.
    from an env var on a server) — it is optional and used only for production
    signed URLs. Sandbox (``pk_test_``) URLs work unsigned.

The base host is derived from the key PREFIX:
  * ``pk_live_…`` -> https://buy.moonpay.com   (production)
  * anything else -> https://buy-sandbox.moonpay.com   (sandbox / test)

Everything here is pure stdlib so the three wallet clients and the test suite
can import it without extra deps.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import os
import re
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote, urlencode, urlsplit

# --------------------------------------------------------------------------
# API key + base host
# --------------------------------------------------------------------------

#: Default PUBLISHABLE (client-side, non-secret) key. Sandbox. Swap for the
#: ``pk_live_…`` key on approval — via :func:`api_key` override or the
#: ``BLOCKLE_MOONPAY_API_KEY`` env var, no code change required.
DEFAULT_API_KEY = "pk_test_uRXfpYr99uQJibabWff6BlZYIzzFONLF"

#: Env var that overrides :data:`DEFAULT_API_KEY` (so ops can flip to live).
API_KEY_ENV = "BLOCKLE_MOONPAY_API_KEY"

SANDBOX_BASE = "https://buy-sandbox.moonpay.com"
LIVE_BASE = "https://buy.moonpay.com"

#: Sell (off-ramp) hosts — same key-prefix rule as the buy hosts above.
SELL_SANDBOX_BASE = "https://sell-sandbox.moonpay.com"
SELL_LIVE_BASE = "https://sell.moonpay.com"

# --------------------------------------------------------------------------
# accounts-service MoonPay endpoints (the live source of truth) + remote config
# --------------------------------------------------------------------------
#
# The clients hold ONLY the publishable key + the commerce PUBLIC key (both from
# /config). Signing, Trade-API auth, Commerce-secret auth and webhook verification
# all stay server-side behind these pinned endpoints. NO secret ever lives here.

#: Public — the publishable key + commerce public key + feature flags (no auth).
CONFIG_ENDPOINT = "https://blockle.org/account/api/moonpay/config"
#: Public — signs a buy/sell widget URL with the server-held secret.
SIGN_ENDPOINT = "https://blockle.org/account/api/moonpay/sign"
#: Authed — proxy to the MoonPay Trade (swap) API (trade key stays server-side).
SWAP_ENDPOINT = "https://blockle.org/account/api/moonpay/swap"
#: Authed — proxy to MoonPay Commerce (crypto checkout); grants flip server-side.
COMMERCE_ENDPOINT = "https://blockle.org/account/api/moonpay/commerce"

#: Cached /config payload (set by :func:`load_remote_config`). ``None`` => never
#: loaded; callers fall back to the ``pk_test`` sandbox default + permissive
#: feature gating. This is the source of truth for the publishable key once set.
_REMOTE_CONFIG: Optional[Dict] = None


def api_key(override: Optional[str] = None) -> str:
    """Resolve the publishable key: explicit override > remote /config > env >
    built-in sandbox default."""
    if override:
        return override
    if _REMOTE_CONFIG and _REMOTE_CONFIG.get("publishableKey"):
        return str(_REMOTE_CONFIG["publishableKey"])
    return os.environ.get(API_KEY_ENV) or DEFAULT_API_KEY


def base_url(key: Optional[str] = None) -> str:
    """Derive the MoonPay host from the key prefix. ``pk_live_`` -> production,
    everything else (``pk_test_``, empty, unknown) -> sandbox."""
    k = key or api_key()
    return LIVE_BASE if k.startswith("pk_live_") else SANDBOX_BASE


def sell_base_url(key: Optional[str] = None) -> str:
    """Derive the MoonPay SELL (off-ramp) host from the key prefix. Same rule
    as :func:`base_url`: ``pk_live_`` -> production, everything else -> sandbox."""
    k = key or api_key()
    return SELL_LIVE_BASE if k.startswith("pk_live_") else SELL_SANDBOX_BASE


def is_live(key: Optional[str] = None) -> bool:
    return (key or api_key()).startswith("pk_live_")


# --------------------------------------------------------------------------
# asset (chain + symbol) -> MoonPay currencyCode
# --------------------------------------------------------------------------
#
# Best-effort, config/overridable. If an asset has no entry here it is NOT on
# MoonPay (for us) and the caller MUST hide the buy button for it.
#
# Keys are the wallet's own chain ids (see qtmultichain.CHAIN_ORDER).

#: Native coin per chain. ``None`` means "native not purchasable" (hide).
NATIVE_CURRENCY_CODES: Dict[str, Optional[str]] = {
    "block": None,          # BLOCK is NOT on MoonPay — never show a button
    "ethereum": "eth",
    "base": "eth_base",     # Base ETH; falls back handled by callers if needed
    "arbitrum": "eth_arbitrum",
    "optimism": "eth_optimism",
    "polygon": "pol_polygon",   # Polygon native (POL / MATIC)
    "bnb": "bnb_bsc",
    "avalanche": "avax_cchain",
    "hyperevm": "hype",     # HYPE — may not yet be listed on MoonPay (verify live)
    "bitcoin": "btc",
    "litecoin": "ltc",
    "dogecoin": "doge",
    "bitcoincash": "bch",
    "solana": "sol",
    "tron": "trx",
    "ton": "ton",
    "xrp": "xrp",
    "stellar": "xlm",
    "tezos": "xtz",
    "cardano": "ada",
}

#: Token overlays, keyed by (chain, SYMBOL-UPPER) -> MoonPay code.
TOKEN_CURRENCY_CODES: Dict[Tuple[str, str], str] = {
    ("ethereum", "USDC"): "usdc",
    ("ethereum", "USDT"): "usdt",
    ("ethereum", "XAUT"): "xaut",
    ("ethereum", "LINK"): "link",
    ("ethereum", "POL"): "pol",
    ("base", "USDC"): "usdc_base",
    ("base", "USDT"): "usdt",
    ("arbitrum", "USDC"): "usdc_arbitrum",
    ("arbitrum", "USDT"): "usdt_arbitrum",
    ("optimism", "USDC"): "usdc_optimism",
    ("optimism", "USDT"): "usdt",
    ("polygon", "USDC"): "usdc_polygon",
    ("polygon", "USDT"): "usdt_polygon",
    ("bnb", "USDC"): "usdc_bsc",
    ("bnb", "USDT"): "usdt_bsc",
    ("avalanche", "USDC"): "usdc_cchain",
    ("avalanche", "USDT"): "usdt",
    ("solana", "USDC"): "usdc_sol",
    ("solana", "USDT"): "usdt_sol",
    ("tron", "USDT"): "usdt_tron",
    ("ton", "USDT"): "usdt_ton",
}


def currency_code(
    chain: str,
    symbol: Optional[str] = None,
    *,
    native_symbol: Optional[str] = None,
    overrides: Optional[Dict] = None,
) -> Optional[str]:
    """Map a wallet asset to a MoonPay ``currencyCode``, or ``None`` if the
    asset is not supported (caller hides the button).

    ``symbol`` ``None`` (or equal to ``native_symbol``) means the chain's native
    coin. ``overrides`` may carry ``{"native": {...}, "token": {(chain,SYM):...}}``
    to swap codes without touching this module.
    """
    native_map = dict(NATIVE_CURRENCY_CODES)
    token_map = dict(TOKEN_CURRENCY_CODES)
    if overrides:
        native_map.update(overrides.get("native") or {})
        token_map.update(overrides.get("token") or {})

    is_native = symbol is None or (
        native_symbol is not None and symbol.upper() == native_symbol.upper()
    )
    if is_native:
        return native_map.get(chain)
    return token_map.get((chain, (symbol or "").upper()))


def supported_assets(
    chain: str,
    *,
    native_symbol: Optional[str] = None,
    token_symbols: Optional[List[str]] = None,
    overrides: Optional[Dict] = None,
) -> List[Tuple[str, str]]:
    """Return the ``(display_symbol, currencyCode)`` pairs on ``chain`` that
    MoonPay can sell. Empty list -> hide the whole buy affordance for the row."""
    out: List[Tuple[str, str]] = []
    if native_symbol:
        code = currency_code(chain, native_symbol, native_symbol=native_symbol,
                             overrides=overrides)
        if code:
            out.append((native_symbol, code))
    for sym in token_symbols or []:
        if native_symbol and sym.upper() == native_symbol.upper():
            continue
        code = currency_code(chain, sym, native_symbol=native_symbol,
                             overrides=overrides)
        if code:
            out.append((sym, code))
    return out


def sell_amount(display: Optional[str]) -> Optional[str]:
    """Trim a human-units balance (a row's ``display`` string) to a MoonPay-safe
    SELL pre-fill amount: a plain positive decimal, at most 8 fractional digits,
    trailing zeros stripped. Returns ``None`` for zero/blank/unparseable values
    so the widget opens WITHOUT a pre-filled amount (never pass 0 or junk)."""
    if display is None:
        return None
    s = str(display).strip().replace(",", "")
    if not re.fullmatch(r"\d*\.?\d+", s):  # plain non-negative decimal only
        return None
    if "." in s:
        whole, frac = s.split(".", 1)
        s = (whole + "." + frac[:8]).rstrip("0").rstrip(".")
    try:
        return s if s and float(s) > 0 else None
    except ValueError:
        return None


def is_block(chain: str) -> bool:
    """BLOCK has no MoonPay listing — buy a supported asset then swap to BLOCK."""
    return chain == "block"


#: Short user-facing note shown instead of a button for BLOCK.
BLOCK_NOTE = (
    "BLOCK is not available on MoonPay. Buy a supported asset (e.g. ETH, BTC or "
    "USDC) with a card, then swap it to BLOCK on the Exchange or via the /buy "
    "curve."
)


# --------------------------------------------------------------------------
# widget URL builder
# --------------------------------------------------------------------------


def build_widget_url(
    *,
    wallet_address: str,
    currency_code: str,  # noqa: A002 — mirrors MoonPay's param name
    api_key: Optional[str] = None,  # noqa: A002
    base_currency_code: Optional[str] = None,
    base_currency_amount: Optional[str] = None,
    redirect_url: Optional[str] = None,
    color_code: Optional[str] = None,
    theme: Optional[str] = None,
    extra: Optional[Dict[str, str]] = None,
    signature: Optional[str] = None,
) -> str:
    """Build the MoonPay buy-widget URL.

    Only ``apiKey``, ``walletAddress`` and ``currencyCode`` are required; the
    rest are optional MoonPay params. ``signature`` (base64, from
    :func:`sign_url`) is appended url-encoded for production signed URLs.
    """
    if not wallet_address:
        raise ValueError("wallet_address is required")
    if not currency_code:
        raise ValueError("currency_code is required")

    key = globals()["api_key"](api_key)
    params: Dict[str, str] = {
        "apiKey": key,
        "walletAddress": wallet_address,
        "currencyCode": currency_code,
    }
    if base_currency_code:
        params["baseCurrencyCode"] = base_currency_code
    if base_currency_amount is not None:
        params["baseCurrencyAmount"] = str(base_currency_amount)
    if redirect_url:
        params["redirectURL"] = redirect_url
    if color_code:
        params["colorCode"] = color_code
    if theme:
        params["theme"] = theme
    if extra:
        for k, v in extra.items():
            if v is not None:
                params[k] = str(v)

    url = base_url(key) + "?" + urlencode(params)
    if signature:
        url += "&signature=" + quote(signature, safe="")
    return url


def build_sell_widget_url(
    *,
    base_currency_code: str,  # the CRYPTO being sold (reuses the buy code map)
    wallet_address: Optional[str] = None,
    api_key: Optional[str] = None,  # noqa: A002
    quote_currency_code: Optional[str] = "usd",  # fiat paid out
    base_currency_amount: Optional[str] = None,
    redirect_url: Optional[str] = None,
    color_code: Optional[str] = None,
    theme: Optional[str] = None,
    extra: Optional[Dict[str, str]] = None,
    signature: Optional[str] = None,
) -> str:
    """Build the MoonPay SELL-widget (off-ramp) URL.

    Opening it launches MoonPay's hosted KYC + payout flow: the user sends
    ``base_currency_code`` crypto (same codes as the buy map) from
    ``wallet_address`` and MoonPay pays fiat (``quote_currency_code``) to their
    bank. We never touch banking details or PII.

    Only ``apiKey`` and ``baseCurrencyCode`` are required; the rest are optional
    MoonPay params. ``signature`` (base64, from the same :func:`sign_url` /
    signer endpoint as buy) is appended url-encoded for production signed URLs.
    """
    if not base_currency_code:
        raise ValueError("base_currency_code is required")

    key = globals()["api_key"](api_key)
    params: Dict[str, str] = {
        "apiKey": key,
        "baseCurrencyCode": base_currency_code,
    }
    if quote_currency_code:
        params["quoteCurrencyCode"] = quote_currency_code
    if wallet_address:
        params["walletAddress"] = wallet_address
    if base_currency_amount is not None:
        params["baseCurrencyAmount"] = str(base_currency_amount)
    if redirect_url:
        params["redirectURL"] = redirect_url
    if color_code:
        params["colorCode"] = color_code
    if theme:
        params["theme"] = theme
    if extra:
        for k, v in extra.items():
            if v is not None:
                params[k] = str(v)

    url = sell_base_url(key) + "?" + urlencode(params)
    if signature:
        url += "&signature=" + quote(signature, safe="")
    return url


# --------------------------------------------------------------------------
# URL signing — SERVER-SIDE ONLY (secret supplied by caller, never stored here)
# --------------------------------------------------------------------------


def sign_query(query: str, secret_key: str) -> str:
    """HMAC-SHA256 the URL query (the part after ``?``, with or without the
    leading ``?``) with the SECRET key and return the base64 signature.

    The secret is passed in by the caller from a server-side env/config and is
    never retained or logged by this module.
    """
    if not secret_key:
        raise ValueError("secret_key is required to sign")
    search = query if query.startswith("?") else "?" + query
    digest = hmac.new(secret_key.encode(), search.encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


def sign_url(url: str, secret_key: str) -> str:
    """Return ``url`` with a ``&signature=…`` appended, signing its existing
    query string. Use only for production (``pk_live_``) with a server-held
    secret; sandbox URLs do not need this."""
    search = urlsplit(url).query
    sig = sign_query("?" + search, secret_key)
    return url + "&signature=" + quote(sig, safe="")


#: Optional: a server endpoint that returns a signed widget URL. When set, the
#: client POSTs the unsigned params and gets back a signed URL — so the secret
#: stays on that server. Empty/None => clients just open the (sandbox) URL.
SIGNER_URL_ENV = "BLOCKLE_MOONPAY_SIGNER_URL"


def signer_url(override: Optional[str] = None) -> Optional[str]:
    """Resolve the signing endpoint: explicit override > the pinned live
    :data:`SIGN_ENDPOINT` (once /config reports ``live``) > env > None. Sandbox
    (``pk_test_``) URLs open unsigned, so no endpoint is pinned until /config
    says the publishable key is live."""
    if override:
        return override
    if _REMOTE_CONFIG is not None and _REMOTE_CONFIG.get("live"):
        return SIGN_ENDPOINT
    return os.environ.get(SIGNER_URL_ENV) or None


def fetch_signed_url(unsigned_url: str, *, endpoint: Optional[str] = None,
                     timeout: float = 8.0) -> Optional[str]:
    """Best-effort: ask a configured signing endpoint to sign ``unsigned_url``.

    Returns the signed URL, or ``None`` if no endpoint is configured or the
    request fails (caller falls back to the unsigned URL). Network import is
    local so merely importing this module touches nothing.
    """
    ep = signer_url(endpoint)
    if not ep:
        return None
    import json
    import urllib.request

    try:
        body = json.dumps({"url": unsigned_url}).encode()
        req = urllib.request.Request(
            ep, data=body, headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            data = json.loads(resp.read().decode())
        return data.get("url") or data.get("signedUrl") or None
    except Exception:
        return None


# --------------------------------------------------------------------------
# remote config — the live source of truth (publishable key + feature flags)
# --------------------------------------------------------------------------


def remote_config() -> Optional[Dict]:
    """The last-loaded ``/config`` payload, or ``None`` if never loaded."""
    return _REMOTE_CONFIG


def set_remote_config(cfg: Optional[Dict]) -> None:
    """Install (or clear, with ``None``) the cached remote config. Exposed so a
    host that already fetched ``/config`` — or a test — can inject it without a
    network hop. The payload must carry ONLY public fields (publishable +
    commerce public key + feature flags); never a secret."""
    global _REMOTE_CONFIG
    _REMOTE_CONFIG = dict(cfg) if cfg else None


def load_remote_config(fetch=None, *, endpoint: Optional[str] = None,
                       timeout: float = 8.0) -> Optional[Dict]:
    """GET the accounts-service MoonPay ``/config`` and cache it as the source of
    truth for the publishable key + commerce public key + feature flags.

    ``fetch`` (optional) is a ``fetch(url, timeout) -> dict`` override used by
    tests / hosts; by default a stdlib ``urllib`` GET is used. On any failure the
    cache is left unchanged and ``None`` is returned (callers keep the sandbox
    fallback). NEVER carries or expects a secret — ``/config`` is public.
    """
    url = endpoint or CONFIG_ENDPOINT
    try:
        if fetch is not None:
            data = fetch(url, timeout)
        else:
            import json as _json
            import urllib.request

            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                data = _json.loads(resp.read().decode())
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    set_remote_config(data)
    return _REMOTE_CONFIG


def feature_enabled(name: str) -> bool:
    """Is MoonPay feature ``name`` (``buy``/``sell``/``swap``/``commerce``)
    available? When no remote config is loaded this is permissive (``True``) so
    the sandbox fallback still shows the affordance; once ``/config`` is loaded it
    honours ``features.X`` (hide a button when the server says the feature is
    off)."""
    if _REMOTE_CONFIG is None:
        return True
    feats = _REMOTE_CONFIG.get("features") or {}
    return bool(feats.get(name, False))


def commerce_public_key() -> Optional[str]:
    """The commerce PUBLIC key from ``/config`` (safe to embed), or ``None``."""
    if _REMOTE_CONFIG is None:
        return None
    return _REMOTE_CONFIG.get("commercePublicKey") or None


# --------------------------------------------------------------------------
# authed server proxies — swap (Trade API) + commerce + status poll
# --------------------------------------------------------------------------


def _post_json(url: str, payload: Dict, *, bearer: Optional[str] = None,
               timeout: float = 12.0) -> Dict:
    """POST ``payload`` as JSON to ``url`` (optionally bearer-authed) and return
    ``{ok, status, body}``. Network import is local so merely importing this
    module touches nothing. Never raises for transport errors — returns
    ``{ok:False, status:0, error:…}`` instead."""
    import json as _json
    import urllib.error
    import urllib.request

    data = _json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = "Bearer " + str(bearer)
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            raw = resp.read().decode()
            status = resp.getcode()
    except urllib.error.HTTPError as e:  # non-2xx still carries a JSON body
        try:
            raw = e.read().decode()
        except Exception:
            raw = ""
        status = e.code
    except Exception as e:  # noqa: BLE001 — surface transport failure to caller
        return {"ok": False, "status": 0, "error": str(e), "body": None}
    try:
        body = _json.loads(raw) if raw else None
    except Exception:
        body = raw
    return {"ok": 200 <= (status or 0) < 300, "status": status, "body": body}


def swap(method: str, path: str, *, query: Optional[Dict] = None,
         body: Optional[Dict] = None, bearer: Optional[str] = None,
         endpoint: Optional[str] = None, transport=None,
         timeout: float = 12.0) -> Dict:
    """S3 — thin AUTHED proxy to the MoonPay Trade (swap) API via the
    accounts-service ``/moonpay/swap`` endpoint (the trade key stays
    server-side). POSTs ``{method, path, query, body}``. Requires an accounts
    session (``bearer``). ``transport(url, payload, bearer, timeout) -> dict`` is
    an override for tests. Returns ``{ok, status, body}``."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("path must start with '/'")
    m = "POST" if str(method).upper() == "POST" else "GET"
    payload = {"method": m, "path": path, "query": query or {}, "body": body}
    url = endpoint or SWAP_ENDPOINT
    if transport is not None:
        return transport(url, payload, bearer, timeout)
    return _post_json(url, payload, bearer=bearer, timeout=timeout)


def swap_quote(*, sell_asset: str, buy_asset: str, amount, bearer: Optional[str] = None,
               **kw) -> Dict:
    """Convenience wrapper: a MoonPay swap quote (sell -> buy for ``amount``)."""
    return swap("GET", "/v3/currencies/quote",
                query={"baseCurrencyCode": sell_asset,
                       "quoteCurrencyCode": buy_asset,
                       "baseCurrencyAmount": amount},
                bearer=bearer, **kw)


def swap_execute(*, quote_id: str, bearer: Optional[str] = None,
                 extra: Optional[Dict] = None, **kw) -> Dict:
    """Convenience wrapper: execute a previously-quoted MoonPay trade."""
    b: Dict = {"quoteId": quote_id}
    if extra:
        b.update(extra)
    return swap("POST", "/v3/trades", body=b, bearer=bearer, **kw)


def _normalize_txn(rec: Dict) -> Dict:
    """Normalize a persisted widget-callback record or a Trade-API transaction to
    ``{id, type, status, asset, amountUsd, at}``."""
    if not isinstance(rec, dict):
        return {"id": None, "type": None, "status": None, "asset": None,
                "amountUsd": None, "at": None}
    typ = rec.get("type") or rec.get("flow")
    cur = rec.get("currency")
    asset = rec.get("asset") or rec.get("currencyCode")
    if not asset and isinstance(cur, dict):
        asset = cur.get("code")
    elif not asset and cur:
        asset = cur
    amt = rec.get("amountUsd")
    if amt is None:
        amt = rec.get("baseCurrencyAmount")
    if amt is None:
        amt = rec.get("quoteCurrencyAmount")
    return {
        "id": (rec.get("id") or rec.get("transactionId")
               or rec.get("externalTransactionId")),
        "type": typ,
        "status": rec.get("status"),
        "asset": asset,
        "amountUsd": amt,
        "at": rec.get("at") or rec.get("createdAt") or rec.get("ts"),
    }


def status(*, bearer: Optional[str] = None, local: Optional[List[Dict]] = None,
           limit: int = 20, poll: bool = True, transport=None,
           endpoint: Optional[str] = None, timeout: float = 12.0) -> List[Dict]:
    """S4 — recent MoonPay transactions + live state, newest first. Merges the
    locally-persisted widget-callback records (``local``) with a Trade-API poll
    of ``/v3/transactions`` (only when ``poll`` and signed in). Qt has no redirect
    capture, so it relies on the poll + any records it persisted on return.
    Returns ``[{id, type, status, asset, amountUsd, at}]`` de-duped by id."""
    out: List[Dict] = [_normalize_txn(r) for r in (local or [])]
    if poll and bearer:
        try:
            r = swap("GET", "/v3/transactions", query={"limit": limit},
                     bearer=bearer, endpoint=endpoint, transport=transport,
                     timeout=timeout)
            body = r.get("body") if isinstance(r, dict) else None
            if isinstance(body, list):
                out.extend(_normalize_txn(rec) for rec in body)
        except Exception:
            pass
    seen = set()
    uniq: List[Dict] = []
    for rec in sorted(out, key=lambda x: x.get("at") or 0, reverse=True):
        rid = rec.get("id")
        if rid and rid in seen:
            continue
        if rid:
            seen.add(rid)
        uniq.append(rec)
    return uniq[:limit]


def commerce_checkout(*, product: str, ref_id: Optional[str] = None,
                      amount_usd=None, ccy: str = "usd", action: str = "create",
                      checkout_id: Optional[str] = None,
                      bearer: Optional[str] = None, endpoint: Optional[str] = None,
                      transport=None, timeout: float = 12.0) -> Dict:
    """M1–M4 — create (or poll) a MoonPay Commerce crypto checkout via the AUTHED
    ``/moonpay/commerce`` proxy. The commerce secret stays server-side and the
    GRANT is applied ONLY by the server webhook (never the client; the client
    merely polls ``action='status'`` for UI). ``action='create'`` returns
    ``{checkoutId, hostedUrl}``; ``action='status'`` returns ``{status}``."""
    payload: Dict = {"action": action, "product": product}
    if ref_id is not None:
        payload["refId"] = ref_id
    if amount_usd is not None:
        payload["amountUsd"] = amount_usd
    if ccy:
        payload["ccy"] = ccy
    if checkout_id is not None:
        payload["checkoutId"] = checkout_id
    url = endpoint or COMMERCE_ENDPOINT
    if transport is not None:
        return transport(url, payload, bearer, timeout)
    return _post_json(url, payload, bearer=bearer, timeout=timeout)


# --------------------------------------------------------------------------
# creative helpers — thin wrappers so every UI hook is one call (C1–C6)
# --------------------------------------------------------------------------


def _ceil_usd(amount) -> Optional[str]:
    """Round a USD amount UP to the nearest whole dollar as a string, or ``None``
    for unparseable/non-positive input."""
    try:
        v = int(math.ceil(float(amount)))
    except (TypeError, ValueError):
        return None
    return str(v) if v > 0 else None


def top_up_shortfall(*, chain: str, symbol: Optional[str] = None,
                     wallet_address: str, shortfall_usd,
                     native_symbol: Optional[str] = None,
                     base_currency_code: str = "usd",
                     redirect_url: Optional[str] = None,
                     api_key: Optional[str] = None,  # noqa: A002
                     overrides: Optional[Dict] = None) -> Dict:
    """C1/C3/C6 — a BUY of exactly the shortfall (rounded UP to the nearest
    dollar) of ``symbol`` on ``chain``, delivered to ``wallet_address``. Returns
    ``{ok, url, code, amountUsd}`` (``url`` UNSIGNED — the caller signs it via
    :func:`fetch_signed_url` in live mode) or ``{ok:False, reason, code}``."""
    code = currency_code(chain, symbol, native_symbol=native_symbol,
                         overrides=overrides)
    if not code:
        return {"ok": False, "reason": "asset not available on MoonPay", "code": None}
    amount = _ceil_usd(shortfall_usd)
    if amount is None:
        return {"ok": False, "reason": "shortfall must be positive", "code": code}
    url = build_widget_url(wallet_address=wallet_address, currency_code=code,
                           api_key=api_key, base_currency_code=base_currency_code,
                           base_currency_amount=amount, redirect_url=redirect_url)
    return {"ok": True, "url": url, "code": code, "amountUsd": amount}


def recurring_buy_preset(*, chain: str, symbol: Optional[str] = None,
                         wallet_address: str, weekly_usd,
                         native_symbol: Optional[str] = None,
                         base_currency_code: str = "usd",
                         api_key: Optional[str] = None,  # noqa: A002
                         overrides: Optional[Dict] = None) -> Dict:
    """C2 — a weekly recurring BUY widget URL PLUS a matching DCA bot spec to
    hand to the bot engine. Returns ``{ok, url, code, botSpec}`` or
    ``{ok:False, reason, code}``. The caller co-creates the DCA bot so the fiat
    auto-buy and the on-chain DCA strategy stay in lockstep."""
    code = currency_code(chain, symbol, native_symbol=native_symbol,
                         overrides=overrides)
    if not code:
        return {"ok": False, "reason": "asset not available on MoonPay", "code": None}
    amount = _ceil_usd(weekly_usd)
    if amount is None:
        return {"ok": False, "reason": "weekly amount must be positive", "code": code}
    url = build_widget_url(
        wallet_address=wallet_address, currency_code=code, api_key=api_key,
        base_currency_code=base_currency_code, base_currency_amount=amount,
        extra={"recurringIntervalDays": "7", "paymentMethod": "credit_debit_card"})
    bot_spec = {"type": "dca", "allocationUsd": float(amount), "cadence": "weekly",
                "chain": chain, "symbol": symbol}
    return {"ok": True, "url": url, "code": code, "botSpec": bot_spec}


def cash_out_gains(*, chain: str, symbol: Optional[str] = None,
                   wallet_address: Optional[str] = None, gain_amount,
                   native_symbol: Optional[str] = None,
                   quote_currency_code: str = "usd",
                   redirect_url: Optional[str] = None,
                   api_key: Optional[str] = None,  # noqa: A002
                   overrides: Optional[Dict] = None) -> Dict:
    """C4 — a SELL (off-ramp) of ``gain_amount`` of ``symbol`` to fiat, pre-filled
    with the realized gain. Returns ``{ok, url, code, amountUsd}`` (``url``
    UNSIGNED) or ``{ok:False, reason, code}``."""
    code = currency_code(chain, symbol, native_symbol=native_symbol,
                         overrides=overrides)
    if not code:
        return {"ok": False, "reason": "asset not available on MoonPay", "code": None}
    amount = sell_amount(str(gain_amount)) if gain_amount is not None else None
    if amount is None:
        return {"ok": False, "reason": "no realized gains to cash out", "code": code}
    url = build_sell_widget_url(
        base_currency_code=code, wallet_address=wallet_address, api_key=api_key,
        quote_currency_code=quote_currency_code, base_currency_amount=amount,
        redirect_url=redirect_url)
    return {"ok": True, "url": url, "code": code, "amountUsd": amount}


def get_block_with_card(*, wallet_address: str, usd_amount, chain: str = "ethereum",
                        stable: str = "USDC", native_symbol: Optional[str] = None,
                        api_key: Optional[str] = None,  # noqa: A002
                        base_currency_code: str = "usd",
                        dex_url: Optional[str] = None,
                        overrides: Optional[Dict] = None) -> Dict:
    """C5 — BLOCK is not on MoonPay, so this is a 2-step guided plan: step1 BUY a
    liquid stablecoin (``stable`` = USDC) for ``usd_amount`` via MoonPay to the
    user's address; step2 SWAP that stablecoin -> BLOCK on the native ``/dex``.
    Returns ``{ok, step1:{url,code,amountUsd}, step2:{action,from,to,dexUrl}}`` or
    ``{ok:False, reason}``."""
    code = currency_code(chain, stable, native_symbol=native_symbol,
                         overrides=overrides)
    if not code:
        return {"ok": False,
                "reason": f"{stable} not available on MoonPay for {chain}"}
    amount = _ceil_usd(usd_amount)
    if amount is None:
        return {"ok": False, "reason": "amount must be positive"}
    buy_url = build_widget_url(
        wallet_address=wallet_address, currency_code=code, api_key=api_key,
        base_currency_code=base_currency_code, base_currency_amount=amount)
    step2 = {"action": "dex-swap", "from": stable, "to": "BLOCK",
             "dexUrl": dex_url or ("blockle://dex?from=%s&to=BLOCK" % stable)}
    return {"ok": True,
            "step1": {"url": buy_url, "code": code, "amountUsd": amount},
            "step2": step2}
