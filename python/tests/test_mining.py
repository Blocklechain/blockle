import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from blockle import mining


def test_live_algos_have_pool_endpoints():
    for name in ("sha256d", "scrypt", "x11"):
        assert mining.is_live(name), name
        url = mining.stratum_url(name)
        assert url and url.startswith("stratum+tcp://blockle.org:")


def test_soon_algos_are_known_but_not_live():
    for name in ("equihash", "blake2b", "blake2s", "blake3", "eaglesong", "kheavyhash"):
        a = mining.get_algo(name)
        assert a is not None and a["status"] == "soon"
        assert not mining.is_live(name)
        assert mining.stratum_url(name) is None


def test_all_nine_algos_present():
    assert set(mining.ALGO_NAMES) == {
        "sha256d", "scrypt", "x11", "equihash", "blake2b", "blake2s", "blake3", "eaglesong", "kheavyhash",
    }


def test_pplns_and_solo_use_different_ports():
    assert mining.stratum_url("scrypt", "pplns") != mining.stratum_url("scrypt", "solo")
    assert mining.stratum_url("scrypt", "pplns").endswith(":3375")
    assert mining.stratum_url("scrypt", "solo").endswith(":3355")


def test_miner_command_shape():
    cmd = mining.miner_command("/usr/bin/cpuminer", "sha256d", "block1qpayout", mode="pplns", worker="rig1")
    assert cmd == ["/usr/bin/cpuminer", "-a", "sha256d", "-o",
                   "stratum+tcp://blockle.org:3377", "-u", "block1qpayout.rig1", "-p", "x"]


def test_miner_command_refuses_non_live_or_missing_inputs():
    assert mining.miner_command("/usr/bin/cpuminer", "equihash", "block1q") is None   # not live
    assert mining.miner_command("", "sha256d", "block1q") is None                      # no miner path
    assert mining.miner_command("/usr/bin/cpuminer", "sha256d", "") is None            # no payout
