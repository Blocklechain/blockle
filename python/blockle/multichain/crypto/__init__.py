"""Crypto primitives + HD/address layer for the multi-chain wallet.

A flat re-export of the submodules so callers can do::

    from blockle.multichain import crypto as K
    K.sha256(b"...")            # hashing
    K.mnemonic_to_seed(mn)      # BIP39
    K.derive_path(seed, path)   # BIP32
    K.evm_address(pub)          # addresses

The submodules mirror the audited browser-extension modules
(``crypto-core.js``, ``secp256k1.js``, ``ed25519.js``, ``hd.js``,
``address.js``, ``bech32.js``) and the Flutter port under
``blockle-app/lib/multichain/crypto``.
"""

from __future__ import annotations

from . import _core, address, bech32, bip32, bip39, ed25519, secp256k1, slip10

# ---- _core (hashing / encoding) ----
to_bytes = _core.to_bytes
hex_to_bytes = _core.hex_to_bytes
bytes_to_hex = _core.bytes_to_hex
concat_bytes = _core.concat_bytes
utf8 = _core.utf8
sha256 = _core.sha256
sha512 = _core.sha512
ripemd160 = _core.ripemd160
keccak256 = _core.keccak256
hash256 = _core.hash256
hash160 = _core.hash160
hmac_sha256 = _core.hmac_sha256
hmac_sha512 = _core.hmac_sha512
pbkdf2_sha512 = _core.pbkdf2_sha512
base58encode = _core.base58encode
base58decode = _core.base58decode
base58check_encode = _core.base58check_encode
base58check_decode = _core.base58check_decode
rlp_encode = _core.rlp_encode

# ---- BIP39 ----
entropy_to_mnemonic = bip39.entropy_to_mnemonic
generate_mnemonic = bip39.generate_mnemonic
mnemonic_to_entropy = bip39.mnemonic_to_entropy
validate_mnemonic = bip39.validate_mnemonic
mnemonic_to_seed = bip39.mnemonic_to_seed

# ---- BIP32 ----
HDNode = bip32.HDNode
master_from_seed = bip32.master_from_seed
derive_child = bip32.derive_child
derive_path = bip32.derive_path
parse_path = bip32.parse_path
serialize = bip32.serialize
HARDENED = bip32.HARDENED

# ---- addresses ----
evm_address = address.evm_address
to_checksum_address = address.to_checksum_address
p2wpkh = address.p2wpkh
p2pkh = address.p2pkh
to_wif = address.to_wif
from_wif = address.from_wif

__all__ = [
    "_core", "address", "bech32", "bip32", "bip39", "ed25519", "secp256k1", "slip10",
    "to_bytes", "hex_to_bytes", "bytes_to_hex", "concat_bytes", "utf8",
    "sha256", "sha512", "ripemd160", "keccak256", "hash256", "hash160",
    "hmac_sha256", "hmac_sha512", "pbkdf2_sha512",
    "base58encode", "base58decode", "base58check_encode", "base58check_decode",
    "rlp_encode",
    "entropy_to_mnemonic", "generate_mnemonic", "mnemonic_to_entropy",
    "validate_mnemonic", "mnemonic_to_seed",
    "HDNode", "master_from_seed", "derive_child", "derive_path", "parse_path",
    "serialize", "HARDENED",
    "evm_address", "to_checksum_address", "p2wpkh", "p2pkh", "to_wif", "from_wif",
]
