"""Smoke + wiring tests for the multi-chain / exchange / agent Qt panels.

Runs headless (offscreen Qt). Verifies the controller derives real addresses
from the sealed HD seed, the agent ctx wiring resolves, the three tabs build,
and the key safety rail holds: a value-moving channel refuses to start without
caps. No network and no real LLM are touched.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


class _StubBlockWallet:
    """Minimal ChainWallet stand-in: snapshot + sign + send + identity."""

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


class MultiChainControllerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self._tmp.name)
        self.wallet = _StubBlockWallet(self.datadir)

    def tearDown(self):
        self._tmp.cleanup()

    def _ctrl(self):
        from blockle.qtmultichain import MultiChainController
        return MultiChainController(self.wallet, self.datadir)

    def test_vault_create_unlock_round_trip(self):
        ctrl = self._ctrl()
        mnemonic = ctrl.create("pw-correct-horse")
        self.assertEqual(len(mnemonic.split()), 12)
        seed1 = ctrl.vault.seed()
        # re-open from disk with a fresh controller
        ctrl2 = self._ctrl()
        self.assertTrue(ctrl2.vault.exists())
        ctrl2.unlock("pw-correct-horse")
        self.assertEqual(ctrl2.vault.seed(), seed1)
        ctrl.loop.stop()
        ctrl2.loop.stop()

    def test_wrong_password_rejected(self):
        from blockle.multichain.vault import WrongPassword
        ctrl = self._ctrl()
        ctrl.create("right-pass")
        ctrl.loop.stop()
        ctrl2 = self._ctrl()
        with self.assertRaises(WrongPassword):
            ctrl2.unlock("wrong-pass")

    def test_controller_derives_addresses_and_ctx_wiring(self):
        ctrl = self._ctrl()
        ctrl.create("pw")
        # every secp256k1 chain derives a concrete address off the one seed
        self.assertTrue(ctrl.accounts["ethereum"].address.startswith("0x"))
        self.assertEqual(ctrl.accounts["ethereum"].scheme, "secp256k1")
        self.assertTrue(ctrl.accounts["bitcoin"].address.startswith("bc1"))
        # BLOCK is the engine identity (post-quantum)
        self.assertEqual(ctrl.accounts["block"].address, "block1stub")
        ctx = ctrl._ctx()
        self.assertEqual(ctx["getAddress"]("ethereum"), ctrl.accounts["ethereum"].address)
        self.assertEqual(ctx["explorerTx"]("ethereum", "0xabc"),
                         "https://etherscan.io/tx/0xabc")
        # the exchange client signs with the BLOCK wallet
        self.assertIs(ctrl.exchange._wallet, self.wallet)
        ctrl.loop.stop()

    def test_tabs_build_offscreen(self):
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")
        # conda envs ship a second Qt that shadows the wheel's offscreen plugin.
        plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
        if plugins.exists():
            os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
        from PySide6.QtWidgets import QApplication
        from blockle.qtmultichain import (AccountsTab, AgentTab, ExchangeTab,
                                          build_tabs)
        QApplication.instance() or QApplication([])
        tabs = build_tabs(self.wallet, self.datadir)
        titles = [t for _w, t in tabs]
        self.assertEqual(titles, ["Accounts", "Exchange", "Agent"])
        widgets = [w for w, _t in tabs]
        self.assertIsInstance(widgets[0], AccountsTab)
        self.assertIsInstance(widgets[1], ExchangeTab)
        self.assertIsInstance(widgets[2], AgentTab)
        # all three share ONE controller
        self.assertIs(widgets[0].ctrl, widgets[2].ctrl)
        widgets[0].ctrl.loop and widgets[0].ctrl.loop.stop() if widgets[0].ctrl.loop else None

    def test_accounts_tab_moonpay_buy_cells(self):
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")
        plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
        if plugins.exists():
            os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
        from PySide6.QtWidgets import QApplication, QPushButton, QLabel
        from blockle.qtmultichain import AccountsTab
        QApplication.instance() or QApplication([])

        ctrl = self._ctrl()
        ctrl.create("pw")
        tab = AccountsTab(ctrl)
        tab._fill_accounts()  # unlocked -> rows + buy cells

        rows = {cid: r for r, cid in enumerate(tab._rows)}
        # BLOCK is not on MoonPay -> a note label, never a button
        block_cell = tab.table.cellWidget(rows["block"], 5)
        self.assertIsInstance(block_cell, QLabel)
        self.assertNotIsInstance(block_cell, QPushButton)
        # a supported chain with a derived address -> a cell holding both a
        # Buy and a Sell button
        eth_cell = tab.table.cellWidget(rows["ethereum"], 5)
        self.assertNotIsInstance(eth_cell, QLabel)
        eth_btns = eth_cell.findChildren(QPushButton)
        self.assertEqual(len(eth_btns), 2)
        self.assertEqual({b.text() for b in eth_btns}, {"Buy…", "Sell…"})
        # supported-asset resolution matches the helper map
        self.assertEqual(tab._supported_assets_for("bitcoin"), [("BTC", "btc")])
        self.assertEqual(tab._supported_assets_for("block"), [])
        ctrl.loop.stop()

    def test_value_moving_channel_refuses_to_start_without_caps(self):
        ctrl = self._ctrl()
        ctrl.create("pw")
        ctrl.vault.set_credential("cref", {"provider": "claude", "apiKey": "sk-ant-x",
                                           "model": "claude-sonnet-4-5"})
        mgr = ctrl.channel_manager(on_event=lambda cid, ev: None)

        async def scenario():
            await mgr.load()
            desc = await mgr.create({"label": "aggressive", "walletId": "regtest",
                                     "provider": "claude", "model": "claude-sonnet-4-5",
                                     "credRef": "cref"})
            # a value-moving channel has default caps auto-applied by the manager
            # (DEFAULT_CAPS sessionUsd=100) — so a brand-new channel CAN start; but
            # one with caps explicitly cleared must refuse.
            cid = desc["id"]
            ch = mgr.get(cid)
            ch.meta["caps"] = {}  # strip caps -> value-moving channel must refuse
            try:
                await mgr.start(cid)
                return "started"
            except ValueError as e:
                return str(e)

        result = asyncio.run(scenario())
        self.assertIn("caps", result)
        ctrl.loop.stop()

    def test_confirm_handler_required_for_value_moving_channel(self):
        ctrl = self._ctrl()
        ctrl.create("pw")
        ctrl.vault.set_credential("cref", {"provider": "claude", "apiKey": "sk-ant-x",
                                           "model": "claude-sonnet-4-5"})
        # build a manager with NO confirm handler -> value-moving start refuses
        import blockle.agent as agentpkg
        mgr = agentpkg.channels.create({
            "store": ctrl._store,
            "resolveCredential": lambda ref, meta: ctrl.vault.get_credential(ref),
            "ctxFor": ctrl._ctx,
        })

        async def scenario():
            await mgr.load()
            desc = await mgr.create({"label": "c", "walletId": "regtest",
                                     "provider": "claude", "credRef": "cref",
                                     "caps": {"sessionUsd": 50}})
            try:
                await mgr.start(desc["id"])
                return "started"
            except ValueError as e:
                return str(e)

        result = asyncio.run(scenario())
        self.assertIn("confirmation handler", result)
        ctrl.loop.stop()


if __name__ == "__main__":
    unittest.main()
