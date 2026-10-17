"""blockle.qtwalletui — the native Blockle Wallet / Portfolio Qt surfaces (PySide6).

The Python/Qt sibling of the extension (JS) and app (Dart) wallet UIs, matching the
shared visual contract ``docs/design/wallet/index.html`` (the SAME color ramp, type
scale, spacing + radius as ``docs/design/bots`` so all three wallets and the Bots
cockpit read as ONE product; theme-aware light + dark, accessible, responsive).

HARD RULE (identical to the Bots platform): this module RENDERS and DISPATCHES only.
Every value on every surface comes from the REAL engine modules already in this
wallet —

  * :mod:`blockle.multichain.portfolio`     — net worth + by-chain + holdings + sparkline
  * :mod:`blockle.multichain.activity`       — aggregated cross-chain feed (+ security labels)
  * :mod:`blockle.multichain.nft`            — NFT inventory + build_nft_transfer
  * :mod:`blockle.multichain.security`       — inspect_transaction / approval manager / revoke
  * :mod:`blockle.multichain.addressbook`    — contacts + resolve_name (ENS/SNS/book)
  * :mod:`blockle.multichain.walletconnect`  — WalletConnect v2 session + request state machine

There is NO mock/placeholder data and NO new money path. A value that cannot be
sourced is shown as "unknown"/unavailable with the engine's audited note — never
fabricated. The UI never signs or broadcasts on its own: every send/sign is decoded
by ``security.inspect_transaction`` and routed through the shared pre-sign confirm
sheet (a DANGER forces the explicit "I understand the risk" confirm, fail-closed),
then handed to the EXISTING signer on the shared :class:`MultiChainController`.

Five surfaces, one widget (:class:`WalletPanel`):
  * PORTFOLIO — net-worth hero + 30-point sparkline (from ``portfolio()`` + the daily
    snapshot history), a by-chain stacked bar + legend, the holdings list with unpriced
    tokens shown-not-counted; Send / Receive / Swap.
  * ACTIVITY  — the aggregated cross-chain feed from ``activity()`` with the security
    decoder labels + flagged-counterparty pills inline.
  * NFTS      — gallery from ``nfts()`` (spam flag, metadata-unavailable tile, an
    operator-approval badge that opens revoke via the approval manager); send routes
    through the security gate.
  * CONNECT   — WalletConnect sessions + paste-URI connect; the proposal review sheet
    and the per-request SIGNATURE/SEND approval sheet (the security confirm sheet)
    driven by the WalletConnect core. A DANGER forces the explicit confirm; nothing
    auto-signs.
  * ADDRESS BOOK — contacts with ENS/SNS/saved badges; Send resolves the name, SHOWS
    the resolved address for confirmation, and inspects the RESOLVED address.

GUI-THREAD RULE (same as qtbots): the async engine coroutines run on the shared
AgentLoop WORKER thread, so a future's done-callback fires OFF the GUI thread. Every
such callback is hopped back onto the GUI thread via a queued signal BEFORE it ever
touches a QWidget — see :class:`WalletController.run_async` and the sheet bridges.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QFrame, QGridLayout, QHBoxLayout, QLabel,
    QLineEdit, QMessageBox, QPushButton, QScrollArea, QSizePolicy, QVBoxLayout,
    QWidget,
)

from . import qtbots as _qb
from .multichain import activity as activity_mod
from .multichain import addressbook as book_mod
from .multichain import logos as logos_mod
from .multichain import nft as nft_mod
from .multichain import nft_indexer as nft_indexer_mod
from .multichain import portfolio as portfolio_mod
from .multichain import security as security_mod
from .multichain import walletconnect as wc_mod
from .multichain import wc_relay as wc_relay_mod
from .multichain.chains import evm as evm_mod

# Shared helpers from the Bots panel — ONE source of truth for the painter colors,
# the money formatter, and the filled-area sparkline, so the two native panels are
# pixel-consistent.
Sparkline = _qb.Sparkline
_qc = _qb._qc
_ghost = _qb._ghost
MONO = _qb.MONO
money = _qb.money
plain_money = _qb.plain_money


# =========================================================================== #
# DESIGN TOKENS — ported verbatim from docs/design/wallet/index.html :root.    #
# The core ramp is identical to qtbots (one product); the k-a..k-d categorical #
# hues drive the by-chain bar + legend + token avatars.                        #
# =========================================================================== #
TOKENS_DARK: Dict[str, str] = {
    "ground": "#0b0f15", "surface": "#141b24", "elevated": "#1d2630",
    "line": "#27333f", "line_soft": "#1f2932",
    "ink": "#e8edf3", "ink_muted": "#8795a4", "ink_faint": "#5d6b79",
    "accent": "#4c8dff", "accent_dim": "#2b4a86",
    "gain": "#2fd39b", "loss": "#f0536a", "warn": "#f0a732",
    "k_a": "#4c8dff", "k_b": "#f0a732", "k_c": "#2fd39b", "k_d": "#b98cff",
}
TOKENS_LIGHT: Dict[str, str] = {
    "ground": "#f3f5f8", "surface": "#ffffff", "elevated": "#ffffff",
    "line": "#dde3ea", "line_soft": "#e8edf2",
    "ink": "#11212f", "ink_muted": "#5a6b7b", "ink_faint": "#93a1af",
    "accent": "#2f6ff0", "accent_dim": "#a9c6ff",
    "gain": "#0c9e6f", "loss": "#d83a52", "warn": "#c6830f",
    "k_a": "#2f6ff0", "k_b": "#c6830f", "k_c": "#0c9e6f", "k_d": "#8257d6",
}
RADIUS, RADIUS_SM = 14, 9

# categorical chain hues, cycled for the by-chain bar (k-a..k-d, design §By chain)
CHAIN_KEYS = ["k_a", "k_c", "k_d", "k_b"]


def build_qss(tok: Dict[str, str]) -> str:
    """Generate the wallet panel stylesheet from a token set (light or dark)."""
    accent_ghost = _ghost(tok["accent"], 0x1f)
    gain_ghost = _ghost(tok["gain"], 0x1f)
    loss_ghost = _ghost(tok["loss"], 0x2a)
    warn_ghost = _ghost(tok["warn"], 0x22)
    return f"""
    #walletRoot {{ background: {tok['ground']}; color: {tok['ink']};
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }}
    #walletRoot QLabel {{ color: {tok['ink']}; background: transparent; }}
    #walletRoot QScrollArea, #walletRoot QScrollArea > QWidget > QWidget {{
        background: transparent; border: 0; }}

    QLabel#eyebrow {{ color: {tok['ink_faint']}; font-size: 10px; font-weight: 700;
        letter-spacing: 2px; }}
    QLabel#heroBig {{ font-size: 44px; font-weight: 800; letter-spacing: -1px; }}
    QLabel#sub {{ color: {tok['ink_muted']}; font-size: 12px; }}
    QLabel#mono {{ font-family: {MONO}; }}
    QLabel#pos {{ color: {tok['gain']}; }}
    QLabel#neg {{ color: {tok['loss']}; }}
    QLabel#faint {{ color: {tok['ink_faint']}; font-size: 12px; }}
    QLabel#h2 {{ font-size: 16px; font-weight: 800; letter-spacing: -0.3px; }}

    QFrame#card {{ background: {tok['surface']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS}px; }}
    QFrame#row {{ background: transparent; border: 0;
        border-bottom: 1px solid {tok['line_soft']}; }}

    QLabel#count {{ color: {tok['ink_faint']}; font-family: {MONO}; font-size: 11px;
        border: 1px solid {tok['line']}; background: {tok['elevated']};
        border-radius: 10px; padding: 2px 9px; }}
    QLabel#chip {{ border: 1px solid {tok['line']}; color: {tok['ink_muted']};
        background: {tok['elevated']}; border-radius: 7px; padding: 2px 8px;
        font-size: 10px; font-weight: 700; }}
    QLabel#mchip {{ border: 1px solid {tok['line']}; color: {tok['ink_muted']};
        background: {tok['elevated']}; border-radius: 6px; padding: 2px 7px;
        font-family: {MONO}; font-size: 10px; }}
    QLabel#chipPos {{ color: {tok['gain']}; background: {gain_ghost}; border-radius: 7px;
        padding: 3px 8px; font-family: {MONO}; font-size: 12px; font-weight: 700; }}
    QLabel#chipNeg {{ color: {tok['loss']}; background: {loss_ghost}; border-radius: 7px;
        padding: 3px 8px; font-family: {MONO}; font-size: 12px; font-weight: 700; }}
    QLabel#tagUnpriced {{ color: {tok['ink_faint']}; border: 1px solid {tok['line']};
        border-radius: 6px; padding: 2px 7px; font-size: 10px; font-weight: 700; }}
    QLabel#flag {{ color: {tok['loss']}; background: {loss_ghost}; border-radius: 6px;
        padding: 2px 7px; font-size: 10px; font-weight: 800; }}
    QLabel#spam {{ color: {tok['warn']}; background: {warn_ghost}; border-radius: 6px;
        padding: 2px 7px; font-size: 10px; font-weight: 800; }}
    QLabel#approval {{ color: {tok['loss']}; background: {loss_ghost}; border-radius: 6px;
        padding: 2px 7px; font-size: 10px; font-weight: 800; }}

    QFrame#nft {{ background: {tok['surface']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS}px; }}
    QFrame#nft:hover {{ border: 1px solid {tok['accent_dim']}; }}
    QLabel#nftArt {{ border-radius: {RADIUS}px; }}
    QLabel#unav {{ color: {tok['ink_faint']}; background: {tok['elevated']};
        border: 1px dashed {tok['line']}; border-radius: {RADIUS_SM}px; font-size: 12px; }}

    #walletRoot QPushButton {{ background: {tok['elevated']}; border: 1px solid {tok['line']};
        border-radius: 10px; padding: 9px 15px; font-weight: 700; color: {tok['ink']}; }}
    #walletRoot QPushButton:hover {{ border: 1px solid {tok['accent_dim']}; }}
    QPushButton#primary {{ background: {tok['accent']}; border: 1px solid {tok['accent']};
        color: white; }}
    QPushButton#danger {{ background: {tok['loss']}; border: 1px solid {tok['loss']};
        color: white; }}
    QPushButton#ghostIcon {{ background: {tok['surface']}; border: 1px solid {tok['line']};
        border-radius: 10px; padding: 7px 10px; color: {tok['ink_muted']}; }}

    #walletRoot QLineEdit {{ background: {tok['elevated']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS_SM}px; padding: 10px 12px; color: {tok['ink']};
        font-family: {MONO}; selection-background-color: {tok['accent']}; }}
    #walletRoot QLineEdit:focus {{ border: 1px solid {tok['accent']}; }}
    #walletRoot QComboBox {{ background: {tok['elevated']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS_SM}px; padding: 8px 12px; color: {tok['ink']}; }}

    QFrame#warnDanger {{ background: {loss_ghost}; border: 1px solid {tok['loss']};
        border-radius: {RADIUS_SM}px; }}
    QFrame#warnWarn {{ background: {warn_ghost}; border: 1px solid {tok['warn']};
        border-radius: {RADIUS_SM}px; }}
    QFrame#warnInfo {{ background: {accent_ghost}; border: 1px solid {tok['accent_dim']};
        border-radius: {RADIUS_SM}px; }}
    QFrame#resolved {{ background: {accent_ghost}; border: 1px solid {tok['accent_dim']};
        border-radius: {RADIUS_SM}px; }}
    QFrame#preview {{ border: 1px solid {tok['line']}; border-radius: {RADIUS_SM}px; }}
    QLabel#pvKey {{ color: {tok['ink_muted']}; font-size: 13px; }}
    QLabel#pvVal {{ font-family: {MONO}; font-size: 13px; }}
    QLabel#checks {{ color: {tok['ink_faint']}; font-size: 11px; }}

    #walletRoot QTabWidget::pane {{ border: 0; }}
    #walletRoot QTabBar::tab {{ background: transparent; color: {tok['ink_muted']};
        padding: 9px 15px; font-weight: 700; border: 0; }}
    #walletRoot QTabBar::tab:selected {{ color: {tok['ink']};
        border-bottom: 2px solid {tok['accent']}; }}

    QScrollBar:vertical {{ background: transparent; width: 10px; }}
    QScrollBar::handle:vertical {{ background: {tok['line']}; border-radius: 5px; min-height: 30px; }}
    QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
    """


# =========================================================================== #
# small formatting helpers                                                     #
# =========================================================================== #
def shorten(a: Optional[str]) -> str:
    s = str(a or "")
    if len(s) <= 14:
        return s
    return s[:8] + "…" + s[-4:]


def _amt_str(amount_base: Any, decimals: Any) -> str:
    try:
        base = int(str(amount_base))
        dec = int(decimals or 0)
    except (TypeError, ValueError):
        return str(amount_base)
    if dec <= 0:
        return f"{base:,}"
    whole, frac = divmod(base, 10 ** dec)
    frac_s = str(frac).rjust(dec, "0").rstrip("0")
    return f"{whole:,}" + (f".{frac_s[:6]}" if frac_s else "")


def _chain_hue(tok: Dict[str, str], idx: int) -> str:
    return tok[CHAIN_KEYS[idx % len(CHAIN_KEYS)]]


def _svg_pixmap(svg: str, size: int):
    """Render an inline-SVG string to a crisp QPixmap at ``size`` px. Returns
    ``None`` if Qt's SVG module is unavailable (caller keeps its text fallback)."""
    try:
        from PySide6.QtCore import QByteArray
        from PySide6.QtGui import QPainter, QPixmap
        from PySide6.QtSvg import QSvgRenderer
    except Exception:  # pragma: no cover - QtSvg always present in our deps
        return None
    try:
        renderer = QSvgRenderer(QByteArray(svg.encode("utf-8")))
        pm = QPixmap(size, size)
        pm.fill(Qt.transparent)
        p = QPainter(pm)
        renderer.render(p)
        p.end()
        return pm
    except Exception:  # pragma: no cover - defensive
        return None


