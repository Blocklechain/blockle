"""Smoke + wiring tests for the native Blockle Bots Qt panel (``blockle.qtbots``).

Runs headless (offscreen Qt). Asserts the UI is driven by the REAL engine — the
deal-ladder preview comes out of the deal engine, the Arena is the real
``ArenaProfile`` over the shared fixture (play funds, no gate), creating a bot
goes through the real ``BotRunner``, and the safety UX holds (live-arm review,
kill-all). No network and no real LLM are touched.
"""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


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


def _qt_app():
    import PySide6  # noqa: F401
    plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
    if plugins.exists():
        os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
    from PySide6.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


class ImportAndPureTest(unittest.TestCase):
    """These need no Qt runtime — pure engine + token helpers."""

    def test_module_imports(self):
        import blockle.qtbots as qb
        self.assertTrue(hasattr(qb, "BotsPanel"))
        self.assertTrue(hasattr(qb, "build_bots_tab"))

    def test_tokens_and_qss(self):
        import blockle.qtbots as qb
        for tok in (qb.TOKENS_DARK, qb.TOKENS_LIGHT):
            for key in ("ground", "surface", "ink", "accent", "gain", "loss",
                        "k_base", "k_safety", "k_tp"):
                self.assertIn(key, tok)
            qss = qb.build_qss(tok)
            self.assertIn("#botsRoot", qss)
            self.assertIn(tok["accent"], qss)

    def test_tokens_match_design_reference(self):
        """The ported ramp must equal docs/design/bots/index.html :root (one
        source of truth across all three wallets)."""
        import blockle.qtbots as qb
        self.assertEqual(qb.TOKENS_DARK["accent"], "#4c8dff")
        self.assertEqual(qb.TOKENS_DARK["gain"], "#2fd39b")
        self.assertEqual(qb.TOKENS_DARK["loss"], "#f0536a")
        self.assertEqual(qb.TOKENS_LIGHT["accent"], "#2f6ff0")
        self.assertEqual(qb.TOKENS_LIGHT["gain"], "#0c9e6f")

    def test_arena_vectors_load(self):
        import blockle.qtbots as qb
        v = qb.load_arena_vectors()
        self.assertEqual(set(v["scenarios"].keys()),
                         {"bull", "crab", "bear", "crash", "pump"})

    def test_deal_ladder_preview_is_engine_driven(self):
        """The preview ladder must be computed by the real deal engine: a base
        order + N safety orders with martingale sizing and a TP above avg entry."""
        import blockle.qtbots as qb
        d = qb.preview_ladder(
            {"baseOrderUsd": 100, "safetyOrderUsd": 100, "maxSafetyOrders": 3,
             "safetyStepPct": 2, "safetyVolumeScale": 1.4, "takeProfitPct": 2,
             "trailingTpPct": 0}, "SOL", 142.8)
        self.assertEqual(len(d["legs"]), 4)                  # base + 3 safety
        self.assertEqual(d["legs"][0]["k"], "base")
        self.assertTrue(all(l["k"] == "safety" for l in d["legs"][1:]))
        # safety sizing scales up (martingale 1.4x)
        self.assertGreater(d["legs"][1]["usd"], d["legs"][0]["usd"] - 1)
        self.assertGreater(d["legs"][2]["usd"], d["legs"][1]["usd"])
        # avg entry sits below spot, TP above avg
        self.assertLess(d["avg"], 142.8)
        self.assertGreater(d["tp"], d["avg"])
        self.assertGreater(d["dipPct"], 0)


