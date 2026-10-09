"""The central contract of the multi-chain layer.

Every supported chain implements the SAME interface; the UI, the exchange
layer and the AI agent talk to adapters only, never to a chain's RPC directly.
Python mirror of ``blockle-app/lib/multichain/chains/chain_adapter.dart`` and
the extension's ``chains/*.js``.

All amounts are BASE-UNIT DECIMAL STRINGS (int-safe); convert to human units
only at the display edge via :func:`format_units`.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class RootSecret:
    """The unlocked root secret handed to secp256k1 / ed25519 adapters.

    For BLOCK the "root secret" is the ML-DSA keypair held in the engine
    session, not this. ``seed`` is the BIP39/HD seed bytes — never logged/sent.
    """

    seed: Optional[bytes] = None


def as_seed(root) -> Optional[bytes]:
    """Accept a RootSecret, a {'seed':...} mapping, or raw seed bytes."""
    if root is None:
        return None
    if isinstance(root, RootSecret):
        return root.seed
    if isinstance(root, dict):
        return root.get("seed")
    if isinstance(root, (bytes, bytearray, memoryview)):
        return bytes(root)
    seed = getattr(root, "seed", None)
    return seed if seed is not None else root


@dataclass
class AssetRef:
    chain: str
    kind: str  # "native" | "erc20" | "block20" | "spl"
    symbol: str
    decimals: int
    address: Optional[str] = None

    def to_json(self) -> dict:
        d = {"chain": self.chain, "kind": self.kind, "symbol": self.symbol, "decimals": self.decimals}
        if self.address is not None:
            d["address"] = self.address
        return d


@dataclass
class DerivedAccount:
    chain: str
    index: int
    address: str
    publicKey: str
    scheme: str  # "ml-dsa-44" | "secp256k1" | "ed25519"
    path: Optional[str] = None

    def to_json(self) -> dict:
        d = {"chain": self.chain, "index": self.index, "address": self.address,
             "publicKey": self.publicKey, "scheme": self.scheme}
        if self.path is not None:
            d["path"] = self.path
        return d


@dataclass
class Balance:
    asset: AssetRef
    confirmed: str  # base units, decimal string
    display: str
    spendable: Optional[str] = None
    error: Optional[str] = None


@dataclass
class BuiltTx:
    chain: str
    raw: str
    txid: str
    fee: str
    summary: Any
    extra: Optional[dict] = None


@dataclass
class BroadcastResult:
    txid: str
    accepted: bool


class ChainAdapter:
    """The five-method interface every chain implements (plus unlock/lock)."""

    id: str
    native: AssetRef

    def unlock(self, root) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    def lock(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    def derive_account(self, root, index: int = 0) -> DerivedAccount:  # pragma: no cover
        raise NotImplementedError

    def get_balance(self, address: str, tokens=None):  # pragma: no cover
        raise NotImplementedError

    def build_send(self, account: DerivedAccount, req) -> BuiltTx:  # pragma: no cover
        raise NotImplementedError

    def broadcast(self, tx: BuiltTx) -> BroadcastResult:  # pragma: no cover
        raise NotImplementedError

    def explorer_tx(self, txid: str) -> str:  # pragma: no cover
        raise NotImplementedError


def format_units(base_str, decimals: int) -> str:
    s = str(int(base_str)).rjust(decimals + 1, "0")
    i = s[: len(s) - decimals]
    f = s[len(s) - decimals:].rstrip("0")
    return f"{i}.{f}" if f else i


# ---- default HTTP transports (injectable; tests pass stubs, no network) ----
JsonRpcFn = Callable[[str, list], Any]
HttpGetFn = Callable[[str], str]
HttpPostFn = Callable[[str, str], str]


def default_json_rpc(url: str, timeout: float = 30) -> JsonRpcFn:
    def rpc(method: str, params: list):
        if not url:
            raise RuntimeError("no RPC endpoint configured")
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode())
        if j.get("error"):
            raise RuntimeError(j["error"].get("message", "rpc error"))
        return j.get("result")

    return rpc


def default_http(base: str, timeout: float = 30):
    def get(path: str) -> str:
        if not base:
            raise RuntimeError("no endpoint configured")
        with urllib.request.urlopen(base + path, timeout=timeout) as r:
            return r.read().decode()

    def post(path: str, body: str) -> str:
        if not base:
            raise RuntimeError("no endpoint configured")
        req = urllib.request.Request(base + path, data=body.encode(),
                                     headers={"content-type": "text/plain"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode()

    return get, post
