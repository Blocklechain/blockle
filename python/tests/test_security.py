"""test_security.py — the Wallet Security Suite (docs/WALLET-SECURITY.md).

Run: cd python && python -m pytest tests/test_security.py -q

Asserts the Python port (``blockle/multichain/security.py``) against the
AUTHORITATIVE shared vectors (``docs/security-vectors.json``) — the exact
decode / warning / revoke / gate-composition cases the JS reference
(``blockle-extension/security.js``) and the Dart port reproduce identically —
plus unit tests for the pre-sign gate and the policy-gate composition (a danger
inspection forces a human confirm even within the auto-approve envelope, and
never weakens it).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from blockle.agent import policy as policy_mod
from blockle.agent import runner as runner_mod
from blockle.agent import tools as tools_mod
from blockle.multichain import security as S
from blockle.multichain.chains import evm as EVM

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "security-vectors.json").read_text())


def run(coro):
    return asyncio.run(coro)


# ---- build an injected ctx from a PLAIN vector ctxSpec (no functions) -------
def build_ctx(spec):
    spec = spec or {}
    ctx = {"config": spec.get("config") or {}}
    code_by = spec.get("codeByAddress")
    if code_by:
        async def get_code(addr):
            k = str(addr).lower()
            return code_by.get(k, code_by.get(addr))
        ctx["getCode"] = get_code
    balances = spec.get("balances")
    if balances:
        async def get_balance(asset):
            k = S.member(asset, "symbol")
            v = balances.get(k)
            return v if v is not None else "0"
        ctx["getBalance"] = get_balance
    usd = spec.get("usd")
    if usd:
        async def estimate_usd(asset, amount=None):
            k = S.member(asset, "symbol")
            return usd.get(k)
        ctx["estimateUsd"] = estimate_usd
    if spec.get("seenRecipients"):
        ctx["seenRecipients"] = {S.norm(x) for x in spec["seenRecipients"]}
    if spec.get("priorApprovals"):
        ctx["priorApprovals"] = {S.norm(x) for x in spec["priorApprovals"]}
    return ctx


def detail_map(details):
    return {d["label"]: d["value"] for d in (details or [])}


def codes_of(ws):
    return sorted(w["code"] for w in ws)


# ===========================================================================
# 1. CANONICAL VECTORS — decode + warnings + severity (shared across ports)
# ===========================================================================
@pytest.mark.parametrize("vec", VECTORS["cases"], ids=[v["name"] for v in VECTORS["cases"]])
def test_vector(vec):
    insp = run(S.inspect_transaction(vec["tx"], build_ctx(vec.get("ctxSpec"))))
    e = vec["expect"]

    assert insp["kind"] == e["kind"], "kind"
    assert insp["severity"] == e["severity"], "severity"
    assert codes_of(insp["warnings"]) == sorted(e.get("warnings") or []), "warning codes"

    # max severity must equal the max over the fired warnings (never fabricated)
    assert insp["severity"] == S.max_severity(insp["warnings"]), "severity == max(warnings)"

    if e.get("fields"):
        m = detail_map(insp["details"])
        for k, v in e["fields"].items():
            assert str(m.get(k)) == str(v), "detail field " + k

    if e.get("checksRan"):
        for c in e["checksRan"]:
            assert c in insp["checks"]["ran"], "check ran: " + c
    if e.get("checksSkipped"):
        sk = [x["code"] for x in insp["checks"]["skipped"]]
        for c in e["checksSkipped"]:
            assert c in sk, "check skipped: " + c

    # NEVER claims "safe": a clean result is warnings:[] + severity none + a
    # transparent record of which checks ran / were skipped.
    if e["severity"] == "none" and not (e.get("warnings") or []):
        assert isinstance(insp["checks"]["ran"], list)
        assert isinstance(insp["checks"]["skipped"], list)
        assert len(insp["checks"]["ran"]) + len(insp["checks"]["skipped"]) > 0, \
            "a clean result still lists its checks"


# unlimited flag sits exactly at the threshold boundary (base-unit/int exact)
def test_unlimited_threshold_boundary_is_exact():
    T = S.DEFAULT_UNLIMITED_THRESHOLD
    spender = "0x1111111111111111111111111111111111111111"
    at = run(S.inspect_transaction(
        {"chain": "ethereum", "to": "0xtok", "data": EVM.erc20_approve_data(spender, T)}, {}))
    below = run(S.inspect_transaction(
        {"chain": "ethereum", "to": "0xtok", "data": EVM.erc20_approve_data(spender, T - 1)}, {}))
    assert any(w["code"] == "unlimited-approval" for w in at["warnings"]), "at threshold is unlimited"
    assert not any(w["code"] == "unlimited-approval" for w in below["warnings"]), \
        "one below threshold is NOT unlimited"


# ===========================================================================
# 2. APPROVAL MANAGER — revoke calldata + read-only list (audited unavailable)
# ===========================================================================
def test_vector_build_revoke_emits_approve_zero_calldata_exactly():
    v = VECTORS["revoke"]
    tx = S.build_revoke(v["chain"], v["token"], v["spender"])
    assert tx["kind"] == v["expect"]["kind"]
    assert tx["to"] == v["expect"]["to"]
    assert tx["value"] == v["expect"]["value"]
    assert tx["data"] == v["expect"]["data"]
    # it reuses the EXISTING chains/evm.py builder — identical bytes
    assert tx["data"] == EVM.erc20_approve_data(v["spender"], 0)


def test_list_approvals_no_indexer_is_audited_unavailable_not_fake_all_clear():
    r = run(S.list_approvals("ethereum", "0x2222222222222222222222222222222222222222", {}))
    assert r["approvals"] == []
    assert r["available"] is False
    assert "NOT a safety claim" in r["note"]


def test_list_approvals_indexer_rows_compute_unlimited_from_threshold():
    MAX = (1 << 256) - 1

    async def get_approvals(chain, owner):
        return [
            {"token": "0xtok", "symbol": "USDC", "spender": "0x1111", "allowance": str(MAX)},
            {"token": "0xtok", "symbol": "USDC", "spender": "0x2222", "allowance": "100"},
        ]
    r = run(S.list_approvals("ethereum", "0xowner", {"indexer": {"getApprovals": get_approvals}}))
    assert r["available"] is True
    assert len(r["approvals"]) == 2
    assert r["approvals"][0]["unlimited"] is True
    assert r["approvals"][0]["allowanceBase"] == str(MAX)
    assert r["approvals"][1]["unlimited"] is False


def test_list_approvals_indexer_error_fails_safe_not_fake_all_clear():
    async def get_approvals(chain, owner):
        raise RuntimeError("rate limited")
    r = run(S.list_approvals("ethereum", "0xowner", {"indexer": {"getApprovals": get_approvals}}))
    assert r["approvals"] == []
    assert r["available"] is False
    assert "unavailable" in r["note"]


# ===========================================================================
# 4. PRE-SIGN GATE — danger forces an explicit confirm; fail-closed; never signs
# ===========================================================================
SET_APPROVAL_FOR_ALL_TRUE = (
    "0xa22cb46500000000000000000000000011111111111111111111111111111111111111110"
    "000000000000000000000000000000000000000000000000000000000000001")


def test_presign_danger_blocked_when_no_confirm_handler_fail_closed():
    tx = {"chain": "ethereum", "to": "0xtok", "data": SET_APPROVAL_FOR_ALL_TRUE}
    with pytest.raises(S.SigningBlocked):
        run(S.presign({"tx": tx, "ctx": {}}))


def test_presign_danger_proceeds_only_after_explicit_confirm_and_decline_throws():
    tx = {"chain": "ethereum", "to": "0xtok", "data": SET_APPROVAL_FOR_ALL_TRUE}

    async def yes(_insp):
        return True

    async def no(_insp):
        return False

    ok = run(S.presign({"tx": tx, "ctx": {}, "confirm": yes}))
    assert ok["cleared"] is True
    assert ok["inspection"]["severity"] == "danger"
    with pytest.raises(S.SigningDeclined):
        run(S.presign({"tx": tx, "ctx": {}, "confirm": no}))


def test_presign_clean_tx_passes_through_no_confirm_required():
    tx = {"chain": "ethereum", "to": "0x2222222222222222222222222222222222222222", "value": "1000"}
    r = run(S.presign({"tx": tx, "ctx": {}}))
    assert r["cleared"] is True
    assert r["inspection"]["severity"] == "none"


# ===========================================================================
# GATE COMPOSITION — the suite composes with, never weakens, the policy gate
# ===========================================================================
def test_policy_gate_confirm_force_overrides_auto_approve_never_grants_on_its_own():
    asked = {"n": 0}

    async def confirm(_s):
        asked["n"] += 1
        return True

    p = policy_mod.create({"autoApproveUnderUsd": 100, "confirm": confirm})
    auto = run(p.gate_confirm({}, {"usd": 1}))
    assert auto["auto"] is True
    assert asked["n"] == 0  # normally auto-approved

    forced = run(p.gate_confirm({}, {"usd": 1, "forceConfirm": True}))
    assert forced["auto"] is False
    assert forced["approved"] is True
    assert asked["n"] == 1  # the human WAS asked despite being under the envelope

    # never weakens: forceConfirm with no confirm handler fails closed
    p2 = policy_mod.create({"requireConfirm": False})  # would normally skip
    g = run(p2.gate_confirm({}, {"forceConfirm": True}))
    assert g["approved"] is False  # forced to confirm, no handler -> denied


class _Scripted:
    def __init__(self, script):
        self.script = script
        self.i = 0

    async def turn(self, _payload):
        if self.i < len(self.script):
            r = self.script[self.i]
            self.i += 1
            return r
        return {"text": "done"}


def _danger_inspect():
    return {
        "chain": "ethereum", "kind": "token-approval", "severity": "danger",
        "warnings": [{"code": "approval-to-eoa", "severity": "danger", "message": "EOA spender"}],
        "checks": {"ran": ["approval-to-eoa"], "skipped": []},
    }


def _send_call():
    return {"toolCalls": [{"id": "t", "name": "send",
                           "arguments": {"chain": "ethereum",
                                         "to": "0x2222222222222222222222222222222222222222",
                                         "amount": "1"}}]}


def test_runner_danger_inspection_forces_human_confirm_within_auto_approve_envelope():
    counters = {"asked": 0, "broadcast": 0}

    async def estimate_usd(*_a):
        return 1  # well under the $100 auto-approve envelope

    async def build_send(*_a):
        return {"raw": "00", "txid": "tx", "fee": "1"}

    async def broadcast(*_a):
        counters["broadcast"] += 1
        return {"txid": "tx", "accepted": True}

    async def inspect(*_a):
        return _danger_inspect()

    async def confirm(_s):
        counters["asked"] += 1
        return True

    ctx = {"estimateUsd": estimate_usd, "buildSend": build_send,
           "broadcast": broadcast, "inspect": inspect}
    tools = tools_mod.build(ctx)
    policy = policy_mod.create({"autoApproveUnderUsd": 100, "confirm": confirm})
    runner = runner_mod.create({
        "provider": _Scripted([_send_call(), {"text": "done"}]),
        "tools": tools, "policy": policy})
    run(runner.run("send under the envelope but dangerous"))
    assert counters["asked"] == 1, "human was asked despite usd(1) <= autoApprove(100)"
    assert counters["broadcast"] == 1, "committed only after the explicit confirm"


def test_runner_danger_inspection_declined_never_commits():
    counters = {"broadcast": 0}

    async def estimate_usd(*_a):
        return 1

    async def build_send(*_a):
        return {"raw": "00", "txid": "tx", "fee": "1"}

    async def broadcast(*_a):
        counters["broadcast"] += 1
        return {"txid": "tx", "accepted": True}

    async def inspect(*_a):
        return _danger_inspect()

    async def confirm(_s):
        return False

    ctx = {"estimateUsd": estimate_usd, "buildSend": build_send,
           "broadcast": broadcast, "inspect": inspect}
    tools = tools_mod.build(ctx)
    policy = policy_mod.create({"autoApproveUnderUsd": 100, "confirm": confirm})
    runner = runner_mod.create({
        "provider": _Scripted([_send_call(), {"text": "ok, cancelled"}]),
        "tools": tools, "policy": policy})
    run(runner.run("dangerous"))
    assert counters["broadcast"] == 0, "a declined danger never broadcasts"
    tool_msg = next(m for m in runner.messages if m.get("role") == "tool")
    assert "user declined" in tool_msg["results"][0]["content"]


def test_runner_warn_inspection_does_not_force_confirm_composition_only_tightens():
    counters = {"asked": 0, "broadcast": 0}

    async def estimate_usd(*_a):
        return 1

    async def build_send(*_a):
        return {"raw": "00", "txid": "tx", "fee": "1"}

    async def broadcast(*_a):
        counters["broadcast"] += 1
        return {"txid": "tx", "accepted": True}

    async def inspect(*_a):
        return {"chain": "ethereum", "kind": "token-approval", "severity": "warn",
                "warnings": [{"code": "unlimited-approval", "severity": "warn"}],
                "checks": {"ran": [], "skipped": []}}

    async def confirm(_s):
        counters["asked"] += 1
        return True

    ctx = {"estimateUsd": estimate_usd, "buildSend": build_send,
           "broadcast": broadcast, "inspect": inspect}
    tools = tools_mod.build(ctx)
    policy = policy_mod.create({"autoApproveUnderUsd": 100, "confirm": confirm})
    runner = runner_mod.create({
        "provider": _Scripted([_send_call(), {"text": "done"}]),
        "tools": tools, "policy": policy})
    run(runner.run("send a warn-level tx under the envelope"))
    assert counters["asked"] == 0, "a warn does not force a confirm (auto-approve still applies)"
    assert counters["broadcast"] == 1


def test_runner_backward_compatible_no_inspect_wired_behaves_as_before():
    counters = {"asked": 0, "broadcast": 0}

    async def estimate_usd(*_a):
        return 1

    async def build_send(*_a):
        return {"raw": "00", "txid": "tx", "fee": "1"}

    async def broadcast(*_a):
        counters["broadcast"] += 1
        return {"txid": "tx", "accepted": True}

    async def confirm(_s):
        counters["asked"] += 1
        return True

    ctx = {"estimateUsd": estimate_usd, "buildSend": build_send, "broadcast": broadcast}
    tools = tools_mod.build(ctx)
    policy = policy_mod.create({"autoApproveUnderUsd": 100, "confirm": confirm})
    runner = runner_mod.create({
        "provider": _Scripted([_send_call(), {"text": "done"}]),
        "tools": tools, "policy": policy})
    run(runner.run("send"))
    assert counters["asked"] == 0, "auto-approved as before (no security inspector)"
    assert counters["broadcast"] == 1


# gate-composition vector sanity (the shared numbers the ports assert too)
def test_vector_gate_composition_scenario_matches():
    gc = VECTORS["gateComposition"]

    async def yes(_s):
        return True

    p = policy_mod.create({"autoApproveUnderUsd": gc["scenario"]["autoApproveUnderUsd"], "confirm": yes})
    without = run(p.gate_confirm({}, {"usd": gc["scenario"]["actionUsd"]}))
    assert without["auto"] == gc["expect"]["withoutSecurity"]["auto"]

    asked = {"n": 0}

    async def count_yes(_s):
        asked["n"] += 1
        return True

    p2 = policy_mod.create({"autoApproveUnderUsd": gc["scenario"]["autoApproveUnderUsd"], "confirm": count_yes})
    forced = run(p2.gate_confirm({}, {"usd": gc["scenario"]["actionUsd"],
                                      "forceConfirm": gc["scenario"]["inspectionSeverity"] == "danger"}))
    assert forced["auto"] == gc["expect"]["withDangerForceConfirm"]["auto"]
    assert (asked["n"] == 1) == gc["expect"]["withDangerForceConfirm"]["humanConfirmCalled"]
