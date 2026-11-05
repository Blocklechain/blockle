"""CashAddr (Bitcoin Cash) address codec.

Python mirror of the CashAddr helpers in ``blockle-extension/address.js`` /
``blockle-app/lib/multichain/crypto/address.dart``.

CashAddr is NOT bech32 — it uses a DIFFERENT 40-bit BCH polymod (the final
``^ 1`` plays the role of bech32's constant). This is a self-contained codec; it
reuses only the shared base32 ``CHARSET`` + ``convert_bits`` from ``bech32``.
"""

from __future__ import annotations

from . import _core
from .bech32 import CHARSET, convert_bits

_CASH_GEN = [0x98F2BC8E61, 0x79B76D99E2, 0xF33E5FB3C4, 0xAE2EABE2A8, 0x1E4F43E470]


def _polymod(values) -> int:
    c = 1
    for v in values:
        b = c >> 35
        c = ((c & 0x07FFFFFFFF) << 5) ^ v
        for i in range(5):
            if (b >> i) & 1:
                c ^= _CASH_GEN[i]
    return c ^ 1


def _prefix_expand(prefix: str):
    return [ord(x) & 0x1F for x in prefix] + [0]


def looks_like_cashaddr(addr: str) -> bool:
    """Cheap heuristic: prefixed form always counts; bare form must be exactly
    42 base32 chars (34 payload + 8 checksum for a 160-bit hash)."""
    if not addr:
        return False
    if ":" in addr:
        return True
    if len(addr) != 42:
        return False
    low = addr.lower()
    return all(ch in CHARSET for ch in low)


def cash_addr_encode(prefix: str, kind: int, hash_bytes) -> str:
    """Encode a CashAddr. ``kind``: 0 = P2PKH, 1 = P2SH. 160-bit hash => sizeBits 0."""
    h = _core.to_bytes(hash_bytes)
    version_byte = (kind << 3) | 0
    payload8 = [version_byte] + list(h)
    data = convert_bits(payload8, 8, 5, True)
    checksum_input = _prefix_expand(prefix) + data + [0] * 8
    mod = _polymod(checksum_input)
    checksum = [(mod >> (5 * (7 - i))) & 0x1F for i in range(8)]
    return prefix + ":" + "".join(CHARSET[d] for d in data + checksum)


def cash_addr_decode(addr: str, expect_prefix: str = "bitcoincash"):
    """Decode a CashAddr (prefixed or bare). Returns ``{prefix, type, hash}``."""
    if ":" in addr:
        prefix, body = addr.lower().split(":", 1)
    else:
        prefix, body = expect_prefix, addr.lower()
    values = []
    for ch in body:
        d = CHARSET.find(ch)
        if d < 0:
            raise ValueError("bad cashaddr char")
        values.append(d)
    if _polymod(_prefix_expand(prefix) + values) != 0:
        raise ValueError("bad cashaddr checksum")
    payload = convert_bits(values[:-8], 5, 8, False)
    if payload is None:
        raise ValueError("bad cashaddr payload")
    version_byte = payload[0]
    return {"prefix": prefix, "type": version_byte >> 3, "hash": bytes(payload[1:])}


def cash_addr_p2pkh(pubkey, prefix: str = "bitcoincash") -> str:
    """Derive a CashAddr P2PKH from a compressed pubkey."""
    h160 = _core.hash160(_core.to_bytes(pubkey))
    return cash_addr_encode(prefix, 0, h160)
