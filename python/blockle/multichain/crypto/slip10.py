"""SLIP-0010 HD derivation for Ed25519 (Solana).

Python mirror of the SLIP-0010 helper in ``blockle-extension/chains/solana.js``.
Ed25519 keys are hardened-only: every path segment MUST be hardened. The
standard Solana account path is ``m/44'/501'/0'/0'`` (Phantom-compatible).

Validated against SLIP-0010 Test Vector 1 (ed25519) at m and m/0'.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import _core as C

HARDENED = 0x80000000


@dataclass
class Slip10Node:
    key: bytes  # 32-byte ed25519 seed
    chain_code: bytes


def _ser32(i: int) -> bytes:
    return (i & 0xFFFFFFFF).to_bytes(4, "big")


def master_key(seed) -> Slip10Node:
    I = C.hmac_sha512(C.utf8("ed25519 seed"), C.to_bytes(seed))
    return Slip10Node(key=I[:32], chain_code=I[32:64])


def derive_child(node: Slip10Node, index: int) -> Slip10Node:
    data = b"\x00" + node.key + _ser32(index)
    I = C.hmac_sha512(node.chain_code, data)
    return Slip10Node(key=I[:32], chain_code=I[32:64])


def parse_path(path: str):
    parts = path.split("/")
    if parts[0] != "m":
        raise ValueError("path must start with 'm'")
    out = []
    for p in parts[1:]:
        if not p.endswith(("'", "h", "H")):
            raise ValueError(f"ed25519 derivation requires hardened segments: {p}")
        n = int(p[:-1])
        if n < 0:
            raise ValueError(f"bad path segment: {p}")
        out.append((n + HARDENED) & 0xFFFFFFFF)
    return out


def derive(seed, path: str) -> Slip10Node:
    node = master_key(seed)
    for index in parse_path(path):
        node = derive_child(node, index)
    return node
