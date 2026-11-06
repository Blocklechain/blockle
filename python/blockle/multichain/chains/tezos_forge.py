"""chains/tezos_forge.py — pure, NETWORK-FREE Tezos binary codec engine.

The Tezos analogue of ``chains/ton_cell.py`` (BOC) and ``chains/stellar_xdr.py``
(XDR): a self-contained forge + base58check module that BOTH the adapter
(``chains/tezos.py``) and the golden-vector test call. No I/O.

Fund-safety posture: the CLIENT forges the whole manager operation here; the node
supplies ONLY the branch (verifiable head block hash) and account counter
(verifiable per-account) — never any part of the signed payload.

Primitives (all byte-exact, cross-checked against the extension JS engine):
  * zarith(n)      — unsigned base-128 LEB128 varint (fee/counter/gas/storage/amount).
  * public_key_hash — curve tag (0x00 tz1 / 0x01 tz2 / 0x02 tz3) || 20B blake2b hash.
  * contract_id    — 0x00||pkh (implicit tzN) or 0x01||20B||0x00 (originated KT1).
  * edpk / tz1 / edsig — standard-alphabet base58check with Tezos prefix bytes.
  * forge_transaction — a single 'transaction' manager operation to hex.
  * signing_bytes  — blake2b(0x03 watermark || forged, 32).

blake2b is stdlib (``hashlib.blake2b(data, digest_size=20|32)``) — no new dep.
Ported from the extension's chains/tezos-forge.js.
"""
from __future__ import annotations

import hashlib

from .. import crypto as K

# ---- Tezos base58 prefix bytes (standard) ---------------------------------
PREFIX = {
    "tz1": bytes([6, 161, 159]),          # ed25519 public-key hash   -> 'tz1…'
    "tz2": bytes([6, 161, 161]),          # secp256k1 public-key hash -> 'tz2…'
    "tz3": bytes([6, 161, 164]),          # p256 public-key hash      -> 'tz3…'
    "KT1": bytes([2, 90, 121]),           # originated contract       -> 'KT1…'
    "edpk": bytes([13, 15, 37, 217]),     # ed25519 public key        -> 'edpk…'
    "edsig": bytes([9, 245, 205, 134, 18]),  # ed25519 signature      -> 'edsig…'
    "B": bytes([1, 52]),                  # block hash                -> 'B…'
    "o": bytes([5, 116]),                 # operation hash            -> 'o…'
}
CURVE_TAG = {"tz1": 0x00, "tz2": 0x01, "tz3": 0x02}
TRANSACTION_TAG = 0x6C
WATERMARK_GENERIC = 0x03


def blake2b(data, digest_size: int = 32) -> bytes:
    """BLAKE2b with a variable digest length (20 for pkh, 32 for signing)."""
    return hashlib.blake2b(K.to_bytes(data), digest_size=digest_size).digest()


# ---- base58check with a Tezos multi-byte prefix ---------------------------
# Tezos uses the SAME Bitcoin base58 alphabet + double-SHA256 checksum as the
# shared crypto core, so no custom codec is needed (unlike XRP).
def b58c_encode(prefix_bytes: bytes, raw) -> str:
    return K.base58check_encode(bytes(prefix_bytes) + K.to_bytes(raw))


def b58c_decode_expect(s: str, prefix_bytes: bytes) -> bytes:
    payload = K.base58check_decode(str(s))
    p = bytes(prefix_bytes)
    if len(payload) < len(p) or payload[: len(p)] != p:
        raise ValueError("tezos: wrong base58 prefix")
    return payload[len(p):]


def edpk(pub32) -> str:
    pub = K.to_bytes(pub32)
    if len(pub) != 32:
        raise ValueError("tezos: ed25519 pubkey must be 32 bytes")
    return b58c_encode(PREFIX["edpk"], pub)


def tz1(pub32) -> str:
    pub = K.to_bytes(pub32)
    if len(pub) != 32:
        raise ValueError("tezos: ed25519 pubkey must be 32 bytes")
    return b58c_encode(PREFIX["tz1"], blake2b(pub, 20))


def edsig(sig64) -> str:
    sig = K.to_bytes(sig64)
    if len(sig) != 64:
        raise ValueError("tezos: ed25519 signature must be 64 bytes")
    return b58c_encode(PREFIX["edsig"], sig)


def address_kind(addr):
    if not isinstance(addr, str):
        return None
    m = addr[:3]
    if m in ("tz1", "tz2", "tz3", "KT1"):
        try:
            b58c_decode_expect(addr, PREFIX[m])
            return m
        except Exception:
            return None
    return None


def is_tz1(addr) -> bool:
    return address_kind(addr) == "tz1"


def is_tezos_destination(addr) -> bool:
    # WE issue tz1 only; SEND accepts tz1/tz2/tz3/KT1.
    return address_kind(addr) is not None


# ---- zarith: unsigned base-128 LEB128 varint ------------------------------
def zarith(n) -> bytes:
    v = int(n)
    if v < 0:
        raise ValueError("zarith: value must be non-negative")
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v != 0:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


# ---- public-key-hash / contract-id encodings ------------------------------
def public_key_hash(addr) -> bytes:
    kind = address_kind(addr)
    if kind is None or kind not in CURVE_TAG:
        raise ValueError("tezos: not a tzN public-key-hash: " + str(addr))
    raw = b58c_decode_expect(addr, PREFIX[kind])
    if len(raw) != 20:
        raise ValueError("tezos: pkh must be 20 bytes")
    return bytes([CURVE_TAG[kind]]) + raw


def contract_id(addr) -> bytes:
    kind = address_kind(addr)
    if kind is None:
        raise ValueError("tezos: not a contract id: " + str(addr))
    if kind == "KT1":
        raw = b58c_decode_expect(addr, PREFIX["KT1"])
        if len(raw) != 20:
            raise ValueError("tezos: KT1 hash must be 20 bytes")
        return bytes([0x01]) + raw + bytes([0x00])
    return bytes([0x00]) + public_key_hash(addr)


# ---- forge a single 'transaction' manager operation -----------------------
def forge_transaction(fields: dict) -> str:
    """fields = {branch, source(tz1), fee, counter, gas_limit, storage_limit,
    amount, destination}. Returns hex (NO watermark, NO signature)."""
    branch_raw = b58c_decode_expect(fields["branch"], PREFIX["B"])
    if len(branch_raw) != 32:
        raise ValueError("tezos: branch must decode to 32 bytes")
    out = bytearray()
    out += branch_raw
    out.append(TRANSACTION_TAG)
    out += public_key_hash(fields["source"])
    out += zarith(fields["fee"])
    out += zarith(fields["counter"])
    out += zarith(fields["gas_limit"])
    out += zarith(fields["storage_limit"])
    out += zarith(fields["amount"])
    out += contract_id(fields["destination"])
    out.append(0x00)  # parameters flag: none
    return bytes(out).hex()


def signing_bytes(forged_hex: str) -> bytes:
    forged = bytes.fromhex(forged_hex)
    return blake2b(bytes([WATERMARK_GENERIC]) + forged, 32)


def injection_hex(forged_hex: str, sig64) -> str:
    return forged_hex + K.to_bytes(sig64).hex()
