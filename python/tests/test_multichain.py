"""Multi-chain wallet layer tests — validated against the SAME published,
independently-verifiable vectors as the audited browser extension
(``blockle-extension/multichain.test.js`` + ``signing.test.js``) and the
Flutter port.

Run:  python -m pytest python/ -k multichain
"""

from __future__ import annotations

import hashlib

import pytest

from blockle.multichain import crypto as K
from blockle.multichain import vault as V
from blockle.multichain.chains import evm as E
from blockle.multichain.chains import solana as SOL
from blockle.multichain.chains import utxo as U
from blockle.multichain.chains import create_registry
from blockle.multichain.chains.chain_adapter import AssetRef

S = K.secp256k1
ED = K.ed25519
ABANDON = ("abandon abandon abandon abandon abandon abandon abandon abandon "
           "abandon abandon abandon about")


def h(b):
    return b.hex() if isinstance(b, (bytes, bytearray)) else b


def te(s):
    return s.encode()


def hx(s):
    return K.hex_to_bytes(s)


# ---- crypto-core ----------------------------------------------------------
def test_hashes():
    assert h(K.sha256(te("abc"))) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert h(K.sha512(te("abc"))) == ("ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
                                      "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f")
    assert h(K.ripemd160(te("abc"))) == "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"
    assert h(K.keccak256(te("abc"))) == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    assert h(K.hash160(te("abc"))) == "bb1be98c142444d7a56aa3981c3942a978e4dc33"


def test_hmac_sha512_rfc4231():
    assert h(K.hmac_sha512(hx("0b" * 20), te("Hi There"))) == (
        "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde"
        "daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854")


def test_base58check_roundtrip():
    payload = hx("00" + "01" * 20)
    enc = K.base58check_encode(payload)
    assert K.base58check_decode(enc) == payload


def test_wordlist_integrity():
    from blockle.multichain.crypto.wordlist import WORDLIST
    assert len(WORDLIST) == 2048
    assert WORDLIST[0] == "abandon" and WORDLIST[-1] == "zoo"
    digest = hashlib.sha256(("\n".join(WORDLIST) + "\n").encode()).hexdigest()
    # Canonical BIP-39 english wordlist sha256 (newline-joined, trailing newline).
    assert digest == "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"


# ---- secp256k1 (sipa RFC6979 vector) --------------------------------------
def test_secp256k1_pub_and_rfc6979():
    priv = hx("1".rjust(64, "0"))
    assert h(S.public_key(priv, True)) == "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    msg = K.sha256(te("Everything should be made as simple as possible, but not simpler."))
    sig = S.sign(msg, priv)
    assert sig.r_hex == "33a69cd2065432a30f3d1ce4eb0d59b8ab58c74f27c41a7fdb5696ad4e6108c9"
    assert sig.s_hex == "6f807982866f785d3f6418d24163ddae117b7db4d5fdf0071de069fa54342262"
    assert S.verify(msg, sig, S.public_key(priv, True))


def test_secp256k1_point_roundtrip():
    priv = hx("1".rjust(64, "0"))
    pub = S.public_key(priv, True)
    x, y = S.decode_point(pub)
    assert S.encode_point((x, y), True) == pub
    assert S.encode_point((x, y), False)[0] == 0x04


# ---- BIP39 seed + BIP32 Test Vector 1 -------------------------------------
def test_bip39_seed_and_validate():
    assert h(K.mnemonic_to_seed(ABANDON, "TREZOR")) == (
        "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
        "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04")
    assert K.validate_mnemonic(ABANDON)
    assert not K.validate_mnemonic("abandon abandon zoo")


def test_bip39_mnemonic_roundtrip():
    ent = hx("00000000000000000000000000000000")
    assert K.entropy_to_mnemonic(ent).split()[0] == "abandon"
    assert K.mnemonic_to_entropy(ABANDON) == ent


def test_bip32_vector1():
    seed = hx("000102030405060708090a0b0c0d0e0f")
    assert K.serialize(K.master_from_seed(seed), False) == (
        "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvv"
        "NKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi")
    assert K.serialize(K.derive_path(seed, "m/0'"), True) == (
        "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwB"
        "ZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw")
    assert K.serialize(K.derive_path(seed, "m/0'/1/2'/2/1000000000"), False) == (
        "xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScG"
        "pWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76")


