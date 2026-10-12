"""test_nft.py — WALLET NFT SUPPORT (docs/WALLET-NFT.md §5).

Run: cd python && python -m pytest tests/test_nft.py -q

Asserts the Python port (``blockle/multichain/nft.py``) against the AUTHORITATIVE
shared vectors (``docs/nft-vectors.json``) — the exact inventory grouping (incl. a
metadata-unavailable item), ipfs:// normalization, ERC-721 + ERC-1155 transfer
calldata, the overdraw / wrong-from fail-closed guards, spam flagging, approval
surfacing, and that a built send routes through the SAME
``security.inspect_transaction`` gate as a normal send — identical to the JS
reference (``blockle-extension/nft.test.js``) and the Dart port.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from blockle.multichain import nft as NFT
from blockle.multichain import security as Security
from blockle.multichain.chains import evm as EVM

V = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "nft-vectors.json").read_text())


def run(coro):
    return asyncio.run(coro)


def indexer_from_raw(raw_map):
    async def get_nfts_for_owner(chain, owner):
        key = chain + ":" + owner
        return raw_map.get(key, [])
    return type("Idx", (), {"getNFTsForOwner": staticmethod(get_nfts_for_owner)})()


def by_contract(items):
    m = {}
    for it in items:
        m.setdefault(str(it["contract"]).lower(), []).append(it)
    return m


# ===========================================================================
# 1. INVENTORY — grouping, balances, metadata-unavailable, ipfs normalization
# ===========================================================================
def test_inventory_groups_never_fabricates_metadata():
    inv = V["inventory"]
    ctx = {"config": V["config"], "indexer": indexer_from_raw(inv["raw"])}
    res = run(NFT.nfts(inv["accounts"], ctx))
    e = inv["expect"]

    assert res["unavailable"] == e["unavailable"], "no unavailable accounts"

    groups = by_contract(res["items"])
    for contract, exp in e["itemsByContract"].items():
        items = groups.get(contract)
        assert items, "has items for " + contract
        assert len(items) == exp["count"], "count for " + contract
        assert items[0]["standard"] == exp["standard"], "standard for " + contract
        balances = [i["balance"] for i in items]
        assert balances == exp["balances"], "balances for " + contract
        if exp.get("tokenIds"):
            assert [i["tokenId"] for i in items] == exp["tokenIds"], "tokenIds for " + contract
        if exp.get("collection") is not None:
            assert items[0].get("collection") == exp["collection"], "collection name for " + contract
        if exp.get("metadataOk") is False:
            assert items[0]["metadataOk"] is False, "metadataOk false for " + contract
            assert items[0]["metadataNote"] == exp["metadataNote"], "metadata-unavailable note"
        if exp.get("hasName") is False:
            assert items[0].get("name") is None, "no fabricated name for " + contract

    keys = [c["key"] for c in res["collections"]]
    assert sorted(keys) == sorted(e["collectionKeys"]), "collection keys"
    bayc = next(c for c in res["collections"]
                if c["key"] == "ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d")
    assert bayc["count"] == 2
    assert len(bayc["items"]) == 2

    for k, exp_img in e["normalizedImages"].items():
        chain, contract, token_id = k.split(":")
        it = next(i for i in res["items"]
                  if i["chain"] == chain and str(i["contract"]).lower() == contract
                  and i.get("tokenId") == token_id)
        assert it["image"] == exp_img, "normalized image for " + k


def test_inventory_no_indexer_is_unavailable_not_fake_empty():
    u = V["unavailable"]
    res = run(NFT.nfts(u["accounts"], {"config": V["config"]}))  # no indexer
    assert len(res["items"]) == u["expect"]["items"]
    assert len(res["unavailable"]) == u["expect"]["unavailableCount"]
    assert "NOT a claim" in res["unavailable"][0]["reason"]


def test_inventory_indexer_error_fails_safe():
    async def get_nfts_for_owner(chain, owner):
        raise RuntimeError("boom")
    indexer = type("Idx", (), {"getNFTsForOwner": staticmethod(get_nfts_for_owner)})()
    res = run(NFT.nfts([{"chain": "ethereum", "address": "0x1111111111111111111111111111111111111111"}],
                       {"indexer": indexer}))
    assert len(res["items"]) == 0
    assert len(res["unavailable"]) == 1
    assert "indexer error" in res["unavailable"][0]["reason"]


# ===========================================================================
# 2. ipfs:// normalization (gateway-configured; non-ipfs passes through)
# ===========================================================================
def test_ipfs_normalization():
    for c in V["ipfs"]:
        assert NFT.normalize_uri(c["in"], V["config"]) == c["out"], c["in"]
    assert NFT.normalize_uri(None, V["config"]) is None, "None passes through"


# ===========================================================================
# 3-4. SEND — exact ERC-721 + ERC-1155 calldata (routes through the signer)
# ===========================================================================
@pytest.mark.parametrize("tv", V["transfers"], ids=[t["name"] for t in V["transfers"]])
def test_transfer_calldata_exact(tv):
    tx = NFT.build_nft_transfer(tv["req"], tv["ctx"])
    e = tv["expect"]
    assert tx["kind"] == e["kind"], "kind"
    assert tx["standard"] == e["standard"], "standard"
    assert tx["to"] == e["to"], "to (contract target)"
    assert tx["value"] == e["value"], "value"
    assert tx["data"] == e["data"], "EXACT calldata"
    # the module NEVER signs: no raw/txid/signature on the built tx
    assert "raw" not in tx and "txid" not in tx, "no signed artifact — module never signs"


# ===========================================================================
# GUARDS — fail-closed (overdraw / wrong-from / missing ownedBalance)
# ===========================================================================
@pytest.mark.parametrize("g", V["guards"], ids=[g["name"] for g in V["guards"]])
def test_guards_fail_closed(g):
    with pytest.raises(Exception) as ei:
        NFT.build_nft_transfer(g["req"], g["ctx"])
    assert g["expectError"] in str(ei.value), \
        'error "%s" includes "%s"' % (str(ei.value), g["expectError"])


# ===========================================================================
# 3 (spec §3). SPAM — conservative FLAG only, never a safety/value claim
# ===========================================================================
@pytest.mark.parametrize("s", V["spam"], ids=[s["name"] for s in V["spam"]])
def test_spam_flag_only(s):
    item = NFT.normalize_item(s["raw"], V["config"])
    if s["expect"]["spam"]:
        assert item.get("spam") is True, "flagged"
        assert sorted(item.get("spamReasons") or []) == sorted(s["expect"]["reasons"]), "reasons"
    else:
        assert not item.get("spam"), "not flagged"


# ===========================================================================
# 4 (spec §4). APPROVAL AWARENESS — reuse the security approval manager
# ===========================================================================
def test_surface_approvals_operator_rows_flagged_danger_revocable():
    a = V["approvals"]

    async def get_approvals(chain, owner):
        return a["rawApprovals"]
    indexer = type("Idx", (), {"getApprovals": staticmethod(get_approvals)})()
    res = run(NFT.surface_approvals(a["chain"], a["owner"], {"indexer": indexer}))
    assert res["available"] is True
    assert len(res["operatorApprovals"]) == len(a["expect"]["operatorApprovals"]), "one operator approval"
    op = res["operatorApprovals"][0]
    exp = a["expect"]["operatorApprovals"][0]
    assert op["collection"] == exp["collection"]
    assert op["operator"] == exp["operator"]
    assert op["severity"] == "danger"
    assert op["revocable"] is True


def test_surface_approvals_no_indexer_never_fake_all_clear():
    res = run(NFT.surface_approvals("ethereum", "0x1111111111111111111111111111111111111111", {}))
    assert res["available"] is False
    assert res["operatorApprovals"] == []


# ===========================================================================
# SEND ROUTES THROUGH THE SAME SECURITY GATE as a normal send
# ===========================================================================
def test_built_send_inspected_by_security_decodes_nft_transfer():
    s = V["inspect"]["safeRecipient"]
    insp = run(Security.inspect_transaction(s["tx"], {}))
    assert insp["kind"] == s["expect"]["kind"], "kind"
    assert insp["severity"] == s["expect"]["severity"], "severity"
    to = next(d for d in insp["details"] if d["label"] == "To")
    assert to["value"] == s["expect"]["to"], "recipient decoded"
    tid = next(d for d in insp["details"] if d["label"] == "Token ID")
    assert tid["value"] == s["expect"]["tokenId"], "tokenId decoded"


def test_built_send_to_denylisted_recipient_raises_send_to_flagged():
    s = V["inspect"]["flaggedRecipient"]
    insp = run(Security.inspect_transaction(s["tx"], {"config": s["config"]}))
    assert insp["kind"] == s["expect"]["kind"]
    assert insp["severity"] == s["expect"]["severity"]
    assert sorted(w["code"] for w in insp["warnings"]) == sorted(s["expect"]["warnings"])


# ===========================================================================
# end-to-end: a built ERC-1155 send and the EVM adapter builder agree on calldata
# ===========================================================================
def test_end_to_end_calldata_matches_evm_builder():
    tx = NFT.build_nft_transfer({
        "chain": "ethereum", "standard": "erc1155",
        "contract": "0x495f947276749Ce646f68AC8c248420045cb7b5e",
        "tokenId": "42", "amount": "3", "ownedBalance": "7",
        "from": "0x1111111111111111111111111111111111111111",
        "to": "0x2222222222222222222222222222222222222222",
    }, {"accounts": [{"chain": "ethereum", "address": "0x1111111111111111111111111111111111111111"}]})
    direct = EVM.erc1155_safe_transfer_from_data(
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222", "42", "3", "0x")
    assert tx["data"] == direct, "nft.py reuses the EVM calldata builder"
