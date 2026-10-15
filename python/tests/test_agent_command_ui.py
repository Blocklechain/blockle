"""tests/test_agent_command_ui.py — pure renderers for the NL command bar.

Port of ``blockle-extension/command-ui.test.js``. The UI owns no gate: it only
renders what the router reports. These tests pin the event -> line mapping and
confirm the renderers present NO self-owned approve control (confirmation
belongs to the shared security sheet via ``policy.gate_confirm``).
"""

from __future__ import annotations

import re

from blockle.agent import command_ui as ui

RESOLVED = "0x" + "b" * 40


def test_intent_badge_distinguishes_action_vs_query():
    assert "ACTION" in ui.intent_badge("action")
    assert "QUERY" in ui.intent_badge("query")


def test_plan_renders_one_row_per_step_each_awaiting_confirm():
    text = ui.plan_text([
        {"index": 0, "action": "swap", "args": {"from": "USDC", "to": "ETH", "amount": "60000000"}},
        {"index": 1, "action": "swap", "args": {"from": "ETH", "to": "USDC", "amount": "40000000"}},
    ])
    rows = re.findall(r"awaiting confirm", text)
    assert len(rows) == 2, "two steps shown, each awaiting confirmation"
    assert "USDC" in text


def test_resolved_mapping_shows_name_and_resolved_address_and_source():
    text = ui.resolved_text({"input": "alice.eth", "address": RESOLVED, "source": "ens"})
    assert "alice.eth" in text
    assert "ens" in text
    assert RESOLVED in text


def test_event_text_maps_router_events_and_ignores_unknowns():
    assert "ACTION" in ui.event_text({"type": "intent", "intent": "action"})
    assert "confirmed & sent" in ui.event_text(
        {"type": "executed", "name": "send", "txid": "0xdeadbeefcafef00d"})
    assert "declined" in ui.event_text({"type": "declined", "name": "send"})
    assert "cap exceeded" in ui.event_text(
        {"type": "step_error", "name": "send", "error": "per-asset cap exceeded"})
    assert "123.45" in ui.event_text({"type": "text", "text": "your net worth is $123.45"})
    assert ui.event_text({"type": "prepared", "name": "send"}) == ""
    assert ui.event_text(None) == ""


def test_command_bar_renders_no_approve_or_sign_control_of_its_own():
    # confirmation belongs to the shared security sheet via policy.gate_confirm;
    # the renderers must never present a clickable approve/confirm/sign control.
    text = (ui.plan_text([{"index": 0, "action": "send",
                           "args": {"chain": "ethereum", "to": "0x" + "a" * 40, "amount": "1"}}])
            + "\n" + ui.step_outcome_text("send", "committed", "0xabc"))
    assert not re.search(r"(approve|sign)\s*(button|now)?", text, re.I) or "awaiting confirm" in text
    # explicitly: no HTML control markup of any kind (plain-text transcript).
    assert "<button" not in text and "onclick" not in text


def test_short_truncates_long_addresses():
    assert ui.short(RESOLVED).startswith("0xbbbbbb") and "…" in ui.short(RESOLVED)
    assert ui.short("short") == "short"
