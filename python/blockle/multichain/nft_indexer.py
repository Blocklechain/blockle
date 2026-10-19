"""multichain/nft_indexer.py — WALLET NFT LIVE INDEXER.

Faithful Python port of ``blockle-extension/nft-indexer.js`` (the injected
``ctx.indexer`` that ``nft.py`` calls as ``getNFTsForOwner(chain, owner)`` ->
raw items).

``nft.py`` is PURE given this indexer: it normalizes the RAW items we return
(never fabricating metadata). THIS module does the real network reads:
  * EVM (ethereum/base/arbitrum/optimism/polygon/bnb/avalanche) via the Alchemy
    NFT API v3 ``getNFTsForOwner`` (operator-configurable key + base url).
  * Solana via a DAS indexer (Helius ``getAssetsByOwner``).

HONEST-OR-NOTHING: a missing key / unconfigured endpoint / HTTP or parse error
returns ``None`` — so ``nft.py`` records the account as ``unavailable`` and NEVER
a fabricated empty inventory. We only ever return a list when a real indexer
actually answered (that list may legitimately be empty).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

from ._util import maybe_await

# CAIP-ish chain -> Alchemy NFT v3 network subdomain.
ALCHEMY_NET = {
    "ethereum": "eth-mainnet", "base": "base-mainnet", "arbitrum": "arb-mainnet",
    "optimism": "opt-mainnet", "polygon": "polygon-mainnet", "bnb": "bnb-mainnet",
    "avalanche": "avax-mainnet",
}
EVM_CHAINS = set(ALCHEMY_NET.keys())
DEFAULT_HELIUS_BASE = "https://mainnet.helius-rpc.com"


def _first_non_empty(*vals):
    for v in vals:
        if v is not None and v != "":
            return v
    return None


# ---- map ONE Alchemy NFT v3 ownedNfts entry -> a raw nft.js item -----------
def map_alchemy_item(chain: str, nft: Dict[str, Any]) -> Dict[str, Any]:
    contract = (nft.get("contract") or {}).get("address") or nft.get("contractAddress")
    token_type = str(
        (nft.get("contract") or {}).get("tokenType")
        or nft.get("tokenType")
        or (((nft.get("id") or {}).get("tokenMetadata") or {}).get("tokenType")
            if isinstance(nft.get("id"), dict) else None)
        or ""
    ).lower()
    standard = "erc1155" if token_type == "erc1155" else ("erc721" if token_type == "erc721" else None)
    raw_meta = (nft.get("raw") or {}).get("metadata") or nft.get("metadata") or {}
    img = nft.get("image") or {}
    image = _first_non_empty(img.get("cachedUrl"), img.get("originalUrl"), img.get("pngUrl"),
                             img.get("thumbnailUrl"), raw_meta.get("image"), raw_meta.get("image_url"))
    animation = _first_non_empty(raw_meta.get("animation_url"),
                                 (nft.get("animation") or {}).get("cachedUrl") if isinstance(nft.get("animation"), dict) else None)
    collection = _first_non_empty((nft.get("collection") or {}).get("name") if isinstance(nft.get("collection"), dict) else None,
                                  (nft.get("contractMetadata") or {}).get("name") if isinstance(nft.get("contractMetadata"), dict) else None,
                                  (nft.get("contract") or {}).get("name") if isinstance(nft.get("contract"), dict) else None)
    name = _first_non_empty(nft.get("name"), nft.get("title"), raw_meta.get("name"))
    token_uri_field = nft.get("tokenUri")
    metadata_uri = _first_non_empty(
        token_uri_field if isinstance(token_uri_field, str) else None,
        (nft.get("raw") or {}).get("tokenUri"),
        token_uri_field.get("raw") if isinstance(token_uri_field, dict) else None,
    )
    metadata_ok = bool(name or image)

    token_id = None
    if nft.get("tokenId") is not None:
        token_id = str(nft.get("tokenId"))
    elif isinstance(nft.get("id"), dict) and nft["id"].get("tokenId") is not None:
        token_id = str(nft["id"]["tokenId"])

    out: Dict[str, Any] = {
        "chain": chain,
        "contract": contract,
        "tokenId": token_id,
        "standard": standard,
        "balance": str(nft.get("balance")) if nft.get("balance") is not None else "1",
        "metadataOk": metadata_ok,
    }
    if name is not None:
        out["name"] = name
    if collection is not None:
        out["collection"] = collection
    if image is not None:
        out["image"] = image
    if animation is not None:
        out["animation"] = animation
    if metadata_uri is not None:
        out["metadataUri"] = metadata_uri
    if isinstance(raw_meta.get("attributes"), list):
        out["attributes"] = raw_meta["attributes"]
    return out


# ---- map ONE DAS (Helius getAssetsByOwner) asset -> a raw nft.js item ------
def map_das_item(asset: Dict[str, Any]) -> Dict[str, Any]:
    content = asset.get("content") or {}
    meta = content.get("metadata") or {}
    links = content.get("links") or {}
    collection = None
    for g in (asset.get("grouping") or []):
        if g and g.get("group_key") == "collection":
            collection = (g.get("collection_metadata") or {}).get("name") or g.get("group_value")
            break
    if collection is None:
        collection = meta.get("symbol")
    files = content.get("files") or []
    first_file = files[0] if files else {}
    image = _first_non_empty(links.get("image"), meta.get("image"),
                             (first_file.get("cdn_uri") or first_file.get("uri")) if isinstance(first_file, dict) else None)
    name = _first_non_empty(meta.get("name"))
    metadata_uri = _first_non_empty(content.get("json_uri"), asset.get("json_uri"))
    metadata_ok = bool(name or image)
    out: Dict[str, Any] = {
        "chain": "solana",
        "contract": asset.get("id"),
        "standard": "metaplex",
        "balance": "1",
        "metadataOk": metadata_ok,
    }
    if name is not None:
        out["name"] = name
    if collection is not None:
        out["collection"] = collection
    if image is not None:
        out["image"] = image
    if metadata_uri is not None:
        out["metadataUri"] = metadata_uri
    if isinstance(meta.get("attributes"), list):
        out["attributes"] = meta["attributes"]
    return out


# ---- default live fetch (stdlib urllib on a thread) — only used when the host
# does not inject its own fetch_impl. The spec-vector tests ALWAYS inject one. --
class _Resp:
    def __init__(self, ok: bool, status: int, body: Any):
        self.ok = ok
        self.status = status
        self._body = body

    async def json(self):
        return self._body


async def _default_fetch(url: str, init: Optional[Dict[str, Any]] = None):  # pragma: no cover - live net
    import urllib.request

    init = init or {}
    method = init.get("method", "GET")
    headers = init.get("headers") or {}
    body = init.get("body")
    data = body.encode("utf-8") if isinstance(body, str) else body

    def _do():
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode("utf-8")
                return _Resp(200 <= r.status < 300, r.status, json.loads(raw) if raw else {})
        except Exception:
            return _Resp(False, 0, {})

    return await asyncio.get_event_loop().run_in_executor(None, _do)


# ---- the factory -----------------------------------------------------------
class Indexer:
    """createIndexer({ alchemy:{apiKey,baseUrl?}, helius/das:{apiKey,baseUrl?|url},
    fetchImpl? }) -> getNFTsForOwner(chain, owner) -> raw[] | None."""

    ALCHEMY_NET = ALCHEMY_NET

    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self._alchemy = opts.get("alchemy") or {}
        self._das = opts.get("das") or opts.get("helius") or {}
        self._fetch: Optional[Callable] = opts.get("fetchImpl") or opts.get("fetch_impl") or _default_fetch
        # Native BLOCK-721 NFTs come from the node's ownership index (no API key).
        self._block_api = (opts.get("blockApi") or opts.get("block_api")
                           or "https://blockle.org/api/explorer").rstrip("/")

    def _alchemy_url(self, chain: str) -> Optional[str]:
        net = ALCHEMY_NET.get(chain)
        if not net:
            return None
        if self._alchemy.get("baseUrl"):
            return self._alchemy["baseUrl"].rstrip("/") + "/getNFTsForOwner"
        if not self._alchemy.get("apiKey"):
            return None
        return ("https://" + net + ".g.alchemy.com/nft/v3/"
                + quote(self._alchemy["apiKey"], safe="") + "/getNFTsForOwner")

    def _das_url(self) -> Optional[str]:
        if self._das.get("url"):
            return self._das["url"]
        if not self._das.get("apiKey"):
            return None
        return ((self._das.get("baseUrl") or DEFAULT_HELIUS_BASE).rstrip("/")
                + "/?api-key=" + quote(self._das["apiKey"], safe=""))

    async def getNFTsForOwner(self, chain: str, owner: str) -> Optional[List[Dict[str, Any]]]:
        if not self._fetch:
            return None  # no transport -> unavailable (never a fake [])
        try:
            if chain in EVM_CHAINS:
                base = self._alchemy_url(chain)
                if not base:
                    return None  # no key/endpoint -> unavailable
                url = (base + "?owner=" + quote(str(owner), safe="")
                       + "&withMetadata=true&pageSize=100")
                res = await maybe_await(self._fetch(url, {"method": "GET",
                                                          "headers": {"accept": "application/json"}}))
                if not res or not getattr(res, "ok", False):
                    return None
                body = await maybe_await(res.json())
                lst = (body.get("ownedNfts") or body.get("nfts") or body.get("ownedNftsV3")
                       or []) if isinstance(body, dict) else []
                if not isinstance(lst, list):
                    return None
                return [map_alchemy_item(chain, n) for n in lst]

            if chain == "solana":
                url = self._das_url()
                if not url:
                    return None  # no key/endpoint -> unavailable
                payload = {
                    "jsonrpc": "2.0", "id": "nfts", "method": "getAssetsByOwner",
                    "params": {"ownerAddress": owner, "page": 1, "limit": 1000,
                               "displayOptions": {"showCollectionMetadata": True}},
                }
                res = await maybe_await(self._fetch(url, {
                    "method": "POST", "headers": {"content-type": "application/json"},
                    "body": json.dumps(payload),
                }))
                if not res or not getattr(res, "ok", False):
                    return None
                body = await maybe_await(res.json())
                if isinstance(body, dict) and body.get("error"):
                    return None
                items = (body.get("result") or {}).get("items") if isinstance(body, dict) else None
                if not isinstance(items, list):
                    return None
                out = []
                for a in items:
                    iface = str(a.get("interface") or "")
                    if iface in ("FungibleToken", "FungibleAsset"):
                        continue
                    out.append(map_das_item(a))
                return out

            if chain == "block":
                # Native Blockle L1: the node indexes BLOCK-721 ownership from
                # Transfer events. Returns {address, count, nfts:[{contract, tokenId}]}.
                url = self._block_api + "/nfts/" + quote(str(owner), safe="")
                res = await maybe_await(self._fetch(url, {"method": "GET",
                                                          "headers": {"accept": "application/json"}}))
                if not res or not getattr(res, "ok", False):
                    return None
                body = await maybe_await(res.json())
                lst = body.get("nfts") if isinstance(body, dict) else None
                if not isinstance(lst, list):
                    return None
                # Enrich with each collection's on-chain name/symbol (from the
                # node token getters) so tiles show a real collection name, not a
                # blank "metadata unavailable" card. One fetch per distinct contract.
                base = self._block_api
                token_base = (base[:-len("/explorer")] if base.endswith("/explorer") else base) + "/token/"
                contracts: List[str] = []
                for n in lst:
                    c = str(n.get("contract")) if isinstance(n, dict) and n.get("contract") is not None else None
                    if c and c not in contracts:
                        contracts.append(c)
                meta_by: Dict[str, Dict[str, Any]] = {}
                for c in contracts:
                    try:
                        r = await maybe_await(self._fetch(token_base + quote(c, safe=""),
                                                          {"method": "GET", "headers": {"accept": "application/json"}}))
                        if r and getattr(r, "ok", False):
                            j0 = await maybe_await(r.json())
                            j = j0.get("result") if isinstance(j0, dict) and isinstance(j0.get("result"), dict) else j0
                            if isinstance(j, dict) and (j.get("name") or j.get("symbol")):
                                meta_by[c] = {"name": j.get("name"), "symbol": j.get("symbol")}
                    except Exception:
                        pass
                return [map_block_item(n, meta_by.get(str(n.get("contract")) if isinstance(n, dict) else None)) for n in lst]

            return None  # unsupported chain -> unavailable (honest)
        except Exception:
            return None  # any error -> unavailable (NEVER a fabricated empty inventory)


# Official BLOCK-721 collections get a canonical image (name/symbol still come
# from the chain). Keyed by lowercase contract id.
_CURATED_NFT = {
    "4a8234f9dda44e953f1a5d4877920431e7d991cdc4b718ff3315dcad7363be4e": {
        "image": "https://blockle.org/world-token.svg", "name": "World Items",
    },
}


def map_block_item(n: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """A native BLOCK-721 item. `meta` is the collection's on-chain metadata
    ({name,symbol}) read from the node token getters — a REAL source, so when
    present we set a name/collection and metadataOk True. A curated image may be
    attached for official collections; otherwise metadataOk stays False and the
    UI renders an honest 'metadata unavailable' tile."""
    contract = str(n.get("contract")) if n and n.get("contract") is not None else None
    token_id = str(n.get("tokenId")) if n and n.get("tokenId") is not None else None
    cur = _CURATED_NFT.get(contract.lower()) if contract else None
    coll = (meta or {}).get("name") or (meta or {}).get("symbol") or (cur or {}).get("name")
    short = ("#" + token_id[:6]) if token_id else ""
    out: Dict[str, Any] = {
        "chain": "block",
        "standard": "block721",
        "contract": contract,
        "tokenId": token_id,
        "metadataOk": bool(coll),
    }
    if coll:
        out["collection"] = coll
        out["name"] = (coll + " " + short).strip()
    if cur and cur.get("image"):
        out["image"] = cur["image"]
    return out


def create_indexer(opts: Optional[Dict[str, Any]] = None) -> Indexer:
    return Indexer(opts)
