"""agent/notify.py — the injectable pop-up surface for agent notifications
(``docs/AGENT-STRATEGIES.md`` §8). Python port; behaviour identical across the
three wallets.

A *notifier* is a small, injectable sink the agent calls to pop a non-blocking,
native message at the user — it NEVER exposes keys, seeds, or LLM credentials and
NEVER blocks the commit path. The Python production surface is a Qt tray
``showMessage`` / non-modal toast (:class:`QtTrayNotifier`); tests inject a fake
(:class:`RecordingNotifier` or any callable via :class:`CallableNotifier`).

The notification *content* is produced by :func:`format_realized` from a
``realized_profit`` event so the exact copy — ``+$45.00 — sold 1.5 SOL → USDC``
with a ``$180.00 → $225.00`` basis→proceeds subtitle — is pinned in one place and
language-identical. Numbers are NEVER fabricated here; the formatter only renders
figures the caller already computed.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional


# --------------------------------------------------------------------------- #
# copy formatting (pinned, language-identical)                                #
# --------------------------------------------------------------------------- #

def _fmt_usd(usd: Any) -> str:
    """``42.1`` -> ``$42.10``; ``None`` -> ``$?``. Two fixed decimals, honest."""
    if usd is None:
        return "$?"
    return "${:,.2f}".format(float(usd))


def _fmt_qty(qty: Any, decimals: Optional[int]) -> str:
    """Render a base-unit integer ``qty`` as a human amount given ``decimals``.

    ``decimals is None`` (unknown) -> show the raw base-unit integer rather than
    invent a scale. Trailing zeros (and a bare dot) are trimmed: ``150000000`` at
    8 decimals -> ``1.5``; ``300000000`` -> ``3``.
    """
    if qty is None:
        return "?"
    try:
        q = int(qty)
    except (TypeError, ValueError):
        return str(qty)
    if decimals is None or decimals < 0:
        return str(q)
    if decimals == 0:
        return str(q)
    neg = q < 0
    q = abs(q)
    scale = 10 ** decimals
    whole, frac = divmod(q, scale)
    frac_str = str(frac).rjust(decimals, "0").rstrip("0")
    out = str(whole) if not frac_str else f"{whole}.{frac_str}"
    return ("-" + out) if neg else out


def format_realized(event: Dict[str, Any], decimals: Optional[int] = None) -> Dict[str, str]:
    """Build the pop-up ``{title, subtitle}`` for a ``realized_profit`` event.

    ``title``    e.g. ``+$45.00 — sold 1.5 SOL → USDC``
    ``subtitle`` e.g. ``$180.00 → $225.00`` (basis → proceeds)

    ``decimals`` falls back to ``event['decimals']`` when not passed; unknown ->
    the sold quantity is shown in raw base units (never a fabricated scale).
    """
    if decimals is None:
        decimals = event.get("decimals")
    realized = event.get("realizedUsd")
    sign = "+" if (realized is not None and float(realized) >= 0) else ""
    qty = _fmt_qty(event.get("soldQty"), decimals)
    asset = event.get("asset") or "?"
    stable = event.get("stable") or "?"
    if realized is None:
        # proceeds-only (unknown basis, requireBasis disabled): never claim a gain
        title = f"sold {qty} {asset} → {stable} for {_fmt_usd(event.get('proceedsUsd'))}"
    else:
        title = f"{sign}{_fmt_usd(realized)} — sold {qty} {asset} → {stable}"
    subtitle = f"{_fmt_usd(event.get('basisUsd'))} → {_fmt_usd(event.get('proceedsUsd'))}"
    return {"title": title, "subtitle": subtitle}


# --------------------------------------------------------------------------- #
# notifier surfaces                                                           #
# --------------------------------------------------------------------------- #

class Notifier:
    """Interface: pop a non-blocking message. ``event`` is the raw payload so a
    surface can render richer UI; ``title``/``subtitle`` are the pinned copy."""

    def notify(self, title: str, subtitle: str = "", event: Optional[Dict[str, Any]] = None) -> None:
        raise NotImplementedError


class CallableNotifier(Notifier):
    """Wrap a plain callable ``fn(title, subtitle, event)`` as a notifier.

    The callable may ignore extra args (we probe its arity defensively) so a
    one-arg ``lambda t: ...`` test double also works. Never raises outward — a
    notification failure must not break the commit path.
    """

    def __init__(self, fn: Callable[..., Any]):
        if not callable(fn):
            raise ValueError("CallableNotifier requires a callable")
        self._fn = fn

    def notify(self, title: str, subtitle: str = "", event: Optional[Dict[str, Any]] = None) -> None:
        try:
            self._fn(title, subtitle, event)
        except TypeError:
            try:
                self._fn(title)
            except Exception:
                pass
        except Exception:
            pass


class RecordingNotifier(Notifier):
    """In-memory sink for tests: appends every pop to :attr:`messages`."""

    def __init__(self):
        self.messages: List[Dict[str, Any]] = []

    def notify(self, title: str, subtitle: str = "", event: Optional[Dict[str, Any]] = None) -> None:
        self.messages.append({"title": title, "subtitle": subtitle, "event": event})


class QtTrayNotifier(Notifier):
    """Production surface: a Qt system-tray ``showMessage`` (non-modal toast).

    PySide6 is imported lazily so importing this module never requires Qt (tests,
    headless CI, the extension/Flutter ports all import ``notify`` freely). If no
    tray icon is supplied and one cannot be created, :meth:`notify` is a safe
    no-op — a missing tray must never crash a trade.
    """

    def __init__(self, tray: Any = None, app_name: str = "Blockle", msec: int = 6000):
        self._tray = tray
        self._app_name = app_name
        self._msec = int(msec)

    def _resolve_tray(self):
        if self._tray is not None:
            return self._tray
        try:  # pragma: no cover - requires a Qt runtime
            from PySide6.QtWidgets import QApplication, QSystemTrayIcon
            if QApplication.instance() is None:
                return None
            self._tray = QSystemTrayIcon()
            self._tray.show()
            return self._tray
        except Exception:  # pragma: no cover
            return None

    def notify(self, title: str, subtitle: str = "", event: Optional[Dict[str, Any]] = None) -> None:
        tray = self._resolve_tray()
        if tray is None:
            return
        try:  # pragma: no cover - requires a Qt runtime
            from PySide6.QtWidgets import QSystemTrayIcon
            tray.showMessage(title, subtitle or "", QSystemTrayIcon.MessageIcon.Information, self._msec)
        except Exception:  # pragma: no cover
            try:
                tray.showMessage(title, subtitle or "")
            except Exception:
                pass


def coerce(notifier: Any) -> Optional[Notifier]:
    """Accept a :class:`Notifier`, a bare callable, or ``None`` and return a
    :class:`Notifier` (or ``None``). Lets a host wire ``notifier=lambda ...``."""
    if notifier is None:
        return None
    if isinstance(notifier, Notifier):
        return notifier
    if callable(notifier):
        return CallableNotifier(notifier)
    raise ValueError("notifier must be a Notifier, a callable, or None")
