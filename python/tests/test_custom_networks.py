"""User-added custom EVM networks: validation/normalize, dedupe, vault-store
roundtrip, and ChainRegistry derivation (same EVM adapter + same secp256k1
address, merge+dedupe by chainId, token-indexer wiring).

Run:  python -m pytest python/ -k custom_networks
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import pytest

from blockle.multichain import crypto as K
from blockle.multichain.chains import (ChainRegistry, create_registry,
                                       dedupe_custom_networks,
                                       explorer_tx_prefix,
                                       normalize_custom_network,
                                       normalize_custom_networks)

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ABANDON = ("abandon abandon abandon abandon abandon abandon abandon abandon "
           "abandon abandon abandon about")


def _seed():
    return K.mnemonic_to_seed(ABANDON)


def _rpc_url(adapter):
    """Pull the configured URL back out of the default_json_rpc closure."""
    for cell in (adapter._rpc.__closure__ or []):
        v = cell.cell_contents
        if isinstance(v, str) and v.startswith("http"):
            return v
    return None


# --- normalize / validation ------------------------------------------------
def test_normalize_minimal_defaults():
    net = normalize_custom_network({
        "name": "My Rollup", "chainId": 7777, "rpcUrl": "https://rpc.example.com",
        "nativeSymbol": "ETH",
    })
    assert net["id"] == "my-rollup"
    assert net["chainId"] == 7777
    assert net["decimals"] == 18  # default
    assert "explorerUrl" not in net and "tokenIndexerUrl" not in net


def test_normalize_full_and_slug_from_id():
    net = normalize_custom_network({
        "id": "Fancy Chain!!", "name": "Fancy", "chainId": "42",
        "rpcUrl": "https://r.example.com", "nativeSymbol": "fcy",
        "decimals": "9", "explorerUrl": "https://scan.example.com",
        "tokenIndexerUrl": "https://idx.example.com/v2/KEY",
    })
    assert net["id"] == "fancy-chain"
    assert net["chainId"] == 42 and net["decimals"] == 9
    assert net["tokenIndexerUrl"].endswith("/KEY")


@pytest.mark.parametrize("bad", [
    {"name": "", "chainId": 1, "rpcUrl": "https://x", "nativeSymbol": "E"},
    {"name": "x", "chainId": 0, "rpcUrl": "https://x", "nativeSymbol": "E"},
    {"name": "x", "chainId": -5, "rpcUrl": "https://x", "nativeSymbol": "E"},
    {"name": "x", "chainId": "nope", "rpcUrl": "https://x", "nativeSymbol": "E"},
    {"name": "x", "chainId": 1, "rpcUrl": "not-a-url", "nativeSymbol": "E"},
    {"name": "x", "chainId": 1, "rpcUrl": "ftp://x", "nativeSymbol": "E"},
    {"name": "x", "chainId": 1, "rpcUrl": "https://x", "nativeSymbol": ""},
    {"name": "x", "chainId": True, "rpcUrl": "https://x", "nativeSymbol": "E"},
    {"name": "x", "chainId": 1, "rpcUrl": "https://x", "nativeSymbol": "E", "decimals": 99},
    {"name": "x", "chainId": 1, "rpcUrl": "https://x", "nativeSymbol": "E", "explorerUrl": "bad"},
])
def test_normalize_rejects_bad(bad):
    with pytest.raises(ValueError):
        normalize_custom_network(bad)


def test_normalize_list_drops_invalid():
    out = normalize_custom_networks([
        {"name": "ok", "chainId": 10, "rpcUrl": "https://a", "nativeSymbol": "E"},
        {"name": "", "chainId": 11, "rpcUrl": "https://b", "nativeSymbol": "E"},  # invalid
    ])
    assert len(out) == 1 and out[0]["name"] == "ok"


def test_explorer_tx_prefix():
    assert explorer_tx_prefix("") == ""
    assert explorer_tx_prefix("https://scan.io") == "https://scan.io/tx/"
    assert explorer_tx_prefix("https://scan.io/") == "https://scan.io/tx/"
    assert explorer_tx_prefix("https://scan.io/tx") == "https://scan.io/tx/"
    assert explorer_tx_prefix("https://scan.io/tx/") == "https://scan.io/tx/"


# --- dedupe ----------------------------------------------------------------
def test_dedupe_by_id_last_wins():
    a = normalize_custom_network({"id": "r", "name": "R1", "chainId": 100,
                                  "rpcUrl": "https://one", "nativeSymbol": "E"})
    b = normalize_custom_network({"id": "r", "name": "R2", "chainId": 100,
                                  "rpcUrl": "https://two", "nativeSymbol": "E"})
    out = dedupe_custom_networks([a, b])
    assert len(out) == 1 and out[0]["rpcUrl"] == "https://two"


def test_dedupe_by_chainid():
    a = normalize_custom_network({"id": "x", "name": "X", "chainId": 100,
                                  "rpcUrl": "https://one", "nativeSymbol": "E"})
    b = normalize_custom_network({"id": "y", "name": "Y", "chainId": 100,
                                  "rpcUrl": "https://two", "nativeSymbol": "E"})
    out = dedupe_custom_networks([a, b])
    assert len(out) == 1 and out[0]["chainId"] == 100
    assert out[0]["id"] == "y"  # last chainId wins


# --- registry derivation ---------------------------------------------------
def test_registry_adds_new_custom_chain():
    reg = create_registry({"customNetworks": [{
        "name": "My Rollup", "chainId": 7777, "rpcUrl": "https://rpc.example.com",
        "nativeSymbol": "MYR", "decimals": 8,
        "explorerUrl": "https://scan.example.com",
    }]})
    assert reg.has("my-rollup")
    adapter = reg.get("my-rollup")
    assert adapter.chainId == 7777
    assert adapter.native.symbol == "MYR" and adapter.decimals == 8
    assert adapter.explorer_tx("0xabc") == "https://scan.example.com/tx/0xabc"
    assert "my-rollup" in reg.enabled()
    assert [n["id"] for n in reg.custom_networks()] == ["my-rollup"]


def test_custom_chain_shares_evm_address():
    reg = create_registry({"customNetworks": [{
        "name": "My Rollup", "chainId": 7777, "rpcUrl": "https://rpc.example.com",
        "nativeSymbol": "ETH",
    }]})
    seed = _seed()
    eth = reg.get("ethereum").derive_account(seed, 0).address
    custom = reg.get("my-rollup").derive_account(seed, 0).address
    assert custom == eth  # one secp256k1 account across every EVM chain


def test_custom_chainid_overrides_builtin_rpc():
    # chainId 1 == Ethereum: this must OVERRIDE the built-in RPC, not duplicate.
    reg = create_registry({"customNetworks": [{
        "name": "My Ethereum", "chainId": 1,
        "rpcUrl": "https://my-eth.example.com", "nativeSymbol": "ETH",
    }]})
    assert reg.custom_networks() == []  # override, not a new chain
    assert not reg.has("my-ethereum")
    assert reg.get("ethereum").chainId == 1
    assert _rpc_url(reg.get("ethereum")) == "https://my-eth.example.com"
    # built-in symbol/explorer preserved on override
    assert reg.get("ethereum").native.symbol == "ETH"


def test_custom_token_indexer_enables_autodetect():
    reg = create_registry({"customNetworks": [{
        "name": "Idx Net", "chainId": 9001, "rpcUrl": "https://rpc.example.com",
        "nativeSymbol": "ETH", "tokenIndexerUrl": "https://idx.example.com/v2/KEY",
    }]})
    assert reg.get("idx-net")._alchemy_rpc is not None
    # No indexer => auto-detect OFF.
    reg2 = create_registry({"customNetworks": [{
        "name": "Bare Net", "chainId": 9002, "rpcUrl": "https://rpc.example.com",
        "nativeSymbol": "ETH",
    }]})
    assert reg2.get("bare-net")._alchemy_rpc is None


def test_registry_invalid_custom_is_skipped_not_fatal():
    reg = create_registry({"customNetworks": [
        {"name": "", "chainId": 123, "rpcUrl": "https://x", "nativeSymbol": "E"},
        {"name": "Good", "chainId": 123, "rpcUrl": "https://ok", "nativeSymbol": "E"},
    ]})
    assert reg.has("good")
    assert len(reg.custom_networks()) == 1


def test_slug_collision_with_builtin_is_distinct():
    # A custom named to slug "ethereum" but a DIFFERENT chainId must not clobber
    # the built-in ethereum adapter.
    reg = create_registry({"customNetworks": [{
        "id": "ethereum", "name": "ethereum", "chainId": 5,
        "rpcUrl": "https://goerli.example.com", "nativeSymbol": "ETH",
    }]})
    assert reg.get("ethereum").chainId == 1  # built-in intact
    assert reg.has("ethereum-5")
    assert reg.get("ethereum-5").chainId == 5


# --- vault store roundtrip -------------------------------------------------
class VaultStoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "vault.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _vault(self):
        from blockle.qtmultichain import MultiVault
        return MultiVault(self.path)

    def test_add_persist_remove(self):
        v = self._vault()
        v.create("pw-correct-horse")
        norm = v.add_custom_network({
            "name": "My Rollup", "chainId": 7777,
            "rpcUrl": "https://rpc.example.com", "nativeSymbol": "ETH",
        })
        self.assertEqual(norm["id"], "my-rollup")
        v.lock()

        # reopen from disk
        v2 = self._vault()
        v2.unlock("pw-correct-horse")
        nets = v2.custom_networks()
        self.assertEqual(len(nets), 1)
        self.assertEqual(nets[0]["chainId"], 7777)

        # dedupe on re-add (same chainId, new rpc)
        v2.add_custom_network({
            "name": "My Rollup", "chainId": 7777,
            "rpcUrl": "https://rpc2.example.com", "nativeSymbol": "ETH",
        })
        self.assertEqual(len(v2.custom_networks()), 1)
        self.assertEqual(v2.custom_networks()[0]["rpcUrl"], "https://rpc2.example.com")

        v2.remove_custom_network("my-rollup")
        self.assertEqual(v2.custom_networks(), [])

    def test_add_rejects_invalid(self):
        v = self._vault()
        v.create("pw")
        with self.assertRaises(ValueError):
            v.add_custom_network({"name": "", "chainId": 1,
                                  "rpcUrl": "https://x", "nativeSymbol": "E"})
        self.assertEqual(v.custom_networks(), [])


if __name__ == "__main__":
    unittest.main()
