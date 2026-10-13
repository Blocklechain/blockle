"""CORRECT PER-CHAIN / PER-TOKEN LOGOS.

Asserts the Python port (``blockle.multichain.logos``) mirrors the reference
resolver: bundled brand icons for every supported chain (offline, no remote
fetch), the token ``logoURI`` path, and the colored-monogram fallback when a
logo is absent or fails to load. There is never a broken / placeholder icon.
"""

import re

from blockle.multichain import logos as L

SUPPORTED = ["btc", "eth", "sol", "doge", "ltc", "block", "bnb", "base",
             "polygon", "arbitrum", "optimism", "avalanche"]

_REMOTE = re.compile(r"""(?:src|href|xlink:href)\s*=\s*["']?\s*https?:|url\(\s*['"]?\s*https?:""", re.I)


def _fetches_remote(svg: str) -> bool:
    # The SVG xmlns namespace URI is an identifier, not a network request.
    return bool(_REMOTE.search(svg))


# ===========================================================================
# 1. BUNDLED CHAIN ICONS — inline SVG, offline (no remote fetch)
# ===========================================================================
def test_every_supported_chain_has_bundled_inline_svg_icon():
    for cid in SUPPORTED:
        svg = L.CHAIN_ICONS[cid]
        assert svg, f"{cid} icon exists"
        assert svg.startswith("<svg"), f"{cid} is inline SVG"
        assert not _fetches_remote(svg), f"{cid} fetches nothing remote"


def test_chain_icon_resolves_adapter_ids_and_symbol_aliases():
    assert L.chain_icon("bitcoin") == L.CHAIN_ICONS["btc"]
    assert L.chain_icon("BTC") == L.CHAIN_ICONS["btc"]
    assert L.chain_icon("ethereum") == L.CHAIN_ICONS["eth"]
    assert L.chain_icon("evm") == L.CHAIN_ICONS["eth"]
    assert L.chain_icon("solana") == L.CHAIN_ICONS["sol"]
    assert L.chain_icon("dogecoin") == L.CHAIN_ICONS["doge"]
    assert L.chain_icon("litecoin") == L.CHAIN_ICONS["ltc"]
    assert L.chain_icon("block") == L.CHAIN_ICONS["block"]
    assert L.chain_icon("bsc") == L.CHAIN_ICONS["bnb"]
    assert L.chain_icon("matic") == L.CHAIN_ICONS["polygon"]


def test_chain_brand_colors_are_recognizable():
    assert "#f7931a" in L.CHAIN_ICONS["btc"], "BTC orange"
    assert "#627eea" in L.CHAIN_ICONS["eth"], "ETH periwinkle"
    assert "#c2a633" in L.CHAIN_ICONS["doge"], "DOGE gold"
    assert "#345d9d" in L.CHAIN_ICONS["ltc"], "LTC blue"
    assert "#4c8dff" in L.CHAIN_ICONS["block"], "BLOCK brand accent"
    assert "#f3ba2f" in L.CHAIN_ICONS["bnb"], "BNB yellow"
    assert "#0052ff" in L.CHAIN_ICONS["base"], "Base blue"


def test_unknown_chain_falls_back_to_monogram_not_broken_icon():
    svg = L.chain_icon("totally-unknown-chain")
    assert svg.startswith("<svg")
    assert not _fetches_remote(svg)


# ===========================================================================
# 2. RESOLVER — native coin, token logoURI, monogram fallback
# ===========================================================================
def test_resolve_native_coin_returns_bundled_chain_icon():
    res = L.resolve({"chain": "bitcoin", "symbol": "BTC", "kind": "native"})
    assert res["kind"] == "chain"
    assert res["id"] == "btc"
    assert res["svg"] == L.CHAIN_ICONS["btc"]
    assert res["dataUri"].startswith("data:image/svg+xml,")


def test_resolve_token_with_logo_uri_uses_image_with_monogram_fallback():
    res = L.resolve({"chain": "ethereum", "symbol": "USDC", "kind": "erc20",
                     "address": "0xA0b8...", "logoURI": "https://example.com/usdc.png"})
    assert res["kind"] == "image"
    assert res["src"] == "https://example.com/usdc.png"
    fb = res["fallback"]
    assert fb["svg"].startswith("<svg")
    assert fb["text"] == "US"
    assert fb["color"].startswith("#")
    assert not _fetches_remote(fb["svg"]), "fallback monogram is offline"


def test_resolve_token_without_logo_uri_is_colored_monogram():
    res = L.resolve({"chain": "solana", "symbol": "BONK", "kind": "spl", "mint": "Dez..."})
    assert res["kind"] == "monogram"
    assert res["text"] == "BO"
    assert res["color"].startswith("#")
    assert res["svg"].startswith("<svg")
    assert not _fetches_remote(res["svg"])


def test_resolve_accepts_assetref_objects():
    from blockle.multichain.chains.chain_adapter import AssetRef
    native = AssetRef(chain="litecoin", kind="native", symbol="LTC", decimals=8)
    res = L.resolve(native)
    assert res["kind"] == "chain"
    assert res["id"] == "ltc"

    tok = AssetRef(chain="ethereum", kind="erc20", symbol="USDT", decimals=6,
                   address="0xdAC1...", logo="https://example.com/usdt.png")
    res2 = L.resolve(tok)
    assert res2["kind"] == "image"
    assert res2["src"] == "https://example.com/usdt.png"


def test_monogram_is_deterministic_and_safe():
    a = L.monogram("USDC")
    b = L.monogram("USDC")
    assert a == b, "deterministic"
    # XML-escaped; never breaks the SVG
    bad = L.monogram("<script>")
    assert "<script>" not in bad
    assert bad.startswith("<svg")
