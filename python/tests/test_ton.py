"""TON (native + USDT jetton) golden-vector gate for the Qt/Python port.

Mirrors blockle-extension/ton.test.js + blockle-app/test/multichain/ton_test.dart.
TON is the hardest chain: the v4R2 address IS cell_hash(StateInit) and the
signature signs cell_hash(signing_cell), so every value cascades from the cell
representation hash. Asserts every value in docs/ton-vectors.json byte-identically
(SLIP-0010 ed25519 m/44'/607'/0', the v4R2 code/data/StateInit cell hashes, the
address codec, the client-built signed external-message BOC — native + jetton).
No network, no external deps.
"""
import json
import os

import pytest

from blockle.multichain import crypto as K
from blockle.multichain.chains import ton as TON
from blockle.multichain.chains import ton_cell as TC
from blockle.multichain.chains.registry import create_registry

ED = K.ed25519


def _fixture():
    p = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "ton-vectors.json")
    with open(p) as f:
        return json.load(f)


V = _fixture()
SUB = V["network"]["subwalletId"]


def _seed():
    return K.mnemonic_to_seed(V["mnemonic"], V.get("passphrase", ""))


def _key_pub():
    key = K.slip10.derive(_seed(), V["path"]).key
    return key, ED.public_key(key)


def test_crc_kats():
    for text, hexv in V["crcKats"]["crc16ccitt"]:
        assert "0x" + TC.crc16_ccitt(text.encode()).hex() == hexv
    for text, hexv in V["crcKats"]["crc32c"]:
        le = TC.crc32c(text.encode())
        be = bytes([le[3], le[2], le[1], le[0]]).hex()
        assert "0x" + be == hexv


def test_key_and_pubkey_rederive():
    key, pub = _key_pub()
    assert key.hex() == V["key"]["ed25519Seed32Hex"]
    assert pub.hex() == V["key"]["publicKeyHex"]


def test_v4r2_cell_hashes():
    _, pub = _key_pub()
    assert TC.V4R2_CODE_BASE64 == V["v4r2"]["codeBocBase64"]
    assert TC.v4r2_code_cell().hash().hex() == V["v4r2"]["codeCellHashHex"]
    assert TC.v4r2_data_cell(pub, SUB).hash().hex() == V["v4r2"]["dataCellHashHex"]
    assert TC.v4r2_state_init(pub, SUB).hash().hex() == V["v4r2"]["stateInitCellHashHex"]


def test_address_encodings():
    h = bytes.fromhex(V["v4r2"]["stateInitCellHashHex"])
    assert TC.format_address(0, h) == V["v4r2"]["addressBounceable"]
    assert TC.format_address(0, h, bounceable=False) == V["v4r2"]["addressNonBounceable"]
    assert TC.format_address(0, h, test_only=True) == V["v4r2"]["addressTestnet"]
    assert TC.raw_address(0, h) == V["v4r2"]["rawAddress"]


def test_address_spec_vectors_round_trip():
    for raw, friendly in V["addressSpecVectors"]:
        pf = TC.parse_address(friendly)
        assert TC.raw_address(pf["workchain"], pf["hash"]) == raw
        pr = TC.parse_address(raw)
        assert TC.format_address(pr["workchain"], pr["hash"]) == friendly
        assert TC.is_ton_address(friendly)
        assert TC.is_ton_address(raw)
    assert not TC.is_ton_address("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
    assert not TC.is_ton_address("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
    assert not TC.is_ton_address("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH")


def test_native_signed_external_message_byte_exact():
    key, pub = _key_pub()
    tx = V["tx"]
    built = TON.build_native_external(
        pub, key, TC.parse_address(tx["dest"]), tx["amount"], tx["seqno"],
        comment=tx["comment"], bounce=tx["bounce"], valid_until=tx["validUntil"], subwallet=SUB)
    assert built["internal_msg"].hash().hex() == tx["intMsgCellHashHex"]
    assert built["signing_cell"].hash().hex() == tx["signingCellHashHex"]
    assert built["signature"].hex() == tx["expected"]["signatureHex"]
    assert ED.verify(built["signing_cell"].hash(), built["signature"], pub)
    assert built["boc"] == tx["expected"]["externalMessageBocBase64"]
    assert built["hash"] == tx["expected"]["externalMessageBocHashHex"]


def test_jetton_signed_external_message_byte_exact():
    key, pub = _key_pub()
    jt = V["jettonTx"]
    built = TON.build_jetton_external(
        pub, key, TC.parse_address(jt["ownerJettonWallet"]), TC.parse_address(jt["dest"]),
        TC.parse_address(jt["responseDest"]), jt["amount"], jt["seqno"],
        fwd_amount=jt["fwdAmount"], gas=jt["gasAmount"], valid_until=jt["validUntil"], subwallet=SUB)
    assert "0x" + format(TON.JETTON_TRANSFER_OP, "08x") == jt["op"]
    assert built["jetton_body"].hash().hex() == jt["jettonBodyCellHashHex"]
    assert built["internal_msg"].hash().hex() == jt["intMsgCellHashHex"]
    assert built["signing_cell"].hash().hex() == jt["signingCellHashHex"]
    assert built["signature"].hex() == jt["expected"]["signatureHex"]
    assert ED.verify(built["signing_cell"].hash(), built["signature"], pub)
    assert built["boc"] == jt["expected"]["externalMessageBocBase64"]
    assert built["hash"] == jt["expected"]["externalMessageBocHashHex"]


def test_boc_round_trips():
    key, pub = _key_pub()
    tx = V["tx"]
    built = TON.build_native_external(
        pub, key, TC.parse_address(tx["dest"]), tx["amount"], tx["seqno"],
        comment=tx["comment"], bounce=tx["bounce"], valid_until=tx["validUntil"], subwallet=SUB)
    decoded = TC.parse_boc(TC.from_base64(built["boc"]))[0]
    assert decoded.hash().hex() == built["hash"]


def test_registry_ton_wired():
    reg = create_registry({})
    assert reg.has("ton")
    assert "ton" in reg.enabled()
    assert reg.endpoints("ton")["api"] == "https://toncenter.com/api/v2"
    toks = reg.tokens_for("ton")
    assert any(t.kind == "jetton" and t.symbol == "USDT"
               and t.address == V["network"]["jettonMasters"]["USDT"] for t in toks)
    acct = reg.get("ton").derive_account({"seed": _seed()})
    assert acct.scheme == "ed25519"
    assert acct.path == V["path"]
    assert acct.address == V["v4r2"]["addressBounceable"]


def test_build_send_client_built_reproduces_golden():
    # Inject a toncenter transport answering seqno=0 — the only node input.
    def post(path, body):
        return json.dumps({"ok": True, "result": {"stack": [["num", "0x0"]]}})

    adapter = TON.create_ton_adapter(post=post)
    adapter.unlock({"seed": _seed()})
    acct = adapter.derive_account({"seed": _seed()})
    tx = V["tx"]
    built = adapter.build_send(acct, {"to": tx["dest"], "amount": tx["amount"]})
    assert built.raw == tx["expected"]["externalMessageBocBase64"]
    assert built.txid == tx["expected"]["externalMessageBocHashHex"]
    assert built.extra["kind"] == "send"
    assert built.extra["seqno"] == 0
