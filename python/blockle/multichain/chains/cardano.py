"""chains/cardano.py — the Cardano (ADA) ChainAdapter.

* key: Ed25519-BIP32 via Icarus (CIP-0003) from the BIP39 ENTROPY + CIP-1852
  BIP32-Ed25519 derivation (crypto/bip32_ed25519.py). NOT SLIP-0010. Payment key
  m/1852'/1815'/0'/0/index; stake key m/1852'/1815'/0'/2/0.
* address: Shelley base (mainnet). payment_cred = blake2b-224(payment_pub32),
  stake_cred = blake2b-224(stake_pub32); header 0x01 (type 0 base, network 1);
  addr_bytes = header || payment_cred(28) || stake_cred(28); bech32 hrp 'addr'.
* native ADA = lovelace (6 decimals). Native-asset (CNT) amounts are surfaced
  for DISPLAY only; CNT SENDING is OUT of v1 scope (min-ADA + multi-asset
  bundling is a v2 follow-up) — never faked.
* SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety, like Tezos/TON/Stellar):
  tx_body canonical CBOR is forged LOCALLY (chains/cardano_cbor.py), txHash =
  blake2b-256(tx_body), signed with signExtended over the payment extended key.
  The ONLY node inputs are UTXOs + tip slot + protocol params — all verifiable,
  never the signed payload.
* provider is CONFIG: default KEYLESS Koios (https://api.koios.rest/api/v1);
  Blockfrost alt when endpoints.cardano.blockfrost.projectId is set.

ENTROPY CAVEAT: Icarus needs the BIP39 entropy, not the 64-byte seed. In Qt the
vault always has a BIP39 mnemonic, so the entropy is threaded in (see
qtmultichain._build). If only a bare seed reaches unlock/derive, this adapter
raises rather than inventing a non-CIP-3 derivation.

Ported from the extension's chains/cardano.js. Cross-checked byte-identical
against bip_utils (CardanoIcarus / Cip1852) in docs/cardano-vectors.json.
"""
from __future__ import annotations

import hashlib
import json
import urllib.request

from .. import crypto as K
from ..crypto import bip32_ed25519 as B32E
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_entropy, format_units)
from . import cardano_cbor as CBOR

ED = K.ed25519

LOVELACE = 1_000_000
HRP = "addr"
ADDR_HEADER = 0x01           # type 0 (base) | network 1 (mainnet)
PURPOSE = "1852'"
COIN_TYPE = "1815'"
# Shelley protocol minFee: fee = a*size + b. Current mainnet params.
DEFAULT_MIN_FEE_A = 44
DEFAULT_MIN_FEE_B = 155381
DEFAULT_TTL_DELTA = 7200     # ttl = current abs slot + ~2h
DEFAULT_KOIOS = "https://api.koios.rest/api/v1"
DEFAULT_EXPLORER = "https://cardanoscan.io/transaction/"


# ---- address helpers (pure) ----------------------------------------------
def blake2b_224(data) -> bytes:
    return hashlib.blake2b(K.to_bytes(data), digest_size=28).digest()


def blake2b_256(data) -> bytes:
    return hashlib.blake2b(K.to_bytes(data), digest_size=32).digest()


def base_address_bytes(payment_pub32, stake_pub32) -> bytes:
    pay = K.to_bytes(payment_pub32)
    stake = K.to_bytes(stake_pub32)
    if len(pay) != 32 or len(stake) != 32:
        raise ValueError("cardano: public keys must be 32 bytes")
    return bytes([ADDR_HEADER]) + blake2b_224(pay) + blake2b_224(stake)


def encode_address(payment_pub32, stake_pub32) -> str:
    return K.bech32.encode(HRP, base_address_bytes(payment_pub32, stake_pub32))


def decode_address(addr: str) -> bytes:
    """bech32-decode an ``addr1…`` string to its raw bytes; validate the header
    and 57-byte length. Raises on anything that is not a mainnet base address."""
    s = str(addr).strip()
    if not s.lower().startswith(HRP + "1"):
        raise ValueError("cardano: not an addr1 address")
    lowered = s.lower()
    data = []
    for ch in lowered[len(HRP) + 1:]:
        d = K.bech32.CHARSET.find(ch)
        if d < 0:
            raise ValueError("cardano: bad bech32 char")
        data.append(d)
    if not K.bech32._verify_checksum(HRP, data, "bech32"):
        raise ValueError("cardano: bad bech32 checksum")
    raw = K.bech32.convert_bits(data[:-6], 5, 8, False)
    if raw is None:
        raise ValueError("cardano: bad bech32 payload")
    raw = bytes(raw)
    if len(raw) != 57 or raw[0] != ADDR_HEADER:
        raise ValueError("cardano: not a mainnet Shelley base address")
    return raw


def is_cardano_address(addr) -> bool:
    try:
        decode_address(addr)
        return True
    except Exception:
        return False


def min_fee(size_bytes: int, a: int = DEFAULT_MIN_FEE_A, b: int = DEFAULT_MIN_FEE_B) -> int:
    return a * int(size_bytes) + b


