"""test_nft_indexer.py — WALLET NFT LIVE INDEXER (blockle/multichain/nft_indexer.py).

Run: cd python && python -m pytest tests/test_nft_indexer.py -q

Python mirror of ``blockle-extension/nft-indexer.test.js`` — verifies the live
indexer maps a MOCK Alchemy NFT v3 response (EVM) and a MOCK DAS getAssetsByOwner
response (Helius / Solana) to the RAW item shape ``nft.py`` expects, that a MISSING
key/endpoint (or an HTTP/parse error) returns no result -> ``unavailable`` (NEVER a
fabricated empty inventory), and that the raw items feed ``nft.py`` end-to-end into
a correctly-normalized inventory.
"""

from __future__ import annotations

import asyncio
import json
import re

import pytest

from blockle.multichain import nft_indexer as NI
from blockle.multichain import nft as NFT


def run(coro):
    return asyncio.run(coro)


class _Resp:
    def __init__(self, ok, status, body):
        self.ok = ok
        self.status = status
        self._body = body

    async def json(self):
        return self._body


def fetch_stub(routes):
    async def _fetch(url, init=None):
        for r in routes:
            if r["match"](url, init):
                return _Resp(r.get("ok", True), r.get("status", 200), r.get("body"))
        return _Resp(False, 404, {})
    return _fetch


