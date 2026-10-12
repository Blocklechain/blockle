"""Security-gate tests for the native BLOCK Send tab (``qtwallet.WalletWindow``).

The BLOCK Send tab (``_do_send``) used to call ``wallet.send`` after only a plain
``QMessageBox.question``. It must now DECODE the transfer through the read-only
security suite (``security.inspect_transaction`` -> ``decode_block``) and route it
through the SAME shared confirm sheet the multi-chain Send flow uses, BEFORE the
BLOCK signer sends: a DANGER forces the explicit "I understand the risk" confirm;
a reject aborts WITHOUT signing. (The sheet's danger mechanics themselves are
asserted in tests/test_qtwalletui.py against the SAME SecurityConfirmSheet.)

Fully headless: these tests borrow the REAL gate methods onto a plain stand-in
object (never a live QMainWindow / Qt widget), so there is no event loop and
``wallet.send`` is a recording stub — we assert purely on whether the gate let the
call through.
"""

from __future__ import annotations

import os
import types
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from blockle.qtwallet import WalletWindow  # noqa: E402  (imports PySide6 lazily-guarded)


class _Line:
    """Minimal QLineEdit stand-in: ``text`` / ``setText`` / ``clear``."""

    def __init__(self, text=""):
        self._t = text

    def text(self):
        return self._t

    def setText(self, t):
        self._t = t

    def clear(self):
        self._t = ""


class _StubWin:
    """A plain (non-Qt) object carrying the REAL BLOCK send-gate methods, so the
    gate runs exactly as in the window without constructing a live QMainWindow."""

    _block_security_ctx = WalletWindow._block_security_ctx
    _inspect_block_send = WalletWindow._inspect_block_send
    _do_send = WalletWindow._do_send


_DRAIN = "block1knowndraineraddressxxxxxxxxxxxxxxxxxx"


def _stub(mc_tabs):
    w = _StubWin()
    w.send_to = _Line(_DRAIN)
    w.send_amount = _Line("10")
    w.send_fee = _Line("0.0001")
    w.node = types.SimpleNamespace(running=False, p2p_address=None)
    w._mc_tabs = mc_tabs
    w._sent = []
    w.wallet = types.SimpleNamespace(
        node=None, send=lambda to, amt, fee: (w._sent.append((to, amt, fee)) or {"txid": "blktx"}))
    # bypass the QMessageBox + refresh in _guarded; just run the send closure
    w._guarded = lambda fn, msg: fn()
    return w


def _denylist_tab(addr):
    """A fake mc tab whose controller surfaces a denylist, so the BLOCK security
    ctx flags ``addr`` as a known drainer (DANGER)."""
    ctrl = types.SimpleNamespace(_security_config=lambda: {"denylist": [addr]})
    widget = types.SimpleNamespace(ctrl=ctrl)
    return [(widget, "Accounts")]


class BlockSendGateTest(unittest.TestCase):
    def test_inspect_block_send_runs_decode_and_flags_danger(self):
        """The formerly-ungated BLOCK send path now RUNS inspect_transaction and
        a denylisted recipient decodes to a DANGER severity."""
        w = _stub(_denylist_tab(_DRAIN))
        insp = w._inspect_block_send(_DRAIN, "10", "0.0001")
        self.assertEqual(insp["chain"], "block")
        self.assertEqual(insp["kind"], "block-send")
        self.assertEqual(insp["severity"], "danger")
        # the preview decoded the REAL amount (10 BLOCK at 8 dp) — never a 0
        self.assertTrue(any("1000000000" in str(d.get("value")) for d in insp["details"]))

    def test_clean_recipient_has_no_warnings_but_still_inspected(self):
        """A non-denylisted recipient simply shows no warnings — the gate still
        ran (uniform preview); it does NOT fabricate a 'safe' claim."""
        w = _stub([])   # no mc controller -> empty config
        insp = w._inspect_block_send("block1cleanrecipientxxxxxxxxxxxxxxx", "1", "0.0001")
        self.assertEqual(insp["severity"], "none")
        self.assertEqual(insp["warnings"], [])
        self.assertIn("ran", insp["checks"])

    def test_reject_aborts_without_signing(self):
        """A rejected confirm sheet must abort the BLOCK send WITHOUT calling the
        signer, and must leave the inputs intact so the user can amend."""
        w = _stub(_denylist_tab(_DRAIN))
        w._confirm_block_send = lambda insp: False   # user rejected the danger sheet
        w._do_send()
        self.assertEqual(w._sent, [], "a rejected gate must NOT reach wallet.send")
        self.assertEqual(w.send_to.text(), _DRAIN)

    def test_accept_reaches_the_signer(self):
        """An accepted confirm sheet lets the EXISTING BLOCK signer send."""
        w = _stub(_denylist_tab(_DRAIN))
        w._confirm_block_send = lambda insp: True
        w._do_send()
        self.assertEqual(w._sent, [(_DRAIN, "10", "0.0001")])

    def test_inspect_runs_before_confirm_and_signer(self):
        """Ordering invariant: the read-only inspection is computed and handed to
        the confirm gate BEFORE the signer is ever reached."""
        w = _stub(_denylist_tab(_DRAIN))
        seen = {}

        def _confirm(insp):
            seen["severity"] = insp.get("severity")
            seen["before_send"] = list(w._sent)   # signer not yet called
            return False

        w._confirm_block_send = _confirm
        w._do_send()
        self.assertEqual(seen["severity"], "danger")
        self.assertEqual(seen["before_send"], [])
        self.assertEqual(w._sent, [])


if __name__ == "__main__":
    unittest.main()
