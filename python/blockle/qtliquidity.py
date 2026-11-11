"""blockle.qtliquidity — the Blockle Liquidity panel for the desktop (Qt) wallet.

Parity with the Flutter liquidity screen: ONE server-authoritative BLOCK price
(the supply-scaled moonshot bonding curve) shared across every wallet, with a
BLOCK<->coin swap. Reads/writes the account service at
`/account/api/liquidity/{state,quote,swap}` (services/accounts/src/liquidity.js
is the source of truth). On-chain settlement is gated server-side; a swap records
the intent and returns the custodial deposit address to send the input asset to.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Callable, Optional

from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtWidgets import (
    QComboBox, QFrame, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton,
    QVBoxLayout, QWidget,
)

API_BASE = os.environ.get("BLOCKLE_ACCOUNT_ORIGIN", "https://blockle.org").rstrip("/")
# Stablecoins price at $1 with no feed; others need a USD mark (price_usd_map).
STABLE = {"USDC", "USDT", "DAI", "USD", "USDB", "PYUSD", "TUSD"}
SWAP_COINS = ["USDC", "USDT", "DAI", "USDB", "SOL", "ETH", "BNB", "MATIC", "AVAX"]


def _http(path: str, method: str = "GET", body: Optional[dict] = None, timeout: int = 20) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"accept": "application/json"}
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(API_BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode() or "{}")
        except Exception:
            return {"error": f"http {e.code}"}


class _Worker(QThread):
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, fn: Callable[[], Any]) -> None:
        super().__init__()
        self._fn = fn

    def run(self) -> None:
        try:
            self.done.emit(self._fn())
        except Exception as e:  # pragma: no cover
            self.failed.emit(str(e))


def _fmt_usd(n: Any) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "—"
    if v >= 1_000_000:
        return f"${v / 1_000_000:.2f}M"
    if v >= 1:
        return f"${v:,.2f}"
    return f"${v:.6f}".rstrip("0").rstrip(".")


def _fmt(n: Any, dp: int = 6) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "—"
    if v == 0:
        return "0"
    s = f"{v:.{dp}f}".rstrip("0").rstrip(".")
    return s


class LiquidityPanel(QWidget):
    """BLOCK<->coin swap on the shared server bonding curve + live pool stats."""

    def __init__(self, ctrl: Any) -> None:
        super().__init__()
        self.ctrl = ctrl
        self._workers: list[_Worker] = []
        self._state: dict = {}

        root = QVBoxLayout(self)
        root.setContentsMargins(22, 22, 22, 22)
        root.setSpacing(12)

        title = QLabel("Blockle Liquidity")
        title.setStyleSheet("font-size: 21px; font-weight: 800;")
        root.addWidget(title)

        # ---- live price / market cap ----
        head = QFrame()
        head.setFrameShape(QFrame.StyledPanel)
        hl = QHBoxLayout(head)
        self.price_lbl = self._stat(hl, "1 BLOCK", "—")
        self.cap_lbl = self._stat(hl, "market cap", "—")
        self.supply_lbl = self._stat(hl, "circulating", "—")
        root.addWidget(head)

        # ---- swap card ----
        card = QFrame()
        card.setFrameShape(QFrame.StyledPanel)
        cl = QVBoxLayout(card)
        cl.setContentsMargins(16, 16, 16, 16)
        cl.setSpacing(10)

        row = QHBoxLayout()
        self.dir_box = QComboBox()
        self.dir_box.addItems(["Buy BLOCK with", "Sell BLOCK for"])
        self.dir_box.currentIndexChanged.connect(lambda _: self._quote())
        row.addWidget(self.dir_box, 2)
        self.coin_box = QComboBox()
        self.coin_box.addItems(SWAP_COINS)
        self.coin_box.currentIndexChanged.connect(lambda _: self._quote())
        row.addWidget(self.coin_box, 1)
        cl.addLayout(row)

        self.amount = QLineEdit()
        self.amount.setPlaceholderText("Amount")
        self.amount.textChanged.connect(lambda _: self._quote())
        cl.addWidget(self.amount)

        self.quote_lbl = QLabel("Enter an amount for a quote.")
        self.quote_lbl.setStyleSheet("color: palette(mid);")
        self.quote_lbl.setWordWrap(True)
        cl.addWidget(self.quote_lbl)

        self.swap_btn = QPushButton("Swap")
        self.swap_btn.setMinimumHeight(40)
        self.swap_btn.setEnabled(False)
        self.swap_btn.clicked.connect(self._swap)
        cl.addWidget(self.swap_btn)
        root.addWidget(card)

        foot = QHBoxLayout()
        self.reserves_lbl = QLabel("pool reserves: —")
        self.reserves_lbl.setStyleSheet("color: palette(mid); font-size: 12px;")
        self.reserves_lbl.setWordWrap(True)
        foot.addWidget(self.reserves_lbl, 1)
        rb = QPushButton("Refresh")
        rb.clicked.connect(self._refresh)
        foot.addWidget(rb)
        root.addLayout(foot)
        root.addStretch(1)

        self._poll = QTimer(self)
        self._poll.timeout.connect(self._refresh)
        self._poll.start(30_000)
        self._refresh()

    def _stat(self, lay: QHBoxLayout, label: str, value: str) -> QLabel:
        box = QVBoxLayout()
        v = QLabel(value)
        v.setStyleSheet("font-size: 17px; font-weight: 700;")
        l = QLabel(label)
        l.setStyleSheet("color: palette(mid); font-size: 11px;")
        box.addWidget(v)
        box.addWidget(l)
        lay.addLayout(box)
        return v

    # ---- helpers ----
    def _run(self, fn: Callable[[], Any], ok: Callable[[Any], None]) -> None:
        w = _Worker(fn)
        w.done.connect(lambda res: (ok(res), self._workers.remove(w) if w in self._workers else None))
        w.failed.connect(lambda e: (self.quote_lbl.setText(e),
                                    self._workers.remove(w) if w in self._workers else None))
        self._workers.append(w)
        w.start()

    def _coin_usd(self, coin: str) -> float:
        if coin in STABLE:
            return 1.0
        try:
            m = self.ctrl.price_usd_map() or {}
            return float(m.get(coin) or m.get(coin.upper()) or 0)
        except Exception:
            return 0.0

    def _block_address(self) -> Optional[str]:
        try:
            return self.ctrl.block_wallet.snapshot().get("wallet", {}).get("address")
        except Exception:
            return None

    # ---- state ----
    def _refresh(self) -> None:
        self._run(lambda: _http("/account/api/liquidity/state"), self._on_state)

    def _on_state(self, s: Any) -> None:
        if not isinstance(s, dict):
            return
        self._state = s
        self.price_lbl.setText(_fmt_usd(s.get("blockPriceUsd")))
        self.cap_lbl.setText(_fmt_usd(s.get("marketCapUsd")))
        cs = s.get("circulatingSupply")
        self.supply_lbl.setText(f"{float(cs):,.0f} BLOCK" if cs else "—")
        res = s.get("reserves") or {}
        if res:
            self.reserves_lbl.setText("pool reserves: " + ", ".join(
                f"{_fmt(v, 3)} {k}" for k, v in sorted(res.items())))
        else:
            self.reserves_lbl.setText("pool reserves: none yet")

    # ---- quote ----
    def _sides(self):
        coin = self.coin_box.currentText()
        if self.dir_box.currentIndex() == 0:  # Buy BLOCK with <coin>
            return coin, "BLOCK", coin
        return "BLOCK", coin, coin  # Sell BLOCK for <coin>

    def _quote(self) -> None:
        self.swap_btn.setEnabled(False)
        try:
            amt = float(self.amount.text())
        except ValueError:
            self.quote_lbl.setText("Enter an amount for a quote.")
            return
        if amt <= 0:
            return
        frm, to, coin = self._sides()
        cu = self._coin_usd(coin)
        if cu <= 0:
            self.quote_lbl.setText(f"No USD price for {coin} on this device — use a stablecoin, "
                                   "or set its price in Settings.")
            return
        self._run(
            lambda: _http("/account/api/liquidity/quote", method="POST",
                          body={"from": frm, "to": to, "amountIn": amt, "coinUsd": cu}),
            self._on_quote)

    def _on_quote(self, q: Any) -> None:
        if not isinstance(q, dict) or not q.get("ok"):
            self.quote_lbl.setText((q or {}).get("reason") or "No quote available.")
            self.swap_btn.setEnabled(False)
            return
        _, to, _ = self._sides()
        self.quote_lbl.setText(f"You receive ≈ {_fmt(q.get('amountOut'))} {to}  "
                               f"(1 BLOCK = {_fmt_usd(q.get('blockPriceUsd'))})")
        self.swap_btn.setEnabled(True)

    # ---- swap ----
    def _swap(self) -> None:
        try:
            amt = float(self.amount.text())
        except ValueError:
            return
        frm, to, coin = self._sides()
        cu = self._coin_usd(coin)
        addr = self._block_address()
        self.swap_btn.setEnabled(False)
        self.quote_lbl.setText("Submitting…")
        self._run(
            lambda: _http("/account/api/liquidity/swap", method="POST",
                          body={"from": frm, "to": to, "amountIn": amt, "coinUsd": cu,
                                "userAddress": addr}),
            self._on_swap)

    def _on_swap(self, r: Any) -> None:
        self.swap_btn.setEnabled(True)
        if not isinstance(r, dict) or r.get("error") or not r.get("ok", r.get("id")):
            QMessageBox.warning(self, "Blockle Liquidity",
                                (r or {}).get("error") or (r or {}).get("reason") or "Swap failed.")
            return
        dep = r.get("depositAddress")
        _, to, _ = self._sides()
        msg = f"Swap recorded: you receive ≈ {_fmt(r.get('amountOut'))} {to}."
        if r.get("status") == "awaiting-deposit" and dep:
            msg += (f"\n\nSend your {r.get('from')} to the treasury to complete it:\n{dep}\n\n"
                    "The payout settles automatically once the deposit confirms.")
        QMessageBox.information(self, "Blockle Liquidity", msg)
        self._refresh()


def build_liquidity_tab(ctrl: Any):
    """Return ``(LiquidityPanel, "Liquidity")`` for the wallet's tab bar."""
    return LiquidityPanel(ctrl), "Liquidity"
