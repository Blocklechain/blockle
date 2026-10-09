"""User-defined custom EVM networks (MetaMask-style "Add network").

A custom network is just CONFIG — a plain record describing an EVM RPC:

    {
      "id":              "<slug>",          # stable key (derived from name)
      "name":            "My Rollup",
      "chainId":         7777,              # positive int (the wallet dedupes by this)
      "rpcUrl":          "https://rpc…",    # http(s) URL
      "nativeSymbol":    "ETH",
      "decimals":        18,                # native-coin decimals (default 18)
      "explorerUrl":     "https://scan…",   # optional
      "tokenIndexerUrl": "https://…/v2/KEY" # optional Alchemy-style ERC-20 indexer
    }

There are NO secrets here — only RPC/explorer/indexer URLs. These records are
validated on the way in and fed to the SAME generic EVM adapter the built-in
networks use (see ``registry.py``), so a custom net gets native + ERC-20
balances, sends and (when ``tokenIndexerUrl`` is set) token auto-detect exactly
like Ethereum/Base/etc.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .chain_adapter import default_json_rpc

MAX_DECIMALS = 36


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").strip().lower()).strip("-")
    return s


def _require_url(value: Any, field: str) -> str:
    url = str(value or "").strip()
    if not re.match(r"^https?://[^\s/$.?#]\S*$", url, re.IGNORECASE):
        raise ValueError(f"{field} must be an http(s) URL")
    return url


def _coerce_int(value: Any, field: str) -> int:
    if isinstance(value, bool):  # bool is an int subclass — reject explicitly
        raise ValueError(f"{field} must be an integer")
    if isinstance(value, int):
        return value
    s = str(value).strip()
    if not re.match(r"^[0-9]+$", s):
        raise ValueError(f"{field} must be a positive integer")
    return int(s)


def normalize_custom_network(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize ONE custom-network record. Raises ``ValueError`` with
    a human message on any bad field. The returned dict is canonical: ``id`` is a
    slug, ``chainId``/``decimals`` are ints, optional URLs are omitted when blank.
    """
    if not isinstance(raw, dict):
        raise ValueError("custom network must be an object")

    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")

    chain_id = _coerce_int(raw.get("chainId"), "chainId")
    if chain_id <= 0:
        raise ValueError("chainId must be a positive integer")

    rpc_url = _require_url(raw.get("rpcUrl"), "rpcUrl")

    native_symbol = str(raw.get("nativeSymbol") or "").strip()
    if not native_symbol:
        raise ValueError("nativeSymbol is required")

    decimals_raw = raw.get("decimals")
    if decimals_raw in (None, ""):
        decimals = 18
    else:
        decimals = _coerce_int(decimals_raw, "decimals")
        if decimals < 0 or decimals > MAX_DECIMALS:
            raise ValueError(f"decimals must be between 0 and {MAX_DECIMALS}")

    slug = _slugify(raw.get("id") or name)
    if not slug:
        raise ValueError("could not derive an id slug from name")

    net: Dict[str, Any] = {
        "id": slug,
        "name": name,
        "chainId": chain_id,
        "rpcUrl": rpc_url,
        "nativeSymbol": native_symbol,
        "decimals": decimals,
    }

    explorer = str(raw.get("explorerUrl") or "").strip()
    if explorer:
        net["explorerUrl"] = _require_url(explorer, "explorerUrl")

    indexer = str(raw.get("tokenIndexerUrl") or "").strip()
    if indexer:
        net["tokenIndexerUrl"] = _require_url(indexer, "tokenIndexerUrl")

    return net


def normalize_custom_networks(items: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Normalize a list, dropping records that fail validation (never raises).
    Dedupes so the LAST record wins per ``id`` and per ``chainId`` — editing a
    network in place replaces the earlier copy rather than duplicating it."""
    out: List[Dict[str, Any]] = []
    for raw in (items or []):
        try:
            out.append(normalize_custom_network(raw))
        except ValueError:
            continue
    return dedupe_custom_networks(out)


def dedupe_custom_networks(nets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep the last record for any repeated ``id`` or ``chainId`` while
    preserving first-seen order of the survivors."""
    by_id: Dict[str, Dict[str, Any]] = {}
    for net in nets:
        by_id[net["id"]] = net  # last id wins
    # Now collapse chainId collisions, last wins, keep order of final survivors.
    seen_chain: Dict[int, str] = {}
    for slug, net in by_id.items():
        seen_chain[net["chainId"]] = slug  # last chainId wins
    keep_ids = set(seen_chain.values())
    return [net for slug, net in by_id.items() if slug in keep_ids]


def explorer_tx_prefix(explorer_url: Optional[str]) -> str:
    """Turn an explorer base URL into a tx-link prefix (``…/tx/``) matching the
    built-in networks' ``explorer`` convention. Empty string when none given."""
    url = str(explorer_url or "").strip()
    if not url:
        return ""
    url = url.rstrip("/")
    if url.endswith("/tx"):
        return url + "/"
    if "/tx/" in url:
        return url
    return url + "/tx/"


def probe_chain_id(rpc_url: str, rpc=None, timeout: float = 8) -> int:
    """Call ``eth_chainId`` and return it as an int. Best-effort — the caller
    catches exceptions; this is a non-blocking confirmation, never a gate."""
    fn = rpc or default_json_rpc(rpc_url, timeout=timeout)
    res = fn("eth_chainId", [])
    return int(res, 16) if isinstance(res, str) else int(res)
