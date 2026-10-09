"""Low-level crypto primitives for the multi-chain layer.

Python mirror of ``blockle-extension/crypto-core.js`` (global ``BLKCrypto``).
Provides the hashes, HMAC/PBKDF2, base58check, RLP and byte/hex helpers the
HD, address and chain-adapter layers are built on.

Unlike the browser build (which hand-rolls these because WebCrypto lacks them),
the Python build leans on well-maintained libraries where they exist:
  * SHA-256/512, HMAC, PBKDF2, scrypt  -> ``hashlib`` / ``hmac`` (stdlib)
  * RIPEMD-160                         -> ``hashlib`` (OpenSSL) with a small
                                          pure-Python fallback (OpenSSL 3 may
                                          disable the legacy provider)
  * Keccak-256 (Ethereum, pre-NIST pad) -> ``pycryptodome`` ``Crypto.Hash.keccak``
  * base58 / base58check                -> ``base58``

Every function is validated in tests against the same published vectors as the
JS/Dart ports (sha256("abc"), keccak256("abc"), ripemd160("abc"), RFC4231
HMAC-SHA512, BIP39 Trezor seed, etc.).
"""

from __future__ import annotations

import hashlib
import hmac as _hmac

import base58 as _base58
from Crypto.Hash import keccak as _keccak

Bytesish = "bytes | bytearray | str | list | memoryview"


# ---- byte / hex helpers --------------------------------------------------
def to_bytes(x) -> bytes:
    if isinstance(x, (bytes, bytearray, memoryview)):
        return bytes(x)
    if isinstance(x, str):
        return hex_to_bytes(x)
    if isinstance(x, (list, tuple)):
        return bytes(x)
    raise TypeError(f"to_bytes: unsupported type {type(x)!r}")


def hex_to_bytes(h: str) -> bytes:
    s = h[2:] if h.startswith("0x") else h
    if len(s) % 2:
        s = "0" + s
    return bytes.fromhex(s)


def bytes_to_hex(b) -> str:
    return to_bytes(b).hex()


def concat_bytes(*arrs) -> bytes:
    return b"".join(to_bytes(a) for a in arrs)


def utf8(s: str) -> bytes:
    return s.encode("utf-8")


# ---- hashes --------------------------------------------------------------
def sha256(msg) -> bytes:
    return hashlib.sha256(to_bytes(msg)).digest()


def sha512(msg) -> bytes:
    return hashlib.sha512(to_bytes(msg)).digest()


def _ripemd160_pure(msg: bytes) -> bytes:
    # Compact pure-Python RIPEMD-160 (fallback when OpenSSL has it disabled).
    import struct

    rl = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
          7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
          3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
          1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
          4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13]
    rr = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
          6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
          15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
          8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
          12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11]
    sl = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
          7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
          11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
          11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
          9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6]
    sr = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
          9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
          9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
          15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
          8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11]
    kl = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
    kr = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]
    mask = 0xFFFFFFFF

    def rol(x, n):
        return ((x << n) | (x >> (32 - n))) & mask

    def f(j, x, y, z):
        if j < 16:
            return x ^ y ^ z
        if j < 32:
            return (x & y) | (~x & mask & z)
        if j < 48:
            return (x | (~y & mask)) ^ z
        if j < 64:
            return (x & z) | (y & (~z & mask))
        return x ^ (y | (~z & mask))

    msg = bytes(msg)
    ml = len(msg)
    data = bytearray(msg) + b"\x80"
    while len(data) % 64 != 56:
        data += b"\x00"
    data += struct.pack("<Q", (ml * 8) & 0xFFFFFFFFFFFFFFFF)

    h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
    for off in range(0, len(data), 64):
        x = list(struct.unpack("<16I", data[off:off + 64]))
        al, bl, cl, dl, el = h0, h1, h2, h3, h4
        ar, br, cr, dr, er = h0, h1, h2, h3, h4
        for j in range(80):
            kj = j // 16
            t = (al + f(j, bl, cl, dl) + x[rl[j]] + kl[kj]) & mask
            t = (rol(t, sl[j]) + el) & mask
            al, el, dl, cl, bl = el, dl, rol(cl, 10), bl, t
            t = (ar + f(79 - j, br, cr, dr) + x[rr[j]] + kr[kj]) & mask
            t = (rol(t, sr[j]) + er) & mask
            ar, er, dr, cr, br = er, dr, rol(cr, 10), br, t
        t = (h1 + cl + dr) & mask
        h1 = (h2 + dl + er) & mask
        h2 = (h3 + el + ar) & mask
        h3 = (h4 + al + br) & mask
        h4 = (h0 + bl + cr) & mask
        h0 = t
    return struct.pack("<5I", h0, h1, h2, h3, h4)


def ripemd160(msg) -> bytes:
    b = to_bytes(msg)
    try:
        h = hashlib.new("ripemd160")
        h.update(b)
        return h.digest()
    except (ValueError, TypeError):
        return _ripemd160_pure(b)


def keccak256(msg) -> bytes:
    k = _keccak.new(digest_bits=256)
    k.update(to_bytes(msg))
    return k.digest()


def hash256(msg) -> bytes:
    return sha256(sha256(msg))  # double SHA-256


def hash160(msg) -> bytes:
    return ripemd160(sha256(msg))  # RIPEMD160(SHA256)


# ---- HMAC / PBKDF2 -------------------------------------------------------
def hmac_sha256(key, msg) -> bytes:
    return _hmac.new(to_bytes(key), to_bytes(msg), hashlib.sha256).digest()


def hmac_sha512(key, msg) -> bytes:
    return _hmac.new(to_bytes(key), to_bytes(msg), hashlib.sha512).digest()


def pbkdf2_sha512(password, salt, iterations: int, dk_len: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", to_bytes(password), to_bytes(salt), iterations, dk_len)


# ---- base58 / base58check ------------------------------------------------
def base58encode(b) -> str:
    return _base58.b58encode(to_bytes(b)).decode("ascii")


def base58decode(s: str) -> bytes:
    return _base58.b58decode(s)


def base58check_encode(payload) -> str:
    return _base58.b58encode_check(to_bytes(payload)).decode("ascii")


def base58check_decode(s: str) -> bytes:
    return _base58.b58decode_check(s)


# ---- RLP (Ethereum) ------------------------------------------------------
def _rlp_encode_length(length: int, offset: int) -> bytes:
    if length < 56:
        return bytes([length + offset])
    hx = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([len(hx) + offset + 55]) + hx


def rlp_encode(item) -> bytes:
    if isinstance(item, (list, tuple)):
        out = b"".join(rlp_encode(x) for x in item)
        return _rlp_encode_length(len(out), 0xC0) + out
    b = to_bytes(item)
    if len(b) == 1 and b[0] < 0x80:
        return b
    return _rlp_encode_length(len(b), 0x80) + b
