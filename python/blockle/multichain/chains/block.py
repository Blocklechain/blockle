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

from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount)

COIN = 100_000_000


class BlockAdapter:
    def __init__(self, wallet=None, explorer="https://blockle.org/tx/", **_):
        self.id = "block"
        self.native = AssetRef(chain="block", kind="native", symbol="BLOCK", decimals=8)
        self.postQuantum = True
        self.scheme = "ml-dsa-44"
        self.explorer = explorer
        self._wallet = wallet  # a blockle.chainwallet.ChainWallet (or compatible)

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
