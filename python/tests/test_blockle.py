"""Integration tests: the Python wrapper driving the real Blockle core —
simulated chain, interrogation, pool generation, mining, and blockle.org
registration/monitoring."""

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
                stats_api = biz.stats()
                self.assertGreaterEqual(stats_api["total_pools"], 1)
            _ = bizproc, chain, aux

if __name__ == "__main__":
    unittest.main()