def set_asset_icon(label: QLabel, asset: Any, size: int = 32) -> bool:
    """Paint the correct per-chain / per-token icon onto ``label`` via the
    shared :mod:`blockle.multichain.logos` resolver — the bundled brand SVG for
    a native chain coin, the token ``logoURI`` where present, else a colored
    monogram. OFFLINE for chains (inline SVG, no fetch); never a broken icon.
    Returns ``True`` when a pixmap was set (so the caller can drop its text
    avatar), ``False`` to fall back to text."""
    try:
        res = logos_mod.resolve(asset)
    except Exception:  # pragma: no cover - defensive
        return False
    # For a remote token logo we render the clean monogram fallback immediately
    # (the desktop list stays offline); chains + monograms are inline SVG.
    svg = res.get("svg") or (res.get("fallback") or {}).get("svg")
    if not svg:
        return False
    pm = _svg_pixmap(svg, size)
    if pm is None:
        return False
    label.setPixmap(pm)
    label.setText("")
    return True


def to_base_units(display: Any, decimals: Any) -> int:
    """Convert a human-entered display amount (e.g. ``"1.5"``) to an EXACT
    base-unit integer using the asset's decimals — base-unit exact, no float.
    Used to build a well-formed tx so the security preview shows the REAL
    amount (never a misleading 0). Raises ``ValueError`` on a malformed amount."""
    try:
        dec = int(decimals or 0)
    except (TypeError, ValueError):
        dec = 0
    s = str(display or "").strip().replace(",", "")
    if not s:
        return 0
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    if "." in s:
        whole, frac = s.split(".", 1)
    else:
        whole, frac = s, ""
    if not (whole + frac).isdigit():
        raise ValueError(f"malformed amount: {display!r}")
    frac = (frac + "0" * dec)[:dec] if dec > 0 else ""
    val = int(whole or "0") * (10 ** dec) + (int(frac) if frac else 0)
    return -val if neg else val


# =========================================================================== #
# ChainBar — the by-chain stacked bar + legend (design §By chain).             #
# =========================================================================== #
class ChainBar(QWidget):
    def __init__(self, tokens: Dict[str, str]):
        super().__init__()
        self.tok = tokens
        self._rows: List[Dict[str, Any]] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(12)
        self.bar = QFrame()
        self.bar.setFixedHeight(12)
        self.bar_lay = QHBoxLayout(self.bar)
        self.bar_lay.setContentsMargins(0, 0, 0, 0)
        self.bar_lay.setSpacing(2)
        lay.addWidget(self.bar)
        self.legend = QVBoxLayout()
        self.legend.setSpacing(9)
        lay.addLayout(self.legend)

    def set_tokens(self, tokens: Dict[str, str]):
        self.tok = tokens
        self._render()

    def set_rows(self, rows: List[Dict[str, Any]]):
        # rows: [{chain, label, usd, pct}]
        self._rows = list(rows or [])
        self._render()

    def _clear(self):
        for lay in (self.bar_lay, self.legend):
            while lay.count():
                it = lay.takeAt(0)
                w = it.widget()
                if w:
                    w.deleteLater()

    def _render(self):
        self._clear()
        tok = self.tok
        if not self._rows:
            seg = QFrame()
            seg.setStyleSheet(f"background:{tok['line_soft']};border-radius:6px;")
            self.bar_lay.addWidget(seg, 1)
            empty = QLabel("No priced holdings yet.")
            empty.setObjectName("faint")
            self.legend.addWidget(empty)
            return
        for i, r in enumerate(self._rows):
            hue = _chain_hue(tok, i)
            pct = max(0.0, float(r.get("pct") or 0))
            seg = QFrame()
            seg.setStyleSheet(f"background:{hue};border-radius:3px;")
            self.bar_lay.addWidget(seg, max(1, int(round(pct * 100))))
            row = QWidget()
            rl = QHBoxLayout(row)
            rl.setContentsMargins(0, 0, 0, 0)
            rl.setSpacing(10)
            dot = QLabel()
            dot.setFixedSize(9, 9)
            dot.setStyleSheet(f"background:{hue};border-radius:3px;")
            rl.addWidget(dot)
            name = QLabel(str(r.get("label") or r.get("chain")))
            name.setStyleSheet("font-size:13px;")
            rl.addWidget(name)
            rl.addStretch(1)
            usd = QLabel(plain_money(r.get("usd")))
            usd.setObjectName("mono")
            usd.setStyleSheet(f"font-family:{MONO};font-size:13px;")
            rl.addWidget(usd)
            pc = QLabel(f"{pct:.1f}%")
            pc.setObjectName("faint")
            pc.setStyleSheet(f"color:{tok['ink_faint']};font-family:{MONO};"
                             f"font-size:12px;min-width:52px;")
            pc.setAlignment(Qt.AlignRight)
            rl.addWidget(pc)
            self.legend.addWidget(row)


