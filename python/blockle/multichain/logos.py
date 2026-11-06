"""Correct per-chain / per-token logos (the resolver).

Python port of ``blockle-extension/logos.js``.

* CHAINS: brand-colored icons for every supported chain are BUNDLED here as
  inline SVG — they render OFFLINE with no remote fetch. BTC, ETH/EVM, SOL,
  DOGE, LTC, BLOCK, BNB, Base, Polygon, Arbitrum, Optimism, Avalanche.
* TOKENS: use the token metadata ``logoURI``/``logo`` that discovery /
  auto-import already carries, rendered at runtime, with a graceful colored
  MONOGRAM fallback when it is absent or fails to load. No broken / placeholder
  icons.

:func:`resolve` is the one entry point the UI uses; :func:`chain_icon` and
:func:`monogram` are exposed for direct use + tests.
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import quote


# ---- bundled, brand-colored chain icons (inline SVG, offline) ------------
# Each is a 32x32 brand-colored disc with the chain's glyph — recognizable,
# tiny, and self-contained (no network, CSP-safe).
def _disc(bg: str, fg: str, glyph: str, extra: str = "") -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
        '<circle cx="16" cy="16" r="16" fill="' + bg + '"/>'
        + extra
        + '<text x="16" y="22" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="700"'
        ' text-anchor="middle" fill="' + fg + '">' + glyph + '</text></svg>'
    )


def _sol_disc() -> str:
    # Solana's three-bar mark on its brand gradient.
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
        '<defs><linearGradient id="solg" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs>'
        '<circle cx="16" cy="16" r="16" fill="#111"/>'
        '<g fill="url(#solg)">'
        '<path d="M9 12.2c.2-.2.4-.3.7-.3h13.1c.4 0 .6.5.3.8l-2.1 2.1c-.1.2-.4.3-.6.3H7.3c-.4 0-.6-.5-.3-.8z"/>'
        '<path d="M9 21.3c.2-.2.4-.3.7-.3h13.1c.4 0 .6.5.3.8l-2.1 2.1c-.1.2-.4.3-.6.3H7.3c-.4 0-.6-.5-.3-.8z" transform="translate(0 -4)"/>'
        '<path d="M23.1 16.7c-.2-.2-.4-.3-.7-.3H9.3c-.4 0-.6.5-.3.8l2.1 2.1c.1.2.4.3.6.3h13.1c.4 0 .6-.5.3-.8z"/>'
        '</g></svg>'
    )


# ---- REAL BRAND MARKS (inline SVG path geometry, offline / CSP-safe) ------
# A brand-colored disc + the asset's genuine logo rendered as vector PATH data
# (not a <text> initial). Mirrors the structure the JS reference will carry.
def _brand(bg: str, inner: str, defs: str = "") -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
        + (defs or "")
        + '<circle cx="16" cy="16" r="16" fill="' + bg + '"/>'
        + inner + '</svg>'
    )


# Bitcoin ₿ — the stylised B with two ascender/descender ticks.
_BTC_MARK = (
    '<g fill="#fff">'
    '<path d="M11 9h6.1c2.5 0 4.2 1.3 4.2 3.4 0 1.5-.8 2.5-2 3 1.5.4 2.5 1.5 2.5 3.2 0 2.4-1.9 3.9-4.9 3.9H11V9z'
    'm3 2.2v3h2.5c1.3 0 2-.6 2-1.5 0-1-.7-1.5-2-1.5H14zm0 4.9v3.3h2.9c1.3 0 2-.6 2-1.6 0-1.1-.8-1.7-2.1-1.7H14z"/>'
    '<rect x="13" y="6.6" width="1.6" height="3"/><rect x="16.3" y="6.6" width="1.6" height="3"/>'
    '<rect x="13" y="22.4" width="1.6" height="3"/><rect x="16.3" y="22.4" width="1.6" height="3"/>'
    '</g>'
)
# Ethereum — the canonical twin-diamond mark.
_ETH_MARK = (
    '<g fill="#fff">'
    '<path d="M16 5 16 13.1 22.8 16.2Z" opacity=".55"/>'
    '<path d="M16 5 9.2 16.2 16 13.1Z"/>'
    '<path d="M16 27 16 20.4 22.8 17.5Z" opacity=".55"/>'
    '<path d="M16 27 9.2 17.5 16 20.4Z"/>'
    '<path d="M16 19.1 22.8 16.2 16 13.1Z" opacity=".35"/>'
    '<path d="M9.2 16.2 16 19.1 16 13.1Z" opacity=".8"/>'
    '</g>'
)
# Dogecoin Ð — a D with the currency cross-bar.
_DOGE_MARK = (
    '<g fill="#fff">'
    '<path d="M11 8h4.8c3.9 0 6.6 3 6.6 8s-2.7 8-6.6 8H11V8zm3 2.6v10.8h1.6c2.4 0 3.8-2 3.8-5.4s-1.4-5.4-3.8-5.4H14z"/>'
    '<rect x="9" y="14.7" width="8.6" height="2.3"/></g>'
)
# Litecoin Ł — the slashed L.
_LTC_MARK = (
    '<g fill="#fff"><path d="M15 7h3.4l-2.1 8.2 2.4-.8-.5 2.1-2.4.8-1 3.8h7l-.6 2.4H10.6l1.5-5.8-2 .7.5-2.1 2-.7L15 7z"/></g>'
)
# TRON — the three-node triangular mark.
_TRON_MARK = (
    '<g fill="#fff"><path d="M8 9l16 2.6-8.4 13.4L8 9zm2.9 2.4l4.3 8.4.3-5.6-4.6-2.8zm6 3.1l-.3 5.6 4.3-6.9-4 1.3zm-5.3-3.2l8.6 1.3-3 1.2-5.6-2.5z"/></g>'
)
# TON — the gem/diamond mark with inner facets.
_TON_MARK = (
    '<g><path d="M8.5 12 23.5 12 16 24.5Z" fill="#fff"/>'
    '<path d="M16 12 16 24.5M8.5 12 16 19 23.5 12" stroke="#0098ea" stroke-width="1.5" fill="none" stroke-linejoin="round"/></g>'
)
# XRP — the two crossing arcs.
_XRP_MARK = (
    '<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">'
    '<path d="M9 9c3.2 4.2 5.4 4.2 7 4.2s3.8 0 7-4.2"/>'
    '<path d="M9 23c3.2-4.2 5.4-4.2 7-4.2s3.8 0 7 4.2"/></g>'
)
# Stellar — the crossed rocket arcs + core.
_XLM_MARK = (
    '<g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round">'
    '<path d="M8 11c6-2.2 10 2.2 16 0"/><path d="M8 21c6 2.2 10-2.2 16 0"/></g>'
    '<circle cx="16" cy="16" r="1.7" fill="#fff"/>'
)
# Tezos — the hexagonal T mark.
_XTZ_MARK = (
    '<g fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round">'
    '<path d="M16 7 23 11 23 21 16 25 9 21 9 11Z"/><path d="M13 13.3h6M16 13.3v8.2"/></g>'
)
# Cardano — the ADA constellation.
_ADA_MARK = (
    '<g fill="#fff"><circle cx="16" cy="16" r="2.4"/>'
    '<circle cx="16" cy="8" r="1.4"/><circle cx="16" cy="24" r="1.4"/>'
    '<circle cx="9" cy="12" r="1.4"/><circle cx="23" cy="12" r="1.4"/>'
    '<circle cx="9" cy="20" r="1.4"/><circle cx="23" cy="20" r="1.4"/>'
    '<circle cx="16" cy="11.6" r="1"/><circle cx="16" cy="20.4" r="1"/>'
    '<circle cx="12.6" cy="16" r="1"/><circle cx="19.4" cy="16" r="1"/></g>'
)
# Blockle — the isometric cube brand mark (matches usdb-token.svg's cube).
_BLOCK_MARK = (
    '<g stroke="#2b5bbf" stroke-width="1" stroke-linejoin="round">'
    '<polygon points="16,7 24,11.5 16,16 8,11.5" fill="#ffffff"/>'
    '<polygon points="8,11.5 16,16 16,25 8,20.5" fill="#dfeaff"/>'
    '<polygon points="24,11.5 24,20.5 16,25 16,16" fill="#bcd3ff"/></g>'
)
# BNB — the diamond-of-diamonds mark.
_BNB_MARK = (
    '<g fill="#1e2026">'
    '<rect x="13.5" y="13.5" width="5" height="5" transform="rotate(45 16 16)"/>'
    '<rect x="13.9" y="6.4" width="4.2" height="4.2" transform="rotate(45 16 8.5)"/>'
    '<rect x="13.9" y="21.4" width="4.2" height="4.2" transform="rotate(45 16 23.5)"/>'
    '<rect x="6.4" y="13.9" width="4.2" height="4.2" transform="rotate(45 8.5 16)"/>'
    '<rect x="21.4" y="13.9" width="4.2" height="4.2" transform="rotate(45 23.5 16)"/></g>'
)
# Base — the circle with the right-edge slot.
_BASE_MARK = (
    '<g><circle cx="16" cy="16" r="8.5" fill="#fff"/>'
    '<rect x="16" y="14.6" width="9.5" height="2.8" fill="#0052ff"/></g>'
)
# Polygon — the twin-hexagon mark.
_POLYGON_MARK = (
    '<g fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round">'
    '<path d="M20 11.2 24 13.6 24 18.4 20 20.8 16 18.4 16 13.6Z"/>'
    '<path d="M12 10.8 16 13.2 16 18 12 20.4 8 18 8 13.2Z"/></g>'
)
# Arbitrum — the stylised A.
_ARB_MARK = '<g fill="#fff"><path d="M16 8 22.4 23h-3.3L16 14.6 12.9 23H9.6Z"/></g>'
# Optimism — the ring O.
_OP_MARK = '<circle cx="16" cy="16" r="7.5" fill="none" stroke="#fff" stroke-width="3"/>'
# Avalanche — the triangular A mark.
_AVAX_MARK = (
    '<g fill="#fff"><path d="M16 8 19.4 14 12.6 14Z"/>'
    '<path d="M20.2 16 24 23 16.4 23Z"/><path d="M11.8 16 15.6 23 8 23Z"/></g>'
)
# Hyperliquid — the mint HYPE mark (named in the task; not yet a Qt native).
_HYPE_MARK = (
    '<g fill="none" stroke="#97fce4" stroke-width="2.4" stroke-linecap="round">'
    '<path d="M9 20c2-8 4-8 7 0s5 8 7 0"/></g>'
)

CHAIN_ICONS = {
    "btc":       _brand("#f7931a", _BTC_MARK),
    "eth":       _brand("#627eea", _ETH_MARK),
    "sol":       _sol_disc(),
    "doge":      _brand("#c2a633", _DOGE_MARK),
    "ltc":       _brand("#345d9d", _LTC_MARK),
    "bch":       _brand("#0ac18e", _BTC_MARK),       # Bitcoin Cash — green ₿
    "tron":      _brand("#ec0623", _TRON_MARK),
    "ton":       _brand("#0098ea", _TON_MARK),
    "xrp":       _brand("#23292f", _XRP_MARK),
    "stellar":   _brand("#000000", _XLM_MARK),
    "tezos":     _brand("#2c7df7", _XTZ_MARK),
    "cardano":   _brand("#0033ad", _ADA_MARK),
    "block":     _brand("#4c8dff", _BLOCK_MARK),     # Blockle brand accent + cube
    "bnb":       _brand("#f3ba2f", _BNB_MARK),
    "base":      _brand("#0052ff", _BASE_MARK),
    "polygon":   _brand("#8247e5", _POLYGON_MARK),
    "arbitrum":  _brand("#28a0f0", _ARB_MARK),
    "optimism":  _brand("#ff0420", _OP_MARK),
    "avalanche": _brand("#e84142", _AVAX_MARK),
    "hype":      _brand("#072723", _HYPE_MARK),
}

# chain id (adapter id or symbol) -> canonical icon key.
CHAIN_ALIAS = {
    "bitcoin": "btc", "btc": "btc",
    "ethereum": "eth", "eth": "eth", "evm": "eth",
    "solana": "sol", "sol": "sol",
    "tron": "tron", "trx": "tron",
    "ton": "ton", "toncoin": "ton",
    "dogecoin": "doge", "doge": "doge",
    "litecoin": "ltc", "ltc": "ltc",
    "bitcoincash": "bch", "bch": "bch",
    "xrp": "xrp", "xrpl": "xrp", "ripple": "xrp",
    "stellar": "stellar", "xlm": "stellar",
    "hyperliquid": "hype", "hype": "hype", "hyperevm": "hype",
    "block": "block", "blockle": "block",
    "bnb": "bnb", "bsc": "bnb", "binance": "bnb",
    "base": "base",
    "polygon": "polygon", "pol": "polygon", "matic": "polygon",
    "arbitrum": "arbitrum", "arb": "arbitrum",
    "optimism": "optimism", "op": "optimism",
    "avalanche": "avalanche", "avax": "avalanche",
    "tezos": "tezos", "xtz": "tezos",
    "cardano": "cardano", "ada": "cardano",
}


def canon_chain(id):
    if not id:
        return None
    k = str(id).lower()
    if k in CHAIN_ALIAS:
        return CHAIN_ALIAS[k]
    return k if k in CHAIN_ICONS else None


# ---- REAL BRAND MARKS for default / known TOKENS -------------------------
# Keyed by UPPERCASE symbol (the same Tether / Circle mark across every chain)
# plus optional ``chain:ADDRESS`` / ``chain:SYMBOL`` overrides. Resolved BEFORE
# the runtime ``logoURI`` so these render crisply OFFLINE (desktop stays local),
# with the colored monogram kept ONLY for genuinely-unknown imported tokens.
# Tether USD₮ — green disc, white ₮ (top bar + stem + peg band).
_USDT_MARK = _brand(
    "#26a17b",
    '<g fill="#fff"><rect x="8" y="8.5" width="16" height="3.2" rx="0.4"/>'
    '<rect x="14.3" y="8.5" width="3.4" height="15"/>'
    '<ellipse cx="16" cy="14.4" rx="6.2" ry="2.3" fill="none" stroke="#fff" stroke-width="2"/></g>',
)
# USD Coin — Circle blue disc, white ringed $.
_USDC_MARK = _brand(
    "#2775ca",
    '<circle cx="16" cy="16" r="8.4" fill="none" stroke="#fff" stroke-width="2.2"/>'
    '<g fill="#fff"><rect x="15.1" y="9.5" width="1.8" height="13" rx="0.9"/>'
    '<path d="M18.4 12.6c-.7-.9-1.8-1.3-3-1.3-1.9 0-3.1 1-3.1 2.5 0 1.3.9 2 2.8 2.4 1.5.3 1.9.6 1.9 1.2 0 .6-.6 1-1.7 1-1 0-1.8-.4-2.3-1.1l-1.4 1c.7 1 1.9 1.6 3.4 1.6 2.1 0 3.4-1 3.4-2.6 0-1.4-.9-2.1-2.9-2.5-1.4-.3-1.8-.5-1.8-1.1 0-.5.5-.9 1.5-.9.9 0 1.6.3 2 1z"/></g>',
)
# Dai — gold disc, white ring + horizontal bar (the ◈ wordmark sigil).
_DAI_MARK = _brand(
    "#f4b731",
    '<circle cx="16" cy="16" r="7.6" fill="none" stroke="#fff" stroke-width="2.2"/>'
    '<rect x="7" y="14.8" width="18" height="2.4" fill="#fff"/>',
)
# Tether Gold — gold disc, white "Au".
_XAUT_MARK = _brand(
    "#c9a227",
    '<text x="16" y="21" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="700"'
    ' text-anchor="middle" fill="#fff">Au</text>',
)
# Chainlink — blue disc, white hexagon.
_LINK_MARK = _brand(
    "#2a5ada",
    '<path d="M16 8 22.9 12 22.9 20 16 24 9.1 20 9.1 12Z" fill="none" stroke="#fff"'
    ' stroke-width="2.4" stroke-linejoin="round"/>',
)
# POL (ERC-20) — reuse the Polygon brand on a purple disc.
_POL_TOKEN_MARK = _brand("#8247e5", _POLYGON_MARK)

# USDB (Blockle USD, BLOCK-20S) — the real brand mark (from usdb-token.svg).
_USDB_MARK = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">'
    '<defs>'
    '<linearGradient id="ub-top" x1="0" y1="0" x2="0.4" y2="1">'
    '<stop offset="0" stop-color="#5affb9"/><stop offset="1" stop-color="#34e39e"/></linearGradient>'
    '<linearGradient id="ub-left" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#23c78f"/><stop offset="1" stop-color="#139b6d"/></linearGradient>'
    '<linearGradient id="ub-right" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#139b6d"/><stop offset="1" stop-color="#0a6f4e"/></linearGradient>'
    '<linearGradient id="ub-dollar" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#eafff7"/><stop offset="1" stop-color="#bff3df"/></linearGradient>'
    '</defs>'
    '<rect x="2" y="2" width="124" height="124" rx="26" fill="#0B0B14"/>'
    '<g stroke="#0B0B14" stroke-width="2.4" stroke-linejoin="round">'
    '<polygon points="64,20 104,42 64,64 24,42" fill="url(#ub-top)"/>'
    '<polygon points="24,42 64,64 64,108 24,86" fill="url(#ub-left)"/>'
    '<polygon points="104,42 104,86 64,108 64,64" fill="url(#ub-right)"/></g>'
    '<text x="64" y="86" text-anchor="middle" font-family="Arial,Helvetica,sans-serif"'
    ' font-size="58" font-weight="800" fill="url(#ub-dollar)" stroke="#0a6f4e"'
    ' stroke-width="1.2" paint-order="stroke">$</text></svg>'
)
# WORLD (BLOCK-20) — the real brand mark (from world-token.svg).
_WORLD_MARK = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">'
    '<defs>'
    '<linearGradient id="wt-coin" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#ffdd7a"/><stop offset="0.5" stop-color="#f3b63a"/>'
    '<stop offset="1" stop-color="#c8871a"/></linearGradient>'
    '<linearGradient id="wt-globe" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#3fa7ff"/><stop offset="1" stop-color="#1f6fd0"/></linearGradient>'
    '</defs>'
    '<circle cx="64" cy="64" r="60" fill="url(#wt-coin)" stroke="#8a5a12" stroke-width="3"/>'
    '<circle cx="64" cy="64" r="52" fill="none" stroke="#fff3cf" stroke-width="2" opacity="0.7"/>'
    '<circle cx="64" cy="64" r="40" fill="url(#wt-globe)"/>'
    '<g fill="none" stroke="#dff1ff" stroke-width="1.6" opacity="0.5">'
    '<ellipse cx="64" cy="64" rx="40" ry="16"/><ellipse cx="64" cy="64" rx="16" ry="40"/>'
    '<line x1="24" y1="64" x2="104" y2="64"/></g>'
    '<path d="M40 46 L48 86 L58 60 L64 78 L70 60 L80 86 L88 46" fill="none" stroke="#fff8e6"'
    ' stroke-width="6.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/></svg>'
)

#: symbol (or ``chain:symbol`` / ``chain:address``) -> real brand SVG.
TOKEN_ICONS = {
    "USDT": _USDT_MARK,
    "USDC": _USDC_MARK,
    "USDC.E": _USDC_MARK,
    "USDBC": _USDC_MARK,
    "DAI": _DAI_MARK,
    "XAUT": _XAUT_MARK,
    "LINK": _LINK_MARK,
    "POL": _POL_TOKEN_MARK,
    "MATIC": _POL_TOKEN_MARK,
    # BLOCK-20 tokens keep their Blockle marks.
    "USDB": _USDB_MARK,
    "WORLD": _WORLD_MARK,
    "WBLOCK": CHAIN_ICONS["block"],   # Solana wrap of BLOCK — Blockle cube
    "BLOCK": CHAIN_ICONS["block"],
}


def _token_icon_svg(asset) -> Optional[str]:
    """Real brand SVG for a default/known TOKEN, else ``None`` (so the resolver
    falls through to a runtime ``logoURI`` and finally the monogram)."""
    if asset is None:
        return None
    chain = str(_field(asset, "chain") or "").lower()
    sym = str(_field(asset, "symbol") or "").upper()
    addr = (_field(asset, "address") or _field(asset, "contract")
            or _field(asset, "mint") or "")
    addr = str(addr).lower()
    for key in ((chain + ":" + addr) if (chain and addr) else None,
                (chain + ":" + sym) if (chain and sym) else None,
                sym or None):
        if key and key in TOKEN_ICONS:
            return TOKEN_ICONS[key]
    return None


def is_block_denominated(asset) -> bool:
    """The ONE guard: an asset whose only USD would have to be DERIVED FROM A
    BLOCK PRICE (impossible without an oracle). True for native BLOCK, every
    BLOCK-20 / BLOCK-20S token (all carry ``chain == 'block'``), and the Solana
    WBLOCK wrap (priced only off BLOCK). Such assets are shown in BLOCK units and
    NEVER get a USD figure. Real-oracle chains (ETH/SOL/BTC/EVM/…) are False."""
    if not asset:
        return False
    chain = _field(asset, "chain")
    if chain and str(chain).lower() == "block":
        return True
    sym = _field(asset, "symbol")
    return bool(sym and str(sym).upper() in ("BLOCK", "WBLOCK"))


# ---- colored monogram fallback (deterministic from the text) -------------
MONO_COLORS = [
    "#6366f1", "#22d3ee", "#c084fc", "#34d399", "#f59e0b",
    "#fb7185", "#38bdf8", "#a3e635", "#f472b6", "#2dd4bf",
]


def _hash_str(s: str) -> int:
    h = 5381
    for ch in s:
        h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
    return h


def mono_color(text) -> str:
    return MONO_COLORS[_hash_str(str(text or "?").upper()) % len(MONO_COLORS)]


def mono_text(text) -> str:
    t = "".join(c for c in str(text or "?") if c.isalnum()).upper()
    return (t[:2] or "?")


def _esc_xml(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def monogram(text) -> str:
    bg = mono_color(text)
    label = _esc_xml(mono_text(text))
    size = 13 if len(mono_text(text)) > 1 else 16
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
        '<circle cx="16" cy="16" r="16" fill="' + bg + '"/>'
        '<text x="16" y="21" font-family="Arial,Helvetica,sans-serif" font-size="' + str(size) + '" font-weight="700"'
        ' text-anchor="middle" fill="#ffffff">' + label + '</text></svg>'
    )


def chain_icon(id) -> str:
    """A chain icon by id — ALWAYS returns markup: the bundled brand icon, else
    a monogram of the id so there is never a broken/placeholder icon."""
    k = canon_chain(id)
    return CHAIN_ICONS[k] if k else monogram(id)


def svg_data_uri(svg: str) -> str:
    return "data:image/svg+xml," + quote(svg, safe="")


def _field(asset, name):
    """Read ``name`` from a dict asset or an ``AssetRef``-like object."""
    if asset is None:
        return None
    if isinstance(asset, dict):
        return asset.get(name)
    return getattr(asset, name, None)


def is_native(asset) -> bool:
    """Is this asset the chain's native coin (vs. a token)?"""
    if not asset:
        return False
    kind = _field(asset, "kind")
    if kind and kind != "native":
        return False
    return not (_field(asset, "address") or _field(asset, "mint") or _field(asset, "contract"))


