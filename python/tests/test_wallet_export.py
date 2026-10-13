"""WALLET EXPORT (docs/WALLET-EXPORT.md).

Asserts the Python port (``blockle.multichain.export``) against the
AUTHORITATIVE shared vectors (``docs/wallet-export-vectors.json``) that the
extension + Flutter ports also reproduce: the fixed seed -> exact WIF
(btc/ltc/doge) + EVM 0x-hex + Solana base58 keys, and the exact Core
``importwallet`` dump lines. Plus: WIF round-trips to the same key+address;
each dump WIF matches its stated address; the gate blocks export while locked
and on a declined confirm; and NO secret is ever logged or sent.
"""

import json
from pathlib import Path

import pytest

from blockle.multichain import export as WX
from blockle.multichain import crypto as K
from blockle.multichain.crypto import ed25519 as ED
from blockle.multichain.crypto import secp256k1 as S
from blockle.multichain.chains.utxo import NETWORKS


def _load_vectors() -> dict:
    # tests/ -> python/ -> repo root -> docs/wallet-export-vectors.json
    root = Path(__file__).resolve().parents[2]
    with open(root / "docs" / "wallet-export-vectors.json", encoding="utf-8") as f:
        return json.load(f)


V = _load_vectors()


def _address_from_wif(chain_id: str, wif: str) -> str:
    """Re-derive an address from a WIF exactly as a recovering wallet would."""
    net = NETWORKS[chain_id]
    dec = K.from_wif(wif)
    pub = S.public_key(dec["private_key"], True)
    if net["segwit"]:
        return K.p2wpkh(pub, net["hrp"])
    return K.p2pkh(pub, net["p2pkh"])


# ===========================================================================
# 1. PORT === VECTORS  (the cross-wallet contract, BYTE-FOR-BYTE)
# ===========================================================================
def test_from_mnemonic_reproduces_vector_seed_hex():
    r = WX.from_mnemonic(V["mnemonic"], V["passphrase"])
    assert r["seedHex"] == V["seedHex"]


def test_private_keys_reproduce_every_vector_key_address_path():
    k = WX.private_keys(V["seedHex"], V["accountIndex"])
    for c in ("bitcoin", "litecoin", "dogecoin"):
        assert k[c]["wif"] == V["keys"][c]["wif"], f"{c} wif"
        assert k[c]["address"] == V["keys"][c]["address"], f"{c} address"
        assert k[c]["wifVersion"] == V["keys"][c]["wifVersion"], f"{c} wif version byte"
        assert k[c]["publicKey"] == V["keys"][c]["publicKey"], f"{c} pubkey"
        assert k[c]["path"] == V["paths"][c], f"{c} path"
    assert k["evm"]["privateKey"] == V["keys"]["evm"]["privateKey"]
    assert k["evm"]["address"] == V["keys"]["evm"]["address"]
    assert k["evm"]["publicKey"] == V["keys"]["evm"]["publicKey"]
    assert k["evm"]["path"] == V["paths"]["evm"]
    assert k["solana"]["secretKey"] == V["keys"]["solana"]["secretKey"]
    assert k["solana"]["address"] == V["keys"]["solana"]["address"]
    assert k["solana"]["publicKey"] == V["keys"]["solana"]["publicKey"]
    assert k["solana"]["path"] == V["paths"]["solana"]


def test_wif_version_bytes_are_chain_correct():
    assert V["keys"]["bitcoin"]["wifVersion"] == 0x80
    assert V["keys"]["litecoin"]["wifVersion"] == 0xB0
    assert V["keys"]["dogecoin"]["wifVersion"] == 0x9E
    for c in ("bitcoin", "litecoin", "dogecoin"):
        assert K.from_wif(V["keys"][c]["wif"])["version"] == V["keys"][c]["wifVersion"], c


def test_core_dump_reproduces_exact_vector_text():
    for c in ("bitcoin", "litecoin", "dogecoin"):
        text = WX.core_dump(c, V["seedHex"], {"indices": [V["accountIndex"]], "time": V["dumpTime"]})
        assert text == V["coreDumps"][c]["text"], f"{c} dump BYTE-FOR-BYTE"
        assert WX.core_dump_filename(c) == V["coreDumps"][c]["filename"], f"{c} filename"
        assert text.startswith("# Wallet dump"), f"{c} header"


# ===========================================================================
# 2. WIF ROUND-TRIP — decode back to the SAME key + address
# ===========================================================================
def test_each_wif_round_trips_to_same_key_and_address():
    k = WX.private_keys(V["seedHex"], V["accountIndex"])
    for c in ("bitcoin", "litecoin", "dogecoin"):
        dec = K.from_wif(k[c]["wif"])
        assert dec["compressed"] is True, f"{c} WIF compressed"
        assert K.to_wif(dec["private_key"], dec["version"], True) == k[c]["wif"], f"{c} re-encode"
        assert _address_from_wif(c, k[c]["wif"]) == k[c]["address"], f"{c} addr from WIF"


# ===========================================================================
# 3. DUMP INTEGRITY — every dump WIF matches its stated addr=
# ===========================================================================
def test_each_dump_wif_matches_its_stated_address():
    for c in ("bitcoin", "litecoin", "dogecoin"):
        parsed = WX.parse_dump(V["coreDumps"][c]["text"])
        assert len(parsed) >= 1, f"{c} >=1 key line"
        for row in parsed:
            assert row["wif"] and row["address"], f"{c} line has WIF + addr"
            assert _address_from_wif(c, row["wif"]) == row["address"], f"{c} dump WIF -> addr"
            assert row["hdkeypath"].startswith("m/"), f"{c} hdkeypath"


