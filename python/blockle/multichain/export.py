"""Wallet export — every key type, incl. Core-importable BTC/LTC/DOGE dumps.

Python port of ``blockle-extension/wallet-export.js`` (the REFERENCE
implementation). Reproduces ``docs/wallet-export-vectors.json`` BYTE-FOR-BYTE:
the same WIF / 0x-hex / base58 secret keys per chain and the same
``importwallet`` dump lines as the extension and the Flutter app.

Lets the user export everything needed to recover funds elsewhere, BEHIND THE
SECURITY GATE (vault unlocked + an explicit confirm that surfaces a
plain-language danger warning):

  1. the BIP-39 mnemonic (+ passphrase) and the raw seed hex,
  2. per-chain private keys for the active account:
       * UTXO (BTC/LTC/DOGE): WIF, chain-correct version byte (BTC 0x80,
         LTC 0xb0, DOGE 0x9e),
       * EVM: 0x-hex private key,
       * Solana: base58 secret key (64-byte seed||pubkey, Phantom-style),
       * BLOCK: the native ML-DSA key from the Wallet session (where applicable),
  3. a Bitcoin-Core ``importwallet``-format dump file for BTC/LTC/DOGE — the
     ``# Wallet dump`` header + per-key lines Core ingests via ``importwallet``
     to rebuild its ``wallet.dat``.

SAFETY: export is READ-ONLY key material. It NEVER moves funds, NEVER touches
the network, is NEVER logged and is NEVER placed in any agent / telemetry /
gateway payload. This module contains ZERO network and ZERO logging calls by
construction. Every path is blocked while the vault is locked and on a
declined confirm.

Reuses this wallet's existing key derivation (``multichain.crypto`` +
``chains.utxo.NETWORKS`` paths) so an exported key controls the exact address
the live adapters show.
"""

from __future__ import annotations

import inspect

from . import crypto as K
from .crypto import ed25519 as ED
from .chains.utxo import NETWORKS as UTXO_NETWORKS

# The derivation paths MUST match the live adapters exactly (chains/evm.py,
# chains/solana.py, chains/utxo.py) so an exported key controls the same
# address the wallet shows.
EVM_PATH = "m/44'/60'/0'/0"       # chains/evm.py
SOL_PATH = "m/44'/501'/0'/0'"     # chains/solana.py (SLIP-0010, hardened)

# Plain-language danger warning the confirm MUST surface before any export.
DANGER_WARNING = (
    "DANGER — these secrets give FULL, IRREVERSIBLE control of your funds. "
    "Anyone who sees your recovery phrase or a private key can take everything. "
    "Never share them, never type them into a website or chat, and never send "
    "them to anyone — Blockle support will NEVER ask for them. Only save them "
    "somewhere private and offline."
)


def _to_seed(seed) -> bytes:
    """Coerce a mnemonic-derived seed, {'seed':...}, hex string or bytes to
    raw seed bytes."""
    if not seed:
        raise ValueError("no seed")
    if isinstance(seed, (bytes, bytearray, memoryview)):
        return bytes(seed)
    if isinstance(seed, dict) and seed.get("seed") is not None:
        return _to_seed(seed["seed"])
    inner = getattr(seed, "seed", None)
    if inner is not None:
        return _to_seed(inner)
    if isinstance(seed, str):
        return K.hex_to_bytes(seed)
    return K.to_bytes(seed)


# ---- 1. mnemonic + seed hex ----------------------------------------------
def from_mnemonic(mnemonic: str, passphrase: str = "") -> dict:
    """The mnemonic is NOT recoverable from the seed, so the caller supplies it
    (it lives in the vault). Returns the seed too so the key derivations can
    reuse it without re-running PBKDF2."""
    seed = K.mnemonic_to_seed(mnemonic, passphrase or "")
    return {"mnemonic": mnemonic, "passphrase": passphrase or "",
            "seedHex": K.bytes_to_hex(seed), "seed": seed}


# ---- 2. per-chain private keys -------------------------------------------
def _utxo_net(chain_id: str) -> dict:
    net = UTXO_NETWORKS.get(chain_id)
    if not net:
        raise ValueError("not a UTXO chain: " + str(chain_id))
    return net