def resolve(asset) -> dict:
    """THE RESOLVER. Given an asset (``{chain, symbol, kind,
    address|mint|contract, logo|logoURI}``) return how to render its icon:

      * native coin        -> ``{kind:'chain', id, svg, dataUri}``
      * token w/ logo URI   -> ``{kind:'image', src, fallback:{svg, dataUri,...}}``
      * token w/o logo URI  -> ``{kind:'monogram', text, color, svg, dataUri}``

    The ``fallback`` on an image is what the UI swaps in on a load error, so a
    broken remote logo degrades to a clean monogram — never a broken image."""
    asset = asset or {}
    if is_native(asset):
        svg = chain_icon(_field(asset, "chain") or _field(asset, "symbol"))
        return {"kind": "chain", "id": canon_chain(_field(asset, "chain") or _field(asset, "symbol")),
                "svg": svg, "dataUri": svg_data_uri(svg)}
    # A default / known token with a REAL brand mark (USDT/USDC/LINK/USDB/…),
    # resolved offline BEFORE any runtime logoURI so desktop stays self-contained.
    tsvg = _token_icon_svg(asset)
    if tsvg:
        return {"kind": "token", "svg": tsvg, "dataUri": svg_data_uri(tsvg)}
    uri = _field(asset, "logoURI") or _field(asset, "logo") or None
    text = _field(asset, "symbol") or _field(asset, "name") or _field(asset, "chain") or "?"
    fb_svg = monogram(text)
    fallback = {"svg": fb_svg, "dataUri": svg_data_uri(fb_svg),
                "text": mono_text(text), "color": mono_color(text)}
    if uri and isinstance(uri, str) and uri.strip():
        return {"kind": "image", "src": uri.strip(), "fallback": fallback}
    return {"kind": "monogram", "text": fallback["text"], "color": fallback["color"],
            "svg": fb_svg, "dataUri": fallback["dataUri"]}
