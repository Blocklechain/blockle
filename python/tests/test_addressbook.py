"""test_addressbook.py — WALLET ADDRESS BOOK + name resolution (§3).

Run: cd python && python -m pytest tests/test_addressbook.py -q

Asserts the Python port (``blockle/multichain/addressbook.py``) against the
AUTHORITATIVE shared fixture ``docs/portfolio-vectors.json`` (ens / sns / book /
raw + a null for an unresolvable name) plus unit tests for the book CRUD (dedup
by label), the never-guess rule, reverse display preference (book >
forward-verified ENS/SNS > null), and the in-memory store wrapper.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from blockle.multichain import addressbook as AB

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "portfolio-vectors.json").read_text())


def run(coro):
    return asyncio.run(coro)


def res_ctx(rn):
    async def resolve_ens(name):
        return rn["ensMap"].get(name)

    async def resolve_sns(name):
        return rn["snsMap"].get(name)
    return {"book": rn["book"], "resolveEns": resolve_ens, "resolveSns": resolve_sns}


# ===========================================================================
# CANONICAL RESOLUTION VECTOR — ens / sns / book / raw / null
# ===========================================================================
def test_vector_resolve_name_ens_sns_book_raw_null():
    rn = VECTORS["resolveName"]
    for c in rn["cases"]:
        got = run(AB.resolve_name(c["input"], c["chain"], res_ctx(rn)))
        if c["expect"] is None:
            assert got is None, c["name"] + " resolves to null"
        else:
            assert got, c["name"] + " resolves"
            assert got["address"] == c["expect"]["address"], c["name"] + " address"
            assert got["source"] == c["expect"]["source"], c["name"] + " source"


def test_resolve_name_eth_with_no_resolver_returns_null():
    assert run(AB.resolve_name("alice.eth", "ethereum", {})) is None


def test_resolve_name_raw_verbatim_never_transformed():
    addr = "0x1234567890abcdef1234567890ABCDEF12345678"
    got = run(AB.resolve_name(addr, "ethereum", {}))
    assert got["source"] == "raw"
    assert got["address"] == addr, "exact bytes preserved (no case/format change)"

    assert run(AB.resolve_name("0xdeadbeef", "ethereum", {})) is None, "too short => null"
    assert run(AB.resolve_name("randomword", "ethereum", {})) is None, "not address-like => null"


# ===========================================================================
# BOOK CRUD — pure list ops, dedup by label
# ===========================================================================
def test_book_add_edit_remove_dedups_by_label_and_sorted():
    lst = []
    lst = AB.upsert_entry(lst, {"label": "Mom", "address": "0xM0M0000000000000000000000000000000000000", "chain": "ethereum"})
    lst = AB.upsert_entry(lst, {"label": "Dad", "address": "0xDAD0000000000000000000000000000000000000"})
    assert len(lst) == 2
    assert [e["label"] for e in lst] == ["Dad", "Mom"], "sorted by label"

    lst = AB.upsert_entry(lst, {"label": "mom", "address": "0xNEW0000000000000000000000000000000000000"})
    assert len(lst) == 2, "no duplicate label"
    assert AB.find_by_label(lst, "Mom")["address"] == "0xNEW0000000000000000000000000000000000000", "edited in place"

    lst = AB.remove_entry(lst, "Dad")
    assert len(lst) == 1
    assert AB.find_by_label(lst, "Dad") is None


def test_normalize_entry_requires_label_and_address():
    with pytest.raises(ValueError, match="label"):
        AB.normalize_entry({"address": "0xabc"})
    with pytest.raises(ValueError, match="address"):
        AB.normalize_entry({"label": "x"})


# ===========================================================================
# REVERSE DISPLAY — book label > forward-verified ENS/SNS > null
# ===========================================================================
def test_reverse_name_book_label_wins():
    book = [{"label": "Mom", "address": "0xM0M0000000000000000000000000000000000000", "chain": "ethereum"}]
    r = run(AB.reverse_name("0xM0M0000000000000000000000000000000000000", "ethereum", {"book": book}))
    assert r == {"label": "Mom", "source": "book"}


def test_reverse_name_ens_trusted_only_when_forward_verifies():
    addr = "0xA11CE00000000000000000000000000000000000"

    async def rev_good(a):
        return "alice.eth"

    async def fwd_good(n):
        return addr
    good = run(AB.reverse_name(addr, "ethereum", {"book": [], "reverseEns": rev_good, "resolveEns": fwd_good}))
    assert good == {"label": "alice.eth", "source": "ens"}

    async def rev_spoof(a):
        return "evil.eth"

    async def fwd_spoof(n):
        return "0x9999999999999999999999999999999999999999"
    spoof = run(AB.reverse_name(addr, "ethereum", {"book": [], "reverseEns": rev_spoof, "resolveEns": fwd_spoof}))
    assert spoof is None, "unverified reverse name is not shown (anti-spoof)"


def test_reverse_name_no_book_no_resolver_returns_null():
    assert run(AB.reverse_name("0xabc", "ethereum", {"book": []})) is None


# ===========================================================================
# STORE WRAPPER — persists via an injected Store (in-memory here)
# ===========================================================================
class MemStore:
    def __init__(self):
        self.data = {}

    async def get(self, keys):
        out = {}
        for k in (keys if isinstance(keys, list) else [keys]):
            if k in self.data:
                out[k] = self.data[k]
        return out

    async def set(self, obj):
        self.data.update(obj)


def test_create_book_persists_through_store_and_resolve_reads_live_book():
    store = MemStore()
    book = AB.create_book({"store": store})
    run(book.add({"label": "Mom", "address": "0xM0M0000000000000000000000000000000000000", "chain": "ethereum"}))
    run(book.add({"label": "Exchange", "address": "0xEXCHANGE000000000000000000000000000000000"}))
    assert len(run(book.list())) == 2

    r = run(book.resolve_name("Mom", "ethereum", {}))
    assert r == {"address": "0xM0M0000000000000000000000000000000000000", "source": "book", "label": "Mom"}

    run(book.remove("Exchange"))
    assert len(run(book.list())) == 1
    assert isinstance(store.data[AB.STORE_KEY], list), "persisted under the settings-adjacent key"
