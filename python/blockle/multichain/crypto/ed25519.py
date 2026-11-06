"""Ed25519 (RFC 8032) — the signature scheme Solana uses for account keys and
transaction signatures.

Python mirror of ``blockle-extension/ed25519.js`` (global ``Ed25519``), backed
by ``pynacl`` (libsodium) for constant-time signing/verification. The API takes
a 32-byte *secret seed* (not the 64-byte expanded libsodium secret key) exactly
like the JS/Dart ports, and returns the 64-byte detached signature.

NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ via ML-DSA).
Validated against RFC 8032 Section 7.1 test vectors 1/2/3.
"""

from __future__ import annotations

import nacl.bindings as _b

from . import _core as C


def public_key(seed) -> bytes:
    s = C.to_bytes(seed)
    if len(s) != 32:
        raise ValueError("ed25519 seed must be 32 bytes")
    pk, _sk = _b.crypto_sign_seed_keypair(s)
    return pk


def sign(message, seed) -> bytes:
    s = C.to_bytes(seed)
    if len(s) != 32:
        raise ValueError("ed25519 seed must be 32 bytes")
    _pk, sk = _b.crypto_sign_seed_keypair(s)
    signed = _b.crypto_sign(C.to_bytes(message), sk)
    return signed[:64]  # detached signature (strip the appended message)


def verify(message, signature, pub_key) -> bool:
    sig = C.to_bytes(signature)
    pub = C.to_bytes(pub_key)
    if len(sig) != 64 or len(pub) != 32:
        return False
    try:
        _b.crypto_sign_open(sig + C.to_bytes(message), pub)
        return True
    except Exception:
        return False


# ---- BIP32-Ed25519 extended-key signing (Cardano / CIP-1852) -------------
# Standard ``sign`` above SHA-512-expands a 32-byte seed into (a, prefix); it
# CANNOT sign with a BIP32-Ed25519 *extended* key, whose scalar ``a`` is given
# DIRECTLY (as the clamped left half kL) and whose nonce prefix is the right
# half kR — neither is a hash of a seed. Cardano needs this variant.
#
# Algorithm (Khovratovich / CIP-0003, producing a *standard* Ed25519 signature
# that verifies under :func:`verify` with A = scalarMulBase(kL)):
#   a  = int_LE(kL)                 (used directly; kL is already clamped)
#   r  = SHA-512(kR || msg)  mod L
#   R  = r·B      (compressed, 32B)
#   k  = SHA-512(R || A || msg) mod L
#   S  = (r + k·a) mod L            (32B little-endian)
#   signature = R || S              (64B)
#
# All scalar reductions / mul / add and the base-point multiply are libsodium
# (constant-time), so no hand-rolled field arithmetic. ``scalar_mul_base`` uses
# the NO-CLAMP base multiply because kL / the derived child scalars are already
# the final scalar (clamping them again would corrupt the key).
def scalar_mul_base(le_scalar) -> bytes:
    """A = n·B for a 32-byte little-endian scalar ``n`` (no extra clamping).

    Returns the 32-byte compressed Edwards point. Handles the full 256-bit
    scalar (libsodium reduces mod the group order internally), which is exactly
    what BIP32-Ed25519 child derivation (kL up to 2^256) requires."""
    s = C.to_bytes(le_scalar)
    if len(s) != 32:
        raise ValueError("ed25519 scalar must be 32 bytes")
    return _b.crypto_scalarmult_ed25519_base_noclamp(s)


def _sha512_mod_l(data) -> bytes:
    """SHA-512(data) reduced mod the Ed25519 group order L -> 32B little-endian."""
    import hashlib
    return _b.crypto_core_ed25519_scalar_reduce(hashlib.sha512(C.to_bytes(data)).digest())


def sign_extended(message, kL, kR, pub=None) -> bytes:
    """Sign ``message`` with a BIP32-Ed25519 extended key (kL left / kR right
    32-byte halves). Returns a 64-byte signature that VERIFIES under the
    standard :func:`verify` with the public key A = scalarMulBase(kL)."""
    kl = C.to_bytes(kL)
    kr = C.to_bytes(kR)
    if len(kl) != 32 or len(kr) != 32:
        raise ValueError("ed25519 extended key halves must be 32 bytes each")
    msg = C.to_bytes(message)
    A = C.to_bytes(pub) if pub is not None else scalar_mul_base(kl)
    if len(A) != 32:
        raise ValueError("ed25519 public key must be 32 bytes")
    r = _sha512_mod_l(kr + msg)
    R = scalar_mul_base(r)
    k = _sha512_mod_l(R + A + msg)
    a = _b.crypto_core_ed25519_scalar_reduce(kl + b"\x00" * 32)  # kL mod L
    S = _b.crypto_core_ed25519_scalar_add(r, _b.crypto_core_ed25519_scalar_mul(k, a))
    return R + S
