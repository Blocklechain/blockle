"""AI Chat tab for the Qt desktop wallet — ChatGPT/Claude-style, paid per message in BLOCK
via a generatable API key against the Blockle Intelligence gateway (same backend as the web +
extension wallets). Additive + self-contained. Network runs off the GUI thread; Qt queued
signals deliver results back to the main thread."""
from __future__ import annotations

import json
import threading
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional, Tuple

from PySide6.QtCore import QObject, Qt, Signal, Slot
from PySide6.QtWidgets import (QHBoxLayout, QLabel, QLineEdit, QPushButton,
                               QTextEdit, QVBoxLayout, QWidget)

API = "https://blockle.org/api/inference"


def _http(path: str, method: str = "GET", body: Optional[dict] = None,
          key: Optional[str] = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    if key:
        req.add_header("authorization", "Bearer " + key)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return {"ok": True, "status": r.status, "j": json.loads(r.read().decode() or "{}")}
    except urllib.error.HTTPError as e:  # 402 etc. carry a JSON body
        try:
            return {"ok": False, "status": e.code, "j": json.loads(e.read().decode() or "{}")}
        except Exception:
            return {"ok": False, "status": e.code, "j": {}}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "status": 0, "j": {"error": str(e)}}


class _Net(QObject):
    done = Signal(object, object)  # (result, error)


def _run_async(fn: Callable[[], Any], cb: Callable[[Any, Any], None], keep: list) -> None:
    net = _Net()
    net.done.connect(cb, Qt.QueuedConnection)
    keep.append(net)  # keep a ref so it isn't GC'd before the signal fires

    def run() -> None:
        try:
            net.done.emit(fn(), None)
        except Exception as e:  # noqa: BLE001
            net.done.emit(None, str(e))

    threading.Thread(target=run, daemon=True).start()


class ChatTab(QWidget):
    def __init__(self, block_wallet: Any, datadir: Any) -> None:
        super().__init__()
        self._wallet = block_wallet
        self._keyfile = Path(datadir) / "inference-key.txt"
        self._key = self._load_key()
        self._deposit = ""
        self._nets: list = []

        root = QVBoxLayout(self)
        self._bal = QLabel("Credit: — BLOCK")
        root.addWidget(self._bal)

        self._thread = QTextEdit(); self._thread.setReadOnly(True)
        self._thread.setPlaceholderText("Ask anything. Paid per message in BLOCK.")
        root.addWidget(self._thread, 1)

        row = QHBoxLayout()
        self._in = QLineEdit(); self._in.setPlaceholderText("Message Blockle Intelligence…")
        self._in.returnPressed.connect(self._send)
        send = QPushButton("Send"); send.clicked.connect(self._send)
        row.addWidget(self._in, 1); row.addWidget(send)
        root.addLayout(row)

        root.addWidget(QLabel("Top up — send BLOCK to credit your key:"))
        trow = QHBoxLayout()
        self._amt = QLineEdit(); self._amt.setPlaceholderText("BLOCK amount (e.g. 5)")
        topbtn = QPushButton("Send & credit"); topbtn.clicked.connect(self._topup)
        trow.addWidget(self._amt, 1); trow.addWidget(topbtn)
        root.addLayout(trow)

        self._msg = QLabel(""); self._msg.setWordWrap(True); root.addWidget(self._msg)

        krow = QHBoxLayout()
        self._keyview = QLineEdit(self._key or ""); self._keyview.setReadOnly(True)
        krow.addWidget(QLabel("API key:")); krow.addWidget(self._keyview, 1)
        root.addLayout(krow)

        self._ensure_key(self._refresh_balance)

    # ---- key storage ----
    def _load_key(self) -> str:
        try:
            return self._keyfile.read_text().strip()
        except Exception:
            return ""

    def _save_key(self, k: str) -> None:
        self._key = k
        try:
            self._keyfile.write_text(k)
        except Exception:
            pass
        self._keyview.setText(k)

    def _ensure_key(self, then: Callable[[], None]) -> None:
        if self._key:
            then(); return

        def make() -> dict:
            return _http("/keys/create", "POST", {"address": ""})

        def done(res: Any, err: Any) -> None:
            if res and res.get("ok") and res["j"].get("key"):
                self._save_key(res["j"]["key"])
            then()

        _run_async(make, done, self._nets)

    # ---- actions ----
    def _refresh_balance(self) -> None:
        if not self._key:
            return
        key = self._key

        def get() -> dict:
            return _http("/credit", "GET", None, key)

        def done(res: Any, err: Any) -> None:
            j = (res or {}).get("j", {}) if res else {}
            if j.get("balanceBlock") is not None:
                self._bal.setText(f"Credit: {j['balanceBlock']} BLOCK")
            if j.get("depositAddr"):
                self._deposit = j["depositAddr"]

        _run_async(get, done, self._nets)

    def _append(self, who: str, text: str) -> None:
        self._thread.append(f"<b>{'You' if who == 'user' else 'Blockle'}:</b> {text}")

    def _send(self) -> None:
        text = self._in.text().strip()
        if not text:
            return
        self._in.clear(); self._append("user", text)
        key = self._key

        def call() -> dict:
            return _http("/chat", "POST", {"prompt": text}, key)

        def done(res: Any, err: Any) -> None:
            j = (res or {}).get("j", {}) if res else {}
            if res and res.get("status") == 402:
                self._append("ai", "Out of BLOCK credit — top up below.")
                self._refresh_balance(); return
            if res and res.get("ok"):
                self._append("ai", j.get("answer", "(no answer)"))
                if j.get("balanceBlock") is not None:
                    self._bal.setText(f"Credit: {j['balanceBlock']} BLOCK")
            else:
                self._append("ai", "Error: " + (j.get("error") or err or "unavailable"))

        self._ensure_key(lambda: _run_async(call, done, self._nets))

    def _topup(self) -> None:
        amt = self._amt.text().strip()
        try:
            if float(amt) <= 0:
                raise ValueError
        except Exception:
            self._msg.setText("Enter a BLOCK amount."); return
        if not self._deposit:
            self._msg.setText("Deposit address not loaded yet — try again in a moment."); return
        self._msg.setText(f"Sending {amt} BLOCK…")
        dep, key = self._deposit, self._key

        def do() -> dict:
            res = self._wallet.send(dep, amt)  # native BLOCK send via the wallet CLI
            txid = res.get("txid") or res.get("hash") or ""
            if not txid:
                raise RuntimeError("no txid from send")
            return _http("/deposit", "POST", {"txid": txid}, key)

        def done(res: Any, err: Any) -> None:
            j = (res or {}).get("j", {}) if res else {}
            if res and res.get("ok"):
                self._msg.setText(f"Credited {j.get('creditedBlock', amt)} BLOCK.")
                self._refresh_balance()
            else:
                self._msg.setText("Sent — credit will appear after a confirmation. " + (j.get("error") or err or ""))

        self._ensure_key(lambda: _run_async(do, done, self._nets))


def build_chat_tab(block_wallet: Any, datadir: Any) -> Tuple[QWidget, str]:
    return ChatTab(block_wallet, datadir), "AI Chat"
