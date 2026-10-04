"""Integration tests for the BLOCK chain wallet layer and the Qt GUI.

Real binaries, real sockets, no mocks: a regtest chain is created on disk,
mined, spent from, shielded into — and a second wallet syncs the chain over
P2P through the embedded node, which is the decentralization claim the Qt
wallet makes.
"""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

from blockle.chainwallet import ChainWallet, NodeProcess, format_block


class ChainWalletTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.datadir = Path(self.tmp.name) / "w1"

    def tearDown(self):
        self.tmp.cleanup()

    def test_wallet_lifecycle_send_and_shield(self):
        w = ChainWallet(datadir=self.datadir, network="regtest")
        self.assertFalse(w.exists())
        w.init_chain()
        self.assertTrue(w.exists())

        w.mine(2)
        snap = w.snapshot()
        self.assertEqual(snap["chain"]["height"], 2)
        self.assertEqual(snap["chain"]["ticker"], "BLOCK")
        addr = snap["wallet"]["address"]
        self.assertTrue(addr.startswith("block1"))
        self.assertTrue(snap["wallet"]["zaddress"].startswith("zblockpk"))
        # premine + 2 subsidies
        self.assertEqual(snap["wallet"]["balance"], (210_000 + 2 * 50) * 100_000_000)
        kinds = [h["kind"] for h in snap["history"]]
        self.assertEqual(kinds, ["coinbase"] * 3)

        # transparent self-send: pending → confirmed
        result = w.send(addr, "7.5")
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["txid"]), 64)
        snap = w.snapshot()
        self.assertTrue(snap["history"][0]["pending"])
        w.mine(1)
        snap = w.snapshot()
        transfers = [h for h in snap["history"] if h["kind"] == "transfer"]
        self.assertEqual(len(transfers), 1)
        self.assertFalse(transfers[0]["pending"])
        self.assertEqual(transfers[0]["net"], -10_000)  # self-send nets only the fee

        # shield → note appears and zbalance moves
        result = w.shield("3")
        self.assertTrue(result["ok"])
        w.mine(1)
        snap = w.snapshot()
        self.assertEqual(snap["wallet"]["zbalance"], 3 * 100_000_000)
        notes = snap["wallet"]["notes"]
        self.assertEqual([n["status"] for n in notes], ["unspent"])
        self.assertIn("shielded", [h["kind"] for h in snap["history"]])

    def test_p2p_sync_between_wallets(self):
        """A fresh wallet with an empty datadir syncs the chain from a peer
        through its embedded node — the wallet is a network participant."""
        w1 = ChainWallet(datadir=self.datadir, network="regtest")
        w1.init_chain()
        w1.mine(3)

        d2 = Path(self.tmp.name) / "w2"
        w2 = ChainWallet(datadir=d2, network="regtest")
        w2.create()

        n1 = NodeProcess(datadir=self.datadir, network="regtest", listen="127.0.0.1:28471")
        n2 = NodeProcess(datadir=d2, network="regtest", listen="127.0.0.1:28472",
                         peers=["127.0.0.1:28471"])
        try:
            n1.start()
            time.sleep(0.5)
            n2.start()
            deadline = time.monotonic() + 30
            height = None
            while time.monotonic() < deadline:
                height = w2.snapshot()["chain"]["height"]
                if height == 3:
                    break
                time.sleep(0.5)
            self.assertEqual(height, 3, f"wallet 2 never synced (log: {n2.log_tail(10)})")
        finally:
            n1.stop()
            n2.stop()

    def test_wallet_parity_encrypt_sign_export(self):
        from blockle.chainwallet import WalletError
        w = ChainWallet(datadir=self.datadir, network="regtest")
        w.init_chain()
        w.mine(1)
        addr = w.snapshot()["wallet"]["address"]

        # encrypt → locked ops fail → unlock works
        w.encrypt("hunter2")
        self.assertTrue(w.snapshot()["wallet"]["encrypted"])
        w.passphrase = None
        with self.assertRaises(WalletError):
            w.send(addr, "1")
        w.passphrase = "wrong"
        with self.assertRaises(WalletError):
            w.send(addr, "1")
        w.passphrase = "hunter2"
        self.assertTrue(w.send(addr, "1")["ok"])

        # sign / verify (and tamper rejection)
        out = w.sign_message("proof of ownership")
        self.assertEqual(out["address"], addr)
        self.assertTrue(w.verify_message(addr, out["signature"], "proof of ownership"))
        self.assertFalse(w.verify_message(addr, out["signature"], "tampered"))

        # passphrase rotation
        w.change_passphrase("hunter3")
        w.passphrase = "hunter2"
        with self.assertRaises(WalletError):
            w.export_keys()
        w.passphrase = "hunter3"

        # export → import roundtrip restores the same address
        blob = w.export_keys()
        self.assertTrue(blob.startswith("blockleexport1"))
        d2 = Path(self.tmp.name) / "restored"
        w2 = ChainWallet(datadir=d2, network="regtest")
        imported = w2.import_keys(blob)
        self.assertEqual(imported["address"], addr)

        # backup copies the (encrypted) wallet file
        backup = Path(self.tmp.name) / "backup.json"
        w.backup(backup)
        self.assertTrue(backup.exists())
        self.assertIn('"encrypted": true', backup.read_text())

    def test_format_block(self):
        self.assertEqual(format_block(100_000_000), "1")
        self.assertEqual(format_block(150_000_000), "1.5")
        self.assertEqual(format_block(-10_000), "-0.0001")


class QtWalletSmokeTest(unittest.TestCase):
    """Offscreen render of the real GUI against a real regtest wallet."""

    def test_window_builds_and_shows_state(self):
        try:
            import PySide6  # noqa: F401
        except ImportError:
            self.skipTest("PySide6 not installed")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        plugins = Path(PySide6.__file__).parent / "Qt" / "plugins" / "platforms"
        if plugins.exists():  # conda envs ship a second Qt that shadows the wheel's
            os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", str(plugins))
        from PySide6.QtWidgets import QApplication
        from blockle.qtwallet import WalletWindow

        with tempfile.TemporaryDirectory() as tmp:
            datadir = Path(tmp) / "w"
            wallet = ChainWallet(datadir=datadir, network="regtest")
            wallet.init_chain()
            wallet.mine(1)

            app = QApplication.instance() or QApplication([])
            node = NodeProcess(datadir=datadir, network="regtest", listen="127.0.0.1:28473")
            win = WalletWindow(wallet, node)
            win._apply_snapshot(wallet.snapshot())
            self.assertEqual(win.height_lbl.text(), "1")
            self.assertEqual(win.bal_lbl.text(), "210050")
            self.assertEqual(win.history.rowCount(), 2)  # premine + subsidy
            from PySide6.QtWidgets import QLineEdit
            self.assertTrue(win.addr_row.findChild(QLineEdit).text().startswith("block1"))
            win.node.stop()
            win.close()


if __name__ == "__main__":
    unittest.main()
