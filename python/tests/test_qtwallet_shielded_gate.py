"""Security-gate tests for the native BLOCK Shielded tab (``qtwallet.WalletWindow``).

The three shielded value-moving handlers (``_do_shield``, ``_do_unshield``,
``_do_zsend``) used to build, sign AND broadcast with NO confirm. They must now
DECODE the operation through the read-only security suite
(``security.inspect_transaction`` -> ``decode_block``) and route it through the
SAME shared confirm sheet (``qtwalletui.SecurityConfirmSheet``) BEFORE the signer
runs ``wallet.shield`` / ``wallet.unshield`` / ``wallet.zsend``:

  * ``shield`` / ``unshield`` move value between the user's OWN pools (no external
    recipient) -> decoded preview + confirm.
  * ``zsend`` has an EXTERNAL, user-typed ``zblockpk`` recipient -> FULL inspection
    with danger-forces-confirm (a denylisted recipient decodes to DANGER).

A reject must abort WITHOUT signing or broadcasting. (The sheet's danger mechanics
are asserted in tests/test_qtwalletui.py against the SAME SecurityConfirmSheet.)

Fully headless: these tests borrow the REAL gate methods onto a plain stand-in
object (never a live QMainWindow / Qt widget), so there is no event loop and
``wallet.*`` are recording stubs — we assert purely on whether the gate let the
call through.
"""

from __future__ import annotations

import os
import types
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from blockle.qtwallet import WalletWindow  # noqa: E402  (PySide6 lazily-guarded)


_DRAIN = "zblockpk1knowndraineraddressxxxxxxxxxxxxxxxxxx"
_CLEAN = "zblockpk1cleanrecipientxxxxxxxxxxxxxxxxxxxxx"


class _StubWin:
    """A plain (non-Qt) object carrying the REAL shielded gate methods, so the
    gate runs exactly as in the window without constructing a live QMainWindow."""

    _block_security_ctx = WalletWindow._block_security_ctx
    _inspect_shielded = WalletWindow._inspect_shielded
    _do_shield = WalletWindow._do_shield
    _do_unshield = WalletWindow._do_unshield
    _do_zsend = WalletWindow._do_zsend


def _stub(mc_tabs=None):
    w = _StubWin()
    w.node = types.SimpleNamespace(running=False, p2p_address=None)
    w._mc_tabs = mc_tabs or []
    w._shielded = []
    w._unshielded = []
    w._zsent = []
    w.wallet = types.SimpleNamespace(
        node=None,
        shield=lambda amt, *a: (w._shielded.append(amt) or {"txid": "shtx"}),
        unshield=lambda note, *a: (w._unshielded.append(note) or {"txid": "untx"}),
        zsend=lambda note, amount, to: (
            w._zsent.append((note, amount, to)) or {"txid": "ztx"}),
    )
    # bypass the QMessageBox + refresh in _guarded; just run the send closure
    w._guarded = lambda fn, msg: fn()
    return w


def _denylist_tab(addr):
    """A fake mc tab whose controller surfaces a denylist, so a shielded recipient
    matching ``addr`` decodes to a DANGER (known drainer)."""
    ctrl = types.SimpleNamespace(_security_config=lambda: {"denylist": [addr]})
    widget = types.SimpleNamespace(ctrl=ctrl)
    return [(widget, "Accounts")]


# --------------------------------------------------------------------------- #
# inspect: the read-only decode runs and surfaces the real severity / amount    #
# --------------------------------------------------------------------------- #
class ShieldedInspectTest(unittest.TestCase):
    def test_zsend_flagged_recipient_is_danger(self):
        """A denylisted EXTERNAL zsend recipient decodes to DANGER (full inspect
        with the recipient-facing checks applied)."""
        w = _stub(_denylist_tab(_DRAIN))
        insp = w._inspect_shielded(to=_DRAIN, amount="5", fee="0.0001", external=True)
        self.assertEqual(insp["chain"], "block")
        self.assertEqual(insp["kind"], "block-send")
        self.assertEqual(insp["severity"], "danger")
        # the preview decoded the REAL amount (5 BLOCK at 8 dp) — never a 0
        self.assertTrue(any("500000000" in str(d.get("value")) for d in insp["details"]))

    def test_shield_ownpool_is_inspected_no_warnings(self):
        """shield moves value into the user's OWN pool — no external recipient —
        so it simply shows no warnings; the gate still RAN (uniform preview) and
        never fabricates a 'safe' claim."""
        w = _stub([])
        insp = w._inspect_shielded(
            to="(your shielded pool)", amount="2", fee="0.0001", external=False)
        self.assertEqual(insp["severity"], "none")
        self.assertEqual(insp["warnings"], [])
        self.assertIn("ran", insp["checks"])

    def test_ownpool_move_is_not_flagged_even_with_denylist(self):
        """An own-pool shield/unshield carries NO external recipient, so a
        populated denylist cannot spuriously flag it (external=False never sets
        ``_recipient``)."""
        w = _stub(_denylist_tab(_DRAIN))
        insp = w._inspect_shielded(
            to="(your transparent address)", amount=None, fee="0.0001", external=False)
        self.assertEqual(insp["severity"], "none")