# ---- key derivation (pure) ------------------------------------------------
def _payment_path(index: int) -> str:
    return f"m/{PURPOSE}/{COIN_TYPE}/0'/0/{int(index or 0)}"


def _stake_path() -> str:
    return f"m/{PURPOSE}/{COIN_TYPE}/0'/2/0"


def derive_keys(entropy, index: int = 0):
    """Return (payment_node, stake_node) for account 0, address ``index``."""
    master = B32E.icarus_master_key(entropy)
    pay = B32E.derive_path(master, _payment_path(index))
    stake = B32E.derive_path(master, _stake_path())
    return pay, stake


def build_signed_transaction(inputs, outputs, fee, ttl, payment_node) -> dict:
    """Forge the canonical tx_body, hash it, sign with the payment extended key,
    and assemble the signed-tx CBOR. Shared by build_send + the golden-vector
    test; deterministic + offline (no network). ``payment_node`` is a
    bip32_ed25519 node (kL/kR/A)."""
    body = CBOR.tx_body(inputs, outputs, fee, ttl)
    tx_hash = blake2b_256(body)
    sig = ED.sign_extended(tx_hash, payment_node.kL, payment_node.kR, payment_node.A)
    signed = CBOR.signed_tx(body, [CBOR.vkey_witness(payment_node.A, sig)])
    return {
        "txBodyCborHex": body.hex(),
        "txHashHex": tx_hash.hex(),
        "vkeyHex": payment_node.A.hex(),
        "signatureHex": sig.hex(),
        "signature": sig,
        "signedTxCborHex": signed.hex(),
    }


