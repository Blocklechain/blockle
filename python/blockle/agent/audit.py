"""agent/audit.py — append-only, local, tamper-evident action log for the agent.

Faithful Python port of ``blockle-extension/agent/audit.js``. Records every
prompt, tool call (args + result + decision), confirmation, cap check, kill, and
broadcast txid. The user can review and export it; it is the accountability
backstop. Nothing here is ever sent to a Blockle server.

Tamper-evidence: each entry is chained with a SHA-256 head hash

    head_n = sha256(head_{n-1} + canonical(entry_n))

so any later edit/removal/reorder of a past entry breaks :meth:`verify`. The log
is persisted locally via the injected ``store`` (or in-memory).
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await


def _canonical(entry: Any) -> str:
    """Stable JSON: keys sorted recursively, deterministic separators.

    ``default=str`` turns anything non-JSON-native (e.g. large ints kept as
    ints, or unexpected objects) into a string, matching the JS bigint->string
    normalization closely enough to keep the chain deterministic in Python.
    """
    return json.dumps(entry, sort_keys=True, separators=(",", ":"), default=str)


def sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class Audit:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self.entries: List[Dict[str, Any]] = []
        self.head = "genesis"
        self.seq = 0
        self.store = opts.get("store")
        self.store_key = opts.get("key") or "agentAuditLog"
        sink = opts.get("sink")
        self.sink = sink if callable(sink) else None
        self.max = opts.get("max") or 2000

    async def record(self, data: Dict[str, Any]) -> Dict[str, Any]:
        entry: Dict[str, Any] = {"seq": self.seq, "ts": int(time.time() * 1000)}
        self.seq += 1
        entry.update(data or {})
        self.head = sha256hex(self.head + _canonical(entry))
        entry["hash"] = self.head
        self.entries.append(entry)
        if len(self.entries) > self.max:
            del self.entries[0:len(self.entries) - self.max]
        if self.sink:
            try:
                self.sink(entry)
            except Exception:
                pass
        if self.store:
            try:
                await maybe_await(self.store.set({self.store_key: {"head": self.head, "entries": self.entries}}))
            except Exception:
                pass
        return entry

    def verify(self) -> Dict[str, Any]:
        head = "genesis"
        for e in self.entries:
            rest = {k: v for k, v in e.items() if k != "hash"}
            head = sha256hex(head + _canonical(rest))
            if head != e.get("hash"):
                return {"ok": False, "at": e.get("seq")}
        return {"ok": head == self.head, "head": head}

    def list(self) -> List[Dict[str, Any]]:
        return list(self.entries)

    def export(self) -> str:
        return json.dumps({"head": self.head, "entries": self.entries}, indent=2, default=str)

    def clear(self) -> None:
        self.entries = []
        self.head = "genesis"
        self.seq = 0


def create(opts: Optional[Dict[str, Any]] = None) -> Audit:
    return Audit(opts)