def _utxo_address(net: dict, node) -> str:
    if net["segwit"]:
        return K.p2wpkh(node.public_key, net["hrp"])
    return K.p2pkh(node.public_key, net["p2pkh"])


def utxo_key(chain_id: str, seed, index: int = 0) -> dict:
    index = index or 0
    net = _utxo_net(chain_id)
    path = net["path"] + "/" + str(index)
    node = K.derive_path(_to_seed(seed), path)
    return {
        "chain": chain_id, "index": index, "path": path,
        "address": _utxo_address(net, node),
        "wif": K.to_wif(node.private_key, net["wif"], True),
        "wifVersion": net["wif"],
        "publicKey": K.bytes_to_hex(node.public_key),
    }


def evm_key(seed, index: int = 0) -> dict:
    index = index or 0
    path = EVM_PATH + "/" + str(index)
    node = K.derive_path(_to_seed(seed), path)
    return {
        "chain": "evm", "index": index, "path": path,
        "address": K.evm_address(node.public_key),
        "privateKey": "0x" + K.bytes_to_hex(node.private_key),
        "publicKey": K.bytes_to_hex(node.public_key),
    }


def sol_path_for_index(index: int) -> str:
    if index and SOL_PATH.endswith("/0'"):
        return SOL_PATH[:-len("/0'")] + "/" + str(index) + "'"
    return SOL_PATH


def solana_key(seed, index: int = 0) -> dict:
    index = index or 0
    path = sol_path_for_index(index)
    node = K.slip10.derive(_to_seed(seed), path)
    pub = ED.public_key(node.key)
    # Phantom/Solana-CLI "secret key" = base58(32-byte seed || 32-byte pubkey).
    secret = K.concat_bytes(node.key, pub)
    return {
        "chain": "solana", "index": index, "path": path,
        "address": K.base58encode(pub),
        "secretKey": K.base58encode(secret),
        "publicKey": K.bytes_to_hex(pub),
    }


def block_key(session) -> dict | None:
    """BLOCK is NOT HD-derived — its ML-DSA-44 keypair lives in the Wallet
    session. Export it straight from the (unlocked) session object. Not part of
    the shared vectors (not seed-derivable). Returns ``None`` when the session
    has no key material."""
    if not session:
        return None

    def pick(*names):
        for n in names:
            if isinstance(session, dict):
                v = session.get(n)
            else:
                v = getattr(session, n, None)
            if v:
                return v
        return None

    secret = pick("secretKeyHex", "secretHex", "privateKeyHex")
    pub = pick("publicKeyHex", "publicHex")
    address = pick("address")
    if not secret or not pub:
        return None
    return {"chain": "block", "scheme": "ml-dsa-44", "address": address,
            "secretKey": secret, "publicKey": pub}


def private_keys(seed, index: int = 0) -> dict:
    """Every seed-derived private key for one account index."""
    index = index or 0
    s = _to_seed(seed)
    return {
        "bitcoin": utxo_key("bitcoin", s, index),
        "litecoin": utxo_key("litecoin", s, index),
        "dogecoin": utxo_key("dogecoin", s, index),
        "evm": evm_key(s, index),
        "solana": solana_key(s, index),
    }


# ---- 3. Bitcoin-Core importwallet dump (BTC/LTC/DOGE) --------------------
def dump_line(k: dict, label: str, time: str) -> str:
    return (k["wif"] + " " + time + " label=" + label
            + " # addr=" + k["address"] + " hdkeypath=" + k["path"])


def core_dump(chain_id: str, seed, opts: dict | None = None) -> str:
    """Core's ``importwallet`` reads whitespace-separated lines of the form
    ``<WIF> <timestamp> label=<label> # addr=<address> hdkeypath=<path>``; the
    ``# Wallet dump`` header + ``#``-comment lines are ignored. Core rebuilds
    its ``wallet.dat`` from exactly these keys."""
    opts = opts or {}
    _utxo_net(chain_id)  # validate
    indices = opts.get("indices") or [opts.get("index", 0)]
    label = opts.get("label") or ("blockle-" + chain_id)
    time = opts.get("time") or "2024-01-01T00:00:00Z"
    s = _to_seed(seed)
    lines = [
        "# Wallet dump created by Blockle",
        "# * Created on " + time,
        "#",
    ]
    for i in indices:
        lines.append(dump_line(utxo_key(chain_id, s, i), label, time))
    lines.append("")  # trailing newline
    return "\n".join(lines)