# ===========================================================================
# 4. SOLANA + EVM key integrity
# ===========================================================================
def test_solana_secret_decodes_to_seed_pubkey_and_matches_address():
    secret = K.base58decode(V["keys"]["solana"]["secretKey"])
    assert len(secret) == 64
    seed_part, pub_part = secret[:32], secret[32:]
    pub = ED.public_key(seed_part)
    assert pub.hex() == pub_part.hex(), "secret tail === pubkey"
    assert K.base58encode(pub) == V["keys"]["solana"]["address"], "pubkey -> address"


def test_evm_hex_private_key_rederives_checksummed_address():
    priv = K.hex_to_bytes(V["keys"]["evm"]["privateKey"].replace("0x", "", 1))
    pub = S.public_key(priv, True)
    assert K.evm_address(pub) == V["keys"]["evm"]["address"]


# ===========================================================================
# 5. THE SECURITY GATE — blocks while locked / on declined confirm
# ===========================================================================
def test_gate_blocks_while_locked():
    calls = {"confirm": False}

    def confirm(_w):
        calls["confirm"] = True
        return True

    g = WX.gate({"unlocked": False, "confirm": confirm})
    assert g["allowed"] is False
    assert g["reason"] == "locked"
    assert calls["confirm"] is False, "a locked vault never even asks to confirm"
    assert "DANGER" in g["warning"]


def test_gate_blocks_on_declined_confirm():
    g = WX.gate({"unlocked": True, "confirm": lambda _w: False})
    assert g["allowed"] is False
    assert g["reason"] == "declined"


def test_gate_fails_closed_with_no_confirm_handler():
    g = WX.gate({"unlocked": True})
    assert g["allowed"] is False
    assert g["reason"] == "no-confirm-handler"


def test_gate_allows_only_when_unlocked_and_confirmed():
    shown = {}

    def confirm(w):
        shown["w"] = w
        return True

    g = WX.gate({"unlocked": True, "confirm": confirm})
    assert g["allowed"] is True
    assert g["reason"] == "confirmed"
    assert shown["w"] == WX.DANGER_WARNING


def test_export_secrets_returns_no_material_when_blocked():
    locked = WX.export_secrets({"unlocked": False, "mnemonic": V["mnemonic"], "confirm": lambda _w: True})
    assert locked["ok"] is False
    assert "keys" not in locked
    assert "mnemonic" not in locked

    declined = WX.export_secrets({"unlocked": True, "mnemonic": V["mnemonic"], "confirm": lambda _w: False})
    assert declined["ok"] is False
    assert "keys" not in declined


def test_export_secrets_unlocked_confirmed_yields_vector_keys_and_dumps():
    r = WX.export_secrets({
        "unlocked": True, "confirm": lambda _w: True,
        "mnemonic": V["mnemonic"], "passphrase": V["passphrase"],
        "index": V["accountIndex"], "coreDumps": True, "indices": [V["accountIndex"]],
    })
    assert r["ok"] is True
    assert r["mnemonic"]["seedHex"] == V["seedHex"]
    assert r["keys"]["bitcoin"]["wif"] == V["keys"]["bitcoin"]["wif"]
    assert r["keys"]["evm"]["privateKey"] == V["keys"]["evm"]["privateKey"]
    assert r["keys"]["solana"]["secretKey"] == V["keys"]["solana"]["secretKey"]
    for c in ("bitcoin", "litecoin", "dogecoin"):
        rows = WX.parse_dump(r["dumps"][c]["text"])
        assert _address_from_wif(c, rows[0]["wif"]) == V["keys"][c]["address"], c


def test_block_native_key_export_from_session():
    assert WX.block_key(None) is None
    assert WX.block_key({"address": "blk1..."}) is None  # no secret
    b = WX.block_key({"secretKeyHex": "aa" * 32, "publicKeyHex": "bb" * 32, "address": "blk1xyz"})
    assert b["scheme"] == "ml-dsa-44"
    assert b["secretKey"] == "aa" * 32
    assert b["publicKey"] == "bb" * 32
    assert b["address"] == "blk1xyz"


# ===========================================================================
# 6. NO SECRET IS LOGGED OR SENT
# ===========================================================================
def test_export_never_logs_a_secret_and_never_touches_network(capsys, monkeypatch):
    secrets = [V["seedHex"], V["mnemonic"], V["keys"]["bitcoin"]["wif"],
               V["keys"]["litecoin"]["wif"], V["keys"]["dogecoin"]["wif"],
               V["keys"]["evm"]["privateKey"], V["keys"]["solana"]["secretKey"]]

    sent = []
    # Any accidental network call would go through urllib — trip it.
    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: sent.append(a) or (_ for _ in ()).throw(RuntimeError("network blocked")))

    r = WX.export_secrets({
        "unlocked": True, "confirm": lambda _w: True,
        "mnemonic": V["mnemonic"], "passphrase": V["passphrase"], "coreDumps": True,
    })
    assert r["ok"] is True

    out = capsys.readouterr()
    haystack = out.out + "\n" + out.err
    for s in secrets:
        assert s not in haystack, "a secret leaked into stdout/stderr"
    assert sent == [], "export made a network call"
