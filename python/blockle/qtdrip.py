"""blockle.qtdrip — the Blockle Drip panel for the desktop (Qt) wallet.

Parity with the Flutter `drip_screen.dart`: a daily free-BLOCK faucet funded by
a 50,000-BLOCK giveaway wallet that releases a halving daily claim
(1 → 0.5 → 0.25 … per tranche). State is public; claiming needs a blockle.org
sign-in (done on the Agent tab — the session token lives on the controller as
`_acct_token`) and sends REAL on-chain BLOCK to the wallet's own BLOCK address.

Authoritative logic is server-side (`services/accounts/src/drip.js`,
`/account/api/drip/{state,claim}`); this panel only reads it and posts a claim.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Callable, Optional

from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QMessageBox, QPushButton, QVBoxLayout, QWidget,
)

# Same origin the Agent / MoonPay proxies use; overridable for a staging host.
API_BASE = os.environ.get("BLOCKLE_ACCOUNT_ORIGIN", "https://blockle.org").rstrip("/")


def _http(path: str, method: str = "GET", body: Optional[dict] = None,
          bearer: Optional[str] = None, timeout: int = 20) -> dict:
    """Call an /account/api/drip endpoint. Raises on transport error; returns the
    parsed JSON (a dict) otherwise, even for 4xx (so the caller can read .error)."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"accept": "application/json"}
    if data is not None:
        headers["content-type"] = "application/json"
    if bearer:
        headers["authorization"] = "Bearer " + bearer
    req = urllib.request.Request(API_BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry a JSON body
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
        except Exception as e:  # pragma: no cover - network/thread
            self.failed.emit(str(e))


def _fmt_block(n: Any) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "—"
    if v == 0:
        return "0"
    s = f"{v:.8f}".rstrip("0").rstrip(".")
    return s


class DripPanel(QWidget):
    """Daily BLOCK claim. Needs a blockle.org sign-in (Agent tab) to claim."""

    def __init__(self, ctrl: Any) -> None:
        super().__init__()
        self.ctrl = ctrl
        self._workers: list[_Worker] = []
        self._state: dict = {}
        self._next_claim_at = 0  # ms epoch; 0 = claimable now

        root = QVBoxLayout(self)
        root.setContentsMargins(24, 24, 24, 24)
        root.setSpacing(14)

        title = QLabel("Blockle Drip")
        title.setStyleSheet("font-size: 22px; font-weight: 700;")
        root.addWidget(title)
        sub = QLabel("Claim free BLOCK once every 24 hours. The daily reward halves "
                     "as the 50,000-BLOCK giveaway is drawn down.")
        sub.setWordWrap(True)
        sub.setStyleSheet("color: palette(mid);")
        root.addWidget(sub)

        card = QFrame()
        card.setFrameShape(QFrame.StyledPanel)
        cl = QVBoxLayout(card)
        cl.setContentsMargins(18, 18, 18, 18)
        cl.setSpacing(10)

        self.reward_lbl = QLabel("—")
        self.reward_lbl.setAlignment(Qt.AlignCenter)
        self.reward_lbl.setStyleSheet("font-size: 30px; font-weight: 800;")
        cl.addWidget(self.reward_lbl)
        r = QLabel("today's reward")
        r.setAlignment(Qt.AlignCenter)
        r.setStyleSheet("color: palette(mid);")
        cl.addWidget(r)

        self.progress_lbl = QLabel("—")
        self.progress_lbl.setAlignment(Qt.AlignCenter)
        cl.addWidget(self.progress_lbl)

        self.claim_btn = QPushButton("Claim today's BLOCK")
        self.claim_btn.setMinimumHeight(40)
        self.claim_btn.clicked.connect(self._claim)
        cl.addWidget(self.claim_btn)

        self.status_lbl = QLabel("")
        self.status_lbl.setAlignment(Qt.AlignCenter)
        self.status_lbl.setWordWrap(True)
        self.status_lbl.setStyleSheet("color: palette(mid);")
        cl.addWidget(self.status_lbl)

        root.addWidget(card)

        foot = QHBoxLayout()
        self.your_lbl = QLabel("claimed by you: —")
        self.your_lbl.setStyleSheet("color: palette(mid);")
        foot.addWidget(self.your_lbl)
        foot.addStretch(1)
        self.refresh_btn = QPushButton("Refresh")
        self.refresh_btn.clicked.connect(self._refresh)
        foot.addWidget(self.refresh_btn)
        root.addLayout(foot)
        root.addStretch(1)

        # Periodic refresh (state every 60s) + a 1s countdown tick.
        self._poll = QTimer(self)
        self._poll.timeout.connect(self._refresh)
        self._poll.start(60_000)
        self._tick = QTimer(self)
        self._tick.timeout.connect(self._update_countdown)
        self._tick.start(1_000)
        self._refresh()

    # ---- helpers -------------------------------------------------------------
    def _token(self) -> Optional[str]:
        return getattr(self.ctrl, "_acct_token", None)

    def _block_address(self) -> Optional[str]:
        try:
            wal = self.ctrl.block_wallet.snapshot().get("wallet") or {}
            return wal.get("address")
        except Exception:
            return None

    def _run(self, fn: Callable[[], Any], ok: Callable[[Any], None]) -> None:
        w = _Worker(fn)
        w.done.connect(lambda res: (ok(res), self._workers.remove(w) if w in self._workers else None))
        w.failed.connect(lambda e: (self.status_lbl.setText(e),
                                    self._workers.remove(w) if w in self._workers else None))
        self._workers.append(w)
        w.start()

    # ---- state ---------------------------------------------------------------
    def _refresh(self) -> None:
        token = self._token()
        self._run(lambda: _http("/account/api/drip/state", bearer=token), self._on_state)

    def _on_state(self, s: Any) -> None:
        if not isinstance(s, dict):
            return
        self._state = s
        self.reward_lbl.setText(_fmt_block(s.get("reward")) + " BLOCK")
        claimed = _fmt_block(s.get("totalClaimed"))
        supply = _fmt_block(s.get("supply"))
        self.progress_lbl.setText(f"{claimed} / {supply} BLOCK given out  ·  "
                                  f"{_fmt_block(s.get('remaining'))} left")
        self.your_lbl.setText("claimed by you: " + _fmt_block(s.get("yourTotal", 0)) + " BLOCK")
        self._next_claim_at = int(s.get("nextClaimAt") or 0)
        if not s.get("active"):
            self.status_lbl.setText("The drip isn't live yet — check back soon.")
            self.claim_btn.setEnabled(False)
            return
        self._update_countdown()

    def _update_countdown(self) -> None:
        if not self._state.get("active"):
            return
        if not self._token():
            self.claim_btn.setEnabled(False)
            self.status_lbl.setText("Sign in to your blockle.org account (Agent tab) to claim.")
            return
        import time
        now_ms = int(time.time() * 1000)
        if self._next_claim_at and self._next_claim_at > now_ms:
            secs = (self._next_claim_at - now_ms) // 1000
            h, m, sec = secs // 3600, (secs % 3600) // 60, secs % 60
            self.claim_btn.setEnabled(False)
            self.claim_btn.setText(f"Next claim in {h:02d}:{m:02d}:{sec:02d}")
            self.status_lbl.setText("")
        else:
            self.claim_btn.setEnabled(True)
            self.claim_btn.setText("Claim today's BLOCK")
            self.status_lbl.setText("")

    # ---- claim ---------------------------------------------------------------
    def _claim(self) -> None:
        token = self._token()
        if not token:
            QMessageBox.information(
                self, "Blockle Drip",
                "Sign in to your blockle.org account on the Agent tab first — the "
                "claim is sent to your BLOCK address and metered per account.")
            return
        addr = self._block_address()
        if not addr:
            QMessageBox.information(
                self, "Blockle Drip",
                "Unlock your wallet so the drip has a BLOCK address to pay out to.")
            return
        self.claim_btn.setEnabled(False)
        self.status_lbl.setText("Claiming…")
        self._run(
            lambda: _http("/account/api/drip/claim", method="POST",
                          body={"address": addr}, bearer=token),
            self._on_claim)

    def _on_claim(self, res: Any) -> None:
        if isinstance(res, dict) and res.get("error"):
            self.status_lbl.setText(res["error"])
            self._update_countdown()
            return
        reward = _fmt_block(res.get("reward")) if isinstance(res, dict) else "?"
        txid = (res or {}).get("txid") if isinstance(res, dict) else None
        msg = f"Claimed {reward} BLOCK to your wallet."
        if txid:
            msg += f"\n\nTx: {txid}"
        QMessageBox.information(self, "Blockle Drip", msg)
        self._refresh()


def build_drip_tab(ctrl: Any):
    """Return ``(DripPanel, "Drip")`` for the wallet's tab bar."""
    return DripPanel(ctrl), "Drip"
