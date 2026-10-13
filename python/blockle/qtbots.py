"""blockle.qtbots — the native "Blockle Bots" Qt panel (PySide6).

A persistent, non-custodial trading-bot cockpit layered on the in-wallet agent +
strategy engine. It is the Python/Qt sibling of the extension (JS) and app (Dart)
Bots UIs, and it matches ``docs/design/bots/index.html`` — the shared visual
contract (color ramp, type scale, spacing, radius; theme-aware light + dark).

HARD RULE (same as the whole platform): this module renders and dispatches ONLY.
Every bit of data on every surface comes from the REAL engine modules already in
this wallet — :mod:`blockle.agent.bots`, :mod:`~blockle.agent.bot_runner`,
:mod:`~blockle.agent.bot_templates`, :mod:`~blockle.agent.arena`,
:mod:`~blockle.agent.notify`. There is NO mock/placeholder data and NO new money
path. The UI never signs or broadcasts; it calls the runner's gated methods
(``add`` / ``arm_live`` / ``enable_paper`` / ``pause`` / ``tick_all`` /
``kill_all`` / ``dashboard`` / ``aggregate``), and arming LIVE always goes through
a plain-language REVIEW sheet (never a silent flip). Arena is pure play-money
simulation that touches no key, no vault, no gate, no broadcast.

Four surfaces, one widget (:class:`BotsPanel`):
  * COCKPIT  — aggregate P&L hero + sparkline, a prominent KILL-ALL, a Paper/Live
    filter, and a grid of bot cards (name, type chip, pair, mode badge, status
    dot, allocation bar vs allocationUsd, today's P&L).
  * CREATE   — SIMPLE (template gallery → pair → one amount → plain-language
    preview → Start in paper / Go live) + an ADVANCED drawer driving a LIVE
    deal-ladder preview (base / safety ladder / avg entry / take-profit).
  * DETAIL   — the deal as a vertical stepper, realized/unrealized tiles,
    allocation, win rate, pause/resume/clone/edit/stop + a per-bot kill.
  * ARENA    — play balance, scenario picker, Run, animated play P&L + score +
    XP/level + a mission + badges + a local leaderboard + the persistent
    disclaimer + the honest "use this for real" on-ramp.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtCore import QPointF, QRectF
from PySide6.QtWidgets import (
    QButtonGroup, QComboBox, QDialog, QDialogButtonBox, QFrame, QGridLayout,
    QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton, QScrollArea,
    QSizePolicy, QSlider, QStackedWidget, QVBoxLayout, QWidget,
)

from . import agent as agentpkg
from .agent import arena as arena_mod
from .agent import bot_templates as templates_mod
from .agent import bots as bots_mod
from .agent import notify as notify_mod


# =========================================================================== #
# DESIGN TOKENS — ported verbatim from docs/design/bots/index.html :root.      #
# One source of truth across all three wallets; here as a Python palette so the #
# QSS stylesheet and the QPainter canvases read the exact same ramp.           #
# =========================================================================== #
TOKENS_DARK: Dict[str, str] = {
    "ground": "#0b0f15", "surface": "#141b24", "elevated": "#1d2630",
    "line": "#27333f", "line_soft": "#1f2932",
    "ink": "#e8edf3", "ink_muted": "#8795a4", "ink_faint": "#5d6b79",
    "accent": "#4c8dff", "accent_dim": "#2b4a86",
    "gain": "#2fd39b", "loss": "#f0536a", "warn": "#f0a732",
    "k_base": "#4c8dff", "k_safety": "#f0a732", "k_tp": "#2fd39b",
}
TOKENS_LIGHT: Dict[str, str] = {
    "ground": "#f3f5f8", "surface": "#ffffff", "elevated": "#ffffff",
    "line": "#dde3ea", "line_soft": "#e8edf2",
    "ink": "#11212f", "ink_muted": "#5a6b7b", "ink_faint": "#93a1af",
    "accent": "#2f6ff0", "accent_dim": "#a9c6ff",
    "gain": "#0c9e6f", "loss": "#d83a52", "warn": "#c6830f",
    "k_base": "#2f6ff0", "k_safety": "#c6830f", "k_tp": "#0c9e6f",
}
RADIUS, RADIUS_SM = 14, 9


def _ghost(hex_color: str, alpha: int = 0x1f) -> str:
    """rgba() ghost fill from a #rrggbb token (Qt QSS has no 8-digit hex)."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha/255:.3f})"


def _qc(hex_color: str, alpha: int = 255) -> QColor:
    c = QColor(hex_color)
    c.setAlpha(alpha)
    return c


MONO = "Menlo, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', monospace"


def build_qss(tok: Dict[str, str]) -> str:
    """Generate the panel stylesheet from a token set (light or dark)."""
    accent_ghost = _ghost(tok["accent"], 0x1f)
    gain_ghost = _ghost(tok["gain"], 0x1f)
    loss_ghost = _ghost(tok["loss"], 0x2a)
    return f"""
    #botsRoot {{ background: {tok['ground']}; color: {tok['ink']};
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }}
    #botsRoot QLabel {{ color: {tok['ink']}; background: transparent; }}
    #botsRoot QScrollArea, #botsRoot QScrollArea > QWidget > QWidget {{ background: transparent; border: 0; }}

    QLabel#eyebrow {{ color: {tok['ink_faint']}; font-size: 10px; font-weight: 700;
        letter-spacing: 2px; }}
    QLabel#heroBig {{ font-size: 40px; font-weight: 800; letter-spacing: -1px; }}
    QLabel#sub {{ color: {tok['ink_muted']}; font-size: 12px; }}
    QLabel#mono {{ font-family: {MONO}; }}
    QLabel#pos {{ color: {tok['gain']}; }}
    QLabel#neg {{ color: {tok['loss']}; }}

    QFrame#card {{ background: {tok['surface']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS}px; }}
    QFrame#tile {{ background: {tok['surface']}; border: 1px solid {tok['line_soft']};
        border-radius: {RADIUS_SM}px; }}
    QFrame#bot {{ background: {tok['surface']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS}px; }}
    QFrame#bot:hover {{ border: 1px solid {tok['accent_dim']}; }}

    QLabel#chip {{ border: 1px solid {tok['line']}; color: {tok['ink_muted']};
        background: {tok['elevated']}; border-radius: 7px; padding: 2px 8px;
        font-size: 10px; font-weight: 700; }}
    QLabel#chipType {{ color: {tok['accent']}; border: 1px solid {tok['accent_dim']};
        background: {accent_ghost}; border-radius: 7px; padding: 2px 8px;
        font-size: 10px; font-weight: 700; }}
    QLabel#badgeLive {{ color: white; background: {tok['gain']}; border-radius: 10px;
        padding: 2px 9px; font-size: 10px; font-weight: 800; }}
    QLabel#badgePaper {{ color: {tok['accent']}; background: transparent;
        border: 1px solid {tok['accent_dim']}; border-radius: 10px; padding: 2px 9px;
        font-size: 10px; font-weight: 800; }}
    QLabel#warnPill {{ color: #2a1a00; background: {tok['warn']}; border-radius: 10px;
        padding: 1px 7px; font-size: 9px; font-weight: 800; }}

    #botsRoot QPushButton {{ background: {tok['elevated']}; border: 1px solid {tok['line']};
        border-radius: 10px; padding: 9px 15px; font-weight: 700; color: {tok['ink']}; }}
    #botsRoot QPushButton:hover {{ border: 1px solid {tok['accent_dim']}; }}
    QPushButton#primary {{ background: {tok['accent']}; border: 1px solid {tok['accent']};
        color: white; }}
    QPushButton#primary:hover {{ background: {tok['accent']}; border: 1px solid {tok['accent']}; }}
    QPushButton#kill {{ color: {tok['loss']}; background: {loss_ghost};
        border: 1px solid {tok['loss']}; border-radius: 10px; font-weight: 800; }}
    QPushButton#kill:hover {{ color: white; background: {tok['loss']}; }}
    QPushButton#seg {{ background: {tok['surface']}; border: 1px solid {tok['line']};
        border-radius: 8px; padding: 6px 14px; color: {tok['ink_muted']}; font-weight: 700; }}
    QPushButton#seg:checked {{ background: {tok['elevated']}; color: {tok['ink']};
        border: 1px solid {tok['accent_dim']}; }}
    QPushButton#tpl {{ text-align: left; background: {tok['elevated']};
        border: 1px solid {tok['line']}; border-radius: {RADIUS_SM}px; padding: 11px;
        color: {tok['ink']}; font-weight: 700; }}
    QPushButton#tpl:checked {{ border: 1px solid {tok['accent']}; background: {accent_ghost}; }}
    QPushButton#scen {{ background: {tok['elevated']}; border: 1px solid {tok['line']};
        border-radius: 14px; padding: 6px 12px; color: {tok['ink_muted']}; font-weight: 700; }}
    QPushButton#scen:checked {{ color: {tok['ink']}; border: 1px solid {tok['accent']};
        background: {accent_ghost}; }}
    QPushButton#advToggle {{ background: transparent; border: 0; border-top: 1px solid {tok['line']};
        color: {tok['ink_muted']}; text-align: left; padding: 12px 2px 2px; font-weight: 700; }}

    #botsRoot QLineEdit {{ background: {tok['elevated']}; border: 1px solid {tok['line']};
        border-radius: {RADIUS_SM}px; padding: 10px 12px; color: {tok['ink']};
        font-family: {MONO}; selection-background-color: {tok['accent']}; }}
    #botsRoot QLineEdit:focus {{ border: 1px solid {tok['accent']}; }}

    QLabel#preview {{ background: {accent_ghost}; border: 1px solid {tok['accent_dim']};
        border-radius: {RADIUS_SM}px; padding: 13px 14px; font-size: 13px; }}
    QLabel#note {{ color: {tok['ink_faint']}; border: 1px dashed {tok['line']};
        border-radius: {RADIUS_SM}px; padding: 12px 14px; font-size: 12px; }}
    QLabel#disclaim {{ color: {tok['ink_faint']}; font-size: 11px; }}

    #botsRoot QTabWidget::pane {{ border: 0; }}
    #botsRoot QTabBar::tab {{ background: transparent; color: {tok['ink_muted']};
        padding: 9px 15px; font-weight: 700; border: 0; }}
    #botsRoot QTabBar::tab:selected {{ color: {tok['ink']}; border-bottom: 2px solid {tok['accent']}; }}

    QSlider::groove:horizontal {{ height: 5px; background: {tok['line']}; border-radius: 3px; }}
    QSlider::handle:horizontal {{ width: 15px; height: 15px; margin: -6px 0;
        border-radius: 8px; background: {tok['accent']}; border: 3px solid {tok['surface']}; }}
    QScrollBar:vertical {{ background: transparent; width: 10px; }}
    QScrollBar::handle:vertical {{ background: {tok['line']}; border-radius: 5px; min-height: 30px; }}
    QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
    """


# =========================================================================== #
# formatting helpers (sign-explicit, monospace-friendly)                       #
# =========================================================================== #
def money(n: Optional[float], signed: bool = True) -> str:
    if n is None:
        return "—"
    sign = ("+" if n >= 0 else "−") if signed else ("" if n >= 0 else "−")
    return f"{sign}${abs(n):,.2f}"


def plain_money(n: Optional[float]) -> str:
    if n is None:
        return "—"
    return f"${n:,.0f}"


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here.parent, *here.parents]:
        if (p / "docs" / "arena-vectors.json").exists():
            return p
    return here.parents[2] if len(here.parents) >= 3 else here.parent


def load_arena_vectors() -> Dict[str, Any]:
    """Load the AUTHORITATIVE shared Arena fixture (docs/arena-vectors.json) —
    loaded, never regenerated, so a (scenario, config) scores identically across
    JS/Dart/Python."""
    path = _repo_root() / "docs" / "arena-vectors.json"
    with open(path, "r") as fh:
        return json.load(fh)


