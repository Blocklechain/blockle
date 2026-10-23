"""Trade tab — the custodial shared-price BLOCK AMM (super-amm).

Buy/sell BLOCK against the base-chain coins (SOL/ETH/BTC/LTC/DOGE) via the live
``/api/amm`` endpoints. In LIVE mode a trade is an intent: the user sends the
quote currency to the pool deposit address, we detect it, execute at the quoted
price, and pay out — the panel shows the deposit address and polls to settlement.
PAPER mode uses the instant ``/amm/trade`` endpoint.

Network calls run off the UI thread (a worker thread + a Qt signal), so the panel
never freezes. ADDITIVE and self-contained — guarded at the build_tabs call site.
"""
from __future__ import annotations
import json
import threading
import urllib.error
import urllib.request
from decimal import Decimal

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import (
    QComboBox, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget,
)

AMM = "https://blockle.org/api/amm"
CHAIN_OF = {"SOL": "solana", "ETH": "ethereum", "BTC": "bitcoin", "LTC": "litecoin", "DOGE": "dogecoin"}


def _http(method: str, path: str, body=None):
    url = AMM + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"accept": "application/json"}
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 (fixed host)
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:  # network/timeout
        return 0, {"error": str(e)}


def _to_base(s: str, dec: int) -> str:
    s = (s or "").strip()
    if not s:
        return "0"
    try:
        q = (Decimal(s) * (Decimal(10) ** dec)).to_integral_value()
        return str(int(q)) if q > 0 else "0"
    except Exception:
        return "0"


def _whole(base, dec: int) -> float:
    try:
        return float(Decimal(int(base)) / (Decimal(10) ** dec))
    except Exception:
        try:
            return float(base) / (10 ** dec)
        except Exception:
            return 0.0


class _Net(QObject):
    """Runs an HTTP call on a worker thread, delivers (tag, status, json) on the UI thread."""
    done = Signal(object)

    def call(self, tag, method, path, body=None):
        def work():
            st, j = _http(method, path, body)
            self.done.emit((tag, st, j))
        threading.Thread(target=work, daemon=True).start()


