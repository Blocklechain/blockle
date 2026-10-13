"""DOGE ENDPOINT — the wallet's Dogecoin Esplora endpoint points at the new
Blockle-hosted shim by default, and stays operator-overridable like the others.
"""

from blockle.multichain.chains import registry as R

SHIM = "https://doge-esplora.blockle.org"


def test_default_dogecoin_endpoint_is_the_shim():
    assert R.DEFAULT_ENDPOINTS["dogecoin"]["esplora"] == SHIM


def test_registry_wires_the_shim_into_the_dogecoin_adapter():
    reg = R.create_registry()
    assert reg.endpoints("dogecoin")["esplora"] == SHIM
    # adapter is built (unchanged) and bound to the configured base
    assert reg.has("dogecoin")


def test_dogecoin_endpoint_is_operator_overridable():
    custom = "https://my-doge-indexer.example/api"
    reg = R.create_registry({"endpoints": {"dogecoin": {"esplora": custom}}})
    assert reg.endpoints("dogecoin")["esplora"] == custom


def test_other_utxo_endpoints_unchanged():
    assert R.DEFAULT_ENDPOINTS["bitcoin"]["esplora"] == "https://blockstream.info/api"
    assert R.DEFAULT_ENDPOINTS["litecoin"]["esplora"] == "https://litecoinspace.org/api"
