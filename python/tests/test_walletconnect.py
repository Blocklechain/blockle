"""test_walletconnect.py — Wallet dApp Connect (WalletConnect v2, Sign API).

Run: cd python && python -m pytest tests/test_walletconnect.py -q

Asserts the Python port (``blockle/multichain/walletconnect.py``) against the
AUTHORITATIVE shared vectors (``docs/walletconnect-vectors.json``) — the exact
pairing / proposal-review / approval-intersection / request-routing / expiry
cases the JS reference (``blockle-extension/walletconnect.js``) and the Dart
port reproduce identically — plus the security-gate integration.

TRUST MODEL: an external dApp is UNTRUSTED. Every signing request requires an
explicit human approval AND runs through the security pre-sign gate; NO dApp
request auto-approves. The relay transport + WC crypto are ABSTRACTED behind an
injected FAKE relay; the core is pure given it, and the core NEVER holds keys
(it signs via the injected signer only after approval).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from blockle.multichain import walletconnect as WC

VEC = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "walletconnect-vectors.json").read_text())

CONFIG = VEC["config"]
NOW = VEC["nowMs"]


def run(coro):
    return asyncio.run(coro)


def codes_of(warnings):
    return sorted(w["code"] for w in (warnings or []))


# ---- injected fakes (relay transport + WC crypto are NOT implemented here) --
class FakeStore:
    """Mirrors the injected encrypted store (NO key material). get(k)->{k:v}."""

    def __init__(self, sessions=None):
        self._mem = {WC.STORE_KEY: dict(sessions or {})}

    async def get(self, key):
        return {key: self._mem.get(key)}

    async def set(self, obj):
        self._mem.update(obj)


class FakeRelay:
    def __init__(self):
        self.calls = []

    async def pair(self, parsed):
        self.calls.append(("pair", parsed))

    async def approveProposal(self, proposal, info):
        self.calls.append(("approveProposal", info))

    async def rejectProposal(self, proposal, reason):
        self.calls.append(("rejectProposal", reason))

    async def disconnect(self, topic, reason):
        self.calls.append(("disconnect", topic))


class FakeSigner:
    """Fake wallet signer — canned outputs; the WC core only calls it AFTER
    approval. Real signing lives in the existing signer/evm/solana adapters."""

    def __init__(self):
        self.calls = []

    async def ethSendTransaction(self, args):
        self.calls.append(("ethSendTransaction", args))
        return "0xhash" + "ab" * 32

    async def ethSignTypedData(self, args):
        self.calls.append(("ethSignTypedData", args))
        return "0xsig" + "cd" * 32

    async def personalSign(self, args):
        self.calls.append(("personalSign", args))
        return "0xsig" + "ef" * 32

    async def solanaSignTransaction(self, args):
        self.calls.append(("solanaSignTransaction", args))
        return "0xsolsig" + "11" * 16

    async def solanaSignAndSend(self, args):
        self.calls.append(("solanaSignAndSend", args))
        return "0xsolsig" + "22" * 16

    async def solanaSignMessage(self, args):
        self.calls.append(("solanaSignMessage", args))
        return "0xsig" + "33" * 16


def make_wc(store=None, signer=None, relay=None):
    return WC.create_wallet_connect({
        "relay": relay or FakeRelay(),
        "store": store or FakeStore(),
        "signer": signer or FakeSigner(),
        "config": CONFIG,
        "now": lambda: NOW,
    })


# ===========================================================================
# 1. PAIRING URI — accept ONLY v2, reject v1 + malformed
# ===========================================================================
def test_pairing_valid_v2():
    parsed = WC.parse_pairing_uri(VEC["pairing"]["valid"]["uri"])
    assert parsed == VEC["pairing"]["valid"]["expect"]


def test_pairing_rejects_v1():
    v1 = VEC["pairing"]["rejectV1"]
    with pytest.raises(ValueError) as ei:
        WC.parse_pairing_uri(v1["uri"])
    assert v1["expectErrorMatch"] in str(ei.value)


@pytest.mark.parametrize("case", VEC["pairing"]["rejectMalformed"],
                         ids=[c["uri"] for c in VEC["pairing"]["rejectMalformed"]])
def test_pairing_rejects_malformed(case):
    with pytest.raises(ValueError) as ei:
        WC.parse_pairing_uri(case["uri"])
    assert case["expectErrorMatch"] in str(ei.value)


def test_pair_hands_to_relay_but_grants_nothing():
    relay = FakeRelay()
    wc = make_wc(relay=relay)
    parsed = run(wc.pair(VEC["pairing"]["valid"]["uri"]))
    assert parsed["topic"] == VEC["pairing"]["valid"]["expect"]["topic"]
    assert relay.calls and relay.calls[0][0] == "pair"
    # pairing grants no session.
    assert run(wc.list_sessions()) == []


# ===========================================================================
# 2. PROPOSAL review / approve / reject
# ===========================================================================
def test_review_surfaces_metadata_and_warnings():
    vec = VEC["proposalReview"]["surfaces-metadata-and-warnings"]
    wc = make_wc()
    review = wc.review_proposal(vec["proposal"])
    exp = vec["expect"]
    assert review["dapp"]["name"] == exp["dapp"]["name"]
    assert review["dapp"]["url"] == exp["dapp"]["url"]
    assert review["dapp"]["description"] == exp["dapp"]["description"]
    assert review["chains"] == exp["chains"]
    for mth in exp["methodsInclude"]:
        assert mth in review["methods"]
    assert codes_of(review["warnings"]) == sorted(exp["warnings"])
    assert review["severity"] == exp["severity"]


def test_review_denylisted_dapp_is_danger():
    vec = VEC["proposalReview"]["denylisted-dapp-is-danger"]
    wc = make_wc()
    review = wc.review_proposal(vec["proposal"])
    exp = vec["expect"]
    assert exp["warnings"][0] in codes_of(review["warnings"])
    assert review["severity"] == exp["severity"]


def test_approve_builds_intersection_namespace():
    vec = VEC["approval"]["intersection"]
    wc = make_wc()
    session = run(wc.approve_proposal(vec["proposal"], {"accounts": vec["accounts"]}))
    exp = vec["expect"]
    ns = session["namespaces"][exp["namespaceKey"]]
    assert ns["chains"] == exp["chains"]
    assert ns["accounts"] == exp["accounts"]
    for mth in exp["methodsInclude"]:
        assert mth in ns["methods"]
    for mth in exp["methodsExclude"]:
        assert mth not in ns["methods"]
    for ch in exp["chainsExclude"]:
        assert ch not in ns["chains"]
    assert session["activeChainId"] == exp["activeChainId"]
    # persisted, NO key material.
    assert "symKey" not in json.dumps(session)
    assert run(wc.get_session(session["topic"]))["topic"] == vec["proposal"]["sessionTopic"]


def test_approve_rejects_required_unsupported_chain_fail_closed():
    vec = VEC["approval"]["reject-required-unsupported-chain"]
    wc = make_wc()
    with pytest.raises(ValueError) as ei:
        run(wc.approve_proposal(vec["proposal"], {"accounts": vec["accounts"]}))
    assert vec["expectThrowMatch"] in str(ei.value)
    # fail-closed: nothing is persisted.
    assert run(wc.list_sessions()) == []


def test_reject_proposal_signals_relay():
    relay = FakeRelay()
    wc = make_wc(relay=relay)
    run(wc.reject_proposal(VEC["approval"]["intersection"]["proposal"], None))
    assert any(c[0] == "rejectProposal" for c in relay.calls)


# ===========================================================================
# 3. REQUEST ROUTING — the signing surface (namespace enforcement + gate)
# ===========================================================================
def settled_wc():
    """A wallet with the sess-abc session settled (via the approval vector)."""
    wc = make_wc()
    run(wc.approve_proposal(VEC["approval"]["intersection"]["proposal"],
                            {"accounts": VEC["approval"]["intersection"]["accounts"]}))
    assert VEC["requests"]["_sessionTopic"] == "sess-abc"
    return wc


def ctx(approve=None, confirm="absent", captured=None):
    c = {}
    if approve is not None:
        async def _approve(pres):
            if captured is not None:
                captured["presentation"] = pres
            return approve
        c["approve"] = _approve
    if confirm != "absent":
        async def _confirm(pres):
            if captured is not None:
                captured["confirm_presentation"] = pres
            return confirm
        c["confirm"] = _confirm
    return c


def err_code(resp):
    return resp.get("error", {}).get("code")


def test_eth_sign_never_settled_even_with_allow_eth_sign():
    # Parity with the JS/Dart reference: eth_sign is NEVER a settled/routed method,
    # so it can never enter a session namespace or reach the signer. allowEthSign
    # only softens the per-request refusal message; it must not settle eth_sign.
    cfg = dict(CONFIG)
    cfg["allowEthSign"] = True
    cfg["supportedMethods"] = list(cfg.get("supportedMethods") or []) + ["eth_sign"]
    wc = WC.create_wallet_connect({
        "relay": FakeRelay(), "store": FakeStore(), "signer": FakeSigner(),
        "config": cfg, "now": lambda: NOW,
    })
    assert "eth_sign" not in wc.config["supportedMethods"], \
        "eth_sign must never be a settled/routed method, even with allowEthSign"


def test_request_out_of_namespace_chain():
    wc = settled_wc()
    vec = VEC["requests"]["out-of-namespace-chain"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=True)))
    assert err_code(resp) == vec["expectErrorCode"]


def test_request_out_of_namespace_method():
    wc = settled_wc()
    vec = VEC["requests"]["out-of-namespace-method"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=True)))
    assert err_code(resp) == vec["expectErrorCode"]


def test_request_unknown_topic():
    wc = settled_wc()
    vec = VEC["requests"]["unknown-topic"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=True)))
    assert err_code(resp) == vec["expectErrorCode"]


def test_request_eth_accounts_read():
    wc = settled_wc()
    vec = VEC["requests"]["eth_accounts-read"]
    resp = run(wc.handle_request(vec["request"], {}))
    assert resp["result"] == vec["expectResult"]


def test_request_eth_chainId_read():
    wc = settled_wc()
    vec = VEC["requests"]["eth_chainId-read"]
    resp = run(wc.handle_request(vec["request"], {}))
    assert resp["result"] == vec["expectResult"]


def test_request_eth_sendTransaction_clean_approved():
    wc = settled_wc()
    vec = VEC["requests"]["eth_sendTransaction-clean-approved"]
    cap = {}
    resp = run(wc.handle_request(vec["request"], ctx(approve=True, captured=cap)))
    assert vec["expectResultMatch"] in resp["result"]
    assert cap["presentation"]["severity"] == vec["expectSeverity"]


def test_request_eth_sendTransaction_danger_setApprovalForAll():
    vec = VEC["requests"]["eth_sendTransaction-danger-setApprovalForAll"]
    # severity of the presentation is danger regardless of the confirm outcome.
    cases = vec["cases"]

    # no confirm handler → fail-closed 5000
    wc = settled_wc()
    c = cases["no-confirm-handler-blocks"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=c["approve"])))
    assert err_code(resp) == c["expectErrorCode"]

    # confirm declined → 4001
    wc = settled_wc()
    c = cases["confirm-declined-rejects"]
    cap = {}
    resp = run(wc.handle_request(vec["request"], ctx(approve=c["approve"], confirm=c["confirm"], captured=cap)))
    assert err_code(resp) == c["expectErrorCode"]
    assert cap["confirm_presentation"]["severity"] == vec["expectSeverity"]

    # confirmed + approved → signs
    wc = settled_wc()
    c = cases["confirmed-and-approved-signs"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=c["approve"], confirm=c["confirm"])))
    assert c["expectResultMatch"] in resp["result"]


def test_request_eth_sendTransaction_declined_approval():
    wc = settled_wc()
    vec = VEC["requests"]["eth_sendTransaction-declined-approval"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=False)))
    assert err_code(resp) == vec["expectErrorCode"]


def test_request_typed_data_permit_unlimited_is_danger():
    wc = settled_wc()
    vec = VEC["requests"]["eth_signTypedData_v4-permit-unlimited-danger"]
    cap = {}
    resp = run(wc.handle_request(vec["request"],
                                 ctx(approve=vec["approve"], confirm=vec["confirm"], captured=cap)))
    pres = cap["presentation"]
    assert pres["severity"] == vec["expectSeverity"]
    codes = codes_of(pres["warnings"])
    for w in vec["expectWarningsInclude"]:
        assert w in codes
    assert vec["expectResultMatch"] in resp["result"]


def test_request_typed_data_permit_sized_ok():
    wc = settled_wc()
    vec = VEC["requests"]["eth_signTypedData_v4-permit-sized-ok"]
    cap = {}
    resp = run(wc.handle_request(vec["request"], ctx(approve=vec["approve"], captured=cap)))
    pres = cap["presentation"]
    assert pres["severity"] != vec["expectSeverityNot"]
    codes = codes_of(pres["warnings"])
    for w in vec["expectWarningsInclude"]:
        assert w in codes
    assert vec["expectResultMatch"] in resp["result"]


def test_request_eth_sign_refused_by_default():
    wc = settled_wc()
    vec = VEC["requests"]["eth_sign-refused"]
    resp = run(wc.handle_request(vec["request"], ctx(approve=True)))
    assert err_code(resp) == vec["expectErrorCode"]
    assert vec["expectErrorMatch"] in resp["error"]["message"]


def test_request_personal_sign_decodes_message():
    wc = settled_wc()
    vec = VEC["requests"]["personal_sign-decodes-message"]
    cap = {}
    resp = run(wc.handle_request(vec["request"], ctx(approve=True, captured=cap)))
    assert cap["presentation"]["decoded"]["text"] == vec["expectDecodedText"]
    assert vec["expectResultMatch"] in resp["result"]


# ===========================================================================
# 4. SESSIONS — expiry, unknown topic, list/get/disconnect
# ===========================================================================
def test_expired_session_is_rejected():
    vec = VEC["expiry"]["expired-session-rejected"]
    sess = vec["session"]
    store = FakeStore(sessions={sess["topic"]: sess})
    wc = make_wc(store=store)
    resp = run(wc.handle_request(vec["request"], ctx(approve=vec["approve"])))
    assert err_code(resp) == vec["expectErrorCode"]


def test_sessions_list_get_disconnect():
    wc = settled_wc()
    sessions = run(wc.list_sessions())
    assert len(sessions) == 1
    topic = sessions[0]["topic"]
    assert run(wc.get_session(topic))["topic"] == topic
    out = run(wc.disconnect(topic))
    assert out == {"topic": topic, "disconnected": True}
    assert run(wc.get_session(topic)) is None
    # disconnecting an unknown topic is a no-op (not an error).
    assert run(wc.disconnect("nope"))["disconnected"] is False


def test_no_dapp_request_auto_approves_without_handler():
    # a signing request with NO approval handler wired is fail-closed (never
    # silently signs) — the whole point of the trust model.
    wc = settled_wc()
    req = VEC["requests"]["eth_sendTransaction-clean-approved"]["request"]
    resp = run(wc.handle_request(req, {}))  # no approve handler
    assert err_code(resp) == WC.ERR["BLOCKED"]
    assert "auto-approve" in resp["error"]["message"]
