"""telemetry.py — ANONYMIZED agent-performance emitter.

Faithful Python port of ``blockle-extension/telemetry.js`` (and the Flutter
``lib/multichain/telemetry.dart``). Feeds the future "house" trading algorithm
with aggregate signal about how the in-wallet agent performs across strategies,
venues, and chains — WITHOUT ever learning who the user is or what they hold.

HARD RULES (enforced in code, not by convention):
  * Never include keys / seeds / LLM creds / raw addresses. The payload is built
    from a strict WHITELIST of coarse fields; a secret/address scrubber runs on
    the finished payload and RAISES (dropping the emit) if anything slips through.
  * Default OFF. Nothing is sent until the user opts in (disclosed via
    ``DISCLOSURE``). Disabled => no network call, ever.
  * Amounts are bucketed, never exact. No wallet/exchange account id is sent —
    only a locally-salted, daily-rotating pseudonymous ``agentId``.

Network failures are swallowed — telemetry must NEVER break or delay a trade.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import time
from typing import Any, Dict, Optional

from ._util import maybe_await

SCHEMA_VERSION = 1
DEFAULT_COLLECTOR = "https://blockle.org/api/agent-telemetry"
DEFAULT_ROTATE_MS = 24 * 60 * 60 * 1000  # pseudonymous id rotates daily
SALT_KEY = "agentTelemetrySalt"
ENABLED_KEY = "agentTelemetryEnabled"

DISCLOSURE = (
    "Anonymous performance telemetry is OFF by default. If you opt in, Blockle "
    "receives coarse, bucketed stats about how the trading agent performs "
    "(strategy, venue, chain, size range, win/loss, P&L %) under a rotating "
    "pseudonymous id. It never includes your keys, seed phrase, LLM credentials, "
    "wallet addresses, or exact amounts. You can turn it off at any time.")


def sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def random_hex(nbytes: int) -> str:
    return os.urandom(nbytes).hex()


# --- bucketing --------------------------------------------------------------
USD_BUCKETS = [
    (0, "0"),
    (10, "<10"),
    (100, "10-100"),
    (1000, "100-1k"),
    (10000, "1k-10k"),
    (100000, "10k-100k"),
    (1000000, "100k-1m"),
]


def bucket_usd(n: Any) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "unknown"
    if not math.isfinite(v) or v < 0:
        return "unknown"
    if v == 0:
        return "0"
    for hi, label in USD_BUCKETS:
        if hi == 0:
            continue
        if v < hi:
            return label
    return "1m+"


def bucket_hold_time(sec: Any) -> str:
    try:
        v = float(sec)
    except (TypeError, ValueError):
        return "unknown"
    if not math.isfinite(v) or v < 0:
        return "unknown"
    if v < 60:
        return "<1m"
    if v < 3600:
        return "1m-1h"
    if v < 86400:
        return "1h-1d"
    if v < 604800:
        return "1d-1w"
    return "1w+"


def _round(n: Any, dp: int):
    try:
        v = float(n)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    f = math.pow(10, dp)
    # Math.round semantics (half up)
    r = math.floor(v * f + 0.5) / f
    return int(r) if dp == 0 else r


# --- label sanitizing -------------------------------------------------------
ADDRESS_LIKE = [
    re.compile(r"0x[0-9a-fA-F]{40}"),
    re.compile(r"[0-9a-fA-F]{40,}"),
    re.compile(r"\b(bc1|ltc1|tb1|block1|doge1)[0-9ac-hj-np-z]{8,}", re.I),
    re.compile(r"\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b"),
    re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b"),
]


def sanitize_label(s: Any, max_len: int = 48) -> Optional[str]:
    if s is None:
        return None
    v = re.sub(r"[ \-]", "", str(s)).strip()
    if not v:
        return None
    for rx in ADDRESS_LIKE:
        if rx.search(v):
            return "redacted"
    return v[:max_len or 48]


# --- secret / address scrubber (defense in depth) ---------------------------
SECRET_PATTERNS = [
    re.compile(r"0x[0-9a-fA-F]{40}"),
    re.compile(r"[0-9a-fA-F]{40,}"),
    re.compile(r"\b(bc1|ltc1|tb1|block1|doge1)[0-9ac-hj-np-z]{8,}", re.I),
    re.compile(r"\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b"),
    re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b"),
    re.compile(r"sk-[a-zA-Z0-9]{8,}"),
    re.compile(r"\b(api[_-]?key|secret|priv(ate)?[_-]?key|mnemonic|seed[_-]?phrase|passphrase|password)\b", re.I),
]
_DISALLOWED_KEY = re.compile(
    r"^(key|seed|secret|apikey|api_key|privkey|private_key|mnemonic|address|addr|from|to)$", re.I)


def assert_no_secrets(obj: Any, path: str = "payload") -> None:
    if obj is None:
        return
    if isinstance(obj, str):
        for rx in SECRET_PATTERNS:
            if rx.search(obj):
                raise ValueError("telemetry: refused — secret/address-like value at " + path)
        return
    if isinstance(obj, dict):
        for k in obj.keys():
            if _DISALLOWED_KEY.match(str(k)):
                raise ValueError('telemetry: refused — disallowed field name "' + str(k) + '" at ' + path)
            assert_no_secrets(obj[k], path + "." + str(k))
        return
    if isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            assert_no_secrets(v, path + "." + str(i))


# --- asset-class classifier (coarse) ---------------------------------------
STABLES = {"USDC", "USDT", "DAI", "USD", "USDP", "TUSD", "PYUSD", "FDUSD"}
MAJORS = {"BTC", "ETH", "SOL", "LTC", "DOGE", "BNB", "XRP"}


def classify_asset(symbol: Any) -> str:
    s = sanitize_label(symbol, 16)
    if not s or s == "redacted":
        return "unknown"
    up = s.upper()
    if up == "BLOCK":
        return "block"
    if up in STABLES:
        return "stablecoin"
    if up in MAJORS:
        return "crypto-major"
    return "crypto-other"


def sanitize_pair(pair: Any) -> Optional[str]:
    s = sanitize_label(pair, 24)
    if not s or s == "redacted":
        return "redacted" if s == "redacted" else None
    parts = [re.sub(r"[^A-Za-z0-9]", "", p).upper() for p in re.split(r"[\/\-:_]", s)]
    parts = [p for p in parts if p]
    if not parts:
        return None
    return "/".join(parts[:2])


def _norm_result(r: Any) -> str:
    s = "" if r is None else str(r).lower()
    if s in ("win", "won", "profit"):
        return "win"
    if s in ("loss", "lost", "lose"):
        return "loss"
    if s in ("flat", "breakeven", "even"):
        return "flat"
    return "unknown"


def _norm_side(side: Any) -> Optional[str]:
    s = "" if side is None else str(side).lower()
    if s in ("buy", "long", "bid"):
        return "buy"
    if s in ("sell", "short", "ask"):
        return "sell"
    return None


class Telemetry:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self.enabled = opts.get("enabled") is True   # DEFAULT OFF
        self.collector_url = opts.get("collectorUrl") or DEFAULT_COLLECTOR
        self.store = opts.get("store")                # {get,set} shim (sync or async)
        clock = opts.get("clock")
        self.clock = clock if callable(clock) else (lambda: int(time.time() * 1000))
        self.rotate_ms = opts.get("rotateMs") or DEFAULT_ROTATE_MS
        self.fetch_impl = opts.get("fetchImpl") if callable(opts.get("fetchImpl")) else None
        self.sink = opts.get("sink") if callable(opts.get("sink")) else None
        self._salt = opts.get("salt")

    def is_enabled(self) -> bool:
        return self.enabled is True

    async def set_enabled(self, on: Any) -> bool:
        self.enabled = on is True
        if self.store:
            try:
                await maybe_await(self.store.set({ENABLED_KEY: self.enabled}))
            except Exception:
                pass
        return self.enabled

    async def load_enabled(self) -> bool:
        if not self.store:
            return self.enabled
        try:
            got = await maybe_await(self.store.get([ENABLED_KEY]))
            if got and isinstance(got.get(ENABLED_KEY), bool):
                self.enabled = got[ENABLED_KEY]
        except Exception:
            pass
        return self.enabled

    async def _get_salt(self) -> str:
        if self._salt:
            return self._salt
        if self.store:
            try:
                got = await maybe_await(self.store.get([SALT_KEY]))
                if got and got.get(SALT_KEY):
                    self._salt = got[SALT_KEY]
                    return self._salt
            except Exception:
                pass
        self._salt = random_hex(16)
        if self.store:
            try:
                await maybe_await(self.store.set({SALT_KEY: self._salt}))
            except Exception:
                pass
        return self._salt

    async def agent_id(self, ts: Optional[int] = None) -> str:
        salt = await self._get_salt()
        t = self.clock() if ts is None else ts
        bucket = math.floor(t / self.rotate_ms)
        return sha256hex(salt + ":" + str(bucket))[:16]

    async def build_payload(self, ev: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        ev = ev or {}
        ts = int(ev["ts"]) if ev.get("ts") is not None else self.clock()

        size_usd = ev.get("sizeUsd") if ev.get("sizeUsd") is not None else ev.get("notionalUsd")
        hold_sec = ev.get("holdTimeSec")
        if hold_sec is None and ev.get("holdTimeMs") is not None:
            hold_sec = float(ev["holdTimeMs"]) / 1000
        if hold_sec is None and ev.get("openedAt") is not None and ev.get("closedAt") is not None:
            hold_sec = (float(ev["closedAt"]) - float(ev["openedAt"])) / 1000

        pair = sanitize_pair(ev.get("pair"))
        base_symbol = pair.split("/")[0] if pair else ev.get("asset")
        asset_class = sanitize_label(ev.get("assetClass"), 24) or classify_asset(base_symbol)

        payload = {
            "v": SCHEMA_VERSION,
            "agentId": await self.agent_id(ts),
            "ts": math.floor(ts / 60000) * 60000,
            "strategy": sanitize_label(ev.get("strategy"), 48) or "unspecified",
            "venue": sanitize_label(ev.get("venue"), 32) or "unknown",
            "chain": sanitize_label(ev.get("chain"), 24) or "unknown",
            "assetClass": asset_class,
            "pair": pair or None,
            "side": _norm_side(ev.get("side")),
            "sizeBucket": bucket_usd(size_usd),
            "holdBucket": bucket_hold_time(hold_sec),
            "holdTimeSec": _round(hold_sec, 0) if hold_sec is not None else None,
            "result": _norm_result(ev.get("result") if ev.get("result") is not None else ev.get("win")),
            "pnlPct": _round(ev.get("pnlPct"), 2) if ev.get("pnlPct") is not None else None,
            "slippagePct": _round(ev.get("slippagePct"), 3) if ev.get("slippagePct") is not None else None,
            "feeBucket": bucket_usd(ev.get("feePaidUsd")) if ev.get("feePaidUsd") is not None else "unknown",
            "feePct": _round(ev.get("feePct"), 3) if ev.get("feePct") is not None else None,
            "intent": sanitize_label(ev.get("intent"), 32) or None,
            "outcome": sanitize_label(ev.get("outcome"), 32) or None,
            "outcomeMetIntent": ev.get("metIntent") if isinstance(ev.get("metIntent"), bool) else None,
        }

        if payload["result"] == "unknown" and isinstance(ev.get("win"), bool):
            payload["result"] = "win" if ev["win"] else "loss"

        return payload

    async def emit(self, ev: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.enabled:
            return {"emitted": False, "reason": "disabled"}

        try:
            payload = await self.build_payload(ev)
            assert_no_secrets(payload)
        except Exception as e:
            return {"emitted": False, "reason": "scrubbed", "error": str(e)}

        if self.sink:
            try:
                self.sink(payload)
            except Exception:
                pass

        if not self.fetch_impl:
            return {"emitted": False, "reason": "no-transport", "payload": payload}

        try:
            import json as _json
            await maybe_await(self.fetch_impl(self.collector_url, {
                "method": "POST",
                "headers": {"content-type": "application/json"},
                "body": _json.dumps(payload),
                "keepalive": True,
                "credentials": "omit",
                "mode": "cors",
            }))
            return {"emitted": True, "payload": payload}
        except Exception as e:
            return {"emitted": False, "reason": "network", "error": str(e), "payload": payload}


def create(opts: Optional[Dict[str, Any]] = None) -> Telemetry:
    return Telemetry(opts)
