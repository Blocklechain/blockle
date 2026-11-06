"""Cardano (native ADA) golden-vector gate for the Qt/Python port.

Mirrors the intended blockle-extension/cardano.test.js + web vendor + Flutter
test/multichain/cardano_test.dart. Asserts every value in
docs/cardano-vectors.json byte-identically:
  * blake2b-224 / blake2b-256 KATs (stdlib hashlib)
  * canonical definite-length CBOR KATs (uint / bstr / array / map)
  * Icarus (CIP-3) master key from BIP39 ENTROPY (PBKDF2 salt=entropy, clamp)
  * CIP-1852 BIP32-Ed25519 payment + stake pubkeys (full-256-bit kL additive)
  * Shelley base address (blake2b-224 creds, header 0x01, bech32 'addr') + its
    validation (reject non-addr1 / wrong network / bad checksum)
  * the client-forged tx_body CBOR -> blake2b-256 txHash -> signExtended over
    the payment extended key -> full signed-tx CBOR, each BYTE-EXACT, and the
    extended signature VERIFIES under standard RFC8032 ed25519.verify
  * the adapter's build_send reproducing the signed-tx bytes OFFLINE (Koios
    stubbed), plus broadcast + balance, and the registry wiring / moonpay.

Cross-checked against the independent bip_utils (CardanoIcarus/Cip1852) ref for
keys+address and cbor2 canonical encoding for the body. No network, no new deps.
"""
import json
import os

import pytest

from blockle.multichain import crypto as K
from blockle.multichain.crypto import bip32_ed25519 as B32E
from blockle.multichain.chains import cardano as ADA
from blockle.multichain.chains import cardano_cbor as CBOR
from blockle.multichain.chains.registry import create_registry
from blockle import moonpay
from blockle.multichain import logos

ED = K.ed25519


def _fixture():
    p = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "cardano-vectors.json")
    with open(p) as f:
        return json.load(f)


V = _fixture()


def _entropy():
    return K.mnemonic_to_entropy(V["mnemonic"])


# ---- primitives ----------------------------------------------------------
def test_blake2b_kats():
    for text, hex_out, length in V["blake2bKats"]:
        fn = ADA.blake2b_224 if length == 28 else ADA.blake2b_256
        assert fn(text.encode()).hex() == hex_out


def test_cbor_kats():
    for n, hex_out in V["cborKats"]["uint"]:
        assert CBOR.uint(n).hex() == hex_out
    for raw_hex, hex_out in V["cborKats"]["bstr"]:
        assert CBOR.bstr(bytes.fromhex(raw_hex)).hex() == hex_out
    assert CBOR.array([CBOR.uint(1), CBOR.uint(2), CBOR.uint(3)]).hex() == V["cborKats"]["array"]
    assert CBOR.cmap([(CBOR.uint(0), CBOR.uint(1)),
                      (CBOR.uint(2), CBOR.uint(3))]).hex() == V["cborKats"]["map"]


# ---- Icarus + CIP-1852 derivation ----------------------------------------
def test_icarus_master_from_entropy():
    ent = _entropy()
    assert ent.hex() == V["icarus"]["entropyHex"]
    m = B32E.icarus_master_key(ent)
    assert (m.kL + m.kR + m.cc).hex() == V["icarus"]["masterKeyHex96"]


def test_cip1852_payment_and_stake_pubkeys():
    pay, stake = ADA.derive_keys(_entropy(), 0)
    d = V["derivation"]
    assert pay.A.hex() == d["paymentPubHex32"]
    assert stake.A.hex() == d["stakePubHex32"]
    assert (pay.A + pay.cc).hex() == d["paymentXpubHex"]