class PanelFlowTest(unittest.TestCase):
    def setUp(self):
        _qt_app()
        self._tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self._tmp.name)
        self.wallet = _StubBlockWallet(self.datadir)

    def tearDown(self):
        self._tmp.cleanup()

    def _bots_panel(self):
        from blockle.qtmultichain import MultiChainController
        from blockle.qtbots import BotsPanel
        ctrl = MultiChainController(self.wallet, self.datadir)
        return BotsPanel(ctrl), ctrl

    def _drain(self, pred=None, limit=300):
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        for _ in range(limit):
            app.processEvents()
            if pred and pred():
                return
            time.sleep(0.003)

    def test_build_tabs_includes_bots(self):
        from blockle.qtbots import BotsPanel
        from blockle.qtmultichain import build_tabs
        tabs = build_tabs(self.wallet, self.datadir)
        titles = [t for _w, t in tabs]
        self.assertIn("Bots", titles)
        self.assertEqual(titles[:4], ["Accounts", "Exchange", "Agent", "Bots"])
        bots = [w for w, t in tabs if t == "Bots"][0]
        self.assertIsInstance(bots, BotsPanel)
        # the Bots panel shares the SAME controller as the other tabs
        self.assertIs(bots.ctrl, tabs[0][0].ctrl)
        bots.ctrl.loop and bots.ctrl.loop.stop()

    def test_four_surfaces_build(self):
        panel, ctrl = self._bots_panel()
        self.assertEqual(self.wallet.__class__.__name__, "_StubBlockWallet")
        self.assertEqual(panel.tabs.count(), 4)
        self.assertEqual([panel.tabs.tabText(i).split()[0] for i in range(4)],
                         ["Cockpit", "Create", "Bot", "Arena"])
        ctrl.loop and ctrl.loop.stop()

    def test_cockpit_locked_empty_state(self):
        panel, ctrl = self._bots_panel()
        panel.cockpit.refresh()  # vault locked -> prompt, no crash, no fake data
        # (offscreen widgets are never "shown"; assert it isn't explicitly hidden)
        self.assertFalse(panel.cockpit.empty.isHidden())
        self.assertIn("Unlock", panel.cockpit.empty.text())
        self.assertEqual(panel.cockpit.count.text(), "0")  # no fabricated bots
        ctrl.loop and ctrl.loop.stop()

    def test_theme_toggle_light_dark(self):
        import blockle.qtbots as qb
        panel, ctrl = self._bots_panel()
        self.assertEqual(panel.theme, "dark")
        self.assertIs(panel.tok, qb.TOKENS_DARK)
        panel._toggle_theme()
        self.assertEqual(panel.theme, "light")
        self.assertIs(panel.tok, qb.TOKENS_LIGHT)
        ctrl.loop and ctrl.loop.stop()

    def test_arena_run_is_real_play_sim(self):
        """Arena.run records into the REAL ArenaProfile: play balance moves by
        play PnL only, a score is produced, and XP accrues — no gate, no vault."""
        panel, ctrl = self._bots_panel()
        arena = panel.arena
        start_xp = panel.bc.arena().xp
        arena._pick_scen("crash")
        arena._run()
        self._drain(pred=lambda: not (arena._anim and arena._anim.isActive()))
        self.assertNotEqual(arena.sim_score.text(), "—")
        self.assertGreaterEqual(panel.bc.arena().xp, start_xp + 10)  # participation XP
        # play balance is PLAY only — the engine's convert_to_real must refuse
        with self.assertRaises(Exception):
            panel.bc.arena().playBalance.convert_to_real()
        ctrl.loop and ctrl.loop.stop()

    def test_arena_scenario_is_deterministic(self):
        """Same (scenario, config) -> identical score (shared fixture, no RNG)."""
        from blockle.agent import arena as arena_mod
        panel, ctrl = self._bots_panel()
        bot = panel.arena._arena_bot()
        r1 = arena_mod.run_scenario({"vectors": panel.bc.vectors, "scenario": "bear", "bot": bot})
        r2 = arena_mod.run_scenario({"vectors": panel.bc.vectors, "scenario": "bear", "bot": bot})
        self.assertEqual(r1["scoreTenths"], r2["scoreTenths"])
        self.assertEqual(r1["finalPnlUc"], r2["finalPnlUc"])
        ctrl.loop and ctrl.loop.stop()

    def test_create_paper_bot_via_real_runner(self):
        panel, ctrl = self._bots_panel()
        ctrl.create("pw-correct-horse")
        panel.create.alloc_in.setText("500")
        panel.create._start_paper()
        self._drain(pred=lambda: bool(panel.bc.runner and panel.bc.runner.list()))
        bots = panel.bc.runner.list()
        self.assertEqual(len(bots), 1)
        self.assertEqual(bots[0].mode, "paper")
        self.assertTrue(bots[0].enabled)
        # cockpit now reflects the real bot (not mock data)
        panel.cockpit.refresh()
        self.assertEqual(panel.cockpit.count.text(), "1")
        agg = panel.bc.runner.aggregate()
        self.assertEqual(len(agg["bots"]), 1)
        ctrl.loop and ctrl.loop.stop()

    def test_use_for_real_lands_paper_disabled(self):
        """The Arena on-ramp imports as paper + disabled with zero allocation —
        never auto-live (the arming/allocation/mainnet gates are never skipped)."""
        from blockle.agent import arena as arena_mod
        panel, ctrl = self._bots_panel()
        bot = arena_mod.use_for_real(panel.arena._arena_bot())
        self.assertEqual(bot.mode, "paper")
        self.assertFalse(bot.enabled)
        self.assertEqual(bot.network, "testnet")
        self.assertEqual(float(bot.allocation_usd), 0.0)
        ctrl.loop and ctrl.loop.stop()

    def test_live_arm_requires_allocation_and_review(self):
        """arm_live is fail-closed: zero allocation is refused by the engine, and
        the review sheet disables confirm when allocation exceeds the session cap."""
        import asyncio
        from blockle.qtbots import LiveArmReview, TOKENS_DARK
        panel, ctrl = self._bots_panel()
        ctrl.create("pw")
        runner = panel.bc.ensure_runner()
        bot = runner.add({"name": "T", "type": "dca",
                          "universe": {"pairs": ["SOL/USDC"]},
                          "config": {"baseOrderUsd": 20}, "allocationUsd": 0,
                          "mode": "paper", "enabled": False, "network": "testnet"})

        async def _arm_zero():
            return await runner.arm_live(bot.id, {"allocationUsd": 0})
        with self.assertRaises(ValueError):
            panel.bc.loop.submit(_arm_zero()).result(timeout=5)

        # review sheet: allocation over the session cap -> confirm disabled
        over = LiveArmReview(None, TOKENS_DARK, name="T", pair="SOL/USDC",
                             allocation=99999.0, session_cap=1000.0,
                             network="testnet", mainnet_enabled=False)
        self.assertFalse(over.confirm_btn.isEnabled())
        ok = LiveArmReview(None, TOKENS_DARK, name="T", pair="SOL/USDC",
                           allocation=500.0, session_cap=1000.0,
                           network="testnet", mainnet_enabled=False)
        self.assertTrue(ok.confirm_btn.isEnabled())
        ctrl.loop and ctrl.loop.stop()

    def test_kill_all_wired_to_runner(self):
        panel, ctrl = self._bots_panel()
        ctrl.create("pw")
        runner = panel.bc.ensure_runner()
        runner.add({"name": "K", "type": "dca", "universe": {"pairs": ["SOL/USDC"]},
                    "config": {"baseOrderUsd": 20}, "allocationUsd": 100,
                    "mode": "paper", "enabled": True, "network": "testnet"})
        self.assertFalse(runner._killed)
        import asyncio
        panel.bc.loop.submit(runner.kill_all("test")).result(timeout=5)
        self.assertTrue(runner._killed)
        self.assertFalse(ctrl.is_unlocked())  # kill locked the vault
        ctrl.loop and ctrl.loop.stop()


if __name__ == "__main__":
    unittest.main()
