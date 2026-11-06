"""chains/xrp.py — the XRP Ledger (XRP) ChainAdapter.

* account key: secp256k1 at BIP44 ``m/44'/144'/0'/0/0`` — the SAME curve + HD
  lib the wallet already uses for EVM/BTC/Tron. No new crypto. SigningPubKey is
  the 33-byte COMPRESSED pubkey (0x02/0x03).
* address = classic 'r…' = ripple-base58check(0x00 || RIPEMD160(SHA256(pub))).
* native XRP (6 decimals; 1 XRP = 1e6 drops). 10-XRP base reserve (surfaced in
  the send UI).
* SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety): the Payment is serialized
  LOCALLY with the XRPL binary codec and SHA512-half-signed; the only node
  inputs are the account Sequence (account_info) and the current ledger index
  (for LastLedgerSequence) — verifiable, never define the payload. So XRP uses
  the TON-style build_send -> broadcast path (needsSign is False).
* endpoint is CONFIG (default https://xrplcluster.com; fallback
  https://s1.ripple.com:51234) via rippled JSON-RPC.

NOT post-quantum — secp256k1/ECDSA, exactly like Bitcoin/Ethereum. Ported from
the extension's chains/xrp.js.
"""
from __future__ import annotations

import json
import urllib.request

from .. import crypto as K
from ..crypto import secp256k1 as S
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, format_units)
from . import xrpl_codec as X

DROPS = 1_000_000
DEFAULT_PATH = "m/44'/144'/0'/0/0"
DEFAULT_RPC = "https://xrplcluster.com"
FALLBACK_RPC = "https://s1.ripple.com:51234"
DEFAULT_FEE_DROPS = "10"
BASE_RESERVE_XRP = 10
LEDGER_OFFSET = 20  # LastLedgerSequence = current + offset (grace window)


def _default_xrp_post(rpc):
    base = str(rpc or DEFAULT_RPC).rstrip("/")

    def post(body) -> str:
        req = urllib.request.Request(base, data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json"},
                                     method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode()

    return post


class XrpAdapter:
    def __init__(self, path=DEFAULT_PATH, explorer="https://xrpscan.com/tx/",
                 symbol="XRP", rpc=None, post=None, **_):
        self.id = "xrp"
        self.scheme = "secp256k1"
        self.drops = DROPS
        self.path = path
        self.explorer = explorer
        self.native = AssetRef(chain="xrp", kind="native", symbol=symbol, decimals=6)
        self.base_reserve_xrp = BASE_RESERVE_XRP
        self._root = None
        self._rpc = rpc or DEFAULT_RPC
        self._post = post or _default_xrp_post(self._rpc)

    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _path_with_index(self, index):
        if not index:
            return self.path
        return self.path[:-2] + str(index) if self.path.endswith("/0") else self.path

    def _node_for(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return K.derive_path(self._root, self._path_with_index(index or 0))

    def _rpc_call(self, method, params):
        body = {"method": method, "params": [params or {}]}
        raw = self._post(body)
        j = json.loads(raw) if isinstance(raw, str) else raw
        return j.get("result", j)

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        node = K.derive_path(seed, self._path_with_index(index or 0))
        return DerivedAccount(chain="xrp", index=index or 0,
                              address=X.classic_address(node.public_key),
                              publicKey=node.public_key.hex(), scheme="secp256k1",
                              path=self._path_with_index(index or 0))

    def _account_info(self, address):
        return self._rpc_call("account_info", {"account": address, "ledger_index": "validated"})

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            res = self._account_info(address)
            acct = (res or {}).get("account_data") or {}
            bal = str(int(acct.get("Balance") or 0))
            out.append(Balance(asset=self.native, confirmed=bal, display=format_units(bal, 6)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        return out

    def discover_tokens(self, address: str):
        # Issued currencies (trust lines) are optional/native-only to start.
        return []

    def _current_ledger(self):
        try:
            r = self._rpc_call("ledger_current", {})
            idx = (r or {}).get("ledger_current_index")
            if idx:
                return int(idx)
        except Exception:
            pass
        try:
            r = self._rpc_call("server_info", {})
            return int(((r or {}).get("info") or {}).get("validated_ledger", {}).get("seq") or 0)
        except Exception:
            return 0

    def build_send(self, account, req) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        to = req.get("to") if isinstance(req, dict) else getattr(req, "to", None)
        amount = req.get("amount") if isinstance(req, dict) else getattr(req, "amount", None)
        dtag = (req.get("destinationTag") if isinstance(req, dict)
                else getattr(req, "destinationTag", None))
        if not to or amount is None:
            raise ValueError("xrp: to + amount required")
        if not X.is_xrp_address(to):
            raise ValueError("xrp: invalid destination address " + str(to))
        index = getattr(account, "index", 0) or 0
        node = self._node_for(index)
        owner = getattr(account, "address", None) or X.classic_address(node.public_key)
        info = self._account_info(owner)
        seq = int(((info or {}).get("account_data") or {}).get("Sequence") or 0)
        last_ledger = self._current_ledger() + LEDGER_OFFSET
        fee = str((req.get("fee") if isinstance(req, dict) else None) or DEFAULT_FEE_DROPS)
        fields = X.build_payment_fields(owner, to, str(amount), fee, seq, last_ledger,
                                        node.public_key.hex(), destination_tag=dtag)
        built = X.build_signed_payment(fields, node.private_key)
        return BuiltTx(chain="xrp", raw=built["txBlobHex"], txid=built["hash"], fee=fee,
                       summary=req, extra={"kind": "send", "sequence": seq,
                                           "lastLedgerSequence": last_ledger})

    def broadcast(self, tx) -> BroadcastResult:
        blob = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        res = self._rpc_call("submit", {"tx_blob": blob})
        engine = (res or {}).get("engine_result")
        accepted = engine in ("tesSUCCESS", "terQUEUED")
        txid = (tx.txid if isinstance(tx, BuiltTx) else None) or \
            ((res or {}).get("tx_json") or {}).get("hash") or ""
        return BroadcastResult(txid=str(txid), accepted=accepted)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + str(txid)


def create_xrp_adapter(**opts) -> XrpAdapter:
    return XrpAdapter(**opts)