# =========================================================================== #
# CANVAS WIDGETS — QPainter ports of the reference charts (dataviz method:      #
# one axis, validated palette, thin marks, direct labels, legend).             #
# =========================================================================== #
class Sparkline(QWidget):
    """A filled area sparkline. ``up`` picks the gain/loss semantic color."""

    def __init__(self, tokens: Dict[str, str], mini: bool = False):
        super().__init__()
        self.tok = tokens
        self.mini = mini
        self.data: List[float] = []
        self.up = True
        self.setMinimumHeight(26 if mini else 72)
        if not mini:
            self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def set_data(self, data: List[float], up: Optional[bool] = None):
        self.data = list(data or [])
        if up is None and len(self.data) >= 2:
            up = self.data[-1] >= self.data[0]
        self.up = bool(up)
        self.update()

    def set_tokens(self, tokens: Dict[str, str]):
        self.tok = tokens
        self.update()

    def paintEvent(self, _ev):
        d = self.data
        if len(d) < 2:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        pad = 2 if self.mini else 6
        lo, hi = min(d), max(d)
        rng = (hi - lo) or 1.0
        col = _qc(self.tok["gain"] if self.up else self.tok["loss"])

        def X(i):
            return pad + i / (len(d) - 1) * (w - pad * 2)

        def Y(v):
            return h - pad - (v - lo) / rng * (h - pad * 2)

        area = QPainterPath()
        area.moveTo(X(0), Y(d[0]))
        for i in range(1, len(d)):
            area.lineTo(X(i), Y(d[i]))
        area.lineTo(X(len(d) - 1), h - pad)
        area.lineTo(X(0), h - pad)
        area.closeSubpath()
        fill = QColor(col)
        fill.setAlpha(52)
        p.fillPath(area, fill)

        line = QPainterPath()
        line.moveTo(X(0), Y(d[0]))
        for i in range(1, len(d)):
            line.lineTo(X(i), Y(d[i]))
        pen = QPen(col, 1.5 if self.mini else 2.0)
        pen.setJoinStyle(Qt.RoundJoin)
        p.setPen(pen)
        p.drawPath(line)
        if not self.mini:
            lx, ly = X(len(d) - 1), Y(d[-1])
            p.setBrush(col)
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(lx, ly), 3.5, 3.5)
        p.end()


class DealLadder(QWidget):
    """The live deal-ladder preview: base order, each safety order, avg-entry
    band, current price and take-profit — the §5a "math is visible" chart. Driven
    entirely by the real engine deal math (:mod:`blockle.agent.bots`)."""

    def __init__(self, tokens: Dict[str, str]):
        super().__init__()
        self.tok = tokens
        self.legs: List[Dict[str, Any]] = []
        self.avg = 0.0
        self.tp = 0.0
        self.price = 0.0
        self.lo = 0.0
        self.hi = 0.0
        self.setMinimumHeight(300)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def set_tokens(self, tokens):
        self.tok = tokens
        self.update()

    def set_deal(self, legs, avg, tp, price, lo, hi):
        self.legs, self.avg, self.tp, self.price = legs, avg, tp, price
        self.lo, self.hi = lo, hi
        self.update()

    def paintEvent(self, _ev):
        if not self.legs or self.hi <= self.lo:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        padL, padR, padT, padB = 56, 70, 14, 20
        lo = min(self.lo, self.avg) * 0.995
        hi = self.hi * 1.004
        rng = (hi - lo) or 1.0
        plotW = w - padL - padR

        def Y(v):
            return padT + (hi - v) / rng * (h - padT - padB)

        mono = QFont("Menlo")
        mono.setPointSize(8)
        p.setFont(mono)
        # gridlines + price axis
        for g in range(6):
            val = lo + rng * g / 5
            y = Y(val)
            p.setPen(QPen(_qc(self.tok["line_soft"]), 1))
            p.drawLine(QPointF(padL, y), QPointF(w - padR, y))
            p.setPen(_qc(self.tok["ink_faint"]))
            p.drawText(QRectF(0, y - 7, padL - 8, 14), Qt.AlignRight | Qt.AlignVCenter, f"${val:.1f}")
        # avg-entry band (accent ghost between current price and avg)
        ay, cy = Y(self.avg), Y(self.price)
        band = QColor(self.tok["accent"])
        band.setAlpha(28)
        p.fillRect(QRectF(padL, min(ay, cy), plotW, abs(cy - ay)), band)
        # current price (dashed)
        pen = QPen(_qc(self.tok["ink_muted"]), 1.2)
        pen.setDashPattern([4, 4])
        p.setPen(pen)
        p.drawLine(QPointF(padL, cy), QPointF(w - padR, cy))
        p.setPen(_qc(self.tok["ink_muted"]))
        p.drawText(QPointF(padL + 6, cy - 6), f"now ${self.price:.1f}")

        def marker(y, color, shape, label, usd):
            p.setPen(QPen(_qc(color), 2.5))
            mx = padL + plotW * 0.62
            p.drawLine(QPointF(padL, y), QPointF(mx, y))
            p.setBrush(_qc(color))
            p.setPen(Qt.NoPen)
            if shape == "diamond":
                poly = QPolygonF([QPointF(mx + 10, y - 5), QPointF(mx + 15, y),
                                  QPointF(mx + 10, y + 5), QPointF(mx + 5, y)])
                p.drawPolygon(poly)
            elif shape == "tri":
                poly = QPolygonF([QPointF(mx + 10, y - 5), QPointF(mx + 15, y + 4),
                                  QPointF(mx + 5, y + 4)])
                p.drawPolygon(poly)
            else:
                p.drawEllipse(QPointF(mx + 10, y), 4.0, 4.0)
            p.setPen(_qc(self.tok["ink_muted"]))
            p.drawText(QPointF(mx + 22, y + 4), label)
            if usd is not None:
                p.setPen(_qc(self.tok["ink_faint"]))
                p.drawText(QRectF(w - padR, y - 7, padR - 4, 14),
                           Qt.AlignRight | Qt.AlignVCenter, f"${round(usd)}")

        # take-profit (above), avg-entry dashed, then the buy ladder
        marker(Y(self.tp), self.tok["k_tp"], "tri", "TP", None)
        pen = QPen(_qc(self.tok["accent"]), 1.4)
        pen.setDashPattern([2, 3])
        p.setPen(pen)
        p.drawLine(QPointF(padL, ay), QPointF(w - padR, ay))
        p.setPen(_qc(self.tok["accent"]))
        p.drawText(QPointF(padL + 6, ay + 12), f"avg ${self.avg:.1f}")
        for i, lg in enumerate(self.legs):
            if lg["k"] == "base":
                marker(Y(lg["price"]), self.tok["k_base"], "diamond", "Base", lg["usd"])
            else:
                marker(Y(lg["price"]), self.tok["k_safety"], "circle", f"SO{i}", lg["usd"])
        p.end()


class ArenaSim(QWidget):
    """The simulated-market chart: the seeded price path + the bot's buy/sell
    fills, animatable up to ``upto`` (play P&L advances with it)."""

    def __init__(self, tokens: Dict[str, str]):
        super().__init__()
        self.tok = tokens
        self.path: List[float] = []
        self.fills: List[Dict[str, Any]] = []
        self.upto = 0
        self.setMinimumHeight(290)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def set_tokens(self, tokens):
        self.tok = tokens
        self.update()

    def set_run(self, path, fills, upto=None):
        self.path = list(path or [])
        self.fills = list(fills or [])
        self.upto = len(self.path) - 1 if upto is None else upto
        self.update()

    def set_upto(self, upto):
        self.upto = upto
        self.update()

    def paintEvent(self, _ev):
        path = self.path
        if len(path) < 2:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        padL, padR, padT, padB = 48, 14, 12, 16
        lo, hi = min(path), max(path)
        rng = (hi - lo) or 1.0
        lo -= rng * 0.08
        hi += rng * 0.08
        rng = hi - lo
        N = len(path)

        def X(i):
            return padL + i / (N - 1) * (w - padL - padR)

        def Y(v):
            return padT + (hi - v) / rng * (h - padT - padB)

        mono = QFont("Menlo")
        mono.setPointSize(8)
        p.setFont(mono)
        for g in range(5):
            val = lo + rng * g / 4
            y = Y(val)
            p.setPen(QPen(_qc(self.tok["line_soft"]), 1))
            p.drawLine(QPointF(padL, y), QPointF(w - padR, y))
            p.setPen(_qc(self.tok["ink_faint"]))
            p.drawText(QRectF(0, y - 7, padL - 6, 14), Qt.AlignRight | Qt.AlignVCenter, f"${val:.0f}")
        up = max(1, min(self.upto, N - 1))
        col = _qc(self.tok["accent"])
        area = QPainterPath()
        area.moveTo(X(0), Y(path[0]))
        for i in range(1, up + 1):
            area.lineTo(X(i), Y(path[i]))
        area.lineTo(X(up), h - padB)
        area.lineTo(X(0), h - padB)
        area.closeSubpath()
        fill = QColor(col)
        fill.setAlpha(40)
        p.fillPath(area, fill)
        line = QPainterPath()
        line.moveTo(X(0), Y(path[0]))
        for i in range(1, up + 1):
            line.lineTo(X(i), Y(path[i]))
        pen = QPen(col, 2.0)
        pen.setJoinStyle(Qt.RoundJoin)
        p.setPen(pen)
        p.drawPath(line)
        # fills so far (buy = base-color diamond, sell = tp-color triangle)
        for fl in self.fills:
            ti = fl.get("t", 0)
            if ti > up:
                continue
            x = X(ti)
            # price for the fill is stored in micro-dollars on the engine fill
            pr = fl.get("_price")
            if pr is None:
                continue
            y = Y(pr)
            if fl.get("side") == "buy":
                p.setBrush(_qc(self.tok["k_base"]))
                p.setPen(Qt.NoPen)
                poly = QPolygonF([QPointF(x, y - 4), QPointF(x + 4, y),
                                  QPointF(x, y + 4), QPointF(x - 4, y)])
                p.drawPolygon(poly)
            else:
                p.setBrush(_qc(self.tok["k_tp"]))
                p.setPen(QPen(_qc(self.tok["surface"]), 1.3))
                poly = QPolygonF([QPointF(x, y - 5), QPointF(x + 5, y + 4),
                                  QPointF(x - 5, y + 4)])
                p.drawPolygon(poly)
        p.end()


# =========================================================================== #
# LIVE MARKS — resolve a USD mark per symbol from the wallet's REAL Exchange     #
# book (the SAME non-custodial client the agent ctx trades through). Book mid     #
# (best bid + best ask)/2, falling back to the last trade. NEVER fabricates a     #
# price: a symbol with no USD-quoted market or no book/trade data resolves to     #
# None, so the engine correctly skips that tick (§5).                            #
# =========================================================================== #
#: stablecoins that denominate a USD market on the exchange (quote ≈ $1).
_USD_QUOTES = ("USDC", "USDT", "USD", "DAI", "USDBC", "PYUSD")


def _best_price(levels: Any) -> Optional[float]:
    """Best (top-of-book) price from a ladder of ``{price, amount}`` levels."""
    if not isinstance(levels, list) or not levels:
        return None
    try:
        p = float(levels[0].get("price"))
        return p if p > 0 else None
    except (TypeError, ValueError, AttributeError):
        return None


def _book_mid(book: Any) -> Optional[float]:
    """Mid of the top bid/ask; one-sided books fall back to the side present."""
    book = book or {}
    bid = _best_price(book.get("bids"))
    ask = _best_price(book.get("asks"))
    if bid is not None and ask is not None:
        return (bid + ask) / 2.0
    return bid if bid is not None else ask


def _last_trade(trades: Any) -> Optional[float]:
    """Price of the most recent trade (the exchange returns newest-first)."""
    if not isinstance(trades, list) or not trades:
        return None
    try:
        p = float(trades[0].get("price"))
        return p if p > 0 else None
    except (TypeError, ValueError, AttributeError):
        return None


def resolve_market_mark(sym: str, markets: Any, get_book, get_trades) -> Optional[float]:
    """USD mark for ``sym`` from a USD-quoted market on the live book.

    ``markets`` is the cached ``getMarkets`` list; ``get_book``/``get_trades`` are
    the exchange fetchers (called at most once, only for the matched market). A
    direct ``SYM/<usd>`` market prices SYM in USD; an inverse ``<usd>/SYM`` market
    is inverted. Returns None (never a synthetic mark) when nothing matches."""
    s = str(sym).upper()
    lst = markets or []
    direct = next((m for m in lst
                   if str(m.get("base")).upper() == s
                   and str(m.get("quote")).upper() in _USD_QUOTES), None)
    inverse = None
    if direct is None:
        inverse = next((m for m in lst
                        if str(m.get("quote")).upper() == s
                        and str(m.get("base")).upper() in _USD_QUOTES), None)
    m = direct or inverse
    if not m:
        return None
    market = m.get("market")
    try:
        price = _book_mid(get_book(market))
    except Exception:
        price = None
    if price is None:
        try:
            price = _last_trade(get_trades(market))
        except Exception:
            price = None
    if price is None or price <= 0:
        return None
    # direct: price is USD-per-SYM; inverse: price is SYM-per-USD -> invert.
    return price if direct is not None else (1.0 / price)


