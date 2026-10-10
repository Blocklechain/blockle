"""Agent token-discovery feed tests (docs/AGENT-STRATEGIES.md §7).

Discovery is READ-ONLY: it finds, filters, flags, scores, and ranks candidate
tokens and NEVER trades, signs, or auto-adds to the policy allowlist. These tests
pin the CANONICAL scoring vector (== 0.98 exactly), prove the filters drop
sub-threshold / denylisted / too-new candidates, that ``rejectFlags`` hard-drops,
that scoring is deterministic + monotonic in liquidity/volume, that sources can be
individually disabled, and that a discovered-but-unapproved token can never reach
a trade (it produces a ``blocked`` audit note through the UNCHANGED dispatch gate).

Run:  python -m pytest python/ -k discovery
"""

from __future__ import annotations

import asyncio

from blockle.agent import audit as audit_mod
from blockle.agent import discovery as disc_mod
from blockle.agent import policy as policy_mod
from blockle.agent import strategies as strat_mod
from blockle.agent import strategy_runner as sr_mod
from blockle.agent import tools as tools_mod


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# scoring: the canonical vector + determinism + monotonicity                  #
# --------------------------------------------------------------------------- #

def test_canonical_scoring_vector_is_exactly_0_98():
    cand = {"liquidityUsd": 100000, "volume24hUsd": 50000, "ageSec": 86400,
            "source": "exchangeListings", "flags": []}
    # 0.40·1 + 0.30·1 + 0.20·1 + 0.10·0.8 − 0.25·0 = 0.98 EXACTLY
    assert disc_mod.score_candidate(cand) == 0.98


def test_score_missing_feature_contributes_zero_not_fabricated():
    # no liquidity + no volume + no age known -> only the source-trust term.
    cand = {"source": "venuePairs", "flags": []}
    assert disc_mod.score_candidate(cand) == 0.10 * 0.5
    # a candidate with nothing and an unknown source scores 0.
    assert disc_mod.score_candidate({"flags": []}) == 0.0


def test_score_clamped_and_flag_penalty_applied():
    base = {"liquidityUsd": 100000, "volume24hUsd": 50000, "ageSec": 86400,
            "source": "exchangeListings"}
    one_flag = dict(base, flags=["low-liquidity"])
    assert disc_mod.score_candidate(one_flag) == 0.98 - 0.25
    # many flags cannot push the score below 0 (clamped).
    many = dict(base, flags=["a", "b", "c", "d", "e"])
    assert disc_mod.score_candidate(many) == 0.0


def test_score_monotonic_in_liquidity_and_volume():
    def mk(liq, vol):
        return {"liquidityUsd": liq, "volume24hUsd": vol, "ageSec": 86400,
                "source": "exchangeListings", "flags": []}
    lo = disc_mod.score_candidate(mk(10000, 10000))
    mid = disc_mod.score_candidate(mk(50000, 30000))
    hi = disc_mod.score_candidate(mk(100000, 50000))
    assert lo < mid < hi
    # deterministic: identical inputs -> identical output.
    assert disc_mod.score_candidate(mk(50000, 30000)) == mid


# --------------------------------------------------------------------------- #
# sources, filters, flags via scan()                                          #
# --------------------------------------------------------------------------- #

def _good_market(symbol="NEW", **over):
    r = {"chain": "base", "symbol": symbol, "address": "0x" + symbol.lower() * 2,
         "pair": f"{symbol}/USDC", "liquidityUsd": 100000, "volume24hUsd": 50000,
         "ageSec": 86400, "verified": True}
    r.update(over)
    return r


def test_scan_filters_drop_subthreshold_too_new_and_wrong_quote():
    ctx = {"getMarkets": lambda: [
        _good_market("KEEP"),
        _good_market("THIN", liquidityUsd=500),          # below minLiquidityUsd
        _good_market("FRESH", ageSec=60),                # below minAgeSec
        _good_market("ODDQ", pair="ODDQ/WBTC"),          # quote not allowed
    ]}
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    syms = {c["symbol"] for c in run(d.scan())}
    assert syms == {"KEEP"}


