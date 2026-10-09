"""Address encoders for the secp256k1 chains.

Python mirror of ``blockle-extension/address.js`` (global ``Addr``):
  * EVM checksummed hex (EIP-55)
  * BTC/LTC native SegWit v0 P2WPKH (bech32, BIP173)
  * legacy Base58Check P2PKH (BTC/LTC/DOGE)
  * WIF private-key import/export

Validated against EIP-55 and the BIP84 ``bc1qcr8te4…`` / LTC / DOGE vectors.
"""

from __future__ import annotations

from . import _core as C
from . import bech32 as B
from . import secp256k1 as S


# ---- EVM (EIP-55 checksum) -----------------------------------------------
def to_checksum_address(addr: str) -> str:
    a = addr.lower().replace("0x", "", 1) if addr.lower().startswith("0x") else addr.lower()
    h = C.keccak256(C.utf8(a)).hex()
    out = "0x"
    for i, ch in enumerate(a):
        out += ch.upper() if int(h[i], 16) >= 8 else ch
    return out


def evm_address(pub_key_bytes) -> str:
    pub = C.to_bytes(pub_key_bytes)
    if len(pub) == 33:
        pub = S.encode_point(S.decode_point(pub), False)
    body = pub[1:]  # drop 0x04
    h = C.keccak256(body)
    return to_checksum_address("0x" + h[-20:].hex())


# ---- UTXO addresses ------------------------------------------------------
def p2wpkh(pub_key_bytes, hrp: str) -> str:
    h160 = C.hash160(C.to_bytes(pub_key_bytes))  # pubkey MUST be compressed
    return B.segwit_encode(hrp, 0, h160)


def p2pkh(pub_key_bytes, version_byte: int) -> str:
    h160 = C.hash160(C.to_bytes(pub_key_bytes))
    return C.base58check_encode(bytes([version_byte]) + h160)


# ---- WIF -----------------------------------------------------------------
def to_wif(priv_bytes, version_byte: int = 0x80, compressed: bool = True) -> str:
    payload = bytes([version_byte]) + C.to_bytes(priv_bytes)
    if compressed:
        payload += b"\x01"
    return C.base58check_encode(payload)


def from_wif(wif: str) -> dict:
    dec = C.base58check_decode(wif)
    compressed = len(dec) == 34
    return {"version": dec[0], "private_key": dec[1:33], "compressed": compressed}