# =========================================================================== #
# BotsController — assembles the REAL engine for the UI.                        #
# =========================================================================== #
class BotsController(QObject):
    """Owns the real :class:`~blockle.agent.bot_runner.BotRunner` + a pure
    :class:`~blockle.agent.arena.ArenaProfile`, built from the shared
    :class:`~blockle.qtmultichain.MultiChainController` (vault, persistence store,
    chain ctx, async loop). The BotRunner is the ONE gated dispatch path; the UI
    only ever calls its methods. Arena needs no vault — it is play-only sim."""

    event = Signal(dict)  # runner events, marshalled onto the UI thread
    # run_async done/error callbacks, marshalled onto the UI thread. The async
    # loop lives on a WORKER thread (AgentLoop), so a future done-callback fires
    # OFF the GUI thread; these queued signals hop the callback back onto the GUI
    # thread before it ever touches a QWidget (QMessageBox / emit / refresh).
    _async_done = Signal(object, object)   # (callback, result)
    _async_error = Signal(object, object)  # (callback, exc)

    def __init__(self, ctrl: Any):
        super().__init__()
        self.ctrl = ctrl
        self.runner = None
        self._arena: Optional[arena_mod.ArenaProfile] = None
        self.vectors = load_arena_vectors()
        self.session_cap_usd = 1000.0
        # BotsController has GUI-thread affinity; because the emit happens on the
        # worker thread these AutoConnection slots run queued on the GUI thread.
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

    @property
    def loop(self):
        return self.ctrl.loop

    def _live_marks(self, symbols: Any) -> Dict[str, float]:
        """REAL USD marks for ``symbols`` fed to the engine each live/paper tick.

        Source order (never a fabricated price — §5):
          1. the wallet's live Exchange book (mid, else last trade) for a
             USD-quoted market — the SAME non-custodial client the agent ctx
             trades through; and
          2. the operator-configured USD price map (vault ``agent.priceUsd``,
             the python equivalent of the extension's ``settings.agent.priceUsd``)
             for any symbol the book cannot price.
        A symbol neither source can price is omitted, so the engine skips that
        tick (stablecoins are resolved by the engine's own $1 fallback)."""
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
                    mark = resolve_market_mark(sym, markets, ex.get_book, ex.get_trades)
                except Exception:
                    mark = None
                if mark is not None and mark > 0:
                    out[sym] = mark
        # supplemental configured map (only for symbols the book did not price)
        price_map: Dict[str, Any] = {}
        try:
            price_map = self.ctrl.vault.price_usd_map() or {}
        except Exception:
            price_map = {}
        if price_map:
            lower = {str(k).upper(): v for k, v in price_map.items()}
            for sym in syms:
                if sym in out:
                    continue
                v = lower.get(str(sym).upper())
                try:
                    if v is not None and float(v) > 0:
                        out[sym] = float(v)
                except (TypeError, ValueError):
                    pass
        return out

    def session_cap(self) -> Optional[float]:
        if self.runner is not None:
            caps = self.runner.policy.caps
            if isinstance(caps, dict) and caps.get("sessionUsd") is not None:
                return float(caps["sessionUsd"])
        return self.session_cap_usd

    def _emit(self, ev: Dict[str, Any]) -> None:
        # called on the AgentLoop thread -> queued signal to the UI thread.
        try:
            self.event.emit(dict(ev))
        except Exception:
            pass

    def ensure_runner(self):
        """Build the live-capable runner. Requires the vault unlocked (same gate
        AgentTab uses). Reuses the audited policy / tools / audit / pnl / store."""
        if not self.is_unlocked():
            raise RuntimeError("Unlock the multi-chain vault first (Accounts tab) to manage bots.")
        if self.runner is not None:
            return self.runner
        ctrl = self.ctrl
        audit = agentpkg.audit.create({"store": ctrl._store})

        async def _lock(_reason=None):
            try:
                ctrl.vault.lock()
            except Exception:
                pass

        policy = agentpkg.policy.create({
            "caps": {"sessionUsd": self.session_cap_usd},
            "confirm": None,          # no per-order confirm -> fail-closed OUTSIDE the allocation
            "onKill": _lock,          # kill wipes decrypted keys + locks the vault
            "audit": audit,
            "requireConfirm": True,
        })
        base_ctx = ctrl._ctx()

        def _network():
            try:
                return "mainnet" if getattr(ctrl.block_wallet, "network", "") == "mainnet" else "testnet"
            except Exception:
                return "testnet"

        async def _prices(symbols):
            # REAL marks from the wallet's live Exchange book (+ the configured
            # USD price map) — the SAME market source the agent ctx trades
            # through. A symbol with no live data is omitted so the engine skips
            # that tick (audited); NEVER a fabricated price (§5).
            return self._live_marks(symbols)

        bots_ctx = dict(base_ctx)
        bots_ctx["network"] = _network
        bots_ctx["prices"] = _prices
        tools = agentpkg.tools.build(bots_ctx)
        notifier = notify_mod.QtTrayNotifier()
        pnl = agentpkg.pnl.create({"notifier": notifier, "audit": audit})
        wallet_id = _network()
        self.runner = agentpkg.bot_runner.create({
            "policy": policy, "tools": tools, "audit": audit, "ctx": bots_ctx,
            "pnl": pnl, "wallet": wallet_id, "channel": "bots",
            "persist": ctrl._store, "mainnetEnabled": False,
            "onEvent": self._emit,
        })
        try:
            self.loop.submit(self.runner.store.restore()).result(timeout=5)
        except Exception:
            pass
        return self.runner

    def arena(self) -> arena_mod.ArenaProfile:
        if self._arena is None:
            self._arena = arena_mod.ArenaProfile({"grantUsd": self.vectors.get("grantDefault")})
        return self._arena

    # ---- async bridge -------------------------------------------------------
    def run_async(self, coro, on_done=None, on_error=None):
        fut = self.loop.submit(coro)

        def _cb(f):
            # Runs on the AgentLoop WORKER thread. NEVER touch a QWidget here —
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


# =========================================================================== #
# DEAL-LADDER PREVIEW — compute the ladder with the REAL engine math so the     #
# preview matches live fills exactly (§5a).                                     #
# =========================================================================== #
def preview_ladder(cfg: Dict[str, Any], base_sym: str, price: float) -> Dict[str, Any]:
    """Drive the DCA engine over a descending path to extract the planned ladder:
    base order, each safety order, the resulting average entry and take-profit."""
    B = bots_mod
    vcfg = B.validate_dca_config(cfg)
    bcfg = B.dca_bps(vcfg)
    bd = B.decimals_for(base_sym)
    price_uc = B.micro_usd(price)
    deal = B.new_dca_deal("preview")
    legs: List[Dict[str, Any]] = []

    def _paper_fill(order, mark_uc):
        if order["side"] == "buy":
            qty = B.qty_for_usd(order["usdSizeUc"], mark_uc, bd)
            return {"qty": qty, "priceUc": mark_uc, "costUc": order["usdSizeUc"], "bd": bd, "paper": True}
        qty = order.get("qty") or 0
        return {"qty": qty, "priceUc": mark_uc, "proceedsUc": B.value_of(qty, mark_uc, bd), "bd": bd, "paper": True}

    # base order at the current mark
    order = B.dca_step(deal, bcfg, price_uc)
    if order and order.get("kind") == "base":
        fill = _paper_fill(order, price_uc)
        B.dca_apply(deal, bcfg, order, fill, 0)
        legs.append({"k": "base", "price": price / 1.0, "usd": B.uc_to_usd(order["usdSizeUc"])})
    # safety ladder: step the mark down to each trigger and let the engine fire
    guard = 0
    while guard < 64:
        guard += 1
        mark_uc = deal["nextTriggerUc"]
        if mark_uc <= 0:
            break
        B.dca_observe(deal, mark_uc)
        order = B.dca_step(deal, bcfg, mark_uc)
        if not order or order.get("kind") != "safety":
            break
        fill = _paper_fill(order, mark_uc)
        if not fill.get("qty"):
            break
        B.dca_apply(deal, bcfg, order, fill, 0)
        legs.append({"k": "safety", "price": B.uc_to_usd(mark_uc), "usd": B.uc_to_usd(order["usdSizeUc"])})

    avg_uc = deal["avgEntryUc"]
    tp_uc = B.apply_bps(avg_uc, bcfg["takeProfitBps"])
    total_usd = sum(lg["usd"] for lg in legs)
    lowest = legs[-1]["price"] if legs else price
    dip_pct = (price - lowest) / price * 100 if price else 0.0
    return {
        "legs": legs,
        "avg": B.uc_to_usd(avg_uc) or price,
        "tp": B.uc_to_usd(tp_uc) or price,
        "price": price,
        "lo": lowest,
        "hi": B.uc_to_usd(tp_uc) or price,
        "totalUsd": total_usd,
        "dipPct": dip_pct,
    }


# =========================================================================== #
# SMALL UI BUILDING BLOCKS                                                      #
# =========================================================================== #
def _eyebrow(text: str) -> QLabel:
    lb = QLabel(text.upper())
    lb.setObjectName("eyebrow")
    return lb


def _hline_card() -> QFrame:
    f = QFrame()
    f.setObjectName("card")
    return f


class BotCard(QFrame):
    """One cockpit bot card, rendered from a REAL runner ``dashboard`` dict."""

    clicked = Signal(str)  # bot id

    def __init__(self, tokens: Dict[str, str], dash: Dict[str, Any]):
        super().__init__()
        self.setObjectName("bot")
        self.tok = tokens
        self.bot_id = dash["bot"]
        self.setCursor(Qt.PointingHandCursor)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(17, 16, 17, 15)
        lay.setSpacing(11)

        top = QHBoxLayout()
        names = QVBoxLayout()
        names.setSpacing(2)
        nm = QLabel(dash.get("name") or dash["bot"])
        nm.setStyleSheet("font-weight:700; font-size:14px;")
        pair = QLabel(_first_pair(dash))
        pair.setObjectName("mono")
        pair.setStyleSheet(f"color:{tokens['ink_muted']}; font-size:11px; font-family:{MONO};")
        names.addWidget(nm)
        names.addWidget(pair)
        top.addLayout(names)
        top.addStretch(1)
        mode = dash.get("mode", "paper")
        badge = QLabel("● Live" if mode == "live" else "○ Paper")
        badge.setObjectName("badgeLive" if mode == "live" else "badgePaper")
        top.addWidget(badge, 0, Qt.AlignTop)
        lay.addLayout(top)

        chips = QHBoxLayout()
        chips.setSpacing(6)
        ty = QLabel(dash.get("type", "").upper())
        ty.setObjectName("chipType")
        chips.addWidget(ty)
        status = dash.get("status", "stopped")
        st = QLabel({"running": "auto · within cap" if mode == "live" else "simulated",
                     "stopped": "stopped", "paused": "paused", "killed": "killed"}.get(status, status))
        st.setObjectName("chip")
        chips.addWidget(st)
        chips.addStretch(1)
        lay.addLayout(chips)

        # allocation bar vs allocationUsd
        cap = float(dash.get("allocationUsd") or 0)
        used = float(dash.get("committedUsd") or 0) if mode == "live" else 0.0
        arow = QHBoxLayout()
        al = QLabel("Allocation")
        al.setStyleSheet(f"color:{tokens['ink_muted']}; font-size:11px;")
        av = QLabel(f"{plain_money(used)} / {plain_money(cap)}")
        av.setObjectName("mono")
        av.setStyleSheet(f"font-size:11px; font-family:{MONO};")
        arow.addWidget(al)
        arow.addStretch(1)
        arow.addWidget(av)
        lay.addLayout(arow)
        pct = int(min(100, (used / cap * 100))) if cap > 0 else 0
        lay.addWidget(AllocBar(tokens, pct))

        # Scan & trade (Autopilot) card: the scanned candidates + scores + the
        # traded/skipped reasons from the last scan tick (docs/AGENT-SCAN.md §3).
        scan = dash.get("scan") if dash.get("type") == "scanner" else None
        if scan:
            worthy = scan.get("worthy") or []
            cands = scan.get("candidates") or []
            head = QLabel(f"Scanned {len(cands)} · traded {len(worthy)} · "
                          f"min {plain_money(scan.get('minProfitBps') or 0)}bps")
            head.setStyleSheet(f"color:{tokens['ink_muted']}; font-size:11px;")
            lay.addWidget(head)
            shown = 0
            for c in cands:
                if shown >= 4:
                    break
                shown += 1
                mark = "✓" if c.get("traded") else "·"
                line = QLabel(f"{mark} {c.get('pair')}  {c.get('strategy') or '—'}  "
                              f"{round(float(c.get('score') or 0), 2)}bps  "
                              f"{'traded' if c.get('traded') else c.get('reason')}")
                line.setObjectName("mono")
                line.setStyleSheet(
                    f"font-size:10px; font-family:{MONO};"
                    f"color:{tokens['gain'] if c.get('traded') else tokens['ink_faint']};")
                lay.addWidget(line)

        foot = QHBoxLayout()
        fl = QVBoxLayout()
        fl.setSpacing(1)
        fl.addWidget(_small_label("Total P&L", tokens["ink_muted"]))
        realized = dash.get("realizedUsd")
        unreal = dash.get("unrealizedUsd") or 0.0
        total = (realized or 0.0) + (unreal or 0.0)
        pv = QLabel(money(total))
        pv.setObjectName("pos" if total >= 0 else "neg")
        pv.setStyleSheet(f"font-weight:700; font-size:14px; font-family:{MONO};"
                         f"color:{tokens['gain'] if total >= 0 else tokens['loss']};")
        fl.addWidget(pv)
        foot.addLayout(fl)
        foot.addStretch(1)
        wins = dash.get("winRate")
        wr = QLabel(f"win {round(wins*100)}%" if wins is not None else "no deals yet")
        wr.setStyleSheet(f"color:{tokens['ink_faint']}; font-size:11px;")
        foot.addWidget(wr, 0, Qt.AlignBottom)
        lay.addLayout(foot)

    def mousePressEvent(self, _ev):
        self.clicked.emit(self.bot_id)


