"""Smoke test for the FULL multi-chain desktop app window (blockle.qtapp).

The shipped desktop launcher used to import ``blockle.qtwallet.main`` (the legacy
BLOCK-only wallet), so the packaged app had none of the multichain / bots /
wallet / agent / hosted features. These tests verify the launcher now points at
the full app and that the window builds — headless (offscreen Qt) — with the
Accounts / Exchange / Agent / Bots / Wallet tabs present.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


class _StubBlockWallet:
    """Minimal ChainWallet stand-in (same shape the other Qt tests use)."""

    network = "regtest"

    def __init__(self, datadir):
        self.datadir = Path(datadir)

    def snapshot(self):
        return {"wallet": {"address": "block1stub", "balance": "210000", "balance_fmt": "210000"},
                "chain": {"height": 1}}

    def sign_message(self, message):
        return {"signature": "sig", "address": "block1stub"}

    def send(self, to, amount, fee="0.0001"):
        return {"txid": "blocktxid"}


class QtAppWindowTest(unittest.TestCase):
    def setUp(self):
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")
        # conda envs ship a second Qt that shadows the wheel's offscreen plugin.
        plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
        if plugins.exists():
            os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
        from PySide6.QtWidgets import QApplication
        self._app = QApplication.instance() or QApplication([])
        self._tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self._tmp.name)
        self.wallet = _StubBlockWallet(self.datadir)

    def tearDown(self):
        self._tmp.cleanup()

    def test_launcher_points_at_full_app(self):
        import launcher
        from blockle import qtapp
        # launcher must launch the FULL multichain app, not the BLOCK-only wallet.
        self.assertIs(launcher.main, qtapp.main)

    def test_app_window_builds_with_all_tabs(self):
        from blockle.qtapp import build_app_window, tab_titles
        win = build_app_window(self.wallet, self.datadir)
        titles = tab_titles(win)
        # the multichain engine layers are all present...
        for t in ("Accounts", "Exchange", "Agent", "Bots", "Wallet"):
            self.assertIn(t, titles, f"missing tab: {t}")
        # ...and the first three are the core panels, in order.
        self.assertEqual(titles[:3], ["Accounts", "Exchange", "Agent"])

        # the panels share ONE controller (one vault / loop / gate); stop its loop.
        tabw = win.tabs
        ctrl = None
        for i in range(tabw.count()):
            c = getattr(tabw.widget(i), "ctrl", None)
            if c is not None:
                ctrl = c
                break
        self.assertIsNotNone(ctrl, "the panels must share a MultiChainController")
        try:
            ctrl.loop and ctrl.loop.stop()
        except Exception:
            pass

    def test_extra_block_tab_is_prepended(self):
        from PySide6.QtWidgets import QLabel

        from blockle.qtapp import build_app_window, tab_titles
        placeholder = QLabel("block")
        win = build_app_window(self.wallet, self.datadir, extra_tabs=[(placeholder, "BLOCK")])
        titles = tab_titles(win)
        self.assertEqual(titles[0], "BLOCK")
        for t in ("Bots", "Wallet", "Agent"):
            self.assertIn(t, titles)
        tabw = win.tabs
        for i in range(tabw.count()):
            c = getattr(tabw.widget(i), "ctrl", None)
            if c is not None:
                try:
                    c.loop and c.loop.stop()
                except Exception:
                    pass
                break


if __name__ == "__main__":
    unittest.main()