# --------------------------------------------------------------------------- #
# _do_shield                                                                    #
# --------------------------------------------------------------------------- #
class DoShieldGateTest(unittest.TestCase):
    def _run(self, accepted, amount="2"):
        w = _stub()
        w._inp = iter([(amount, True)])
        # monkeypatch QInputDialog.getText used inside _do_shield
        import blockle.qtwallet as m
        orig = m.QInputDialog.getText
        m.QInputDialog.getText = staticmethod(lambda *a, **k: next(w._inp))
        crit = []
        orig_crit = m.QMessageBox.critical
        m.QMessageBox.critical = staticmethod(lambda *a, **k: crit.append(a))
        w._confirm_security = lambda insp, title: accepted
        try:
            w._do_shield()
        finally:
            m.QInputDialog.getText = orig
            m.QMessageBox.critical = orig_crit
        return w

    def test_reject_aborts_without_shielding(self):
        w = self._run(accepted=False)
        self.assertEqual(w._shielded, [], "a rejected gate must NOT reach wallet.shield")

    def test_accept_reaches_the_signer(self):
        w = self._run(accepted=True)
        self.assertEqual(w._shielded, ["2"])


# --------------------------------------------------------------------------- #
# _do_unshield                                                                  #
# --------------------------------------------------------------------------- #
class DoUnshieldGateTest(unittest.TestCase):
    def _run(self, accepted):
        w = _stub()
        w._selected_note = lambda: 7
        import blockle.qtwallet as m
        orig_crit = m.QMessageBox.critical
        m.QMessageBox.critical = staticmethod(lambda *a, **k: None)
        w._confirm_security = lambda insp, title: accepted
        try:
            w._do_unshield()
        finally:
            m.QMessageBox.critical = orig_crit
        return w

    def test_reject_aborts_without_unshielding(self):
        w = self._run(accepted=False)
        self.assertEqual(w._unshielded, [], "a rejected gate must NOT reach wallet.unshield")

    def test_accept_reaches_the_signer(self):
        w = self._run(accepted=True)
        self.assertEqual(w._unshielded, [7])


# --------------------------------------------------------------------------- #
# _do_zsend                                                                     #
# --------------------------------------------------------------------------- #
class DoZsendGateTest(unittest.TestCase):
    def _run(self, accepted, to, amount, mc_tabs=None):
        w = _stub(mc_tabs)
        w._selected_note = lambda: 3
        import blockle.qtwallet as m
        # getText is called twice: recipient, then amount
        inp = iter([(to, True), (amount, True)])
        orig = m.QInputDialog.getText
        m.QInputDialog.getText = staticmethod(lambda *a, **k: next(inp))
        orig_crit = m.QMessageBox.critical
        m.QMessageBox.critical = staticmethod(lambda *a, **k: None)
        seen = {}

        def _confirm(insp, title):
            seen["severity"] = insp.get("severity")
            seen["before"] = list(w._zsent)   # signer not yet called
            return accepted

        w._confirm_security = _confirm
        try:
            w._do_zsend()
        finally:
            m.QInputDialog.getText = orig
            m.QMessageBox.critical = orig_crit
        w._seen = seen
        return w

    def test_reject_on_flagged_recipient_aborts(self):
        w = self._run(accepted=False, to=_DRAIN, amount="1", mc_tabs=_denylist_tab(_DRAIN))
        self.assertEqual(w._seen["severity"], "danger")
        self.assertEqual(w._seen["before"], [])
        self.assertEqual(w._zsent, [], "a rejected gate must NOT reach wallet.zsend")

    def test_accept_reaches_the_signer(self):
        w = self._run(accepted=True, to=_CLEAN, amount="1")
        self.assertEqual(w._zsent, [(3, "1", _CLEAN)])

    def test_inspect_runs_before_signer(self):
        """Ordering invariant: the read-only inspection is handed to the confirm
        gate BEFORE the signer is ever reached."""
        w = self._run(accepted=True, to=_DRAIN, amount="1", mc_tabs=_denylist_tab(_DRAIN))
        self.assertEqual(w._seen["before"], [])
        self.assertEqual(w._zsent, [(3, "1", _DRAIN)])

    def test_empty_recipient_voucher_still_gated(self):
        """An empty recipient is an out-of-band voucher (no external recipient),
        but it STILL runs the inspect + confirm gate before signing."""
        w = self._run(accepted=False, to="", amount="")
        self.assertEqual(w._zsent, [], "even a voucher zsend must clear the gate first")


if __name__ == "__main__":
    unittest.main()