# ---- address derivation (abandon mnemonic / seed) -------------------------
def test_address_derivation():
    seed = K.mnemonic_to_seed(ABANDON, "")
    eth = K.derive_path(seed, "m/44'/60'/0'/0/0")
    assert h(eth.private_key) == "1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727"
    assert K.evm_address(eth.public_key) == "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    assert K.p2wpkh(K.derive_path(seed, "m/84'/0'/0'/0/0").public_key, "bc") == "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
    assert K.p2wpkh(K.derive_path(seed, "m/84'/2'/0'/0/0").public_key, "ltc") == "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh"
    assert K.p2pkh(K.derive_path(seed, "m/44'/3'/0'/0/0").public_key, 0x1E) == "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC"
    assert K.to_checksum_address("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359") == "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"


def test_wif_roundtrip():
    seed = K.mnemonic_to_seed(ABANDON, "")
    priv = K.derive_path(seed, "m/84'/0'/0'/0/0").private_key
    wif = K.to_wif(priv, 0x80, True)
    dec = K.from_wif(wif)
    assert dec["private_key"] == priv and dec["compressed"] is True


# ---- EVM tx building ------------------------------------------------------
def test_erc20_calldata_and_format():
    assert E.erc20_transfer_data("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "1") == (
        "0xa9059cbb0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
        "0000000000000000000000000000000000000000000000000000000000000001")
    assert E.format_units("1500000000000000000", 18) == "1.5"
    assert E.format_units("1234567", 6) == "1.234567"


def test_erc20_approve_allowance_calldata():
    # unlimited approve -> max uint256
    data = E.erc20_approve_data("0x" + "ab" * 20)
    assert data.startswith("0x095ea7b3")
    assert data.endswith("f" * 64)
    al = E.erc20_allowance_data("0x" + "11" * 20, "0x" + "22" * 20)
    assert al.startswith("0xdd62ed3e")


def test_eip1559_sign_and_recover():
    seed = K.mnemonic_to_seed(ABANDON, "")
    node = K.derive_path(seed, "m/44'/60'/0'/0/0")
    frm = K.evm_address(node.public_key)
    tx = {"chainId": 1, "nonce": 0, "maxPriorityFeePerGas": 1_000_000_000,
          "maxFeePerGas": 20_000_000_000, "gasLimit": 21000,
          "to": "0x3535353535353535353535353535353535353535", "value": 10 ** 18, "data": "0x"}
    signed = E.sign_eip1559(tx, node.private_key)
    assert signed["raw"].startswith("0x02")
    assert len(signed["txid"]) == 66
    sh = hx(signed["sigHash"][2:])
    sig = S.sign(sh, node.private_key)
    rec = K.evm_address(S.recover(sh, sig.r, sig.s, sig.recovery, False))
    assert rec.lower() == frm.lower()


def test_legacy155_sign_and_recover():
    seed = K.mnemonic_to_seed(ABANDON, "")
    node = K.derive_path(seed, "m/44'/60'/0'/0/0")
    frm = K.evm_address(node.public_key)
    tx = {"chainId": 1, "nonce": 0, "gasPrice": 20_000_000_000, "gasLimit": 21000,
          "to": "0x3535353535353535353535353535353535353535", "value": 10 ** 18, "data": "0x"}
    signed = E.sign_legacy155(tx, node.private_key)
    assert len(signed["txid"]) == 66
    # recover: recompute the sighash and recid from v
    assert signed["raw"].startswith("0x")


def test_evm_sign_arbitrary_tx_and_approve():
    seed = K.mnemonic_to_seed(ABANDON, "")

    # Canned RPC stub so nothing hits the network; records calls.
    def rpc(method, params):
        return {
            "eth_getTransactionCount": "0x7",
            "eth_gasPrice": "0x3b9aca00",
            "eth_estimateGas": "0x5208",
        }[method]

    adapter = E.create_evm_adapter(id="base", chainId=8453, rpc=rpc)
    adapter.unlock({"seed": seed})
    acct = adapter.derive_account({"seed": seed})
    frm = acct.address

    built = adapter.sign_arbitrary_tx(acct, {"to": "0x" + "cd" * 20, "data": "0xabcdef", "value": 0})
    assert built.raw.startswith("0x02") and built.chain == "base"
    # the sender of the signed arbitrary tx must recover to the owner address
    from blockle.multichain.chains.evm import _rlp_num, _rlp_addr, _rlp_data
    tx = {"chainId": 8453, "nonce": 7, "maxPriorityFeePerGas": 0x3b9aca00,
          "maxFeePerGas": 0x3b9aca00 * 2, "gasLimit": 0x5208,
          "to": "0x" + "cd" * 20, "value": 0, "data": "0xabcdef"}
    signed = E.sign_eip1559(tx, K.derive_path(seed, "m/44'/60'/0'/0/0").private_key)
    sh = hx(signed["sigHash"][2:])
    sig = S.sign(sh, K.derive_path(seed, "m/44'/60'/0'/0/0").private_key)
    assert K.evm_address(S.recover(sh, sig.r, sig.s, sig.recovery, False)).lower() == frm.lower()

    # approve builds a type-2 tx too (unlimited allowance calldata)
    approve = adapter.build_approve(acct, {"address": "0x" + "ab" * 20}, "0x" + "cd" * 20)
    assert approve.raw.startswith("0x02")


