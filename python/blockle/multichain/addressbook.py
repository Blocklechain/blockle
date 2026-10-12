"""multichain/addressbook.py — WALLET ADDRESS BOOK + NAME RESOLUTION
(docs/WALLET-PORTFOLIO.md §3).

Faithful Python port of ``blockle-extension/addressbook.js`` (the JS reference),
asserted against the AUTHORITATIVE shared fixture ``docs/portfolio-vectors.json``.

READ-ONLY with respect to the chain; the only writes are to the LOCAL labeled-
contacts store (encrypted-at-rest alongside settings — persistence is delegated
to the injected Store, the same encrypted settings backend). No key material, no
money path.

Two parts:
  1. A local labeled-contacts store: add / edit / remove / list
     { label, address, chain?, note? }.
  2. resolve_name(input, chain, ctx) -> { address, source:'ens'|'sns'|'book'|'raw' } | None
     ENS (.eth) via the injected resolver, SNS (.sol) via the injected resolver,
     the local book by label, else a verbatim raw address — or None. It NEVER
     returns a guessed address: a name that doesn't resolve returns None, and a
     raw string that isn't a plausible address for the chain returns None.
  + reverse_name(address, chain, ctx): book label > forward-verified ENS/SNS
     reverse > None (the caller then shows truncated hex).

The send flow resolves a typed name, SHOWS the resolved address for user
confirmation (anti-spoofing), and STILL runs the §-security pre-sign inspection
on the resolved address — this module only resolves; it never signs or sends.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ._util import maybe_await, member

STORE_KEY = "addressBook"

_EVM_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_SOL_ADDR_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
_BLOCK_ADDR_RE = re.compile(r"^block1[0-9a-z]{20,}$", re.IGNORECASE)
_BECH32_UTXO_RE = re.compile(r"^(bc1|ltc1)[0-9a-z]{20,}$", re.IGNORECASE)
_BASE58_UTXO_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{25,40}$")
_HEX_RE = re.compile(r"^0x[0-9a-fA-F]+$")

EVM_CHAINS = {"ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche"}


# ---- address shape checks (plausibility only; never a guess) ---------------
def is_evm_address(s: Any) -> bool:
    return bool(_EVM_ADDR_RE.match(str(s or "")))


def is_sol_address(s: Any) -> bool:
    return bool(_SOL_ADDR_RE.match(str(s or "")))


def is_block_address(s: Any) -> bool:
    return bool(_BLOCK_ADDR_RE.match(str(s or "")))


def is_bech32_utxo(s: Any) -> bool:
    return bool(_BECH32_UTXO_RE.match(str(s or "")))


def is_base58_utxo(s: Any) -> bool:
    return bool(_BASE58_UTXO_RE.match(str(s or "")))


def is_address_like(input_: Any, chain: Any) -> bool:
    s = str(input_ or "")
    if not s:
        return False
    if chain in EVM_CHAINS:
        return is_evm_address(s)
    if chain == "solana":
        return is_sol_address(s)
    if chain == "block":
        return is_block_address(s)
    if chain in ("bitcoin", "litecoin"):
        return is_bech32_utxo(s) or is_base58_utxo(s)
    if chain == "dogecoin":
        return is_base58_utxo(s)
    # unknown chain: accept the broadest set of plausible shapes
    return is_evm_address(s) or is_sol_address(s) or is_block_address(s) or is_bech32_utxo(s)


# compare addresses: EVM hex case-insensitive; everything else case-sensitive.
def addr_eq(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return False
    x, y = str(a), str(b)
    if _HEX_RE.match(x) and _HEX_RE.match(y):
        return x.lower() == y.lower()
    return x == y


def label_key(s: Any) -> str:
    return str(s or "").strip().lower()


# ---- pure list operations (the store wrapper persists the result) ----------
def normalize_entry(e: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    e = e or {}
    label = str(member(e, "label") or "").strip()
    address = str(member(e, "address") or "").strip()
    if not label:
        raise ValueError("address book entry requires a label")
    if not address:
        raise ValueError("address book entry requires an address")
    out: Dict[str, Any] = {"label": label, "address": address}
    if member(e, "chain"):
        out["chain"] = str(member(e, "chain"))
    note = member(e, "note")
    if note is not None and str(note) != "":
        out["note"] = str(note)
    return out


def upsert_entry(lst: Optional[List[Dict[str, Any]]], entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """add OR edit (dedup by label, case-insensitive): a matching label is replaced."""
    e = normalize_entry(entry)
    out = list(lst) if isinstance(lst, list) else []
    idx = next((i for i, x in enumerate(out) if label_key(x.get("label")) == label_key(e["label"])), -1)
    if idx >= 0:
        out[idx] = e
    else:
        out.append(e)
    out.sort(key=lambda x: label_key(x.get("label")))
    return out


def remove_entry(lst: Optional[List[Dict[str, Any]]], label: Any) -> List[Dict[str, Any]]:
    return [x for x in (lst if isinstance(lst, list) else []) if label_key(x.get("label")) != label_key(label)]


def find_by_label(lst: Optional[List[Dict[str, Any]]], label: Any) -> Optional[Dict[str, Any]]:
    for x in (lst if isinstance(lst, list) else []):
        if label_key(x.get("label")) == label_key(label):
            return x
    return None


def find_by_address(lst: Optional[List[Dict[str, Any]]], address: Any,
                    chain: Any = None) -> Optional[Dict[str, Any]]:
    """first book entry matching an address (optionally constrained to a chain)."""
    for x in (lst if isinstance(lst, list) else []):
        if addr_eq(x.get("address"), address) and (not chain or not x.get("chain") or x.get("chain") == chain):
            return x
    return None


# ===========================================================================
# resolve_name(input, chain, ctx) -> { address, source } | None
#   ctx['resolveEns'](name) -> address | None    (injected, for .eth)
#   ctx['resolveSns'](name) -> address | None    (injected, for .sol)
#   ctx['book']            -> [entry]             (the local book list)
# Never returns a guessed address.
# ===========================================================================
async def resolve_name(input_: Any, chain: Any,
                       ctx: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    ctx = ctx or {}
    raw = str(input_ or "").strip()
    if not raw:
        return None
    lower = raw.lower()

    # ENS (.eth) — the injected resolver is the sole authority.
    if lower.endswith(".eth"):
        resolve_ens = member(ctx, "resolveEns")
        if not callable(resolve_ens):
            return None
        try:
            addr = await maybe_await(resolve_ens(raw))
        except Exception:  # noqa: BLE001
            addr = None
        return {"address": str(addr), "source": "ens", "name": raw} if addr else None
    # SNS (.sol)
    if lower.endswith(".sol"):
        resolve_sns = member(ctx, "resolveSns")
        if not callable(resolve_sns):
            return None
        try:
            addr = await maybe_await(resolve_sns(raw))
        except Exception:  # noqa: BLE001
            addr = None
        return {"address": str(addr), "source": "sns", "name": raw} if addr else None

    # local book by label
    book = member(ctx, "book") or []
    hit = find_by_label(book, raw)
    if hit:
        return {"address": hit["address"], "source": "book", "label": hit["label"]}

    # a verbatim raw address — returned ONLY when it is a plausible address for
    # the chain (never a guess, never a transform of the input).
    if is_address_like(raw, chain):
        return {"address": raw, "source": "raw"}

    return None


# ===========================================================================
# reverse_name(address, chain, ctx) -> { label, source } | None
#   preference: book label > forward-verified ENS/SNS reverse > None.
#   ctx['reverseEns'](addr)->name, ctx['reverseSns'](addr)->name (injected),
#   each only trusted when it FORWARD-verifies (name resolves back to addr).
# ===========================================================================
async def reverse_name(address: Any, chain: Any,
                       ctx: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    ctx = ctx or {}
    if not address:
        return None
    book = member(ctx, "book") or []
    hit = find_by_address(book, address, chain)
    if hit:
        return {"label": hit["label"], "source": "book"}

    async def try_reverse(rev_fn, fwd_fn, source):
        if not callable(rev_fn):
            return None
        try:
            name = await maybe_await(rev_fn(address))
        except Exception:  # noqa: BLE001
            name = None
        if not name:
            return None
        # forward-verify: the claimed name MUST resolve back to this address.
        if not callable(fwd_fn):
            return None
        try:
            fwd = await maybe_await(fwd_fn(name))
        except Exception:  # noqa: BLE001
            fwd = None
        return {"label": str(name), "source": source} if (fwd and addr_eq(fwd, address)) else None

    if chain in EVM_CHAINS:
        return await try_reverse(member(ctx, "reverseEns"), member(ctx, "resolveEns"), "ens")
    if chain == "solana":
        return await try_reverse(member(ctx, "reverseSns"), member(ctx, "resolveSns"), "sns")
    return None


# ===========================================================================
# The stateful store wrapper (persists to the injected Store under STORE_KEY).
# ===========================================================================
def create_book(opts: Optional[Dict[str, Any]] = None):
    opts = opts or {}
    store = member(opts, "store")
    key = member(opts, "key") or STORE_KEY
    if store is None or not callable(member(store, "get")) or not callable(member(store, "set")):
        raise ValueError("create_book: an injected Store with get/set is required")

    async def load():
        s = await maybe_await(store.get([key]))
        v = s.get(key) if isinstance(s, dict) else None
        return v if isinstance(v, list) else []

    async def save(lst):
        await maybe_await(store.set({key: lst}))
        return lst

    class _Book:
        async def list(self):
            return await load()

        async def add(self, entry):
            return await save(upsert_entry(await load(), entry))

        async def edit(self, entry):
            return await save(upsert_entry(await load(), entry))  # same dedup-by-label path

        async def remove(self, label):
            return await save(remove_entry(await load(), label))

        async def get(self, label):
            return find_by_label(await load(), label)

        async def find_address(self, address, chain=None):
            return find_by_address(await load(), address, chain)

        async def resolve_name(self, input_, chain, ctx=None):
            merged = {"book": await load()}
            merged.update(ctx or {})
            return await resolve_name(input_, chain, merged)

        async def reverse_name(self, address, chain, ctx=None):
            merged = {"book": await load()}
            merged.update(ctx or {})
            return await reverse_name(address, chain, merged)

    return _Book()
