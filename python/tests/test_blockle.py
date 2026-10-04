"""Integration tests: the Python wrapper driving the real Blockle core —
simulated chain, interrogation, pool generation, mining, blockle.biz
registration, and Proof-of-Blocks attribution for an external pool."""

import tempfile
import time
import unittest
from pathlib import Path

import blockle


class TestBlockle(unittest.TestCase):
    def test_full_stack(self):
        tmp = Path(tempfile.mkdtemp(prefix="blockle-py-"))
        with blockle.simchain(port=28480, name="PyCoin") as chain, blockle.simchain(
            port=28481, name="BLOCK"
        ) as aux, blockle.biz_server(
            port=28490,
            data=tmp / "registry.json",
            pob_whitelist="PyCoin:0:pysim",
            algo_weights="pysim=1e18",
            monitor_interval=2,
        ) as bizproc:
            # 1. interrogation
            profile = blockle.inspect("http://127.0.0.1:28480/")
            self.assertTrue(profile["ready_for_builtin_adapter"], profile)
            self.assertEqual(profile["algorithm"], "SHA-256d")
            self.assertEqual(profile["confidence"], 100)

            # 2. pool generation + merged mining + registration
            pool = blockle.add_chain(
                "PyCoin",
                "http://127.0.0.1:28480/",
                config=tmp / "pool.toml",
                stratum="127.0.0.1:28333",
                dashboard="127.0.0.1:28482",
            )
            pool.add_aux("BLOCK", "http://127.0.0.1:28481/")
            pool.set_heartbeat_secs(5)
            pool.register(
                "http://127.0.0.1:28490",
                public_chain_rpc="http://127.0.0.1:28480/",
                aux_chain_rpcs={"BLOCK": "http://127.0.0.1:28481/"},
                payout_address="block1pytest",
            )
            self.assertEqual(pool.config["chain"]["name"], "PyCoin")

            with pool.serve():
                # 3. mine through real stratum
                report = blockle.mine("127.0.0.1:28333", worker="py", shares=16)
                self.assertGreaterEqual(report["accepted"], 16)

                stats = pool.dashboard_stats()
                self.assertGreaterEqual(len(stats["blocks_found"]), 1)
                self.assertIn("py", pool.payouts()["balances"])

                # 4. heartbeat + verification cycles
                time.sleep(12)
                biz = blockle.BizClient("http://127.0.0.1:28490")
                pools = biz.pools()
                self.assertEqual(len(pools), 1)
                self.assertIn(pools[0]["status"], ("online", "verified"))
                pob = biz.pob()
                # difficulty 4.66e-10 x weight 1e18 ≈ 4.66 BLOCK (4.66e8 base units) per block
                self.assertGreaterEqual(pob["totals"]["block_minted_base_units"], 4e8)
                batch = biz.settlement_batch()
                self.assertTrue(batch["epochs"])
                entry = batch["epochs"][0]["entries"][0]
                self.assertEqual(entry["address"], "block1pytest")
                self.assertGreater(entry["amount_base_units"], 0)
            _ = bizproc, chain, aux

    def test_external_pool_watcher(self):
        tmp = Path(tempfile.mkdtemp(prefix="blockle-py-ext-"))
        with blockle.simchain(port=28580, name="LegacyCoin"), blockle.biz_server(
            port=28590,
            data=tmp / "registry.json",
            pob_whitelist="LegacyCoin:0:legacysim",
            algo_weights="legacysim=1e18",
            monitor_interval=2,
        ):
            # A "legacy" pool: Blockle only knows its coinbase tag + RPC.
            pool = blockle.add_chain(
                "LegacyCoin",
                "http://127.0.0.1:28580/",
                config=tmp / "legacy.toml",
                stratum="127.0.0.1:28334",
                dashboard="127.0.0.1:28582",
            )
            biz = blockle.BizClient("http://127.0.0.1:28590")
            reg = biz.register_external(
                name="Legacy Mining Co",
                chain="LegacyCoin",
                stratum="127.0.0.1:28334",
                chain_rpc="http://127.0.0.1:28580/",
                coinbase_tag="/blockle/",
                payout_address="block1legacy",
            )
            self.assertIn("pool_id", reg)
            with pool.serve():  # the pool itself never talks to blockle.biz
                blockle.mine("127.0.0.1:28334", worker="zed", shares=20)
                time.sleep(10)
            pob = biz.pob()
            credited = [
                c for c in pob["claims"] if c["status"]["state"] == "Credited"
            ]
            self.assertGreaterEqual(len(credited), 1, pob["totals"])
            self.assertEqual(credited[0]["pool_id"], reg["pool_id"])
            self.assertGreater(credited[0]["credits"], 0)
            self.assertGreater(credited[0]["difficulty"], 0)


if __name__ == "__main__":
    unittest.main()