def core_dump_filename(chain_id: str) -> str:
    return chain_id + "-blockle-import.txt"


def parse_dump(text: str) -> list:
    """Parse a dump back to its key lines — the inverse used by the Core
    round-trip test (and by any importer):
    ``[{wif, time, label, address, hdkeypath}]``."""
    out = []
    for raw in str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        hash_at = line.find(" # ")
        head = line[:hash_at] if hash_at >= 0 else line
        tail = line[hash_at + 3:] if hash_at >= 0 else ""
        parts = head.split()
        wif = parts[0]
        time = parts[1] if len(parts) > 1 else ""
        label = ""
        for p in parts[2:]:
            if p.startswith("label="):
                label = p[len("label="):]
        address = None
        hdkeypath = None
        for tok in tail.split():
            if tok.startswith("addr="):
                address = tok[len("addr="):].rstrip(",")
            elif tok.startswith("hdkeypath="):
                hdkeypath = tok[len("hdkeypath="):]
        out.append({"wif": wif, "time": time, "label": label,
                    "address": address, "hdkeypath": hdkeypath})
    return out


# ---- THE SECURITY GATE ----------------------------------------------------
def _maybe_call(confirm, warning):
    """Call ``confirm(warning)`` and resolve an awaitable result if the handler
    is a coroutine (so sync and async confirm handlers both work)."""
    try:
        res = confirm(warning)
    except Exception:
        return False
    if inspect.isawaitable(res):
        import asyncio
        try:
            return bool(asyncio.get_event_loop().run_until_complete(res))
        except RuntimeError:
            return bool(asyncio.run(res))
    return bool(res)


def gate(opts: dict | None = None) -> dict:
    """Blocks export unless the vault is unlocked AND the user passes an
    explicit confirm that surfaces :data:`DANGER_WARNING`. Fails closed (no
    confirm handler → no export). Touches NO secret material itself."""
    opts = opts or {}
    if not opts.get("unlocked"):
        return {"allowed": False, "reason": "locked", "warning": DANGER_WARNING}
    confirm = opts.get("confirm")
    if not callable(confirm):
        return {"allowed": False, "reason": "no-confirm-handler", "warning": DANGER_WARNING}
    ok = _maybe_call(confirm, DANGER_WARNING)
    return {"allowed": bool(ok), "reason": "confirmed" if ok else "declined",
            "warning": DANGER_WARNING}


def export_secrets(opts: dict | None = None) -> dict:
    """Gated export: runs the gate, then (only if allowed) assembles the
    requested material. Returns ``{ok:False, reason, warning}`` when blocked —
    never any secret. No logging, no network, nothing handed to any sink."""
    opts = opts or {}
    g = gate(opts)
    if not g["allowed"]:
        return {"ok": False, "reason": g["reason"], "warning": g["warning"]}
    index = opts.get("index", 0) or 0
    out = {"ok": True}
    seed = opts.get("seed")
    if opts.get("mnemonic"):
        out["mnemonic"] = from_mnemonic(opts["mnemonic"], opts.get("passphrase", ""))
        seed = seed or out["mnemonic"]["seed"]
    if seed:
        out["keys"] = private_keys(seed, index)
    if opts.get("blockSession"):
        b = block_key(opts["blockSession"])
        if b:
            out["block"] = b
    if opts.get("coreDumps") and seed:
        indices = opts.get("indices") or [index]
        out["dumps"] = {}
        for c in ("bitcoin", "litecoin", "dogecoin"):
            out["dumps"][c] = {"filename": core_dump_filename(c),
                               "text": core_dump(c, seed, {"indices": indices})}
    return out
