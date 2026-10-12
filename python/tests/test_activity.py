"""test_activity.py — WALLET ACTIVITY merged cross-chain feed (§2).

Run: cd python && python -m pytest tests/test_activity.py -q

Asserts the Python port (``blockle/multichain/activity.py``) against the
AUTHORITATIVE shared fixture ``docs/portfolio-vectors.json``: the merge/sort
order, the security-decoder-reused ``kind`` per item, the counterparty flag (a
denylisted recipient stays flagged in history), and STABLE paging with a cursor
— plus the "unavailable indexer => audited note, never a fabricated empty feed"
rule.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from blockle.multichain import activity as A

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "portfolio-vectors.json").read_text())


def run(coro):
    return asyncio.run(coro)


def act_ctx(av):
    async def history(chain, address=None):
        return av["history"].get(chain, [])
    return {"securityConfig": av["securityConfig"], "history": history}


def ids_of(items):
    return [i["txid"] for i in items]


# ===========================================================================
# CANONICAL MERGE/SORT VECTOR — newest-first, decoded kinds, flagged counterparty
# ===========================================================================
def test_vector_merged_feed_time_sorted_decoded_kinds_counterparty_flag():
    av = VECTORS["activity"]
    r = run(A.activity(av["accounts"], act_ctx(av), {"limit": 100}))
    e = av["expect"]["merged"]
    assert len(r["items"]) == len(e), "all items merged"
    for i in range(len(e)):
        assert r["items"][i]["chain"] == e[i]["chain"]
        assert r["items"][i]["txid"] == e[i]["txid"], "sort order"
        assert r["items"][i]["ts"] == e[i]["ts"]
        assert r["items"][i]["kind"] == e[i]["kind"], "reused security decoder"
        assert r["items"][i]["direction"] == e[i]["direction"]
        assert r["items"][i]["flagged"] == e[i]["flagged"]
    # the flagged item carries the security warning code, matching the pre-sign suite
    flagged = next(i for i in r["items"] if i["flagged"])
    assert "send-to-flagged" in flagged["warnings"], "flag reason comes from the security suite"


# ===========================================================================
# STABLE PAGING — cursor-based, deterministic across calls
# ===========================================================================
def test_vector_paging_is_stable():
    av = VECTORS["activity"]
    ctx = act_ctx(av)

    p1 = run(A.activity(av["accounts"], ctx, {"limit": av["expect"]["page1"]["limit"]}))
    assert ids_of(p1["items"]) == av["expect"]["page1"]["ids"], "page1 ids"
    assert p1.get("nextCursor") == av["expect"]["page1"]["nextCursor"], "page1 stable cursor"

    p2 = run(A.activity(av["accounts"], ctx,
                        {"limit": av["expect"]["page2"]["limit"], "cursor": p1["nextCursor"]}))
    assert ids_of(p2["items"]) == av["expect"]["page2"]["ids"], "page2 ids (no overlap, no gap)"
    assert (p2.get("nextCursor") is None) == (av["expect"]["page2"]["nextCursor"] is None)

    # no item appears on both pages (stable, non-overlapping)
    overlap = [a for a in p1["items"] if any(b["txid"] == a["txid"] for b in p2["items"])]
    assert len(overlap) == 0, "pages do not overlap"


# ===========================================================================
# UNAVAILABLE INDEXER — audited note, never a fabricated empty "no activity"
# ===========================================================================
def test_unavailable_indexer_contributes_nothing_plus_audited_note():
    r = run(A.activity([{"chain": "ethereum", "address": "0xE"}], {}, {}))
    assert len(r["items"]) == 0
    assert len(r["notes"]) == 1, "one audited note for the unavailable chain"
    assert "not a claim of no activity" in r["notes"][0]["note"]


def test_throwing_indexer_noted_real_empty_not_noted():
    async def throwing(chain, address=None):
        raise RuntimeError("rate limited")
    thrown = run(A.activity([{"chain": "ethereum", "address": "0xE"}],
                            {"history": throwing}, {}))
    assert len(thrown["items"]) == 0
    assert len(thrown["notes"]) == 1
    assert "indexer error" in thrown["notes"][0]["note"]

    async def empty(chain, address=None):
        return []
    empty_real = run(A.activity([{"chain": "ethereum", "address": "0xE"}],
                                {"history": empty}, {}))
    assert len(empty_real["items"]) == 0
    assert len(empty_real["notes"]) == 0, "a genuine empty history is not an audited unavailability"


# ===========================================================================
# order is a strict stable total order (ts desc, chain asc, txid asc)
# ===========================================================================
def test_cmp_stable_total_order():
    import functools
    a = {"ts": 100, "chain": "ethereum", "txid": "0xaa"}
    b = {"ts": 100, "chain": "ethereum", "txid": "0xbb"}
    c = {"ts": 200, "chain": "solana", "txid": "0xaa"}
    assert A.cmp(c, a) < 0, "newer first"
    assert A.cmp(a, b) < 0, "same ts+chain: txid ascending"
    lst = sorted([a, c, b], key=functools.cmp_to_key(A.cmp))
    assert [x["txid"] for x in lst] == ["0xaa", "0xaa", "0xbb"]