# ---- providers (Koios default / Blockfrost alt) ---------------------------
def _koios_http(base):
    b = str(base or DEFAULT_KOIOS).rstrip("/")

    def get(path):
        with urllib.request.urlopen(b + path, timeout=30) as r:
            return r.read().decode()

    def post(path, body, content_type="application/json"):
        data = body if isinstance(body, (bytes, bytearray)) else str(body).encode()
        req = urllib.request.Request(b + path, data=data,
                                     headers={"content-type": content_type}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode()

    return get, post


class CardanoAdapter:
    def __init__(self, koios=None, blockfrost=None, explorer=DEFAULT_EXPLORER,
                 symbol="ADA", http_get=None, http_post=None,
                 min_fee_a=DEFAULT_MIN_FEE_A, min_fee_b=DEFAULT_MIN_FEE_B,
                 ttl_delta=DEFAULT_TTL_DELTA, **_):
        self.id = "cardano"
        self.scheme = "ed25519-bip32"
        self.lovelace = LOVELACE
        self.explorer = explorer
        self.native = AssetRef(chain="cardano", kind="native", symbol=symbol, decimals=6)
        self._entropy = None
        self._min_fee_a = int(min_fee_a)
        self._min_fee_b = int(min_fee_b)
        self._ttl_delta = int(ttl_delta)
        self._blockfrost = blockfrost if (blockfrost and blockfrost.get("projectId")) else None
        self._koios = koios or DEFAULT_KOIOS
        g, p = _koios_http(self._koios)
        self._get = http_get or g
        self._post = http_post or p

    # ---- lock state ----
    def unlock(self, root):
        self._entropy = as_entropy(root)

    def lock(self):
        self._entropy = None

    def _require_entropy(self, root=None):
        ent = as_entropy(root) if root is not None else None
        ent = ent if ent is not None else self._entropy
        if ent is None:
            raise RuntimeError(
                "cardano: no BIP39 entropy available — Icarus (CIP-3) needs the "
                "entropy, not the 64-byte seed")
        return ent

    # ---- derivation ----
    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        ent = self._require_entropy(root)
        pay, stake = derive_keys(ent, index or 0)
        address = encode_address(pay.A, stake.A)
        return DerivedAccount(chain="cardano", index=index or 0, address=address,
                              publicKey=pay.A.hex(), scheme="ed25519-bip32",
                              path=_payment_path(index or 0))

    # ---- balances (Koios) ----
    def _utxos(self, address):
        if self._blockfrost:
            return self._blockfrost_utxos(address)
        body = json.dumps({"_addresses": [address]})
        raw = self._post("/address_utxos", body, "application/json")
        data = json.loads(raw) if raw else []
        return data if isinstance(data, list) else []

    def _blockfrost_utxos(self, address):
        base = str(self._blockfrost["url"]).rstrip("/")
        req = urllib.request.Request(base + "/addresses/" + address + "/utxos",
                                     headers={"project_id": self._blockfrost["projectId"]})
        with urllib.request.urlopen(req, timeout=30) as r:
            arr = json.loads(r.read().decode())
        # Normalize Blockfrost shape -> Koios-like {tx_hash, tx_index, value, asset_list}
        out = []
        for u in arr or []:
            amounts = u.get("amount") or []
            lovelace = "0"
            assets = []
            for a in amounts:
                if a.get("unit") == "lovelace":
                    lovelace = str(a.get("quantity", "0"))
                else:
                    unit = a.get("unit", "")
                    assets.append({"policy_id": unit[:56], "asset_name": unit[56:],
                                   "quantity": str(a.get("quantity", "0"))})
            out.append({"tx_hash": u.get("tx_hash"), "tx_index": u.get("output_index", 0),
                        "value": lovelace, "asset_list": assets})
        return out

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            utxos = self._utxos(address)
            total = 0
            assets = {}  # (policy, name) -> qty
            for u in utxos:
                total += int(u.get("value", 0) or 0)
                for a in (u.get("asset_list") or []):
                    key = (a.get("policy_id", ""), a.get("asset_name", ""))
                    assets[key] = assets.get(key, 0) + int(a.get("quantity", 0) or 0)
            ada = str(total)
            out.append(Balance(asset=self.native, confirmed=ada, display=format_units(ada, 6)))
            # Native-asset (CNT) amounts are DISPLAY-ONLY in v1 (no sending).
            for (policy, name), qty in assets.items():
                try:
                    label = bytes.fromhex(name).decode("ascii") if name else policy[:8]
                except Exception:
                    label = (policy[:8] + name)[:12]
                ref = AssetRef(chain="cardano", kind="cnt", symbol=label, decimals=0,
                               address=policy + name)
                out.append(Balance(asset=ref, confirmed=str(qty), display=str(qty)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        return out

    def discover_tokens(self, address: str):
        # CNT discovery surfaces via get_balance (display-only); no sendable list.
        return []

    # ---- tip / params ----
    def _tip_slot(self):
        if self._blockfrost:
            base = str(self._blockfrost["url"]).rstrip("/")
            req = urllib.request.Request(base + "/blocks/latest",
                                         headers={"project_id": self._blockfrost["projectId"]})
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read().decode())
            return int(j.get("slot", 0))
        raw = self._get("/tip")
        j = json.loads(raw)
        row = j[0] if isinstance(j, list) else j
        return int(row.get("abs_slot", 0))

    # ---- send (client-built + client-signed) ----
    def build_send(self, account, req) -> BuiltTx:
        ent = self._require_entropy()
        to = req.get("to") if isinstance(req, dict) else getattr(req, "to", None)
        amount = req.get("amount") if isinstance(req, dict) else getattr(req, "amount", None)
        if not to or amount is None:
            raise ValueError("cardano: to + amount required")
        if not is_cardano_address(to):
            raise ValueError("cardano: invalid destination address " + str(to))
        amount = int(amount)
        index = getattr(account, "index", 0) or 0
        pay, stake = derive_keys(ent, index)
        owner = getattr(account, "address", None) or encode_address(pay.A, stake.A)

        utxos = self._utxos(owner)
        # coin selection: largest-first until amount + a fee ceiling is covered.
        utxos = sorted(utxos, key=lambda u: int(u.get("value", 0) or 0), reverse=True)
        to_bytes = decode_address(to)
        self_bytes = decode_address(owner)
        rq = req if isinstance(req, dict) else {}
        ttl = int(rq.get("ttl") or (self._tip_slot() + self._ttl_delta))

        selected = []
        picked = 0
        built = None
        fee = self._min_fee_b
        for u in utxos:
            selected.append(u)
            picked += int(u.get("value", 0) or 0)
            # iterate fee: build with current estimate, re-measure, settle.
            for _ in range(3):
                change = picked - amount - fee
                outputs = [(to_bytes, amount)]
                if change > 0:
                    outputs.append((self_bytes, change))
                inputs = [(bytes.fromhex(x["tx_hash"]), int(x["tx_index"])) for x in selected]
                built = build_signed_transaction(inputs, outputs, fee, ttl, pay)
                size = len(bytes.fromhex(built["signedTxCborHex"]))
                new_fee = min_fee(size, self._min_fee_a, self._min_fee_b)
                if new_fee == fee:
                    break
                fee = new_fee
            if picked >= amount + fee:
                break
        if built is None or picked < amount + fee:
            raise ValueError("cardano: insufficient funds (incl. fee)")

        return BuiltTx(chain="cardano", raw=built["signedTxCborHex"], txid=built["txHashHex"],
                       fee=str(fee), summary=req,
                       extra={"kind": "send", "ttl": ttl, "inputs": len(selected)})

    def broadcast(self, tx) -> BroadcastResult:
        hexstr = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        raw = bytes.fromhex(str(hexstr))
        if self._blockfrost:
            base = str(self._blockfrost["url"]).rstrip("/")
            req = urllib.request.Request(base + "/tx/submit", data=raw,
                                         headers={"project_id": self._blockfrost["projectId"],
                                                  "content-type": "application/cbor"}, method="POST")
            with urllib.request.urlopen(req, timeout=30) as r:
                txid = r.read().decode().strip().strip('"')
        else:
            txid = self._post("/submittx", raw, "application/cbor").strip().strip('"')
        return BroadcastResult(txid=str(txid), accepted=bool(txid))

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + str(txid)


def create_cardano_adapter(**opts) -> CardanoAdapter:
    return CardanoAdapter(**opts)