# =========================================================================== #
# WalletController — owns the REAL engine wiring + the GUI-thread async bridge. #
# Built on the shared MultiChainController (vault, registry, chain ctx, the one #
# AgentLoop worker thread, the existing signer). Read-only everywhere except an #
# explicit, inspected + gated send/sign that reuses the EXISTING signer.        #
# =========================================================================== #
class WalletController(QObject):
    # async run_async done/error, marshalled onto the GUI thread. The coroutines
    # run on the AgentLoop WORKER thread, so a future's done-callback fires OFF
    # the GUI thread; these queued signals hop the callback back onto the GUI
    # thread before it ever touches a QWidget.
    _async_done = Signal(object, object)   # (callback, result)
    _async_error = Signal(object, object)  # (callback, exc)
    # the per-request dApp approval + danger confirm bridges (worker -> GUI). The
    # resolver is a plain callable the GUI slot invokes with the user's decision;
    # the awaiting coroutine's future is set via loop.call_soon_threadsafe.
    approval_requested = Signal(object, object)  # (presentation, resolver)
    danger_requested = Signal(object, object)    # (presentation, resolver)
    proposal_requested = Signal(object, object)  # (review, resolver) — dApp session proposal

    def __init__(self, ctrl: Any):
        super().__init__()
        self.ctrl = ctrl
        self._wc: Optional[wc_mod.WalletConnect] = None
        self._relay_wired = False
        self._snap_key = "portfolioSnapshots"
        self._async_done.connect(self._invoke_cb)
        self._async_error.connect(self._invoke_cb)

    @staticmethod
    def _invoke_cb(callback, arg):
        if callback is not None:
            callback(arg)

    # ---- lifecycle ----------------------------------------------------------
    def is_unlocked(self) -> bool:
        try:
            return bool(self.ctrl.is_unlocked())
        except Exception:
            return False

    def ready(self) -> bool:
        """True once the vault is unlocked and the shared async loop + store are
        built — the precondition for calling any async engine coroutine."""
        return self.loop is not None and getattr(self.ctrl, "_store", None) is not None

    @property
    def loop(self):
        return self.ctrl.loop

    def accounts_list(self) -> List[Dict[str, Any]]:
        """``[{chain, address}]`` for every derived account — the REAL per-chain
        addresses the vault controls (empty when locked). Never fabricated."""
        out: List[Dict[str, Any]] = []
        accts = getattr(self.ctrl, "accounts", None) or {}
        order = []
        try:
            order = self.ctrl.ordered_chains()
        except Exception:
            order = list(accts.keys())
        for cid in order:
            acc = accts.get(cid)
            addr = getattr(acc, "address", None) if acc is not None else None
            if addr:
                out.append({"chain": cid, "address": addr})
        return out

    def chain_label(self, cid: str) -> str:
        try:
            return self.ctrl.chain_label(cid)
        except Exception:
            return cid

    # ---- live USD marks: the SAME non-custodial market source the bots use ---
    def _marks(self, symbols: Any) -> Dict[str, float]:
        out: Dict[str, float] = {}
        syms = [str(s) for s in (symbols or [])]
        ex = getattr(self.ctrl, "exchange", None)
        markets = None
        if ex is not None:
            try:
                markets = ex.get_markets()
            except Exception:
                markets = None
        if markets:
            for sym in syms:
                try:
                    mark = _qb.resolve_market_mark(sym, markets, ex.get_book, ex.get_trades)
                except Exception:
                    mark = None
                if mark is not None and mark > 0:
                    out[sym] = mark
        price_map: Dict[str, Any] = {}
        try:
            price_map = self.ctrl.vault.price_usd_map() or {}
        except Exception:
            price_map = {}
        if price_map:
            upper = {str(k).upper(): v for k, v in price_map.items()}
            for sym in syms:
                if sym in out:
                    continue
                v = upper.get(str(sym).upper())
                try:
                    if v is not None and float(v) > 0:
                        out[sym] = float(v)
                except (TypeError, ValueError):
                    pass
        return out

    def _price_asset(self, asset: Any) -> Optional[float]:
        sym = None
        if isinstance(asset, dict):
            sym = asset.get("symbol")
        else:
            sym = getattr(asset, "symbol", None)
        if not sym:
            return None
        return self._marks([sym]).get(str(sym))

    # ---- engine ctx builders (real adapters; honest when an indexer is absent) -
    def _base_ctx(self) -> Dict[str, Any]:
        try:
            return self.ctrl._ctx()
        except Exception:
            return {}

    def _optional_indexer(self, name: str):
        """Expose an adapter-provided read-only indexer by (duck-typed) method
        name if the registry's adapters implement it; otherwise ``None`` so the
        engine emits its audited 'unavailable' note (NEVER a fabricated empty)."""
        reg = getattr(self.ctrl, "registry", None)
        if reg is None:
            return None
        def fn(chain, *a, **k):
            try:
                adapter = reg.get(chain)
            except Exception:
                return None
            m = getattr(adapter, name, None)
            if not callable(m):
                return None
            return m(*a, **k)
        # only advertise the hook if at least one enabled adapter implements it
        try:
            for cid in reg.enabled():
                if callable(getattr(reg.get(cid), name, None)):
                    return fn
        except Exception:
            return None
        return None

    def portfolio_ctx(self) -> Dict[str, Any]:
        base = self._base_ctx()
        return {
            "getBalance": base.get("getBalance"),
            "priceUsd": self._price_asset,     # callable(asset)->mark|None (real market source)
            "asOf": int(time.time() * 1000),
        }

    def _security_config(self) -> Dict[str, Any]:
        cfg: Dict[str, Any] = {}
        try:
            v = self.ctrl.vault
            if hasattr(v, "security_config") and callable(v.security_config):
                cfg = dict(v.security_config() or {})
        except Exception:
            cfg = {}
        return cfg

    def security_ctx(self) -> Dict[str, Any]:
        ctx: Dict[str, Any] = {"config": self._security_config()}
        # a real getCode via the EVM adapter's JSON-RPC enables the
        # approval-to-eoa danger rule; absent => the rule is skipped (audited).
        reg = getattr(self.ctrl, "registry", None)
        if reg is not None:
            def get_code(chain, address):
                try:
                    adapter = reg.get(chain)
                except Exception:
                    return None
                rpc = getattr(adapter, "_rpc", None)
                if not callable(rpc):
                    return None
                try:
                    return rpc("eth_getCode", [address, "latest"])
                except Exception:
                    return None
            ctx["getCode"] = get_code
        return ctx

    def activity_ctx(self) -> Dict[str, Any]:
        base = self._base_ctx()
        ctx: Dict[str, Any] = {
            "getBalance": base.get("getBalance"),
            "explorerTx": _mk_async(base.get("explorerTx")),
            "securityConfig": self._security_config(),
        }
        hist = self._optional_indexer("get_history")
        if callable(hist):
            ctx["history"] = hist   # real indexer when an adapter provides one
        return ctx

    def _endpoints(self) -> Dict[str, Any]:
        """Operator-configured read-only endpoint/key settings (Alchemy NFT API,
        Helius DAS, the WalletConnect relay projectId) from the sealed vault. These
        are READ-ONLY indexer/relay keys, NOT wallet secrets. Empty when locked."""
        try:
            v = self.ctrl.vault
            if hasattr(v, "endpoints") and callable(v.endpoints):
                return dict(v.endpoints() or {})
        except Exception:
            pass
        return {}

    def _live_nft_indexer(self):
        """The LIVE NFT indexer (nft_indexer.create_indexer): EVM via the Alchemy
        NFT API, Solana via a Helius DAS indexer, both operator-configurable. A
        missing key / endpoint returns no result so the engine reports the account
        `unavailable` — NEVER a fabricated empty inventory. Returns ``None`` when no
        key is configured so the adapter-provided fallback (if any) is used."""
        ep = self._endpoints()
        alchemy = ep.get("alchemy") or {}
        helius = ep.get("helius") or ep.get("das") or {}
        if not (alchemy.get("apiKey") or alchemy.get("baseUrl")
                or helius.get("apiKey") or helius.get("url")):
            return None
        try:
            return nft_indexer_mod.create_indexer({"alchemy": alchemy, "helius": helius})
        except Exception:
            return None

    def nft_ctx(self) -> Dict[str, Any]:
        # Prefer the LIVE indexer (Alchemy / Helius DAS) when the operator has
        # configured a key; else fall back to an adapter-provided read-only hook.
        indexer = self._live_nft_indexer()
        if indexer is None:
            hook = {}
            get_for_owner = self._optional_indexer("get_nfts")
            if callable(get_for_owner):
                hook["getNFTsForOwner"] = get_for_owner
            indexer = hook or None
        return {"indexer": indexer, "config": self._security_config()}

    def resolve_ctx(self, book: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Name-resolution ctx: the local book plus any injected ENS/SNS resolver.
        Without a resolver, ``.eth``/``.sol`` names return None (never guessed)."""
        ctx: Dict[str, Any] = {"book": list(book or [])}
        reg = getattr(self.ctrl, "registry", None)
        if reg is not None:
            for cid, key in (("ethereum", "resolveEns"), ("solana", "resolveSns")):
                try:
                    adapter = reg.get(cid) if reg.has(cid) else None
                except Exception:
                    adapter = None
                fn = getattr(adapter, "resolve_name", None) if adapter else None
                if callable(fn):
                    ctx[key] = fn
        return ctx

    # ---- the address book (local, encrypted-at-rest alongside settings) ------
    def book(self):
        return book_mod.create_book({"store": self.ctrl._store})

    # ---- daily net-worth snapshot (drives the sparkline; real totals only) ---
    async def _load_snapshots(self) -> List[Dict[str, Any]]:
        try:
            got = await self.ctrl._store.get([self._snap_key])
            v = got.get(self._snap_key) if isinstance(got, dict) else None
            return v if isinstance(v, list) else []
        except Exception:
            return []

    async def _save_snapshots(self, lst: List[Dict[str, Any]]):
        try:
            await self.ctrl._store.set({self._snap_key: lst})
        except Exception:
            pass

    async def record_snapshot(self, total_usd_micro: str) -> List[Dict[str, Any]]:
        hist = await self._load_snapshots()
        hist = portfolio_mod.record_snapshot(
            hist, {"ts": int(time.time() * 1000), "totalUsdMicro": str(total_usd_micro)})
        await self._save_snapshots(hist)
        return hist

    def native_asset(self, chain: str) -> Dict[str, Any]:
        """The chain's native asset (symbol + decimals) from the REAL adapter —
        used to build a well-formed inspection tx for the send flow."""
        reg = getattr(self.ctrl, "registry", None)
        if reg is not None:
            try:
                return reg.get(chain).native.to_json()
            except Exception:
                pass
        return {"chain": chain, "kind": "native", "symbol": "?", "decimals": 18}

    def build_inspection_tx(self, chain: str, to: str, display_amount: Any,
                            asset: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Build a WELL-FORMED tx for ``security.inspect_transaction`` so the
        preview shows the REAL amount + recipient (never a misleading 0):

          * native send — the real base-unit amount goes in ``tx['value']``
            (EVM reads ``value``; the field ``amount`` is mirrored for the
            BLOCK decoder) so ``decode_*`` reads the true amount.
          * token (ERC-20) send — the ERC-20 ``transfer(to,amount)`` CALLDATA
            is built with the EXISTING evm adapter builder and ``to`` points at
            the token contract, so ``decode_evm`` decodes the true recipient +
            amount from the calldata.

        Returns the tx dict; the resolved base-unit amount is attached under the
        private ``_amountBase`` key for the signer step. Never fabricates."""
        asset = asset or self.native_asset(chain)
        decimals = security_mod.member(asset, "decimals")
        amount_base = to_base_units(display_amount, decimals) if display_amount else 0
        kind = security_mod.member(asset, "kind")
        if kind == "erc20":
            token_addr = security_mod.member(asset, "address")
            return {
                "chain": chain, "to": token_addr, "value": "0",
                "data": evm_mod.erc20_transfer_data(to, amount_base),
                "asset": asset, "_recipient": to, "_amountBase": amount_base,
            }
        return {
            "chain": chain, "to": to, "value": str(amount_base),
            "amount": str(amount_base),   # mirrored for the BLOCK/native decoder
            "asset": asset, "_recipient": to, "_amountBase": amount_base,
        }

    async def perform_send(self, chain: str, to: str, amount_base: Any,
                           asset: Optional[Any] = None) -> Dict[str, Any]:
        """Route an INSPECTED, gate-cleared send through the EXISTING per-chain
        signer/broadcast — the SAME ``build_send`` -> ``broadcast`` adapter path
        the Accounts-tab Send dialog and the agent/send flow use. The UI never
        signs on its own; this is only ever reached AFTER the security confirm
        sheet is accepted. ``asset=None`` is a native send; an ``AssetRef`` is a
        token send. Runs on the worker loop (RPC); the caller marshals the
        done-callback back onto the GUI thread via :meth:`run_async`."""
        reg = getattr(self.ctrl, "registry", None)
        acct = (getattr(self.ctrl, "accounts", {}) or {}).get(chain)
        if reg is None or acct is None:
            raise RuntimeError("signer unavailable (vault locked or chain unsupported)")
        adapter = reg.get(chain)
        built = adapter.build_send(acct, {"asset": asset, "to": to, "amount": str(amount_base)})
        res = adapter.broadcast(built)
        txid = getattr(res, "txid", None)
        if txid is None and isinstance(res, dict):
            txid = res.get("txid")
        return {"txid": txid, "fee": getattr(built, "fee", None)}

    # ---- WalletConnect v2 core (session + request state machine) -------------
    def _wc_config(self) -> Dict[str, Any]:
        """WalletConnect config derived from the REAL wallet: the CAIP-2 chains
        the wallet actually controls (so a proposal only settles to controlled
        chains) + the shared security denylist. Never a fabricated grant."""
        wallet_chains: List[str] = []
        reg = getattr(self.ctrl, "registry", None)
        if reg is not None:
            try:
                for cid in reg.enabled():
                    adapter = reg.get(cid)
                    chain_id = getattr(adapter, "chainId", None)
                    if chain_id is not None:              # an EVM chain
                        wallet_chains.append(f"eip155:{chain_id}")
                    elif cid == "solana":
                        wallet_chains.append("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
            except Exception:
                pass
        cfg: Dict[str, Any] = {"walletChains": wallet_chains}
        sec_cfg = self._security_config()
        if sec_cfg.get("denylist"):
            cfg["denylist"] = sec_cfg["denylist"]
        return cfg

    def _live_wc_relay(self):
        """The LIVE WalletConnect v2 relay transport (wc_relay.create_relay): opens
        a wss connection to the operator's relay with a relay-auth JWT, speaks the
        irn JSON-RPC, and carries ChaCha20-Poly1305 type-0 envelopes end-to-end. It
        NEVER holds keys and NEVER signs. Returns ``None`` when no projectId is
        configured (the review/approval sheets still drive the core)."""
        ep = self._endpoints()
        wc_ep = ep.get("walletconnect") or {}
        project_id = wc_ep.get("projectId")
        if not project_id:
            return None
        try:
            opts = {"projectId": project_id}
            if wc_ep.get("relayUrl"):
                opts["relayUrl"] = wc_ep["relayUrl"]
            return wc_relay_mod.create_relay(opts)
        except Exception:
            return None

    def wallet_connect(self) -> wc_mod.WalletConnect:
        if self._wc is None:
            self._wc = wc_mod.create_wallet_connect({
                "store": self.ctrl._store,       # encrypted session store (NO keys)
                "security": security_mod,        # reuse the wallet security suite
                "relay": self._live_wc_relay(),  # LIVE WC v2 relay (wss irn + envelopes)
                "signer": self._wc_signer(),     # signs ONLY after approval (existing signer)
                "config": self._wc_config(),     # chains the wallet really controls
            })
        return self._wc

    def _wc_signer(self):
        """The dApp-request signer — a thin adapter over the EXISTING per-chain
        signer on the shared controller. It is only ever reached AFTER the
        security gate + explicit approval inside the WC core (fail-closed)."""
        ctrl = self.ctrl

        def eth_send(req):
            tx = (req or {}).get("tx") or {}
            chain = wc_mod.evm_chain_name(req.get("chainId"))
            # route through the EXISTING arbitrary-tx signer on the adapter
            reg = getattr(ctrl, "registry", None)
            adapter = reg.get(chain) if reg else None
            acct = (getattr(ctrl, "accounts", {}) or {}).get(chain)
            signed = adapter.sign_arbitrary_tx(acct, tx)
            res = adapter.broadcast(signed)
            return getattr(res, "txid", None) or res

        def _blocked(*_a, **_k):
            raise RuntimeError("signer unavailable (vault locked or unsupported method)")

        return {
            "ethSendTransaction": eth_send,
            "ethSignTypedData": _blocked,
            "personalSign": _blocked,
            "solanaSignTransaction": _blocked,
            "solanaSignAndSendTransaction": _blocked,
            "solanaSignMessage": _blocked,
        }

    def wc_request_ctx(self) -> Dict[str, Any]:
        """ctx for ``WalletConnect.handle_request`` — the approve + danger-confirm
        handlers bridge onto the GUI thread (the request runs on the worker loop)
        and the security ctx reuses the wallet suite."""
        async def approve(presentation):
            return await self._bridge(self.approval_requested, presentation)

        async def confirm(presentation):
            return await self._bridge(self.danger_requested, presentation)

        return {"approve": approve, "confirm": confirm, "security": self.security_ctx()}

    def _wc_accounts(self) -> List[str]:
        """The CAIP-10 accounts the wallet can OFFER a dApp (chain-id:address) —
        the real per-chain addresses the vault controls. Fed to approve_proposal so
        a session only ever settles accounts the wallet actually holds."""
        out: List[str] = []
        reg = getattr(self.ctrl, "registry", None)
        accts = getattr(self.ctrl, "accounts", None) or {}
        if reg is None:
            return out
        try:
            for cid in reg.enabled():
                acc = accts.get(cid)
                addr = getattr(acc, "address", None) if acc is not None else None
                if not addr:
                    continue
                adapter = reg.get(cid)
                chain_id = getattr(adapter, "chainId", None)
                if chain_id is not None:
                    out.append(f"eip155:{chain_id}:{addr}")
                elif cid == "solana":
                    out.append(f"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{addr}")
        except Exception:
            pass
        return out

    def ensure_relay_wired(self) -> bool:
        """Drive the LIVE WC v2 relay end-to-end: subscribe inbound session
        proposals (bridged to the GUI review sheet, then approve/reject through the
        core — which settles only controlled chains) and route inbound session
        requests through ``handle_request`` (the SAME security gate + approval) and
        publish the result. Idempotent; a no-op when no relay is configured."""
        wc = self.wallet_connect()
        if self._relay_wired or wc.relay is None:
            return self._relay_wired
        self._relay_wired = True
        # requests -> handle_request (gate + approval) -> respond, on the worker loop
        wc.connect_relay(self.wc_request_ctx())

        def on_proposal(proposal):
            async def _flow():
                review = wc.review_proposal(proposal)
                ok = await self._bridge(self.proposal_requested, review)
                if ok:
                    await wc.approve_proposal(proposal, {"accounts": self._wc_accounts()})
                else:
                    await wc.reject_proposal(proposal, None)
            try:
                self.loop.submit(_flow())
            except Exception:
                pass

        sub = getattr(wc.relay, "subscribeProposals", None)
        if callable(sub):
            sub(on_proposal)
        return True

    async def _bridge(self, signal, presentation) -> bool:
        """Emit a queued signal to the GUI thread, show the sheet there, and
        await the user's decision via a loop future resolved cross-thread."""
        loop = self.loop.loop
        fut = loop.create_future()

        def resolver(ok):
            loop.call_soon_threadsafe(fut.set_result, bool(ok))

        signal.emit(presentation, resolver)
        return await fut

    # ---- async bridge (identical pattern to BotsController.run_async) --------
    def run_async(self, coro, on_done=None, on_error=None):
        if self.loop is None:
            # vault locked — no worker loop yet. Close the coroutine so it is not
            # left un-awaited; the caller's locked-state UI already stands in.
            try:
                coro.close()
            except Exception:
                pass
            return None
        fut = self.loop.submit(coro)

        def _cb(f):
            # Runs on the AgentLoop WORKER thread — NEVER touch a QWidget here;
            # hop the callback onto the GUI thread via the queued signals above.
            try:
                res = f.result()
            except Exception as e:  # pragma: no cover - surfaced in UI
                if on_error:
                    self._async_error.emit(on_error, e)
                return
            if on_done:
                self._async_done.emit(on_done, res)

        fut.add_done_callback(_cb)
        return fut


def _mk_async(fn):
    """Wrap a sync ctx callable as an async one (the engines ``await`` ctx fns)."""
    if fn is None:
        return None

    async def _inner(*a, **k):
        return fn(*a, **k)
    return _inner


# =========================================================================== #
# SECURITY CONFIRM SHEET — the shared review sheet used by Send AND dApp        #
# requests. Decoded preview + warnings by severity + the "N checks ran / M      #
# skipped; nothing claims safe" line. A DANGER needs the explicit extra confirm.#
# =========================================================================== #
class SecurityConfirmSheet(QDialog):
    def __init__(self, tok: Dict[str, str], inspection: Dict[str, Any],
                 *, title: str = "Review transaction", dapp: Optional[str] = None,
                 resolved: Optional[str] = None, approve_label: Optional[str] = None,
                 parent=None):
        super().__init__(parent)
        self.tok = tok
        self.inspection = inspection or {}
        self.setObjectName("walletRoot")
        self.setWindowTitle(title)
        self.setModal(True)
        self.setMinimumWidth(460)
        self.setStyleSheet(build_qss(tok))

        root = QVBoxLayout(self)
        root.setContentsMargins(22, 20, 22, 22)
        root.setSpacing(12)

        head = QLabel(title)
        head.setObjectName("h2")
        root.addWidget(head)

        if dapp:
            d = QLabel(dapp)
            d.setObjectName("sub")
            d.setWordWrap(True)
            root.addWidget(d)

        if resolved:
            box = QFrame()
            box.setObjectName("resolved")
            bl = QHBoxLayout(box)
            bl.setContentsMargins(13, 10, 13, 10)
            lbl = QLabel(resolved)
            lbl.setWordWrap(True)
            lbl.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
            bl.addWidget(lbl)
            root.addWidget(box)

        # --- decoded preview ---
        summary = self.inspection.get("summary")
        if summary:
            s = QLabel(str(summary))
            s.setWordWrap(True)
            s.setStyleSheet(f"color:{tok['ink']};font-size:13px;font-weight:650;")
            root.addWidget(s)

        details = self.inspection.get("details") or []
        if details:
            pv = QFrame()
            pv.setObjectName("preview")
            pvl = QVBoxLayout(pv)
            pvl.setContentsMargins(0, 0, 0, 0)
            pvl.setSpacing(0)
            head_row = QLabel("  Transaction preview")
            head_row.setStyleSheet(
                f"background:{tok['elevated']};color:{tok['ink_muted']};font-size:12px;"
                f"padding:9px 12px;border-top-left-radius:{RADIUS_SM}px;"
                f"border-top-right-radius:{RADIUS_SM}px;")
            pvl.addWidget(head_row)
            for d in details:
                row = QWidget()
                rl = QHBoxLayout(row)
                rl.setContentsMargins(12, 8, 12, 8)
                k = QLabel(str(_field(d, "label")))
                k.setObjectName("pvKey")
                v = QLabel(str(_field(d, "value")))
                v.setObjectName("pvVal")
                v.setAlignment(Qt.AlignRight)
                v.setWordWrap(True)
                rl.addWidget(k)
                rl.addStretch(1)
                rl.addWidget(v)
                pvl.addWidget(row)
            root.addWidget(pv)

        # --- warnings by severity ---
        warnings = self.inspection.get("warnings") or []
        severity = self.inspection.get("severity") or security_mod.max_severity(warnings)
        for w in warnings:
            root.addWidget(self._warn_box(w))

        # --- the transparency "N checks ran / M skipped" line (never "safe") ---
        root.addWidget(self._checks_line())

        # --- actions; a DANGER forces the explicit extra confirm ---
        self._is_danger = severity == "danger"
        self._confirm_box = None
        if self._is_danger:
            cb = QCheckBox("I understand the risk")
            cb.setStyleSheet(f"color:{tok['loss']};font-weight:700;")
            cb.stateChanged.connect(self._sync_ok)
            self._confirm_box = cb
            root.addWidget(cb)

        actions = QHBoxLayout()
        actions.setSpacing(10)
        reject = QPushButton("Reject")
        reject.clicked.connect(self.reject)
        self.ok = QPushButton(approve_label or (
            "I understand the risk — approve" if self._is_danger else "Approve"))
        self.ok.setObjectName("danger" if self._is_danger else "primary")
        self.ok.clicked.connect(self.accept)
        actions.addWidget(reject, 1)
        actions.addWidget(self.ok, 1)
        root.addLayout(actions)
        self._sync_ok()

    def _sync_ok(self, *_):
        if self._is_danger and self._confirm_box is not None:
            self.ok.setEnabled(self._confirm_box.isChecked())

    def _warn_box(self, w: Dict[str, Any]) -> QWidget:
        tok = self.tok
        sev = _field(w, "severity") or "info"
        name = {"danger": "warnDanger", "warn": "warnWarn"}.get(sev, "warnInfo")
        color = {"danger": tok["loss"], "warn": tok["warn"]}.get(sev, tok["accent"])
        box = QFrame()
        box.setObjectName(name)
        bl = QVBoxLayout(box)
        bl.setContentsMargins(13, 11, 15, 12)
        bl.setSpacing(3)
        code = _field(w, "code") or sev
        t = QLabel("⚠  " + str(code))
        t.setStyleSheet(f"color:{color};font-weight:800;font-size:13px;")
        bl.addWidget(t)
        msg = _field(w, "message")
        if msg:
            d = QLabel(str(msg))
            d.setWordWrap(True)
            d.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
            bl.addWidget(d)
        return box

    def _checks_line(self) -> QLabel:
        checks = self.inspection.get("checks") or {}
        ran = checks.get("ran") or []
        skipped = checks.get("skipped") or []
        parts = [f"{len(ran)} checks ran"]
        if skipped:
            reasons = ", ".join(
                str(_field(s, "reason") or _field(s, "code")) for s in skipped[:3])
            parts.append(f"{len(skipped)} skipped ({reasons})")
        line = " · ".join(parts) + ". Nothing here claims this is safe."
        lab = QLabel("✓ " + line)
        lab.setObjectName("checks")
        lab.setWordWrap(True)
        return lab


def _field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


# =========================================================================== #
# SEND SHEET — type a name/address, RESOLVE it, SHOW the resolved address for   #
# confirmation, then run security.inspect_transaction on the RESOLVED address   #
# before opening the shared confirm sheet (the deferred send-flow piece).       #
# =========================================================================== #
class SendSheet(QDialog):
    def __init__(self, wc: WalletController, tok: Dict[str, str],
                 *, prefill_chain: Optional[str] = None,
                 prefill_to: Optional[str] = None, parent=None):
        super().__init__(parent)
        self.wc = wc
        self.tok = tok
        self.setObjectName("walletRoot")
        self.setWindowTitle("Send")
        self.setModal(True)
        self.setMinimumWidth(440)
        self.setStyleSheet(build_qss(tok))
        self._resolved: Optional[Dict[str, Any]] = None

        root = QVBoxLayout(self)
        root.setContentsMargins(22, 20, 22, 22)
        root.setSpacing(11)
        head = QLabel("Send")
        head.setObjectName("h2")
        root.addWidget(head)

        self.chain = QComboBox()
        for acc in wc.accounts_list():
            self.chain.addItem(wc.chain_label(acc["chain"]), acc["chain"])
        if self.chain.count() == 0:
            self.chain.addItem("Unlock the vault first", None)
            self.chain.setEnabled(False)
        if prefill_chain:
            i = self.chain.findData(prefill_chain)
            if i >= 0:
                self.chain.setCurrentIndex(i)
        root.addWidget(_labeled("Network", self.chain, tok))

        self.to = QLineEdit()
        self.to.setPlaceholderText("alice.eth / name.sol / a saved label / an address")
        if prefill_to:
            self.to.setText(prefill_to)
        self.to.textChanged.connect(self._on_to_changed)
        root.addWidget(_labeled("Recipient", self.to, tok))

        self.resolved_box = QFrame()
        self.resolved_box.setObjectName("resolved")
        rl = QHBoxLayout(self.resolved_box)
        rl.setContentsMargins(13, 10, 13, 10)
        self.resolved_lbl = QLabel("")
        self.resolved_lbl.setWordWrap(True)
        self.resolved_lbl.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
        rl.addWidget(self.resolved_lbl)
        self.resolved_box.setVisible(False)
        root.addWidget(self.resolved_box)

        self.amount = QLineEdit()
        self.amount.setPlaceholderText("0.0")
        root.addWidget(_labeled("Amount", self.amount, tok))

        actions = QHBoxLayout()
        actions.setSpacing(10)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        self.review = QPushButton("Review send")
        self.review.setObjectName("primary")
        self.review.clicked.connect(self._do_review)
        actions.addWidget(cancel, 1)
        actions.addWidget(self.review, 1)
        root.addLayout(actions)

    def _current_chain(self) -> Optional[str]:
        return self.chain.currentData()

    def _on_to_changed(self, _text: str):
        # reset resolution; it is re-run on Review (needs the book, async).
        self._resolved = None
        self.resolved_box.setVisible(False)

    def _do_review(self):
        chain = self._current_chain()
        raw = self.to.text().strip()
        if not chain or not raw:
            QMessageBox.information(self, "Send", "Pick a network and a recipient.")
            return
        # resolve the name against the local book + injected ENS/SNS, THEN inspect
        # the RESOLVED address — the deferred send-flow piece, all on real engines.
        amt = self.amount.text().strip()
        async def _flow():
            book = await self.wc.book().list()
            ctx = self.wc.resolve_ctx(book)
            resolved = await book_mod.resolve_name(raw, chain, ctx)
            if not resolved:
                return {"error": "Could not resolve that name. "
                        "Enter a valid address or a saved/ENS/SNS name — never guessed."}
            # Build a WELL-FORMED tx so the preview shows the REAL amount: the
            # base-unit amount goes in tx['value'] for a native send (token sends
            # build the ERC-20 transfer calldata). NOT a misleading value="0".
            try:
                tx = self.wc.build_inspection_tx(chain, resolved["address"], amt)
            except ValueError as e:
                return {"error": str(e)}
            inspection = await security_mod.inspect_transaction(tx, self.wc.security_ctx())
            return {"resolved": resolved, "inspection": inspection,
                    "chain": chain, "to": resolved["address"],
                    "amountBase": tx.get("_amountBase", 0)}
        self.review.setEnabled(False)
        self.wc.run_async(_flow(), on_done=self._on_reviewed,
                          on_error=lambda e: self._reenable(str(e)))

    def _reenable(self, msg: str):
        self.review.setEnabled(True)
        QMessageBox.warning(self, "Send", msg)

    def _on_reviewed(self, out: Dict[str, Any]):
        self.review.setEnabled(True)
        if out.get("error"):
            QMessageBox.warning(self, "Send", out["error"])
            return
        resolved = out["resolved"]
        self._resolved = resolved
        src = resolved.get("source")
        name = resolved.get("name") or resolved.get("label") or self.to.text().strip()
        addr = resolved["address"]
        self.resolved_lbl.setText(
            f"✓  {name} resolves to  {shorten(addr)}   ({str(src).upper()})")
        self.resolved_box.setVisible(True)
        # open the shared security confirm sheet on the RESOLVED address
        sheet = SecurityConfirmSheet(
            self.tok, out["inspection"], title="Review send",
            resolved=f"✓ {name} → {shorten(addr)} (source: {src}) — confirm it's right.",
            parent=self)
        if sheet.exec() == QDialog.Accepted:
            # The security gate cleared (a DANGER required the explicit confirm
            # inside the sheet). ONLY NOW do we hand the send to the EXISTING
            # signer/broadcast path — the same adapter build_send -> broadcast the
            # Accounts Send dialog and the agent/send flow use. It runs on the
            # worker loop; the done/error callbacks are marshalled back onto the
            # GUI thread by run_async's queued-signal bridge (no worker-thread
            # widget touch). The UI never signs or broadcasts except right here,
            # after the gate.
            self.review.setEnabled(False)
            self.wc.run_async(
                self.wc.perform_send(out["chain"], out["to"], out["amountBase"]),
                on_done=self._on_sent,
                on_error=self._on_send_error)

    def _on_sent(self, res: Dict[str, Any]):
        txid = (res or {}).get("txid")
        QMessageBox.information(
            self, "Send", f"Broadcast through the wallet signer.\ntxid: {txid}")
        self.accept()

    def _on_send_error(self, exc: Any):
        self.review.setEnabled(True)
        QMessageBox.warning(self, "Send", f"Broadcast failed: {exc}")


def _labeled(label: str, widget: QWidget, tok: Dict[str, str]) -> QWidget:
    wrap = QWidget()
    lay = QVBoxLayout(wrap)
    lay.setContentsMargins(0, 0, 0, 0)
    lay.setSpacing(5)
    lab = QLabel(label.upper())
    lab.setObjectName("eyebrow")
    lay.addWidget(lab)
    lay.addWidget(widget)
    return wrap


# =========================================================================== #
# PROPOSAL REVIEW SHEET — surfaces the dApp's CLAIMED metadata (never trusted)  #
# + exactly what it requests, with warnings; approve/reject only (no auto).     #
# =========================================================================== #
class ProposalReviewSheet(QDialog):
    def __init__(self, tok: Dict[str, str], review: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.tok = tok
        self.setObjectName("walletRoot")
        self.setWindowTitle("Connection request")
        self.setModal(True)
        self.setMinimumWidth(460)
        self.setStyleSheet(build_qss(tok))
        root = QVBoxLayout(self)
        root.setContentsMargins(22, 20, 22, 22)
        root.setSpacing(11)

        head = QLabel("Connection request")
        head.setObjectName("h2")
        root.addWidget(head)

        dapp = review.get("dapp") or {}
        meta = QLabel(f"{dapp.get('name') or 'Unknown dApp'} · {dapp.get('url') or ''}")
        meta.setObjectName("sub")
        meta.setWordWrap(True)
        root.addWidget(meta)
        claim = QLabel("The name + URL above are CLAIMED by the dApp and are not verified.")
        claim.setObjectName("faint")
        claim.setWordWrap(True)
        root.addWidget(claim)

        chains = review.get("chains") or []
        methods = review.get("methods") or []
        root.addWidget(self._pills("Chains", chains))
        root.addWidget(self._pills("Methods", methods))

        for w in (review.get("warnings") or []):
            sev = _field(w, "severity") or "info"
            name = {"danger": "warnDanger", "warn": "warnWarn"}.get(sev, "warnInfo")
            color = {"danger": tok["loss"], "warn": tok["warn"]}.get(sev, tok["accent"])
            box = QFrame()
            box.setObjectName(name)
            bl = QVBoxLayout(box)
            bl.setContentsMargins(13, 10, 15, 11)
            t = QLabel("⚠  " + str(_field(w, "code")))
            t.setStyleSheet(f"color:{color};font-weight:800;")
            bl.addWidget(t)
            m = _field(w, "message")
            if m:
                d = QLabel(str(m))
                d.setWordWrap(True)
                d.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
                bl.addWidget(d)
            root.addWidget(box)

        actions = QHBoxLayout()
        actions.setSpacing(10)
        reject = QPushButton("Reject")
        reject.clicked.connect(self.reject)
        ok = QPushButton("Approve connection")
        ok.setObjectName("primary")
        ok.clicked.connect(self.accept)
        actions.addWidget(reject, 1)
        actions.addWidget(ok, 1)
        root.addLayout(actions)

    def _pills(self, label: str, items: List[str]) -> QWidget:
        wrap = QWidget()
        lay = QVBoxLayout(wrap)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(5)
        lab = QLabel(label.upper())
        lab.setObjectName("eyebrow")
        lay.addWidget(lab)
        flow = QHBoxLayout()
        flow.setSpacing(6)
        for it in (items or ["—"]):
            p = QLabel(str(it))
            p.setObjectName("mchip")
            flow.addWidget(p)
        flow.addStretch(1)
        lay.addLayout(flow)
        return wrap


# =========================================================================== #
# PANELS                                                                        #
# =========================================================================== #
class _ScrollPanel(QWidget):
    """A vertically scrolling panel body with a content VBox (``self.body``)."""

    def __init__(self, tok: Dict[str, str]):
        super().__init__()
        self.tok = tok
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        inner = QWidget()
        self.body = QVBoxLayout(inner)
        self.body.setContentsMargins(18, 14, 18, 20)
        self.body.setSpacing(12)
        scroll.setWidget(inner)
        outer.addWidget(scroll)

    def set_tokens(self, tok: Dict[str, str]):
        self.tok = tok

    def _clear_body(self, keep: int = 0):
        while self.body.count() > keep:
            it = self.body.takeAt(keep)
            w = it.widget()
            if w:
                w.deleteLater()


def _sec_head(tok: Dict[str, str], title: str, count: Optional[str] = None) -> QWidget:
    w = QWidget()
    lay = QHBoxLayout(w)
    lay.setContentsMargins(0, 6, 0, 0)
    lay.setSpacing(10)
    h = QLabel(title)
    h.setObjectName("h2")
    lay.addWidget(h)
    if count is not None:
        c = QLabel(count)
        c.setObjectName("count")
        lay.addWidget(c)
    lay.addStretch(1)
    return w


class PortfolioPanel(_ScrollPanel):
    """Net-worth hero + sparkline + by-chain bar + holdings (unpriced shown-not-
    counted) + Send/Receive/Swap — all from ``portfolio()`` + the daily snapshot."""

    open_send = Signal()

    def __init__(self, wc: WalletController, tok: Dict[str, str]):
        super().__init__(tok)
        self.wc = wc

        # --- hero card ---
        self.hero = QFrame()
        self.hero.setObjectName("card")
        hl = QVBoxLayout(self.hero)
        hl.setContentsMargins(24, 22, 24, 22)
        hl.setSpacing(6)
        eb = QLabel("NET WORTH · ALL CHAINS")
        eb.setObjectName("eyebrow")
        hl.addWidget(eb)
        self.big = QLabel("—")
        self.big.setObjectName("heroBig")
        hl.addWidget(self.big)
        self.sub = QLabel("")
        self.sub.setObjectName("sub")
        self.sub.setWordWrap(True)
        hl.addWidget(self.sub)
        self.spark = Sparkline(tok)
        self.spark.setMinimumHeight(72)
        hl.addWidget(self.spark, 1)
        send_row = QHBoxLayout()
        send_row.setSpacing(9)
        self.send_btn = QPushButton("↗  Send")
        self.send_btn.setObjectName("primary")
        self.send_btn.clicked.connect(self.open_send.emit)
        recv = QPushButton("↓  Receive")
        recv.clicked.connect(self._receive)
        swap = QPushButton("⇄  Swap")
        swap.clicked.connect(lambda: QMessageBox.information(
            self, "Swap", "Swap routes through the Exchange tab's non-custodial swap."))
        send_row.addWidget(self.send_btn)
        send_row.addWidget(recv)
        send_row.addWidget(swap)
        send_row.addStretch(1)
        hl.addLayout(send_row)
        self.body.addWidget(self.hero)

        # --- by-chain card ---
        chains_card = QFrame()
        chains_card.setObjectName("card")
        ccl = QVBoxLayout(chains_card)
        ccl.setContentsMargins(20, 18, 20, 18)
        ccl.setSpacing(12)
        ce = QLabel("BY CHAIN")
        ce.setObjectName("eyebrow")
        ccl.addWidget(ce)
        self.chainbar = ChainBar(tok)
        ccl.addWidget(self.chainbar)
        self.body.addWidget(chains_card)

        # --- holdings ---
        self.body.addWidget(_sec_head(tok, "Holdings", "0"))
        self.holdings_card = QFrame()
        self.holdings_card.setObjectName("card")
        self.holdings_lay = QVBoxLayout(self.holdings_card)
        self.holdings_lay.setContentsMargins(0, 0, 0, 0)
        self.holdings_lay.setSpacing(0)
        self.body.addWidget(self.holdings_card)

        self.unpriced_note = QLabel(
            "ⓘ  Unpriced tokens are shown but not counted in net worth — never guessed.")
        self.unpriced_note.setObjectName("faint")
        self.unpriced_note.setWordWrap(True)
        self.body.addWidget(self.unpriced_note)
        self.body.addStretch(1)

        self._head = self.body.itemAt(2).widget()  # the sec-head (to update count)

    def set_tokens(self, tok: Dict[str, str]):
        super().set_tokens(tok)
        self.spark.set_tokens(tok)
        self.chainbar.set_tokens(tok)
        self.setStyleSheet(build_qss(tok))

    def _receive(self):
        accts = self.wc.accounts_list()
        if not accts:
            QMessageBox.information(self, "Receive", "Unlock the vault to see your addresses.")
            return
        lines = "\n".join(f"{self.wc.chain_label(a['chain'])}:  {a['address']}" for a in accts)
        QMessageBox.information(self, "Receive — your addresses", lines)

    def refresh(self):
        accts = self.wc.accounts_list()
        if not accts:
            self.big.setText("—")
            self.sub.setText("Unlock the multi-chain vault (Accounts tab) to see your portfolio.")
            self.chainbar.set_rows([])
            self._render_holdings([])
            return

        async def _load():
            pf = await portfolio_mod.portfolio(accts, self.wc.portfolio_ctx())
            hist = await self.wc.record_snapshot(pf.get("totalUsdMicro") or "0")
            spark = portfolio_mod.sparkline(hist, 30)
            return {"pf": pf, "spark": spark}
        self.wc.run_async(_load(), on_done=self._apply,
                          on_error=lambda e: self.sub.setText(f"portfolio unavailable: {e}"))

    def _apply(self, out: Dict[str, Any]):
        pf = out["pf"]
        tok = self.tok
        total = pf.get("totalUsd") or 0
        self.big.setText(plain_money(total))
        unpriced = pf.get("unpriced") or []
        up = f" · {len(unpriced)} holding{'s' if len(unpriced) != 1 else ''} unpriced" if unpriced else ""
        self.sub.setText(f"Across {len(pf.get('byChain') or [])} chains{up}")
        # sparkline from the REAL snapshot history (>=2 points to draw)
        pts = [p["usd"] for p in (out.get("spark") or [])]
        self.spark.set_data(pts)
        # by-chain
        rows = []
        for c in (pf.get("byChain") or []):
            rows.append({"chain": c["chain"], "label": self.wc.chain_label(c["chain"]),
                         "usd": c.get("usd"), "pct": c.get("pct")})
        self.chainbar.set_rows(rows)
        self._render_holdings(pf.get("holdings") or [])

    def _render_holdings(self, holdings: List[Dict[str, Any]]):
        while self.holdings_lay.count():
            it = self.holdings_lay.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        tok = self.tok
        if self._head is not None:
            cnt = self._head.layout().itemAt(1).widget()
            if isinstance(cnt, QLabel):
                cnt.setText(str(len(holdings)))
        if not holdings:
            e = QLabel("  No holdings found for the unlocked accounts.")
            e.setObjectName("faint")
            e.setStyleSheet(f"color:{tok['ink_faint']};padding:14px 18px;")
            self.holdings_lay.addWidget(e)
            return
        for i, h in enumerate(holdings):
            self.holdings_lay.addWidget(self._holding_row(h, i, len(holdings)))

    def _holding_row(self, h: Dict[str, Any], idx: int, total: int) -> QWidget:
        tok = self.tok
        row = QFrame()
        row.setObjectName("row" if idx < total - 1 else "")
        rl = QHBoxLayout(row)
        rl.setContentsMargins(18, 13, 18, 13)
        rl.setSpacing(13)
        sym = str(h.get("symbol") or "?")
        hue = _chain_hue(tok, idx)
        av = QLabel(sym[:2].upper())
        av.setFixedSize(32, 32)
        av.setAlignment(Qt.AlignCenter)
        av.setStyleSheet(f"background:{hue};color:white;border-radius:16px;"
                         f"font-weight:800;font-size:11px;")
        # Correct per-chain / per-token logo (bundled brand SVG for a native
        # coin, token logoURI, else a colored monogram) — never a broken icon.
        set_asset_icon(av, {
            "chain": h.get("chain"), "symbol": sym, "kind": h.get("kind"),
            "address": h.get("address") or h.get("contract") or h.get("mint"),
            "logoURI": h.get("logoURI"), "logo": h.get("logo"),
        }, size=32)
        rl.addWidget(av)
        namecol = QVBoxLayout()
        namecol.setSpacing(1)
        nm = QLabel(sym)
        nm.setStyleSheet("font-weight:650;font-size:14px;")
        ch = QLabel(self.wc.chain_label(h.get("chain")))
        ch.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
        namecol.addWidget(nm)
        namecol.addWidget(ch)
        rl.addLayout(namecol)
        rl.addStretch(1)
        amtcol = QVBoxLayout()
        amtcol.setSpacing(1)
        amt = QLabel(f"{_amt_str(h.get('amountBase'), h.get('decimals'))} {sym}")
        amt.setStyleSheet(f"font-family:{MONO};font-size:13px;")
        amt.setAlignment(Qt.AlignRight)
        amtcol.addWidget(amt)
        if h.get("pricedOk"):
            q = QLabel(plain_money(h.get("usd")))
            q.setStyleSheet(f"color:{tok['ink_faint']};font-family:{MONO};font-size:12px;")
            q.setAlignment(Qt.AlignRight)
            amtcol.addWidget(q)
        else:
            tag = QLabel("UNPRICED")
            tag.setObjectName("tagUnpriced")
            tag.setAlignment(Qt.AlignRight)
            amtcol.addWidget(tag, alignment=Qt.AlignRight)
        rl.addLayout(amtcol)
        return row


class ActivityPanel(_ScrollPanel):
    """The aggregated cross-chain feed from ``activity()`` with the security
    decoder labels + flagged-counterparty pills inline."""

    def __init__(self, wc: WalletController, tok: Dict[str, str]):
        super().__init__(tok)
        self.wc = wc
        self.body.addWidget(_sec_head(tok, "Activity", "all chains"))
        self.feed = QFrame()
        self.feed.setObjectName("card")
        self.feed_lay = QVBoxLayout(self.feed)
        self.feed_lay.setContentsMargins(0, 0, 0, 0)
        self.feed_lay.setSpacing(0)
        self.body.addWidget(self.feed)
        self.body.addStretch(1)

    def set_tokens(self, tok):
        super().set_tokens(tok)
        self.setStyleSheet(build_qss(tok))

    def refresh(self):
        accts = self.wc.accounts_list()
        if not accts:
            self._render({"items": [], "notes": [
                {"note": "Unlock the vault to see your cross-chain activity."}]})
            return
        self.wc.run_async(
            activity_mod.activity(accts, self.wc.activity_ctx(), {"limit": 25}),
            on_done=self._render,
            on_error=lambda e: self._render({"items": [], "notes": [{"note": str(e)}]}))

    def _render(self, out: Dict[str, Any]):
        while self.feed_lay.count():
            it = self.feed_lay.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        tok = self.tok
        items = out.get("items") or []
        notes = out.get("notes") or []
        if not items:
            msg = "No activity to show."
            if notes:
                msg = "  ·  ".join(str(_field(n, "note")) for n in notes)
            e = QLabel("  " + msg)
            e.setObjectName("faint")
            e.setWordWrap(True)
            e.setStyleSheet(f"color:{tok['ink_faint']};padding:16px 18px;")
            self.feed_lay.addWidget(e)
            return
        for i, a in enumerate(items):
            self.feed_lay.addWidget(self._row(a, i, len(items)))
        for n in notes:
            note = QLabel("ⓘ  " + str(_field(n, "note")))
            note.setObjectName("faint")
            note.setWordWrap(True)
            note.setStyleSheet(f"color:{tok['ink_faint']};padding:12px 18px;")
            self.feed_lay.addWidget(note)

    def _row(self, a: Dict[str, Any], idx: int, total: int) -> QWidget:
        tok = self.tok
        row = QFrame()
        row.setObjectName("row" if idx < total - 1 else "")
        rl = QHBoxLayout(row)
        rl.setContentsMargins(18, 13, 18, 13)
        rl.setSpacing(13)
        kind = str(a.get("kind") or "contract")
        glyph = {"transfer": "↕", "token-transfer": "↕", "swap": "⇄",
                 "approval": "✓", "nft": "🖼"}.get(kind, "•")
        ic = QLabel(glyph)
        ic.setFixedSize(34, 34)
        ic.setAlignment(Qt.AlignCenter)
        ic.setStyleSheet(f"background:{tok['elevated']};border:1px solid {tok['line']};"
                         f"border-radius:10px;color:{tok['ink_muted']};")
        rl.addWidget(ic)
        col = QVBoxLayout()
        col.setSpacing(2)
        lead_row = QHBoxLayout()
        lead_row.setSpacing(8)
        lead = QLabel(str(a.get("summary") or kind.replace("-", " ").title()))
        lead.setStyleSheet("font-weight:650;font-size:14px;")
        lead_row.addWidget(lead)
        if a.get("flagged"):
            codes = a.get("warnings") or []
            flag = QLabel("⚠ " + (str(codes[0]) if codes else "flagged counterparty"))
            flag.setObjectName("flag")
            lead_row.addWidget(flag)
        lead_row.addStretch(1)
        col.addLayout(lead_row)
        cp = a.get("counterparty")
        meta = f"{self.wc.chain_label(a.get('chain'))} · {a.get('direction')}"
        if cp:
            meta += f" · {shorten(cp)}"
        m = QLabel(meta)
        m.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
        col.addLayout(_wrap(m))
        rl.addLayout(col, 1)
        if a.get("amountBase") is not None:
            val = QLabel(_amt_str(a.get("amountBase"), 18 if a.get("chain") in ("ethereum", "base") else 0))
            val.setStyleSheet(f"font-family:{MONO};font-size:13px;")
            val.setAlignment(Qt.AlignRight)
            rl.addWidget(val)
        return row


def _wrap(w: QWidget):
    lay = QHBoxLayout()
    lay.setContentsMargins(0, 0, 0, 0)
    lay.addWidget(w)
    lay.addStretch(1)
    return lay


class NftPanel(_ScrollPanel):
    """Gallery from ``nfts()`` — spam flag, metadata-unavailable tile, an operator-
    approval badge that opens revoke via the security approval manager."""

    def __init__(self, wc: WalletController, tok: Dict[str, str]):
        super().__init__(tok)
        self.wc = wc
        self.body.addWidget(_sec_head(tok, "NFTs", "0"))
        self.grid_host = QWidget()
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(14)
        self.body.addWidget(self.grid_host)
        self.note = QLabel(
            "🛡  Suspected-spam collections are flagged, not hidden. An open operator "
            "approval is shown with a revoke action.")
        self.note.setObjectName("faint")
        self.note.setWordWrap(True)
        self.body.addWidget(self.note)
        self.body.addStretch(1)
        self._head = self.body.itemAt(0).widget()

    def set_tokens(self, tok):
        super().set_tokens(tok)
        self.setStyleSheet(build_qss(tok))

    def refresh(self):
        accts = self.wc.accounts_list()
        if not accts:
            self._render({"items": [], "unavailable": [
                {"reason": "Unlock the vault to see your NFTs."}]}, {})
            return

        async def _load():
            inv = await nft_mod.nfts(accts, self.wc.nft_ctx())
            # operator-approval awareness: list approvals per account (if an
            # indexer is wired); surfaced so the gallery can offer revoke.
            approvals: Dict[str, Any] = {}
            for a in accts:
                try:
                    res = await security_mod.list_approvals(
                        a["chain"], a["address"], self.wc.security_ctx())
                    approvals[a["chain"]] = res
                except Exception:
                    pass
            return inv, approvals
        self.wc.run_async(_load(), on_done=lambda r: self._render(r[0], r[1]),
                          on_error=lambda e: self._render(
                              {"items": [], "unavailable": [{"reason": str(e)}]}, {}))

    def _operator_set(self, approvals: Dict[str, Any]) -> set:
        out = set()
        for res in (approvals or {}).values():
            for ap in (res.get("approvals") or []):
                if ap.get("operator") and ap.get("token"):
                    out.add(str(ap.get("token")).lower())
        return out

    def _render(self, inv: Dict[str, Any], approvals: Dict[str, Any]):
        while self.grid.count():
            it = self.grid.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        tok = self.tok
        items = inv.get("items") or []
        unavailable = inv.get("unavailable") or []
        operators = self._operator_set(approvals)
        if self._head is not None:
            cnt = self._head.layout().itemAt(1).widget()
            if isinstance(cnt, QLabel):
                cnt.setText(str(len(items)))
        if not items:
            reason = "No NFTs found."
            if unavailable:
                reason = "  ·  ".join(str(_field(u, "reason")) for u in unavailable)
            e = QLabel(reason)
            e.setObjectName("faint")
            e.setWordWrap(True)
            self.grid.addWidget(e, 0, 0)
            return
        cols = 3
        for i, n in enumerate(items):
            has_op = str(n.get("contract") or "").lower() in operators
            self.grid.addWidget(self._tile(n, i, has_op), i // cols, i % cols)

    def _tile(self, n: Dict[str, Any], idx: int, has_op: bool) -> QWidget:
        tok = self.tok
        card = QFrame()
        card.setObjectName("nft")
        cl = QVBoxLayout(card)
        cl.setContentsMargins(0, 0, 0, 10)
        cl.setSpacing(8)
        art = QLabel()
        art.setObjectName("nftArt" if n.get("metadataOk", True) else "unav")
        art.setFixedHeight(130)
        art.setAlignment(Qt.AlignCenter)
        if not n.get("metadataOk", True):
            art.setText("metadata\nunavailable")
        else:
            hue = _chain_hue(tok, idx)
            art.setStyleSheet(f"background:{hue};border-top-left-radius:{RADIUS}px;"
                              f"border-top-right-radius:{RADIUS}px;font-size:30px;")
            art.setText("🖼")
        cl.addWidget(art)
        badges = QHBoxLayout()
        badges.setContentsMargins(10, 0, 10, 0)
        badges.setSpacing(6)
        if n.get("spam"):
            b = QLabel("SPAM?")
            b.setObjectName("spam")
            badges.addWidget(b)
        if has_op:
            b = QLabel("APPROVAL")
            b.setObjectName("approval")
            b.setCursor(Qt.PointingHandCursor)
            badges.addWidget(b)
        badges.addStretch(1)
        cl.addLayout(badges)
        meta = QVBoxLayout()
        meta.setContentsMargins(12, 0, 12, 0)
        meta.setSpacing(1)
        nm = QLabel(str(n.get("name") or f"#{n.get('tokenId')}"))
        nm.setStyleSheet("font-weight:650;font-size:13px;")
        col = QLabel(str(n.get("collection") or "—"))
        col.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
        meta.addWidget(nm)
        meta.addWidget(col)
        cl.addLayout(meta)
        btns = QHBoxLayout()
        btns.setContentsMargins(12, 2, 12, 0)
        btns.setSpacing(6)
        send = QPushButton("Send")
        send.clicked.connect(lambda: self._send_nft(n))
        btns.addWidget(send)
        if has_op:
            rev = QPushButton("Revoke")
            rev.setObjectName("danger")
            rev.clicked.connect(lambda: self._revoke(n))
            btns.addWidget(rev)
        btns.addStretch(1)
        cl.addLayout(btns)
        return card

    def _send_nft(self, n: Dict[str, Any]):
        # build the transfer calldata, inspect it, then route through the gate.
        async def _flow():
            accts = {a["chain"]: a["address"] for a in self.wc.accounts_list()}
            frm = accts.get(n.get("chain"))
            req = {"chain": n.get("chain"), "standard": n.get("standard"),
                   "contract": n.get("contract"), "tokenId": n.get("tokenId"),
                   "from": frm, "to": frm, "amount": 1,
                   "ownedBalance": n.get("balance") or 1}
            try:
                built = nft_mod.build_nft_transfer(req, {"accounts": accts})
            except Exception as e:
                return {"error": f"cannot build transfer: {e}"}
            insp = await security_mod.inspect_transaction(
                built.get("tx") or built, self.wc.security_ctx())
            return {"inspection": insp}
        self.wc.run_async(_flow(), on_done=self._after_nft_build,
                          on_error=lambda e: QMessageBox.warning(self, "Send NFT", str(e)))

    def _after_nft_build(self, out: Dict[str, Any]):
        if out.get("error"):
            QMessageBox.warning(self, "Send NFT", out["error"])
            return
        SecurityConfirmSheet(self.tok, out["inspection"], title="Review NFT transfer",
                             parent=self).exec()

    def _revoke(self, n: Dict[str, Any]):
        # build approve(spender, 0) via the approval manager; inspect; gate.
        async def _flow():
            tx = security_mod.build_revoke(n.get("chain"), n.get("contract"), n.get("operator") or "")
            insp = await security_mod.inspect_transaction(tx, self.wc.security_ctx())
            return {"inspection": insp}
        self.wc.run_async(_flow(),
                          on_done=lambda o: SecurityConfirmSheet(
                              self.tok, o["inspection"], title="Revoke operator approval",
                              parent=self).exec(),
                          on_error=lambda e: QMessageBox.warning(self, "Revoke", str(e)))


class ConnectPanel(_ScrollPanel):
    """WalletConnect sessions + paste-URI connect. The proposal review sheet and
    the per-request SIGNATURE/SEND approval sheet are driven by the WC core."""

    def __init__(self, wc: WalletController, tok: Dict[str, str]):
        super().__init__(tok)
        self.wc = wc
        self.body.addWidget(_sec_head(tok, "Connected dApps", "WalletConnect"))
        card = QFrame()
        card.setObjectName("card")
        cl = QVBoxLayout(card)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(0)
        paste = QWidget()
        pl = QHBoxLayout(paste)
        pl.setContentsMargins(16, 14, 16, 14)
        pl.setSpacing(9)
        self.uri = QLineEdit()
        self.uri.setPlaceholderText("Paste a WalletConnect URI (wc:…@2)")
        pl.addWidget(self.uri, 1)
        connect = QPushButton("Connect")
        connect.setObjectName("primary")
        connect.clicked.connect(self._connect)
        pl.addWidget(connect)
        cl.addWidget(paste)
        self.sessions_host = QWidget()
        self.sessions_lay = QVBoxLayout(self.sessions_host)
        self.sessions_lay.setContentsMargins(0, 0, 0, 0)
        self.sessions_lay.setSpacing(0)
        cl.addWidget(self.sessions_host)
        self.body.addWidget(card)
        hint = QLabel(
            "ⓘ  dApps are untrusted — every signing request needs your explicit "
            "approval and runs the security check. Nothing auto-signs.")
        hint.setObjectName("faint")
        hint.setWordWrap(True)
        self.body.addWidget(hint)
        self.body.addStretch(1)

    def set_tokens(self, tok):
        super().set_tokens(tok)
        self.setStyleSheet(build_qss(tok))

    def refresh(self):
        if not self.wc.ready():
            self._render([])
            return
        self.wc.run_async(self.wc.wallet_connect().list_sessions(),
                          on_done=self._render,
                          on_error=lambda e: self._render([]))

    def _render(self, sessions: List[Any]):
        while self.sessions_lay.count():
            it = self.sessions_lay.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        tok = self.tok
        sessions = sessions or []
        if not sessions:
            e = QLabel("  No active sessions. Paste a WalletConnect URI to connect a dApp.")
            e.setObjectName("faint")
            e.setStyleSheet(f"color:{tok['ink_faint']};padding:16px;")
            self.sessions_lay.addWidget(e)
            return
        for i, s in enumerate(sessions):
            self.sessions_lay.addWidget(self._row(s, i, len(sessions)))

    def _row(self, s: Dict[str, Any], idx: int, total: int) -> QWidget:
        tok = self.tok
        dapp = (s or {}).get("dapp") or {}
        row = QFrame()
        row.setObjectName("row" if idx < total - 1 else "")
        rl = QHBoxLayout(row)
        rl.setContentsMargins(18, 15, 18, 15)
        rl.setSpacing(13)
        logo = QLabel("🔗")
        logo.setFixedSize(38, 38)
        logo.setAlignment(Qt.AlignCenter)
        logo.setStyleSheet(f"background:{tok['elevated']};border:1px solid {tok['line']};"
                           f"border-radius:10px;font-size:17px;")
        rl.addWidget(logo)
        col = QVBoxLayout()
        col.setSpacing(4)
        nm = QLabel(str(dapp.get("name") or "dApp"))
        nm.setStyleSheet("font-weight:650;font-size:14px;")
        url = QLabel(str(dapp.get("url") or ""))
        url.setStyleSheet(f"color:{tok['ink_muted']};font-size:12px;")
        col.addWidget(nm)
        col.addWidget(url)
        methods = []
        for ns in (s.get("namespaces") or {}).values():
            methods.extend(ns.get("methods") or [])
        if methods:
            flow = QHBoxLayout()
            flow.setSpacing(6)
            for m in methods[:4]:
                p = QLabel(str(m))
                p.setObjectName("mchip")
                flow.addWidget(p)
            flow.addStretch(1)
            col.addLayout(flow)
        rl.addLayout(col, 1)
        disc = QPushButton("✕")
        disc.setObjectName("ghostIcon")
        disc.clicked.connect(lambda: self._disconnect(s.get("topic")))
        rl.addWidget(disc)
        return row

    def _disconnect(self, topic):
        if not topic:
            return
        self.wc.run_async(self.wc.wallet_connect().disconnect(topic),
                          on_done=lambda _: self.refresh(),
                          on_error=lambda e: QMessageBox.warning(self, "Disconnect", str(e)))

    def _connect(self):
        uri = self.uri.text().strip()
        if not uri:
            return
        # parse + pair (rejects v1/malformed). With a LIVE relay configured, pairing
        # subscribes the pairing topic and the dApp's session proposal arrives over
        # the relay -> the review sheet opens -> approve settles only controlled
        # chains. Without a relay (no projectId), pairing surfaces the parse result
        # and the honest "no relay configured" note — never a fake grant.
        try:
            parsed = wc_mod.parse_pairing_uri(uri)
        except Exception as e:
            QMessageBox.warning(self, "Connect", f"Invalid URI: {e}")
            return
        has_relay = self.wc.ready() and self.wc.ensure_relay_wired()
        if has_relay:
            self.wc.run_async(
                self.wc.wallet_connect().pair(uri),
                on_done=lambda _p: QMessageBox.information(
                    self, "Connect",
                    f"Paired topic {shorten(parsed.get('topic'))} (v{parsed.get('version')}).\n"
                    "Waiting for the dApp's session proposal — the review sheet will "
                    "open when it arrives. Nothing is granted until you approve."),
                on_error=lambda e: QMessageBox.warning(self, "Connect", str(e)))
            self.uri.clear()
            return
        QMessageBox.information(
            self, "Connect",
            f"Paired topic {shorten(parsed.get('topic'))} (v{parsed.get('version')}).\n"
            "No relay transport is configured (set a WalletConnect projectId under "
            "Endpoints) — nothing is granted.")

    # --- the per-request approval + danger confirm sheets (GUI-thread slots) ---
    def show_proposal(self, review: Dict[str, Any]) -> bool:
        return ProposalReviewSheet(self.tok, review, parent=self).exec() == QDialog.Accepted

    def show_proposal_request(self, review: Dict[str, Any], resolver):
        """GUI-thread slot: a dApp session proposal arrived over the LIVE relay.
        Show the review sheet; the resolver settles the worker-loop future so the
        core approves (settling only controlled chains) or rejects."""
        accepted = self.show_proposal(review)
        resolver(accepted)
        if accepted:
            self.refresh()

    def show_approval(self, presentation: Dict[str, Any], resolver):
        insp = (presentation or {}).get("inspection") or {}
        dapp = (presentation or {}).get("dapp") or {}
        label = f"{dapp.get('name') or 'dApp'} · {dapp.get('url') or ''}  —  {presentation.get('method')}"
        sheet = SecurityConfirmSheet(self.tok, insp, title="Signature / send request",
                                     dapp=label, parent=self)
        resolver(sheet.exec() == QDialog.Accepted)

    def show_danger(self, presentation: Dict[str, Any], resolver):
        # the danger confirm is handled within the approval sheet's extra confirm;
        # when the WC core asks for a standalone danger confirm, reuse the sheet.
        self.show_approval(presentation, resolver)


class AddressBookPanel(_ScrollPanel):
    """Contacts with ENS/SNS/saved badges; Send resolves + inspects the name."""

    open_send = Signal(str, str)  # (chain, label-or-address)

    def __init__(self, wc: WalletController, tok: Dict[str, str]):
        super().__init__(tok)
        self.wc = wc
        head = _sec_head(tok, "Address book", "0")
        add = QPushButton("+ Add contact")
        add.clicked.connect(self._add)
        head.layout().addWidget(add)
        self.body.addWidget(head)
        self._head = head
        self.card = QFrame()
        self.card.setObjectName("card")
        self.rows_lay = QVBoxLayout(self.card)
        self.rows_lay.setContentsMargins(0, 0, 0, 0)
        self.rows_lay.setSpacing(0)
        self.body.addWidget(self.card)
        self.body.addStretch(1)

    def set_tokens(self, tok):
        super().set_tokens(tok)
        self.setStyleSheet(build_qss(tok))

    def refresh(self):
        if not self.wc.ready():
            self._render([])
            return
        self.wc.run_async(self.wc.book().list(), on_done=self._render,
                          on_error=lambda e: self._render([]))

    def _render(self, contacts: List[Dict[str, Any]]):
        while self.rows_lay.count():
            it = self.rows_lay.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        tok = self.tok
        contacts = contacts or []
        cnt = self._head.layout().itemAt(1).widget()
        if isinstance(cnt, QLabel):
            cnt.setText(str(len(contacts)))
        if not contacts:
            e = QLabel("  No saved contacts yet.")
            e.setObjectName("faint")
            e.setStyleSheet(f"color:{tok['ink_faint']};padding:16px 18px;")
            self.rows_lay.addWidget(e)
            return
        for i, c in enumerate(contacts):
            self.rows_lay.addWidget(self._row(c, i, len(contacts)))

    def _badge_for(self, label: str) -> str:
        low = str(label or "").lower()
        if low.endswith(".eth"):
            return "ENS"
        if low.endswith(".sol"):
            return "SNS"
        return "saved"

    def _row(self, c: Dict[str, Any], idx: int, total: int) -> QWidget:
        tok = self.tok
        row = QFrame()
        row.setObjectName("row" if idx < total - 1 else "")
        rl = QHBoxLayout(row)
        rl.setContentsMargins(18, 13, 18, 13)
        rl.setSpacing(13)
        label = str(c.get("label") or "?")
        hue = _chain_hue(tok, idx)
        av = QLabel(label[:2].upper())
        av.setFixedSize(32, 32)
        av.setAlignment(Qt.AlignCenter)
        av.setStyleSheet(f"background:{hue};color:white;border-radius:16px;font-weight:800;font-size:11px;")
        rl.addWidget(av)
        col = QVBoxLayout()
        col.setSpacing(2)
        top = QHBoxLayout()
        top.setSpacing(8)
        nm = QLabel(label)
        nm.setStyleSheet("font-weight:650;font-size:14px;")
        top.addWidget(nm)
        badge = QLabel(self._badge_for(label))
        badge.setObjectName("mchip")
        top.addWidget(badge)
        top.addStretch(1)
        col.addLayout(top)
        addr = QLabel(shorten(c.get("address")))
        addr.setStyleSheet(f"color:{tok['ink_muted']};font-family:{MONO};font-size:12px;")
        col.addWidget(addr)
        rl.addLayout(col, 1)
        send = QPushButton("↗ Send")
        send.clicked.connect(lambda: self.open_send.emit(c.get("chain") or "", label))
        rl.addWidget(send)
        return row

    def _add(self):
        from PySide6.QtWidgets import QInputDialog
        label, ok = QInputDialog.getText(self, "Add contact", "Label (or name.eth / name.sol):")
        if not ok or not label.strip():
            return
        address, ok = QInputDialog.getText(self, "Add contact", "Address:")
        if not ok or not address.strip():
            return
        self.wc.run_async(self.wc.book().add({"label": label.strip(), "address": address.strip()}),
                          on_done=lambda _: self.refresh(),
                          on_error=lambda e: QMessageBox.warning(self, "Add contact", str(e)))


# =========================================================================== #
# WalletPanel — the five-surface tab host + header + theme toggle.             #
# =========================================================================== #
class MiningPanel(QWidget):
    """Merge-mine BLOCK from the wallet. Blockle is merge-mined, so this doesn't hash in-process
    (Python is too slow for these algos) — it picks an algorithm, auto-fills the Blockle pool
    stratum + your BLOCK payout address, and launches an EXTERNAL miner binary you point to. Live
    algos mine now; others light up as their pools come online."""

    def __init__(self, wc: Any, tok: Any):
        super().__init__()
        self.wc = wc
        self.tok = tok
        self.payout = ""
        self._proc = None
        from PySide6.QtWidgets import (QVBoxLayout, QHBoxLayout, QLabel, QComboBox, QLineEdit,
                                       QPushButton, QPlainTextEdit, QFormLayout)
        from . import mining
        self._mining = mining

        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(10)
        intro = QLabel("Merge-mine BLOCK: point a miner at a Blockle pool and earn BLOCK alongside the parent chain — no extra power.")
        intro.setWordWrap(True)
        intro.setObjectName("muted")
        root.addWidget(intro)

        form = QFormLayout()
        self.algo = QComboBox()
        for a in mining.ALGOS:
            label = f"{a['algo']}  ·  {a['parent']}" if a["status"] == "live" else f"{a['algo']}  ·  (pool coming soon)"
            self.algo.addItem(label, a["algo"])
        self.algo.currentIndexChanged.connect(self._on_algo)
        form.addRow("Algorithm", self.algo)

        self.mode = QComboBox()
        self.mode.addItem("PPLNS (shared, steadier)", "pplns")
        self.mode.addItem("Solo (full block or nothing)", "solo")
        self.mode.currentIndexChanged.connect(self._refresh_cmd)
        form.addRow("Pool mode", self.mode)

        self.pool_lbl = QLabel("—")
        self.pool_lbl.setObjectName("mono")
        self.pool_lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        form.addRow("Pool", self.pool_lbl)

        self.payout_lbl = QLabel("unlock your wallet")
        self.payout_lbl.setObjectName("mono")
        self.payout_lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        form.addRow("BLOCK payout", self.payout_lbl)

        self.miner_path = QLineEdit()
        self.miner_path.setPlaceholderText("path to your miner binary (cpuminer, ccminer, SRBMiner…)")
        self.miner_path.textChanged.connect(self._refresh_cmd)
        form.addRow("Miner", self.miner_path)

        self.worker = QLineEdit("blockle")
        self.worker.textChanged.connect(self._refresh_cmd)
        form.addRow("Worker", self.worker)
        root.addLayout(form)

        self.cmd_lbl = QPlainTextEdit()
        self.cmd_lbl.setReadOnly(True)
        self.cmd_lbl.setFixedHeight(54)
        self.cmd_lbl.setObjectName("mono")
        root.addWidget(QLabel("Miner command"))
        root.addWidget(self.cmd_lbl)

        btns = QHBoxLayout()
        self.copy_btn = QPushButton("Copy command")
        self.copy_btn.setObjectName("ghost")
        self.copy_btn.clicked.connect(self._copy)
        self.start_btn = QPushButton("Start mining")
        self.start_btn.clicked.connect(self._start)
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.setObjectName("ghost")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self._stop)
        btns.addWidget(self.copy_btn)
        btns.addStretch(1)
        btns.addWidget(self.stop_btn)
        btns.addWidget(self.start_btn)
        root.addLayout(btns)

        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setObjectName("mono")
        root.addWidget(self.log, 1)

        self.refresh()
        self._on_algo()

    def set_tokens(self, tok: Any):
        self.tok = tok

    def refresh(self):
        try:
            accts = self.wc.accounts_list() or []
        except Exception:
            accts = []
        blk = next((a.get("address") for a in accts if str(a.get("chain", "")).lower() == "block"), None)
        self.payout = blk or (accts[0].get("address") if accts else "")
        self.payout_lbl.setText(self.payout or "unlock your wallet to mine to your address")
        self._refresh_cmd()

    def _cur_algo(self):
        return self.algo.currentData()

    def _on_algo(self):
        a = self._mining.get_algo(self._cur_algo()) or {}
        live = a.get("status") == "live"
        url = self._mining.stratum_url(self._cur_algo(), self.mode.currentData())
        self.pool_lbl.setText(url if url else "pool coming soon — this algorithm isn't live yet")
        hint = a.get("miner", "")
        if hint:
            self.miner_path.setToolTip("Suggested: " + hint)
        self.start_btn.setEnabled(live)
        self._refresh_cmd()

    def _build_cmd(self):
        return self._mining.miner_command(self.miner_path.text().strip(), self._cur_algo(),
                                          self.payout, mode=self.mode.currentData(),
                                          worker=self.worker.text().strip() or "blockle")

    def _refresh_cmd(self):
        cmd = self._build_cmd()
        self.cmd_lbl.setPlainText(" ".join(cmd) if cmd else
                                  "Select a live algorithm, point to your miner, and unlock your wallet.")

    def _copy(self):
        cmd = self._build_cmd()
        if cmd:
            from PySide6.QtWidgets import QApplication
            QApplication.clipboard().setText(" ".join(cmd))
            self.copy_btn.setText("Copied ✓")

    def _start(self):
        cmd = self._build_cmd()
        if not cmd:
            self.log.appendPlainText("Can't start: choose a live algorithm, a miner binary, and unlock your wallet.")
            return
        from PySide6.QtCore import QProcess
        self._proc = QProcess(self)
        self._proc.setProcessChannelMode(QProcess.MergedChannels)
        self._proc.readyReadStandardOutput.connect(
            lambda: self.log.appendPlainText(bytes(self._proc.readAllStandardOutput()).decode("utf-8", "replace").rstrip()))
        self._proc.finished.connect(self._on_finished)
        self.log.appendPlainText("$ " + " ".join(cmd))
        self._proc.start(cmd[0], cmd[1:])
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)

    def _stop(self):
        if self._proc:
            self._proc.terminate()

    def _on_finished(self, *_):
        self.log.appendPlainText("— miner stopped —")
        self.start_btn.setEnabled(self._mining.is_live(self._cur_algo()))
        self.stop_btn.setEnabled(False)
        self._proc = None


class WalletPanel(QWidget):
    def __init__(self, ctrl: Any, theme: str = "dark"):
        super().__init__()
        self.setObjectName("walletRoot")
        self.ctrl = ctrl
        self.wc = WalletController(ctrl)
        self.theme = theme if theme in ("dark", "light") else "dark"
        self.tok = TOKENS_DARK if self.theme == "dark" else TOKENS_LIGHT

        root = QVBoxLayout(self)
        root.setContentsMargins(18, 14, 18, 14)
        root.setSpacing(10)

        # No redundant brand/top bar — the window title + tab bar already say "Blockle Wallet".
        # Keep only a slim right-aligned utility row: the active-account chip + theme toggle.
        header = QHBoxLayout()
        header.addStretch(1)
        self.acct_chip = QLabel("locked")
        self.acct_chip.setObjectName("mchip")
        header.addWidget(self.acct_chip)
        self.theme_btn = QPushButton("☾" if self.theme == "dark" else "☀")
        self.theme_btn.setObjectName("ghostIcon")
        self.theme_btn.setToolTip("Toggle light / dark theme")
        self.theme_btn.clicked.connect(self._toggle_theme)
        header.addWidget(self.theme_btn)
        root.addLayout(header)

        from PySide6.QtWidgets import QTabWidget
        self.tabs = QTabWidget()
        self.portfolio = PortfolioPanel(self.wc, self.tok)
        self.activity = ActivityPanel(self.wc, self.tok)
        self.nfts = NftPanel(self.wc, self.tok)
        self.connect = ConnectPanel(self.wc, self.tok)
        self.book = AddressBookPanel(self.wc, self.tok)
        self.mining = MiningPanel(self.wc, self.tok)
        self.tabs.addTab(self.portfolio, "Portfolio")
        self.tabs.addTab(self.activity, "Activity")
        self.tabs.addTab(self.nfts, "NFTs")
        self.tabs.addTab(self.mining, "Mining")
        self.tabs.addTab(self.connect, "Connect")
        self.tabs.addTab(self.book, "Address book")
        root.addWidget(self.tabs, 1)

        # wiring
        self.portfolio.open_send.connect(lambda: self._open_send(None, None))
        self.book.open_send.connect(lambda chain, to: self._open_send(chain or None, to))
        self.tabs.currentChanged.connect(self._on_tab)
        # the dApp approval + danger confirm bridges -> the Connect panel's sheets
        self.wc.approval_requested.connect(self.connect.show_approval, Qt.QueuedConnection)
        self.wc.danger_requested.connect(self.connect.show_danger, Qt.QueuedConnection)
        self.wc.proposal_requested.connect(self.connect.show_proposal_request, Qt.QueuedConnection)

        self.setStyleSheet(build_qss(self.tok))
        self._refresh_acct()
        self.portfolio.refresh()

        self._timer = QTimer(self)
        self._timer.setInterval(8000)
        self._timer.timeout.connect(self._periodic)
        self._timer.start()

    # ---- theme ----
    def _toggle_theme(self):
        self.theme = "light" if self.theme == "dark" else "dark"
        self.tok = TOKENS_DARK if self.theme == "dark" else TOKENS_LIGHT
        self.theme_btn.setText("☾" if self.theme == "dark" else "☀")
        for p in (self.portfolio, self.activity, self.nfts, self.mining, self.connect, self.book):
            p.set_tokens(self.tok)
        self.setStyleSheet(build_qss(self.tok))
        self._refresh_current()

    def _refresh_acct(self):
        accts = self.wc.accounts_list()
        if accts:
            self.acct_chip.setText(shorten(accts[0]["address"]))
        else:
            self.acct_chip.setText("locked")

    def _on_tab(self, _idx: int):
        self._refresh_acct()
        self._refresh_current()

    def _refresh_current(self):
        w = self.tabs.currentWidget()
        if hasattr(w, "refresh"):
            w.refresh()

    def _periodic(self):
        # a gentle refresh of the live surface only (reads real engines; no money)
        w = self.tabs.currentWidget()
        if w is self.portfolio:
            self.portfolio.refresh()

    def _open_send(self, chain: Optional[str], to: Optional[str]):
        sheet = SendSheet(self.wc, self.tok, prefill_chain=chain, prefill_to=to, parent=self)
        sheet.exec()


def build_wallet_tab(ctrl: Any, theme: str = "dark"):
    """Return ``(WalletPanel, "Wallet")`` for the wallet's tab bar, sharing the
    given :class:`~blockle.qtmultichain.MultiChainController`."""
    return WalletPanel(ctrl, theme=theme), "Wallet"
