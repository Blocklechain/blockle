"""Finalized security-gating locks.

Covers the paths newly brought under the security bar:

  * agent/tools.py buy_block — the SELLER-SUPPLIED x402 payTo is inspected before
    settlement; a flagged (danger) payTo FAILS CLOSED (refuse to pay), a clean
    payTo settles.                                                           (§B)
  * exchange x402 challenge parsing — payTo / network extraction across the
    top-level and accepts[] shapes (adversarial relay input).
  * qtmultichain ExchangeTab — _sell / _place / _buy route through the SHARED
    SecurityConfirmSheet (never a plain QMessageBox): a reject reaches NO
    sign/broadcast, an accept does; a denylisted reserve / payTo is a danger
    the inspection surfaces.                                            (§A/§B/§C)
  * qtwallet console — value-moving verbs (friendly `send` + raw CLI send/sign
    family) are blocked unless a dev-only flag is set, so broadcast is impossible
    from the ungated console.                                                (§2)

Headless (offscreen Qt); no network, no real signer.
"""

from __future__ import annotations

import asyncio
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def run(coro):
    return asyncio.run(coro)


# ======================================================================== #
# agent buy_block — inspect the x402 payTo, fail closed on a flagged payTo   #
# ======================================================================== #
class BuyBlockPayToInspectTest(unittest.TestCase):
    def _ctx(self, challenge, inspect_fn, paid=True):
        state = {"paid": [], "inspected": []}

        async def buy_block(usdc, *rest):
            if not rest or rest == (None,):
                return {"paymentRequired": True, "challenge": challenge}
            return {"settled": True}

        async def pay_x402(ch):
            state["paid"].append(ch)
            return {"paymentTxid": "0xpay", "chain": "base"} if paid else None

        def inspect(chain, intent):
            state["inspected"].append((chain, intent))
            return inspect_fn(chain, intent)

        ctx = {"exchange": {"buyBlock": buy_block}, "payX402Usdc": pay_x402,
               "inspect": inspect}
        return ctx, state

    def test_flagged_payto_fails_closed(self):
        from blockle.agent import tools as tools_mod
        challenge = {"amount": "1000000", "asset": "USDC",
                     "accepts": [{"scheme": "exact", "payTo": "0xdrainer", "network": "base"}]}
        ctx, state = self._ctx(
            challenge, lambda c, i: {"severity": "danger", "warnings": [{"code": "send-to-flagged"}]})
        reg = tools_mod.build(ctx)
        prep = run(reg.get("buy_block")["prepare"]({"usdc": "1000000"}))
        with self.assertRaises(ValueError) as cm:
            run(prep["commit"]())
        self.assertIn("flagged", str(cm.exception))
        # the payTo was inspected on the `base` chain, and NOTHING was paid
        self.assertEqual(state["inspected"][0][0], "base")
        self.assertEqual(state["inspected"][0][1]["to"], "0xdrainer")
        self.assertEqual(state["paid"], [])

    def test_clean_payto_settles(self):
        from blockle.agent import tools as tools_mod
        challenge = {"amount": "1000000", "asset": "USDC",
                     "accepts": [{"scheme": "exact", "payTo": "0xseller", "network": "base"}]}
        ctx, state = self._ctx(challenge, lambda c, i: {"severity": "none", "warnings": []})
        reg = tools_mod.build(ctx)
        prep = run(reg.get("buy_block")["prepare"]({"usdc": "1000000"}))
        res = run(prep["commit"]())
        self.assertTrue(res["paid"])
        self.assertEqual(len(state["paid"]), 1)
        self.assertEqual(state["inspected"][0][1]["to"], "0xseller")

    def test_no_payto_skips_inspect_and_settles(self):
        # a challenge that names no recipient has nothing external to inspect
        from blockle.agent import tools as tools_mod
        ctx, state = self._ctx({"amount": "1000000", "asset": "USDC"},
                               lambda c, i: {"severity": "danger"})
        reg = tools_mod.build(ctx)
        prep = run(reg.get("buy_block")["prepare"]({"usdc": "1000000"}))
        res = run(prep["commit"]())
        self.assertTrue(res["paid"])
        self.assertEqual(state["inspected"], [])  # inspect never called