def test_scan_denylist_and_allowlist():
    ctx = {"getMarkets": lambda: [_good_market("AAA"), _good_market("BBB"), _good_market("CCC")]}
    # denylist drops BBB
    d1 = disc_mod.create({"ctx": ctx, "config": {
        "sources": {"watchlist": False}, "filters": {"denylist": ["BBB"]}}})
    assert {c["symbol"] for c in run(d1.scan())} == {"AAA", "CCC"}
    # allowlist keeps only AAA
    d2 = disc_mod.create({"ctx": ctx, "config": {
        "sources": {"watchlist": False}, "filters": {"allowlist": ["AAA"]}}})
    assert {c["symbol"] for c in run(d2.scan())} == {"AAA"}


def test_reject_flags_hard_drop_honeypot():
    ctx = {"getMarkets": lambda: [
        _good_market("SAFE"),
        _good_market("TRAP", honeypot=True),
    ]}
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    out = run(d.scan())
    syms = {c["symbol"] for c in out}
    assert "TRAP" not in syms and "SAFE" in syms


def test_requireVerified_drops_unverified_external():
    ctx = {"getMarkets": lambda: [
        _good_market("OK", verified=True),
        _good_market("SHADY", verified=False),
    ]}
    # default requireVerified True -> SHADY dropped
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    assert {c["symbol"] for c in run(d.scan())} == {"OK"}
    # requireVerified False -> SHADY kept but carries an 'unverified' flag
    d2 = disc_mod.create({"ctx": ctx, "config": {
        "sources": {"watchlist": False}, "filters": {"requireVerified": False}}})
    shady = next(c for c in run(d2.scan()) if c["symbol"] == "SHADY")
    assert "unverified" in shady["flags"]


def test_rug_heuristics_add_flags_never_claim_safe():
    ctx = {"getMarkets": lambda: [_good_market(
        "RISK", chain="solana", liquidityLocked=False, mintRenounced=False,
        holderTopPct=80)]}
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    c = run(d.scan())[0]
    assert "liquidity-not-locked" in c["flags"]
    assert "mint-not-renounced" in c["flags"]
    assert "holder-concentration" in c["flags"]
    # the flags drag the score down but the candidate is still surfaced (honest).
    assert c["score"] < 0.98


def test_sources_individually_disabled():
    ctx = {
        "getMarkets": lambda: [_good_market("EXCH")],
        "getBlockLaunches": lambda: [_good_market("LAUNCH", chain="block")],
        "getVenuePairs": lambda: [_good_market("VENUE")],
    }
    # everything on (watchlist adds WATCH)
    d_all = disc_mod.create({"ctx": ctx, "config": {
        "watchlist": [{"symbol": "WATCH", "chain": "base", "liquidityUsd": 100000,
                       "volume24hUsd": 50000, "ageSec": 86400, "pair": "WATCH/USDC"}]}})
    assert {c["symbol"] for c in run(d_all.scan())} == {"EXCH", "LAUNCH", "VENUE", "WATCH"}
    # disable exchangeListings + venuePairs
    d_some = disc_mod.create({"ctx": ctx, "config": {
        "sources": {"exchangeListings": False, "venuePairs": False, "watchlist": False}}})
    assert {c["symbol"] for c in run(d_some.scan())} == {"LAUNCH"}


def test_exchange_listings_surfaces_only_new_markets():
    ctx = {"getMarkets": lambda: [_good_market("OLD"), _good_market("NEW")]}
    d = disc_mod.create({"ctx": ctx, "config": {
        "sources": {"watchlist": False}, "seenMarkets": ["OLD/USDC"]}})
    assert {c["symbol"] for c in run(d.scan())} == {"NEW"}


def test_token_lists_read_only_fetch_parsed():
    fetched = []

    def fetch_json(url):
        fetched.append(url)
        return {"tokens": [
            {"chain": "ethereum", "symbol": "LIST", "address": "0xabc", "verified": True},
        ]}

    d = disc_mod.create({"ctx": {"fetchJson": fetch_json}, "config": {
        "sources": {"watchlist": False},
        "tokenLists": [{"url": "https://tokens.example/list.json"}],
        # token-list entries have no liquidity/age -> relax those filters for the test
        "filters": {"minLiquidityUsd": 0, "minAgeSec": 0}}})
    out = run(d.scan())
    assert fetched == ["https://tokens.example/list.json"]
    assert [c["symbol"] for c in out] == ["LIST"]
    assert out[0]["source"] == "tokenLists"


