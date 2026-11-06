"""BIP32-Ed25519 (Khovratovich/Dmitrienko) + Icarus (CIP-0003) key derivation —
the HD scheme Cardano uses for CIP-1852 account keys.

This is NOT SLIP-0010. Cardano's Icarus master key is derived from the BIP39
*entropy* (the 16-32 raw entropy bytes, NOT the 64-byte seed) and child keys use
the BIP32-Ed25519 additive scheme (full 256-bit kL with NO reduction mod L at
derivation time; the scalar is only reduced mod L inside the signer).

Pinned byte-for-byte by docs/cardano-vectors.json and cross-checked against the
independent ``bip_utils`` (CardanoIcarus / Cip1852) reference. Mirrors the
extension's chains/cardano-crypto.js and the Flutter crypto/bip32_ed25519.dart.

Primitives reused from the shared core:
  * PBKDF2-HMAC-SHA512  (Icarus master, iters=4096, dkLen=96)  -> _core.pbkdf2_sha512
  * HMAC-SHA512         (child Z / chain-code)                 -> _core.hmac_sha512
  * scalarMulBase       (A = kL·B, no-clamp)                   -> ed25519.scalar_mul_base
No new crypto primitive is introduced here — only the BIP32-Ed25519 arithmetic.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import _core as C
from . import ed25519 as ED

HARDENED = 0x80000000


@dataclass
class Bip32Ed25519Node:
    """An extended Ed25519 node: left/right private halves, chain code, and the
    cached compressed public key A = scalarMulBase(kL)."""

    kL: bytes   # 32B little-endian scalar (clamped at the master, extended by children)
    kR: bytes   # 32B little-endian nonce prefix half
    cc: bytes   # 32B chain code
    A: bytes    # 32B compressed Ed25519 public key


def _le(b: bytes) -> int:
    return int.from_bytes(b, "little")


def _to_le(n: int, length: int = 32) -> bytes:
    return (n % (1 << (8 * length))).to_bytes(length, "little")


def icarus_master_key(entropy) -> Bip32Ed25519Node:
    """CIP-0003 Icarus master key from the BIP39 ENTROPY (not the seed).

    mk = PBKDF2-HMAC-SHA512(password="", salt=entropy, iters=4096, dkLen=96);
    kL = mk[0:32], kR = mk[32:64], cc = mk[64:96]; then clamp kL
    (kL[0] &= 0xF8; kL[31] &= 0x1F; kL[31] |= 0x40)."""
    ent = C.to_bytes(entropy)
    if not (16 <= len(ent) <= 64):
        raise ValueError("cardano: icarus entropy must be 16..64 bytes")
    mk = bytearray(C.pbkdf2_sha512(b"", ent, 4096, 96))
    kL = bytearray(mk[0:32])
    kR = bytes(mk[32:64])
    cc = bytes(mk[64:96])
    kL[0] &= 0xF8
    kL[31] &= 0x1F
    kL[31] |= 0x40
    kL = bytes(kL)
    return Bip32Ed25519Node(kL=kL, kR=kR, cc=cc, A=ED.scalar_mul_base(kL))


def derive_child(node: Bip32Ed25519Node, index: int) -> Bip32Ed25519Node:
    """One BIP32-Ed25519 step. Hardened (index >= 2^31) mixes the private key;
    soft mixes the public key A. kL' = 8·int_LE(Z[0:28]) + int_LE(kL)  (FULL
    256-bit, NO mod L); kR' = (int_LE(Z[32:64]) + int_LE(kR)) mod 2^256."""
    i_le = (index & 0xFFFFFFFF).to_bytes(4, "little")
    if index >= HARDENED:
        Z = C.hmac_sha512(node.cc, b"\x00" + node.kL + node.kR + i_le)
        cc2 = C.hmac_sha512(node.cc, b"\x01" + node.kL + node.kR + i_le)[32:64]
    else:
        Z = C.hmac_sha512(node.cc, b"\x02" + node.A + i_le)
        cc2 = C.hmac_sha512(node.cc, b"\x03" + node.A + i_le)[32:64]
    ZL = Z[0:28]
    ZR = Z[32:64]
    kL2 = _to_le(8 * _le(ZL) + _le(node.kL), 32)   # NO reduction mod L
    kR2 = _to_le(_le(ZR) + _le(node.kR), 32)
    return Bip32Ed25519Node(kL=kL2, kR=kR2, cc=cc2, A=ED.scalar_mul_base(kL2))


def _parse_segment(seg: str) -> int:
    hard = seg.endswith("'") or seg.endswith("h") or seg.endswith("H")
    num = int(seg[:-1]) if hard else int(seg)
    return num + HARDENED if hard else num


def derive_path(node: Bip32Ed25519Node, path: str) -> Bip32Ed25519Node:
    """Derive ``m/..`` (e.g. ``m/1852'/1815'/0'/0/0``). Leading ``m`` optional.
    Account level is hardened; role + index are SOFT (CIP-1852)."""
    cur = node
    for seg in str(path).split("/"):
        if seg in ("", "m", "M"):
            continue
        cur = derive_child(cur, _parse_segment(seg))
    return cur


def derive_from_entropy(entropy, path: str) -> Bip32Ed25519Node:
    """Convenience: Icarus master from entropy, then derive ``path``."""
    return derive_path(icarus_master_key(entropy), path)