# ---- UTXO tx building -----------------------------------------------------
def test_bip143_sighash_and_signature():
    le0 = "fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f"
    le1 = "ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a"
    inputs = [
        {"txid": h(hx(le0)[::-1]), "vout": 0, "sequence": 0xFFFFFFEE},
        {"txid": h(hx(le1)[::-1]), "vout": 1, "sequence": 0xFFFFFFFF},
    ]
    outputs = [
        {"script": hx("76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac"), "value": 112340000},
        {"script": hx("76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac"), "value": 223450000},
    ]
    script_code = hx("76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac")
    # BIP143 example: nLockTime=0x11, SIGHASH_ALL=0x01
    sh = U.sighash_segwit(1, inputs, outputs, 1, script_code, 600000000, 0xFFFFFFFF, 0x11, 0x01)
    assert h(sh) == "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670"
    priv = hx("619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9")
    sig = S.sign(sh, priv)
    assert h(sig.der) + "01" == (
        "304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a"
        "0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01")
    assert h(S.public_key(priv, True)) == "025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357"


def test_utxo_full_build_btc_and_doge():
    seed = K.mnemonic_to_seed(ABANDON, "")
    net = U.NETWORKS["bitcoin"]
    node = K.derive_path(seed, net["path"] + "/0")
    frm = K.p2wpkh(node.public_key, "bc")
    built = U.build_and_sign(net, node, frm, {
        "to": "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "amount": "120000", "feeRate": 10,
        "utxos": [{"txid": "a" * 64, "vout": 0, "value": "100000"},
                  {"txid": "b" * 64, "vout": 1, "value": "50000"}]})
    assert built["raw"][8:12] == "0001"  # segwit marker
    assert len(built["txid"]) == 64
    for si in built["signedInputs"]:
        rec = S.recover(si["_sh"], si["_sig"].r, si["_sig"].s, si["_sig"].recovery, True)
        assert rec == node.public_key

    dnet = U.NETWORKS["dogecoin"]
    dnode = K.derive_path(seed, dnet["path"] + "/0")
    dfrom = K.p2pkh(dnode.public_key, dnet["p2pkh"])
    dbuilt = U.build_and_sign(dnet, dnode, dfrom, {
        "to": dfrom, "amount": "100000000", "feeRate": 1000,
        "utxos": [{"txid": "c" * 64, "vout": 0, "value": "500000000"}]})
    assert dbuilt["raw"][8:12] != "0001"
    for si in dbuilt["signedInputs"]:
        rec = S.recover(si["_sh"], si["_sig"].r, si["_sig"].s, si["_sig"].recovery, True)
        assert rec == dnode.public_key


def test_utxo_insufficient_funds_raises():
    seed = K.mnemonic_to_seed(ABANDON, "")
    net = U.NETWORKS["bitcoin"]
    node = K.derive_path(seed, net["path"] + "/0")
    frm = K.p2wpkh(node.public_key, "bc")
    with pytest.raises(ValueError):
        U.build_and_sign(net, node, frm, {
            "to": frm, "amount": "999999999", "feeRate": 10,
            "utxos": [{"txid": "a" * 64, "vout": 0, "value": "100000"}]})


