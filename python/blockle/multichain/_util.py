"""Tiny internal helpers shared by the multichain + agent Python modules.

Kept dependency-free (stdlib only). These mirror conveniences the extension got
for free in JavaScript (awaiting a value that may or may not be a Promise,
member access that works on both plain objects and maps).
"""

from __future__ import annotations

import inspect
import math
from typing import Any


async def maybe_await(value: Any) -> Any:
    """Await ``value`` if it is awaitable, otherwise return it unchanged.

    The extension's callbacks (confirm, provider.turn, exchange.quote, tool
    handlers) are all Promise-returning; the Python mirror accepts either a
    coroutine/awaitable or a plain return value so hosts can wire sync *or*
    async callables.
    """
    if inspect.isawaitable(value):
        return await value
    return value


def member(obj: Any, name: str):
    """Fetch ``name`` from a dict-like OR an object, mirroring ``obj.name`` in JS.

    Returns ``None`` when absent (never raises), matching JS property access on
    a missing key.
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def js_round(x: float) -> int:
    """``Math.round`` semantics: round-half-up toward +inf (not banker's)."""
    return math.floor(float(x) + 0.5)


def is_finite(x: Any) -> bool:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)
