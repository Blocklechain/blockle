"""chains/autoimport.py — AUTO-DETECT + AUTO-IMPORT held tokens on EVERY chain.

Faithful Python port of ``blockle-extension/chains/autoimport.js``; shared vector
``docs/scan-vectors.json`` -> ``tokenImport``.

On unlock / account-switch / manual refresh the wallet runs per-chain token
discovery for EVERY enabled chain + custom network and AUTO-IMPORTS (persists)
any newly-found token that carries a REAL positive balance into the SAME
persisted list a manual "import token" writes (the ``chainTokens`` map for EVM /
Solana / custom nets; the ``tokens`` id array for BLOCK-20) — so it shows up with
its balance + in the portfolio automatically, no manual add.

NON-NEGOTIABLE RULES:
  * NEVER fabricate — a token is imported ONLY with a real detected balance +
    metadata from the adapter's discover_tokens (balance > 0).
  * Dedupe by (chain, contract|mint) — re-running adds nothing new (idempotent).
  * Honor the security suite: a token whose contract/mint is on the denylist, or
    that trips the spam heuristic, or that carries a scam/honeypot/rug flag, is
    NOT auto-imported — it is MARKED into a separate ``flaggedTokens`` list.
  * Default first-class tokens (USDC/USDT/…) are already shown; never re-imported.

PURE core (:func:`filter_for_import`) + an async orchestrator (:func:`auto_import`)
with every dependency injected, so it is fully testable with no network.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


def _lc(x: Any) -> str:
    return "" if x is None else str(x).lower()


def token_key(t: Any) -> str:
    """Canonical identity of a token on a chain: (chain, contract|mint|id)."""
    if not t:
        return ""
    tid = _lc(t.get("address") or t.get("mint") or t.get("contract") or t.get("id") or t.get("symbol"))
    return _lc(t.get("chain")) + ":" + tid


def token_id(t: Dict[str, Any]) -> Optional[str]:
    """The on-chain id a persisted entry is keyed by (what a manual import writes)."""
    return t.get("address") or t.get("mint") or t.get("contract") or t.get("id") or None


def has_positive_balance(t: Any) -> bool:
    if not t or t.get("balance") is None:
        return False
    try:
        return int(str(t.get("balance"))) > 0
    except (TypeError, ValueError):
        return False


_SPAM_DOMAIN = re.compile(r"https?://|www\.|\.(com|net|io|org|xyz|app|fi|co|vip|cash|gift)\b", re.I)
_SPAM_BAIT = re.compile(r"\b(airdrop|claim|voucher|reward|visit|redeem|bonus|free|giveaway|t\.me|telegram)\b", re.I)


def looks_spam(t: Any) -> bool:
    """Obvious-spam check on token name/symbol — URLs, domains, claim-bait, or
    absurdly long text (mirrors TokenDiscovery.looksSpam)."""
    name = str((t and (t.get("name") or t.get("symbol"))) or "")
    if not name:
        return False
    if len(name) > 48:
        return True
    if _SPAM_DOMAIN.search(name):
        return True
    if _SPAM_BAIT.search(name):
        return True
    return False


# The scam/danger flags that BLOCK an auto-import (fail-closed).
DANGER_FLAGS = {"honeypot", "scam", "rug", "denylist", "malicious", "blocklisted"}


def normalize_import(t: Dict[str, Any]) -> Dict[str, Any]:
    """Strip transient balance/display fields — the persisted entry mirrors exactly
    what a manual import writes (chain, kind, symbol, decimals, address|mint)."""
    out: Dict[str, Any] = {
        "chain": t.get("chain"),
        "kind": t.get("kind") or "erc20",
        "symbol": t.get("symbol") or "TOKEN",
        "decimals": int(t.get("decimals") if t.get("decimals") is not None else 18),
    }
    if t.get("address"):
        out["address"] = t["address"]
    if t.get("mint"):
        out["mint"] = t["mint"]
    if t.get("name"):
        out["name"] = t["name"]
    return out


def filter_for_import(discovered: Optional[List[Dict[str, Any]]],
                      existing: Optional[List[Dict[str, Any]]],
                      opts: Optional[Dict[str, Any]] = None) -> Dict[str, List[Dict[str, Any]]]:
    """PURE: classify a batch of DISCOVERED tokens for ONE chain against the
    already-persisted list + the security denylist. Deterministic, no I/O.

    Returns ``{"toImport", "flagged", "skipped"}`` — each a list of
    ``{"token", "reason"?}``."""
    opts = opts or {}
    denylist = {_lc(x) for x in (opts.get("denylist") or [])}
    spam_filter = opts.get("spamFilter") is not False
    existing_keys = {token_key(t) for t in (existing or [])}
    to_import: List[Dict[str, Any]] = []
    flagged: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for t in (discovered or []):
        if not t:
            continue
        key = token_key(t)
        if not key or key.endswith(":"):
            skipped.append({"token": t, "reason": "no-identity"})
            continue
        if t.get("isDefault"):
            skipped.append({"token": t, "reason": "default"})
            continue
        if not has_positive_balance(t):
            skipped.append({"token": t, "reason": "zero-balance"})
            continue
        if key in existing_keys:
            skipped.append({"token": t, "reason": "already-imported"})
            continue

        # ---- security gate: denylist / scam flags / spam → MARK, do not import ----
        flags = [_lc(f) for f in (t.get("flags") or [])]
        tid = _lc(token_id(t))
        if tid and tid in denylist:
            flagged.append({"token": t, "reason": "denylist"})
            continue
        danger = next((f for f in flags if f in DANGER_FLAGS), None)
        if danger:
            flagged.append({"token": t, "reason": danger})
            continue
        if spam_filter and looks_spam(t):
            flagged.append({"token": t, "reason": "spam"})
            continue

        to_import.append({"token": normalize_import(t)})

    return {"toImport": to_import, "flagged": flagged, "skipped": skipped}


async def auto_import(deps: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Async orchestrator: run discovery for every chain + auto-import.

    deps:
      registry      — ChainRegistry (``discover_tokens(chain, addr)`` + ``enabled()``)
      address_for   — async/sync callable (chain) -> account address
      store         — {"get"(keys)->dict, "set"(obj)} persistence shim
      chains        — optional explicit chain id list; else registry.enabled()
      denylist      — optional security denylist (contract/mint strings)
      spam_filter   — default True

    Writes newly-found non-flagged tokens into ``chainTokens[chain]`` (BLOCK-20 ids
    into ``tokens``), MARKS flagged ones into ``flaggedTokens[chain]``, persists,
    and returns a per-chain summary. Incremental + idempotent."""
    deps = deps or {}
    registry = deps.get("registry")
    if not registry or not hasattr(registry, "discover_tokens"):
        raise ValueError("auto_import requires a registry")
    store = deps.get("store")
    chains = deps.get("chains")
    if chains is None:
        chains = registry.enabled() if hasattr(registry, "enabled") else []
    denylist = deps.get("denylist") or []
    spam_filter = deps.get("spamFilter") is not False
    address_for = deps.get("address_for") or deps.get("addressFor")

    got: Dict[str, Any] = {}
    if store and hasattr(store, "get"):
        got = (await _maybe(store.get(["chainTokens", "tokens", "flaggedTokens"]))) or {}
    chain_tokens: Dict[str, Any] = dict(got.get("chainTokens") or {})
    block_ids: List[Any] = list(got.get("tokens") or [])
    flagged_tokens: Dict[str, Any] = dict(got.get("flaggedTokens") or {})

    summary: Dict[str, Any] = {"imported": [], "flagged": [], "perChain": {}}
    changed = False

    for chain in chains:
        try:
            address = await _maybe(address_for(chain)) if callable(address_for) else None
        except Exception:
            address = None
        if not address:
            summary["perChain"][chain] = {"error": "no-address"}
            continue

        try:
            discovered = (await _maybe(registry.discover_tokens(chain, address))) or []
        except Exception:
            discovered = []

        if chain == "block":
            existing = [{"chain": "block", "id": i} for i in block_ids]
        else:
            existing = chain_tokens.get(chain) or []

        res = filter_for_import(discovered, existing, {"denylist": denylist, "spamFilter": spam_filter})
        to_import, flagged, skipped = res["toImport"], res["flagged"], res["skipped"]

        if to_import:
            if chain == "block":
                for item in to_import:
                    tid = token_id(item["token"])
                    if tid and tid not in block_ids:
                        block_ids.append(tid)
                        changed = True
            else:
                lst = list(chain_tokens.get(chain) or [])
                keys = {token_key(t) for t in lst}
                for item in to_import:
                    k = token_key(item["token"])
                    if k not in keys:
                        lst.append(item["token"])
                        keys.add(k)
                        changed = True
                chain_tokens[chain] = lst
            for item in to_import:
                summary["imported"].append(item["token"])

        if flagged:
            flist = list(flagged_tokens.get(chain) or [])
            fkeys = {token_key(t) for t in flist}
            for item in flagged:
                tok, reason = item["token"], item["reason"]
                k = token_key(tok)
                if k not in fkeys:
                    marked = normalize_import(tok)
                    marked["reason"] = reason
                    flist.append(marked)
                    fkeys.add(k)
                    changed = True
                summary["flagged"].append({"token": normalize_import(tok), "reason": reason})
            flagged_tokens[chain] = flist

        summary["perChain"][chain] = {"imported": len(to_import), "flagged": len(flagged),
                                      "skipped": len(skipped)}

    if changed and store and hasattr(store, "set"):
        await _maybe(store.set({"chainTokens": chain_tokens, "tokens": block_ids,
                                "flaggedTokens": flagged_tokens}))

    summary["changed"] = changed
    summary["chainTokens"] = chain_tokens
    summary["tokens"] = block_ids
    summary["flaggedTokens"] = flagged_tokens
    return summary


async def _maybe(value: Any) -> Any:
    import inspect
    if inspect.isawaitable(value):
        return await value
    return value


# JS-parity aliases
filterForImport = filter_for_import
autoImport = auto_import
tokenKey = token_key
normalizeImport = normalize_import
hasPositiveBalance = has_positive_balance
looksSpam = looks_spam
