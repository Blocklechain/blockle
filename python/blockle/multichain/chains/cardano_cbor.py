"""chains/cardano_cbor.py — pure, NETWORK-FREE canonical CBOR codec for Cardano
transactions (the Cardano analogue of tezos_forge / ton_cell / xrpl_codec /
stellar_xdr).

Only the subset Cardano tx serialization needs, and ONLY in canonical /
definite-length form (RFC 8949 §4.2 core deterministic encoding):
  * unsigned int  (major 0)  — minimal width 0x00..0x17 inline, else 1a/18/19/1b
  * byte string   (major 2)  — 0x40|len (minimal-width len header) || bytes
  * array         (major 4)  — 0x80|len header || items
  * map           (major 5)  — 0xa0|len header || (key,value)* ; caller supplies
                               keys already in canonical (ascending) order
  * ``True`` and ``None``    — simple values 0xf5 / 0xf6 (signed-tx trailer)

Encodes a Shelley/Babbage/Conway transaction body + the signed-tx wrapper. No
I/O. Mirrors the extension's chains/cardano-cbor.js; unit-gated by the cborKats
in docs/cardano-vectors.json before the adapter trusts it.
"""
from __future__ import annotations

from .. import crypto as K


# ---- primitive heads ------------------------------------------------------
def _head(major: int, n: int) -> bytes:
    """Major-type head with a canonical minimal-width argument ``n``."""
    mt = major << 5
    if n < 0:
        raise ValueError("cbor: negative length/uint")
    if n < 24:
        return bytes([mt | n])
    if n < 0x100:
        return bytes([mt | 24, n])
    if n < 0x10000:
        return bytes([mt | 25]) + n.to_bytes(2, "big")
    if n < 0x100000000:
        return bytes([mt | 26]) + n.to_bytes(4, "big")
    if n < 0x10000000000000000:
        return bytes([mt | 27]) + n.to_bytes(8, "big")
    raise ValueError("cbor: integer too large for a 64-bit argument")


def uint(n) -> bytes:
    """Canonical unsigned integer (major 0)."""
    v = int(n)
    if v < 0:
        raise ValueError("cbor: uint must be non-negative")
    return _head(0, v)


def bstr(data) -> bytes:
    """Definite-length byte string (major 2)."""
    b = K.to_bytes(data)
    return _head(2, len(b)) + b


def array(items) -> bytes:
    """Definite-length array (major 4); ``items`` are already-encoded byte
    chunks."""
    items = list(items)
    return _head(4, len(items)) + b"".join(items)


def cmap(pairs) -> bytes:
    """Definite-length map (major 5). ``pairs`` is a list of (key_bytes,
    value_bytes) ALREADY in canonical key order — the caller is responsible for
    ordering (tx-body keys are the small ints 0..3, emitted ascending)."""
    pairs = list(pairs)
    out = _head(5, len(pairs))
    for k, v in pairs:
        out += k + v
    return out


TRUE = b"\xf5"
NULL = b"\xf6"


# ---- Cardano transaction structures ---------------------------------------
def encode_input(tx_hash32, index) -> bytes:
    """A transaction input = [ bytes .size 32 (tx hash), uint (output index) ]."""
    h = K.to_bytes(tx_hash32)
    if len(h) != 32:
        raise ValueError("cardano: input tx hash must be 32 bytes")
    return array([bstr(h), uint(index)])


def encode_output(addr_bytes, coin) -> bytes:
    """A (coin-only) output = [ bytes (address), uint (lovelace) ]. v1 sends
    pure-ADA outputs only; native-asset bundling (the {coin, multiasset} map
    form) is a v2 follow-up and deliberately not emitted here."""
    return array([bstr(addr_bytes), uint(coin)])


def tx_body(inputs, outputs, fee, ttl) -> bytes:
    """Canonical tx_body map {0: [inputs], 1: [outputs], 2: fee, 3: ttl}.

    ``inputs`` = iterable of (tx_hash32, index); ``outputs`` = iterable of
    (addr_bytes, coin). Keys are emitted in ascending order 0,1,2,3."""
    in_arr = array([encode_input(h, i) for (h, i) in inputs])
    out_arr = array([encode_output(a, c) for (a, c) in outputs])
    return cmap([
        (uint(0), in_arr),
        (uint(1), out_arr),
        (uint(2), uint(fee)),
        (uint(3), uint(ttl)),
    ])


def vkey_witness(vkey32, sig64) -> bytes:
    """A single vkey witness = [ bytes .size 32 (pubkey), bytes .size 64 (sig) ]."""
    vk = K.to_bytes(vkey32)
    sg = K.to_bytes(sig64)
    if len(vk) != 32:
        raise ValueError("cardano: vkey must be 32 bytes")
    if len(sg) != 64:
        raise ValueError("cardano: signature must be 64 bytes")
    return array([bstr(vk), bstr(sg)])


def witness_set(vkey_witnesses) -> bytes:
    """Witness set map {0: [vkey_witnesses]} (only key 0 in v1 — no native
    scripts / plutus)."""
    wits = list(vkey_witnesses)
    return cmap([(uint(0), array(wits))])


def signed_tx(body_cbor, vkey_witnesses, auxiliary=None) -> bytes:
    """Babbage/Conway signed transaction =
    [ tx_body, witness_set, is_valid(True), auxiliary_data(null) ]."""
    aux = NULL if auxiliary is None else K.to_bytes(auxiliary)
    return array([
        K.to_bytes(body_cbor),
        witness_set(vkey_witnesses),
        TRUE,
        aux,
    ])