class AllocBar(QWidget):
    def __init__(self, tokens, pct):
        super().__init__()
        self.tok = tokens
        self.pct = max(0, min(100, pct))
        self.setFixedHeight(6)

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        p.setBrush(_qc(self.tok["line"]))
        p.setPen(Qt.NoPen)
        p.drawRoundedRect(QRectF(0, 0, w, h), 3, 3)
        if self.pct > 0:
            p.setBrush(_qc(self.tok["accent"]))
            p.drawRoundedRect(QRectF(0, 0, w * self.pct / 100, h), 3, 3)
        p.end()


def _small_label(text, color):
    lb = QLabel(text)
    lb.setStyleSheet(f"color:{color}; font-size:11px;")
    return lb


def _first_pair(dash: Dict[str, Any]) -> str:
    deals = dash.get("activeDeals") or []
    if deals:
        return deals[0].get("pair", "—")
    return dash.get("pair") or "—"


class StatTile(QFrame):
    def __init__(self, tokens, eyebrow, value, sub="", value_color=None):
        super().__init__()
        self.setObjectName("tile")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 14)
        lay.setSpacing(3)
        lay.addWidget(_eyebrow(eyebrow))
        v = QLabel(value)
        v.setObjectName("mono")
        v.setStyleSheet(f"font-size:22px; font-weight:700; font-family:{MONO};"
                        + (f"color:{value_color};" if value_color else ""))
        lay.addWidget(v)
        if sub:
            s = QLabel(sub)
            s.setStyleSheet(f"color:{tokens['ink_muted']}; font-size:11px;")
            lay.addWidget(s)
        self.value_label = v


# =========================================================================== #
# LIVE-ARMING REVIEW SHEET (§5 / §5a) — the one moment that must feel           #
# deliberate. Restates, in plain words: the allocation cap, that orders run     #
# AUTO within it with no further taps, the kill switch, and (mainnet) the       #
# mainnetEnabled requirement. One clear confirm — never a silent flip.          #
# =========================================================================== #
class LiveArmReview(QDialog):
    def __init__(self, parent, tokens, *, name, pair, allocation, session_cap,
                 network, mainnet_enabled):
        super().__init__(parent)
        self.setWindowTitle("Go live — review")
        self.setModal(True)
        self.tok = tokens
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 18)
        lay.setSpacing(12)

        title = QLabel("Arm this bot to trade LIVE")
        title.setStyleSheet("font-size:18px; font-weight:800;")
        lay.addWidget(title)
        sub = QLabel(f"{name} · {pair} · {network}")
        sub.setObjectName("sub")
        lay.addWidget(sub)

        over_cap = session_cap is not None and allocation > session_cap
        bullets = [
            f"<b>Allocation cap:</b> this bot can deploy at most "
            f"<b>{plain_money(allocation)}</b>. It is a hard, non-bypassable per-bot "
            f"ceiling enforced by a committed-spend ledger on top of your policy caps.",
            "<b>Runs automatically within that cap:</b> orders fire with no further "
            "taps as long as each stays inside the allocation AND your session/"
            "per-asset caps. An order that would exceed the cap simply does not fire.",
            "<b>Always on:</b> the session caps, the allowlist, the hash-chained "
            "audit, the 0.05% fee and the KILL switch never turn off. Auto means "
            "\"no manual tap,\" not \"no checks.\"",
        ]
        if network == "mainnet":
            bullets.append(
                "<b>Mainnet:</b> requires operator sign-off (mainnetEnabled). It is "
                + ("<b>ENABLED</b>." if mainnet_enabled else
                   "<b>OFF</b> — arming will be refused until you enable it."))
        for b in bullets:
            lb = QLabel("•  " + b)
            lb.setWordWrap(True)
            lb.setStyleSheet("font-size:12.5px;")
            lay.addWidget(lb)

        if session_cap is not None:
            cap_note = QLabel(f"Policy session cap: {plain_money(session_cap)}.")
            cap_note.setObjectName("sub")
            lay.addWidget(cap_note)
        if over_cap:
            warn = QLabel(f"Allocation {plain_money(allocation)} exceeds the session "
                          f"cap {plain_money(session_cap)} — lower it to arm.")
            warn.setObjectName("neg")
            warn.setWordWrap(True)
            lay.addWidget(warn)

        bb = QDialogButtonBox()
        self.confirm_btn = QPushButton("Confirm — arm live")
        self.confirm_btn.setObjectName("primary")
        cancel = QPushButton("Cancel")
        if over_cap or (network == "mainnet" and not mainnet_enabled):
            self.confirm_btn.setEnabled(False)
        bb.addButton(cancel, QDialogButtonBox.RejectRole)
        bb.addButton(self.confirm_btn, QDialogButtonBox.AcceptRole)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)


