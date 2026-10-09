"""Password-sealed encryption of wallet secrets.

Python mirror of ``blockle-extension/vault.js`` and ``blockle-app/.../vault.dart``.
The sealed blob is byte-for-byte portable across the extension, the Flutter app
and this Qt wallet: the same ``{ v, kdf:{name,params}, salt, iv, data }`` JSON,
the same scrypt(N=16384, r=8, p=1) KDF, and the same AES-256-GCM AEAD (128-bit
tag appended to the ciphertext, exactly like WebCrypto / libsodium).

The vault holds the entire secret state as one authenticated-encrypted blob:
  * the BLOCK identity (ML-DSA-44 keypair) — post-quantum,
  * the HD seed for every secp256k1 chain (EVM / BTC / LTC / DOGE) — ECDSA,
  * the Solana ed25519 key (derived from the same seed),
  * and private settings (agent credential, endpoints, token list).

IMPORTANT (honest scoping): the vault is a STORAGE property, not a signature
property. Sealing a BTC/LTC/DOGE/EVM key in a memory-hard vault does NOT make
that key post-quantum — those chains sign with ECDSA. Only BLOCK's on-chain
signatures are post-quantum (ML-DSA-44). The vault hardens every key against
OFFLINE theft of the stored blob; it says nothing about the signature scheme.

Crypto:
  v2 (current) — scrypt (RFC 7914, memory-hard) -> AES-256-GCM (AEAD).
  v1 (legacy)  — PBKDF2-SHA256/310k -> AES-256-GCM. Still opens; callers
                 transparently re-seal as v2 on the next successful unlock.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Legacy v1 KDF cost (only used to OPEN old blobs).
_PBKDF2_ITERS = 310000

# v2 KDF cost. scrypt N=2^14, r=8, p=1 ~ 16 MiB of memory-hard work per guess —
# the standard "interactive" setting. Params are stored in the sealed blob so
# they can evolve without breaking existing vaults.
SCRYPT = {"N": 16384, "r": 8, "p": 1}
KEY_LEN = 32  # AES-256


class WrongPassword(Exception):
    """Wrong password (AES-GCM auth-tag failure) or a tampered blob.

    Normalised so there is no decryption oracle beyond "wrong password".
    """

    def __init__(self, message="wrong password"):
        super().__init__(message)


def _b64(b) -> str:
    return base64.b64encode(bytes(b)).decode("ascii")


def _unb64(s) -> bytes:
    return base64.b64decode(s)


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, dk_len: int) -> bytes:
    # maxmem must be big enough for N=16384,r=8 (~16 MiB); give it headroom.
    return hashlib.scrypt(password.encode("utf-8"), salt=bytes(salt), n=n, r=r, p=p,
                          dklen=dk_len, maxmem=64 * 1024 * 1024)


def _kdf_of(sealed: dict) -> dict:
    if sealed and sealed.get("kdf") and sealed["kdf"].get("name"):
        return sealed["kdf"]
    return {"name": "pbkdf2", "params": {"iters": _PBKDF2_ITERS}}


def _key_for(sealed: dict, password: str, salt: bytes) -> bytes:
    kdf = _kdf_of(sealed)
    if kdf["name"] == "scrypt":
        p = kdf.get("params") or SCRYPT
        return _scrypt(password, salt, p["N"], p["r"], p["p"], KEY_LEN)
    if kdf["name"] == "pbkdf2":
        iters = (kdf.get("params") or {}).get("iters", _PBKDF2_ITERS)
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes(salt), iters, KEY_LEN)
    raise ValueError(f'vault: unknown kdf "{kdf["name"]}"')


def seal(obj, password: str) -> dict:
    """plaintext object + password -> SealedVault dict (salt/iv/data base64)."""
    salt = os.urandom(16)
    iv = os.urandom(12)
    dk = _scrypt(password, salt, SCRYPT["N"], SCRYPT["r"], SCRYPT["p"], KEY_LEN)
    pt = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(dk).encrypt(iv, pt, None)
    return {
        "v": 2,
        "kdf": {"name": "scrypt", "params": {"N": SCRYPT["N"], "r": SCRYPT["r"], "p": SCRYPT["p"]}},
        "salt": _b64(salt),
        "iv": _b64(iv),
        "data": _b64(ct),
    }


def open(sealed: dict, password: str):
    """sealed + password -> object. Raises :class:`WrongPassword` on failure."""
    salt = _unb64(sealed["salt"])
    key = _key_for(sealed, password, salt)
    try:
        pt = AESGCM(key).decrypt(_unb64(sealed["iv"]), _unb64(sealed["data"]), None)
    except Exception:
        raise WrongPassword()
    return json.loads(pt.decode("utf-8"))


def needs_upgrade(sealed: dict) -> bool:
    """True if a blob is not in the current (v2 / scrypt) format and should be
    transparently re-sealed on the next unlock."""
    return (not sealed) or sealed.get("v") != 2 or _kdf_of(sealed)["name"] != "scrypt"


class Vault:
    """Namespace mirroring the JS ``Vault`` object (``Vault.seal`` / ``.open``)."""

    seal = staticmethod(seal)
    open = staticmethod(open)
    needs_upgrade = staticmethod(needs_upgrade)
