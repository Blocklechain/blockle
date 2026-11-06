"""chains/xrpl_codec.py — the minimal XRP Ledger binary codec + classic-address
codec the XRP adapter (chains/xrp.py) and the golden-vector tests depend on.
Byte-identical logic to the extension's chains/xrpl-codec.js (the canonical
engine) and cross-checked against xrpl-py (xrpl.core.binarycodec /
addresscodec).

A Payment is serialized in canonical field order (sorted by (type_code,
field_code)) with the standard XRPL type serializers. Signing hashes the
'STX\\0'-prefixed serialization WITHOUT TxnSignature with SHA512-half (first 32
bytes of SHA512); the secp256k1 low-S DER goes in TxnSignature; the tx is then
re-serialized WITH the signature for submit. The tx hash is SHA512-half of the
'TXN\\0'-prefixed full signed serialization (upper hex).

NOT post-quantum — secp256k1/ECDSA, exactly like Bitcoin/Ethereum.
"""
from __future__ import annotations

from .. import crypto as K

RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"
ACCOUNT_PREFIX = b"\x00"               # classic address version byte 0x00 -> 'r…'
STX_PREFIX = b"\x53\x54\x58\x00"       # 'STX\0' single-sig signing prefix
TXN_PREFIX = b"\x54\x58\x4e\x00"       # 'TXN\0' tx-id prefix
TX_PAYMENT = 0                         # TransactionType enum
TF_FULLY_CANONICAL_SIG = 0x80000000


# ---- ripple base58check (double-SHA256 4-byte checksum, ripple alphabet) ----
def _b58_encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = RIPPLE_ALPHABET[r] + out
    for byte in b:
        if byte == 0:
            out = RIPPLE_ALPHABET[0] + out
        else:
            break
    return out


def _b58_decode(s: str) -> bytes:
    n = 0
    for ch in s:
        d = RIPPLE_ALPHABET.find(ch)
        if d < 0:
            raise ValueError("xrp: bad ripple-base58 char")
        n = n * 58 + d
    full = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = 0
    for ch in s:
        if ch == RIPPLE_ALPHABET[0]:
            pad += 1
        else:
            break
    return b"\x00" * pad + full


def ripple_b58check_encode(payload: bytes) -> str:
    chk = K.sha256(K.sha256(payload))[:4]
    return _b58_encode(payload + chk)


def ripple_b58check_decode(s: str) -> bytes:
    raw = _b58_decode(s)
    if len(raw) < 5:
        raise ValueError("xrp: base58check too short")
    payload, chk = raw[:-4], raw[-4:]
    if K.sha256(K.sha256(payload))[:4] != chk:
        raise ValueError("xrp: bad base58check checksum")
    return payload


# ---- classic address --------------------------------------------------------
def account_id_from_pubkey(pub33) -> bytes:
    """AccountID = RIPEMD160(SHA256(compressed-pubkey)) (20 bytes)."""
    return K.hash160(K.to_bytes(pub33))


def classic_address(pub33) -> str:
    return ripple_b58check_encode(ACCOUNT_PREFIX + account_id_from_pubkey(pub33))


def address_from_account_id(account_id20: bytes) -> str:
    return ripple_b58check_encode(ACCOUNT_PREFIX + bytes(account_id20))


def account_id_from_address(addr: str) -> bytes:
    payload = ripple_b58check_decode(str(addr))
    if len(payload) != 21 or payload[0] != 0:
        raise ValueError("xrp: not a classic address")
    return payload[1:]


def is_xrp_address(addr) -> bool:
    if not isinstance(addr, str) or not addr.startswith("r"):
        return False
    try:
        return len(account_id_from_address(addr)) == 20
    except Exception:
        return False


# ---- field table + binary serializer ----------------------------------------
# (type_code, field_code, kind) per rippled definitions.json.
FIELDS = {
    "TransactionType":    (1, 2, "UInt16"),
    "Flags":              (2, 2, "UInt32"),
    "Sequence":           (2, 4, "UInt32"),
    "DestinationTag":     (2, 14, "UInt32"),
    "LastLedgerSequence": (2, 27, "UInt32"),
    "Amount":             (6, 1, "Amount"),
    "Fee":                (6, 8, "Amount"),
    "SigningPubKey":      (7, 3, "Blob"),
    "TxnSignature":       (7, 4, "Blob"),
    "Account":            (8, 1, "AccountID"),
    "Destination":        (8, 3, "AccountID"),
}


