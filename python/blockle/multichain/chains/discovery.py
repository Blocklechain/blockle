"""Held-token auto-discovery: per-chain enumeration of the tokens an address
ACTUALLY holds, plus the merge/dedupe logic that folds those discovered tokens
into the wallet's default (known) token list.

Discovery is per-chain (each adapter owns its own ``discover_tokens``); this
module holds the chain-agnostic plumbing:

  * response parsers (Solana ``getTokenAccountsByOwner`` jsonParsed, Alchemy
    ``alchemy_getTokenBalances`` / ``alchemy_getTokenMetadata``) — pure, so the
    tests parse canned fixtures with no network;
  * :func:`merge_balances` — merge the default-list balances with the
    discovered balances, DEDUPED by ``(chain, contract)``, native first, then
    non-zero balances, then everything else;
  * :func:`is_spam` — a deliberately simple optional spam heuristic.

HARD RULES: endpoints/keys are config and are passed in by the registry; nothing
here hardcodes or logs a key. Discovery is additive — it never changes how the
native coin or the default tokens are read.
"""

from __future__ import annotations

from typing import Any, List, Optional

from .chain_adapter import AssetRef, Balance, format_units

#: The SPL Token program — owner-program filter for ``getTokenAccountsByOwner``.
TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
#: Token-2022 program (newer SPL mints). Enumerated alongside the classic one.
TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"


# --------------------------------------------------------------------------
# response parsers (pure — no network, no adapter state)
# --------------------------------------------------------------------------


def parse_spl_accounts(resp: Any) -> List[dict]:
    """Parse a Solana ``getTokenAccountsByOwner`` (jsonParsed) response into
    ``[{"mint", "amount", "decimals"}]`` with amounts aggregated per mint and
    zero balances dropped."""
    value = resp.get("value") if isinstance(resp, dict) else resp
    agg: dict = {}
    for acc in (value or []):
        try:
            info = acc["account"]["data"]["parsed"]["info"]
            mint = info["mint"]
            ta = info["tokenAmount"]
            amount = int(ta["amount"])
            decimals = int(ta["decimals"])
        except (KeyError, TypeError, ValueError):
            continue
        if mint in agg:
            agg[mint]["amount"] += amount
        else:
            agg[mint] = {"mint": mint, "amount": amount, "decimals": decimals}
    return [v for v in agg.values() if v["amount"] > 0]


