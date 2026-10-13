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

    def test_vault_auto_import_held_tokens_persists_and_is_idempotent(self):
        """Feature A wallet integration: the auto-import persists newly-held tokens
        into the SAME ``tokens[chain]`` list a manual import writes, MARKS flagged
        ones, dedupes by (chain, contract|mint), and re-running changes nothing."""
        ctrl = self._ctrl()
        ctrl.create("pw")
        discovered = {
            "ethereum": [
                {"chain": "ethereum", "kind": "erc20", "symbol": "USDC", "decimals": 6,
                 "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "isDefault": True, "balance": "1000000"},
                {"chain": "ethereum", "kind": "erc20", "symbol": "DAI", "decimals": 18,
                 "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F", "name": "Dai Stablecoin",
                 "balance": "5000000000000000000"},
                {"chain": "ethereum", "kind": "erc20", "symbol": "EVIL", "decimals": 18,
                 "address": "0xdEAD000000000000000000000000000000000000", "name": "Drainer", "balance": "1000"},
                {"chain": "ethereum", "kind": "erc20", "symbol": "ZERO", "decimals": 18,
                 "address": "0x2222222222222222222222222222222222222222", "balance": "0"},
            ],
        }
        denylist = ["0xdead000000000000000000000000000000000000"]
        summary = ctrl.vault.auto_import_tokens(discovered, denylist=denylist)
        self.assertTrue(summary["changed"])
        eth = ctrl.vault.tokens().get("ethereum") or []
        syms = [t["symbol"] for t in eth]
        self.assertIn("DAI", syms)          # real positive balance imported
        self.assertNotIn("USDC", syms)      # default never re-imported
        self.assertNotIn("ZERO", syms)      # zero balance never fabricated
        self.assertNotIn("EVIL", syms)      # denylisted never imported
        flagged = ctrl.vault.flagged_tokens().get("ethereum") or []
        self.assertEqual([f["reason"] for f in flagged], ["denylist"])
        # idempotent: a second run with the import persisted changes nothing.
        summary2 = ctrl.vault.auto_import_tokens(discovered, denylist=denylist)
        self.assertFalse(summary2["changed"])
        self.assertEqual(len(ctrl.vault.tokens().get("ethereum") or []), len(eth))
        ctrl.loop.stop()

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
        from blockle.qtbots import BotsPanel
        from blockle.qtmultichain import (AccountsTab, AgentTab, ExchangeTab,
                                          build_tabs)
        QApplication.instance() or QApplication([])
        tabs = build_tabs(self.wallet, self.datadir)
        titles = [t for _w, t in tabs]
        # the native Bots cockpit + Wallet surfaces are appended after
        # Accounts/Exchange/Agent (each additive, guarded).
        self.assertEqual(titles, ["Accounts", "Exchange", "Agent", "Bots", "Wallet"])
        widgets = [w for w, _t in tabs]
        self.assertIsInstance(widgets[0], AccountsTab)
        self.assertIsInstance(widgets[1], ExchangeTab)
        self.assertIsInstance(widgets[2], AgentTab)
        self.assertIsInstance(widgets[3], BotsPanel)
        # all four share ONE controller
        self.assertIs(widgets[0].ctrl, widgets[2].ctrl)
        self.assertIs(widgets[0].ctrl, widgets[3].ctrl)
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


class SendDialogSecurityGateTest(unittest.TestCase):
    """The Accounts-tab per-chain Send dialog (``SendDialog``) must route the
    built tx through ``security.inspect_transaction`` + the shared confirm sheet
    BEFORE the existing adapter broadcasts: a DANGER forces the explicit confirm,
    a reject aborts WITHOUT signing. (Formerly: only a plain QMessageBox.)"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self._tmp.name)
        self.wallet = _StubBlockWallet(self.datadir)

    def tearDown(self):
        self._tmp.cleanup()

    def _dialog(self):
        from PySide6.QtWidgets import QApplication
        from blockle.qtmultichain import MultiChainController, SendDialog
        QApplication.instance() or QApplication([])
        ctrl = MultiChainController(self.wallet, self.datadir)
        ctrl.create("pw")
        dlg = SendDialog(ctrl, ["ethereum"])
        return ctrl, dlg

    def test_inspection_tx_runs_inspect_and_flags_danger(self):
        """The dialog builds a WELL-FORMED tx (real recipient + amount) and the
        inspection flags a denylisted recipient as DANGER."""
        from blockle.multichain import security as sec
        drain = "0x000000000000000000000000000000000000dEaD"
        ctrl, dlg = self._dialog()
        dlg.to.setText(drain)
        dlg.amount.setText("1000000000000000000")   # 1 ETH, base units
        tx = dlg._inspection_tx("ethereum")
        self.assertEqual(sec.norm(tx["to"]), sec.norm(drain))
        self.assertEqual(tx["value"], "1000000000000000000")
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {"denylist": [drain]}}))
        self.assertEqual(insp["severity"], "danger")
        ctrl.loop.stop()

    def test_gate_blocks_on_reject_and_allows_on_accept(self):
        """A rejected confirm sheet never reaches the adapter broadcast; an
        accepted one does — exercised on a real DANGER inspection."""
        from PySide6.QtWidgets import QDialog
        from blockle import qtwalletui as w
        from blockle.multichain import security as sec
        drain = "0x000000000000000000000000000000000000dEaD"
        ctrl, dlg = self._dialog()
        dlg.to.setText(drain)
        dlg.amount.setText("1000000000000000000")
        tx = dlg._inspection_tx("ethereum")
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {"denylist": [drain]}}))
        self.assertEqual(insp["severity"], "danger")

        reached = []
        dlg._really_broadcast = lambda: reached.append(True)
        orig_exec = w.SecurityConfirmSheet.exec
        try:
            w.SecurityConfirmSheet.exec = lambda self: QDialog.Rejected
            dlg._on_inspected(insp)
            self.assertEqual(reached, [], "reject must NOT reach the signer")

            w.SecurityConfirmSheet.exec = lambda self: QDialog.Accepted
            dlg._on_inspected(insp)
            self.assertEqual(reached, [True], "accept must reach the signer")
        finally:
            w.SecurityConfirmSheet.exec = orig_exec
        ctrl.loop.stop()


class ExportSecretsGateTest(unittest.TestCase):
    """The Accounts-tab Export action must run ``multichain.export.export_secrets``
    BEHIND its own security gate: locked => nothing; unlocked but declined =>
    nothing; unlocked + an explicit confirm (surfacing the plain-language danger
    warning) => mnemonic + seed + per-chain keys + the BTC/LTC/DOGE Core dumps.
    The UI only CALLS the module — the gate + assembly stay in the module."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self._tmp.name)
        self.wallet = _StubBlockWallet(self.datadir)

    def tearDown(self):
        self._tmp.cleanup()

    def _ctrl(self):
        from blockle.qtmultichain import MultiChainController
        return MultiChainController(self.wallet, self.datadir)

    def test_controller_export_runs_module_through_gate(self):
        """Delegates to the real module: a confirm handler is called with the
        module's DANGER_WARNING; a Yes yields every key type + the Core dumps;
        a No yields a declined block (never a secret); locked is refused."""
        from blockle.multichain import export as export_mod
        ctrl = self._ctrl()
        ctrl.create("pw")

        # locked (fresh controller, never unlocked) — refused, no secret
        locked_ctrl = self._ctrl()
        res_locked = locked_ctrl.export_secrets(confirm=lambda w: True)
        self.assertFalse(res_locked["ok"])
        self.assertEqual(res_locked["reason"], "locked")
        self.assertNotIn("mnemonic", res_locked)
        self.assertNotIn("keys", res_locked)

        # unlocked + decline — the gate blocks, still no secret
        seen = []
        res_declined = ctrl.export_secrets(
            confirm=lambda warning: seen.append(warning) or False)
        self.assertFalse(res_declined["ok"])
        self.assertEqual(res_declined["reason"], "declined")
        self.assertNotIn("keys", res_declined)
        # the gate surfaced the module's plain-language danger warning
        self.assertEqual(seen, [export_mod.DANGER_WARNING])

        # unlocked + confirm — full export, matching the sealed seed
        res = ctrl.export_secrets(confirm=lambda warning: True)
        self.assertTrue(res["ok"])
        self.assertEqual(res["mnemonic"]["mnemonic"], ctrl.vault.mnemonic())
        self.assertEqual(res["keys"]["bitcoin"]["address"],
                         ctrl.accounts["bitcoin"].address)
        self.assertTrue(res["keys"]["evm"]["privateKey"].startswith("0x"))
        self.assertIn("secretKey", res["keys"]["solana"])
        # the BTC/LTC/DOGE importwallet dumps are present + Core-shaped
        self.assertEqual(set(res["dumps"]), {"bitcoin", "litecoin", "dogecoin"})
        self.assertTrue(res["dumps"]["bitcoin"]["text"]
                        .startswith("# Wallet dump created by Blockle"))
        self.assertEqual(res["dumps"]["dogecoin"]["filename"],
                         "dogecoin-blockle-import.txt")
        ctrl.loop.stop()
        locked_ctrl.loop and locked_ctrl.loop.stop()

    def test_export_button_reachable_and_calls_module_through_gate(self):
        """The Accounts tab exposes an Export action, gated: disabled while
        locked, enabled after unlock, and clicking it drives the real module
        export through the modal confirm (Yes => the exported bundle reaches the
        display; Cancel => nothing is shown, nothing leaks)."""
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")
        from unittest.mock import patch
        plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
        if plugins.exists():
            os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
        from PySide6.QtWidgets import QApplication, QMessageBox
        from blockle.qtmultichain import AccountsTab
        QApplication.instance() or QApplication([])

        ctrl = self._ctrl()
        ctrl.create("pw")
        tab = AccountsTab(ctrl)
        # the action exists and is gated on unlock (disabled before, enabled after)
        self.assertFalse(tab.export_btn.isEnabled())
        tab._on_unlocked()
        self.assertTrue(tab.export_btn.isEnabled())

        shown = []
        tab._show_export = lambda res: shown.append(res)  # don't block on a modal

        # Cancel at the gate -> export runs, declines, nothing displayed
        with patch.object(QMessageBox, "exec", return_value=QMessageBox.Cancel):
            tab._export_secrets()
        self.assertEqual(shown, [])

        # Yes at the gate -> the real module export reaches the display bundle
        with patch.object(QMessageBox, "exec", return_value=QMessageBox.Yes):
            tab._export_secrets()
        self.assertEqual(len(shown), 1)
        self.assertTrue(shown[0]["ok"])
        self.assertIn("mnemonic", shown[0])
        self.assertEqual(set(shown[0]["dumps"]), {"bitcoin", "litecoin", "dogecoin"})
        # and the rendered text carries the phrase + a per-chain key line
        text = tab._render_export_text(shown[0])
        self.assertIn(ctrl.vault.mnemonic(), text)
        self.assertIn("[bitcoin]", text)
        ctrl.loop.stop()


if __name__ == "__main__":
    unittest.main()
