"""chains/autoimport tests — auto-detect + auto-import held tokens on EVERY chain.
Pins the shared contract (docs/scan-vectors.json -> tokenImport): a real positive
balance is auto-imported; a default / zero-balance row is not; dedupe by
(chain, contract|mint); the security suite (denylist / scam flags / spam) MARKS a
token instead of importing it; re-running imports nothing (idempotent). The
orchestrator persists into the SAME store keys a manual import writes. Outputs
match the JS reference (blockle-extension/chains/autoimport.js) byte-for-byte.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from blockle.multichain.chains import autoimport as TokenAutoImport

VEC = json.loads((Path(__file__).resolve().parents[2] / "docs" / "scan-vectors.json").read_text())["tokenImport"]


def run(coro):
    return asyncio.run(coro)


# ===========================================================================
# SHARED VECTOR: detected balances -> the exact imported / flagged / skipped sets
# ===========================================================================
def test_token_import_vector_ethereum_classifies_exactly():
    r = TokenAutoImport.filter_for_import(VEC["detected"]["ethereum"], [],
                                          {"denylist": VEC["denylist"], "spamFilter": VEC["spamFilter"]})
    assert [x["token"] for x in r["toImport"]] == [VEC["expect"]["imported"][0]]
    assert [(f["token"]["symbol"], f["reason"]) for f in r["flagged"]] == \
        [("CLAIM", "spam"), ("EVIL", "denylist")]
    assert [(s["token"]["symbol"], s["reason"]) for s in r["skipped"]] == \
        [("USDC", "default"), ("ZERO", "zero-balance")]


def test_token_import_vector_solana_spl_is_imported():
    r = TokenAutoImport.filter_for_import(VEC["detected"]["solana"], [],
                                          {"denylist": VEC["denylist"], "spamFilter": VEC["spamFilter"]})
    assert [x["token"] for x in r["toImport"]] == [VEC["expect"]["imported"][1]]


# ===========================================================================
# NEVER FABRICATE: a token with no (or zero) detected balance is never imported
# ===========================================================================
def test_zero_or_no_balance_token_is_never_imported():
    discovered = [
        {"chain": "ethereum", "kind": "erc20", "symbol": "ZERO", "decimals": 18, "address": "0xaaa", "balance": "0"},
        {"chain": "ethereum", "kind": "erc20", "symbol": "NOBAL", "decimals": 18, "address": "0xbbb"},
    ]
    r = TokenAutoImport.filter_for_import(discovered, [], {})
    assert len(r["toImport"]) == 0
    assert [s["reason"] for s in r["skipped"]] == ["zero-balance", "zero-balance"]


# ===========================================================================
# SECURITY: a flagged / denylisted / spam token is MARKED, never imported/traded
# ===========================================================================
def test_denylisted_token_is_flagged_never_imported():
    discovered = [{"chain": "ethereum", "kind": "erc20", "symbol": "BAD", "decimals": 18,
                   "address": "0xBAD", "balance": "100"}]
    r = TokenAutoImport.filter_for_import(discovered, [], {"denylist": ["0xbad"]})
    assert len(r["toImport"]) == 0
    assert r["flagged"][0]["reason"] == "denylist"


def test_scam_honeypot_flagged_token_is_flagged_never_imported():
    discovered = [{"chain": "ethereum", "kind": "erc20", "symbol": "HP", "decimals": 18,
                   "address": "0xhp", "balance": "100", "flags": ["honeypot"]}]
    r = TokenAutoImport.filter_for_import(discovered, [], {})
    assert len(r["toImport"]) == 0
    assert r["flagged"][0]["reason"] == "honeypot"


# ===========================================================================
# DEDUPE + IDEMPOTENT: re-running with the import already persisted adds nothing
# ===========================================================================
def test_rerun_is_idempotent():
    first = TokenAutoImport.filter_for_import(VEC["detected"]["ethereum"], [],
                                              {"denylist": VEC["denylist"], "spamFilter": True})
    persisted = [x["token"] for x in first["toImport"]]
    second = TokenAutoImport.filter_for_import(VEC["detected"]["ethereum"], persisted,
                                               {"denylist": VEC["denylist"], "spamFilter": True})
    assert [x["token"] for x in second["toImport"]] == VEC["expect"]["idempotent_rerun_imports"]
    assert any(s["token"]["symbol"] == "DAI" and s["reason"] == "already-imported" for s in second["skipped"])


# ===========================================================================
# ORCHESTRATOR: runs discovery for EVERY chain + persists into the manual-import
# store keys (chainTokens for EVM/Solana, tokens for BLOCK-20).
# ===========================================================================
class FakeStore:
    def __init__(self, initial=None):
        self.data = {"chainTokens": {}, "tokens": [], "flaggedTokens": {}}
        if initial:
            self.data.update(initial)

    async def get(self, keys):
        keys = keys if isinstance(keys, (list, tuple)) else [keys]
        return {k: self.data.get(k) for k in keys}

    async def set(self, obj):
        self.data.update(obj)


def fake_registry(per_chain):
    class Reg:
        def enabled(self):
            return list(per_chain.keys())

        def discover_tokens(self, chain, addr):
            return per_chain.get(chain, [])

    return Reg()


def test_orchestrator_auto_imports_across_every_chain():
    store = FakeStore()
    registry = fake_registry({"ethereum": VEC["detected"]["ethereum"], "solana": VEC["detected"]["solana"]})
    summary = run(TokenAutoImport.auto_import({
        "registry": registry, "store": store, "denylist": VEC["denylist"], "spamFilter": True,
        "address_for": lambda c: "0xMyAddress",
    }))
    assert store.data["chainTokens"]["ethereum"] == [VEC["expect"]["imported"][0]]
    assert store.data["chainTokens"]["solana"] == [VEC["expect"]["imported"][1]]
    assert len(store.data["flaggedTokens"]["ethereum"]) == 2
    assert sorted(f["reason"] for f in store.data["flaggedTokens"]["ethereum"]) == ["denylist", "spam"]
    assert len(summary["imported"]) == 2
    assert summary["changed"] is True


def test_orchestrator_second_run_changes_nothing():
    registry = fake_registry({"ethereum": VEC["detected"]["ethereum"], "solana": VEC["detected"]["solana"]})
    store = FakeStore()
    run(TokenAutoImport.auto_import({"registry": registry, "store": store, "denylist": VEC["denylist"],
                                     "address_for": lambda c: "0xMe"}))
    snapshot = json.dumps(store.data, sort_keys=True)
    summary2 = run(TokenAutoImport.auto_import({"registry": registry, "store": store, "denylist": VEC["denylist"],
                                                "address_for": lambda c: "0xMe"}))
    assert summary2["changed"] is False
    assert json.dumps(store.data, sort_keys=True) == snapshot


def test_orchestrator_block20_persists_into_tokens_id_array():
    store = FakeStore()
    registry = fake_registry({
        "block": [{"chain": "block", "kind": "block20", "symbol": "MEME", "decimals": 8,
                   "id": "abc123", "address": "abc123", "balance": "500"}],
    })
    run(TokenAutoImport.auto_import({"registry": registry, "store": store, "address_for": lambda c: "block1addr"}))
    assert store.data["tokens"] == ["abc123"]