def parse_alchemy_balances(resp: Any) -> List[dict]:
    """Parse ``alchemy_getTokenBalances`` into ``[{"contract", "amount"}]``,
    dropping zero balances and un-parseable hex."""
    rows = resp.get("tokenBalances") if isinstance(resp, dict) else resp
    out: List[dict] = []
    for tb in (rows or []):
        contract = tb.get("contractAddress") if isinstance(tb, dict) else None
        if not contract:
            continue
        raw = tb.get("tokenBalance") or "0x0"
        try:
            amount = int(raw, 16) if isinstance(raw, str) else int(raw)
        except (TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        out.append({"contract": contract, "amount": amount})
    return out


def parse_alchemy_metadata(resp: Any) -> dict:
    """Normalise ``alchemy_getTokenMetadata`` into ``{symbol, decimals, name,
    logo}`` with safe fallbacks."""
    r = resp if isinstance(resp, dict) else {}
    dec = r.get("decimals")
    try:
        decimals = int(dec) if dec is not None else 18
    except (TypeError, ValueError):
        decimals = 18
    return {
        "symbol": (r.get("symbol") or "").strip() or "?",
        "decimals": decimals,
        "name": (r.get("name") or None),
        "logo": (r.get("logo") or None),
    }


# --------------------------------------------------------------------------
# spam heuristic (optional, simple)
# --------------------------------------------------------------------------

_SPAM_MARKERS = (
    "http://", "https://", "www.", ".com", ".io", ".org", ".xyz", ".net",
    "visit ", "claim", "reward", "airdrop", "voucher", "t.me", "giveaway",
    "free ", "bonus", "access", "redeem",
)


def is_spam(asset: AssetRef) -> bool:
    """A conservative obvious-spam check on token *name/symbol*: URLs, claim
    bait, or absurdly long text. Never flags the native coin."""
    if asset.kind == "native":
        return False
    text = f"{asset.symbol or ''} {asset.name or ''}".lower()
    if len(asset.symbol or "") > 24 or len(asset.name or "") > 48:
        return True
    return any(m in text for m in _SPAM_MARKERS)


# --------------------------------------------------------------------------
# merge / dedupe
# --------------------------------------------------------------------------


def _key(b: Balance):
    a = b.asset
    if a.kind == "native":
        return ("native", a.chain)
    return (a.chain, (a.address or a.symbol or "").lower())


def _is_nonzero(b: Balance) -> bool:
    if getattr(b, "error", None):
        return False
    try:
        return int(b.confirmed) > 0
    except (TypeError, ValueError):
        return False


def _richer_asset(a: AssetRef, b: AssetRef) -> AssetRef:
    """Pick the asset ref carrying the more useful metadata (a real symbol, a
    name, a logo) — so a known-list USDC wins over a bare discovered mint."""
    def score(x: AssetRef) -> int:
        s = 0
        sym = x.symbol or ""
        if sym and sym != "?" and not sym.endswith("…"):
            s += 2
        if getattr(x, "name", None):
            s += 1
        if getattr(x, "logo", None):
            s += 1
        return s
    return a if score(a) >= score(b) else b


def _combine(first: Balance, second: Balance) -> Balance:
    """Fold a duplicate (same chain+contract) into one Balance: richer metadata,
    and a live non-zero amount preferred over a zero/errored one."""
    asset = _richer_asset(first.asset, second.asset)
    pick = first
    if not _is_nonzero(first) and _is_nonzero(second):
        pick = second
    return Balance(asset=asset, confirmed=pick.confirmed, display=pick.display,
                   spendable=pick.spendable, error=pick.error)


def merge_balances(primary: List[Balance], discovered: Optional[List[Balance]] = None,
                   hide_spam: bool = False) -> List[Balance]:
    """Merge default-list balances (``primary``, native first) with discovered
    balances, deduped by ``(chain, contract)``. Order: native, then non-zero
    balances, then zero/errored. Stable within each group.

    ``hide_spam`` drops zero-balance tokens and obvious-spam names (the native
    coin and default-list tokens with a live balance are always kept)."""
    seen: dict = {}
    order: list = []
    for b in list(primary or []) + list(discovered or []):
        k = _key(b)
        if k in seen:
            seen[k] = _combine(seen[k], b)
        else:
            seen[k] = b
            order.append(k)
    out = [seen[k] for k in order]
    if hide_spam:
        out = [b for b in out
               if b.asset.kind == "native" or (_is_nonzero(b) and not is_spam(b.asset))]
    # native first (0), then non-zero (1), then zero/errored (2); stable sort
    out.sort(key=lambda b: 0 if b.asset.kind == "native" else (1 if _is_nonzero(b) else 2))
    return out


# --------------------------------------------------------------------------
# builders — turn parsed rows into Balance objects
# --------------------------------------------------------------------------


def spl_rows_to_balances(chain: str, rows: List[dict], known=None) -> List[Balance]:
    """Build SPL Balances from :func:`parse_spl_accounts` rows, borrowing
    symbol/decimals/logo from a known-token list keyed by mint when present."""
    by_addr = {(t.address or "").lower(): t for t in (known or []) if t.address}
    out: List[Balance] = []
    for r in rows:
        mint = r["mint"]
        hit = by_addr.get(mint.lower())
        decimals = hit.decimals if hit else r["decimals"]
        symbol = hit.symbol if hit else (mint[:4] + "…")
        asset = AssetRef(chain=chain, kind="spl", symbol=symbol, decimals=decimals,
                         address=mint, name=(hit.name if hit else None),
                         logo=(hit.logo if hit else None))
        v = str(r["amount"])
        out.append(Balance(asset=asset, confirmed=v, display=format_units(v, decimals)))
    return out
