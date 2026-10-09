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
import os
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


def api_key(override: Optional[str] = None) -> str:
    """Resolve the publishable key: explicit override > env > built-in default."""
    if override:
        return override
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
    "bitcoin": "btc",
    "litecoin": "ltc",
    "dogecoin": "doge",
    "solana": "sol",
}

#: Token overlays, keyed by (chain, SYMBOL-UPPER) -> MoonPay code.
TOKEN_CURRENCY_CODES: Dict[Tuple[str, str], str] = {
    ("ethereum", "USDC"): "usdc",
    ("ethereum", "USDT"): "usdt",
    ("base", "USDC"): "usdc_base",
    ("arbitrum", "USDC"): "usdc_arbitrum",
    ("arbitrum", "USDT"): "usdt_arbitrum",
    ("optimism", "USDC"): "usdc_optimism",
    ("polygon", "USDC"): "usdc_polygon",
    ("polygon", "USDT"): "usdt_polygon",
    ("solana", "USDC"): "usdc_sol",
    ("solana", "USDT"): "usdt_sol",
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
    return override or os.environ.get(SIGNER_URL_ENV) or None


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