def _field_id(type_code: int, field_code: int) -> bytes:
    if type_code < 16 and field_code < 16:
        return bytes([(type_code << 4) | field_code])
    if type_code >= 16 and field_code < 16:
        return bytes([field_code, type_code])
    if type_code < 16 and field_code >= 16:
        return bytes([type_code << 4, field_code])
    return bytes([0, type_code, field_code])


def _vl_length(n: int) -> bytes:
    if n <= 192:
        return bytes([n])
    if n <= 12480:
        n -= 193
        return bytes([193 + (n >> 8), n & 0xFF])
    if n <= 918744:
        n -= 12481
        return bytes([241 + (n >> 16), (n >> 8) & 0xFF, n & 0xFF])
    raise ValueError("xrp: VL field too long")


def _enc_amount_xrp(drops) -> bytes:
    v = int(drops)
    if v < 0:
        raise ValueError("xrp: negative drops")
    # bit 63 = 0 (XRP, not issued), bit 62 = 1 (positive)
    return (v | 0x4000000000000000).to_bytes(8, "big")


def _enc_field(name: str, val) -> bytes:
    t, f, kind = FIELDS[name]
    hdr = _field_id(t, f)
    if kind == "UInt16":
        body = int(val).to_bytes(2, "big")
    elif kind == "UInt32":
        body = int(val).to_bytes(4, "big")
    elif kind == "Amount":
        body = _enc_amount_xrp(val)
    elif kind in ("AccountID", "Blob"):
        payload = bytes.fromhex(val) if isinstance(val, str) else bytes(val)
        body = _vl_length(len(payload)) + payload
    else:
        raise ValueError("xrp: unknown field kind " + kind)
    return hdr + body


def serialize(fields: dict, for_signing: bool = False) -> bytes:
    """Serialize the tx fields in canonical order. Amount/Fee are drops strings;
    Account/Destination/*PubKey/*Signature are hex; ints are ints. None values
    are skipped; TxnSignature is skipped when ``for_signing``."""
    items = []
    for name, val in fields.items():
        if val is None:
            continue
        if for_signing and name == "TxnSignature":
            continue
        t, f, _ = FIELDS[name]
        items.append((t, f, name, val))
    items.sort(key=lambda it: (it[0], it[1]))
    return b"".join(_enc_field(name, val) for _, _, name, val in items)


def sha512_half(b: bytes) -> bytes:
    return K.sha512(b)[:32]


def signing_hash(fields: dict) -> bytes:
    return sha512_half(STX_PREFIX + serialize(fields, for_signing=True))


def tx_hash(signed_blob: bytes) -> str:
    return sha512_half(TXN_PREFIX + signed_blob).hex().upper()


def build_payment_fields(account_addr: str, dest_addr: str, amount_drops, fee_drops,
                         sequence: int, last_ledger_sequence: int, signing_pubkey_hex: str,
                         flags: int = TF_FULLY_CANONICAL_SIG, destination_tag=None) -> dict:
    """Build the ordered Payment field map (AccountID/Destination as hex account
    ids). ``signing_pubkey_hex`` is the 33-byte compressed pubkey hex."""
    fields = {
        "TransactionType": TX_PAYMENT,
        "Flags": int(flags),
        "Sequence": int(sequence),
        "LastLedgerSequence": int(last_ledger_sequence),
        "Amount": str(amount_drops),
        "Fee": str(fee_drops),
        "SigningPubKey": signing_pubkey_hex.lower(),
        "Account": account_id_from_address(account_addr).hex(),
        "Destination": account_id_from_address(dest_addr).hex(),
    }
    if destination_tag is not None:
        fields["DestinationTag"] = int(destination_tag)
    return fields


def build_signed_payment(fields: dict, priv) -> dict:
    """Sign the payment fields (secp256k1 low-S DER over SHA512-half('STX\\0'||
    tx-without-sig)) and re-serialize with TxnSignature. Returns dict with
    txBlobHex / txnSignatureDerHex / signHashHex / hash."""
    from ..crypto import secp256k1 as S
    h = signing_hash(fields)
    sig = S.sign(h, priv)
    der = sig.der
    signed = dict(fields)
    signed["TxnSignature"] = der.hex()
    blob = serialize(signed, for_signing=False)
    return {"txBlobHex": blob.hex(), "txnSignatureDerHex": der.hex(),
            "signHashHex": h.hex(), "hash": tx_hash(blob), "fields": signed}
