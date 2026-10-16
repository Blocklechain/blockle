"""Blockle encrypted-backup envelope (v1) — Python port.

Byte-for-byte compatible with blockle-extension/backup-crypto.js and
blockle-app/lib/multichain/backup_crypto.dart so a backup made on any wallet restores on any
other. The vault is encrypted on-device with a key derived from the backup passphrase; only the
opaque envelope leaves the device (zero-knowledge — the server can't decrypt). Verified against
docs/backup-vectors.json.

Envelope: base64url( utf8( JSON {v,kdf,iter,salt,nonce,ct} ) )
  kdf   = PBKDF2-HMAC-SHA256, iter iterations, 32-byte key   (symmetric -> post-quantum safe)
  cipher= AES-256-GCM, 12-byte nonce, AAD = b"blockle-backup-v1", ct = ciphertext||tag (base64)
"""
import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITER = 600000
AAD = b"blockle-backup-v1"


def _derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations, dklen=32)


def encrypt_vault(passphrase: str, plaintext: str, *, salt: bytes | None = None,
                  nonce: bytes | None = None, iterations: int = ITER) -> str:
    salt = salt if salt is not None else os.urandom(16)
    nonce = nonce if nonce is not None else os.urandom(12)
    key = _derive_key(passphrase, salt, iterations)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), AAD)  # ciphertext||tag
    env = {
        "v": 1, "kdf": "pbkdf2-sha256", "iter": iterations,
        "salt": base64.b64encode(salt).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "ct": base64.b64encode(ct).decode(),
    }
    return base64.urlsafe_b64encode(json.dumps(env, separators=(",", ":")).encode("utf-8")).decode()


def decrypt_vault(passphrase: str, blob: str) -> str:
    # urlsafe_b64decode needs correct padding; add it back.
    pad = "=" * (-len(blob) % 4)
    env = json.loads(base64.urlsafe_b64decode(blob + pad).decode("utf-8"))
    if env.get("v") != 1 or env.get("kdf") != "pbkdf2-sha256":
        raise ValueError("unsupported backup version")
    key = _derive_key(passphrase, base64.b64decode(env["salt"]), int(env["iter"]))
    pt = AESGCM(key).decrypt(base64.b64decode(env["nonce"]), base64.b64decode(env["ct"]), AAD)
    return pt.decode("utf-8")