# ======================================================================== #
# exchange x402 challenge parsing                                            #
# ======================================================================== #
class X402ParseTest(unittest.TestCase):
    def test_pay_to_top_level_and_accepts(self):
        from blockle.multichain import exchange as X
        self.assertEqual(X.x402_pay_to({"payTo": "0xtop"}), "0xtop")
        self.assertEqual(
            X.x402_pay_to({"accepts": [{"scheme": "exact", "payTo": "0xacc"}]}), "0xacc")
        self.assertEqual(
            X.x402_pay_to({"accepts": [{"recipient": "0xrecip"}]}), "0xrecip")
        self.assertIsNone(X.x402_pay_to({"accepts": [{"scheme": "exact"}]}))
        self.assertIsNone(X.x402_pay_to(None))

    def test_network_default_base(self):
        from blockle.multichain import exchange as X
        self.assertEqual(X.x402_network({"accepts": [{"network": "Ethereum"}]}), "ethereum")
        self.assertEqual(X.x402_network({"network": "base"}), "base")
        self.assertEqual(X.x402_network({"accepts": [{"scheme": "exact"}]}), "base")


# ======================================================================== #
# ExchangeTab — the three value-moving actions now use the shared sheet      #
# ======================================================================== #
class _StubEx:
    def __init__(self, reserve="block1reserve"):
        self._reserve = reserve
        self.calls = []

    def reserve_address(self):
        return self._reserve

    def get_book(self, market):
        return {"bids": [], "asks": []}

    def get_markets(self):
        return []

    def place_order(self, p):
        self.calls.append(("place_order", p))
        return {"orderId": "ord-1"}

    def sell_block(self, amt, opts):
        self.calls.append(("sell_block", amt, opts))
        return {"blockTxid": "tx"}

    def buy_block(self, usdc):
        self.calls.append(("buy_block", usdc))
        return {"paymentRequired": True,
                "challenge": {"amount": "1000000", "asset": "USDC",
                              "accepts": [{"payTo": "0xseller", "network": "base"}]}}


