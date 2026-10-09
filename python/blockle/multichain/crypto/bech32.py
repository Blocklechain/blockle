"""bech32 / bech32m (BIP-173 / BIP-350) + native SegWit address codec.

Python mirror of the bech32 helpers in ``blockle-extension/address.js`` /
``bech32.js``. Used for BTC/LTC P2WPKH (``bc1…`` / ``ltc1…``) and the BLOCK
``block1…`` address rendering.
"""

from __future__ import annotations

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GEN = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
_BECH32M_CONST = 0x2BC830A3


def _polymod(values) -> int:
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (b >> i) & 1:
                chk ^= _GEN[i]
    return chk


def _hrp_expand(hrp: str):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _create_checksum(hrp: str, data, spec: str):
    const = _BECH32M_CONST if spec == "bech32m" else 1
    values = _hrp_expand(hrp) + list(data) + [0, 0, 0, 0, 0, 0]
    mod = _polymod(values) ^ const
    return [(mod >> (5 * (5 - i))) & 31 for i in range(6)]


def _verify_checksum(hrp: str, data, spec: str) -> bool:
    const = _BECH32M_CONST if spec == "bech32m" else 1
    return _polymod(_hrp_expand(hrp) + list(data)) == const


def convert_bits(data, frm: int, to: int, pad: bool):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << to) - 1
    for value in data:
        if value < 0 or (value >> frm):
            return None
        acc = (acc << frm) | value
        bits += frm
        while bits >= to:
            bits -= to
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (to - bits)) & maxv)
    elif bits >= frm or ((acc << (to - bits)) & maxv):
        return None
    return ret


def encode(hrp: str, data_bytes) -> bytes:
    """Plain bech32 encode of raw bytes (BLOCK ``block1…`` addresses)."""
    data = convert_bits(list(bytes(data_bytes)), 8, 5, True)
    combined = data + _create_checksum(hrp, data, "bech32")
    return hrp + "1" + "".join(CHARSET[d] for d in combined)


def segwit_encode(hrp: str, witver: int, program) -> str:
    prog = bytes(program)
    spec = "bech32" if witver == 0 else "bech32m"
    data = [witver] + convert_bits(list(prog), 8, 5, True)
    combined = data + _create_checksum(hrp, data, spec)
    return hrp + "1" + "".join(CHARSET[d] for d in combined)


def segwit_decode(hrp: str, addr: str):
    lowered = addr.lower()
    if not lowered.startswith(hrp + "1"):
        raise ValueError("wrong hrp")
    body = lowered[len(hrp) + 1:]
    data = []
    for ch in body:
        d = CHARSET.find(ch)
        if d < 0:
            raise ValueError("bad bech32 char")
        data.append(d)
    witver = data[0]
    spec = "bech32" if witver == 0 else "bech32m"
    if not _verify_checksum(hrp, data, spec):
        raise ValueError("bad bech32 checksum")
    program = convert_bits(data[1:-6], 5, 8, False)
    if program is None:
        raise ValueError("bad program")
    return {"version": witver, "program": bytes(program)}
