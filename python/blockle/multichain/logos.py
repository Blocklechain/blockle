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


CHAIN_ICONS = {
    "btc":       _disc("#f7931a", "#ffffff", "₿"),   # ₿
    "eth":       _disc("#627eea", "#ffffff", "Ξ"),   # Ξ
    "sol":       _sol_disc(),
    "doge":      _disc("#c2a633", "#ffffff", "Ð"),   # Ð
    "ltc":       _disc("#345d9d", "#ffffff", "Ł"),   # Ł
    "block":     _disc("#4c8dff", "#ffffff", "B"),        # Blockle brand accent
    "bnb":       _disc("#f3ba2f", "#1e2026", "B"),
    "base":      _disc("#0052ff", "#ffffff", "B"),
    "polygon":   _disc("#8247e5", "#ffffff", "P"),
    "arbitrum":  _disc("#28a0f0", "#ffffff", "A"),
    "optimism":  _disc("#ff0420", "#ffffff", "O"),
    "avalanche": _disc("#e84142", "#ffffff", "A"),
}

# chain id (adapter id or symbol) -> canonical icon key.
CHAIN_ALIAS = {
    "bitcoin": "btc", "btc": "btc",
    "ethereum": "eth", "eth": "eth", "evm": "eth",
    "solana": "sol", "sol": "sol",
    "dogecoin": "doge", "doge": "doge",
    "litecoin": "ltc", "ltc": "ltc",
    "block": "block", "blockle": "block",
    "bnb": "bnb", "bsc": "bnb", "binance": "bnb",
    "base": "base",
    "polygon": "polygon", "pol": "polygon", "matic": "polygon",
    "arbitrum": "arbitrum", "arb": "arbitrum",
    "optimism": "optimism", "op": "optimism",
    "avalanche": "avalanche", "avax": "avalanche",
}


def canon_chain(id):
    if not id:
        return None
    k = str(id).lower()
    if k in CHAIN_ALIAS:
        return CHAIN_ALIAS[k]
    return k if k in CHAIN_ICONS else None


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
    uri = _field(asset, "logoURI") or _field(asset, "logo") or None
    text = _field(asset, "symbol") or _field(asset, "name") or _field(asset, "chain") or "?"
    fb_svg = monogram(text)
    fallback = {"svg": fb_svg, "dataUri": svg_data_uri(fb_svg),
                "text": mono_text(text), "color": mono_color(text)}
    if uri and isinstance(uri, str) and uri.strip():
        return {"kind": "image", "src": uri.strip(), "fallback": fallback}
    return {"kind": "monogram", "text": fallback["text"], "color": fallback["color"],
            "svg": fb_svg, "dataUri": fallback["dataUri"]}