class ExchangeTabGateTest(unittest.TestCase):
    def setUp(self):
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")
        import tempfile
        from pathlib import Path
        # conda envs ship a second Qt that shadows the wheel's offscreen plugin.
        plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
        if plugins.exists():
            os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
        from PySide6.QtWidgets import QApplication
        from blockle.qtmultichain import ExchangeTab, MultiChainController
        self._tmp = tempfile.TemporaryDirectory()
        QApplication.instance() or QApplication([])

        class _W:
            network = "regtest"

            def snapshot(self):
                return {"wallet": {"address": "block1stub"}, "chain": {"height": 1}}

            def sign_message(self, m):
                return {"signature": "s", "address": "block1stub"}

            def send(self, *a, **k):
                return {"txid": "t"}

        ctrl = MultiChainController(_W(), Path(self._tmp.name))
        # locked vault => ExchangeTab.__init__ touches no network
        self.ctrl = ctrl
        self.tab = ExchangeTab(ctrl)
        self.stub = _StubEx()
        self.ctrl.exchange = self.stub
        # run the committed action synchronously so we can assert on the stub
        self._ran = []

        def _run(fn, ok=None, label=""):
            # run the ACTION synchronously (so the stub records the call) but skip
            # the success callback — it pops a modal QMessageBox that blocks a
            # headless run. The gate assertions only care that fn() executed.
            self._ran.append(label)
            self._last = fn()
        self.tab._run = _run

    def tearDown(self):
        try:
            self.ctrl.loop and self.ctrl.loop.stop()
        except Exception:
            pass
        self._tmp.cleanup()

    def _patch_sheet(self, accepted):
        from PySide6.QtWidgets import QDialog
        from blockle import qtwalletui as w
        self._orig = w.SecurityConfirmSheet.exec
        w.SecurityConfirmSheet.exec = lambda self: (QDialog.Accepted if accepted
                                                    else QDialog.Rejected)

    def _unpatch_sheet(self):
        from blockle import qtwalletui as w
        w.SecurityConfirmSheet.exec = self._orig

    # ---- place_order (first-party; §C confirm-gating via the shared sheet) --
    def test_place_reject_blocks_and_accept_runs(self):
        p = {"market": "BLOCK/USDC", "side": "buy", "type": "limit",
             "amount": "100", "price": "2"}
        self._patch_sheet(False)
        try:
            self.assertFalse(self.tab._confirm_inspection(self.tab._place_preview(p), "x"))
        finally:
            self._unpatch_sheet()
        # the preview is first-party: inspect recorded as skipped, no warning
        prev = self.tab._place_preview(p)
        self.assertEqual(prev["severity"], "none")
        self.assertTrue(prev["checks"]["skipped"])

        # end-to-end: reject => place_order NEVER called
        self._patch_sheet(False)
        try:
            self.tab.markets.addItem("BLOCK/USDC")
            self.tab.markets.setCurrentRow(0)
            self.tab.o_amount.setText("100")
            self.tab.o_price.setText("2")
            self.tab._place()
        finally:
            self._unpatch_sheet()
        self.assertEqual(self.stub.calls, [])

        # accept => place_order IS called
        self._patch_sheet(True)
        try:
            self.tab._place()
        finally:
            self._unpatch_sheet()
        self.assertEqual(self.stub.calls[0][0], "place_order")

    # ---- sell_block (real BLOCK -> known reserve; §A) -----------------------
    def test_sell_inspection_tx_decodes_reserve_and_gate_controls_broadcast(self):
        from blockle.multichain import security as sec
        tx = self.tab._sell_inspection_tx("block1reserve", "500000000")
        insp = run(sec.inspect_transaction(tx, {"config": {}}))
        self.assertEqual(insp["kind"], "block-send")
        self.assertEqual(sec.norm(insp.get("chain")), "block")
        # a trusted reserve is not flagged
        self.assertNotEqual(insp["severity"], "danger")

        # a denylisted reserve WOULD be a danger (the check really runs)
        bad = run(sec.inspect_transaction(
            self.tab._sell_inspection_tx("block1bad", "1"),
            {"config": {"denylist": ["block1bad"]}}))
        self.assertEqual(bad["severity"], "danger")

        # reject => sell_block never runs; accept => it runs
        self._patch_sheet(False)
        try:
            self.tab._on_sell_inspected(insp, "500000000", "0xusdc", "block1reserve")
        finally:
            self._unpatch_sheet()
        self.assertEqual(self.stub.calls, [])

        self._patch_sheet(True)
        try:
            self.tab._on_sell_inspected(insp, "500000000", "0xusdc", "block1reserve")
        finally:
            self._unpatch_sheet()
        self.assertEqual(self.stub.calls[0][0], "sell_block")
        self.assertEqual(self.stub.calls[0][2], {"userUsdcAddr": "0xusdc"})

    # ---- buy_block (x402 payTo externally influenced; §B) -------------------
    def test_buy_inspection_tx_targets_payto_and_flags_denylist(self):
        from blockle.multichain import security as sec
        challenge = {"amount": "1000000", "asset": "USDC",
                     "accepts": [{"payTo": "0x000000000000000000000000000000000000dEaD",
                                  "network": "base"}]}
        from blockle.multichain import exchange as X
        pay_to = X.x402_pay_to(challenge)
        tx = self.tab._buy_inspection_tx(pay_to, challenge)
        self.assertEqual(sec.norm(tx["to"]), sec.norm(pay_to))
        self.assertEqual(tx["chain"], "base")
        insp = run(sec.inspect_transaction(tx, {"config": {"denylist": [pay_to]}}))
        self.assertEqual(insp["severity"], "danger")

    def test_buy_result_reject_does_not_prompt_settlement(self):
        # a rejected payTo review must stop before the settle prompt
        prompted = []
        from blockle.multichain import security as sec
        challenge = {"amount": "1000000", "asset": "USDC",
                     "accepts": [{"payTo": "0xseller", "network": "base"}]}
        insp = run(sec.inspect_transaction(
            self.tab._buy_inspection_tx("0xseller", challenge), {"config": {}}))

        import blockle.qtmultichain as qm

        def _confirm(inspection, title):
            prompted.append(("confirm", title))
            return False  # reject
        self.tab._confirm_inspection = _confirm
        orig_mb = qm.QMessageBox
        try:
            # if it tried to prompt settlement it would construct a QMessageBox;
            # make that explode so a leak is caught
            class _Boom:
                def __init__(self, *a, **k):
                    raise AssertionError("settlement prompt reached after reject")
            qm.QMessageBox = _Boom
            self.tab._on_buy_inspected(insp, challenge)
        finally:
            qm.QMessageBox = orig_mb
        self.assertEqual(prompted, [("confirm", "Review x402 payTo")])


