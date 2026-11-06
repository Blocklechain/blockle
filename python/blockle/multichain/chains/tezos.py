"""chains/tezos.py — the Tezos (XTZ) ChainAdapter.

* account key: ed25519 via SLIP-0010 at ``m/44'/1729'/0'/0'`` (coin type 1729,
  FOUR hardened segments — Solana-style, unlike Stellar/TON's three). Reuses the
  SHARED ``K.slip10.derive``. No new crypto. Pinned by docs/tezos-vectors.json.
* address = tz1 = base58check([6,161,159] || blake2b(pub,20)); public-key export
  edpk = base58check([13,15,37,217] || pub). (chains/tezos_forge.py is the forge
  / zarith / pkh / base58check engine.)
* native XTZ (6 decimals; 1 XTZ = 1e6 mutez).
* SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety): the whole 'transaction'
  manager operation is forged LOCALLY to bytes and ed25519-signed over
  blake2b(0x03 || forged, 32). The ONLY node inputs are branch (head block hash)
  + counter (per-account) — both verifiable, never define the signed payload.
* endpoint is CONFIG (default https://mainnet.api.tez.ie; alt https://rpc.tzkt.io/mainnet).

NOT post-quantum — ed25519 is classical EC crypto. Ported from the extension's
chains/tezos.js.
"""
from __future__ import annotations

import urllib.parse
import urllib.request

from .. import crypto as K
from ..crypto import slip10
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, format_units)
from . import tezos_forge as TZ

ED = K.ed25519

MUTEZ = 1_000_000
DEFAULT_PATH = "m/44'/1729'/0'/0'"
DEFAULT_RPC = "https://mainnet.api.tez.ie"  # alt: https://rpc.tzkt.io/mainnet
DEFAULT_FEE = "1420"
DEFAULT_GAS_LIMIT = "1040"
DEFAULT_STORAGE_LIMIT = "257"


def _default_rpc_http(rpc):
    base = str(rpc or DEFAULT_RPC).rstrip("/")

    def http_get(path) -> str:
        with urllib.request.urlopen(base + path, timeout=30) as resp:
            return resp.read().decode()

    def http_post(path, body, content_type="application/json") -> str:
        req = urllib.request.Request(base + path, data=body.encode(),
                                     headers={"content-type": content_type}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode()

    return http_get, http_post


def build_signed_transaction(fields: dict, seed_key) -> dict:
    """Forge + ed25519-sign a single 'transaction' manager op LOCALLY. Shared by
    build_send + the golden-vector test; deterministic + offline (no network)."""
    forged_hex = TZ.forge_transaction(fields)
    signing_hash = TZ.signing_bytes(forged_hex)
    signature = ED.sign(signing_hash, seed_key)
    return {
        "forgedHex": forged_hex,
        "signingHashHex": signing_hash.hex(),
        "signature": signature,
        "signatureHex": signature.hex(),
        "edsig": TZ.edsig(signature),
        "injectionHex": TZ.injection_hex(forged_hex, signature),
    }


class TezosAdapter:
    def __init__(self, path=DEFAULT_PATH, explorer="https://tzkt.io/", symbol="XTZ",
                 rpc=None, http_get=None, http_post=None, **_):
        self.id = "tezos"
        self.scheme = "ed25519"
        self.mutez = MUTEZ
        self.path = path
        self.explorer = explorer
        self.native = AssetRef(chain="tezos", kind="native", symbol=symbol, decimals=6)
        self._root = None
        self._rpc = rpc or DEFAULT_RPC
        g, p = _default_rpc_http(self._rpc)
        self._get = http_get or g
        self._post = http_post or p

    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _path_with_index(self, index):
        if not index:
            return self.path
        return self.path[:-2] + f"{index}'" if self.path.endswith("/0'") else self.path

    def _key_for(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return slip10.derive(self._root, self._path_with_index(index or 0)).key

    def _strip(self, raw) -> str:
        return str(raw).strip().strip('"')

    def _branch_head(self) -> str:
        return self._strip(self._get("/chains/main/blocks/head/hash"))

    def _counter_of(self, address) -> int:
        raw = self._get("/chains/main/blocks/head/context/contracts/"
                        + urllib.parse.quote(address) + "/counter")
        return int(self._strip(raw))

    def _balance_of(self, address) -> str:
        raw = self._get("/chains/main/blocks/head/context/contracts/"
                        + urllib.parse.quote(address) + "/balance")
        return self._strip(raw)

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        key = slip10.derive(seed, self._path_with_index(index or 0)).key
        pub = ED.public_key(key)
        return DerivedAccount(chain="tezos", index=index or 0, address=TZ.tz1(pub),
                              publicKey=pub.hex(), scheme="ed25519",
                              path=self._path_with_index(index or 0))

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            bal = str(int(self._balance_of(address)))
            out.append(Balance(asset=self.native, confirmed=bal, display=format_units(bal, 6)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        return out

    def discover_tokens(self, address: str):
        # FA1.2/FA2 token discovery needs an indexer; native-only to start.
        return []

    def build_send(self, account, req) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        to = req.get("to") if isinstance(req, dict) else getattr(req, "to", None)
        amount = req.get("amount") if isinstance(req, dict) else getattr(req, "amount", None)
        if not to or amount is None:
            raise ValueError("tezos: to + amount required")
        if not TZ.is_tezos_destination(to):
            raise ValueError("tezos: invalid destination address " + str(to))
        index = getattr(account, "index", 0) or 0
        key = self._key_for(index)
        pub = ED.public_key(key)
        owner = getattr(account, "address", None) or TZ.tz1(pub)
        branch = self._branch_head()
        counter = self._counter_of(owner) + 1
        rq = req if isinstance(req, dict) else {}
        fields = {
            "branch": branch, "source": owner,
            "fee": str(rq.get("fee", DEFAULT_FEE)),
            "counter": str(counter),
            "gas_limit": str(rq.get("gasLimit", DEFAULT_GAS_LIMIT)),
            "storage_limit": str(rq.get("storageLimit", DEFAULT_STORAGE_LIMIT)),
            "amount": str(amount),
            "destination": to,
        }
        built = build_signed_transaction(fields, key)
        return BuiltTx(chain="tezos", raw=built["injectionHex"], txid="",
                       fee=fields["fee"], summary=req,
                       extra={"kind": "send", "counter": fields["counter"], "edsig": built["edsig"]})

    def broadcast(self, tx) -> BroadcastResult:
        import json as _json
        hex_op = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        raw = self._post("/injection/operation", _json.dumps(str(hex_op)))
        txid = self._strip(raw)
        return BroadcastResult(txid=str(txid), accepted=bool(txid))

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + str(txid)


def create_tezos_adapter(**opts) -> TezosAdapter:
    return TezosAdapter(**opts)