# ---- mock Alchemy NFT API v3 getNFTsForOwner response ----------------------
ALCHEMY_BODY = {
    "ownedNfts": [
        {
            "contract": {"address": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", "tokenType": "ERC721"},
            "tokenId": "7777", "balance": "1", "name": "Bored Ape #7777",
            "image": {"cachedUrl": "https://cdn.alchemy.com/bayc/7777.png",
                      "originalUrl": "ipfs://Qmbayc/7777.png"},
            "collection": {"name": "Bored Ape Yacht Club"},
            "tokenUri": "ipfs://Qmbayc/7777.json",
            "raw": {"metadata": {"name": "Bored Ape #7777", "image": "ipfs://Qmbayc/7777.png",
                                 "attributes": [{"trait_type": "Fur", "value": "Gold"}]}},
        },
        {
            "contract": {"address": "0x495f947276749Ce646f68AC8c248420045cb7b5e", "tokenType": "ERC1155"},
            "tokenId": "42", "balance": "3", "name": "Edition 42",
            "image": {"cachedUrl": "https://cdn.alchemy.com/ed/42.png"},
            "collection": {"name": "OpenSea Shared"},
            "raw": {"metadata": {"attributes": []}},
        },
        {
            "contract": {"address": "0x0000000000000000000000000000000000000abc", "tokenType": "ERC721"},
            "tokenId": "1", "balance": "1", "image": {}, "raw": {"metadata": {}},
        },
    ],
}

# ---- mock DAS (Helius) getAssetsByOwner response ---------------------------
DAS_BODY = {
    "jsonrpc": "2.0", "id": "nfts",
    "result": {
        "total": 2, "limit": 1000, "page": 1,
        "items": [
            {
                "interface": "V1_NFT",
                "id": "MintAddrSolana1111111111111111111111111111",
                "content": {
                    "json_uri": "https://arweave.net/abc.json",
                    "metadata": {"name": "DeGod #1234", "symbol": "DGOD",
                                 "attributes": [{"trait_type": "Background", "value": "Blue"}]},
                    "links": {"image": "https://arweave.net/degod-1234.png"},
                },
                "grouping": [{"group_key": "collection",
                              "group_value": "DeGodsColl1111111111111111111111111111111"}],
            },
            {
                "interface": "FungibleToken",
                "id": "UsdcMint1111111111111111111111111111111111",
                "content": {"metadata": {"name": "USD Coin", "symbol": "USDC"}, "links": {}},
            },
        ],
    },
}


# ===========================================================================
# 1. EVM — Alchemy mapping
# ===========================================================================
def test_evm_maps_alchemy_no_fabrication():
    idx = NI.create_indexer({"alchemy": {"apiKey": "test-key"}, "fetchImpl": fetch_stub([
        {"match": lambda u, i: bool(re.search(r"eth-mainnet\.g\.alchemy\.com/nft/v3/.*/getNFTsForOwner", u))
         and "owner=0xOWNER" in u, "body": ALCHEMY_BODY},
    ])})
    raw = run(idx.getNFTsForOwner("ethereum", "0xOWNER"))
    assert isinstance(raw, list)
    assert len(raw) == 3

    bayc = raw[0]
    assert bayc["chain"] == "ethereum"
    assert bayc["contract"] == "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"
    assert bayc["standard"] == "erc721"
    assert bayc["tokenId"] == "7777"
    assert bayc["balance"] == "1"
    assert bayc["name"] == "Bored Ape #7777"
    assert bayc["collection"] == "Bored Ape Yacht Club"
    assert bayc["image"] == "https://cdn.alchemy.com/bayc/7777.png"
    assert bayc["metadataUri"] == "ipfs://Qmbayc/7777.json"
    assert bayc["attributes"] == [{"trait_type": "Fur", "value": "Gold"}]
    assert bayc["metadataOk"] is True

    ed = raw[1]
    assert ed["standard"] == "erc1155"
    assert ed["balance"] == "3"

    bare = raw[2]
    assert bare["metadataOk"] is False
    assert bare.get("name") is None
    assert bare.get("image") is None


def test_evm_raw_items_feed_nft_normalized():
    idx = NI.create_indexer({"alchemy": {"apiKey": "test-key"},
                             "fetchImpl": fetch_stub([{"match": lambda u, i: True, "body": ALCHEMY_BODY}])})
    res = run(NFT.nfts([{"chain": "ethereum", "address": "0xOWNER"}], {"indexer": idx, "config": {}}))
    assert res["unavailable"] == []
    assert len(res["items"]) == 3
    bayc = next(i for i in res["items"] if i["tokenId"] == "7777")
    assert bayc["metadataUri"] == "https://ipfs.io/ipfs/Qmbayc/7777.json"
    bare = next(i for i in res["items"] if i["metadataOk"] is False)
    assert bare["metadataNote"] == "metadata-unavailable"


# ===========================================================================
# 2. Solana — DAS mapping (non-fungibles only)
# ===========================================================================
def test_solana_maps_das_filters_fungibles():
    saw = {}

    async def _fetch(url, init=None):
        saw["body"] = json.loads(init["body"])
        return _Resp(True, 200, DAS_BODY)
    idx = NI.create_indexer({"helius": {"apiKey": "helius-key"}, "fetchImpl": _fetch})
    raw = run(idx.getNFTsForOwner("solana", "OwnerSolPubkey111"))
    assert saw["body"]["method"] == "getAssetsByOwner"
    assert saw["body"]["params"]["ownerAddress"] == "OwnerSolPubkey111"
    assert isinstance(raw, list)
    assert len(raw) == 1
    degod = raw[0]
    assert degod["chain"] == "solana"
    assert degod["standard"] == "metaplex"
    assert degod["contract"] == "MintAddrSolana1111111111111111111111111111"
    assert degod["name"] == "DeGod #1234"
    assert degod["image"] == "https://arweave.net/degod-1234.png"
    assert degod["metadataUri"] == "https://arweave.net/abc.json"
    assert degod["attributes"] == [{"trait_type": "Background", "value": "Blue"}]
    assert degod["metadataOk"] is True


# ===========================================================================
# 3. HONEST-OR-NOTHING — missing key / error => None => `unavailable`
# ===========================================================================
def test_missing_key_is_none_not_fake_empty():
    idx = NI.create_indexer({"alchemy": {}, "fetchImpl": fetch_stub([{"match": lambda u, i: True, "body": ALCHEMY_BODY}])})
    assert run(idx.getNFTsForOwner("ethereum", "0xOWNER")) is None

    idx_sol = NI.create_indexer({"fetchImpl": fetch_stub([{"match": lambda u, i: True, "body": DAS_BODY}])})
    assert run(idx_sol.getNFTsForOwner("solana", "Owner")) is None


def test_http_or_parse_error_is_none():
    idx = NI.create_indexer({"alchemy": {"apiKey": "k"},
                             "fetchImpl": fetch_stub([{"match": lambda u, i: True, "ok": False, "status": 500, "body": {}}])})
    assert run(idx.getNFTsForOwner("ethereum", "0xOWNER")) is None

    async def _throw(url, init=None):
        raise RuntimeError("network down")
    idx_throw = NI.create_indexer({"alchemy": {"apiKey": "k"}, "fetchImpl": _throw})
    assert run(idx_throw.getNFTsForOwner("ethereum", "0xOWNER")) is None

    async def _das_err(url, init=None):
        return _Resp(True, 200, {"error": {"code": -32000, "message": "bad"}})
    idx_das_err = NI.create_indexer({"helius": {"apiKey": "k"}, "fetchImpl": _das_err})
    assert run(idx_das_err.getNFTsForOwner("solana", "Owner")) is None


def test_missing_key_reports_unavailable():
    idx = NI.create_indexer({"alchemy": {}, "fetchImpl": fetch_stub([{"match": lambda u, i: True, "body": ALCHEMY_BODY}])})
    res = run(NFT.nfts([{"chain": "ethereum", "address": "0xOWNER"}], {"indexer": idx, "config": {}}))
    assert len(res["items"]) == 0
    assert len(res["unavailable"]) == 1
    assert "NOT a claim" in res["unavailable"][0]["reason"]


def test_unsupported_chain_is_none():
    idx = NI.create_indexer({"alchemy": {"apiKey": "k"}, "helius": {"apiKey": "k"},
                             "fetchImpl": fetch_stub([{"match": lambda u, i: True, "body": {}}])})
    assert run(idx.getNFTsForOwner("bitcoin", "bc1xyz")) is None
