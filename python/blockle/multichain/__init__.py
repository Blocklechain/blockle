"""Blockle multi-chain wallet layer (Python).

A faithful Python port of the audited browser-extension multi-chain modules
(``blockle-extension/*.js``) and the Flutter port
(``blockle-app/lib/multichain``), so the PySide6 Qt wallet can be multi-chain
(EVM + ERC-20 USDC/USDT, BTC/LTC/DOGE, Solana, BLOCK) with an encrypted vault.

Layers:
  * :mod:`blockle.multichain.crypto` — hashes, secp256k1 (coincurve), ed25519
    (pynacl), keccak, base58check, bech32, BIP39/BIP32, SLIP-0010, EVM/UTXO
    addresses. Validated against the published vectors (BIP32 TV1, BIP39
    Trezor, EIP-55, BIP84 ``bc1qcr8te4…``, RFC 8032 ed25519, SLIP-0010 SOL).
  * :mod:`blockle.multichain.chains` — the uniform ChainAdapter per chain
    (EVM, UTXO, Solana, BLOCK) + the ChainRegistry.
  * :mod:`blockle.multichain.vault` — scrypt + AES-256-GCM v2 sealed storage,
    byte-for-byte portable with the extension / Flutter vaults.

HARD RULES honoured here: keys/seeds/LLM creds are NEVER logged, sent, or
stored unencrypted; signing is local; only BLOCK is post-quantum; endpoints are
config; the layer is additive and importable without touching qtwallet.
"""

from __future__ import annotations

from . import crypto, exchange, telemetry, vault, venues
from .chains import (AssetRef, Balance, BroadcastResult, BuiltTx, ChainAdapter,
                     ChainRegistry, DerivedAccount, RootSecret, create_registry)
from .vault import Vault, WrongPassword

__all__ = [
    "crypto", "vault", "Vault", "WrongPassword",
    "AssetRef", "Balance", "BroadcastResult", "BuiltTx", "ChainAdapter",
    "DerivedAccount", "RootSecret", "ChainRegistry", "create_registry",
    "venues", "telemetry", "exchange",
]
