"""multichain/activity.py — WALLET ACTIVITY: one time-sorted cross-chain history
feed (docs/WALLET-PORTFOLIO.md §2).

Faithful Python port of ``blockle-extension/activity.js`` (the JS reference),
asserted against the AUTHORITATIVE shared fixture ``docs/portfolio-vectors.json``.

READ-ONLY. ``activity(accounts, ctx, {cursor?, limit?})`` pulls per-chain history
from the indexers injected via ctx (EVM getAssetTransfers/logs, Solana
signatures-for-address, UTXO esplora address txs, BLOCK node history), merges
them into ONE feed sorted newest-first, and pages it with a STABLE cursor.

An indexer that is unavailable contributes NOTHING plus an audited note — never
a fabricated empty "no activity" (which would read as a safety/emptiness claim).

It DECODES each item's ``kind`` by REUSING the wallet security suite's decoder
(``security.inspect_transaction``) so the label matches the pre-sign preview
EXACTLY, and marks any item whose counterparty the security suite would flag (so
past interactions with a flagged address stay visible in history too).

PURE given the injected indexers + security ctx; no network here, no clock.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from . import security as Security
from ._util import maybe_await, member
from .chains import evm as EVM

EVM_CHAINS = {"ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche"}
UTXO_CHAINS = {"bitcoin", "litecoin", "dogecoin"}

# security-decoder kind -> Activity kind (docs §2). Never fabricates a meaning
# the decoder didn't produce: an unknown selector decodes to contract.
KIND_MAP = {
    "native-transfer": "transfer",
    "block-send": "transfer",
    "utxo-send": "transfer",
    "token-transfer": "token-transfer",
    "token-approval": "approval",
    "contract-call": "contract",
    "unknown": "contract",
}
# warning codes that flag the COUNTERPARTY (not merely the shape of the tx).
COUNTERPARTY_FLAGS = {"send-to-flagged", "known-drainer", "approval-to-eoa", "setApprovalForAll-true"}

_ADDR_HEX_RE = re.compile(r"^0x[0-9a-fA-F]*$")


def norm(a: Any) -> Any:
    if a is None:
        return a
    s = str(a)
    return s.lower() if _ADDR_HEX_RE.match(s) else s


def eq(a: Any, b: Any) -> bool:
    return a is not None and b is not None and norm(a) == norm(b)


# Build the tx shape the security decoder understands from a raw indexer row,
# RECONSTRUCTING the same calldata the pre-sign path would see (so the decoded
# kind/label is identical). Never invents fields the row didn't carry.
def build_tx(chain: str, row: Dict[str, Any]) -> Dict[str, Any]:
    asset = member(row, "asset")
    value = member(row, "value")
    if value is None:
        value = member(row, "amount")
    if chain in EVM_CHAINS:
        data = member(row, "data")
        if data and data != "0x":
            return {"chain": chain, "to": member(row, "to"), "data": data,
                    "value": member(row, "value"), "asset": asset}
        if asset and member(asset, "kind") == "erc20" and member(asset, "address"):
            return {"chain": chain, "to": member(asset, "address"),
                    "data": EVM.erc20_transfer_data(member(row, "to"), value or 0), "asset": asset}
        return {"chain": chain, "to": member(row, "to"), "value": value or 0, "asset": asset}
    if chain == "block":
        return {"chain": chain, "to": member(row, "to"), "amount": value or 0, "asset": asset}
    if chain == "solana":
        if isinstance(member(row, "instructions"), list):
            return {"chain": chain, "instructions": member(row, "instructions"), "asset": asset}
        return {"chain": chain, "instructions": [
            {"program": "system", "type": "transfer",
             "info": {"destination": member(row, "to"), "lamports": str(value or 0)}}], "asset": asset}
    if chain in UTXO_CHAINS:
        if isinstance(member(row, "outputs"), list):
            return {"chain": chain, "inputs": member(row, "inputs"), "outputs": member(row, "outputs"),
                    "ownAddresses": member(row, "ownAddresses"),
                    "changeAddress": member(row, "changeAddress"), "asset": asset}
        return {"chain": chain, "outputs": [{"address": member(row, "to"), "value": str(value or 0)}],
                "ownAddresses": member(row, "ownAddresses"), "asset": asset}
    return {"chain": chain, "to": member(row, "to"), "value": value or 0, "asset": asset}


# Resolve direction relative to the owning account address.
def direction_of(chain: str, row: Dict[str, Any], address: Any, activity_kind: str) -> str:
    if activity_kind == "approval":
        return "out"
    if activity_kind == "contract":
        return "contract"
    frm, to = member(row, "from"), member(row, "to")
    is_from = address is not None and eq(frm, address)
    is_to = address is not None and eq(to, address)
    if is_from and is_to:
        return "self"
    if is_from:
        return "out"
    if is_to:
        return "in"
    if member(row, "direction"):
        return member(row, "direction")
    return "out"


# The security ctx for decode: the same config the pre-sign uses (denylist /
# knownSpenders / thresholds), carried on ctx['securityConfig']. No network reads
# here, so getCode-dependent checks simply don't run (decode + denylist still do).
def sec_ctx(ctx: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {"config": member(ctx, "securityConfig") or {}}


async def inspect(ctx: Optional[Dict[str, Any]], tx: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    # allow a caller-provided inspector (wiring.inspect); else the suite directly.
    inspector = member(ctx, "inspect")
    if callable(inspector):
        try:
            return await maybe_await(inspector(tx["chain"], tx))
        except Exception:  # noqa: BLE001
            pass  # fall through
    try:
        return await Security.inspect_transaction(tx, sec_ctx(ctx))
    except Exception:  # noqa: BLE001
        return None


# Pull one chain's raw history via the injected indexer. Distinguishes
# UNAVAILABLE (None / throw -> audited note) from a real empty list ([]).
async def pull_history(ctx: Optional[Dict[str, Any]], chain: str, address: Any) -> Dict[str, Any]:
    history_fn = member(ctx, "history")
    indexers = member(ctx, "indexers")
    fn = history_fn or (indexers.get(chain) if isinstance(indexers, dict) else None)
    if not callable(fn):
        return {"rows": [], "note": {"chain": chain,
                "note": "history unavailable: no indexer configured for " + chain
                        + " — not a claim of no activity."}}
    try:
        rows = await maybe_await(history_fn(chain, address)) if callable(history_fn) \
            else await maybe_await(fn(address))
    except Exception as e:  # noqa: BLE001
        return {"rows": [], "note": {"chain": chain,
                "note": "history unavailable: indexer error (" + str(e) + ") for " + chain
                        + " — not a claim of no activity."}}
    if rows is None:
        return {"rows": [], "note": {"chain": chain,
                "note": "history unavailable: indexer returned no result for " + chain
                        + " — not a claim of no activity."}}
    return {"rows": rows if isinstance(rows, list) else [], "note": None}


# Stable total order: ts DESC, then chain ASC, then txid ASC.
def cmp(a: Dict[str, Any], b: Dict[str, Any]) -> int:
    if a["ts"] != b["ts"]:
        return -1 if a["ts"] > b["ts"] else 1
    if a["chain"] != b["chain"]:
        return -1 if a["chain"] < b["chain"] else 1
    at, bt = str(a["txid"]), str(b["txid"])
    return -1 if at < bt else (1 if at > bt else 0)


def cursor_key(it: Dict[str, Any]) -> str:
    return str(it["ts"]) + ":" + it["chain"] + ":" + it["txid"]


def parse_cursor(c: Any) -> Optional[Dict[str, Any]]:
    if not c:
        return None
    s = str(c)
    i = s.find(":")
    j = s.find(":", i + 1)
    if i < 0 or j < 0:
        return None
    return {"ts": float(s[:i]), "chain": s[i + 1:j], "txid": s[j + 1:]}


def _cmp_to_key(fn):
    class _K:
        __slots__ = ("obj",)

        def __init__(self, obj):
            self.obj = obj

        def __lt__(self, other):
            return fn(self.obj, other.obj) < 0

    return _K


# ===========================================================================
# activity(accounts, ctx, opts) -> { items, nextCursor?, notes }
# ===========================================================================
async def activity(accounts: Optional[List[Any]] = None,
                   ctx: Optional[Dict[str, Any]] = None,
                   opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ctx = ctx or {}
    opts = opts or {}
    accounts = accounts if isinstance(accounts, list) else []
    limit = max(1, int(opts["limit"])) if member(opts, "limit") is not None else 25

    items: List[Dict[str, Any]] = []
    notes: List[Dict[str, Any]] = []
    for acc in accounts:
        chain = member(acc, "chain")
        address = member(acc, "address")
        if not chain:
            continue
        pulled = await pull_history(ctx, chain, address)
        rows, note = pulled["rows"], pulled["note"]
        if note:
            notes.append(note)
        for row in rows:
            tx = build_tx(chain, row)
            insp = await inspect(ctx, tx)
            dec_kind = insp["kind"] if insp and member(insp, "kind") else "unknown"
            kind = KIND_MAP.get(dec_kind, "contract")
            warnings = (member(insp, "warnings") or []) if insp else []
            flagged = any(w.get("code") in COUNTERPARTY_FLAGS for w in warnings)
            direction = direction_of(chain, row, address, kind)
            amount_base = member(row, "value")
            if amount_base is None:
                amount_base = member(row, "amount")
            it: Dict[str, Any] = {
                "chain": chain, "txid": str(member(row, "txid")),
                "ts": float(member(row, "ts")) if _is_num(member(row, "ts")) else member(row, "ts"),
                "direction": direction, "kind": kind,
                "status": member(row, "status") or "confirmed",
                "account": address,
                "summary": member(insp, "summary") if insp else None,
                "flagged": flagged,
                "warnings": [w.get("code") for w in warnings],
                "severity": member(insp, "severity") if insp else "none",
            }
            # ts int normalization to match JS Number() on integer strings/numbers
            if isinstance(it["ts"], float) and it["ts"].is_integer():
                it["ts"] = int(it["ts"])
            if member(row, "asset"):
                it["asset"] = member(row, "asset")
            if amount_base is not None:
                it["amountBase"] = str(amount_base)
            if member(row, "counterparty") is not None or member(row, "from") is not None \
                    or member(row, "to") is not None:
                cp = member(row, "counterparty")
                if cp is None:
                    cp = member(row, "to") if eq(member(row, "from"), address) else member(row, "from")
                it["counterparty"] = cp
            if member(row, "fee") is not None:
                it["feeBase"] = str(member(row, "fee"))
            if member(row, "memo") is not None:
                it["memo"] = member(row, "memo")
            explorer_tx = member(ctx, "explorerTx")
            if callable(explorer_tx):
                try:
                    u = await maybe_await(explorer_tx(chain, member(row, "txid")))
                    if u:
                        it["explorerUrl"] = u
                except Exception:  # noqa: BLE001
                    pass
            items.append(it)

    items.sort(key=_cmp_to_key(cmp))

    # stable paging: keep only items strictly AFTER the cursor in sort order.
    cur = parse_cursor(member(opts, "cursor"))
    page = items
    if cur:
        page = [it for it in items if cmp(cur, it) < 0]
    page_slice = page[:limit]
    out: Dict[str, Any] = {"items": page_slice, "notes": notes}
    if len(page) > len(page_slice) and len(page_slice) > 0:
        out["nextCursor"] = cursor_key(page_slice[-1])
    return out


def _is_num(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False