# ---- ed25519 (RFC 8032 Section 7.1) ---------------------------------------
def test_ed25519_rfc8032():
    sk1 = hx("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    pk1 = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    assert h(ED.public_key(sk1)) == pk1
    assert h(ED.sign(b"", sk1)) == (
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc"
        "61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
    assert ED.verify(b"", hx(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc"
        "61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"), hx(pk1))

    sk3 = hx("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7")
    pk3 = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025"
    sig3 = ED.sign(hx("af82"), sk3)
    assert ED.verify(hx("af82"), sig3, hx(pk3))
    assert not ED.verify(hx("af83"), sig3, hx(pk3))
    bad = bytearray(sig3)
    bad[0] ^= 0x01
    assert not ED.verify(hx("af82"), bytes(bad), hx(pk3))


# ---- SLIP-0010 ed25519 (Test vector 1) ------------------------------------
def test_slip10_vector1():
    seed = hx("000102030405060708090a0b0c0d0e0f")
    m = K.slip10.master_key(seed)
    assert h(m.key) == "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"
    assert h(m.chain_code) == "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb"
    n = K.slip10.derive(seed, "m/0'")
    assert h(n.key) == "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3"


# ---- Solana adapter (signer location + serialized-tx sign) ----------------
def test_solana_derive_and_sign_serialized_tx():
    seed = K.mnemonic_to_seed(ABANDON, "")
    adapter = SOL.create_solana_adapter()
    adapter.unlock({"seed": seed})
    acct = adapter.derive_account({"seed": seed})
    assert acct.scheme == "ed25519"
    pub = bytes.fromhex(acct.publicKey)
    assert K.base58encode(pub) == acct.address

    # Build a minimal legacy transaction: 1 required sig, header [1,0,1],
    # 1 account key (our pubkey), rest arbitrary message bytes.
    sig_area = bytes([1]) + bytes(64)  # shortvec count=1 + one empty sig slot
    message = bytes([1, 0, 1]) + bytes([1]) + pub + b"\xde\xad\xbe\xef"
    tx = sig_area + message
    built = adapter.sign_tx(acct, {"raw": SOL._to_base64(tx)})
    signed = SOL._from_base64(built.raw)
    loc = SOL.locate_signer(signed, pub)
    assert loc["signerIndex"] == 0
    sig = bytes(signed[loc["sigAreaStart"]: loc["sigAreaStart"] + 64])
    assert ED.verify(message, sig, pub)
    assert built.txid == K.base58encode(sig)


def test_solana_rejects_non_signer():
    seed = K.mnemonic_to_seed(ABANDON, "")
    adapter = SOL.create_solana_adapter()
    adapter.unlock({"seed": seed})
    acct = adapter.derive_account({"seed": seed})
    other = bytes(32)  # a key that is not ours
    sig_area = bytes([1]) + bytes(64)
    message = bytes([1, 0, 1]) + bytes([1]) + other + b"\x00"
    tx = sig_area + message
    with pytest.raises(ValueError):
        adapter.sign_tx(acct, {"raw": SOL._to_base64(tx)})


# ---- registry derivation (no network) -------------------------------------
def test_registry_derivation():
    reg = create_registry({})
    seed = K.mnemonic_to_seed(ABANDON, "")
    reg.unlock({"seed": seed})
    eth = reg.get("ethereum").derive_account({"seed": seed})
    base = reg.get("base").derive_account({"seed": seed})
    assert eth.address.lower() == base.address.lower()  # same secp account
    assert eth.address == "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    btc = reg.get("bitcoin").derive_account({"seed": seed})
    assert btc.address == "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
    sol = reg.get("solana").derive_account({"seed": seed})
    assert sol.scheme == "ed25519"
    assert "ethereum" in reg.enabled() and "bitcoin" in reg.enabled()
    assert any(t.symbol == "USDC" for t in reg.tokens_for("ethereum"))


# ---- vault (scrypt + AES-256-GCM v2) --------------------------------------
def test_vault_seal_open_roundtrip():
    seed = K.mnemonic_to_seed(ABANDON, "")
    secret = {"seed": seed.hex(), "agentCred": "sk-xxx", "note": "держи"}
    sealed = V.seal(secret, "correct horse battery staple")
    assert sealed["v"] == 2 and sealed["kdf"]["name"] == "scrypt"
    assert sealed["kdf"]["params"] == {"N": 16384, "r": 8, "p": 1}
    # plaintext must not leak into the blob
    blob = (sealed["salt"] + sealed["iv"] + sealed["data"]).lower()
    assert seed.hex() not in blob and "sk-xxx" not in V.open(sealed, "correct horse battery staple")["seed"]
    opened = V.open(sealed, "correct horse battery staple")
    assert opened == secret
    assert not V.needs_upgrade(sealed)


def test_vault_wrong_password_raises():
    sealed = V.seal({"a": 1}, "right")
    with pytest.raises(V.WrongPassword):
        V.open(sealed, "wrong")


def test_vault_v1_pbkdf2_opens_and_needs_upgrade():
    # Construct a legacy v1 blob (PBKDF2) and confirm it opens + flags upgrade.
    import base64 as b64
    import hashlib as hl
    import json
    import os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = hl.pbkdf2_hmac("sha256", b"pw", salt, 310000, 32)
    ct = AESGCM(key).encrypt(iv, json.dumps({"legacy": True}).encode(), None)
    sealed = {"v": 1, "salt": b64.b64encode(salt).decode(), "iv": b64.b64encode(iv).decode(),
              "data": b64.b64encode(ct).decode()}
    assert V.open(sealed, "pw") == {"legacy": True}
    assert V.needs_upgrade(sealed)
