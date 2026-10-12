"""multichain/security.py — the WALLET SECURITY SUITE (docs/WALLET-SECURITY.md).

Faithful Python port of ``blockle-extension/security.js`` (the JS reference),
asserted against the AUTHORITATIVE shared vectors ``docs/security-vectors.json``.

Stops the #1 way funds get drained: blind-signing a malicious transaction or a
hostile token approval. Everything here is READ-ONLY analysis + warnings — it
NEVER signs, NEVER moves funds, and NEVER fabricates a safety claim (the absence
of a warning is not a claim of safety).

Three parts, one spec:
  1. inspect_transaction(tx, ctx) -> Inspection   (pure given injected ctx)
  2. approval manager: list_approvals (read-only) + build_revoke (approve(s,0))
  3. scam / phishing / malicious-approval warnings (config-toggleable, pinned
     codes) + a pre-sign gate helper (danger forces an explicit confirm).

PURE: every chain read (getCode / balance / USD / indexer / denylist / history)
is injected via ``ctx`` and mockable. All money math is base-unit / int-exact.

Reuses the EXISTING ERC-20 calldata builders in ``chains/evm.py`` (never
reimplements signing).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ._util import maybe_await, member
from .chains import evm as EVM
from .chains.chain_adapter import format_units

# ---- selectors (mirror chains/evm.py) --------------------------------------
SEL_TRANSFER = "a9059cbb"            # transfer(address,uint256)
SEL_APPROVE = "095ea7b3"             # approve(address,uint256)
SEL_TRANSFER_FROM = "23b872dd"       # transferFrom(address,address,uint256)
SEL_SET_APPROVAL_FOR_ALL = "a22cb465"  # setApprovalForAll(address,bool)
MAX_UINT256 = (1 << 256) - 1

# Default "unlimited" threshold: at/above this an allowance is treated as
# unlimited. 2^255 catches 2^256-1 and every absurdly-large grant while never
# flagging a real, sized allowance. Operator-overridable via config.
DEFAULT_UNLIMITED_THRESHOLD = 1 << 255

EVM_CHAINS = {"ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche"}
UTXO_CHAINS = {"bitcoin", "litecoin", "dogecoin"}

SEV_RANK = {"none": 0, "info": 1, "warn": 2, "danger": 3}
WARNING_CODES = [
    "unlimited-approval", "approval-to-unknown-spender", "approval-to-eoa",
    "known-drainer", "send-to-flagged", "setApprovalForAll-true",
    "new-address", "large-share", "mismatch-currency",
]

_HEX_RE = re.compile(r"^0x[0-9a-fA-F]+$")
_ADDR_HEX_RE = re.compile(r"^0x[0-9a-fA-F]*$")
_INT_RE = re.compile(r"^-?\d+$")


# ---- small pure helpers ----------------------------------------------------
def to_big(v: Any) -> int:
    if isinstance(v, bool):
        raise ValueError("not a base-unit integer: " + repr(v))
    if isinstance(v, int):
        return v
    if v is None or v == "":
        return 0
    s = str(v).strip()
    if _HEX_RE.match(s):
        return int(s, 16)
    if not _INT_RE.match(s):
        raise ValueError("not a base-unit integer: " + s)
    return int(s)


def norm(a: Any) -> Any:
    """Normalize an address for comparison: EVM hex is case-insensitive
    (lowercase); base58 (Solana) / bech32 are case-sensitive, left as-is."""
    if a is None:
        return a
    s = str(a)
    return s.lower() if _ADDR_HEX_RE.match(s) else s


def shorten(a: Any) -> str:
    s = str(a if a is not None else "")
    return s[:8] + "…" + s[-4:] if len(s) > 14 else s


def is_empty_code(code: Any) -> bool:
    if code is None:
        return True
    s = re.sub(r"^0x", "", str(code))
    return len(s) == 0 or re.match(r"^0*$", s) is not None


def _is_int_like(decimals) -> bool:
    if decimals is None:
        return False
    try:
        return float(decimals) == int(float(decimals))
    except (TypeError, ValueError):
        return False


def fmt_amt(base, decimals, symbol=None) -> str:
    if _is_int_like(decimals):
        try:
            s = format_units(str(to_big(base)), int(decimals))
        except Exception:
            s = str(base)
    else:
        s = str(base) + " base units"
    return s + " " + symbol if symbol else s


def _has(set_like, key) -> bool:
    if not set_like:
        return False
    try:
        return key in set_like
    except TypeError:
        return False


def W(code, severity, message, evidence=None) -> Dict[str, Any]:
    w = {"code": code, "severity": severity, "message": message}
    if evidence is not None:
        w["evidence"] = evidence
    return w


def max_severity(warnings) -> str:
    best = "none"
    for w in warnings:
        if SEV_RANK[w["severity"]] > SEV_RANK[best]:
            best = w["severity"]
    return best


def merge_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    cfg = cfg or {}
    thr = member(cfg, "unlimitedThreshold")
    pct = member(cfg, "largeSharePct")
    return {
        "unlimitedThreshold": to_big(thr) if thr is not None else DEFAULT_UNLIMITED_THRESHOLD,
        "largeSharePct": float(pct) if pct is not None else 50,
        "denylist": [norm(x) for x in (member(cfg, "denylist") or [])],
        "knownSpenders": [norm(x) for x in (member(cfg, "knownSpenders") or [])],
        "warnings": member(cfg, "warnings") or {},
    }


# ===========================================================================
# 1. DECODE — chain-specific, no fabrication (unknown stays contract-call)
# ===========================================================================
def _native_symbol(tx) -> str:
    asset = tx.get("asset")
    return (asset and member(asset, "symbol")) or tx.get("symbol") or "ETH"


def _native_asset(tx) -> Dict[str, Any]:
    asset = tx.get("asset")
    if asset and member(asset, "kind") == "native":
        return asset
    dec = member(asset, "decimals") if asset else None
    return {"chain": tx.get("chain"), "kind": "native", "symbol": _native_symbol(tx),
            "decimals": dec if dec is not None else 18}


def decode_evm(tx, config) -> Dict[str, Any]:
    to = norm(tx.get("to"))
    value = to_big(tx.get("value") or 0)
    data = (tx.get("data") or "0x").lower()
    hexs = re.sub(r"^0x", "", data)
    asset = tx.get("asset")
    token_asset = asset or {"chain": tx.get("chain"), "kind": "erc20", "address": to,
                            "decimals": None}

    # native transfer: no (or empty) calldata
    if len(hexs) < 8:
        native = _native_asset(tx)
        return {
            "kind": "native-transfer",
            "summary": f"Send {fmt_amt(value, native['decimals'], native['symbol'])} to {shorten(to)}",
            "details": [{"label": "To", "value": to}, {"label": "Amount", "value": str(value)}],
            "effects": [{"asset": native, "direction": "out", "amountBase": str(value)}] if value > 0 else [],
            "sem": {"recipient": to, "outAmount": value, "asset": native},
        }

    selector = hexs[:8]
    args = hexs[8:]

    def word(i):
        return args[i * 64:i * 64 + 64]

    def addr_at(i):
        return "0x" + (word(i) or "")[24:]

    def big_at(i):
        w = word(i)
        return int(w, 16) if w else 0

    tok_dec = member(token_asset, "decimals")
    tok_sym = member(token_asset, "symbol")

    if selector == SEL_TRANSFER:
        recipient, amount = norm(addr_at(0)), big_at(1)
        return {
            "kind": "token-transfer",
            "summary": f"Transfer {fmt_amt(amount, tok_dec, tok_sym or 'tokens')} to {shorten(recipient)}",
            "details": [{"label": "Token", "value": to}, {"label": "To", "value": recipient},
                        {"label": "Amount", "value": str(amount)}],
            "effects": [{"asset": token_asset, "direction": "out", "amountBase": str(amount)}],
            "sem": {"recipient": recipient, "outAmount": amount, "asset": token_asset, "token": to},
        }

    if selector == SEL_APPROVE:
        spender, allowance = norm(addr_at(0)), big_at(1)
        unlimited = allowance >= config["unlimitedThreshold"]
        return {
            "kind": "token-approval", "approvalType": "erc20",
            "summary": (f"Approve {shorten(spender)} to spend "
                        f"{'UNLIMITED' if unlimited else fmt_amt(allowance, tok_dec, tok_sym or 'tokens')}"),
            "details": [{"label": "Token", "value": to}, {"label": "Spender", "value": spender},
                        {"label": "Allowance", "value": "UNLIMITED" if unlimited else str(allowance)}],
            "effects": [],
            "sem": {"spender": spender, "allowance": allowance, "unlimited": unlimited,
                    "asset": token_asset, "token": to},
        }

    if selector == SEL_TRANSFER_FROM:
        frm, recipient, amount = norm(addr_at(0)), norm(addr_at(1)), big_at(2)
        return {
            "kind": "token-transfer",
            "summary": f"transferFrom {shorten(frm)} → {shorten(recipient)}: {fmt_amt(amount, tok_dec, tok_sym or 'tokens')}",
            "details": [{"label": "Token", "value": to}, {"label": "From", "value": frm},
                        {"label": "To", "value": recipient}, {"label": "Amount", "value": str(amount)}],
            "effects": [{"asset": token_asset, "direction": "out", "amountBase": str(amount)}],
            "sem": {"recipient": recipient, "from": frm, "outAmount": amount, "asset": token_asset, "token": to},
        }

    if selector == SEL_SET_APPROVAL_FOR_ALL:
        operator, approved = norm(addr_at(0)), big_at(1) != 0
        return {
            "kind": "token-approval", "approvalType": "operator",
            "summary": (f"{'GRANT' if approved else 'Revoke'} operator approval over your ENTIRE "
                        f"collection {shorten(to)} to {shorten(operator)}"),
            "details": [{"label": "Collection", "value": to}, {"label": "Operator", "value": operator},
                        {"label": "Approved", "value": approved}],
            "effects": [],
            "sem": {"operator": operator, "spender": operator, "approved": approved, "token": to},
        }

    # unknown selector -> contract-call (never fabricate a meaning)
    extra = (" sending " + fmt_amt(value, 18, _native_symbol(tx))) if value > 0 else ""
    return {
        "kind": "contract-call",
        "summary": f"Call contract {shorten(to)} (selector 0x{selector}){extra}",
        "details": [{"label": "Contract", "value": to}, {"label": "Selector", "value": "0x" + selector},
                    {"label": "Value", "value": str(value)}],
        "effects": [{"asset": _native_asset(tx), "direction": "out", "amountBase": str(value)}] if value > 0 else [],
        "sem": {"contract": to, "recipient": to if value > 0 else None, "outAmount": value,
                "asset": _native_asset(tx)},
    }


def decode_block(tx) -> Dict[str, Any]:
    to = tx.get("to")
    amount = to_big(tx.get("amount") or 0)
    fee = to_big(tx.get("fee")) if tx.get("fee") is not None else None
    asset = tx.get("asset") or {"chain": "block", "kind": "native", "symbol": "BLOCK", "decimals": 8}
    details = [{"label": "To", "value": to}, {"label": "Amount", "value": str(amount)}]
    if fee is not None:
        details.append({"label": "Fee", "value": str(fee)})
    return {
        "kind": "block-send",
        "summary": f"Send {fmt_amt(amount, member(asset, 'decimals'), member(asset, 'symbol'))} to {shorten(to)}",
        "details": details,
        "effects": [{"asset": asset, "direction": "out", "amountBase": str(amount)}],
        "sem": {"recipient": to, "outAmount": amount, "asset": asset},
    }


def decode_utxo(tx) -> Dict[str, Any]:
    inputs = tx.get("inputs") or []
    outputs = tx.get("outputs") or []
    asset = tx.get("asset")
    symbol = (asset and member(asset, "symbol")) or (
        "LTC" if tx.get("chain") == "litecoin" else "DOGE" if tx.get("chain") == "dogecoin" else "BTC")
    asset = asset or {"chain": tx.get("chain"), "kind": "native", "symbol": symbol, "decimals": 8}
    change_raw = []
    if tx.get("changeAddress"):
        ca = tx["changeAddress"]
        change_raw += ca if isinstance(ca, list) else [ca]
    if tx.get("ownAddresses"):
        change_raw += list(tx["ownAddresses"])
    change_set = {norm(x) for x in change_raw if x}
    in_total = sum((to_big(i.get("value")) for i in inputs), 0)
    out_total = sum((to_big(o.get("value")) for o in outputs), 0)
    fee = (in_total - out_total) if in_total > 0 else None
    send_outputs = [o for o in outputs if norm(o.get("address")) not in change_set]
    net_send = sum((to_big(o.get("value")) for o in send_outputs), 0)
    if send_outputs:
        primary = norm(send_outputs[0].get("address"))
    elif outputs:
        primary = norm(outputs[0].get("address"))
    else:
        primary = None
    details = [
        {"label": "Inputs", "value": str(len(inputs))},
        {"label": "Outputs", "value": str(len(outputs))},
        {"label": "To", "value": primary},
        {"label": "Net send", "value": str(net_send)},
    ]
    if fee is not None:
        details.append({"label": "Fee", "value": str(fee)})
    return {
        "kind": "utxo-send",
        "summary": f"Send {fmt_amt(net_send, 8, symbol)} to {shorten(primary)} ({len(inputs)} in → {len(outputs)} out)",
        "details": details,
        "effects": [{"asset": asset, "direction": "out", "amountBase": str(net_send)}],
        "sem": {"recipient": primary, "outAmount": net_send, "asset": asset},
    }


def decode_solana(tx) -> Dict[str, Any]:
    native = {"chain": "solana", "kind": "native", "symbol": "SOL", "decimals": 9}
    ix = tx.get("instructions") or ([tx["instruction"]] if tx.get("instruction") else [])

    def is_system(i):
        return member(i, "program") == "system" or member(i, "programId") == "11111111111111111111111111111111"

    def is_token(i):
        return member(i, "program") == "spl-token" or member(i, "programId") == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

    def info(i):
        return member(i, "info") or member(member(i, "parsed"), "info") or {}

    def typ(i):
        return member(i, "type") or member(member(i, "parsed"), "type")

    def find(pred):
        for i in ix:
            if pred(i):
                return i
        return None

    sys_xfer = find(lambda i: is_system(i) and typ(i) == "transfer")
    if sys_xfer:
        d = info(sys_xfer)
        amount = to_big(d.get("lamports") if d.get("lamports") is not None else (d.get("amount") or 0))
        to = d.get("destination") or d.get("to")
        return {
            "kind": "native-transfer",
            "summary": f"Send {fmt_amt(amount, 9, 'SOL')} to {shorten(to)}",
            "details": [{"label": "To", "value": to}, {"label": "Amount", "value": str(amount)}],
            "effects": [{"asset": native, "direction": "out", "amountBase": str(amount)}],
            "sem": {"recipient": to, "outAmount": amount, "asset": native},
        }

    tok_xfer = find(lambda i: is_token(i) and typ(i) in ("transfer", "transferChecked"))
    if tok_xfer:
        d = info(tok_xfer)
        ta = d.get("tokenAmount")
        amount = to_big((ta and ta.get("amount")) or d.get("amount") or 0)
        to = d.get("destination") or d.get("to")
        mint = d.get("mint")
        a = tx.get("asset")
        asset = {"chain": "solana", "kind": "spl", "mint": mint,
                 "symbol": member(a, "symbol"), "decimals": member(a, "decimals")}
        return {
            "kind": "token-transfer",
            "summary": f"Transfer {fmt_amt(amount, asset['decimals'], asset['symbol'] or 'SPL tokens')} to {shorten(to)}",
            "details": [{"label": "Mint", "value": mint}, {"label": "To", "value": to},
                        {"label": "Amount", "value": str(amount)}],
            "effects": [{"asset": asset, "direction": "out", "amountBase": str(amount)}],
            "sem": {"recipient": to, "outAmount": amount, "asset": asset},
        }

    tok_approve = find(lambda i: is_token(i) and typ(i) in ("approve", "approveChecked"))
    if tok_approve:
        d = info(tok_approve)
        ta = d.get("tokenAmount")
        allowance = to_big((ta and ta.get("amount")) or d.get("amount") or 0)
        spender = d.get("delegate") or d.get("spender")
        return {
            "kind": "token-approval", "approvalType": "erc20",
            "summary": f"Approve delegate {shorten(spender)} to spend {allowance} base units",
            "details": [{"label": "Delegate", "value": spender}, {"label": "Allowance", "value": str(allowance)}],
            "effects": [],
            "sem": {"spender": spender, "allowance": allowance, "unlimited": False, "token": d.get("mint")},
        }

    program_ids = [member(i, "programId") or member(i, "program") for i in ix]
    program_ids = [p for p in program_ids if p]
    n = len(program_ids)
    return {
        "kind": "contract-call",
        "summary": f"Solana program call ({n} instruction{'' if n == 1 else 's'})",
        "details": [{"label": "Programs", "value": ", ".join(program_ids)}],
        "effects": [],
        "sem": {"programIds": program_ids},
    }


# ===========================================================================
# 3. WARNINGS — each independently toggleable, thresholds from config
# ===========================================================================
async def run_warnings(decoded, tx, ctx, config) -> Dict[str, Any]:
    warnings: List[Dict[str, Any]] = []
    ran: List[str] = []
    skipped: List[Dict[str, Any]] = []

    def on(code):
        return config["warnings"].get(code) is not False

    denylist = set(config["denylist"])
    known_spenders = set(config["knownSpenders"])
    sem = decoded.get("sem") or {}
    kind = decoded["kind"]

    is_approval = kind == "token-approval"
    is_transfer = kind in ("native-transfer", "token-transfer", "block-send", "utxo-send")
    is_contract_call = kind == "contract-call"

    get_code = member(ctx, "getCode")
    get_balance = member(ctx, "getBalance")
    estimate_usd = member(ctx, "estimateUsd")
    seen_recipients = member(ctx, "seenRecipients")
    prior_approvals = member(ctx, "priorApprovals")

    async def check(code, can_run, reason, fn):
        # skip (with reason) when a dependency is unavailable; else record it ran
        # and emit a warning if it fired. Disabled checks are omitted entirely.
        if not on(code):
            return
        if not can_run:
            skipped.append({"code": code, "reason": reason})
            return
        try:
            w = await maybe_await(fn())
        except Exception as e:  # noqa: BLE001
            skipped.append({"code": code, "reason": "error: " + str(e)})
            return
        ran.append(code)
        if w:
            warnings.append(w)

    # ---- approvals ---------------------------------------------------------
    if is_approval and decoded.get("approvalType") == "erc20":
        async def _unlimited():
            if sem.get("unlimited"):
                allowance = sem.get("allowance")
                return W("unlimited-approval", "warn",
                         "This grants an UNLIMITED token allowance — the spender can move your "
                         "entire balance, now and in future.",
                         {"spender": sem.get("spender"),
                          "allowance": str(allowance) if allowance is not None else None})
            return None
        await check("unlimited-approval", True, None, _unlimited)

    if is_approval and decoded.get("approvalType") == "operator":
        async def _operator():
            if sem.get("approved") is True:
                return W("setApprovalForAll-true", "danger",
                         "Grants an operator control over your ENTIRE NFT collection — it can "
                         "transfer every item.",
                         {"operator": sem.get("operator"), "collection": sem.get("token")})
            return None
        await check("setApprovalForAll-true", True, None, _operator)

    if is_approval:
        spender = norm(sem.get("spender") or sem.get("operator"))

        async def _unknown_spender():
            unknown = bool(spender) and spender not in known_spenders and not _has(prior_approvals, spender)
            return W("approval-to-unknown-spender", "warn",
                     "Spender is not a known router and has not been approved by this wallet before.",
                     {"spender": spender}) if unknown else None
        await check("approval-to-unknown-spender", len(known_spenders) > 0,
                    "no known-good router allowlist configured", _unknown_spender)

        async def _eoa():
            code = await maybe_await(get_code(spender))
            return W("approval-to-eoa", "danger",
                     "Spender has NO contract code (an EOA) — it cannot be a real router. "
                     "Classic drainer pattern.",
                     {"spender": spender}) if is_empty_code(code) else None
        await check("approval-to-eoa", callable(get_code),
                    "code check skipped: no getCode/RPC", _eoa)

    # ---- known drainer (approval spender / contract-call target) -----------
    if is_approval or is_contract_call:
        target = norm(sem.get("spender") or sem.get("operator") or sem.get("contract"))

        async def _drainer():
            return W("known-drainer", "danger",
                     "Target address is on the known-drainer denylist.",
                     {"address": target}) if target and target in denylist else None
        await check("known-drainer", True, None, _drainer)

    # ---- transfers ---------------------------------------------------------
    if is_transfer:
        recipient = norm(sem.get("recipient"))

        async def _flagged():
            return W("send-to-flagged", "danger",
                     "Recipient is on the known-drainer / scam denylist.",
                     {"recipient": recipient}) if recipient and recipient in denylist else None
        await check("send-to-flagged", True, None, _flagged)

        async def _new_addr():
            return W("new-address", "info",
                     "First time this wallet has sent to this address.",
                     {"recipient": recipient}) if recipient and not _has(seen_recipients, recipient) else None
        await check("new-address", seen_recipients is not None,
                    "no local recipient history available", _new_addr)

        amount = to_big(sem.get("outAmount")) if sem.get("outAmount") is not None else 0

        async def _large_share():
            bal = to_big(await maybe_await(get_balance(sem.get("asset"))))
            if bal <= 0:
                return None
            # amount / bal > pct/100  <=>  amount*100 > bal*pct  (int-exact)
            pct = max(0, round(config["largeSharePct"]))
            sym = member(sem.get("asset"), "symbol") or "balance"
            return W("large-share", "warn",
                     f"This spends more than {config['largeSharePct']}% of your {sym}.",
                     {"amount": str(amount), "balance": str(bal)}) if amount * 100 > bal * pct else None
        await check("large-share", callable(get_balance) and amount > 0,
                    "balance unavailable (cannot compute share)", _large_share)

        async def _mismatch():
            usd = await maybe_await(estimate_usd(sem.get("asset"), str(amount)))
            a = sem.get("asset")
            ev = member(a, "symbol") or member(a, "address") or member(a, "mint")
            return W("mismatch-currency", "info",
                     "Cannot resolve a USD value for this asset — double-check the token is what "
                     "you expect.", {"asset": ev}) if usd is None else None
        await check("mismatch-currency", callable(estimate_usd) and amount > 0,
                    "no USD price source", _mismatch)

    return {"warnings": warnings, "checks": {"ran": ran, "skipped": skipped}}


# ===========================================================================
# THE CORE: inspect_transaction(tx, ctx) -> Inspection
# ===========================================================================
async def inspect_transaction(tx: Optional[Dict[str, Any]] = None,
                              ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    tx = tx or {}
    ctx = ctx or {}
    config = merge_config(member(ctx, "config"))
    chain = tx.get("chain") or member(ctx, "chain") or "unknown"

    if chain in EVM_CHAINS:
        decoded = decode_evm(tx, config)
    elif chain == "solana":
        decoded = decode_solana(tx)
    elif chain in UTXO_CHAINS:
        decoded = decode_utxo(tx)
    elif chain == "block":
        decoded = decode_block(tx)
    else:
        decoded = {"kind": "unknown", "summary": "Unrecognized transaction",
                   "details": [], "effects": [], "sem": {}}

    out = await run_warnings(decoded, tx, ctx, config)
    warnings = out["warnings"]
    return {
        "chain": chain, "kind": decoded["kind"],
        "summary": decoded["summary"],
        "details": decoded["details"],
        "effects": decoded["effects"],
        "warnings": warnings,
        "severity": max_severity(warnings),
        "checks": out["checks"],  # {ran:[], skipped:[{code,reason}]} — transparency, never "safe"
    }


# ===========================================================================
# 2. APPROVAL MANAGER — read-only list + build_revoke (routes through sign path)
# ===========================================================================
async def list_approvals(chain: str, owner: str,
                         ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ctx = ctx or {}
    config = merge_config(member(ctx, "config"))
    indexer = member(ctx, "indexer")
    get_approvals = member(indexer, "getApprovals")
    if not callable(get_approvals):
        # NEVER a fabricated all-clear: empty + an audited "unavailable" note.
        return {"chain": chain, "owner": owner, "approvals": [], "available": False,
                "note": "approvals unavailable: no indexer configured — this is NOT a safety claim."}
    try:
        raw = await maybe_await(get_approvals(chain, owner))
    except Exception as e:  # noqa: BLE001
        return {"chain": chain, "owner": owner, "approvals": [], "available": False,
                "note": "approvals unavailable: indexer error (" + str(e) + ") — NOT a safety claim."}

    approvals = []
    for a in (raw or []):
        raw_allow = (member(a, "allowanceBase") if member(a, "allowanceBase") is not None
                     else (member(a, "allowance") if member(a, "allowance") is not None
                           else (member(a, "amount") or 0)))
        allowance = to_big(raw_allow)
        approvals.append({
            "token": member(a, "token") or member(a, "contract") or member(a, "address"),
            "tokenSymbol": member(a, "tokenSymbol") or member(a, "symbol"),
            "spender": member(a, "spender"),
            "spenderLabel": member(a, "spenderLabel"),
            "allowanceBase": str(allowance),
            "unlimited": allowance >= config["unlimitedThreshold"],
            "lastUpdated": member(a, "lastUpdated"),
        })
    return {"chain": chain, "owner": owner, "approvals": approvals, "available": True}


def build_revoke(chain: str, token: Any, spender: str) -> Dict[str, Any]:
    """Build an approve(spender, 0) revoke. The suite NEVER signs — this tx goes
    through the normal sign path (and the agent gate) like any other."""
    token_addr = member(token, "address") or token
    if not token_addr:
        raise ValueError("build_revoke: missing token address")
    if not spender:
        raise ValueError("build_revoke: missing spender")
    return {
        "chain": chain,
        "kind": "token-approval-revoke",
        "to": token_addr,
        "value": "0",
        "data": EVM.erc20_approve_data(spender, 0),  # approve(spender, 0) via the EXISTING builder
        "note": "revoke — routes through the normal sign path + agent gate; the suite never signs",
    }


# ===========================================================================
# 4. PRE-SIGN GATE — the signer calls this before signing. A danger severity
#    forces an EXTRA explicit confirm; fail closed when no confirm handler is
#    wired. Composes with (never weakens) the caller's own gate. Never signs.
# ===========================================================================
class SigningBlocked(Exception):
    def __init__(self, msg, inspection):
        super().__init__(msg)
        self.blocked = True
        self.inspection = inspection


class SigningDeclined(Exception):
    def __init__(self, msg, inspection):
        super().__init__(msg)
        self.declined = True
        self.inspection = inspection


async def presign(opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    opts = opts or {}
    inspection = await inspect_transaction(opts.get("tx"), opts.get("ctx") or {})
    if inspection["severity"] == "danger":
        confirm = opts.get("confirm")
        if not callable(confirm):
            raise SigningBlocked(
                "signing blocked: danger-level security warnings require explicit confirmation",
                inspection)
        ok = await maybe_await(confirm(inspection))
        if not ok:
            raise SigningDeclined("signing declined by user after danger warnings", inspection)
    return {"inspection": inspection, "cleared": True}
