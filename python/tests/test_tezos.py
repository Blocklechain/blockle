"""Tezos (native XTZ) golden-vector gate for the Qt/Python port.

Mirrors blockle-extension/tezos.test.js + web/wallet/vendor/tezos.test.js + the
Flutter test/multichain/tezos_test.dart. Asserts every value in
docs/tezos-vectors.json byte-identically: the blake2b primitive (20/32), the
zarith LEB128 varint, the contract-id encoding per address family, SLIP-0010
ed25519 m/44'/1729'/0'/0' -> edpk -> tz1, and the client-forged single
'transaction' manager op (branch||0x6c||pkh(source)||zarith…||contractId||0x00)
signed ed25519 over blake2b(0x03||forged,32), plus edsig + injection payload.
No network, no extra deps (blake2b is stdlib hashlib).
"""
import json
import os

import pytest

from blockle.multichain import crypto as K
from blockle.multichain.chains import tezos as TEZOS
from blockle.multichain.chains import tezos_forge as TZ
from blockle.multichain.chains.registry import create_registry

ED = K.ed25519


def _fixture():
    p = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "tezos-vectors.json")
    with open(p) as f:
        return json.load(f)


V = _fixture()


def _seed():
    return K.mnemonic_to_seed(V["mnemonic"], V.get("passphrase", ""))


def _key_pub():
    key = K.slip10.derive(_seed(), V["path"]).key
    return key, ED.public_key(key)


def test_blake2b_kats():
    for text, hex_out, length in V["blake2bKats"]:
        assert TZ.blake2b(text.encode(), length).hex() == hex_out


def test_zarith_kats():
    for n, hex_out in V["zarithKats"]:
        assert TZ.zarith(n).hex() == hex_out


def test_contract_id_per_family():
    for addr, hex_out in V["destinationKats"]:
        assert TZ.contract_id(addr).hex() == hex_out


def test_key_edpk_tz1_rederive():
    key, pub = _key_pub()
    assert key.hex() == V["expected"]["seedKeyHex"]
    assert pub.hex() == V["expected"]["edpkPubkeyHex"]
    assert TZ.edpk(pub) == V["expected"]["edpk"]
    assert TZ.tz1(pub) == V["expected"]["address"]


def test_address_spec_vectors_and_validation():
    for pub_hex, addr in V["addressSpecVectors"]:
        assert TZ.tz1(bytes.fromhex(pub_hex)) == addr
        assert TZ.is_tz1(addr)
        assert TZ.is_tezos_destination(addr)
    for addr, _ in V["destinationKats"]:
        assert TZ.is_tezos_destination(addr)
    assert not TZ.is_tz1("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
    assert not TZ.is_tezos_destination("GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX")
    assert not TZ.is_tezos_destination("rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3")


def test_forge_sign_byte_exact_and_verifies():
    key, pub = _key_pub()
    built = TEZOS.build_signed_transaction(V["tx"]["fields"], key)
    exp = V["tx"]["expected"]
    assert built["forgedHex"] == exp["forgedHex"]
    assert built["signingHashHex"] == exp["signingHashHex"]
    assert built["signatureHex"] == exp["signatureHex"]
    assert built["edsig"] == exp["edsig"]
    assert built["injectionHex"] == exp["injectionHex"]
    assert ED.verify(bytes.fromhex(built["signingHashHex"]), built["signature"], pub)


def test_adapter_build_send_offline_byte_exact():
    seed = _seed()
    counter_minus1 = str(int(V["tx"]["fields"]["counter"]) - 1)

    def http_get(path):
        if path.endswith("/hash"):
            return '"' + V["tx"]["fields"]["branch"] + '"'
        if path.endswith("/counter"):
            return '"' + counter_minus1 + '"'
        if path.endswith("/balance"):
            return '"5000000"'
        raise AssertionError("unexpected GET " + path)

    def http_post(path, body, content_type="application/json"):
        return '"ooGoldenInjectedOpHash"'

    a = TEZOS.create_tezos_adapter(http_get=http_get, http_post=http_post)
    a.unlock(seed)
    acct = a.derive_account({"seed": seed}, 0)
    assert acct.address == V["expected"]["address"]
    assert acct.scheme == "ed25519"
    with pytest.raises(ValueError):
        a.build_send(acct, {"to": "not-a-tezos-address", "amount": "1"})
    built = a.build_send(acct, {
        "to": V["tx"]["fields"]["destination"], "amount": V["tx"]["fields"]["amount"],
        "fee": V["tx"]["fields"]["fee"], "gasLimit": V["tx"]["fields"]["gas_limit"],
        "storageLimit": V["tx"]["fields"]["storage_limit"],
    })
    assert built.raw == V["tx"]["expected"]["injectionHex"]
    bc = a.broadcast(built)
    assert bc.txid == "ooGoldenInjectedOpHash"
    assert bc.accepted
    bal = a.get_balance(acct.address)
    assert bal[0].display == "5"


def test_registry_wiring():
    reg = create_registry({})
    assert reg.has("tezos")
    assert "tezos" in reg.enabled()
    assert reg.endpoints("tezos")["rpc"] == "https://mainnet.api.tez.ie"
    acct = reg.get("tezos").derive_account({"seed": _seed()})
    assert acct.scheme == "ed25519"
    assert acct.address == V["expected"]["address"]
