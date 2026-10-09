"""BIP-32 hierarchical-deterministic derivation over secp256k1.

Python mirror of the BIP-32 half of ``blockle-extension/hd.js`` (global ``HD``).
Used by the EVM and BTC/LTC/DOGE adapters. Validated against BIP-32 Test
Vector 1 (xprv/xpub serialisation at m, m/0', m/0'/1/2'/2/1000000000).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import _core as C
from . import secp256k1 as S

HARDENED = 0x80000000


@dataclass
class HDNode:
    private_key: bytes | None
    public_key: bytes  # 33-byte compressed
    chain_code: bytes
    depth: int = 0
    index: int = 0
    parent_fingerprint: bytes = field(default_factory=lambda: b"\x00\x00\x00\x00")


def master_from_seed(seed) -> HDNode:
    I = C.hmac_sha512(C.utf8("Bitcoin seed"), C.to_bytes(seed))
    il, ir = I[:32], I[32:]
    d = S.bytes_to_big(il)
    if d == 0 or not S.is_valid_private(d):
        raise ValueError("invalid master key")
    return HDNode(
        private_key=il,
        public_key=S.public_key(il, True),
        chain_code=ir,
        depth=0,
        index=0,
        parent_fingerprint=b"\x00\x00\x00\x00",
    )


def _fingerprint(node: HDNode) -> bytes:
    return C.hash160(node.public_key)[:4]


def _ser32(i: int) -> bytes:
    return (i & 0xFFFFFFFF).to_bytes(4, "big")


def derive_child(node: HDNode, index: int) -> HDNode:
    hardened = index >= HARDENED
    if hardened:
        if node.private_key is None:
            raise ValueError("cannot derive hardened from a public node")
        data = b"\x00" + node.private_key + _ser32(index)
    else:
        data = node.public_key + _ser32(index)
    I = C.hmac_sha512(node.chain_code, data)
    il, ir = I[:32], I[32:]
    if S.bytes_to_big(il) >= S.N:
        return derive_child(node, index + 1)  # invalid IL, skip
    if node.private_key is not None:
        try:
            child_priv = S.priv_add(node.private_key, il)
        except Exception:
            return derive_child(node, index + 1)
        return HDNode(
            private_key=child_priv,
            public_key=S.public_key(child_priv, True),
            chain_code=ir,
            depth=node.depth + 1,
            index=index,
            parent_fingerprint=_fingerprint(node),
        )
    try:
        child_pub = S.point_add_scalar(node.public_key, il)
    except Exception:
        return derive_child(node, index + 1)
    return HDNode(
        private_key=None,
        public_key=child_pub,
        chain_code=ir,
        depth=node.depth + 1,
        index=index,
        parent_fingerprint=_fingerprint(node),
    )


def parse_path(path: str):
    parts = path.split("/")
    if parts[0] != "m":
        raise ValueError("path must start with 'm'")
    out = []
    for p in parts[1:]:
        hardened = p.endswith(("'", "h", "H"))
        n = int(p[:-1] if hardened else p)
        if n < 0:
            raise ValueError(f"bad path segment: {p}")
        out.append((n + HARDENED) & 0xFFFFFFFF if hardened else n)
    return out


def derive_path(seed_or_node, path: str) -> HDNode:
    node = seed_or_node if isinstance(seed_or_node, HDNode) else master_from_seed(seed_or_node)
    for index in parse_path(path):
        node = derive_child(node, index)
    return node


def serialize(node: HDNode, pub: bool, version_hex: str | None = None) -> str:
    if version_hex is None:
        version_hex = "0488b21e" if pub else "0488ade4"
    version = C.hex_to_bytes(version_hex)
    depth = bytes([node.depth & 0xFF])
    parent_fp = node.parent_fingerprint or b"\x00\x00\x00\x00"
    child_index = _ser32(node.index)
    if pub:
        key = node.public_key
    else:
        key = b"\x00" + node.private_key
    return C.base58check_encode(version + depth + parent_fp + child_index + node.chain_code + key)