def test_watchlist_items_trusted_as_candidates():
    d = disc_mod.create({"ctx": {}, "config": {
        "watchlist": ["MYCOIN"],
        "filters": {"minLiquidityUsd": 0, "minAgeSec": 0}}})
    out = run(d.scan())
    assert len(out) == 1
    assert out[0]["symbol"] == "MYCOIN" and out[0]["source"] == "watchlist"
    assert out[0]["approved"] is False      # still NOT auto-approved


def test_dedup_and_maxCandidates_and_ranking():
    ctx = {
        "getMarkets": lambda: [_good_market("DUP")],
        "getVenuePairs": lambda: [_good_market("DUP")],   # same addr -> deduped
    }
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    out = run(d.scan())
    assert len([c for c in out if c["symbol"] == "DUP"]) == 1

    # ranking desc by score + maxCandidates cap
    ctx2 = {"getMarkets": lambda: [
        _good_market("HI", liquidityUsd=100000, volume24hUsd=50000),
        _good_market("LO", liquidityUsd=12000, volume24hUsd=12000),
        _good_market("MID", liquidityUsd=40000, volume24hUsd=25000),
    ]}
    d2 = disc_mod.create({"ctx": ctx2, "config": {
        "sources": {"watchlist": False}, "filters": {"maxCandidates": 2}}})
    out2 = run(d2.scan())
    assert [c["symbol"] for c in out2] == ["HI", "MID"]   # top-2, HI first


# --------------------------------------------------------------------------- #
# the safety invariant: discovery NEVER auto-trades / auto-approves           #
# --------------------------------------------------------------------------- #

def test_scan_always_returns_approved_false_until_explicit_action():
    ctx = {"getMarkets": lambda: [_good_market("NEW")]}
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    out = run(d.scan())
    assert all(c["approved"] is False for c in out)

    # explicit user action flips approval; default consumption is approved-only.
    d.approve("NEW")
    approved = run(d.approved_candidates())
    assert [c["symbol"] for c in approved] == ["NEW"]
    assert approved[0]["approved"] is True


def test_discovered_unapproved_token_cannot_reach_a_trade():
    """A discovered token is NOT on the policy allowlist; dispatching a strategy
    Intent that trades it produces a ``blocked`` audit note — never a trade. This
    reuses the UNCHANGED dispatch gate (discovery adds nothing to the allowlist)."""
    ctx = {"getMarkets": lambda: [_good_market("SHADYTOKEN")]}
    d = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    cand = run(d.scan())[0]
    assert cand["approved"] is False

    # a trivial planner that wants to swap the discovered (unapproved) token.
    class _Strat:
        def validate_params(self, p):
            return p or {}

        def plan(self, _ctx, _params):
            return [{"tool": "swap", "args": {"from": cand["symbol"], "to": "USDC",
                                              "amount": "1000000"},
                     "tag": "disc", "strategy": "x"}]

    class _Reg:
        def get(self, name):
            return _Strat()

    audit = audit_mod.create({})
    # policy allowlist does NOT include 'swap' -> the Intent is blocked at dispatch.
    policy = policy_mod.create({"audit": audit, "requireConfirm": False})
    policy.set_allowlist(["get_balance"])   # discovery never added 'swap'
    tools = tools_mod.build(ctx)

    sr = sr_mod.create({"tools": tools, "policy": policy, "audit": audit,
                        "ctx": ctx, "registry": _Reg()})
    results = run(sr.tick("x", {}, {"mode": "auto"}))
    assert any("blocked" in r for r in results)
    types = [e.get("type") for e in audit.list()]
    assert "blocked" in types
    # nothing executed.
    assert not any("executed" in r for r in results)


# --------------------------------------------------------------------------- #
# §7 Wiring: StrategyRunner.candidates() draws the universe from discovery     #
# (approved-only by default; the dispatch gate is never bypassed).            #
# --------------------------------------------------------------------------- #

class _FakeDiscovery:
    """Minimal discovery double: scan() returns one approved + one unapproved."""

    def __init__(self, rows):
        self._rows = rows

    async def scan(self):
        return [dict(r) for r in self._rows]


