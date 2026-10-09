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
