"""The BLOCK ChainAdapter — a THIN wrapper over the existing, consensus-correct
BLOCK stack (:class:`blockle.chainwallet.ChainWallet`, which shells out to the
Rust ``blockle-chain`` binary). It does NOT reimplement any BLOCK crypto —
ML-DSA-44 signing stays entirely in Rust / blockle-wasm.

Python mirror of ``blockle-extension/chains/block.js``. BLOCK is the wallet's
native identity and is ALWAYS enabled; this adapter exists so the UI / exchange
/ agent can talk to every chain through one uniform ChainAdapter interface.

Post-quantum: YES — BLOCK alone is signed with ML-DSA-44 (FIPS 204).

Because the ``blockle-chain`` CLI builds-and-submits a transfer in one step, the
adapter keeps the build/broadcast split of the interface by deferring the actual
network submit to :meth:`broadcast` (the agent-confirmation gate still inspects
the summarised, fully-priced transfer before anything is sent).
"""

from __future__ import annotations

import json
import urllib.request

from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, format_units)

COIN = 100_000_000

#: Public BLOCK-20 token API defaults (config-overridable). ``tokenListUrl``
#: lists the known BLOCK-20 contracts; ``tokenApi/<id>?holder=<addr>`` returns a
#: token's metadata + that holder's balance (proxies the node ``tokeninfo`` view
#: call). Both are read-only, no secret involved.
DEFAULT_TOKEN_LIST_URL = "https://blockle.org/api/dex/tokens"
DEFAULT_TOKEN_API = "https://blockle.org/api/token"


def _default_http_get(timeout: float = 15):
    def get(url: str) -> str:
        req = urllib.request.Request(url, headers={"accept": "application/json",
                                                   "user-agent": "blockle-multichain"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode()
    return get


class BlockAdapter:
    def __init__(self, wallet=None, explorer="https://blockle.org/tx/",
                 tokenListUrl=DEFAULT_TOKEN_LIST_URL, tokenApi=DEFAULT_TOKEN_API,
                 http_get=None, discover=True, **_):
        self.id = "block"
        self.native = AssetRef(chain="block", kind="native", symbol="BLOCK", decimals=8)
        self.postQuantum = True
        self.scheme = "ml-dsa-44"
        self.explorer = explorer
        self._wallet = wallet  # a blockle.chainwallet.ChainWallet (or compatible)
        self._token_list_url = tokenListUrl
        self._token_api = tokenApi
        self._http_get = http_get or _default_http_get()
        self._discover_enabled = discover

    # No-ops for interface symmetry: the BLOCK key lives in the wallet session.
    def unlock(self, root=None):
        pass

    def lock(self):
        pass

    def _snapshot(self):
        return self._wallet.snapshot()

    def derive_account(self, root=None, index: int = 0) -> DerivedAccount:
        snap = self._snapshot()
        w = snap.get("wallet", snap)
        address = w.get("address")
        pub = w.get("publicKey") or w.get("public_key") or ""
        return DerivedAccount(chain="block", index=0, address=address, publicKey=pub,
                              scheme="ml-dsa-44")

    def get_balance(self, address=None, tokens=None):
        try:
            snap = self._snapshot()
            w = snap.get("wallet", snap)
            confirmed = str(w.get("balance", "0"))
            display = w.get("balanceFmt") or w.get("balance_fmt") or "—"
            return [Balance(asset=self.native, confirmed=confirmed, spendable=confirmed, display=display)]
        except Exception as e:
            return [Balance(asset=self.native, confirmed="0", display="—", error=str(e))]

    def discover_tokens(self, address=None, limit=None):
        """Holder scan: list the known BLOCK-20 contracts, then read this
        address's balance of each (the node ``tokeninfo`` view via the public
        token API), keeping the non-zero holdings. Returns ``[]`` when disabled
        or no list endpoint is configured."""
        if not self._discover_enabled or not self._token_list_url:
            return []
        addr = address
        if not addr:
            try:
                addr = self.derive_account().address
            except Exception:
                return []
        if not addr:
            return []
        try:
            listing = json.loads(self._http_get(self._token_list_url))
        except Exception:
            return []
        if isinstance(listing, dict) and "result" in listing:
            listing = listing["result"]
        if isinstance(listing, dict):
            contracts = list(listing.keys())
            meta_by_id = listing
        elif isinstance(listing, list):
            contracts = [c if isinstance(c, str) else c.get("contract") for c in listing]
            meta_by_id = {}
        else:
            return []
        if limit:
            contracts = contracts[:limit]
        out = []
        for contract in contracts:
            if not contract:
                continue
            try:
                info = json.loads(self._http_get(
                    f"{self._token_api}/{contract}?holder={addr}"))
            except Exception:
                continue
            if isinstance(info, dict) and "result" in info:
                info = info["result"]
            if not isinstance(info, dict):
                continue
            bal = info.get("balance")
            try:
                amount = int(bal) if bal is not None else 0
            except (TypeError, ValueError):
                amount = 0
            if amount <= 0:
                continue
            try:
                decimals = int(info.get("decimals") or 0)
            except (TypeError, ValueError):
                decimals = 0
            logo = (meta_by_id.get(contract) or {}).get("logo") if isinstance(meta_by_id.get(contract), dict) else None
            asset = AssetRef(chain="block", kind="block20",
                             symbol=(info.get("symbol") or "?"), decimals=decimals,
                             address=contract, name=(info.get("name") or None),
                             logo=(logo or None))
            v = str(amount)
            out.append(Balance(asset=asset, confirmed=v, display=format_units(v, decimals)))
        return out

    def build_send(self, account, req) -> BuiltTx:
        to = req["to"] if isinstance(req, dict) else req.to
        amount = req["amount"] if isinstance(req, dict) else req.amount
        fee_rate = (req.get("feeRate") if isinstance(req, dict) else getattr(req, "feeRate", None))
        fee = str(fee_rate if fee_rate is not None else 100000)
        # The raw carries the pending params; the ML-DSA signing + submit happen
        # inside the Rust CLI on broadcast — this adapter never touches the key.
        return BuiltTx(chain="block", raw="", txid="", fee=fee, summary=req,
                       extra={"to": to, "amount": str(amount), "fee": fee})

    def broadcast(self, tx: BuiltTx) -> BroadcastResult:
        p = tx.extra or {}
        to = p["to"]
        amount = _to_decimal(p["amount"])
        fee = _to_decimal(p.get("fee", "100000"))
        res = self._wallet.send(to, amount, fee)
        txid = str(res.get("txid") or res.get("result") or res) if isinstance(res, dict) else str(res)
        return BroadcastResult(txid=txid, accepted=True)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + txid


def _to_decimal(base_units) -> str:
    """Convert base-unit BLOCK (int) to the decimal string the CLI expects."""
    v = int(base_units)
    whole, frac = divmod(abs(v), COIN)
    sign = "-" if v < 0 else ""
    if frac == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{str(frac).zfill(8).rstrip('0')}"


def create_block_adapter(**opts) -> BlockAdapter:
    return BlockAdapter(**opts)
