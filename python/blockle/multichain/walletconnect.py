"""multichain/walletconnect.py — Wallet dApp Connect (WalletConnect v2, Sign API) CORE.

Faithful Python port of ``blockle-extension/walletconnect.js`` (the JS reference),
asserted against the AUTHORITATIVE shared vectors ``docs/walletconnect-vectors.json``
(IDENTICAL across the JS reference, the Dart port, and this Python port).

WHAT THIS IS: the SESSION + REQUEST state machine + the SECURITY integration.
It is PURE given an INJECTED ``relay`` client — the WC v2 relay transport + the
WC crypto (x25519 + chacha20-poly1305) live behind that client and are NOT
implemented here (tests inject a FAKE relay). The real SDK wiring + a live
pairing smoke test are the final integration step (see spec §6), exactly like
the HTLC transport.

TRUST MODEL (the whole point): an external dApp is UNTRUSTED. Unlike the user's
own bots — which may run auto within an allocation — EVERY dApp signing request
requires explicit human approval AND runs through the wallet security pre-sign
gate (reuses ``security.inspect_transaction`` + this module's EIP-712 /
personal_sign decode). NO dApp request ever auto-approves. The core NEVER holds
keys: it signs via the injected wallet ``signer`` ONLY after approval, and
sessions persist NO key material.

All money is base-unit / int-exact (Python ints are arbitrary precision).
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

from ._util import maybe_await, member
from . import security as Security

# ---- pinned JSON-RPC / state-machine error codes (shared across ports) ----
ERR = {
    "UNAUTHORIZED": 3001,      # chain/method outside the approved namespace
    "USER_REJECTED": 4001,     # a human declined the approval / danger confirm
    "ETH_SIGN_DISABLED": 4100,  # eth_sign refused by default (blind-sign phishing)
    "SESSION_EXPIRED": 4201,   # request on an expired session
    "UNKNOWN_TOPIC": 4202,     # request on a topic with no settled session
    "UNSUPPORTED_CHAIN": 4203,  # wallet_switch/add to a chain the wallet lacks
    "BLOCKED": 5000,           # fail-closed: no approval/confirm handler wired
}

# The SUPPORTED + SAFE method set the wallet will ever settle into a session.
# eth_sign is DELIBERATELY absent (refused by default, §3). Read methods are
# answered from session state.
DEFAULT_METHODS = [
    "eth_sendTransaction",
    "eth_signTypedData", "eth_signTypedData_v4", "eth_signTypedData_v3",
    "personal_sign",
    "wallet_switchEthereumChain", "wallet_addEthereumChain",
    "eth_accounts", "eth_chainId",
    "solana_signTransaction", "solana_signAndSendTransaction", "solana_signMessage",
]
READ_METHODS = {"eth_accounts", "eth_chainId"}
SIGNING_METHODS = {
    "eth_sendTransaction", "eth_signTypedData", "eth_signTypedData_v4", "eth_signTypedData_v3",
    "personal_sign", "solana_signTransaction", "solana_signAndSendTransaction", "solana_signMessage",
}
DEFAULT_EVENTS = ["accountsChanged", "chainChanged"]
DEFAULT_TTL_SECONDS = 7 * 24 * 3600
DEFAULT_LONG_DEADLINE_SECONDS = 30 * 24 * 3600

STORE_KEY = "wc:sessions"

# unlimited sentinels for off-chain (Permit / Permit2) approvals. Permit2 amount
# is uint160 (max 2^160-1 is its "infinite" sentinel); EIP-2612 value is uint256
# (max 2^256-1). The generic unlimitedThreshold (2^255) catches uint256-style
# grants; the uint160 sentinel is matched explicitly so a Permit2 infinite
# allowance is never missed.
MAX_UINT256 = (1 << 256) - 1
MAX_UINT160 = (1 << 160) - 1
MAX_UINT48 = (1 << 48) - 1  # Permit2 "no expiry" sentinel

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
_TOPIC_RE = re.compile(r"[^0-9a-f]", re.IGNORECASE)
_HEX_RE = re.compile(r"^0x[0-9a-fA-F]+$")
_HEX_BODY_RE = re.compile(r"^0x[0-9a-fA-F]*$")

_SEV_RANK = {"none": 0, "info": 1, "warn": 2, "danger": 3}


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
    if not re.match(r"^-?\d+$", s):
        raise ValueError("not a base-unit integer: " + s)
    return int(s)


def lc(s: Any) -> Any:
    return s if s is None else str(s).lower()


def uniq(arr: List[Any]) -> List[Any]:
    out: List[Any] = []
    seen = set()
    for x in arr:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def now_sec(ms: int) -> int:
    return int(ms // 1000)


def host_of(url: Any) -> Optional[str]:
    if not url:
        return None
    try:
        host = urlparse(str(url)).hostname
        if host:
            return host.lower()
    except Exception:  # noqa: BLE001
        pass
    m = re.sub(r"^[a-z]+://", "", str(url), flags=re.IGNORECASE)
    m = re.split(r"[/?#]", m)[0]
    return m.lower() if m else None


def hex_to_utf8(h: Any) -> Optional[str]:
    hh = re.sub(r"^0x", "", str(h))
    if len(hh) == 0 or len(hh) % 2 != 0 or re.search(r"[^0-9a-fA-F]", hh):
        return None
    try:
        return bytes.fromhex(hh).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None


def utf8_to_hex(s: str) -> str:
    return "0x" + s.encode("utf-8").hex()


def is_mostly_printable(s: str) -> bool:
    if not s:
        return False
    printable = 0
    for ch in s:
        c = ord(ch)
        if c == 9 or c == 10 or c == 13 or (32 <= c < 127) or c >= 160:
            printable += 1
    return printable / len(s) >= 0.8


def max_severity(warnings) -> str:
    best = "none"
    for w in (warnings or []):
        if _SEV_RANK.get(w.get("severity"), 0) > _SEV_RANK[best]:
            best = w["severity"]
    return best


# JSON-RPC result / error shapers. handle_request echoes the request id.
def rpc_result(id_, result) -> Dict[str, Any]:
    return {"id": id_, "result": result}


def rpc_error(id_, code, message, data=None) -> Dict[str, Any]:
    e = {"code": code, "message": message}
    if data is not None:
        e["data"] = data
    return {"id": id_, "error": e}


# ===========================================================================
# 1. PAIRING URI — accept ONLY v2, reject v1 + malformed with a clear error.
# ===========================================================================
# wc:<topic>@2?relay-protocol=irn&symKey=<hex>
def parse_pairing_uri(uri: Any) -> Dict[str, Any]:
    if uri is None or not isinstance(uri, str):
        raise ValueError("walletconnect: pairing URI must be a string")
    s = uri.strip()
    if not s.lower().startswith("wc:"):
        raise ValueError("walletconnect: not a WalletConnect URI (missing wc: scheme)")
    body = s[3:]
    at = body.find("@")
    if at < 0:
        raise ValueError("walletconnect: malformed pairing URI (missing @version)")
    topic = body[:at]
    rest = body[at + 1:]
    q_index = rest.find("?")
    version = rest if q_index < 0 else rest[:q_index]
    if version == "1":
        raise ValueError(
            "walletconnect: WalletConnect v1 URIs are not supported (deprecated + insecure) "
            "— use a v2 (@2) link")
    if version != "2":
        raise ValueError(
            'walletconnect: unsupported WalletConnect version "@' + version
            + '" (only v2 is accepted)')
    if not topic or _TOPIC_RE.search(topic):
        raise ValueError("walletconnect: malformed pairing URI (bad topic)")
    query = "" if q_index < 0 else rest[q_index + 1:]
    params: Dict[str, str] = {}
    for kv in query.split("&"):
        if not kv:
            continue
        eq = kv.find("=")
        if eq < 0:
            params[kv] = ""
        else:
            params[kv[:eq]] = unquote(kv[eq + 1:])
    relay_protocol = params.get("relay-protocol")
    sym_key = params.get("symKey")
    if not relay_protocol:
        raise ValueError("walletconnect: malformed pairing URI (missing relay-protocol)")
    if not sym_key or not _HEX64_RE.match(sym_key):
        raise ValueError("walletconnect: malformed pairing URI (missing or invalid symKey)")
    return {"protocol": "wc", "topic": topic, "version": 2,
            "relayProtocol": relay_protocol, "symKey": sym_key}


# ===========================================================================
# EIP-712 typed-data decode + Permit / Permit2 detection (off-chain approval
# phishing is a top drainer vector — flag unlimited / long-deadline as DANGER)
# ===========================================================================
def decode_typed_data(raw: Any, cfg: Dict[str, Any], now_s: int) -> Dict[str, Any]:
    if isinstance(raw, str):
        try:
            typed = json.loads(raw)
        except Exception:  # noqa: BLE001
            typed = {}
    else:
        typed = raw
    typed = typed or {}
    domain = typed.get("domain") or {}
    message = typed.get("message") or {}
    primary_type = typed.get("primaryType") or ""

    warnings: List[Dict[str, Any]] = []
    is_permit2 = lc(domain.get("name")) == "permit2" or bool(
        re.match(r"^Permit(Single|Batch)$", str(primary_type)))
    details_amount = (message.get("details") or {}).get("amount") if isinstance(
        message.get("details"), dict) else None
    details_token = (message.get("details") or {}).get("token") if isinstance(
        message.get("details"), dict) else None
    looks_permit = bool(re.search(r"permit", str(primary_type), re.IGNORECASE)) or (
        bool(message)
        and (message.get("value") is not None or message.get("amount") is not None
             or details_amount is not None)
        and (message.get("spender") is not None or details_token is not None))
    is_approval = is_permit2 or looks_permit

    details = [
        {"label": "Primary type", "value": primary_type or "(unknown)"},
        {"label": "Domain", "value": str(domain.get("name")) if domain.get("name") is not None else "(unnamed)"},
    ]
    if domain.get("verifyingContract"):
        details.append({"label": "Verifying contract", "value": domain.get("verifyingContract")})
    if domain.get("chainId") is not None:
        details.append({"label": "Chain id", "value": str(domain.get("chainId"))})

    severity = "none"
    sem: Dict[str, Any] = {}

    if is_approval:
        msg_details = message.get("details") if isinstance(message.get("details"), dict) else {}
        spender = message.get("spender") or msg_details.get("spender") or None
        token = msg_details.get("token") or message.get("token") or domain.get("verifyingContract") or None
        if message.get("value") is not None:
            amount_raw = message.get("value")
        elif msg_details.get("amount") is not None:
            amount_raw = msg_details.get("amount")
        elif message.get("amount") is not None:
            amount_raw = message.get("amount")
        else:
            amount_raw = None
        if message.get("deadline") is not None:
            deadline_raw = message.get("deadline")
        elif message.get("sigDeadline") is not None:
            deadline_raw = message.get("sigDeadline")
        elif msg_details.get("expiration") is not None:
            deadline_raw = msg_details.get("expiration")
        else:
            deadline_raw = None

        amount = None
        unlimited = False
        if amount_raw is not None:
            amount = to_big(amount_raw)
            unlimited = amount >= cfg["unlimitedThreshold"] or amount == MAX_UINT160 or amount == MAX_UINT256
        deadline = None
        long_deadline = False
        if deadline_raw is not None:
            deadline = to_big(deadline_raw)
            long_window = cfg["longDeadlineSeconds"]
            long_deadline = deadline == MAX_UINT48 or deadline == MAX_UINT256 or (
                deadline > now_s and (deadline - now_s) > long_window)

        sem["spender"] = spender
        sem["token"] = token
        sem["unlimited"] = unlimited
        sem["longDeadline"] = long_deadline
        sem["amount"] = str(amount) if amount is not None else None
        sem["deadline"] = str(deadline) if deadline is not None else None

        details.append({"label": "Spender", "value": spender or "(none)"})
        if token:
            details.append({"label": "Token", "value": token})
        details.append({"label": "Allowance",
                        "value": "(none)" if amount is None else ("UNLIMITED" if unlimited else str(amount))})
        if deadline is not None:
            details.append({"label": "Deadline",
                            "value": "NEVER EXPIRES" if (deadline == MAX_UINT48 or deadline == MAX_UINT256) else str(deadline)})

        warnings.append({
            "code": "offchain-approval", "severity": "info",
            "message": ("This is an OFF-CHAIN token approval signature (Permit"
                        + ("2" if is_permit2 else "")
                        + ") — it grants a spender allowance without an on-chain tx."),
            "evidence": {"spender": spender, "token": token}})
        if unlimited:
            warnings.append({
                "code": "permit-unlimited", "severity": "danger",
                "message": "This Permit grants an UNLIMITED token allowance — the spender can drain your entire balance.",
                "evidence": {"spender": spender, "amount": sem["amount"]}})
        if long_deadline:
            warnings.append({
                "code": "permit-long-deadline", "severity": "danger",
                "message": "This Permit has an extremely long (or no) expiry — the allowance stays live far into the future.",
                "evidence": {"spender": spender, "deadline": sem["deadline"]}})

        severity = max_severity(warnings)

    kind = "typed-data-permit" if is_approval else "typed-data"
    if is_approval:
        summary = ("Sign off-chain approval (" + ("Permit2" if is_permit2 else "Permit") + ")"
                   + (" — UNLIMITED" if sem.get("unlimited") else "")
                   + (" to " + sem["spender"] if sem.get("spender") else ""))
    else:
        summary = ("Sign typed data: " + (primary_type or "struct")
                   + (" (" + domain.get("name") + ")" if domain.get("name") else ""))

    return {"kind": kind, "primaryType": primary_type, "domain": domain, "message": message,
            "typed": typed, "details": details, "warnings": warnings, "severity": severity,
            "summary": summary, "sem": sem, "isApproval": is_approval, "isPermit2": is_permit2}


# personal_sign — decode UTF-8 + flag a tx / EIP-712 smuggled as "text".
def decode_personal_sign(params: Any) -> Dict[str, Any]:
    msg_raw = params[0] if isinstance(params, list) else params
    is_hex = isinstance(msg_raw, str) and bool(_HEX_BODY_RE.match(msg_raw))
    message_hex = msg_raw if is_hex else utf8_to_hex("" if msg_raw is None else str(msg_raw))
    if is_hex:
        decoded = hex_to_utf8(msg_raw)
        text = decoded if decoded is not None else msg_raw
    else:
        text = "" if msg_raw is None else str(msg_raw)

    warnings: List[Dict[str, Any]] = []
    t = str(text or "")
    looks_typed = bool(re.search(r'"types"\s*:', t)) and bool(re.search(r'"domain"\s*:', t))
    hex_body = re.sub(r"^0x", "", msg_raw) if is_hex else ""
    looks_raw_tx = is_hex and len(hex_body) >= 64 and not is_mostly_printable(t)
    if looks_typed:
        warnings.append({
            "code": "personal-sign-structured", "severity": "warn",
            "message": ('This "message" contains EIP-712 typed-data JSON — a structured approval '
                        'may be smuggled as plain text. Read it carefully.')})
    if looks_raw_tx:
        warnings.append({
            "code": "personal-sign-binary", "severity": "warn",
            "message": ('This "message" is a long binary/hex blob (not human-readable text) — '
                        'it may be a raw transaction or digest. Do not sign unless you know what it is.')})

    return {"kind": "personal-sign", "messageHex": message_hex, "text": t,
            "details": [{"label": "Message", "value": t}],
            "warnings": warnings, "severity": max_severity(warnings),
            "summary": "Sign message: " + (t[:80] + "…" if len(t) > 80 else t)}


# ---- CAIP + namespace helpers ----------------------------------------------
def caip2_of_account(caip10: Any) -> str:
    parts = str(caip10).split(":")
    return parts[0] + ":" + parts[1] if len(parts) >= 3 else str(caip10)


def address_of_account(caip10: Any) -> str:
    parts = str(caip10).split(":")
    return ":".join(parts[2:]) if len(parts) >= 3 else str(caip10)


def namespace_for_chain(session, chain_id):
    nss = session.get("namespaces") or {}
    for ns_id in nss:
        if chain_id in (nss[ns_id].get("chains") or []):
            return nss[ns_id]
    return None


def account_for(session, chain_id):
    ns = namespace_for_chain(session, chain_id)
    if not ns:
        return None
    match = next((a for a in (ns.get("accounts") or []) if caip2_of_account(a) == chain_id), None)
    caip10 = match or ((ns.get("accounts") or [None])[0] if ns.get("accounts") else None)
    if not caip10:
        return None
    return {"caip10": caip10, "address": address_of_account(caip10), "chainId": chain_id}


def addresses_for(session, chain_id):
    ns = namespace_for_chain(session, chain_id)
    if not ns:
        return []
    return [address_of_account(a) for a in (ns.get("accounts") or [])
            if caip2_of_account(a) == chain_id]


def chain_id_hex(caip2):
    if not caip2:
        return None
    n = str(caip2).split(":")[1]
    if re.match(r"^\d+$", n):
        return "0x" + format(int(n, 10), "x")
    return caip2  # non-eip155 (e.g. solana) — return the caip2 as-is


# map a CAIP-2 eip155 chain to the security suite's chain name (best-effort).
EIP155_NAME = {
    "1": "ethereum", "8453": "base", "42161": "arbitrum", "10": "optimism",
    "137": "polygon", "56": "bnb", "43114": "avalanche",
}


def evm_chain_name(chain_id):
    if not chain_id:
        return "ethereum"
    parts = str(chain_id).split(":")
    if parts[0] == "solana":
        return "solana"
    if parts[0] == "eip155":
        return EIP155_NAME.get(parts[1], "ethereum")
    return "ethereum"


def _namespace_id_of(caip2):
    return str(caip2).split(":")[0]


def normalize_config(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    c = c or {}
    denylist = {lc(d) for d in (member(c, "denylist") or [])}
    wallet_chains = set(member(c, "walletChains") or member(c, "chains") or [])
    supported_methods = set(member(c, "supportedMethods") or DEFAULT_METHODS)
    allow_eth_sign = bool(member(c, "allowEthSign"))
    # eth_sign is NEVER a settled/routed method (matches the JS/Dart reference):
    # the blind-sign legacy method is a classic phishing vector, so it must never
    # enter the session namespace or reach the signer. `allowEthSign` only softens
    # the per-request refusal message; it does not settle eth_sign.
    supported_methods.discard("eth_sign")
    supported_events = set(member(c, "supportedEvents") or DEFAULT_EVENTS)
    ttl = member(c, "sessionTtlSeconds")
    thr = member(c, "unlimitedThreshold")
    long_dl = member(c, "longDeadlineSeconds")
    return {
        "denylist": denylist,
        "walletChains": wallet_chains,
        "supportedMethods": supported_methods,
        "supportedEvents": supported_events,
        "allowEthSign": allow_eth_sign,
        "sessionTtlSeconds": int(ttl) if ttl is not None else DEFAULT_TTL_SECONDS,
        "unlimitedThreshold": to_big(thr) if thr is not None else (1 << 255),
        "longDeadlineSeconds": int(long_dl) if long_dl is not None else DEFAULT_LONG_DEADLINE_SECONDS,
    }


class _InMemoryStore:
    """In-memory fallback store (tests inject their own; prod injects the
    encrypted Store). Mirrors the JS get/set shape: ``get(key) -> {key: val}``."""

    def __init__(self):
        self._mem: Dict[str, Any] = {}

    async def get(self, key):
        return {key: self._mem.get(key)}

    async def set(self, obj):
        self._mem.update(obj)


class _RpcError(Exception):
    """Carries a JSON-RPC error produced inside a signing gate/path."""

    def __init__(self, rpc):
        super().__init__(rpc.get("error", {}).get("message", "rpc error"))
        self.rpc = rpc


def _rpc_throw(id_, code, message):
    return _RpcError(rpc_error(id_, code, message))


# ===========================================================================
# factory — all platform pieces INJECTED. relay + store + signer are mockable.
# ===========================================================================
class WalletConnect:
    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        self.relay = deps.get("relay")                 # transport (injected; fake in tests)
        self.store = deps.get("store") or _InMemoryStore()  # encrypted session store (NO keys)
        self.signer = deps.get("signer")               # signs ONLY after approval
        self.security = deps.get("security") or Security  # the wallet security suite (reused)
        now = deps.get("now")
        if callable(now):
            self._clock = now
        else:
            import time
            self._clock = lambda: int(time.time() * 1000)
        self.config = normalize_config(deps.get("config"))
        self.ERR = ERR

    def _clock_ms(self):
        return self._clock()

    # expose the pure pairing parser as a method too (parity with the JS object)
    parse_pairing_uri = staticmethod(parse_pairing_uri)

    # -----------------------------------------------------------------------
    # session persistence (via the injected store; NO key material ever stored)
    # -----------------------------------------------------------------------
    async def _load_all(self) -> Dict[str, Any]:
        got = await maybe_await(self.store.get(STORE_KEY))
        m = got.get(STORE_KEY) if got else None
        return m if isinstance(m, dict) else {}

    async def _save_all(self, m: Dict[str, Any]):
        await maybe_await(self.store.set({STORE_KEY: m}))

    async def list_sessions(self) -> List[Any]:
        m = await self._load_all()
        return list(m.values())

    async def get_session(self, topic):
        m = await self._load_all()
        return m.get(topic)

    async def _put_session(self, sess):
        m = await self._load_all()
        m[sess["topic"]] = sess
        await self._save_all(m)
        return sess

    async def disconnect(self, topic, reason=None):
        m = await self._load_all()
        existed = topic in m
        if existed:
            del m[topic]
        await self._save_all(m)
        if existed and self.relay and callable(member(self.relay, "disconnect")):
            try:
                await maybe_await(self.relay.disconnect(topic, reason))
            except Exception:  # noqa: BLE001
                pass  # best-effort
        return {"topic": topic, "disconnected": existed}

    # -----------------------------------------------------------------------
    # 1b. pair — hand the parsed pairing to the relay. Grants NOTHING on its own.
    # -----------------------------------------------------------------------
    async def pair(self, uri):
        parsed = parse_pairing_uri(uri)  # throws on v1/malformed
        if self.relay and callable(member(self.relay, "pair")):
            await maybe_await(self.relay.pair(parsed))
        return parsed

    # -----------------------------------------------------------------------
    # 2. PROPOSAL review / approve / reject
    # -----------------------------------------------------------------------
    @staticmethod
    def _flatten_namespaces(ns):
        chains, methods, events = [], [], []
        for key in (ns or {}):
            entry = ns[key] or {}
            entry_chains = list(entry.get("chains")) if isinstance(entry.get("chains"), list) else []
            if len(entry_chains) == 0 and ":" in key:
                entry_chains = [key]
            chains.extend(entry_chains)
            methods.extend(entry.get("methods") or [])
            events.extend(entry.get("events") or [])
        return {"chains": uniq(chains), "methods": uniq(methods), "events": uniq(events)}

    def _merged_request(self, proposal):
        req = self._flatten_namespaces(proposal.get("requiredNamespaces"))
        opt = self._flatten_namespaces(proposal.get("optionalNamespaces"))
        return {
            "requiredChains": req["chains"],
            "chains": uniq(req["chains"] + opt["chains"]),
            "methods": uniq(req["methods"] + opt["methods"]),
            "events": uniq(req["events"] + opt["events"]),
        }

    def review_proposal(self, proposal):
        proposal = proposal or {}
        proposer = proposal.get("proposer") or {}
        dapp_raw = proposer.get("metadata") if proposer.get("metadata") else (
            proposal.get("dapp") or proposal.get("metadata") or {})
        # CLAIMED metadata — surfaced, NEVER trusted.
        dapp = {
            "name": dapp_raw.get("name"),
            "url": dapp_raw.get("url"),
            "icons": dapp_raw.get("icons") or [],
            "description": dapp_raw.get("description"),
        }
        m = self._merged_request(proposal)
        warnings: List[Dict[str, Any]] = []

        host = host_of(dapp["url"])
        if host and (host in self.config["denylist"]
                     or (dapp["url"] and lc(dapp["url"]) in self.config["denylist"])):
            warnings.append({
                "code": "dapp-domain-denylisted", "severity": "danger",
                "message": "This dApp domain is on the known-phishing / scam denylist.",
                "evidence": {"url": dapp["url"], "host": host}})
        unsupported = [c for c in m["chains"] if c not in self.config["walletChains"]]
        if unsupported:
            warnings.append({
                "code": "requests-unsupported-chain", "severity": "warn",
                "message": "The dApp requests chains this wallet does not control; those will not be granted.",
                "evidence": {"chains": unsupported}})
        if "eth_sign" in m["methods"]:
            warnings.append({
                "code": "requests-eth_sign", "severity": "warn",
                "message": "The dApp requests eth_sign — a blind-sign legacy method refused by default (classic phishing vector)."})

        return {
            "dapp": dapp,
            "requiredNamespaces": proposal.get("requiredNamespaces") or {},
            "optionalNamespaces": proposal.get("optionalNamespaces") or {},
            "chains": m["chains"],
            "methods": m["methods"],
            "events": m["events"],
            "warnings": warnings,
            "severity": max_severity(warnings),
        }

    async def approve_proposal(self, proposal, opts=None):
        proposal = proposal or {}
        opts = opts or {}
        offered = [a for a in (opts.get("accounts") or []) if a]
        review = self.review_proposal(proposal)
        m = self._merged_request(proposal)

        # chains the wallet actually controls = config-controlled ∩ offered-account chains
        offered_chains = {caip2_of_account(a) for a in offered}
        controlled = {c for c in self.config["walletChains"] if c in offered_chains}

        # fail-closed: a REQUIRED chain not controlled => reject the whole proposal.
        missing_required = [c for c in m["requiredChains"] if c not in controlled]
        if missing_required:
            e = ValueError("walletconnect: proposal requires chains the wallet does not control: "
                           + ", ".join(missing_required))
            e.code = ERR["UNSUPPORTED_CHAIN"]
            e.missing_required = missing_required
            raise e

        # settled chains = requested ∩ controlled (optional unsupported are dropped)
        settled_chains = [c for c in m["chains"] if c in controlled]
        settled_methods = [x for x in m["methods"] if x in self.config["supportedMethods"]]
        settled_events = [x for x in m["events"] if x in self.config["supportedEvents"]]

        namespaces: Dict[str, Any] = {}
        for c in settled_chains:
            ns_id = _namespace_id_of(c)
            if ns_id not in namespaces:
                namespaces[ns_id] = {"chains": [], "accounts": [], "methods": [], "events": []}
            namespaces[ns_id]["chains"].append(c)
        for a in offered:
            c = caip2_of_account(a)
            if c not in controlled:
                continue  # never expose an account on a chain we didn't settle
            ns_id = _namespace_id_of(c)
            if ns_id in namespaces:
                namespaces[ns_id]["accounts"].append(a)
        for ns_id in namespaces:
            namespaces[ns_id]["methods"] = uniq(settled_methods)
            namespaces[ns_id]["events"] = uniq(settled_events)
            namespaces[ns_id]["chains"] = uniq(namespaces[ns_id]["chains"])
            namespaces[ns_id]["accounts"] = uniq(namespaces[ns_id]["accounts"])

        now_ms = self._clock_ms()
        ttl = int(opts["ttlSeconds"]) if opts.get("ttlSeconds") is not None else self.config["sessionTtlSeconds"]
        topic = proposal.get("sessionTopic") or proposal.get("topic") or proposal.get("pairingTopic")
        if not topic:
            raise ValueError("walletconnect: proposal has no session topic")

        relays = proposal.get("relays") or []
        relay_protocol = (relays[0].get("protocol") if relays and relays[0] else None) or "irn"
        session = {
            "topic": topic,
            "pairingTopic": proposal.get("pairingTopic"),
            "dapp": review["dapp"],                     # CLAIMED metadata (persisted as claimed)
            "namespaces": namespaces,                   # approved chains/accounts/methods/events
            "activeChainId": settled_chains[0] if settled_chains else None,
            "createdAt": now_ms,
            "expiry": now_ms + ttl * 1000,              # ms epoch
            "relayProtocol": relay_protocol,
            # NO key material. Ever.
        }

        await self._put_session(session)
        if self.relay and callable(member(self.relay, "approveProposal")):
            try:
                await maybe_await(self.relay.approveProposal(proposal, {"namespaces": namespaces, "topic": topic}))
            except Exception:  # noqa: BLE001
                pass  # transport best-effort
        return session

    async def reject_proposal(self, proposal, reason=None):
        proposal = proposal or {}
        if self.relay and callable(member(self.relay, "rejectProposal")):
            try:
                await maybe_await(self.relay.rejectProposal(
                    proposal, reason or {"code": ERR["USER_REJECTED"],
                                         "message": "user rejected the session proposal"}))
            except Exception:  # noqa: BLE001
                pass  # best-effort
        return None

    # -----------------------------------------------------------------------
    # 3. REQUEST ROUTING — namespace enforcement FIRST, then the signing surface.
    # -----------------------------------------------------------------------
    async def handle_request(self, request, ctx=None):
        request = request or {}
        ctx = ctx or {}
        id_ = request.get("id")
        topic = request.get("topic")
        chain_id = request.get("chainId")
        method = request.get("method")
        params = request.get("params")

        # (4) unknown topic / expiry — state-machine guards first.
        session = await self.get_session(topic)
        if not session:
            return rpc_error(id_, ERR["UNKNOWN_TOPIC"], "no settled session for topic: " + str(topic))
        if session.get("expiry") is not None and self._clock_ms() >= session["expiry"]:
            return rpc_error(id_, ERR["SESSION_EXPIRED"], "session expired — reconnect the dApp")

        # eth_sign — REFUSED by default with an explanatory error (strictly more
        # restrictive than the namespace gate; never signs blind).
        if method == "eth_sign" and not self.config["allowEthSign"]:
            return rpc_error(id_, ERR["ETH_SIGN_DISABLED"],
                             "eth_sign is disabled: it blind-signs an arbitrary 32-byte digest "
                             "(a classic drainer vector). Use personal_sign or eth_signTypedData_v4 instead.")

        # NAMESPACE ENFORCEMENT — chainId + method must be inside the approved
        # namespace. No exceptions (read methods are allowed on an approved chain).
        ns = namespace_for_chain(session, chain_id)
        if not ns:
            return rpc_error(id_, ERR["UNAUTHORIZED"],
                             "unauthorized chain (outside the approved session namespace): " + str(chain_id))
        method_allowed = method in (ns.get("methods") or []) or method in READ_METHODS
        if not method_allowed:
            return rpc_error(id_, ERR["UNAUTHORIZED"],
                             "unauthorized method (outside the approved session namespace): " + str(method))

        # READ methods — answered from session state, NO prompt.
        if method == "eth_accounts":
            return rpc_result(id_, addresses_for(session, chain_id))
        if method == "eth_chainId":
            return rpc_result(id_, chain_id_hex(session.get("activeChainId") or chain_id))

        account = account_for(session, chain_id)

        try:
            if method == "eth_sendTransaction":
                return await self._do_eth_send_transaction(id_, session, chain_id, params, account, ctx)
            if method in ("eth_signTypedData", "eth_signTypedData_v4", "eth_signTypedData_v3"):
                return await self._do_sign_typed_data(id_, session, chain_id, method, params, account, ctx)
            if method == "personal_sign":
                return await self._do_personal_sign(id_, session, chain_id, params, account, ctx)
            if method == "wallet_switchEthereumChain":
                return await self._do_switch_chain(id_, session, params, ctx)
            if method == "wallet_addEthereumChain":
                return await self._do_add_chain(id_, session, params, ctx)
            if method == "solana_signTransaction":
                return await self._do_solana(id_, session, chain_id, "signTransaction", params, account, ctx)
            if method == "solana_signAndSendTransaction":
                return await self._do_solana(id_, session, chain_id, "signAndSendTransaction", params, account, ctx)
            if method == "solana_signMessage":
                return await self._do_solana_message(id_, session, chain_id, params, account, ctx)
            return rpc_error(id_, ERR["UNAUTHORIZED"], "unsupported method: " + str(method))
        except _RpcError as e:
            return e.rpc

    # ---- the ONE human + security gate every signing request flows through ---
    # Returns True when cleared to sign; raises _RpcError when rejected/blocked.
    # A DANGER severity forces the extra confirm (fail-closed). SAME gate the
    # user's own signer uses — a dApp can never cause an unprompted or
    # danger-auto-approved signature.
    async def _gate(self, id_, presentation, ctx):
        severity = presentation.get("severity") or "none"
        if severity == "danger":
            confirm = member(ctx, "confirm")
            if not callable(confirm):
                raise _rpc_throw(id_, ERR["BLOCKED"],
                                 "signing blocked: danger-level security warnings require an "
                                 "explicit confirmation handler (fail-closed)")
            okc = await maybe_await(confirm(presentation))
            if not okc:
                raise _rpc_throw(id_, ERR["USER_REJECTED"], "user declined after danger-level warnings")
        # explicit human approval is ALWAYS required — never auto-approve a dApp.
        approve = member(ctx, "approve")
        if not callable(approve):
            raise _rpc_throw(id_, ERR["BLOCKED"],
                             "signing blocked: no approval handler wired — an external dApp "
                             "request can never auto-approve (fail-closed)")
        ok = await maybe_await(approve(presentation))
        if not ok:
            raise _rpc_throw(id_, ERR["USER_REJECTED"], "user rejected the request")
        return True

    def _security_ctx(self, ctx, chain_id):
        base = member(ctx, "security") or {}
        merged = dict(base)
        base_cfg = member(base, "config") or {}
        cfg = dict(base_cfg)
        cfg["denylist"] = list(self.config["denylist"])
        cfg["unlimitedThreshold"] = self.config["unlimitedThreshold"]
        merged["chain"] = evm_chain_name(chain_id)
        merged["config"] = cfg
        return merged

    async def _do_eth_send_transaction(self, id_, session, chain_id, params, account, ctx):
        tx = params[0] if isinstance(params, list) else params
        inspect_tx = dict(tx or {})
        inspect_tx["chain"] = evm_chain_name(chain_id)
        inspection = await maybe_await(
            self.security.inspect_transaction(inspect_tx, self._security_ctx(ctx, chain_id)))
        presentation = {
            "method": "eth_sendTransaction", "topic": session["topic"], "chainId": chain_id,
            "dapp": session.get("dapp"), "account": account,
            "inspection": inspection, "severity": inspection["severity"], "warnings": inspection["warnings"],
        }
        await self._gate(id_, presentation, ctx)
        send = member(self.signer, "ethSendTransaction")
        if not self.signer or not callable(send):
            raise _rpc_throw(id_, ERR["BLOCKED"], "no signer wired for eth_sendTransaction")
        hash_ = await maybe_await(send({"account": account, "chainId": chain_id, "tx": tx, "inspection": inspection}))
        if isinstance(hash_, str):
            result = hash_
        elif isinstance(hash_, dict) and hash_.get("hash"):
            result = hash_["hash"]
        else:
            result = hash_
        return rpc_result(id_, result)

    async def _do_sign_typed_data(self, id_, session, chain_id, method, params, account, ctx):
        raw = params[1] if isinstance(params, list) else params
        decoded = decode_typed_data(raw, self.config, now_sec(self._clock_ms()))
        presentation = {
            "method": method, "topic": session["topic"], "chainId": chain_id,
            "dapp": session.get("dapp"), "account": account,
            "decoded": decoded, "warnings": decoded["warnings"], "severity": decoded["severity"],
        }
        await self._gate(id_, presentation, ctx)
        sign = member(self.signer, "ethSignTypedData")
        if not self.signer or not callable(sign):
            raise _rpc_throw(id_, ERR["BLOCKED"], "no signer wired for " + str(method))
        version = "v3" if method == "eth_signTypedData_v3" else "v4"
        sig = await maybe_await(sign({"account": account, "chainId": chain_id,
                                      "typedData": decoded["typed"], "version": version, "decoded": decoded}))
        return rpc_result(id_, sig)

    async def _do_personal_sign(self, id_, session, chain_id, params, account, ctx):
        decoded = decode_personal_sign(params)
        presentation = {
            "method": "personal_sign", "topic": session["topic"], "chainId": chain_id,
            "dapp": session.get("dapp"), "account": account,
            "decoded": decoded, "warnings": decoded["warnings"], "severity": decoded["severity"],
        }
        await self._gate(id_, presentation, ctx)
        sign = member(self.signer, "personalSign")
        if not self.signer or not callable(sign):
            raise _rpc_throw(id_, ERR["BLOCKED"], "no signer wired for personal_sign")
        sig = await maybe_await(sign({"account": account, "chainId": chain_id,
                                      "message": decoded["messageHex"], "text": decoded["text"]}))
        return rpc_result(id_, sig)

    async def _do_switch_chain(self, id_, session, params, ctx):
        p = params[0] if isinstance(params, list) else params
        hex_id = (p.get("chainId") if isinstance(p, dict) else p) if p else None
        caip2 = "eip155:" + str(int(str(hex_id), 16))
        if not namespace_for_chain(session, caip2) and caip2 not in self.config["walletChains"]:
            return rpc_error(id_, ERR["UNSUPPORTED_CHAIN"],
                             "cannot switch to a chain the wallet does not have: " + caip2)
        await self._gate(id_, {"method": "wallet_switchEthereumChain", "topic": session["topic"],
                               "chainId": caip2, "dapp": session.get("dapp"), "severity": "none"}, ctx)
        session["activeChainId"] = caip2
        await self._put_session(session)
        return rpc_result(id_, None)

    async def _do_add_chain(self, id_, session, params, ctx):
        p = params[0] if isinstance(params, list) else params
        hex_id = p.get("chainId") if isinstance(p, dict) else None
        caip2 = "eip155:" + str(int(str(hex_id), 16))
        if caip2 not in self.config["walletChains"]:
            return rpc_error(id_, ERR["UNSUPPORTED_CHAIN"],
                             "refusing to add a chain the wallet does not have configured: " + caip2)
        await self._gate(id_, {"method": "wallet_addEthereumChain", "topic": session["topic"],
                               "chainId": caip2, "dapp": session.get("dapp"), "severity": "none"}, ctx)
        return rpc_result(id_, None)

    async def _do_solana(self, id_, session, chain_id, kind, params, account, ctx):
        if isinstance(params, dict):
            p = params
        else:
            p = {"transaction": params[0] if isinstance(params, list) else params}
        tx = p.get("transaction") or {}
        instructions = p.get("instructions") or (tx.get("instructions") if isinstance(tx, dict) else None) or []
        inspection = await maybe_await(self.security.inspect_transaction(
            {"chain": "solana", "instructions": instructions}, self._security_ctx(ctx, chain_id)))
        presentation = {
            "method": "solana_" + kind, "topic": session["topic"], "chainId": chain_id,
            "dapp": session.get("dapp"), "account": account,
            "inspection": inspection, "severity": inspection["severity"], "warnings": inspection["warnings"],
        }
        await self._gate(id_, presentation, ctx)
        fn_name = "solanaSignAndSend" if kind == "signAndSendTransaction" else "solanaSignTransaction"
        fn = member(self.signer, fn_name)
        if not self.signer or not callable(fn):
            raise _rpc_throw(id_, ERR["BLOCKED"], "no signer wired for solana_" + kind)
        out = await maybe_await(fn({"account": account, "chainId": chain_id,
                                    "transaction": p.get("transaction"), "inspection": inspection}))
        return rpc_result(id_, out)

    async def _do_solana_message(self, id_, session, chain_id, params, account, ctx):
        if isinstance(params, dict):
            p = params
        else:
            p = {"message": params[0] if isinstance(params, list) else params}
        text = str(p.get("message")) if p.get("message") is not None else ""
        presentation = {
            "method": "solana_signMessage", "topic": session["topic"], "chainId": chain_id,
            "dapp": session.get("dapp"), "account": account,
            "decoded": {"kind": "message", "text": text}, "warnings": [], "severity": "none",
        }
        await self._gate(id_, presentation, ctx)
        fn = member(self.signer, "solanaSignMessage")
        if not self.signer or not callable(fn):
            raise _rpc_throw(id_, ERR["BLOCKED"], "no signer wired for solana_signMessage")
        sig = await maybe_await(fn({"account": account, "chainId": chain_id, "message": p.get("message")}))
        return rpc_result(id_, sig)

    # ---- connect the relay (integration glue; tests call handle_request direct)
    def connect_relay(self, ctx=None):
        if not self.relay or not callable(member(self.relay, "subscribeRequests")):
            return lambda: None

        async def on_request(request):
            response = await self.handle_request(request, ctx or {})
            if self.relay and callable(member(self.relay, "respond")):
                await maybe_await(self.relay.respond(request.get("topic"), response))
            return response

        return self.relay.subscribeRequests(on_request)


def create_wallet_connect(deps: Optional[Dict[str, Any]] = None) -> WalletConnect:
    return WalletConnect(deps)
