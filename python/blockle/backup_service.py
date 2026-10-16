"""backup_service.py — encrypted cloud backup/restore for the Qt wallet.

Thin orchestration over backup_client (bearer-token auth + upload/download) and backup_crypto
(on-device encryption under a SEPARATE backup passphrase). The caller supplies the vault's
plaintext as a dict (its own key model) and gets it back on restore; only opaque ciphertext is
uploaded, so the server can never read it. 2FA is required for backup ops. Same-wallet restore;
the envelope format is shared with the extension + Flutter wallets.
"""
from . import backup_client


def backup_payload(origin, email, password, totp, payload: dict, passphrase: str, meta=None):
    """Encrypt + upload the vault `payload` dict. Requires a current TOTP code."""
    token, _ = backup_client.login(origin, email, password, totp)
    meta = {"app": "qt", **(meta or {})}
    backup_client.backup(origin, token, totp, payload, passphrase, meta)
    return True


def restore_payload(origin, email, password, totp, passphrase: str) -> dict:
    """Download + decrypt the latest backup; returns the vault payload dict.

    Raises on a wrong passphrase (GCM auth failure) — never returns partial/garbage data.
    """
    import json
    token, _ = backup_client.login(origin, email, password, totp)
    plaintext = backup_client.restore(origin, token, totp, passphrase)
    return json.loads(plaintext)