# =========================================================================== #
# COCKPIT                                                                      #
# =========================================================================== #
class CockpitPanel(QWidget):
    open_detail = Signal(str)

    def __init__(self, bc: BotsController, tokens: Dict[str, str]):
        super().__init__()
        self.bc = bc
        self.tok = tokens
        self.mode_filter = "all"
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 8, 0, 0)
        root.setSpacing(14)

        # hero row: aggregate P&L + sparkline | stat tiles
        hero = QHBoxLayout()
        hero.setSpacing(16)
        herocard = _hline_card()
        hc = QVBoxLayout(herocard)
        hc.setContentsMargins(22, 20, 24, 20)
        hc.setSpacing(4)
        hc.addWidget(_eyebrow("Portfolio P&L · all bots"))
        self.hero_big = QLabel("—")
        self.hero_big.setObjectName("heroBig")
        hc.addWidget(self.hero_big)
        self.hero_sub = QLabel("")
        self.hero_sub.setObjectName("sub")
        hc.addWidget(self.hero_sub)
        self.spark = Sparkline(tokens, mini=False)
        hc.addWidget(self.spark, 1)
        hero.addWidget(herocard, 3)

        tiles = QGridLayout()
        tiles.setSpacing(1)
        self.t_active = StatTile(tokens, "Active bots", "0", "0 paper · 0 live")
        self.t_alloc = StatTile(tokens, "Allocation in use", "$0", "of $0 capped")
        self.t_real = StatTile(tokens, "Realized", "—", "across all deals")
        self.t_win = StatTile(tokens, "Win rate", "—", "0 deals")
        tiles.addWidget(self.t_active, 0, 0)
        tiles.addWidget(self.t_alloc, 0, 1)
        tiles.addWidget(self.t_real, 1, 0)
        tiles.addWidget(self.t_win, 1, 1)
        tw = QWidget()
        tw.setLayout(tiles)
        hero.addWidget(tw, 2)
        root.addLayout(hero)

        # section head + filter
        head = QHBoxLayout()
        h2 = QLabel("Your bots")
        h2.setStyleSheet("font-size:16px; font-weight:700;")
        head.addWidget(h2)
        self.count = QLabel("0")
        self.count.setObjectName("chip")
        head.addWidget(self.count)
        head.addStretch(1)
        self.seg_group = QButtonGroup(self)
        for key, label in [("all", "All"), ("paper", "Paper"), ("live", "Live")]:
            b = QPushButton(label)
            b.setObjectName("seg")
            b.setCheckable(True)
            b.setChecked(key == "all")
            b.clicked.connect(lambda _c=False, k=key: self._set_filter(k))
            self.seg_group.addButton(b)
            head.addWidget(b)
        root.addLayout(head)

        self.empty = QLabel("")
        self.empty.setObjectName("note")
        self.empty.setWordWrap(True)
        root.addWidget(self.empty)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.grid_host = QWidget()
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(16)
        self.grid.setAlignment(Qt.AlignTop)
        self.scroll.setWidget(self.grid_host)
        root.addWidget(self.scroll, 1)

        note = QLabel("Non-custodial & gated. Keys never leave your device. Live bots trade "
                      "fully auto within their allocation cap — no per-order tap inside the cap — "
                      "but every order still passes session caps, the allowlist, the hash-chained "
                      "audit, the 0.05% fee and the kill switch. Mainnet stays off until you enable it.")
        note.setObjectName("note")
        note.setWordWrap(True)
        root.addWidget(note)

    def set_tokens(self, tokens):
        self.tok = tokens
        self.spark.set_tokens(tokens)

    def _set_filter(self, key):
        self.mode_filter = key
        self.refresh()

    def refresh(self):
        # clear grid
        while self.grid.count():
            it = self.grid.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        if not self.bc.is_unlocked() or self.bc.runner is None:
            self.empty.setText("Unlock the multi-chain vault (Accounts tab) to see and manage "
                               "your bots. You can still design a bot and play the Arena now.")
            self.empty.setVisible(True)
            self.hero_big.setText("—")
            self.hero_sub.setText("")
            self.count.setText("0")
            return
        agg = self.bc.runner.aggregate()
        rows = [r for r in agg.get("bots", []) if r]
        if self.mode_filter != "all":
            rows = [r for r in rows if r.get("mode") == self.mode_filter]

        realized = agg.get("realizedUsd") or 0.0
        unreal = sum((r.get("unrealizedUsd") or 0.0) for r in agg.get("bots", []) if r)
        total = realized + unreal
        self.hero_big.setText(money(total))
        self.hero_big.setStyleSheet(f"font-size:40px; font-weight:800; letter-spacing:-1px;"
                                    f"color:{self.tok['gain'] if total >= 0 else self.tok['loss']};")
        self.hero_sub.setText(f"realized {money(realized)} · unrealized {money(unreal)}")
        # sparkline from the per-bot realized ledger (real data; cumulative)
        series = [0.0]
        acc = 0.0
        for r in agg.get("bots", []):
            if not r:
                continue
            acc += (r.get("realizedUsd") or 0.0)
            series.append(acc)
        if len(series) < 2:
            series = [0.0, total]
        self.spark.set_data(series, up=total >= 0)

        all_rows = [r for r in agg.get("bots", []) if r]
        n_paper = len([r for r in all_rows if r.get("mode") == "paper"])
        n_live = len([r for r in all_rows if r.get("mode") == "live"])
        self.t_active.value_label.setText(str(len(all_rows)))
        cap_sum = sum(float(r.get("allocationUsd") or 0) for r in all_rows)
        used_sum = sum(float(r.get("committedUsd") or 0) for r in all_rows if r.get("mode") == "live")
        self.t_alloc.value_label.setText(plain_money(used_sum))
        self.t_real.value_label.setText(money(realized))
        total_deals = sum(int(r.get("totalDeals") or 0) for r in all_rows)
        total_wins = sum(int(r.get("winCount") or 0) for r in all_rows)
        self.t_win.value_label.setText(f"{round(total_wins/total_deals*100)}%" if total_deals else "—")

        self.count.setText(str(len(rows)))
        if not rows:
            self.empty.setText("No bots yet. Head to Create a bot, pick a template, set one "
                               "amount, and Start in paper — risk-free.")
            self.empty.setVisible(True)
            return
        self.empty.setVisible(False)
        cols = 2
        for i, r in enumerate(rows):
            card = BotCard(self.tok, r)
            card.clicked.connect(self.open_detail.emit)
            self.grid.addWidget(card, i // cols, i % cols)


# =========================================================================== #
# CREATE — two tiers on one screen (§5a).                                      #
# =========================================================================== #
# Starter template presets come from the REAL engine (bot_templates.TEMPLATES),
# so the create flow and the deal math stay in lock-step with the other wallets.
_TPL_ORDER = ["conservative_dca", "aggressive_dca", "wide_grid", "block_accumulator"]


class CreatePanel(QWidget):
    created = Signal()  # a bot was added -> cockpit refresh

    def __init__(self, bc: BotsController, tokens: Dict[str, str]):
        super().__init__()
        self.bc = bc
        self.tok = tokens
        self.sel_template = _TPL_ORDER[0]
        self.price = 142.80  # reference mark for the preview ladder
        # advanced slider state (seeded from the chosen template)
        self.adv = {"base": 100, "tp": 2.0, "so": 3, "step": 2.0, "vol": 1.4, "tr": 0.6}

        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 8, 0, 0)
        outer.setSpacing(16)

        # ---- left: the form ----
        left = _hline_card()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(20, 18, 20, 18)
        lv.setSpacing(6)
        title = QLabel("Create a bot")
        title.setStyleSheet("font-size:15px; font-weight:700;")
        lv.addWidget(title)
        hint = QLabel("Pick a starting point, choose a pair, set one amount. Tune the rest "
                      "under Advanced if you want.")
        hint.setObjectName("sub")
        hint.setWordWrap(True)
        lv.addWidget(hint)

        lv.addWidget(_eyebrow("1 · Template"))
        self.tpl_group = QButtonGroup(self)
        tgrid = QGridLayout()
        tgrid.setSpacing(10)
        for i, key in enumerate(_TPL_ORDER):
            t = templates_mod.TEMPLATES[key]
            b = QPushButton(f"{t['name']}\n{t['blurb']}")
            b.setObjectName("tpl")
            b.setCheckable(True)
            b.setChecked(i == 0)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(lambda _c=False, k=key: self._pick_template(k))
            self.tpl_group.addButton(b)
            tgrid.addWidget(b, i // 2, i % 2)
        lv.addLayout(tgrid)

        lv.addSpacing(6)
        lv.addWidget(self._field_label("2 · Pair", "what to trade"))
        self.pair_in = QLineEdit("SOL/USDC")
        lv.addWidget(self.pair_in)
        self.pair_in.textChanged.connect(self._render)

        lv.addWidget(self._field_label("3 · Amount to allocate", "the bot's hard cap"))
        self.alloc_in = QLineEdit("500")
        lv.addWidget(self.alloc_in)
        self.alloc_in.textChanged.connect(self._render)

        self.preview = QLabel("")
        self.preview.setObjectName("preview")
        self.preview.setWordWrap(True)
        lv.addWidget(self.preview)

        self.adv_toggle = QPushButton("▸  Advanced — safety orders, take-profit, trailing")
        self.adv_toggle.setObjectName("advToggle")
        self.adv_toggle.setCheckable(True)
        self.adv_toggle.clicked.connect(self._toggle_adv)
        lv.addWidget(self.adv_toggle)

        self.adv_box = QWidget()
        agrid = QGridLayout(self.adv_box)
        agrid.setContentsMargins(0, 10, 0, 0)
        agrid.setSpacing(12)
        self._sliders = {}
        specs = [
            ("base", "Base order", 25, 300, 1, "$%d"),
            ("tp", "Take-profit", 5, 80, 10, "%.1f%%"),
            ("so", "Safety orders", 0, 6, 1, "%d"),
            ("step", "Price step", 5, 60, 10, "%.1f%%"),
            ("vol", "Volume scale", 10, 25, 10, "%.1f×"),
            ("tr", "Trailing", 0, 30, 10, "%.1f%%"),
        ]
        for i, (key, label, lo, hi, div, fmt) in enumerate(specs):
            cell = QVBoxLayout()
            row = QHBoxLayout()
            lab = QLabel(label)
            lab.setStyleSheet(f"color:{tokens['ink_muted']}; font-size:11px;")
            val = QLabel("")
            val.setObjectName("mono")
            val.setStyleSheet(f"font-weight:700; font-family:{MONO};")
            row.addWidget(lab)
            row.addStretch(1)
            row.addWidget(val)
            cell.addLayout(row)
            sl = QSlider(Qt.Horizontal)
            sl.setMinimum(lo)
            sl.setMaximum(hi)
            sl.valueChanged.connect(lambda _v=0, k=key: self._slider_changed(k))
            cell.addWidget(sl)
            cw = QWidget()
            cw.setLayout(cell)
            agrid.addWidget(cw, i // 2, i % 2)
            self._sliders[key] = {"slider": sl, "val": val, "div": div, "fmt": fmt}
        self.adv_box.setVisible(False)
        lv.addWidget(self.adv_box)

        actions = QHBoxLayout()
        self.paper_btn = QPushButton("▶  Start in paper")
        self.paper_btn.setObjectName("primary")
        self.paper_btn.clicked.connect(self._start_paper)
        self.live_btn = QPushButton("⚡ Go live…")
        self.live_btn.clicked.connect(self._go_live)
        actions.addWidget(self.paper_btn, 1)
        actions.addWidget(self.live_btn)
        lv.addLayout(actions)
        lv.addStretch(1)

        lscroll = QScrollArea()
        lscroll.setWidgetResizable(True)
        lscroll.setWidget(left)
        outer.addWidget(lscroll, 1)

        # ---- right: the live deal-ladder preview ----
        right = _hline_card()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(20, 18, 20, 18)
        rv.setSpacing(10)
        head = QHBoxLayout()
        hv = QVBoxLayout()
        hv.setSpacing(2)
        hv.addWidget(_eyebrow("Deal preview"))
        self.ladder_title = QLabel("SOL/USDC")
        self.ladder_title.setStyleSheet("font-size:15px; font-weight:700;")
        hv.addWidget(self.ladder_title)
        head.addLayout(hv)
        head.addStretch(1)
        self.ladder_type = QLabel("DCA")
        self.ladder_type.setObjectName("chipType")
        head.addWidget(self.ladder_type, 0, Qt.AlignTop)
        rv.addLayout(head)

        self.ladder = DealLadder(tokens)
        rv.addWidget(self.ladder, 1)

        legend = QHBoxLayout()
        for color, text in [(tokens["k_base"], "Base order"), (tokens["k_safety"], "Safety orders"),
                            (tokens["k_tp"], "Take-profit")]:
            sw = QLabel("■")
            sw.setStyleSheet(f"color:{color}; font-size:13px;")
            lb = QLabel(text)
            lb.setStyleSheet(f"color:{tokens['ink_muted']}; font-size:11px;")
            legend.addWidget(sw)
            legend.addWidget(lb)
            legend.addSpacing(10)
        legend.addStretch(1)
        rv.addLayout(legend)

        stats = QHBoxLayout()
        stats.setSpacing(1)
        self.s_max = StatTile(tokens, "Max deal size", "$0")
        self.s_avg = StatTile(tokens, "Avg entry if all fill", "—")
        self.s_dip = StatTile(tokens, "Covers a dip of", "—")
        for t in (self.s_max, self.s_avg, self.s_dip):
            stats.addWidget(t)
        rv.addLayout(stats)
        outer.addWidget(right, 1)

        self._pick_template(self.sel_template)

    # ---- helpers ----
    def _field_label(self, label, hint):
        lb = QLabel(f"{label}   <span style='color:{self.tok['ink_faint']};font-weight:400'>{hint}</span>")
        lb.setStyleSheet("font-size:12px; font-weight:700; margin-top:10px;")
        return lb

    def set_tokens(self, tokens):
        self.tok = tokens
        self.ladder.set_tokens(tokens)

    def _pick_template(self, key):
        self.sel_template = key
        t = templates_mod.TEMPLATES[key]
        c = t["config"]
        if t["type"] == "dca":
            self.adv = {
                "base": c.get("baseOrderUsd", 100),
                "tp": c.get("takeProfitPct", 2.0),
                "so": c.get("maxSafetyOrders", 3),
                "step": c.get("safetyStepPct", 2.0),
                "vol": c.get("safetyVolumeScale", 1.4),
                "tr": c.get("trailingTpPct", 0.0),
            }
        pairs = (t.get("universe") or {}).get("pairs") or []
        if pairs:
            self.pair_in.setText(pairs[0])
        self.ladder_type.setText(t["type"].upper())
        self._sync_sliders()
        self._render()

    def _sync_sliders(self):
        for key, s in self._sliders.items():
            s["slider"].blockSignals(True)
            s["slider"].setValue(int(round(self.adv[key] * s["div"])))
            s["slider"].blockSignals(False)
            self._update_slider_label(key)

    def _update_slider_label(self, key):
        s = self._sliders[key]
        self.adv[key] = s["slider"].value() / s["div"]
        s["val"].setText(s["fmt"] % (self.adv[key]))

    def _slider_changed(self, key):
        self._update_slider_label(key)
        self._render()

    def _toggle_adv(self):
        open_ = self.adv_toggle.isChecked()
        self.adv_box.setVisible(open_)
        self.adv_toggle.setText(("▾" if open_ else "▸") +
                                "  Advanced — safety orders, take-profit, trailing")

    def _config(self):
        return {
            "baseOrderUsd": self.adv["base"], "safetyOrderUsd": self.adv["base"],
            "maxSafetyOrders": int(self.adv["so"]), "safetyStepPct": self.adv["step"],
            "safetyStepScale": 1.0, "safetyVolumeScale": self.adv["vol"],
            "takeProfitPct": self.adv["tp"], "trailingTpPct": self.adv["tr"],
            "stopLossPct": 0, "cooldownSec": 0, "startCondition": "asap",
        }

    def _alloc(self):
        try:
            return max(0.0, float(self.alloc_in.text()))
        except ValueError:
            return 0.0

    def _base_sym(self):
        pair = self.pair_in.text().strip() or "SOL/USDC"
        return bots_mod.split_pair(pair)[0] if "/" in pair else pair

    def _render(self):
        pair = self.pair_in.text().strip() or "SOL/USDC"
        self.ladder_title.setText(pair)
        t = templates_mod.TEMPLATES[self.sel_template]
        if t["type"] != "dca":
            # grid/other: show the engine's own plain-language describe(), no ladder
            self.preview.setText(self._describe(t["type"]))
            self.ladder.set_deal([], 0, 0, 0, 0, 0)
            self.s_max.value_label.setText(plain_money(self._alloc()))
            self.s_avg.value_label.setText("—")
            self.s_dip.value_label.setText("—")
            return
        d = preview_ladder(self._config(), self._base_sym(), self.price)
        self.ladder.set_deal(d["legs"], d["avg"], d["tp"], d["price"], d["lo"], d["hi"])
        self.s_max.value_label.setText(plain_money(d["totalUsd"]))
        self.s_avg.value_label.setText(f"${d['avg']:.2f}")
        self.s_dip.value_label.setText(f"−{d['dipPct']:.1f}%")
        self.preview.setText(self._describe("dca"))

    def _describe(self, type_):
        """Plain-language preview straight from the engine's Bot.describe()."""
        try:
            spec = {
                "type": type_, "name": templates_mod.TEMPLATES[self.sel_template]["name"],
                "universe": {"pairs": [self.pair_in.text().strip() or "SOL/USDC"]},
                "config": self._config() if type_ == "dca"
                else dict(templates_mod.TEMPLATES[self.sel_template]["config"]),
                "allocationUsd": self._alloc(),
            }
            bot = bots_mod.Bot(spec)
            text = bot.describe()
        except Exception as e:  # pragma: no cover - defensive
            return f"(preview unavailable: {e})"
        return text + f"  Capped at {plain_money(self._alloc())}."

    # ---- actions: build a REAL bot via the runner (never a mock) ----
    def _make_spec(self, mode):
        t = templates_mod.TEMPLATES[self.sel_template]
        cfg = self._config() if t["type"] == "dca" else dict(t["config"])
        return {
            "name": t["name"], "type": t["type"],
            "universe": {"pairs": [self.pair_in.text().strip() or "SOL/USDC"]},
            "config": cfg, "allocationUsd": self._alloc(),
            "mode": "paper", "enabled": False, "network": "testnet",
            "template": self.sel_template,
        }

    def _start_paper(self):
        try:
            runner = self.bc.ensure_runner()
        except RuntimeError as e:
            QMessageBox.information(self, "Unlock needed", str(e))
            return
        bot = runner.add(self._make_spec("paper"))

        def _done(_):
            self.created.emit()
            QMessageBox.information(self, "Paper bot started",
                                    f"{bot.name} is running in PAPER mode — it simulates fills at "
                                    f"live quotes and books P&L to the dashboard, but never "
                                    f"broadcasts. Arm it live from Bot detail when you're ready.")
        self.bc.run_async(runner.enable_paper(bot.id), on_done=lambda r: _done(r),
                          on_error=lambda e: QMessageBox.warning(self, "Bots", str(e)))

    def _go_live(self):
        try:
            runner = self.bc.ensure_runner()
        except RuntimeError as e:
            QMessageBox.information(self, "Unlock needed", str(e))
            return
        alloc = self._alloc()
        pair = self.pair_in.text().strip() or "SOL/USDC"
        dlg = LiveArmReview(self, self.tok, name=templates_mod.TEMPLATES[self.sel_template]["name"],
                            pair=pair, allocation=alloc, session_cap=self.bc.session_cap(),
                            network="testnet", mainnet_enabled=False)
        if dlg.exec() != QDialog.Accepted:
            return
        spec = self._make_spec("live")
        bot = runner.add(spec)

        def _done(_):
            self.created.emit()
            QMessageBox.information(self, "Bot armed live",
                                    f"{bot.name} is armed LIVE with a {plain_money(alloc)} cap and "
                                    f"runs automatically within it. Kill it any time.")
        self.bc.run_async(runner.arm_live(bot.id, {"allocationUsd": alloc}),
                          on_done=lambda r: _done(r),
                          on_error=lambda e: QMessageBox.warning(self, "Go live refused", str(e)))


# =========================================================================== #
# DETAIL — the deal as a vertical stepper + performance tiles + controls.       #
# =========================================================================== #
class DetailPanel(QWidget):
    changed = Signal()   # a control mutated state -> cockpit refresh

    def __init__(self, bc: BotsController, tokens: Dict[str, str]):
        super().__init__()
        self.bc = bc
        self.tok = tokens
        self.bot_id: Optional[str] = None
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 8, 0, 0)
        self.placeholder = QLabel("Select a bot from the Cockpit to see its deal timeline, "
                                  "performance and controls.")
        self.placeholder.setObjectName("note")
        self.placeholder.setWordWrap(True)
        root.addWidget(self.placeholder)

        self.body = QWidget()
        self.body.setVisible(False)
        cols = QHBoxLayout(self.body)
        cols.setContentsMargins(0, 0, 0, 0)
        cols.setSpacing(16)

        # left: deal stepper + controls
        self.left = _hline_card()
        self.lv = QVBoxLayout(self.left)
        self.lv.setContentsMargins(20, 18, 20, 18)
        self.lv.setSpacing(8)
        cols.addWidget(self.left, 3)

        # right: performance tiles
        self.right = _hline_card()
        self.rv = QVBoxLayout(self.right)
        self.rv.setContentsMargins(20, 18, 20, 18)
        self.rv.setSpacing(10)
        cols.addWidget(self.right, 2)
        root.addWidget(self.body, 1)
        root.addStretch(1)

    def set_tokens(self, tokens):
        self.tok = tokens
        if self.bot_id:
            self.show_bot(self.bot_id)

    def _clear(self, layout):
        while layout.count():
            it = layout.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
            elif it.layout():
                self._clear(it.layout())

    def show_bot(self, bot_id: str):
        self.bot_id = bot_id
        if self.bc.runner is None:
            return
        dash = self.bc.runner.dashboard(bot_id)
        bot = self.bc.runner.get(bot_id)
        if not dash or not bot:
            return
        self.placeholder.setVisible(False)
        self.body.setVisible(True)
        self._clear(self.lv)
        self._clear(self.rv)

        # ---- header ----
        head = QHBoxLayout()
        ty = QLabel(dash["type"].upper())
        ty.setObjectName("chipType")
        head.addWidget(ty)
        nm = QLabel(dash.get("name") or bot_id)
        nm.setStyleSheet("font-size:19px; font-weight:800;")
        head.addWidget(nm)
        head.addStretch(1)
        mode = dash.get("mode", "paper")
        badge = QLabel("● Live" if mode == "live" else "○ Paper")
        badge.setObjectName("badgeLive" if mode == "live" else "badgePaper")
        head.addWidget(badge)
        self.lv.addLayout(head)
        sub = QLabel(f"{_first_pair(dash)} · {dash.get('status','paused')} · {dash.get('network','testnet')}")
        sub.setObjectName("sub")
        self.lv.addWidget(sub)

        # ---- deal stepper (real deal state) ----
        self.lv.addSpacing(4)
        steps = self._deal_steps(bot, dash)
        if not steps:
            none = QLabel("No open deal yet — the bot opens a base order on its next tick when "
                          "its start condition is met and market data is available.")
            none.setObjectName("sub")
            none.setWordWrap(True)
            self.lv.addWidget(none)
        else:
            for st in steps:
                self.lv.addWidget(self._step_row(st))

        # ---- controls ----
        self.lv.addSpacing(8)
        ctrls = QHBoxLayout()
        ctrls.setSpacing(8)
        running = dash.get("status") == "running"
        pause_btn = QPushButton("Pause" if running else "Resume")
        pause_btn.clicked.connect(lambda: self._toggle_pause(bot_id, running, mode))
        clone_btn = QPushButton("Clone")
        clone_btn.clicked.connect(lambda: self._clone(bot_id))
        stop_btn = QPushButton("Stop")
        stop_btn.clicked.connect(lambda: self._stop_bot(bot_id))
        remove_btn = QPushButton("Delete")
        remove_btn.clicked.connect(lambda: self._remove_bot(bot_id))
        kill_btn = QPushButton("⏻ Kill bot")
        kill_btn.setObjectName("kill")
        kill_btn.clicked.connect(lambda: self._kill_bot(bot_id))
        for b in (pause_btn, clone_btn, stop_btn, remove_btn):
            ctrls.addWidget(b)
        ctrls.addStretch(1)
        ctrls.addWidget(kill_btn)
        self.lv.addLayout(ctrls)
        self.lv.addStretch(1)

        # ---- performance tiles ----
        self.rv.addWidget(_eyebrow("Performance"))
        tiles = QGridLayout()
        tiles.setSpacing(12)
        unreal = dash.get("unrealizedUsd")
        realized = dash.get("realizedUsd")
        tiles.addWidget(self._perf_tile("Unrealized", money(unreal) if unreal is not None else "—",
                                        unreal), 0, 0)
        deals = dash.get("totalDeals") or 0
        tiles.addWidget(self._perf_tile(f"Realized ({deals} deals)",
                                        money(realized) if realized is not None else "—", realized), 0, 1)
        cap = float(dash.get("allocationUsd") or 0)
        used = float(dash.get("committedUsd") or 0) if mode == "live" else 0.0
        at = self._perf_tile("Allocation used",
                             f"{plain_money(used)} / {plain_money(cap)}", None)
        pct = int(min(100, used / cap * 100)) if cap > 0 else 0
        at.layout().addWidget(AllocBar(self.tok, pct))
        tiles.addWidget(at, 1, 0)
        wr = dash.get("winRate")
        wins = dash.get("winCount") or 0
        dd = dash.get("maxDrawdownUsd")
        wt = self._perf_tile("Win rate", f"{round(wr*100)}%" if wr is not None else "—", None)
        sub2 = QLabel(f"{wins} of {deals} · max DD {money(dd, signed=False) if dd else '—'}")
        sub2.setStyleSheet(f"color:{self.tok['ink_muted']}; font-size:11px;")
        wt.layout().addWidget(sub2)
        tiles.addWidget(wt, 1, 1)
        tw = QWidget()
        tw.setLayout(tiles)
        self.rv.addWidget(tw)

        note = QLabel("Profit pop-ups are on. When a deal closes into a stablecoin in profit "
                      "you'll get a notification via the notify module.")
        note.setObjectName("note")
        note.setWordWrap(True)
        self.rv.addWidget(note)
        self.rv.addStretch(1)

    def _deal_steps(self, bot, dash):
        """Build stepper rows from the real active DCA deal fills + armed next + TP."""
        B = bots_mod
        by_pair = bot.state.get("byPair") or {}
        steps = []
        for pair, ps in by_pair.items():
            deal = ps.get("deal") if isinstance(ps, dict) else None
            if not deal or deal.get("status") == "closed" or deal.get("type") != "dca":
                continue
            base = B.split_pair(pair)[0]
            for fill in deal.get("fills", []):
                if fill["side"] == "buy":
                    kind = "Base order" if fill["kind"] == "base" else f"Safety order {fill['kind']}"
                    price = B.uc_to_usd(fill["priceUc"])
                    steps.append({"state": "done", "lead": f"{kind} filled",
                                  "meta": f"entry ${price:.2f}" if price else "",
                                  "amt": money(B.uc_to_usd(fill.get("costUc")), signed=False)})
                else:
                    steps.append({"state": "done", "lead": f"{fill['kind'].upper()} sell",
                                  "meta": "closed", "amt": ""})
            # armed next safety
            cfg = B.dca_bps(bot.config)
            if deal.get("safetyOrdersUsed", 0) < cfg["maxSafetyOrders"] and deal.get("nextTriggerUc"):
                trig = B.uc_to_usd(deal["nextTriggerUc"])
                steps.append({"state": "active", "lead": f"Safety order {deal['safetyOrdersUsed']+1} armed",
                              "meta": f"triggers at ${trig:.2f}" if trig else "", "amt": "waiting"})
            # take-profit target
            if deal.get("avgEntryUc"):
                tp = B.uc_to_usd(B.apply_bps(deal["avgEntryUc"], cfg["takeProfitBps"]))
                steps.append({"state": "pending", "lead": "Take-profit",
                              "meta": f"+{bot.config['takeProfitPct']}% from avg entry",
                              "amt": f"${tp:.2f}" if tp else "target"})
            break
        return steps

    def _step_row(self, st):
        w = QWidget()
        row = QHBoxLayout(w)
        row.setContentsMargins(0, 6, 0, 6)
        ring = QLabel({"done": "✓", "active": "●", "pending": "▲"}.get(st["state"], "•"))
        color = {"done": self.tok["gain"], "active": self.tok["accent"],
                 "pending": self.tok["ink_faint"]}.get(st["state"], self.tok["ink_faint"])
        ring.setStyleSheet(f"color:{color}; font-weight:800; font-size:14px;")
        ring.setFixedWidth(22)
        row.addWidget(ring)
        mid = QVBoxLayout()
        mid.setSpacing(1)
        lead = QLabel(st["lead"])
        lead.setStyleSheet("font-weight:700; font-size:13px;")
        mid.addWidget(lead)
        if st["meta"]:
            meta = QLabel(st["meta"])
            meta.setStyleSheet(f"color:{self.tok['ink_muted']}; font-size:11px;")
            mid.addWidget(meta)
        row.addLayout(mid, 1)
        amt = QLabel(st["amt"])
        amt.setObjectName("mono")
        amt.setStyleSheet(f"font-family:{MONO}; font-size:12px;")
        row.addWidget(amt, 0, Qt.AlignRight)
        return w

    def _perf_tile(self, eyebrow, value, signed_val):
        f = QFrame()
        f.setObjectName("tile")
        lay = QVBoxLayout(f)
        lay.setContentsMargins(15, 14, 15, 14)
        lay.setSpacing(4)
        lay.addWidget(_eyebrow(eyebrow))
        v = QLabel(value)
        color = ""
        if signed_val is not None:
            color = f"color:{self.tok['gain'] if signed_val >= 0 else self.tok['loss']};"
        v.setStyleSheet(f"font-size:21px; font-weight:800; font-family:{MONO};{color}")
        lay.addWidget(v)
        return f

    # ---- control actions (all via the real runner) ----
    def _toggle_pause(self, bot_id, running, mode):
        runner = self.bc.runner
        if running:
            self.bc.run_async(runner.pause(bot_id), on_done=lambda _: self._after())
        elif mode == "live":
            # The bot is ALREADY live (paper->live is the explicit arm review
            # sheet, not this toggle) — this is just resuming a paused live bot.
            # It is not a silent flip, so a brief resume confirm makes it
            # deliberate, then re-enables with the bot's existing allocation (no
            # full arm-review sheet). arm_live keeps its fail-closed checks.
            bot = runner.get(bot_id)
            alloc = getattr(bot, "allocation_usd", None) if bot else None
            prompt = "Resume this live bot? It will trade automatically within its "
            prompt += f"${alloc:g} allocation." if alloc else "allocation."
            if QMessageBox.question(self, "Resume live bot", prompt) != QMessageBox.Yes:
                return
            self.bc.run_async(runner.arm_live(bot_id), on_done=lambda _: self._after(),
                              on_error=lambda e: QMessageBox.warning(self, "Bots", str(e)))
        else:
            self.bc.run_async(runner.enable_paper(bot_id), on_done=lambda _: self._after(),
                              on_error=lambda e: QMessageBox.warning(self, "Bots", str(e)))

    def _clone(self, bot_id):
        bot = self.bc.runner.get(bot_id)
        if not bot:
            return
        spec = bot.to_json()
        spec.pop("id", None)
        spec.pop("state", None)
        spec["name"] = bot.name + " (clone)"
        spec["mode"] = "paper"
        spec["enabled"] = False
        clone = self.bc.runner.add(spec)
        self.bc.run_async(self.bc.runner.enable_paper(clone.id), on_done=lambda _: self._after())

    def _stop_bot(self, bot_id):
        """Per-bot STOP: truly halt this one bot (enabled=false, scheduler skips
        it, open live orders best-effort cancelled). It stays in the list."""
        runner = self.bc.runner
        if runner is None:
            return
        self.bc.run_async(runner.stop(bot_id), on_done=lambda _: self._after(),
                          on_error=lambda e: QMessageBox.warning(self, "Bots", str(e)))

    def _remove_bot(self, bot_id):
        """Per-bot REMOVE/delete: halt + delete this bot from the store and the UI."""
        runner = self.bc.runner
        if runner is None:
            return
        if QMessageBox.question(self, "Delete bot",
                                "Stop and permanently delete this bot? Its deal history is "
                                "removed. (Open live orders are best-effort cancelled first.)",
                                QMessageBox.Yes | QMessageBox.No, QMessageBox.No) != QMessageBox.Yes:
            return
        self.bc.run_async(runner.remove(bot_id), on_done=lambda _: self._after_remove(),
                          on_error=lambda e: QMessageBox.warning(self, "Bots", str(e)))

    def _kill_bot(self, bot_id):
        if QMessageBox.question(self, "Kill bot",
                                "Stop this bot immediately? (The global Kill-all also locks the "
                                "vault; this just halts the one bot.)") != QMessageBox.Yes:
            return
        self.bc.run_async(self.bc.runner.stop(bot_id), on_done=lambda _: self._after())

    def _after(self):
        self.changed.emit()
        if self.bot_id:
            self.show_bot(self.bot_id)

    def _after_remove(self):
        # the bot is gone — leave the detail view and refresh the cockpit list.
        self.bot_id = None
        self.body.setVisible(False)
        self.placeholder.setVisible(True)
        self.changed.emit()


# =========================================================================== #
# ARENA (PLAY) — the gamified, zero-risk sandbox (§9). Pure play-money sim; it  #
# NEVER touches a key, vault, gate or broadcast. Everything is driven by the    #
# real :class:`~blockle.agent.arena.ArenaProfile` over the shared fixture.      #
# =========================================================================== #
_SCEN_LABELS = [("bull", "📈 Bull"), ("crab", "🦀 Crab"), ("bear", "📉 Bear"),
                ("crash", "💥 Flash-crash"), ("pump", "🚀 Pump & fade")]


class ArenaPanel(QWidget):
    go_create = Signal()

    def __init__(self, bc: BotsController, tokens: Dict[str, str]):
        super().__init__()
        self.bc = bc
        self.tok = tokens
        self.scenario = "bull"
        self._anim: Optional[QTimer] = None
        self._run_result: Optional[Dict[str, Any]] = None
        self._path: List[float] = []
        self._fills: List[Dict[str, Any]] = []
        self._equity: List[float] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 8, 0, 0)
        root.setSpacing(14)

        # top: play balance + level/XP
        top = QHBoxLayout()
        top.setSpacing(16)
        bal = _hline_card()
        bl = QHBoxLayout(bal)
        bl.setContentsMargins(16, 12, 18, 12)
        coin = QLabel("🪙")
        coin.setStyleSheet("font-size:26px;")
        bl.addWidget(coin)
        bv = QVBoxLayout()
        bv.setSpacing(1)
        t = QLabel("PLAY BALANCE")
        t.setStyleSheet(f"color:{tokens['warn']}; font-size:10px; font-weight:800; letter-spacing:2px;")
        bv.addWidget(t)
        self.play_bal = QLabel("—")
        self.play_bal.setObjectName("mono")
        self.play_bal.setStyleSheet(f"font-size:22px; font-weight:800; font-family:{MONO};")
        bv.addWidget(self.play_bal)
        bl.addLayout(bv)
        top.addWidget(bal)

        lvlcard = _hline_card()
        ll = QVBoxLayout(lvlcard)
        ll.setContentsMargins(16, 12, 18, 12)
        lr = QHBoxLayout()
        self.lvl_name = QLabel("Lv 1")
        self.lvl_name.setStyleSheet(f"color:{tokens['accent']}; font-weight:800;")
        self.xp_txt = QLabel("0 XP")
        self.xp_txt.setObjectName("mono")
        self.xp_txt.setStyleSheet(f"color:{tokens['ink_muted']}; font-family:{MONO};")
        lr.addWidget(self.lvl_name)
        lr.addStretch(1)
        lr.addWidget(self.xp_txt)
        ll.addLayout(lr)
        self.xp_bar = AllocBar(tokens, 0)
        ll.addWidget(self.xp_bar)
        self.unlock_lbl = QLabel("Next unlock: —")
        self.unlock_lbl.setObjectName("sub")
        ll.addWidget(self.unlock_lbl)
        top.addWidget(lvlcard, 1)
        root.addLayout(top)

        # main: sim | mission
        main = QHBoxLayout()
        main.setSpacing(16)
        simcard = _hline_card()
        sv = QVBoxLayout(simcard)
        sv.setContentsMargins(20, 18, 20, 18)
        sv.setSpacing(10)
        shead = QHBoxLayout()
        shv = QVBoxLayout()
        shv.setSpacing(2)
        shv.addWidget(_eyebrow("Simulated market · seeded & replayable"))
        self.sim_title = QLabel("Conservative DCA · SOL")
        self.sim_title.setStyleSheet("font-size:15px; font-weight:700;")
        shv.addWidget(self.sim_title)
        shead.addLayout(shv)
        shead.addStretch(1)
        self.sim_state = QLabel("Ready")
        self.sim_state.setObjectName("chipType")
        shead.addWidget(self.sim_state, 0, Qt.AlignTop)
        sv.addLayout(shead)

        scen = QHBoxLayout()
        scen.setSpacing(6)
        self.scen_group = QButtonGroup(self)
        for key, label in _SCEN_LABELS:
            b = QPushButton(label)
            b.setObjectName("scen")
            b.setCheckable(True)
            b.setChecked(key == "bull")
            b.clicked.connect(lambda _c=False, k=key: self._pick_scen(k))
            self.scen_group.addButton(b)
            scen.addWidget(b)
        scen.addStretch(1)
        sv.addLayout(scen)

        self.sim = ArenaSim(tokens)
        sv.addWidget(self.sim, 1)

        foot = QHBoxLayout()
        foot.setSpacing(14)
        self.run_btn = QPushButton("▶  Run simulation")
        self.run_btn.setObjectName("primary")
        self.run_btn.clicked.connect(self._run)
        foot.addWidget(self.run_btn)
        for attr, label in [("pnl", "Play P&L"), ("score", "Score"), ("dd", "Max drawdown")]:
            box = QVBoxLayout()
            box.setSpacing(2)
            box.addWidget(_eyebrow(label))
            v = QLabel("—")
            v.setObjectName("mono")
            v.setStyleSheet(f"font-size:18px; font-weight:800; font-family:{MONO};")
            box.addWidget(v)
            setattr(self, f"sim_{attr}", v)
            bw = QWidget()
            bw.setLayout(box)
            foot.addWidget(bw)
        foot.addStretch(1)
        sv.addLayout(foot)

        disc = QLabel("⚠ " + self.bc.vectors.get("disclaimer", "Simulation with play funds — not "
                      "financial advice. Simulated performance does not predict real results."))
        disc.setObjectName("disclaim")
        disc.setWordWrap(True)
        sv.addWidget(disc)
        main.addWidget(simcard, 3)

        # mission column
        mcard = _hline_card()
        mv = QVBoxLayout(mcard)
        mv.setContentsMargins(18, 16, 18, 16)
        mv.setSpacing(8)
        mh = QHBoxLayout()
        mt = QLabel("🎯 Mission")
        mt.setStyleSheet("font-size:14px; font-weight:800;")
        mh.addWidget(mt)
        mh.addStretch(1)
        self.mission_reward = QLabel("")
        self.mission_reward.setObjectName("chip")
        mh.addWidget(self.mission_reward)
        mv.addLayout(mh)
        self.mission_goal = QLabel("")
        self.mission_goal.setObjectName("sub")
        self.mission_goal.setWordWrap(True)
        mv.addWidget(self.mission_goal)
        design = QPushButton("Design your strategy →")
        design.clicked.connect(self.go_create.emit)
        mv.addWidget(design)

        mv.addWidget(_eyebrow("Badges"))
        self.badges_row = QHBoxLayout()
        self.badges_row.setSpacing(8)
        bw = QWidget()
        bw.setLayout(self.badges_row)
        mv.addWidget(bw)

        mv.addWidget(_eyebrow("Leaderboard · local"))
        self.lb_box = QVBoxLayout()
        self.lb_box.setSpacing(2)
        lbw = QWidget()
        lbw.setLayout(self.lb_box)
        mv.addWidget(lbw)
        lb_note = QLabel("Global leaderboard & shareable runs — coming later.")
        lb_note.setObjectName("disclaim")
        mv.addWidget(lb_note)

        self.use_real = QPushButton("✓  Use this strategy for real (starts in paper)")
        self.use_real.setObjectName("primary")
        self.use_real.clicked.connect(self._use_for_real)
        mv.addWidget(self.use_real)
        mv.addStretch(1)
        main.addWidget(mcard, 2)
        root.addLayout(main, 1)

        self._load_scen("bull")
        self.refresh()

    def set_tokens(self, tokens):
        self.tok = tokens
        self.sim.set_tokens(tokens)
        self.xp_bar.tok = tokens
        self.refresh()

    # ---- the arena config: reuse a real template (Conservative DCA on SOL) ----
    def _arena_bot(self):
        return {"type": "dca", "name": "Conservative DCA",
                "pair": "SOL/USDC",
                "config": dict(templates_mod.TEMPLATES["conservative_dca"]["config"])}

    def _pick_scen(self, key):
        self.scenario = key
        self._load_scen(key)

    def _load_scen(self, key):
        """Preview the path + the engine's planned fills WITHOUT recording a run."""
        res = arena_mod.run_scenario({"vectors": self.bc.vectors, "scenario": key,
                                      "bot": self._arena_bot()})
        self._path = arena_mod.price_path(self.bc.vectors, key)
        self._fills = self._decorate_fills(res["fills"])
        self._equity = [bots_mod.uc_to_usd(x) or 0.0 for x in res["equityCurveUc"]]
        self.sim.set_run(self._path, self._fills)
        self.sim_state.setText("Ready")
        self.sim_pnl.setText("+$0.00")
        self.sim_score.setText("—")
        self.sim_dd.setText("—")

    def _decorate_fills(self, fills):
        """Attach a plot price (USD) to each engine fill for the chart."""
        out = []
        for f in fills:
            pr_uc = f.get("priceUc")
            try:
                pr = float(pr_uc) / 1e6 if pr_uc is not None else None
            except (TypeError, ValueError):
                pr = None
            out.append({"t": f.get("t", 0), "side": f.get("side"), "_price": pr})
        return out

    def _run(self):
        if self._anim and self._anim.isActive():
            return
        # record the run into the REAL profile (XP / missions / badges / board).
        # profile.run() is deterministic from the shared fixture and accrues XP +
        # moves the play balance SYNCHRONOUSLY here — no RNG, no gate.
        profile = self.bc.arena()
        rec = profile.run({"vectors": self.bc.vectors, "scenario": self.scenario,
                           "bot": self._arena_bot()})
        res = rec["result"]
        self._run_result = rec
        self._equity = [bots_mod.uc_to_usd(x) or 0.0 for x in res["equityCurveUc"]]
        self._fills = self._decorate_fills(res["fills"])
        self.sim.set_run(self._path, self._fills, upto=0)
        # COMMIT the authoritative result up-front: score, PnL, drawdown and the
        # play-balance display are set NOW, decoupled from the animation. This is
        # robust to headless/offscreen QTimer behaviour (where the reveal below may
        # never advance). The _anim timer is PURELY VISUAL — it animates the chart
        # and the PnL number toward this already-decided result.
        self._commit_result(res, rec)
        # animate the reveal (respects a static fallback if the curve is short)
        self._anim_i = 0
        self._anim = QTimer(self)
        self._anim.setInterval(20)
        self._anim.timeout.connect(lambda: self._tick_anim(res, rec))
        self._anim.start()

    def _tick_anim(self, res, rec):
        N = len(self._path)
        self._anim_i += 2
        if self._anim_i >= N - 1:
            self._anim_i = N - 1
        self.sim.set_upto(self._anim_i)
        if self._anim_i < len(self._equity):
            eq = self._equity[self._anim_i]
            self.sim_pnl.setText(money(eq))
            self.sim_pnl.setStyleSheet(
                f"font-size:18px; font-weight:800; font-family:{MONO};"
                f"color:{self.tok['gain'] if eq >= 0 else self.tok['loss']};")
        if self._anim_i >= N - 1:
            self._anim.stop()
            self._finish(res, rec)

    def _commit_result(self, res, rec):
        """Set the authoritative run result on the panel synchronously (score,
        PnL, drawdown, state) and refresh the profile display (XP, play balance).
        Idempotent — the animation's _finish re-settles to the same values."""
        pnl = bots_mod.uc_to_usd(res["finalPnlUc"]) or 0.0
        self.sim_pnl.setText(money(pnl))
        self.sim_pnl.setStyleSheet(f"font-size:18px; font-weight:800; font-family:{MONO};"
                                   f"color:{self.tok['gain'] if pnl >= 0 else self.tok['loss']};")
        sc = res["score"]
        self.sim_score.setText(("+" if sc >= 0 else "") + f"{sc:.1f}")
        dd_pct = (res["ddTenthPct"] or 0) / 10.0
        self.sim_dd.setText(f"−{dd_pct:.1f}%")
        self.sim_state.setText(f"Done · {('+' if sc >= 0 else '')}{sc:.1f}")
        self.refresh()

    def _finish(self, res, rec):
        # end-of-animation settle — re-commit the (already-decided) result.
        self._commit_result(res, rec)

    def refresh(self):
        profile = self.bc.arena()
        pb = profile.playBalance.to_json()
        bal_uc = pb.get("balanceUc")
        try:
            bal = float(bal_uc) / 1e6
        except (TypeError, ValueError):
            bal = 0.0
        self.play_bal.setText(f"{bal:,.0f}")
        lvl = profile.level()
        self.lvl_name.setText(f"Lv {lvl['level']}")
        nxt = lvl.get("xpToNext") or 0
        self.xp_txt.setText(f"{lvl['xp']} XP" + (f" · {nxt} to next" if lvl.get("nextLevel") else " · max"))
        # xp progress within the current band
        self.xp_bar.pct = self._xp_pct(lvl)
        self.xp_bar.update()
        unlocks = lvl.get("unlocks") or []
        self.unlock_lbl.setText("Unlocked: " + (", ".join(unlocks[-3:]) if unlocks else "—"))

        # mission: first incomplete, else a completed one
        mission = None
        for m in arena_mod.MISSIONS:
            if m["id"] not in profile.missions_completed:
                mission = m
                break
        if mission is None and arena_mod.MISSIONS:
            mission = arena_mod.MISSIONS[0]
        if mission:
            self.mission_reward.setText(f"+{mission['rewardXp']} XP")
            done = mission["id"] in profile.missions_completed
            self.mission_goal.setText(("✓ " if done else "") + mission["desc"])

        # badges
        while self.badges_row.count():
            it = self.badges_row.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
        icons = {"first_run": "🎓", "green_run": "💚", "high_score": "🎯",
                 "diamond_hands": "🛡️", "all_scenarios": "🌍", "veteran": "💎"}
        for b in arena_mod.BADGES:
            earned = b["id"] in profile.badges
            lb = QLabel(icons.get(b["id"], "🏅"))
            lb.setToolTip(f"{b['name']} — {b['desc']}" + ("" if earned else "  (locked)"))
            lb.setStyleSheet("font-size:22px;" + ("" if earned else "color:#555;"))
            if not earned:
                lb.setEnabled(False)
            self.badges_row.addWidget(lb)
        self.badges_row.addStretch(1)

        # leaderboard (local, real)
        while self.lb_box.count():
            it = self.lb_box.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
        top = profile.leaderboard.top(self.scenario, 5)
        if not top:
            empty = QLabel("Run a sim to put a score on the board.")
            empty.setObjectName("sub")
            self.lb_box.addWidget(empty)
        else:
            for i, e in enumerate(top):
                row = QHBoxLayout()
                rk = QLabel(str(i + 1))
                rk.setObjectName("mono")
                rk.setFixedWidth(20)
                rk.setStyleSheet(f"color:{self.tok['ink_faint']}; font-family:{MONO}; font-weight:700;")
                nm = QLabel(e.get("name") or "you")
                sc = e.get("score")
                scl = QLabel(("+" if sc >= 0 else "") + f"{sc:.1f}")
                scl.setObjectName("mono")
                scl.setStyleSheet(f"font-family:{MONO}; font-weight:700;"
                                  f"color:{self.tok['gain'] if sc >= 0 else self.tok['loss']};")
                row.addWidget(rk)
                row.addWidget(nm)
                row.addStretch(1)
                row.addWidget(scl)
                rw = QWidget()
                rw.setLayout(row)
                self.lb_box.addWidget(rw)

    def _xp_pct(self, lvl):
        levels = arena_mod.LEVELS
        cur_min = 0
        nxt_min = None
        for lv in levels:
            if lv["level"] == lvl["level"]:
                cur_min = lv["minXp"]
            if lvl.get("nextLevel") and lv["level"] == lvl["nextLevel"]:
                nxt_min = lv["minXp"]
        if nxt_min is None or nxt_min <= cur_min:
            return 100
        return int((lvl["xp"] - cur_min) / (nxt_min - cur_min) * 100)

    def _use_for_real(self):
        # the ONE honest on-ramp: export -> import ALWAYS lands paper + disabled.
        try:
            runner = self.bc.ensure_runner()
        except RuntimeError as e:
            QMessageBox.information(self, "Unlock needed",
                                    str(e) + "\n\nThe strategy is ready — unlock to import it as a "
                                    "paper bot (it never auto-goes-live).")
            return
        bot = arena_mod.use_for_real(self._arena_bot())  # paper + disabled + testnet + alloc 0
        added = runner.add(bot.to_json())
        self.bc.run_async(runner.enable_paper(added.id),
                          on_done=lambda _: QMessageBox.information(
                              self, "Imported as paper bot",
                              f"'{added.name}' landed as a PAPER + disabled bot with a $0 allocation. "
                              f"Set an allocation and arm it live from Bot detail when ready — the "
                              f"arming + allocation + mainnet gates are never skipped."))