# ======================================================================== #
# qtwallet console — value-moving verbs blocked without the dev flag         #
# ======================================================================== #
class _ConsoleWallet:
    network = "regtest"

    def __init__(self):
        self.sent = []

    def send(self, to, amount, fee):
        self.sent.append((to, amount, fee))
        return {"txid": "console-tx"}

    def snapshot(self):
        return {"wallet": {"address": "block1me"}, "chain": {"height": 1}}

    def _run(self, *toks):
        # raw CLI passthrough stand-in
        self.sent.append(("_run",) + toks)
        return "cli-ok\n"


class ConsoleGateTest(unittest.TestCase):
    """The debug console is GONE, and this is what keeps it from coming back.

    These four tests used to drive `blockle.qtwallet.run_console_command`,
    which let a user type `send`/`sendtoaddress`/`z_sendmany` at a prompt. The
    gate they asserted was that spending was refused unless
    BLOCKLE_CONSOLE_DEV_SEND was set.

    The console tab was removed wholesale in "sync: pull wallet code + source
    work from production server" (fde0c53d), which rewrote qtwallet.py. The
    tests kept importing the deleted function, so all four errored on import
    and have been RED in CI ever since -- and because the Python suite gates
    the packaging step, that is why no wallet bundle could be attached to a
    release.

    Deleting them would drop the security property on the floor. Asserting the
    feature's ABSENCE keeps it: if anyone reintroduces a console that can
    spend, these fail and the author has to bring the gate back with it.
    """

    def setUp(self):
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")

    def test_no_console_command_runner_ships(self):
        import blockle.qtwallet as qtwallet

        self.assertFalse(
            hasattr(qtwallet, "run_console_command"),
            "a console command runner is back in qtwallet. It must not be able "
            "to spend by default -- restore the BLOCKLE_CONSOLE_DEV_SEND gate "
            "and the four tests this replaced (see git history for this file).",
        )

    def test_no_console_tab_is_built(self):
        """A console reachable from the UI is the thing that carried the risk."""
        import pathlib

        pkg = pathlib.Path(blockle_pkg_dir())
        offenders = []
        for path in pkg.glob("*.py"):
            for num, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                if "addTab" in line and "console" in line.lower():
                    offenders.append(f"{path.name}:{num}")
        self.assertEqual(
            offenders, [],
            "a Console tab is wired into the wallet UI again: " + ", ".join(offenders),
        )

    def test_no_spend_capable_cli_passthrough(self):
        """The raw-CLI escape hatch the old console exposed must stay closed."""
        import pathlib

        pkg = pathlib.Path(blockle_pkg_dir())
        offenders = []
        for path in pkg.glob("*.py"):
            text = path.read_text(errors="replace")
            for name in ("sendtoaddress", "z_sendmany", "sendrawtransaction"):
                if name in text:
                    offenders.append(f"{path.name}: {name}")
        self.assertEqual(
            offenders, [],
            "a raw spend-capable CLI passthrough is present again: "
            + ", ".join(offenders),
        )


def blockle_pkg_dir():
    import blockle

    return os.path.dirname(blockle.__file__)


if __name__ == "__main__":
    unittest.main()
