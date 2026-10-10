"""Injectable notifier + realized-profit copy tests (docs/AGENT-STRATEGIES.md §8).

The pop-up surface is an INJECTABLE notifier: production uses a Qt tray
``showMessage`` / non-modal toast; tests inject a fake. These tests pin the copy
produced by :func:`notify.format_realized` (``+$45.00 — sold 1.5 SOL → USDC`` with
a ``$180.00 → $225.00`` subtitle), the quantity rendering (decimals known vs.
unknown -> raw base units, never a fabricated scale), the proceeds-only (unknown
basis) copy, and the notifier adapters (callable, recording, coerce, and the
headless Qt no-op fallback).

Run:  python -m pytest python/ -k notify
"""

from __future__ import annotations

from blockle.agent import notify as notify_mod


# --------------------------------------------------------------------------- #
# copy formatting                                                             #
# --------------------------------------------------------------------------- #

def test_format_realized_canonical_copy():
    ev = {"asset": "SOL", "soldQty": 150000000, "proceedsUsd": 225.0,
          "basisUsd": 180.0, "realizedUsd": 45.0, "stable": "USDC"}
    out = notify_mod.format_realized(ev, decimals=8)
    assert out["title"] == "+$45.00 — sold 1.5 SOL → USDC"
    assert out["subtitle"] == "$180.00 → $225.00"


def test_format_realized_reads_decimals_from_event():
    ev = {"asset": "SOL", "soldQty": 300000000, "proceedsUsd": 450.0,
          "basisUsd": 360.0, "realizedUsd": 90.0, "stable": "USDT", "decimals": 8}
    out = notify_mod.format_realized(ev)
    assert out["title"] == "+$90.00 — sold 3 SOL → USDT"   # trailing zeros trimmed


def test_format_realized_spec_example_3_2_sol():
    ev = {"asset": "SOL", "soldQty": 320000000, "proceedsUsd": 100.0,
          "basisUsd": 57.9, "realizedUsd": 42.1, "stable": "USDC"}
    out = notify_mod.format_realized(ev, decimals=8)
    assert out["title"] == "+$42.10 — sold 3.2 SOL → USDC"


def test_format_qty_unknown_decimals_shows_base_units():
    ev = {"asset": "FOO", "soldQty": 150000000, "proceedsUsd": 10.0,
          "basisUsd": 5.0, "realizedUsd": 5.0, "stable": "USDC"}
    # decimals unknown -> render the raw base-unit integer, never guess a scale.
    out = notify_mod.format_realized(ev)
    assert out["title"] == "+$5.00 — sold 150000000 FOO → USDC"


def test_format_proceeds_only_when_basis_unknown():
    ev = {"asset": "SOL", "soldQty": 150000000, "proceedsUsd": 225.0,
          "basisUsd": None, "realizedUsd": None, "stable": "USDC"}
    out = notify_mod.format_realized(ev, decimals=8)
    # no gain claim; subtitle shows the unknown basis honestly as $?
    assert out["title"] == "sold 1.5 SOL → USDC for $225.00"
    assert out["subtitle"] == "$? → $225.00"


def test_fmt_usd_two_decimals_and_thousands():
    assert notify_mod._fmt_usd(42.1) == "$42.10"
    assert notify_mod._fmt_usd(1234.5) == "$1,234.50"
    assert notify_mod._fmt_usd(None) == "$?"


# --------------------------------------------------------------------------- #
# notifier adapters                                                           #
# --------------------------------------------------------------------------- #

def test_recording_notifier_collects():
    n = notify_mod.RecordingNotifier()
    n.notify("hello", "sub", {"x": 1})
    assert n.messages == [{"title": "hello", "subtitle": "sub", "event": {"x": 1}}]


def test_callable_notifier_three_arg():
    seen = []
    n = notify_mod.CallableNotifier(lambda t, s, e: seen.append((t, s, e)))
    n.notify("t", "s", {"k": 1})
    assert seen == [("t", "s", {"k": 1})]


def test_callable_notifier_one_arg_fallback():
    seen = []
    n = notify_mod.CallableNotifier(lambda t: seen.append(t))
    n.notify("just-title", "ignored", {"k": 1})
    assert seen == ["just-title"]


def test_callable_notifier_swallows_errors():
    def boom(*a, **k):
        raise RuntimeError("nope")

    n = notify_mod.CallableNotifier(boom)
    n.notify("t", "s", None)   # must not raise


def test_coerce_accepts_notifier_callable_and_none():
    rec = notify_mod.RecordingNotifier()
    assert notify_mod.coerce(rec) is rec
    assert notify_mod.coerce(None) is None
    c = notify_mod.coerce(lambda *a: None)
    assert isinstance(c, notify_mod.CallableNotifier)


def test_coerce_rejects_non_callable():
    import pytest
    with pytest.raises(ValueError):
        notify_mod.coerce(123)


def test_qt_tray_notifier_headless_is_noop():
    # No tray injected and no Qt runtime -> safe no-op (never crashes a trade).
    n = notify_mod.QtTrayNotifier()
    n.notify("title", "sub", {"x": 1})   # must not raise


def test_qt_tray_notifier_uses_injected_tray():
    class FakeTray:
        def __init__(self):
            self.calls = []

        def showMessage(self, *args):
            self.calls.append(args)

    tray = FakeTray()
    n = notify_mod.QtTrayNotifier(tray=tray)
    n.notify("title", "sub", {"x": 1})
    assert len(tray.calls) == 1
    assert tray.calls[0][0] == "title" and tray.calls[0][1] == "sub"
