"""Blockle encrypted-backup client (Qt wallet) — Python port.

Talks to the accounts service as a native wallet (bearer token). Encryption is local via
backup_crypto; only opaque ciphertext is uploaded (zero-knowledge). 2FA is required for backup
ops, so a current TOTP code is supplied. Shared contract with backup-client.js / backup_client.dart.
"""
import json
import urllib.request
import urllib.error

from . import backup_crypto

DEFAULT_ORIGIN = "https://blockle.org"


def _req(origin, method, path, token=None, totp=None, body=None):
    headers = {"x-blockle-client": "wallet"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    if totp:
        headers["x-totp"] = totp
    req = urllib.request.Request((origin or DEFAULT_ORIGIN) + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error", f"http {e.code}")
        except Exception:
            msg = f"http {e.code}"
        raise RuntimeError(msg)


def login(origin, email, password, totp=None):
    d = _req(origin, "POST", "/account/api/login", body={"email": email, "password": password, "totp": totp})
    if not d.get("token"):
        raise RuntimeError("no token returned")
    return d["token"], d.get("user")


def me(origin, token):
    """The signed-in account (incl. ``sub`` with the Copilot tier) — for feature gating."""
    return _req(origin, "GET", "/account/api/me", token=token).get("user")


def tier_of(user):
    """Extract the Copilot subscription tier from a /me user object. 'free' when inactive."""
    sub = (user or {}).get("sub") or {}
    return (sub.get("tier") or "free") if sub.get("active") else "free"


def backup(origin, token, totp, vault_obj, passphrase, meta=None):
    plaintext = vault_obj if isinstance(vault_obj, str) else json.dumps(vault_obj)
    ciphertext = backup_crypto.encrypt_vault(passphrase, plaintext)
    _req(origin, "PUT", "/account/api/backup", token=token, totp=totp,
         body={"ciphertext": ciphertext, "meta": meta or {}})
    return True


def restore(origin, token, totp, passphrase):
    d = _req(origin, "GET", "/account/api/backup", token=token, totp=totp)
    latest = d.get("latest") or {}
    if not latest.get("ciphertext"):
        raise RuntimeError("no backup stored")
    return backup_crypto.decrypt_vault(passphrase, latest["ciphertext"])
