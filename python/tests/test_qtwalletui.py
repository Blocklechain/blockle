"""Smoke + wiring tests for the native Blockle Wallet Qt surfaces
(``blockle.qtwalletui``).

Run headless (offscreen Qt). Asserts the five surfaces are driven by the REAL
engine modules — the portfolio hero/by-chain/holdings come out of
``multichain.portfolio``, activity out of ``multichain.activity``, the security
confirm sheet is rendered from a real ``security.inspect_transaction`` Inspection
(and a DANGER forces the explicit "I understand the risk" confirm), the send flow
resolves a name via ``multichain.addressbook`` and inspects the RESOLVED address,
and the Connect panel routes a WalletConnect request through the per-request
approval + danger-confirm gate — marshalled onto the GUI thread via the queued
signal bridge (never a worker-thread widget touch). No network, no real LLM.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

_REPO = Path(__file__).resolve().parents[2]
_MNEMONIC = "test test test test test test test test test test test junk"


def _qt_app():
    import PySide6  # noqa: F401
    plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
    if plugins.exists():
        os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
    from PySide6.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


class _StubBlockWallet:
    network = "regtest"

    def __init__(self, datadir):
        self.datadir = Path(datadir)

    def snapshot(self):
        return {"wallet": {"address": "block1stub", "publicKey": "pk"},
                "chain": {"height": 1}}

    def sign_message(self, message):
        return {"signature": "sig", "address": "block1stub"}

    def send(self, to, amount, fee="0.0001"):
        return {"txid": "blocktxid"}


# ===========================================================================
# pure (no Qt runtime) — tokens + qss + helpers + design-reference parity
# ===========================================================================
class PureTest(unittest.TestCase):
    def test_module_imports(self):
        import blockle.qtwalletui as w
        for name in ("WalletPanel", "WalletController", "build_wallet_tab",
                     "PortfolioPanel", "ActivityPanel", "NftPanel", "ConnectPanel",
                     "AddressBookPanel", "SecurityConfirmSheet", "SendSheet",
                     "ProposalReviewSheet"):
            self.assertTrue(hasattr(w, name), name)

    def test_tokens_and_qss(self):
        import blockle.qtwalletui as w
        for tok in (w.TOKENS_DARK, w.TOKENS_LIGHT):
            for key in ("ground", "surface", "ink", "accent", "gain", "loss",
                        "warn", "k_a", "k_b", "k_c", "k_d"):
                self.assertIn(key, tok)
            qss = w.build_qss(tok)
            self.assertIn("#walletRoot", qss)
            self.assertIn(tok["accent"], qss)

    def test_tokens_match_design_reference(self):
        """The ported ramp must equal docs/design/wallet/index.html :root — the
        SAME core ramp as the Bots panel (one product, one look)."""
        import blockle.qtbots as qb
        import blockle.qtwalletui as w
        # core ramp identical across the two native panels
        for key in ("accent", "gain", "loss"):
            self.assertEqual(w.TOKENS_DARK[key], qb.TOKENS_DARK[key])
            self.assertEqual(w.TOKENS_LIGHT[key], qb.TOKENS_LIGHT[key])
        # categorical hues from the design reference :root
        self.assertEqual(w.TOKENS_DARK["k_a"], "#4c8dff")
        self.assertEqual(w.TOKENS_DARK["k_b"], "#f0a732")
        self.assertEqual(w.TOKENS_DARK["k_c"], "#2fd39b")
        self.assertEqual(w.TOKENS_DARK["k_d"], "#b98cff")
        self.assertEqual(w.TOKENS_LIGHT["k_d"], "#8257d6")

    def test_amount_formatter(self):
        import blockle.qtwalletui as w
        self.assertEqual(w._amt_str("1500000000000000000", 18), "1.5")
        self.assertEqual(w._amt_str("2305", 0), "2,305")
        self.assertEqual(w.shorten("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
                         "0xd8dA6B…6045")


# ===========================================================================
# the shared SECURITY CONFIRM SHEET — rendered from a REAL Inspection
# ===========================================================================
class ConfirmSheetTest(unittest.TestCase):
    def setUp(self):
        _qt_app()

    def test_clean_inspection_no_extra_confirm(self):
        from blockle.multichain import security as sec
        from blockle.qtwalletui import SecurityConfirmSheet, TOKENS_DARK
        tx = {"chain": "ethereum", "to": "0x1111111111111111111111111111111111111111",
              "value": "1000000000000000000",
              "asset": {"chain": "ethereum", "kind": "native", "symbol": "ETH", "decimals": 18}}
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {}}))
        self.assertEqual(insp["severity"], "none")
        sheet = SecurityConfirmSheet(TOKENS_DARK, insp)
        self.assertFalse(sheet._is_danger)
        self.assertTrue(sheet.ok.isEnabled())           # clean -> approve enabled
        # the transparency "N checks ran" line is present and never claims safe
        line = sheet._checks_line().text().lower()
        self.assertIn("checks ran", line)
        self.assertIn("nothing", line)
        self.assertIn("safe", line)

    def test_danger_forces_explicit_confirm(self):
        from blockle.multichain import security as sec
        from blockle.qtwalletui import SecurityConfirmSheet, TOKENS_DARK
        drain = "0x000000000000000000000000000000000000dEaD"
        tx = {"chain": "ethereum", "to": drain, "value": "1000000000000000000",
              "asset": {"chain": "ethereum", "kind": "native", "symbol": "ETH", "decimals": 18}}
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {"denylist": [drain]}}))
        self.assertEqual(insp["severity"], "danger")
        sheet = SecurityConfirmSheet(TOKENS_DARK, insp)
        self.assertTrue(sheet._is_danger)
        self.assertFalse(sheet.ok.isEnabled())          # DANGER: approve disabled...
        sheet._confirm_box.setChecked(True)             # ...until the explicit ack
        self.assertTrue(sheet.ok.isEnabled())


# ===========================================================================
# PANELS — locked empty state, unlocked wiring, the send-flow resolution,
# and the WalletConnect GUI-thread approval bridge
# ===========================================================================
class PanelTest(unittest.TestCase):
    def setUp(self):
        _qt_app()
        self._tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self._tmp.name)
        self.wallet = _StubBlockWallet(self.datadir)

    def tearDown(self):
        try:
            from blockle.qtmultichain import MultiChainController  # noqa: F401
        finally:
            self._tmp.cleanup()

    def _drain(self, pred=None, limit=400):
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        for _ in range(limit):
            app.processEvents()
            if pred and pred():
                return
            time.sleep(0.003)

    def _ctrl(self, unlocked=False):
        from blockle.qtmultichain import MultiChainController
        ctrl = MultiChainController(self.wallet, self.datadir)
        if unlocked:
            ctrl.create("pw", _MNEMONIC)
        return ctrl

    # ---- build / integration ------------------------------------------------
    def test_build_tabs_includes_wallet(self):
        from blockle.qtmultichain import build_tabs
        from blockle.qtwalletui import WalletPanel
        tabs = build_tabs(self.wallet, self.datadir)
        titles = [t for _w, t in tabs]
        self.assertIn("Wallet", titles)
        wp = [w for w, t in tabs if t == "Wallet"][0]
        self.assertIsInstance(wp, WalletPanel)
        # shares the SAME controller as the Accounts tab (one vault, one loop)
        self.assertIs(wp.ctrl, tabs[0][0].ctrl)
        tabs[0][0].ctrl.loop and tabs[0][0].ctrl.loop.stop()

    def test_surfaces_build(self):
        from blockle.qtwalletui import WalletPanel
        wp = WalletPanel(self._ctrl())
        self.assertEqual([wp.tabs.tabText(i) for i in range(wp.tabs.count())],
                         ["Portfolio", "Activity", "NFTs", "Mining", "Connect", "Address book"])
        wp.ctrl.loop and wp.ctrl.loop.stop()

    def test_locked_state_is_honest_empty_no_fake_data(self):
        from blockle.qtwalletui import WalletPanel
        wp = WalletPanel(self._ctrl())
        for p in (wp.portfolio, wp.activity, wp.nfts, wp.connect, wp.book):
            p.refresh()
        self._drain(limit=60)
        self.assertEqual(wp.portfolio.big.text(), "—")   # no fabricated net worth
        self.assertEqual(wp.acct_chip.text(), "locked")
        wp.ctrl.loop and wp.ctrl.loop.stop()

    def test_theme_toggle_light_dark(self):
        import blockle.qtwalletui as w
        wp = w.WalletPanel(self._ctrl())
        self.assertEqual(wp.theme, "dark")
        self.assertIs(wp.tok, w.TOKENS_DARK)
        wp._toggle_theme()
        self.assertEqual(wp.theme, "light")
        self.assertIs(wp.tok, w.TOKENS_LIGHT)
        wp.ctrl.loop and wp.ctrl.loop.stop()

    # ---- unlocked wiring: real derived addresses feed the engines -----------
    def test_unlocked_accounts_feed_the_engines(self):
        from blockle.qtwalletui import WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        self.assertTrue(wc.ready())
        accts = wc.accounts_list()
        chains = {a["chain"] for a in accts}
        self.assertIn("ethereum", chains)
        # the portfolio ctx exposes the REAL balance adapter + a price callable
        pctx = wc.portfolio_ctx()
        self.assertTrue(callable(pctx["getBalance"]))
        self.assertTrue(callable(pctx["priceUsd"]))
        ctrl.loop and ctrl.loop.stop()

    def test_portfolio_render_from_real_engine(self):
        """PortfolioPanel._apply renders a real ``portfolio()`` result: hero total,
        by-chain rows, holdings count, and unpriced shown-not-counted."""
        from blockle.multichain import portfolio as pf
        from blockle.qtwalletui import PortfolioPanel, TOKENS_DARK, WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        accts = [{"chain": "ethereum", "address": "0xabc"},
                 {"chain": "solana", "address": "soladdr"}]
        # a deterministic injected ctx (the MOCK lives in the TEST, not the UI):
        # one priced ETH holding + one unpriced token.
        async def get_balance(chain, address=None):
            if chain == "ethereum":
                return [{"asset": {"chain": "ethereum", "symbol": "ETH", "decimals": 18},
                         "confirmed": "2000000000000000000"}]
            return [{"asset": {"chain": "solana", "symbol": "MYST", "decimals": 0},
                     "confirmed": "15000"}]
        ctx = {"getBalance": get_balance, "priceUsd": {"ETH": 3000}, "asOf": 1}
        result = asyncio.run(pf.portfolio(accts, ctx))
        spark = pf.sparkline(
            pf.record_snapshot([], {"ts": 1, "totalUsdMicro": result["totalUsdMicro"]}), 30)
        panel = PortfolioPanel(wc, TOKENS_DARK)
        panel._apply({"pf": result, "spark": spark})
        self.assertIn("6,000", panel.big.text())            # 2 ETH * $3000, priced
        self.assertEqual(len(result["unpriced"]), 1)        # MYST shown, not counted
        self.assertEqual(result["byChain"][0]["chain"], "ethereum")
        ctrl.loop and ctrl.loop.stop()

    def test_holding_rows_call_the_logos_resolver(self):
        """Every holdings row paints its icon through the shared
        ``multichain.logos`` resolver (native brand SVG / token logoURI / colored
        monogram), passing the row's chain + symbol + contract — never a hard-coded
        or broken icon."""
        from unittest.mock import patch
        import blockle.qtwalletui as w
        from blockle.qtwalletui import PortfolioPanel, TOKENS_DARK, WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        panel = PortfolioPanel(wc, TOKENS_DARK)
        holdings = [
            {"chain": "ethereum", "symbol": "ETH", "amountBase": "1", "decimals": 18},
            {"chain": "ethereum", "symbol": "USDC", "kind": "erc20", "decimals": 6,
             "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"},
        ]
        with patch.object(w.logos_mod, "resolve", wraps=w.logos_mod.resolve) as rv:
            panel._render_holdings(holdings)
        self.assertGreaterEqual(rv.call_count, 2)
        assets = [c.args[0] for c in rv.call_args_list]
        self.assertEqual(assets[0]["chain"], "ethereum")
        self.assertEqual(assets[0]["symbol"], "ETH")
        usdc = next(a for a in assets if a["symbol"] == "USDC")
        self.assertEqual(usdc["address"],
                         "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
        ctrl.loop and ctrl.loop.stop()

    # ---- the deferred SEND-FLOW name resolution ------------------------------
    def test_send_flow_resolves_name_then_inspects_resolved_address(self):
        from blockle.multichain import addressbook as ab
        from blockle.multichain import security as sec
        from blockle.qtwalletui import WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        eth_addr = next(a["address"] for a in wc.accounts_list() if a["chain"] == "ethereum")
        # save a labeled contact, then resolve by label + inspect the RESOLVED addr
        fut = wc.loop.submit(wc.book().add({"label": "savings", "address": eth_addr,
                                            "chain": "ethereum"}))
        fut.result(5)

        async def flow():
            book = await wc.book().list()
            resolved = await ab.resolve_name("savings", "ethereum", wc.resolve_ctx(book))
            tx = {"chain": "ethereum", "to": resolved["address"], "value": "0",
                  "asset": wc.native_asset("ethereum")}
            insp = await sec.inspect_transaction(tx, wc.security_ctx())
            return resolved, insp
        resolved, insp = wc.loop.submit(flow()).result(5)
        self.assertEqual(resolved["source"], "book")        # resolved via the book
        self.assertEqual(resolved["address"], eth_addr)     # the RESOLVED address
        self.assertEqual(insp["chain"], "ethereum")         # inspected the resolved addr
        self.assertIn("checks", insp)
        ctrl.loop and ctrl.loop.stop()

    def test_send_flow_rejects_unresolvable_name(self):
        from blockle.multichain import addressbook as ab
        from blockle.qtwalletui import WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)

        async def flow():
            # a .eth name with no injected resolver resolves to None — never guessed
            return await ab.resolve_name("nobody.eth", "ethereum", wc.resolve_ctx([]))
        self.assertIsNone(wc.loop.submit(flow()).result(5))
        ctrl.loop and ctrl.loop.stop()

    # ---- WalletConnect: per-request approval through the GUI-thread bridge ----
    def test_walletconnect_request_routes_through_gui_approval_bridge(self):
        """handle_request runs on the worker loop; its approve callback emits a
        QUEUED signal that the GUI thread answers via the sheet. A declined
        approval returns the user-rejected error — exercising the full bridge +
        gate without a network broadcast."""
        from blockle.multichain import walletconnect as WC
        from blockle.qtwalletui import WalletController
        vec = json.loads((_REPO / "docs" / "walletconnect-vectors.json").read_text())
        ctrl = self._ctrl(unlocked=True)
        wcc = WalletController(ctrl)
        core = wcc.wallet_connect()
        # settle the shared session into the REAL (controller) store
        wcc.loop.submit(core.approve_proposal(
            vec["approval"]["intersection"]["proposal"],
            {"accounts": vec["approval"]["intersection"]["accounts"]})).result(5)

        captured = {}

        def on_approval(presentation, resolver):
            # runs ON THE GUI THREAD (queued) — safe to touch widgets here.
            captured["presentation"] = presentation
            resolver(False)          # user declines -> 4001, no signing, no network
        wcc.approval_requested.connect(on_approval)

        req = vec["requests"]["eth_sendTransaction-clean-approved"]["request"]
        fut = wcc.loop.submit(core.handle_request(req, wcc.wc_request_ctx()))
        self._drain(pred=lambda: fut.done(), limit=400)
        resp = fut.result(5)
        self.assertEqual(resp.get("error", {}).get("code"), WC.ERR["USER_REJECTED"])
        self.assertIn("presentation", captured)              # the sheet was driven
        self.assertEqual(captured["presentation"]["method"], "eth_sendTransaction")
        ctrl.loop and ctrl.loop.stop()

    def test_proposal_review_sheet_surfaces_untrusted_metadata(self):
        from blockle.multichain import walletconnect as WC
        from blockle.qtwalletui import ProposalReviewSheet, TOKENS_DARK
        vec = json.loads((_REPO / "docs" / "walletconnect-vectors.json").read_text())
        core = WC.create_wallet_connect({"config": vec["config"], "now": lambda: vec["nowMs"]})
        review = core.review_proposal(
            vec["proposalReview"]["surfaces-metadata-and-warnings"]["proposal"])
        sheet = ProposalReviewSheet(TOKENS_DARK, review)   # builds without error
        self.assertIsNotNone(sheet)

    # ---- FIX-M: the preview shows the REAL amount (not a misleading 0) --------
    def test_send_tx_native_amount_is_in_value_not_zero(self):
        """A native send puts the REAL base-unit amount in tx['value'] so
        inspect_transaction decodes the true amount (regression: it used to be
        value='0' with the amount only in displayAmount -> preview showed 0)."""
        from blockle.multichain import security as sec
        from blockle.qtwalletui import WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        to = "0x1111111111111111111111111111111111111111"
        tx = wc.build_inspection_tx("ethereum", to, "1.5")   # 1.5 ETH, 18 decimals
        self.assertEqual(tx["value"], "1500000000000000000")  # real base units
        self.assertNotEqual(tx["value"], "0")
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {}}))
        self.assertEqual(insp["kind"], "native-transfer")
        amount = next(d["value"] for d in insp["details"] if d["label"] == "Amount")
        self.assertEqual(amount, "1500000000000000000")      # preview = REAL amount
        self.assertIn("1.5", insp["summary"])
        ctrl.loop and ctrl.loop.stop()

    def test_send_tx_token_builds_erc20_calldata_decoding_true_amount(self):
        """A token send builds ERC-20 transfer calldata (reusing the evm adapter)
        so inspect_transaction decodes the true recipient + amount from calldata."""
        from blockle.multichain import security as sec
        from blockle.qtwalletui import WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        usdc = {"chain": "ethereum", "kind": "erc20", "symbol": "USDC", "decimals": 6,
                "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"}
        to = "0x2222222222222222222222222222222222222222"
        tx = wc.build_inspection_tx("ethereum", to, "12.5", asset=usdc)  # 12.5 USDC
        self.assertEqual(tx["to"], usdc["address"])          # tx goes to the token
        self.assertTrue(tx["data"].startswith("0xa9059cbb"))  # transfer(address,uint256)
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {}}))
        self.assertEqual(insp["kind"], "token-transfer")
        amount = next(d["value"] for d in insp["details"] if d["label"] == "Amount")
        self.assertEqual(amount, "12500000")                 # 12.5 * 10**6, from calldata
        recipient = next(d["value"] for d in insp["details"] if d["label"] == "To")
        self.assertEqual(recipient.lower(), to.lower())      # true recipient decoded
        ctrl.loop and ctrl.loop.stop()

    def test_base_units_parser_is_exact(self):
        from blockle.qtwalletui import to_base_units
        self.assertEqual(to_base_units("1.5", 18), 1500000000000000000)
        self.assertEqual(to_base_units("2,305", 0), 2305)
        self.assertEqual(to_base_units("0.000001", 6), 1)
        self.assertEqual(to_base_units("", 18), 0)
        with self.assertRaises(ValueError):
            to_base_units("abc", 18)

    # ---- FIX-L: an approved send reaches the EXISTING signer/broadcast --------
    def test_perform_send_routes_through_existing_signer_broadcast(self):
        """perform_send uses the SAME adapter build_send -> broadcast path the
        Accounts Send dialog + agent/send flow use (spied here; no network)."""
        from blockle.qtwalletui import WalletController
        ctrl = self._ctrl(unlocked=True)
        wc = WalletController(ctrl)
        adapter = ctrl.registry.get("ethereum")
        calls = {}

        class _Built:
            chain, raw, txid, fee = "ethereum", "0xraw", "0xbuilt", "21000"

        class _Res:
            txid, accepted = "0xsent", True

        def fake_build_send(acct, req):
            calls["build"] = req
            return _Built()

        def fake_broadcast(built):
            calls["broadcast"] = built
            return _Res()
        adapter.build_send = fake_build_send
        adapter.broadcast = fake_broadcast
        to = "0x3333333333333333333333333333333333333333"
        res = wc.loop.submit(wc.perform_send("ethereum", to, 1500000000000000000)).result(5)
        self.assertEqual(res["txid"], "0xsent")              # broadcast reached
        self.assertEqual(calls["build"]["to"], to)
        self.assertEqual(calls["build"]["amount"], "1500000000000000000")
        self.assertIsNone(calls["build"]["asset"])           # native send
        self.assertIsInstance(calls.get("broadcast"), _Built)
        ctrl.loop and ctrl.loop.stop()

    def test_approved_send_reaches_signer_declined_does_not(self):
        """The invariant: the UI signs/broadcasts ONLY through the existing
        signer AFTER the security gate clears. An approved confirm hands the tx
        to perform_send; a declined confirm never does."""
        from PySide6.QtWidgets import QDialog, QMessageBox
        from blockle.multichain import security as sec
        import blockle.qtwalletui as w
        ctrl = self._ctrl(unlocked=True)
        wc = w.WalletController(ctrl)
        eth_addr = next(a["address"] for a in wc.accounts_list() if a["chain"] == "ethereum")
        sheet = w.SendSheet(wc, w.TOKENS_DARK)

        sent = []

        async def fake_perform(chain, to, amount_base, asset=None):
            sent.append((chain, to, amount_base))
            return {"txid": "0xok"}
        wc.perform_send = fake_perform

        tx = wc.build_inspection_tx("ethereum", eth_addr, "1.5")
        insp = asyncio.run(sec.inspect_transaction(tx, {"config": {}}))
        out = {"resolved": {"address": eth_addr, "source": "book", "name": "savings"},
               "inspection": insp, "chain": "ethereum", "to": eth_addr,
               "amountBase": tx["_amountBase"]}

        orig_exec = w.SecurityConfirmSheet.exec
        orig_info = QMessageBox.information
        QMessageBox.information = staticmethod(lambda *a, **k: None)  # don't block
        try:
            # APPROVED -> the send reaches the signer
            w.SecurityConfirmSheet.exec = lambda self: QDialog.Accepted
            sheet._on_reviewed(out)
            self._drain(pred=lambda: len(sent) >= 1, limit=400)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0], ("ethereum", eth_addr, tx["_amountBase"]))
            # DECLINED -> the send never reaches the signer
            w.SecurityConfirmSheet.exec = lambda self: QDialog.Rejected
            sheet._on_reviewed(out)
            self._drain(limit=60)
            self.assertEqual(len(sent), 1)                   # unchanged: no new send
        finally:
            w.SecurityConfirmSheet.exec = orig_exec
            QMessageBox.information = orig_info
        ctrl.loop and ctrl.loop.stop()


if __name__ == "__main__":
    unittest.main()