_MIXED = [
    {"symbol": "APPROVED", "approved": True, "score": 0.9},
    {"symbol": "RAW", "approved": False, "score": 0.8},
]


def test_candidates_approved_only_by_default():
    disc = _FakeDiscovery(_MIXED)
    sr = sr_mod.create({"tools": tools_mod.build({}), "policy": policy_mod.create({}),
                        "discovery": disc})
    # default: approved-only (an unapproved candidate is a suggestion, not tradeable).
    default = run(sr.candidates())
    assert [c["symbol"] for c in default] == ["APPROVED"]
    # opting in surfaces the raw universe too (still never auto-traded).
    allc = run(sr.candidates({"includeUnapproved": True}))
    assert sorted(c["symbol"] for c in allc) == ["APPROVED", "RAW"]
    # no discovery wired -> empty universe (never fabricated).
    bare = sr_mod.create({"tools": tools_mod.build({}), "policy": policy_mod.create({})})
    assert run(bare.candidates()) == []


def test_autoConsiderUnapproved_includes_raw_but_gate_still_blocks_it():
    """With ``autoConsiderUnapproved=True`` the raw (unapproved) candidate enters
    the considered universe — yet a trade on it STILL passes the UNCHANGED dispatch
    gate, so a non-allowlisted tool yields a ``blocked`` audit note and never a
    trade. Discovery adds nothing to the policy allowlist."""
    ctx = {"getMarkets": lambda: [_good_market("RAWTOKEN")]}
    disc = disc_mod.create({"ctx": ctx, "config": {"sources": {"watchlist": False}}})
    raw_cand = run(disc.scan())[0]
    assert raw_cand["approved"] is False

    audit = audit_mod.create({})
    policy = policy_mod.create({"audit": audit, "requireConfirm": False})
    policy.set_allowlist(["get_balance"])    # 'swap' is NOT allowlisted
    tools = tools_mod.build(ctx)

    class _Strat:
        def validate_params(self, p):
            return p or {}

        def plan(self, _ctx, _params):
            return [{"tool": "swap", "args": {"from": raw_cand["symbol"], "to": "USDC",
                                              "amount": "1000000"},
                     "tag": "disc", "strategy": "x"}]

    class _Reg:
        def get(self, name):
            return _Strat()

    sr = sr_mod.create({"tools": tools, "policy": policy, "audit": audit, "ctx": ctx,
                        "registry": _Reg(), "discovery": disc,
                        "autoConsiderUnapproved": True})

    # autoConsiderUnapproved surfaces the unapproved candidate in the universe...
    universe = run(sr.candidates())
    assert raw_cand["symbol"] in [c["symbol"] for c in universe]

    # ...but dispatching a trade on it is STILL blocked at the gate: no commit.
    results = run(sr.tick("x", {}, {"mode": "auto"}))
    assert any("blocked" in r for r in results)
    assert "blocked" in [e.get("type") for e in audit.list()]
    assert not any("executed" in r for r in results)


# --------------------------------------------------------------------------- #
# FIX-B: dedup keeps the HIGHEST-TRUST source, regardless of gather order      #
# --------------------------------------------------------------------------- #

def test_dedup_highest_trust_wins_watchlist_beats_blocklaunches():
    """A watchlist (trust 1.0) candidate and a blockLaunches (trust 0.7) candidate
    with the SAME dedup key collapse to the watchlist one — even though watchlist
    is gathered LAST. Highest trust wins, not first-seen."""
    shared = {"chain": "block", "symbol": "DUPE", "address": "0xdupe",
              "pair": "DUPE/USDC", "liquidityUsd": 100000, "volume24hUsd": 50000,
              "ageSec": 86400}
    ctx = {"getBlockLaunches": lambda: [dict(shared, verified=True)]}
    d = disc_mod.create({"ctx": ctx, "config": {
        "sources": {"exchangeListings": False, "venuePairs": False, "tokenLists": False},
        "watchlist": [dict(shared)]}})
    out = run(d.scan())
    dupes = [c for c in out if c["symbol"] == "DUPE"]
    assert len(dupes) == 1                       # collapsed to a single candidate
    assert dupes[0]["source"] == "watchlist"     # the highest-trust source won
