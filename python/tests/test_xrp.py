"""XRP (native) golden-vector gate for the Qt/Python port.

Mirrors blockle-extension/chains/xrp.test.js + the Flutter xrp_test.dart.
Asserts every value in docs/xrp-vectors.json byte-identically: secp256k1 BIP44
m/44'/144'/0'/0/0 -> compressed pub -> ripple-base58check 'r…', and the
client-built XRPL-binary-codec Payment (signing data = 'STX\\0'||tx-without-sig)
signed with SHA512-half -> low-S DER TxnSignature -> signed tx_blob, plus a
DestinationTag variant. The vector itself was cross-checked byte-identically
against ripple-binary-codec / xrpl-py. No network, no extra deps.
"""
import json
import os

import pytest

from blockle.multichain import crypto as K
from blockle.multichain.chains import xrp as XRP
from blockle.multichain.chains import xrpl_codec as X
from blockle.multichain.chains.registry import create_registry


def _fixture():
    p = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "xrp-vectors.json")
    with open(p) as f:
        return json.load(f)


V = _fixture()


def _seed():
    return K.mnemonic_to_seed(V["mnemonic"], V.get("passphrase", ""))


def _node():
    return K.derive_path(_seed(), V["path"])


def test_key_pub_address_rederive():
    n = _node()
    assert n.private_key.hex() == V["expected"]["privKeyHex"]
    assert n.public_key.hex() == V["expected"]["pubkeyHexCompressed"]
    assert X.account_id_from_pubkey(n.public_key).hex() == V["expected"]["accountIdHex"]
    assert X.classic_address(n.public_key) == V["expected"]["classicAddress"]


def test_address_spec_vectors_round_trip():
    for acct_hex, addr in V["addressSpecVectors"]:
        assert X.address_from_account_id(bytes.fromhex(acct_hex)) == addr
        assert X.account_id_from_address(addr).hex() == acct_hex
        assert X.is_xrp_address(addr)
    assert not X.is_xrp_address("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
    assert not X.is_xrp_address("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH")
    assert not X.is_xrp_address("GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX")


def _check_signed_tx(section):
    n = _node()
    f = section["fields"]
    fields = X.build_payment_fields(
        f["Account"], f["Destination"], f["Amount"], f["Fee"], f["Sequence"],
        f["LastLedgerSequence"], n.public_key.hex(), flags=f["Flags"],
        destination_tag=f.get("DestinationTag"))
    # signing data = 'STX\0' || serialize(fields, for_signing=True)
    signing_data = X.STX_PREFIX + X.serialize(fields, for_signing=True)
    assert signing_data.hex() == section["signingDataHex"]
    built = X.build_signed_payment(fields, n.private_key)
    assert built["txnSignatureDerHex"] == section["expected"]["txnSignatureDerHex"]
    assert built["txBlobHex"] == section["expected"]["txBlobHex"]
    assert built["hash"] == section["expected"]["hash"]
    from coincurve import PublicKey
    assert PublicKey(n.public_key).verify(
        bytes.fromhex(built["txnSignatureDerHex"]), X.sha512_half(signing_data), hasher=None)


def test_signed_payment_byte_exact_and_verifies():
    _check_signed_tx(V["tx"])


def test_signed_payment_with_destination_tag_byte_exact():
    _check_signed_tx(V["txWithTag"])


def test_registry_xrp_wired():
    reg = create_registry({})
    assert reg.has("xrp")
    assert "xrp" in reg.enabled()
    assert reg.endpoints("xrp")["rpc"] == V["network"]["endpoint"]
    acct = reg.get("xrp").derive_account({"seed": _seed()})
    assert acct.scheme == "secp256k1"
    assert acct.path == V["path"]
    assert acct.address == V["expected"]["classicAddress"]


def test_build_send_client_built_reproduces_golden():
    tx = V["tx"]
    seq = tx["fields"]["Sequence"]
    last_ledger = tx["fields"]["LastLedgerSequence"]

    def post(body):
        m = body.get("method")
        if m == "account_info":
            return json.dumps({"result": {"account_data": {"Sequence": seq, "Balance": "100000000"}}})
        if m == "ledger_current":
            return json.dumps({"result": {"ledger_current_index": last_ledger - XRP.LEDGER_OFFSET}})
        if m == "submit":
            return json.dumps({"result": {"engine_result": "tesSUCCESS",
                                          "tx_json": {"hash": tx["expected"]["hash"]}}})
        return json.dumps({"result": {}})

    adapter = XRP.create_xrp_adapter(post=post)
    adapter.unlock({"seed": _seed()})
    acct = adapter.derive_account({"seed": _seed()})
    built = adapter.build_send(acct, {"to": tx["fields"]["Destination"], "amount": tx["fields"]["Amount"]})
    assert built.raw == tx["expected"]["txBlobHex"]
    assert built.txid == tx["expected"]["hash"]
    assert built.extra["sequence"] == seq
    assert built.extra["lastLedgerSequence"] == last_ledger
    res = adapter.broadcast(built)
    assert res.accepted and res.txid == tx["expected"]["hash"]


def test_invalid_destination_rejected():
    adapter = XRP.create_xrp_adapter(post=lambda body: json.dumps({"result": {}}))
    adapter.unlock({"seed": _seed()})
    acct = adapter.derive_account({"seed": _seed()})
    with pytest.raises(ValueError):
        adapter.build_send(acct, {"to": "0xdeadbeef", "amount": "1000000"})
