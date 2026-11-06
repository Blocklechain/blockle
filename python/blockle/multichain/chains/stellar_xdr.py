"""chains/stellar_xdr.py — the minimal Stellar XDR encoder + strkey address
codec the Stellar adapter (chains/stellar.py) and the golden-vector tests depend
on. Byte-identical logic to the extension's chains/stellar-xdr.js (the canonical
engine) and cross-checked against stellar-sdk (TransactionEnvelope / StrKey /
Keypair).

A v1 TransactionEnvelope with a single Payment op (native XLM or an AlphaNum4
issued asset) is serialized with standard XDR. The signature base is
SHA256( networkId || ENVELOPE_TYPE_TX(=2) || txXDR ), networkId =
SHA256(network passphrase); the tx hash is that same SHA256. The ed25519
signature of the 32-byte hash plus the 4-byte key hint form the single
DecoratedSignature in the envelope.

NOT post-quantum — ed25519 is classical EC crypto.
"""
from __future__ import annotations

import base64 as _b64

from .. import crypto as K
from ..crypto import ed25519 as ED

PUBLIC_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
ENVELOPE_TYPE_TX = 2
STRKEY_VERSION_ACCOUNT = 6 << 3   # 0x30 -> 'G…'
B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
BASE_FEE = 100                    # stroops per operation


# ---- CRC-16/XMODEM (poly 0x1021, init 0x0000) — same as ton_cell.crc16 ------
def crc16_xmodem(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return crc


# ---- base32 (RFC 4648, no padding) -----------------------------------------
def base32_encode(data: bytes) -> str:
    bits = 0
    value = 0
    out = []
    for b in data:
        value = (value << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append(B32[(value >> bits) & 31])
    if bits > 0:
        out.append(B32[(value << (5 - bits)) & 31])
    return "".join(out)


def base32_decode(s: str) -> bytes:
    bits = 0
    value = 0
    out = bytearray()
    for ch in s:
        d = B32.find(ch)
        if d < 0:
            raise ValueError("stellar: bad base32 char")
        value = (value << 5) | d
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((value >> bits) & 0xFF)
    return bytes(out)


# ---- strkey 'G…' account address -------------------------------------------
def encode_ed25519_public_key(pub32) -> str:
    pub = K.to_bytes(pub32)
    if len(pub) != 32:
        raise ValueError("stellar: ed25519 pubkey must be 32 bytes")
    payload = bytes([STRKEY_VERSION_ACCOUNT]) + pub
    crc = crc16_xmodem(payload)
    payload += bytes([crc & 0xFF, (crc >> 8) & 0xFF])  # little-endian
    return base32_encode(payload)


def decode_ed25519_public_key(addr: str) -> bytes:
    raw = base32_decode(str(addr))
    if len(raw) != 35 or raw[0] != STRKEY_VERSION_ACCOUNT:
        raise ValueError("stellar: not a 'G…' account address")
    body, chk = raw[:33], raw[33:]
    crc = crc16_xmodem(body)
    if chk != bytes([crc & 0xFF, (crc >> 8) & 0xFF]):
        raise ValueError("stellar: bad strkey checksum")
    return body[1:]


def is_stellar_address(addr) -> bool:
    if not isinstance(addr, str) or not addr.startswith("G") or len(addr) != 56:
        return False
    try:
        return len(decode_ed25519_public_key(addr)) == 32
    except Exception:
        return False


# ---- XDR primitives ---------------------------------------------------------
def _u32(v) -> bytes:
    return int(v).to_bytes(4, "big")


def _i64(v) -> bytes:
    return int(v).to_bytes(8, "big", signed=True)


def _opaque_var(b: bytes) -> bytes:
    return _u32(len(b)) + b + b"\x00" * ((4 - len(b) % 4) % 4)


def _muxed_ed25519(pub32: bytes) -> bytes:
    return _u32(0) + bytes(pub32)      # CryptoKeyType KEY_TYPE_ED25519 = 0, uint256


def _account_id(pub32: bytes) -> bytes:
    return _u32(0) + bytes(pub32)      # PublicKey PUBLIC_KEY_TYPE_ED25519 = 0


def asset_native() -> bytes:
    return _u32(0)                     # ASSET_TYPE_NATIVE


def asset_alphanum4(code: str, issuer_pub32: bytes) -> bytes:
    c = code.encode("ascii")
    if len(c) > 4:
        raise ValueError("stellar: AlphaNum4 code > 4 chars")
    c = c + b"\x00" * (4 - len(c))
    return _u32(1) + c + _account_id(issuer_pub32)   # ASSET_TYPE_CREDIT_ALPHANUM4 = 1


def payment_op(dest_pub32: bytes, amount_stroops, asset_xdr: bytes = None) -> bytes:
    body = _muxed_ed25519(dest_pub32)
    body += asset_xdr if asset_xdr is not None else asset_native()
    body += _i64(amount_stroops)
    # Operation: sourceAccount optional(none=0) + OperationBody union(PAYMENT=1)
    return _u32(0) + _u32(1) + body


def transaction_xdr(source_pub32: bytes, fee: int, seqnum: int, ops: list) -> bytes:
    out = _muxed_ed25519(source_pub32)
    out += _u32(fee)
    out += _i64(seqnum)
    out += _u32(0)   # Preconditions: PRECOND_NONE
    out += _u32(0)   # Memo: MEMO_NONE
    out += _u32(len(ops))
    for op in ops:
        out += op
    out += _u32(0)   # Transaction.ext v = 0
    return out


def network_id(passphrase: str = PUBLIC_NETWORK_PASSPHRASE) -> bytes:
    return K.sha256(passphrase.encode("utf-8"))


def signing_base(tx_xdr: bytes, passphrase: str = PUBLIC_NETWORK_PASSPHRASE) -> bytes:
    return network_id(passphrase) + _u32(ENVELOPE_TYPE_TX) + tx_xdr


def tx_hash(tx_xdr: bytes, passphrase: str = PUBLIC_NETWORK_PASSPHRASE) -> bytes:
    return K.sha256(signing_base(tx_xdr, passphrase))


def build_signed_envelope(source_pub32, seed_key, seqnum: int, ops: list,
                          fee: int = None, passphrase: str = PUBLIC_NETWORK_PASSPHRASE) -> dict:
    """Build + ed25519-sign a v1 TransactionEnvelope. Returns dict with
    txXDRunsignedHex / signingBaseHex / hash / signatureHex / hint /
    envelopeXDRBase64."""
    source_pub32 = K.to_bytes(source_pub32)
    fee = (BASE_FEE * len(ops)) if fee is None else fee
    tx = transaction_xdr(source_pub32, fee, seqnum, ops)
    base = signing_base(tx, passphrase)
    h = K.sha256(base)
    signature = ED.sign(h, seed_key)
    hint = source_pub32[-4:]
    env = _u32(ENVELOPE_TYPE_TX) + tx + _u32(1) + hint + _opaque_var(signature)
    return {"txXDRunsignedHex": tx.hex(), "signingBaseHex": base.hex(),
            "hash": h.hex(), "signatureHex": signature.hex(), "hint": hint.hex(),
            "envelopeXDRBase64": _b64.b64encode(env).decode("ascii")}
