"""Telemetry tests: OFF-by-default (disabled => no emit), the secret/address
scrubber (no keys/seeds/addresses ever leave), bucketing, and the pseudonymous
rotating agent id.

Mirrors blockle-extension/telemetry.test.js.
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.multichain import telemetry as T


def run(coro):
    return asyncio.run(coro)


# -------------------------------------------------------------- OFF by default


def test_disabled_by_default_no_emit():
    t = T.create({})  # no enabled flag
    assert t.is_enabled() is False
    res = run(t.emit({"strategy": "momentum", "venue": "evmdex", "chain": "base", "sizeUsd": 50}))
    assert res == {"emitted": False, "reason": "disabled"}


def test_disabled_never_calls_transport():
    calls = []

    async def fetch_impl(url, opts):
        calls.append((url, opts))

    t = T.create({"fetchImpl": fetch_impl})  # enabled still False
    run(t.emit({"strategy": "x", "sizeUsd": 10}))
    assert calls == []  # disabled => no network, ever


def test_enabled_emits_bucketed_payload_with_no_raw_fields():
    captured = {}

    async def fetch_impl(url, opts):
        import json
        captured["url"] = url
        captured["body"] = json.loads(opts["body"])

    t = T.create({"enabled": True, "fetchImpl": fetch_impl, "salt": "deadbeef",
                  "clock": lambda: 1_700_000_000_000})
    res = run(t.emit({
        "strategy": "mean-reversion", "venue": "jupiter", "chain": "solana",
        "pair": "SOL/USDC", "side": "buy", "sizeUsd": 250, "holdTimeSec": 7200,
        "result": "win", "pnlPct": 3.14159, "feePaidUsd": 0.5,
    }))
    assert res["emitted"] is True
    body = captured["body"]
    # coarse, bucketed, whitelisted fields only
    assert body["sizeBucket"] == "100-1k"
    assert body["holdBucket"] == "1h-1d"
    assert body["result"] == "win"
    assert body["pnlPct"] == 3.14            # rounded to 2dp
    assert body["pair"] == "SOL/USDC"
    assert body["assetClass"] == "crypto-major"
    assert len(body["agentId"]) == 16        # pseudonymous, truncated hash
    # exact size/amount never present
    assert "sizeUsd" not in body and "amount" not in body


# ------------------------------------------------------------- NO SECRETS


def test_scrubber_rejects_evm_address():
    with pytest.raises(ValueError):
        T.assert_no_secrets({"note": "0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c"})


def test_scrubber_rejects_api_key_and_seed_words():
    # OpenAI/Anthropic-style key: sk- + 8+ alphanumerics
    with pytest.raises(ValueError):
        T.assert_no_secrets({"x": "sk-abcd1234efgh5678ijkl"})
    # the credential/seed keyword scrubber (\bmnemonic\b etc.)
    with pytest.raises(ValueError):
        T.assert_no_secrets({"x": "my mnemonic is written down"})
    with pytest.raises(ValueError):
        T.assert_no_secrets({"x": "here is the seed_phrase value"})


def test_scrubber_rejects_disallowed_field_names():
    # exactly the names in the disallowed-key list (case-insensitive)
    for bad in ("apiKey", "api_key", "seed", "secret", "privkey", "private_key",
                "address", "addr", "from", "to", "mnemonic", "key"):
        with pytest.raises(ValueError):
            T.assert_no_secrets({bad: "whatever"})


def test_emit_drops_when_label_would_leak_address():
    """If a raw address is smuggled into a label field, the built payload must
    sanitize it to 'redacted' and the emit must still carry no secret."""
    sent = {}

    async def fetch_impl(url, opts):
        import json
        sent["body"] = json.loads(opts["body"])

    t = T.create({"enabled": True, "fetchImpl": fetch_impl, "salt": "cafe"})
    res = run(t.emit({"strategy": "0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c",
                      "venue": "evmdex", "chain": "base"}))
    # the emit succeeds but the leaky label was redacted, not transmitted
    assert res["emitted"] is True
    assert sent["body"]["strategy"] == "redacted"
    T.assert_no_secrets(sent["body"])  # backstop confirms nothing leaked


def test_build_payload_passes_scrubber():
    t = T.create({"enabled": True, "salt": "01"})
    payload = run(t.build_payload({"strategy": "grid", "venue": "blockle", "chain": "block",
                                   "pair": "BLOCK/USDC", "sizeUsd": 5, "result": "loss"}))
    T.assert_no_secrets(payload)  # must not raise
    assert payload["sizeBucket"] == "<10"
    assert payload["assetClass"] == "block"
    assert payload["result"] == "loss"


# ------------------------------------------------------ pseudonymous id


def test_agent_id_rotates_daily_and_is_salt_bound():
    day = 24 * 60 * 60 * 1000
    a = T.create({"enabled": True, "salt": "salt-A"})
    b = T.create({"enabled": True, "salt": "salt-B"})
    id_day0 = run(a.agent_id(0))
    id_day0_again = run(a.agent_id(1000))             # same rotation window
    id_day1 = run(a.agent_id(day + 1))                # next window
    id_b_day0 = run(b.agent_id(0))                    # different salt
    assert id_day0 == id_day0_again                   # stable within the window
    assert id_day0 != id_day1                         # rotates across windows
    assert id_day0 != id_b_day0                       # salt-bound
    assert len(id_day0) == 16


def test_bucketing_helpers():
    assert T.bucket_usd(0) == "0"
    assert T.bucket_usd(5) == "<10"
    assert T.bucket_usd(500) == "100-1k"
    assert T.bucket_usd(5_000_000) == "1m+"
    assert T.bucket_usd(-1) == "unknown"
    assert T.bucket_hold_time(30) == "<1m"
    assert T.bucket_hold_time(7200) == "1h-1d"
    assert T.bucket_hold_time(7 * 86400) == "1w+"


def test_classify_and_sanitize():
    assert T.classify_asset("USDC") == "stablecoin"
    assert T.classify_asset("BTC") == "crypto-major"
    assert T.classify_asset("BLOCK") == "block"
    assert T.classify_asset("PEPE") == "crypto-other"
    assert T.sanitize_pair("block/usdc") == "BLOCK/USDC"
    # an address-like label is redacted
    assert T.sanitize_label("0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c") == "redacted"
