"""LAYER A of the owned-token auto-import work (Python / Qt wallet): each
new-chain adapter's ``discover_tokens(address)`` maps a MOCKED indexer response
to Balance rows the shared auto-import gate consumes. Proves the JSON->row
mapping for TRON (TRC-20) / TON (jettons) / STELLAR (trustlines) / CARDANO
(native-assets) + the best-effort contract (empty -> [], transport raise -> []).
No network — every adapter transport is injected.
"""

from __future__ import annotations

import json

from blockle.multichain.chains.cardano import CardanoAdapter
from blockle.multichain.chains.stellar import StellarAdapter
from blockle.multichain.chains.ton import TonAdapter
from blockle.multichain.chains.tron import TronAdapter

USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
USDT_JETTON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM33SE2FUVWC3RUWX7VZITXS2TZDN"


# --------------------------------------------------------------------------- TRON
def test_tron_discover_maps_trc20_known_symbol():
    adapter = TronAdapter(api="http://x", get=lambda path: json.dumps({"data": [{USDT_TRC20: "5000000"}]}))
    rows = adapter.discover_tokens("TXYZ")
    assert len(rows) == 1
    b = rows[0]
    assert (b.asset.chain, b.asset.kind, b.asset.symbol, b.asset.decimals, b.asset.address) == \
        ("tron", "trc20", "USDT", 6, USDT_TRC20)
    assert (b.confirmed, b.display) == ("5000000", "5")


def test_tron_discover_drops_zero_and_tolerates_errors():
    assert TronAdapter(api="http://x", get=lambda p: json.dumps({"data": [{USDT_TRC20: "0"}]})).discover_tokens("T") == []
    assert TronAdapter(api="http://x", get=lambda p: json.dumps({"data": []})).discover_tokens("T") == []

    def boom(_):
        raise RuntimeError("offline")
    assert TronAdapter(api="http://x", get=boom).discover_tokens("T") == []


# --------------------------------------------------------------------------- TON
def test_ton_discover_maps_jetton_balances():
    body = json.dumps({"balances": [{"balance": "3000000",
                                      "jetton": {"address": USDT_JETTON, "symbol": "USDT", "decimals": 6}}]})
    adapter = TonAdapter(api="http://x/api/v2", get=lambda url: body)
    rows = adapter.discover_tokens("EQowner")
    assert len(rows) == 1
    b = rows[0]
    assert (b.asset.chain, b.asset.kind, b.asset.symbol, b.asset.decimals, b.asset.address) == \
        ("ton", "jetton", "USDT", 6, USDT_JETTON)
    assert (b.confirmed, b.display) == ("3000000", "3")


def test_ton_discover_toncenter_v3_shape_and_errors():
    body = json.dumps({"jetton_wallets": [{"balance": "0", "jetton": "EQz"},
                                          {"balance": "42", "jetton": "EQm"}],
                       "metadata": {"EQm": {"token_info": [{"symbol": "JUSD", "decimals": 2}]}}})
    rows = TonAdapter(api="http://x/api/v2", get=lambda url: body).discover_tokens("EQo")
    assert len(rows) == 1
    assert (rows[0].asset.symbol, rows[0].asset.decimals, rows[0].confirmed, rows[0].display) == ("JUSD", 2, "42", "0.42")

    def boom(_):
        raise RuntimeError("offline")
    assert TonAdapter(api="http://x/api/v2", get=boom).discover_tokens("EQo") == []


# ------------------------------------------------------------------------ STELLAR
def test_stellar_discover_maps_non_native_trustlines():
    body = json.dumps({"balances": [
        {"asset_type": "native", "balance": "10.0000000"},
        {"asset_type": "credit_alphanum4", "asset_code": "USDC", "asset_issuer": USDC_ISSUER, "balance": "12.5000000"},
        {"asset_type": "credit_alphanum4", "asset_code": "ZERO", "asset_issuer": "GAZERO", "balance": "0.0000000"},
    ]})
    adapter = StellarAdapter(horizon="http://x", http_get=lambda path: body)
    rows = adapter.discover_tokens("GABC")
    assert len(rows) == 1
    b = rows[0]
    assert (b.asset.chain, b.asset.kind, b.asset.symbol, b.asset.decimals, b.asset.address) == \
        ("stellar", "stellar-asset", "USDC", 7, f"USDC:{USDC_ISSUER}")
    assert (b.confirmed, b.display) == ("125000000", "12.5")


def test_stellar_discover_tolerates_errors():
    def boom(_):
        raise RuntimeError("offline")
    assert StellarAdapter(horizon="http://x", http_get=boom).discover_tokens("GABC") == []


# ------------------------------------------------------------------------ CARDANO
def test_cardano_discover_aggregates_native_assets():
    policy = "ab" * 28  # 56-hex policy id
    unit = policy + "54455354"  # assetName 'TEST'
    utxos = [
        {"tx_hash": "aa", "tx_index": 0, "value": "2000000",
         "asset_list": [{"policy_id": policy, "asset_name": "54455354", "quantity": "4"}]},
        {"tx_hash": "bb", "tx_index": 1, "value": "2000000",
         "asset_list": [{"policy_id": policy, "asset_name": "54455354", "quantity": "3"}]},
    ]

    def http_post(path, body, content_type=None):
        return json.dumps(utxos)

    adapter = CardanoAdapter(koios="http://x", http_post=http_post)
    rows = adapter.discover_tokens("addr1xyz")
    assert len(rows) == 1
    b = rows[0]
    assert (b.asset.chain, b.asset.kind, b.asset.symbol, b.asset.decimals, b.asset.address) == \
        ("cardano", "native-asset", "TEST", 0, unit)
    assert (b.confirmed, b.display) == ("7", "7")


def test_cardano_discover_empty_and_errors():
    def empty(path, body, content_type=None):
        return json.dumps([{"tx_hash": "aa", "tx_index": 0, "value": "2000000", "asset_list": []}])
    assert CardanoAdapter(koios="http://x", http_post=empty).discover_tokens("addr1") == []

    def boom(path, body, content_type=None):
        raise RuntimeError("offline")
    assert CardanoAdapter(koios="http://x", http_post=boom).discover_tokens("addr1") == []
