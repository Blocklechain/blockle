"""chains/stellar.py — the Stellar (XLM) ChainAdapter.

* account key: ed25519 via SLIP-0010 at ``m/44'/148'/0'`` (coin type 148, three
  hardened segments). Reuses the SHARED ``K.slip10.derive``. No new crypto.
* address = strkey 'G…' = base32(0x30 || 32-byte ed25519 pub || crc16-xmodem-LE),
  no padding.
* native XLM (7 decimals; 1 XLM = 1e7 stroops). 1-XLM base reserve per entry
  (surfaced in the send UI).
* SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety): the v1 TransactionEnvelope
  with a single Payment op is serialized LOCALLY with Stellar XDR and ed25519-
  signed over SHA256(networkId || ENVELOPE_TYPE_TX || txXDR); the only node input
  is the account sequence (Horizon GET /accounts) — verifiable, never defines the
  payload. So Stellar uses the TON-style build_send -> broadcast path.
* endpoint is CONFIG (default https://horizon.stellar.org) via Horizon REST.

NOT post-quantum — ed25519 is classical EC crypto. Ported from the extension's
chains/stellar.js.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .. import crypto as K
from ..crypto import ed25519 as ED, slip10
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, format_units)
from . import stellar_xdr as SX

STROOP = 10_000_000
DEFAULT_PATH = "m/44'/148'/0'"
DEFAULT_HORIZON = "https://horizon.stellar.org"
BASE_RESERVE_XLM = 1


def _default_horizon_http(horizon):
    base = str(horizon or DEFAULT_HORIZON).rstrip("/")

    def http_get(path) -> str:
        with urllib.request.urlopen(base + path, timeout=30) as resp:
            return resp.read().decode()

    def http_post(path, body, content_type="application/x-www-form-urlencoded") -> str:
        req = urllib.request.Request(base + path, data=body.encode(),
                                     headers={"content-type": content_type}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode()
        except urllib.error.HTTPError as e:  # Horizon returns 400 w/ a JSON body
            return e.read().decode()

    return http_get, http_post


class StellarAdapter:
    def __init__(self, path=DEFAULT_PATH, explorer="https://stellar.expert/explorer/public/tx/",
                 symbol="XLM", horizon=None, http_get=None, http_post=None,
                 passphrase=SX.PUBLIC_NETWORK_PASSPHRASE, **_):
        self.id = "stellar"
        self.scheme = "ed25519"
        self.stroop = STROOP
        self.path = path
        self.explorer = explorer
        self.passphrase = passphrase
        self.native = AssetRef(chain="stellar", kind="native", symbol=symbol, decimals=7)
        self.base_reserve_xlm = BASE_RESERVE_XLM
        self._root = None
        self._horizon = horizon or DEFAULT_HORIZON
        g, p = _default_horizon_http(self._horizon)
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

    def _account(self, address):
        raw = self._get("/accounts/" + urllib.parse.quote(address))
        return json.loads(raw) if isinstance(raw, str) else raw

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        key = slip10.derive(seed, self._path_with_index(index or 0)).key
        pub = ED.public_key(key)
        return DerivedAccount(chain="stellar", index=index or 0,
                              address=SX.encode_ed25519_public_key(pub),
                              publicKey=pub.hex(), scheme="ed25519",
                              path=self._path_with_index(index or 0))

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            acct = self._account(address)
            native = "0"
            for b in (acct.get("balances") or []):
                if b.get("asset_type") == "native":
                    # Horizon reports a decimal string (7 dp) — convert to stroops.
                    native = str(int(round(float(b.get("balance", "0")) * STROOP)))
                    break
            out.append(Balance(asset=self.native, confirmed=native, display=format_units(native, 7)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        return out

    def discover_tokens(self, address: str):
        # Issued assets (trustlines) optional/native-only to start.
        return []

    def _sequence_of(self, address):
        acct = self._account(address)
        return int(acct.get("sequence"))

    def build_send(self, account, req) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        to = req.get("to") if isinstance(req, dict) else getattr(req, "to", None)
        amount = req.get("amount") if isinstance(req, dict) else getattr(req, "amount", None)
        asset = req.get("asset") if isinstance(req, dict) else getattr(req, "asset", None)
        if not to or amount is None:
            raise ValueError("stellar: to + amount required")
        if not SX.is_stellar_address(to):
            raise ValueError("stellar: invalid destination address " + str(to))
        index = getattr(account, "index", 0) or 0
        key = self._key_for(index)
        pub = ED.public_key(key)
        owner = getattr(account, "address", None) or SX.encode_ed25519_public_key(pub)
        seq = self._sequence_of(owner) + 1
        dest = SX.decode_ed25519_public_key(to)
        asset_xdr = None
        is_issued = asset is not None and getattr(asset, "kind", None) in ("stellar-asset", "credit_alphanum4")
        if is_issued:
            issuer = SX.decode_ed25519_public_key(getattr(asset, "address", None) or asset["issuer"])
            asset_xdr = SX.asset_alphanum4(asset.symbol, issuer)
        ops = [SX.payment_op(dest, int(amount), asset_xdr)]
        built = SX.build_signed_envelope(pub, key, seq, ops, fee=SX.BASE_FEE * len(ops),
                                         passphrase=self.passphrase)
        return BuiltTx(chain="stellar", raw=built["envelopeXDRBase64"], txid=built["hash"],
                       fee=str(SX.BASE_FEE * len(ops)), summary=req,
                       extra={"kind": "send", "sequence": seq})

    def broadcast(self, tx) -> BroadcastResult:
        env = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        body = "tx=" + urllib.parse.quote(env, safe="")
        raw = self._post("/transactions", body)
        res = json.loads(raw) if isinstance(raw, str) else raw
        txid = (res or {}).get("hash") or (tx.txid if isinstance(tx, BuiltTx) else "") or ""
        accepted = bool((res or {}).get("successful")) or bool((res or {}).get("hash"))
        return BroadcastResult(txid=str(txid), accepted=accepted)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + str(txid)


def create_stellar_adapter(**opts) -> StellarAdapter:
    return StellarAdapter(**opts)