# =========================================================================== #
# BotsPanel — the single widget added as the wallet's "Bots" tab. Header        #
# (Paper/Live filter + KILL-ALL + theme) over an inner Cockpit/Create/Detail/   #
# Arena tab set, all sharing ONE BotsController (= ONE real BotRunner).         #
# =========================================================================== #
class BotsPanel(QWidget):
    def __init__(self, ctrl: Any, theme: str = "dark"):
        super().__init__()
        self.setObjectName("botsRoot")
        self.ctrl = ctrl
        self.bc = BotsController(ctrl)
        self.theme = theme if theme in ("dark", "light") else "dark"
        self.tok = TOKENS_DARK if self.theme == "dark" else TOKENS_LIGHT

        root = QVBoxLayout(self)
        root.setContentsMargins(18, 14, 18, 14)
        root.setSpacing(10)

        # ---- header bar ----
        header = QHBoxLayout()
        brand = QLabel("◆ Blockle Bots")
        brand.setStyleSheet("font-size:16px; font-weight:800;")
        header.addWidget(brand)
        dexpill = QLabel("DEX")
        dexpill.setObjectName("chip")
        header.addWidget(dexpill)
        header.addStretch(1)

        theme_btn = QPushButton("☾" if self.theme == "dark" else "☀")
        theme_btn.setFixedWidth(40)
        theme_btn.setToolTip("Toggle light / dark theme")
        theme_btn.clicked.connect(self._toggle_theme)
        header.addWidget(theme_btn)
        self.theme_btn = theme_btn

        self.kill_btn = QPushButton("⏻  Kill all")
        self.kill_btn.setObjectName("kill")
        self.kill_btn.clicked.connect(self._kill_all)
        header.addWidget(self.kill_btn)
        root.addLayout(header)

        # ---- inner tabs ----
        from PySide6.QtWidgets import QTabWidget
        self.tabs = QTabWidget()
        self.cockpit = CockpitPanel(self.bc, self.tok)
        self.create = CreatePanel(self.bc, self.tok)
        self.detail = DetailPanel(self.bc, self.tok)
        self.arena = ArenaPanel(self.bc, self.tok)
        self.tabs.addTab(self.cockpit, "Cockpit")
        self.tabs.addTab(self.create, "Create a bot")
        self.tabs.addTab(self.detail, "Bot detail")
        self.tabs.addTab(self.arena, "Arena ⬤ PLAY")
        root.addWidget(self.tabs, 1)

        # wiring between surfaces
        self.cockpit.open_detail.connect(self._open_detail)
        self.create.created.connect(self.cockpit.refresh)
        self.detail.changed.connect(self.cockpit.refresh)
        self.arena.go_create.connect(lambda: self.tabs.setCurrentWidget(self.create))
        self.bc.event.connect(self._on_runner_event)

        self.setStyleSheet(build_qss(self.tok))
        self.cockpit.refresh()

        # a gentle periodic cockpit refresh (reads real dashboards; no trading)
        self._timer = QTimer(self)
        self._timer.setInterval(5000)
        self._timer.timeout.connect(self._periodic)
        self._timer.start()

    # ---- theme ----
    def _toggle_theme(self):
        self.theme = "light" if self.theme == "dark" else "dark"
        self.tok = TOKENS_DARK if self.theme == "dark" else TOKENS_LIGHT
        self.theme_btn.setText("☾" if self.theme == "dark" else "☀")
        for p in (self.cockpit, self.create, self.detail, self.arena):
            p.set_tokens(self.tok)
        self.setStyleSheet(build_qss(self.tok))
        self.cockpit.refresh()

    def _open_detail(self, bot_id: str):
        self.detail.show_bot(bot_id)
        self.tabs.setCurrentWidget(self.detail)

    def _periodic(self):
        if self.tabs.currentWidget() is self.cockpit:
            self.cockpit.refresh()

    def _on_runner_event(self, ev: Dict[str, Any]):
        # realized-profit pop-ups come from the notify module inside the engine;
        # here we just keep the cockpit live on lifecycle events.
        self.cockpit.refresh()

    def _kill_all(self):
        if self.bc.runner is None:
            QMessageBox.information(self, "Kill all",
                                   "No live runner yet — unlock the vault to manage bots.")
            return
        if QMessageBox.question(
                self, "Kill all bots",
                "Stop ALL bots immediately, best-effort cancel their open orders, and LOCK the "
                "vault (wiping decrypted keys + the LLM credential)? This is the emergency stop.",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No) != QMessageBox.Yes:
            return
        self.bc.run_async(self.bc.runner.kill_all("ui kill-all"),
                          on_done=lambda _: self.cockpit.refresh(),
                          on_error=lambda e: QMessageBox.warning(self, "Kill all", str(e)))


def build_bots_tab(ctrl: Any, theme: str = "dark"):
    """Return ``(BotsPanel, "Bots")`` for the wallet's tab bar, sharing the given
    :class:`~blockle.qtmultichain.MultiChainController`."""
    return BotsPanel(ctrl, theme=theme), "Bots"
