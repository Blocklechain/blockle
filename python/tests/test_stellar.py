"""Stellar (native XLM + issued AlphaNum4) golden-vector gate for the Qt/Python port.

Mirrors blockle-extension/chains/stellar.test.js + the Flutter stellar_test.dart.
Asserts every value in docs/stellar-vectors.json byte-identically: SLIP-0010
ed25519 m/44'/148'/0' -> strkey 'G…' (base32(0x30||pub||crc16xmodem-LE)), and the
client-built v1 TransactionEnvelope XDR signed ed25519 over the tx hash =
SHA256(networkId||ENVELOPE_TYPE_TX||txXDR), plus an AlphaNum4 issued-asset
variant. The vector itself was cross-checked byte-identically against
@stellar/stellar-base / stellar-sdk. No network, no extra deps.
"""
import json
import os

import pytest

from blockle.multichain import crypto as K
from blockle.multichain.chains import stellar as STELLAR
from blockle.multichain.chains import stellar_xdr as SX
from blockle.multichain.chains.registry import create_registry

ED = K.ed25519


def _fixture():
    p = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "stellar-vectors.json")
    with open(p) as f:
        return json.load(f)


V = _fixture()


def _seed():
    return K.mnemonic_to_seed(V["mnemonic"], V.get("passphrase", ""))


def _key_pub():
    key = K.slip10.derive(_seed(), V["path"]).key
    return key, ED.public_key(key)


def test_crc_kat_and_network_id():
    for text, val in V["crcKats"]:
        assert SX.crc16_xmodem(text.encode()) == val
    assert SX.network_id().hex() == V["network"]["networkIdHex"]


def test_key_pub_address_rederive():
    key, pub = _key_pub()
    assert key.hex() == V["expected"]["seedKeyHex"]
    assert pub.hex() == V["expected"]["pubkeyHex"]
    assert SX.encode_ed25519_public_key(pub) == V["expected"]["address"]


def test_address_spec_vectors_round_trip():
    for pub_hex, addr in V["addressSpecVectors"]:
        assert SX.encode_ed25519_public_key(bytes.fromhex(pub_hex)) == addr
        assert SX.decode_ed25519_public_key(addr).hex() == pub_hex
        assert SX.is_stellar_address(addr)
    assert not SX.is_stellar_address("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
    assert not SX.is_stellar_address("rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3")


def _check_envelope(section, asset_xdr=None):
    key, pub = _key_pub()
    f = section["fields"]
    dest = SX.decode_ed25519_public_key(f["op"]["destination"])
    ops = [SX.payment_op(dest, int(f["op"]["amountStroops"]), asset_xdr)]
    built = SX.build_signed_envelope(pub, key, int(f["sequence"]), ops, fee=f["fee"])
    import base64
    assert base64.b64decode(section["txXDRunsignedBase64"]).hex() == built["txXDRunsignedHex"]
    assert built["hash"] == section["signingPayloadHex"]
    assert built["hash"] == section["expected"]["hash"]
    assert built["signatureHex"] == section["expected"]["signatureHex"]
    assert built["hint"] == section["expected"]["hint"]
    assert built["envelopeXDRBase64"] == section["expected"]["envelopeXDRBase64"]
    assert ED.verify(bytes.fromhex(built["hash"]), bytes.fromhex(built["signatureHex"]), pub)


def test_native_signed_envelope_byte_exact_and_verifies():
    _check_envelope(V["tx"])


def test_issued_alphanum4_signed_envelope_byte_exact():
    op = V["assetTx"]["fields"]["op"]
    issuer = SX.decode_ed25519_public_key(op["asset"]["issuer"])
    _check_envelope(V["assetTx"], SX.asset_alphanum4(op["asset"]["code"], issuer))


def test_registry_stellar_wired():
    reg = create_registry({})
    assert reg.has("stellar")
    assert "stellar" in reg.enabled()
    assert reg.endpoints("stellar")["horizon"] == V["network"]["horizon"]
    acct = reg.get("stellar").derive_account({"seed": _seed()})
    assert acct.scheme == "ed25519"
    assert acct.path == V["path"]
    assert acct.address == V["expected"]["address"]


def test_build_send_client_built_reproduces_golden():
    tx = V["tx"]
    seq = int(tx["fields"]["sequence"])

    def http_get(path):
        return json.dumps({"sequence": str(seq - 1),
                           "balances": [{"asset_type": "native", "balance": "10.0000000"}]})

    def http_post(path, body, content_type=None):
        return json.dumps({"successful": True, "hash": tx["expected"]["hash"]})

    adapter = STELLAR.create_stellar_adapter(http_get=http_get, http_post=http_post)
    adapter.unlock({"seed": _seed()})
    acct = adapter.derive_account({"seed": _seed()})
    built = adapter.build_send(acct, {"to": tx["fields"]["op"]["destination"],
                                      "amount": tx["fields"]["op"]["amountStroops"]})
    assert built.raw == tx["expected"]["envelopeXDRBase64"]
    assert built.txid == tx["expected"]["hash"]
    assert built.extra["sequence"] == seq
    res = adapter.broadcast(built)
    assert res.accepted and res.txid == tx["expected"]["hash"]


def test_invalid_destination_rejected():
    adapter = STELLAR.create_stellar_adapter(
        http_get=lambda p: "{}", http_post=lambda p, b, content_type=None: "{}")
    adapter.unlock({"seed": _seed()})
    acct = adapter.derive_account({"seed": _seed()})
    with pytest.raises(ValueError):
        adapter.build_send(acct, {"to": "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3", "amount": "1000000"})