# ---- Shelley base address ------------------------------------------------
def test_address_byte_exact_and_validation():
    pay, stake = ADA.derive_keys(_entropy(), 0)
    a = V["address"]
    assert ADA.blake2b_224(pay.A).hex() == a["paymentCredHex28"]
    assert ADA.blake2b_224(stake.A).hex() == a["stakeCredHex28"]
    assert ADA.base_address_bytes(pay.A, stake.A).hex() == a["addressBytesHex57"]
    addr = ADA.encode_address(pay.A, stake.A)
    assert addr == a["bech32"]
    # round-trip + validation
    assert ADA.decode_address(addr).hex() == a["addressBytesHex57"]
    assert ADA.is_cardano_address(addr)
    assert ADA.is_cardano_address(V["recipient"]["bech32"])
    # reject foreign / malformed
    assert not ADA.is_cardano_address("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
    assert not ADA.is_cardano_address("tz1VQA4RP4fLjEEMW2FR4pE9kAg5abb5h5GL")
    assert not ADA.is_cardano_address(addr[:-1] + ("q" if addr[-1] != "q" else "p"))  # bad checksum


# ---- forge + extended-sign byte-exact + verify ---------------------------
def test_forge_sign_byte_exact_and_verifies():
    ent = _entropy()
    pay, _stake = ADA.derive_keys(ent, 0)
    tx = V["tx"]
    inputs = [(bytes.fromhex(i["txHashHex"]), i["index"]) for i in tx["inputs"]]
    outputs = [(ADA.decode_address(o["address"]), int(o["coin"])) for o in tx["outputs"]]
    built = ADA.build_signed_transaction(inputs, outputs, int(tx["fee"]), tx["ttl"], pay)
    assert built["txBodyCborHex"] == tx["txBodyCborHex"]
    assert built["txHashHex"] == tx["txHashHex"]
    assert built["vkeyHex"] == tx["vkeyHex32"]
    assert built["signatureHex"] == tx["signatureHex64"]
    assert built["signedTxCborHex"] == tx["signedTxCborHex"]
    assert ED.verify(bytes.fromhex(built["txHashHex"]), built["signature"], pay.A)


# ---- adapter build_send OFFLINE byte-exact -------------------------------
def test_adapter_build_send_offline_byte_exact():
    ent = _entropy()
    root = {"seed": b"", "entropy": ent}
    tx = V["tx"]
    self_addr = V["address"]["bech32"]

    def http_post(path, body, content_type="application/json"):
        if path == "/address_utxos":
            return json.dumps([{
                "tx_hash": tx["inputs"][0]["txHashHex"],
                "tx_index": tx["inputs"][0]["index"],
                "value": tx["inputTotal"],
                "asset_list": [],
            }])
        if path == "/submittx":
            return '"' + tx["txHashHex"] + '"'
        raise AssertionError("unexpected POST " + path)

    def http_get(path):
        raise AssertionError("ttl is pinned via req; no GET expected")

    a = ADA.create_cardano_adapter(http_get=http_get, http_post=http_post)
    a.unlock(root)
    acct = a.derive_account(root, 0)
    assert acct.address == self_addr
    assert acct.scheme == "ed25519-bip32"

    with pytest.raises(ValueError):
        a.build_send(acct, {"to": "not-a-cardano-address", "amount": "1"})

    built = a.build_send(acct, {
        "to": V["recipient"]["bech32"],
        "amount": tx["outputs"][0]["coin"],
        "ttl": tx["ttl"],
    })
    assert built.raw == tx["signedTxCborHex"]
    assert built.txid == tx["txHashHex"]
    assert built.fee == tx["fee"]

    bc = a.broadcast(built)
    assert bc.txid == tx["txHashHex"]
    assert bc.accepted


def test_adapter_balance_with_native_assets_display():
    ent = _entropy()

    def http_post(path, body, content_type="application/json"):
        assert path == "/address_utxos"
        return json.dumps([
            {"tx_hash": "aa" * 32, "tx_index": 0, "value": "5000000", "asset_list": []},
            {"tx_hash": "bb" * 32, "tx_index": 1, "value": "2000000",
             "asset_list": [{"policy_id": "ab" * 28, "asset_name": "41", "quantity": "7"}]},
        ])

    a = ADA.create_cardano_adapter(http_post=http_post)
    a.unlock({"entropy": ent})
    bal = a.get_balance(V["address"]["bech32"])
    assert bal[0].asset.symbol == "ADA"
    assert bal[0].confirmed == "7000000"      # 5 + 2 ADA
    assert bal[0].display == "7"
    # native-asset (CNT) surfaced for DISPLAY only
    cnt = [b for b in bal if b.asset.kind == "cnt"]
    assert len(cnt) == 1 and cnt[0].confirmed == "7"


def test_entropy_blocker_is_surfaced_not_faked():
    # A bare seed (no entropy) must NOT silently derive a bogus key.
    a = ADA.create_cardano_adapter()
    a.unlock(b"\x00" * 64)  # as_entropy(bytes) -> None
    with pytest.raises(RuntimeError):
        a.derive_account(None, 0)


# ---- registry wiring + metadata ------------------------------------------
def test_registry_wiring_and_entropy_threading():
    reg = create_registry({})
    assert reg.has("cardano")
    assert "cardano" in reg.enabled()
    assert reg.endpoints("cardano")["koios"] == V["network"]["koios"]
    # registry.unlock threads entropy; derive via the carrier mapping
    root = {"seed": K.mnemonic_to_seed(V["mnemonic"]), "entropy": _entropy()}
    reg.unlock(root)
    acct = reg.get("cardano").derive_account(root, 0)
    assert acct.scheme == "ed25519-bip32"
    assert acct.address == V["address"]["bech32"]


def test_moonpay_and_logo():
    assert moonpay.NATIVE_CURRENCY_CODES["cardano"] == V["network"]["moonpay"]["native"]
    assert logos.canon_chain("cardano") == "cardano"
    assert logos.canon_chain("ada") == "cardano"
    assert "₳" in logos.chain_icon("cardano")