class TradeTab(QWidget):
    def __init__(self, ctrl):
        super().__init__()
        self.ctrl = ctrl
        self.side = "buy"
        self.pairs = []
        self.dec = {"BLOCK": 8}
        self.live = False
        self.intent_id = None
        self.net = _Net()
        self.net.done.connect(self._on_net)
        self._build()
        self._qtimer = QTimer(self)
        self._qtimer.setSingleShot(True)
        self._qtimer.timeout.connect(self.quote)
        self._poll = QTimer(self)
        self._poll.timeout.connect(self._poll_tick)
        self.refresh()

    # ---- UI ----
    def _build(self):
        v = QVBoxLayout(self)
        self.price = QLabel("BLOCK price  —")
        self.price.setStyleSheet("font-size:20px;font-weight:600")
        v.addWidget(self.price)
        self.sub = QLabel("")
        self.sub.setStyleSheet("color:#888;font-size:12px")
        v.addWidget(self.sub)

        srow = QHBoxLayout()
        self.buy_btn = QPushButton("Buy BLOCK")
        self.sell_btn = QPushButton("Sell BLOCK")
        for b in (self.buy_btn, self.sell_btn):
            b.setCheckable(True)
        self.buy_btn.setChecked(True)
        self.buy_btn.clicked.connect(lambda: self._set_side("buy"))
        self.sell_btn.clicked.connect(lambda: self._set_side("sell"))
        srow.addWidget(self.buy_btn)
        srow.addWidget(self.sell_btn)
        v.addLayout(srow)

        arow = QHBoxLayout()
        self.amt = QLineEdit()
        self.amt.setPlaceholderText("Amount")
        self.amt.textChanged.connect(lambda _=None: self._qtimer.start(250))
        self.cur = QComboBox()
        self.cur.currentIndexChanged.connect(lambda _=None: self.quote())
        arow.addWidget(self.amt, 2)
        arow.addWidget(self.cur, 1)
        v.addLayout(arow)

        self.amt_lbl = QLabel("You pay")
        self.amt_lbl.setStyleSheet("color:#888;font-size:12px")
        v.addWidget(self.amt_lbl)

        self.quote_lbl = QLabel("Enter an amount.")
        self.quote_lbl.setWordWrap(True)
        v.addWidget(self.quote_lbl)

        self.go = QPushButton("Enter an amount")
        self.go.setEnabled(False)
        self.go.clicked.connect(self.execute)
        v.addWidget(self.go)

        self.status = QLabel("")
        self.status.setWordWrap(True)
        self.status.setTextInteractionFlags(self.status.textInteractionFlags())
        v.addWidget(self.status)

        self.pairs_lbl = QLabel("")
        self.pairs_lbl.setWordWrap(True)
        self.pairs_lbl.setStyleSheet("color:#aaa;font-size:12px")
        v.addWidget(self.pairs_lbl)
        v.addStretch(1)

    def _set_side(self, side):
        self.side = side
        self.buy_btn.setChecked(side == "buy")
        self.sell_btn.setChecked(side == "sell")
        self.amt_lbl.setText("You pay" if side == "buy" else "You sell (BLOCK)")
        self.quote()

    def _cur_sym(self):
        return self.cur.currentText().split(" ")[0] if self.cur.count() else ""

    def _cur_dec(self):
        return self.dec.get(self._cur_sym(), 8)

    # ---- data ----
    def refresh(self):
        self.net.call("info", "GET", "/info")

    def quote(self):
        sym = self._cur_sym()
        if not sym:
            return
        in_dec = self._cur_dec() if self.side == "buy" else self.dec.get("BLOCK", 8)
        amt_base = _to_base(self.amt.text(), in_dec)
        if amt_base == "0":
            self.quote_lbl.setText("Enter an amount.")
            self.go.setEnabled(False)
            self.go.setText("Enter an amount")
            return
        self.quote_lbl.setText("Quoting…")
        self.go.setEnabled(False)
        self.net.call("quote", "GET", f"/quote?side={self.side}&sym={sym}&amount={amt_base}")

    def execute(self):
        sym = self._cur_sym()
        in_dec = self._cur_dec() if self.side == "buy" else self.dec.get("BLOCK", 8)
        amt_base = _to_base(self.amt.text(), in_dec)
        if amt_base == "0":
            return
        self.go.setEnabled(False)
        if not self.live:
            self.go.setText("Submitting…")
            self.net.call("trade", "POST", "/trade", {"side": self.side, "sym": sym, "amount": amt_base, "to": self._addr("block")})
            return
        self.go.setText("Creating order…")
        pair = next((p for p in self.pairs if p["sym"] == sym), {})
        payout = self._addr("block") if self.side == "buy" else self._addr(pair.get("chain", "block"))
        self.net.call("intent", "POST", "/intent", {"side": self.side, "sym": sym, "amount": amt_base, "payoutAddress": payout})

    def _addr(self, chain):
        try:
            a = self.ctrl.accounts.get(chain)
            return a.address if a else ""
        except Exception:
            return ""

    # ---- network results (UI thread) ----
    def _on_net(self, payload):
        tag, status, j = payload
        if tag == "info":
            self._render_info(j)
        elif tag == "quote":
            self._render_quote(status, j)
        elif tag == "trade":
            self._render_trade(status, j)
        elif tag == "intent":
            self._render_intent(status, j)
        elif tag == "poll":
            self._render_poll(j)

    def _render_info(self, info):
        if not info or info.get("error"):
            self.pairs_lbl.setText("Market unavailable right now.")
            return
        self.live = bool(info.get("live"))
        self.pairs = info.get("pairs", [])
        self.dec = {"BLOCK": info.get("blockDecimals", 8)}
        for p in self.pairs:
            self.dec[p["sym"]] = p["decimals"]
        self.price.setText("BLOCK price  $%s" % ("%g" % info.get("priceUsd", 0)))
        seed = info.get("seed", {})
        self.sub.setText(("PAPER — no real funds move · " if info.get("paper") else "")
                         + "fee %s%% · seed %s BLOCK @ $%s"
                         % (info.get("feeBps", 0) / 100, format(int(seed.get("block", 0)), ","), seed.get("priceUsd")))
        if self.cur.count() != len(self.pairs):
            self.cur.blockSignals(True)
            self.cur.clear()
            for p in self.pairs:
                self.cur.addItem(f"{p['sym']} · {p['network']}")
            self.cur.blockSignals(False)
        lines = []
        for p in self.pairs:
            liq = p.get("hasLiquidity")
            mb = _whole(p.get("maxSellableBlockBase", 0), info.get("blockDecimals", 8))
            lines.append(f"{p['pair']} — {p['network']} · " + (f"sellable ≤ {mb:,.2f} BLOCK" if liq else "no liquidity yet"))
        self.pairs_lbl.setText("\n".join(lines))

    def _render_quote(self, status, d):
        if status != 200 or d.get("error"):
            self.quote_lbl.setText(d.get("error", "Quote failed"))
            return
        before = float(d.get("priceBeforeMicroUsd", 0) or 0)
        after = float(d.get("priceAfterMicroUsd", 0) or 0)
        impact = (after - before) / before * 100 if before else 0
        if self.side == "buy":
            blk = _whole(d.get("blockOut", 0), self.dec.get("BLOCK", 8))
            self.quote_lbl.setText("Receive %.4f BLOCK · fee $%.2f · impact %.2f%%" % (blk, float(d.get("feeUsd", 0)) / 1e6, impact))
            self.go.setEnabled(True)
            self.go.setText("Buy BLOCK")
        else:
            sym = self._cur_sym()
            out = _whole(d.get("assetOut", 0), self._cur_dec())
            if not d.get("liquidity"):
                self.quote_lbl.setText("Would receive %.6f %s, but that pair has no liquidity yet." % (out, sym))
                self.go.setEnabled(False)
                self.go.setText("No %s liquidity" % sym)
            else:
                self.quote_lbl.setText("Receive %.6f %s · fee $%.2f · impact %.2f%%" % (out, sym, float(d.get("feeUsd", 0)) / 1e6, impact))
                self.go.setEnabled(True)
                self.go.setText("Sell BLOCK")

    def _render_trade(self, status, d):
        self.go.setEnabled(True)
        self.go.setText("Buy BLOCK" if self.side == "buy" else "Sell BLOCK")
        if status != 200:
            self.status.setText(d.get("error", "Trade failed"))
            return
        if self.side == "buy":
            self.status.setText("Bought %.4f BLOCK (paper)" % _whole(d.get("blockOut", 0), self.dec.get("BLOCK", 8)))
        else:
            self.status.setText("Sold BLOCK for %.6f %s (paper)" % (_whole(d.get("assetOut", 0), self._cur_dec()), self._cur_sym()))
        self.amt.clear()
        self.refresh()

    def _render_intent(self, status, it):
        self.go.setEnabled(True)
        self.go.setText("Buy BLOCK" if self.side == "buy" else "Sell BLOCK")
        if status != 200 or it.get("error"):
            self.status.setText(it.get("error", "Could not create order"))
            return
        self.intent_id = it.get("id")
        dep_dec = self.dec.get(it.get("depositAsset"), 8)
        out_dec = self.dec.get(it.get("payoutAsset"), 8)
        amt = _whole(it.get("amountInBase", 0), dep_dec)
        out = _whole((it.get("quote") or {}).get("outBase", 0), out_dec)
        self.status.setText(
            "Send exactly %g %s to:\n%s\nYou receive ≈ %.6f %s\nWaiting for your deposit…"
            % (amt, it.get("depositAsset"), it.get("depositAddress"), out, it.get("payoutAsset"))
        )
        self._poll.start(5000)

    def _poll_tick(self):
        if self.intent_id:
            self.net.call("poll", "GET", "/intent/" + self.intent_id)

    def _render_poll(self, it):
        st = it.get("status")
        out_dec = self.dec.get(it.get("payoutAsset"), 8)
        if st == "funded":
            self.status.setText("Deposit detected — executing…")
        elif st in ("executed", "paid"):
            self.status.setText("Paying out…")
        elif st == "settled":
            got = _whole(it.get("executedOutBase") or (it.get("quote") or {}).get("outBase", 0), out_dec)
            self.status.setText("✓ Done — received %.6f %s" % (got, it.get("payoutAsset")))
            self._poll.stop()
            self.intent_id = None
            self.amt.clear()
            self.refresh()
        elif st == "refund":
            self.status.setText("Refunded — %s. Your deposit is being returned." % it.get("error", "price moved / no liquidity"))
            self._poll.stop()
            self.intent_id = None
        elif st == "expired":
            self.status.setText("Order expired — no deposit received.")
            self._poll.stop()
            self.intent_id = None


def build_trade_tab(ctrl):
    """Return ``(widget, title)`` for build_tabs."""
    return (TradeTab(ctrl), "Trade")
