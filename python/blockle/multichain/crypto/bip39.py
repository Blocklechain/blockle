"""BIP-39 mnemonic <-> entropy <-> seed.

Python mirror of the BIP-39 half of ``blockle-extension/hd.js``. The BIP-39
seed is the HD root stored (sealed) in the vault; each chain derives its
account from it via a BIP44/BIP84 path.

Validated against the Trezor ``abandon…about`` / "TREZOR" seed vector.
"""

from __future__ import annotations

import os
import unicodedata

from . import _core as C
from .wordlist import WORDLIST

_INDEX = {w: i for i, w in enumerate(WORDLIST)}


def entropy_to_mnemonic(entropy) -> str:
    ent = C.to_bytes(entropy)
    if len(ent) % 4 != 0 or not (16 <= len(ent) <= 32):
        raise ValueError("bad entropy length")
    cs_bits = (len(ent) * 8) // 32
    bits = "".join(f"{b:08b}" for b in ent)
    cs = "".join(f"{b:08b}" for b in C.sha256(ent))[:cs_bits]
    bits += cs
    words = [WORDLIST[int(bits[i:i + 11], 2)] for i in range(0, len(bits), 11)]
    return " ".join(words)


def generate_mnemonic(strength: int = 128) -> str:
    if strength % 32 != 0:
        raise ValueError("strength must be a multiple of 32")
    return entropy_to_mnemonic(os.urandom(strength // 8))


def mnemonic_to_entropy(mnemonic: str) -> bytes:
    words = unicodedata.normalize("NFKD", mnemonic).strip().split()
    if len(words) not in (12, 15, 18, 21, 24):
        raise ValueError("bad mnemonic word count")
    bits = ""
    for w in words:
        idx = _INDEX.get(w)
        if idx is None:
            raise ValueError(f"unknown word: {w}")
        bits += f"{idx:011b}"
    cs_bits = len(words) // 3
    ent_bits = len(bits) - cs_bits
    entropy = bytes(int(bits[i:i + 8], 2) for i in range(0, ent_bits, 8))
    cs_check = "".join(f"{b:08b}" for b in C.sha256(entropy))[:cs_bits]
    if bits[ent_bits:] != cs_check:
        raise ValueError("invalid mnemonic checksum")
    return entropy


def validate_mnemonic(mnemonic: str) -> bool:
    try:
        mnemonic_to_entropy(mnemonic)
        return True
    except Exception:
        return False


def mnemonic_to_seed(mnemonic: str, passphrase: str = "") -> bytes:
    mn = unicodedata.normalize("NFKD", mnemonic).encode("utf-8")
    salt = unicodedata.normalize("NFKD", "mnemonic" + passphrase).encode("utf-8")
    return C.pbkdf2_sha512(mn, salt, 2048, 64)
