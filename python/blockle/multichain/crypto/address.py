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


# ---- Tron (base58check over 0x41 || keccak20) ----------------------------
# Tron reuses the SAME body as an EVM address — keccak256(uncompressedPub[1:])
# last 20 bytes — but prepends a 0x41 version byte and encodes the 21-byte
# payload with Bitcoin-style base58check (double-SHA256 4-byte checksum) instead
# of EIP-55 hex. The result is a 'T…' address. Mirrors blockle-extension/
# address.js (Addr.tronAddress / tronAddressToHex / tronHexToBase58 / isTronAddress).
def tron_address(pub_key_bytes) -> str:
    pub = C.to_bytes(pub_key_bytes)
    if len(pub) == 33:
        pub = S.encode_point(S.decode_point(pub), False)  # -> 65B uncompressed
    body = pub[1:]  # drop 0x04
    h = C.keccak256(body)
    payload = bytes([0x41]) + h[-20:]  # 21 bytes
    return C.base58check_encode(payload)


def tron_address_to_hex(addr: str) -> str:
    """'T…' -> '41'+40-hex (21-byte hex, 0x41 prefix). Raises unless prefix 0x41."""
    payload = C.base58check_decode(str(addr))
    if len(payload) != 21 or payload[0] != 0x41:
        raise ValueError("not a tron address")
    return payload.hex()


def tron_hex_to_base58(hex_addr: str) -> str:
    """'41…'(21B) or bare 20-byte hex (optionally 0x-prefixed) -> 'T…' base58."""
    h = str(hex_addr)
    if h.lower().startswith("0x"):
        h = h[2:]
    b = bytes.fromhex(h)
    if len(b) == 20:
        b = bytes([0x41]) + b
    if len(b) != 21 or b[0] != 0x41:
        raise ValueError("bad tron hex address")
    return C.base58check_encode(b)


def is_tron_address(addr) -> bool:
    if not isinstance(addr, str):
        return False
    import re
    if re.fullmatch(r"(0x)?41[0-9a-fA-F]{40}", addr):
        return True
    if not re.fullmatch(r"T[1-9A-HJ-NP-Za-km-z]{33}", addr):
        return False
    try:
        p = C.base58check_decode(addr)
        return len(p) == 21 and p[0] == 0x41
    except Exception:
        return False


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
