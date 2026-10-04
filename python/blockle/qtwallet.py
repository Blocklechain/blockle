"""Blockle Qt — desktop wallet for the BLOCK chain.

A Qt 6 (PySide6) GUI over :mod:`blockle.chainwallet`. Decentralized by
construction: the wallet embeds a full ``blockle-chain`` node that listens
for peers, connects out, syncs headers-to-tip and gossips transactions; all
keys and signing stay in the Rust binary on your machine. Transparent and
shielded (STARK hidden-amount) funds are both first-class.

Run with ``blockle-qt`` (``pip install blockle[qt]``).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PySide6.QtCore import Qt, QThread, QTimer, Signal, QSettings
    from PySide6.QtGui import QFont, QGuiApplication
    from PySide6.QtWidgets import (
        QApplication, QCheckBox, QFormLayout, QFrame, QGridLayout, QGroupBox,
        QHBoxLayout, QHeaderView, QInputDialog, QLabel, QLineEdit, QMainWindow,
        QMessageBox, QPlainTextEdit, QPushButton, QSpinBox, QTabWidget,
        QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
    )
except ImportError:  # pragma: no cover
    print("blockle-qt needs PySide6 — install with: pip install 'blockle[qt]'", file=sys.stderr)
    sys.exit(1)

from .chainwallet import ChainWallet, NodeProcess, WalletError, format_block

ACCENT = "#3987e5"
STYLE = """
* { font-family: -apple-system, 'Segoe UI', sans-serif; }
QMainWindow, QWidget { background: #0a0b0e; color: #f2f4f8; }
QTabWidget::pane { border: 1px solid #23262e; border-radius: 8px; top: -1px; }
QTabBar::tab { background: transparent; color: #7d8495; padding: 8px 18px;
  border: none; font-weight: 600; font-size: 13px; }
QTabBar::tab:selected { color: #f2f4f8; border-bottom: 2px solid #3987e5; }
QGroupBox { border: 1px solid #23262e; border-radius: 10px; margin-top: 12px;
  padding-top: 10px; font-weight: 600; color: #b7bcc8; }
QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 4px; }
QLabel#big { font-size: 30px; font-weight: 700; color: #f2f4f8; }
QLabel#sub { color: #7d8495; font-size: 11px; font-weight: 600; }
QLabel#mono, QLineEdit#mono { font-family: Menlo, 'Cascadia Code', monospace; }
QLineEdit, QSpinBox, QPlainTextEdit {
  background: #13151a; border: 1px solid #2e323c; border-radius: 7px;
  padding: 7px 10px; color: #f2f4f8; selection-background-color: #3987e5; }
QLineEdit:focus, QSpinBox:focus { border-color: #3987e5; }
QPushButton { background: #181b21; border: 1px solid #2e323c; border-radius: 8px;
  padding: 8px 16px; font-weight: 600; color: #f2f4f8; }
QPushButton:hover { border-color: #3987e5; }
QPushButton#primary { background: #2a6fc4; border-color: transparent; color: white; }
QPushButton#primary:hover { background: #3f8fee; }
QPushButton:disabled { color: #7d8495; background: #101217; }
QTableWidget { background: #13151a; border: 1px solid #23262e; border-radius: 8px;
  gridline-color: #23262e; }
QTableWidget::item { padding: 5px; }
QHeaderView::section { background: #0e1014; color: #7d8495; border: none;
  border-bottom: 1px solid #23262e; padding: 7px; font-weight: 600;
  font-size: 11px; text-transform: uppercase; }
QPlainTextEdit { font-family: Menlo, monospace; font-size: 11px; }
QCheckBox { color: #b7bcc8; }
"""


class SnapshotWorker(QThread):
    """Polls ``ui-snapshot`` off the UI thread."""

    ready = Signal(dict)
    failed = Signal(str)

    def __init__(self, wallet: ChainWallet):
        super().__init__()
        self.wallet = wallet

    def run(self):  # noqa: D102
        try:
            self.ready.emit(self.wallet.snapshot())
        except Exception as e:  # pragma: no cover - surfaced in UI
            self.failed.emit(str(e))


def _copy_row(label: str, value: str) -> QWidget:
    w = QWidget()
    lay = QHBoxLayout(w)
    lay.setContentsMargins(0, 0, 0, 0)
    field = QLineEdit(value)
    field.setObjectName("mono")
    field.setReadOnly(True)
    btn = QPushButton("Copy")
    btn.setFixedWidth(70)

    def do_copy():
        QGuiApplication.clipboard().setText(field.text())
        btn.setText("Copied ✓")
        QTimer.singleShot(1200, lambda: btn.setText("Copy"))

    btn.clicked.connect(do_copy)
    lay.addWidget(QLabel(label))
    lay.addWidget(field, 1)
    lay.addWidget(btn)
    return w


class WalletWindow(QMainWindow):
    def __init__(self, wallet: ChainWallet, node: NodeProcess):
        super().__init__()
        self.wallet = wallet
        self.node = node
        self.snap: dict = {}
        self.worker: SnapshotWorker | None = None

        self.setWindowTitle(f"Blockle Wallet — {wallet.network}")
        self.resize(980, 680)
        self.setStyleSheet(STYLE)

        tabs = QTabWidget()
        tabs.addTab(self._overview_tab(), "Overview")
        tabs.addTab(self._send_tab(), "Send")
        tabs.addTab(self._receive_tab(), "Receive")
        tabs.addTab(self._shielded_tab(), "Shielded")
        tabs.addTab(self._node_tab(), "Node")
        self.setCentralWidget(tabs)

        self.status_lbl = QLabel("starting…")
        self.statusBar().addWidget(self.status_lbl)
        self.statusBar().setStyleSheet("color:#7d8495")

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(4000)
        self.refresh()

    # ---------- tabs ----------

    def _overview_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        tiles = QHBoxLayout()
        self.bal_lbl = QLabel("—")
        self.zbal_lbl = QLabel("—")
        self.height_lbl = QLabel("—")
        for title, lbl in (("TRANSPARENT BALANCE", self.bal_lbl),
                           ("SHIELDED BALANCE", self.zbal_lbl),
                           ("CHAIN HEIGHT", self.height_lbl)):
            box = QFrame()
            box.setStyleSheet("QFrame{background:#13151a;border:1px solid #23262e;border-radius:10px}")
            bl = QVBoxLayout(box)
            lbl.setObjectName("big")
            cap = QLabel(title)
            cap.setObjectName("sub")
            bl.addWidget(lbl)
            bl.addWidget(cap)
            tiles.addWidget(box)
        lay.addLayout(tiles)

        lay.addWidget(QLabel("Recent activity"))
        self.history = QTableWidget(0, 6)
        self.history.setHorizontalHeaderLabels(["Height", "Type", "Amount", "Counterparty", "Txid", "Status"])
        self.history.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.history.setEditTriggers(QTableWidget.NoEditTriggers)
        self.history.verticalHeader().hide()
        lay.addWidget(self.history, 1)
        return w

    def _send_tab(self) -> QWidget:
        w = QWidget()
        outer = QVBoxLayout(w)
        box = QGroupBox("Send BLOCK (transparent)")
        form = QFormLayout(box)
        self.send_to = QLineEdit()
        self.send_to.setPlaceholderText("block1…")
        self.send_to.setObjectName("mono")
        self.send_amount = QLineEdit()
        self.send_amount.setPlaceholderText("0.0")
        self.send_fee = QLineEdit("0.0001")
        form.addRow("Recipient", self.send_to)
        form.addRow("Amount", self.send_amount)
        form.addRow("Fee", self.send_fee)
        btn = QPushButton("Send")
        btn.setObjectName("primary")
        btn.clicked.connect(self._do_send)
        form.addRow(btn)
        outer.addWidget(box)
        outer.addStretch(1)
        return w

    def _receive_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        box = QGroupBox("Your addresses")
        v = QVBoxLayout(box)
        self.addr_holder = v
        v.addWidget(QLabel("Transparent address (post-quantum ML-DSA-44):"))
        self.addr_row = _copy_row("", "")
        v.addWidget(self.addr_row)
        v.addWidget(QLabel("Shielded address (ML-KEM-768 — give this out for private payments):"))
        self.zaddr_row = _copy_row("", "")
        v.addWidget(self.zaddr_row)
        lay.addWidget(box)
        lay.addStretch(1)
        return w

    def _shielded_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        self.notes = QTableWidget(0, 4)
        self.notes.setHorizontalHeaderLabels(["#", "Value", "Status", "Commitment"])
        self.notes.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.notes.setEditTriggers(QTableWidget.NoEditTriggers)
        self.notes.setSelectionBehavior(QTableWidget.SelectRows)
        self.notes.verticalHeader().hide()
        lay.addWidget(QLabel("Shielded notes (amounts hidden on chain; STARK-proven)"))
        lay.addWidget(self.notes, 1)

        row = QHBoxLayout()
        for text, fn in (("Shield funds…", self._do_shield),
                         ("Unshield note…", self._do_unshield),
                         ("Private send (zsend)…", self._do_zsend),
                         ("Import voucher…", self._do_import),
                         ("Scan for incoming", self._do_scan)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            row.addWidget(b)
        lay.addLayout(row)
        return w

    def _node_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        box = QGroupBox("Embedded node — your wallet IS a network participant")
        form = QFormLayout(box)
        self.node_listen = QLineEdit(self.node.listen)
        self.node_peers = QLineEdit(",".join(self.node.peers))
        self.node_peers.setPlaceholderText("host:port, host:port …")
        self.node_mine = QCheckBox("mine while running")
        self.node_btn = QPushButton("Start node")
        self.node_btn.setObjectName("primary")
        self.node_btn.clicked.connect(self._toggle_node)
        form.addRow("Listen", self.node_listen)
        form.addRow("Peers", self.node_peers)
        form.addRow("", self.node_mine)
        form.addRow(self.node_btn)
        lay.addWidget(box)

        if self.wallet.network == "regtest":
            mine_row = QHBoxLayout()
            self.mine_n = QSpinBox()
            self.mine_n.setRange(1, 100)
            mb = QPushButton("Mine blocks (regtest)")
            mb.clicked.connect(self._do_mine)
            mine_row.addWidget(self.mine_n)
            mine_row.addWidget(mb)
            mine_row.addStretch(1)
            lay.addLayout(mine_row)

        self.node_log = QPlainTextEdit()
        self.node_log.setReadOnly(True)
        lay.addWidget(self.node_log, 1)
        return w

    # ---------- refresh ----------

    def refresh(self):
        if self.worker is not None and self.worker.isRunning():
            return
        self.worker = SnapshotWorker(self.wallet)
        self.worker.ready.connect(self._apply_snapshot)
        self.worker.failed.connect(lambda e: self.status_lbl.setText(f"error: {e}"))
        self.worker.start()
        if self.node.running:
            self.node_log.setPlainText("\n".join(self.node.log_tail()))
            sb = self.node_log.verticalScrollBar()
            sb.setValue(sb.maximum())

    def _apply_snapshot(self, snap: dict):
        self.snap = snap
        wal, chain = snap.get("wallet"), snap.get("chain", {})
        if wal:
            self.bal_lbl.setText(wal["balance_fmt"])
            self.zbal_lbl.setText(wal["zbalance_fmt"])
            self.addr_row.findChild(QLineEdit).setText(wal["address"])
            self.zaddr_row.findChild(QLineEdit).setText(wal["zaddress"])
            self._fill_notes(wal.get("notes", []))
        self.height_lbl.setText(str(chain.get("height", "—")))
        self._fill_history(snap.get("history", []))
        node_state = f"node {'running' if self.node.running else 'stopped'}"
        self.status_lbl.setText(
            f"{chain.get('name', '?')} · height {chain.get('height')} · "
            f"{chain.get('mempool', 0)} tx in mempool · {node_state}"
        )
        self.node_btn.setText("Stop node" if self.node.running else "Start node")

    def _fill_history(self, items: list[dict]):
        self.history.setRowCount(len(items))
        for r, h in enumerate(items):
            vals = [
                "pending" if h["pending"] else str(h["height"]),
                h["kind"],
                h["net_fmt"] + " BLOCK",
                (h.get("counterparty") or "")[:28],
                h["txid"][:20] + "…",
                "unconfirmed" if h["pending"] else "confirmed",
            ]
            for c, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if c == 2:
                    item.setForeground(Qt.red if h["net"] < 0 else Qt.green)
                self.history.setItem(r, c, item)

    def _fill_notes(self, notes: list[dict]):
        self.notes.setRowCount(len(notes))
        for r, n in enumerate(notes):
            for c, v in enumerate([str(n["index"]), n["value_fmt"] + " BLOCK",
                                   n["status"], n["commitment"][:24] + "…"]):
                self.notes.setItem(r, c, QTableWidgetItem(v))

    # ---------- actions ----------

    def _guarded(self, fn, success_msg: str):
        try:
            result = fn()
        except WalletError as e:
            QMessageBox.critical(self, "Blockle", str(e))
            return None
        if isinstance(result, dict) and result.get("txid"):
            QMessageBox.information(self, "Blockle", f"{success_msg}\n\ntxid: {result['txid']}")
        else:
            QMessageBox.information(self, "Blockle", success_msg)
        self.refresh()
        return result

    def _do_send(self):
        to, amount = self.send_to.text().strip(), self.send_amount.text().strip()
        if not to or not amount:
            QMessageBox.warning(self, "Blockle", "Recipient and amount are required.")
            return
        if QMessageBox.question(
            self, "Confirm send",
            f"Send {amount} BLOCK to\n{to}\n(fee {self.send_fee.text()})?",
        ) != QMessageBox.Yes:
            return
        self.wallet.node = self.node.p2p_address if self.node.running else None
        if self._guarded(lambda: self.wallet.send(to, amount, self.send_fee.text().strip()),
                         "Transaction submitted."):
            self.send_to.clear()
            self.send_amount.clear()

    def _selected_note(self) -> int | None:
        rows = self.notes.selectionModel().selectedRows()
        if not rows:
            QMessageBox.warning(self, "Blockle", "Select a note first.")
            return None
        return int(self.notes.item(rows[0].row(), 0).text())

    def _do_shield(self):
        amount, ok = QInputDialog.getText(self, "Shield", "Amount to move into the shielded pool:")
        if ok and amount.strip():
            self.wallet.node = self.node.p2p_address if self.node.running else None
            self._guarded(lambda: self.wallet.shield(amount.strip()), "Funds shielded.")

    def _do_unshield(self):
        note = self._selected_note()
        if note is None:
            return
        self.wallet.node = self.node.p2p_address if self.node.running else None
        self._guarded(lambda: self.wallet.unshield(note), "Note unshielded to your address.")

    def _do_zsend(self):
        note = self._selected_note()
        if note is None:
            return
        to, ok = QInputDialog.getText(
            self, "Private send",
            "Recipient shielded address (zblockpk…),\nor leave empty for an out-of-band voucher:")
        if not ok:
            return
        amount, ok = QInputDialog.getText(self, "Private send",
                                          "Amount (empty = whole note minus fee):")
        if not ok:
            return
        self.wallet.node = self.node.p2p_address if self.node.running else None
        result = self._guarded(
            lambda: self.wallet.zsend(note, amount.strip() or None, to.strip() or None),
            "Private transfer submitted — amounts are hidden on chain.")
        if result and result.get("voucher"):
            dlg = QMessageBox(self)
            dlg.setWindowTitle("Voucher — treat as cash")
            dlg.setText("Hand this voucher to the recipient out of band; "
                        "they import it under Shielded → Import voucher.")
            dlg.setDetailedText(result["voucher"])
            dlg.exec()

    def _do_import(self):
        voucher, ok = QInputDialog.getMultiLineText(self, "Import voucher", "Paste voucher (blocklenote1…):")
        if ok and voucher.strip():
            self._guarded(lambda: self.wallet.note_import(voucher) or {}, "Voucher imported.")

    def _do_scan(self):
        try:
            report = self.wallet.scan()
        except WalletError as e:
            QMessageBox.critical(self, "Blockle", str(e))
            return
        QMessageBox.information(self, "Scan", report.strip() or "no new notes found")
        self.refresh()

    def _do_mine(self):
        self._guarded(lambda: {"out": self.wallet.mine(self.mine_n.value())} and {},
                      f"Mined {self.mine_n.value()} block(s).")

    def _toggle_node(self):
        if self.node.running:
            self.node.stop()
            self.node_btn.setText("Start node")
            return
        self.node.listen = self.node_listen.text().strip()
        self.node.peers = [p for p in self.node_peers.text().split(",") if p.strip()]
        self.node.mine = self.node_mine.isChecked()
        settings = QSettings("blockle", "wallet")
        settings.setValue("listen", self.node.listen)
        settings.setValue("peers", ",".join(self.node.peers))
        try:
            self.node.start()
        except Exception as e:
            QMessageBox.critical(self, "Blockle", f"node failed to start: {e}")
            return
        self.node_btn.setText("Stop node")

    def closeEvent(self, event):  # noqa: N802
        self.node.stop()
        event.accept()


def main() -> int:
    ap = argparse.ArgumentParser(prog="blockle-qt", description="Blockle Qt wallet for the BLOCK chain")
    ap.add_argument("--datadir", default=str(Path.home() / ".blockle"))
    ap.add_argument("--network", default="mainnet", choices=["mainnet", "regtest"])
    ap.add_argument("--connect", action="append", default=[], help="peer to connect the embedded node to (repeatable)")
    ap.add_argument("--listen", default=None, help="P2P listen address for the embedded node")
    args = ap.parse_args()

    app = QApplication(sys.argv)
    app.setApplicationName("Blockle Wallet")
    app.setFont(QFont(app.font().family(), 13))

    settings = QSettings("blockle", "wallet")
    datadir = Path(args.datadir)
    datadir.mkdir(parents=True, exist_ok=True)
    wallet = ChainWallet(datadir=datadir, network=args.network)
    if not wallet.exists():
        wallet.create()
        QMessageBox.information(
            None, "Blockle",
            "A new wallet was generated (post-quantum ML-DSA-44 keys).\n\n"
            f"Keys live in {datadir}/wallet.json — back that file up; "
            "it IS your money.")
    if args.network == "regtest" and not wallet.has_chain():
        wallet.init_chain()

    node = NodeProcess(
        datadir=datadir, network=args.network,
        listen=args.listen or settings.value("listen", "0.0.0.0:18444"),
        peers=args.connect or [p for p in str(settings.value("peers", "")).split(",") if p],
    )
    win = WalletWindow(wallet, node)
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
