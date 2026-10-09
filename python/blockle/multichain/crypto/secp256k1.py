"""secp256k1 ECDSA — the curve used by EVM and BTC/LTC/DOGE.

Python mirror of ``blockle-extension/secp256k1.js`` (global ``Secp256k1``). The
heavy lifting is delegated to ``coincurve`` (libsecp256k1): deterministic
RFC-6979 signing, low-S normalisation, public-key recovery, and the modular
tweak add/multiply BIP32 child derivation needs — all constant-time C.

NOT post-quantum: this is secp256k1/ECDSA, exactly like Bitcoin and Ethereum.
Only BLOCK's on-chain signatures are post-quantum (ML-DSA-44).

DER encoding is produced here (minimal-length, matching Bitcoin's
``SIG + hashtype`` convention) rather than via the library so it is identical
to the JS/Dart ports and the published BIP143 vector.
"""

from __future__ import annotations

from dataclasses import dataclass

from coincurve import PrivateKey, PublicKey

from . import _core as C

# Curve order N (same constant the JS port exposes).
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F


def bytes_to_big(b) -> int:
    return int.from_bytes(C.to_bytes(b), "big")


def big_to_32(x: int) -> bytes:
    return (x % (1 << 256)).to_bytes(32, "big")


def is_valid_private(d: int) -> bool:
    return 0 < d < N


def public_key(priv, compressed: bool = True) -> bytes:
    d = bytes_to_big(priv)
    if not is_valid_private(d):
        raise ValueError("invalid private key")
    return PrivateKey(big_to_32(d)).public_key.format(compressed)


def decode_point(pub) -> tuple[int, int]:
    """Return the (x, y) affine coordinates of a 33/65-byte public key."""
    p = PublicKey(C.to_bytes(pub)).point()
    return p[0], p[1]


def encode_point(point: tuple[int, int], compressed: bool = True) -> bytes:
    x, y = point
    prefix = 0x04
    # Reconstruct via coincurve for uniform (de)compression behaviour.
    body = b"\x04" + big_to_32(x) + big_to_32(y)
    return PublicKey(body).format(compressed)


def priv_add(priv, tweak) -> bytes:
    """(priv + tweak) mod N as 32 bytes. Raises on an invalid (zero) result."""
    pk = PrivateKey(C.to_bytes(priv)).add(C.to_bytes(tweak))
    return pk.secret


def point_add_scalar(pub, tweak) -> bytes:
    """Compressed (pubPoint + tweak*G). Raises if the result is infinity."""
    return PublicKey(C.to_bytes(pub)).add(C.to_bytes(tweak)).format(True)


@dataclass
class Signature:
    r: int
    s: int
    recovery: int
    compact: bytes  # r||s (64 bytes)
    der: bytes
    r_hex: str
    s_hex: str


def _der_encode(r: int, s: int) -> bytes:
    def enc(v: int) -> bytes:
        b = big_to_32(v).lstrip(b"\x00") or b"\x00"
        if b[0] & 0x80:
            b = b"\x00" + b
        return b

    rb, sb = enc(r), enc(s)
    body = b"\x02" + bytes([len(rb)]) + rb + b"\x02" + bytes([len(sb)]) + sb
    return b"\x30" + bytes([len(body)]) + body


def sign(msg_hash, priv) -> Signature:
    """Deterministic RFC-6979 ECDSA over a 32-byte digest. low-S, with recid."""
    h = C.to_bytes(msg_hash)
    d = bytes_to_big(priv)
    if not is_valid_private(d):
        raise ValueError("invalid private key")
    sig65 = PrivateKey(big_to_32(d)).sign_recoverable(h, hasher=None)
    r = int.from_bytes(sig65[0:32], "big")
    s = int.from_bytes(sig65[32:64], "big")
    recovery = sig65[64]
    return Signature(
        r=r, s=s, recovery=recovery,
        compact=sig65[0:64],
        der=_der_encode(r, s),
        r_hex=sig65[0:32].hex(),
        s_hex=sig65[32:64].hex(),
    )


def verify(msg_hash, sig, pub) -> bool:
    try:
        r = sig.r if isinstance(sig, Signature) else (sig["r"] if isinstance(sig, dict) else sig[0])
        s = sig.s if isinstance(sig, Signature) else (sig["s"] if isinstance(sig, dict) else sig[1])
    except Exception:
        return False
    r = r if isinstance(r, int) else bytes_to_big(r)
    s = s if isinstance(s, int) else bytes_to_big(s)
    if not (0 < r < N and 0 < s < N):
        return False
    der = _der_encode(r, s)
    try:
        return PublicKey(C.to_bytes(pub)).verify(der, C.to_bytes(msg_hash), hasher=None)
    except Exception:
        return False


def recover(msg_hash, r, s, recovery: int, compressed: bool = False) -> bytes:
    rb = big_to_32(r if isinstance(r, int) else bytes_to_big(r))
    sb = big_to_32(s if isinstance(s, int) else bytes_to_big(s))
    sig65 = rb + sb + bytes([recovery & 0xFF])
    pub = PublicKey.from_signature_and_message(sig65, C.to_bytes(msg_hash), hasher=None)
    return pub.format(compressed)
