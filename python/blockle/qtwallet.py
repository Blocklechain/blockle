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
import json
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PySide6.QtCore import Qt, QThread, QTimer, Signal, QSettings
    from PySide6.QtGui import QFont, QGuiApplication, QIcon
    from PySide6.QtWidgets import (
        QApplication, QCheckBox, QCompleter, QFileDialog, QFormLayout, QFrame, QGridLayout,
        QGroupBox, QHBoxLayout, QHeaderView, QInputDialog, QLabel, QLineEdit,
        QMainWindow, QMessageBox, QPlainTextEdit, QPushButton, QSpinBox,
        QTabWidget, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
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

#: Public BLOCK-20 token API (metadata + per-holder balance).
TOKEN_API = "https://blockle.org/api/token"
#: Public site API base (DEX pools, buy-curve price history).
API_BASE = "https://blockle.org/api"
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _http_json(url: str, timeout: float = 10.0):
    """GET `url` and parse JSON (raises on network/parse error)."""
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "blockle-qt"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _bech32_data(addr: str) -> list[int] | None:
    """Return the 5-bit data symbols of a bech32 string (checksum dropped),
    or ``None`` if it does not look like bech32. The checksum is not verified
    (the chain may use bech32 or bech32m); we only need the payload."""
    if not addr or any(ord(c) < 33 or ord(c) > 126 for c in addr):
        return None
    if addr.lower() != addr and addr.upper() != addr:
        return None  # mixed case
    addr = addr.lower()
    pos = addr.rfind("1")
    if pos < 1 or pos + 7 > len(addr):
        return None
    data: list[int] = []
    for c in addr[pos + 1:]:
        d = _BECH32_CHARSET.find(c)
        if d == -1:
            return None
        data.append(d)
    return data[:-6]  # drop the 6-symbol checksum


def _convertbits(data: list[int], frombits: int, tobits: int) -> list[int] | None:
    """Convert between bit groups (BIP173), requiring exact, zero padding."""
    acc = bits = 0
    maxv = (1 << tobits) - 1
    ret: list[int] = []
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None  # excess or non-zero padding
    return ret


def _address_to_holder_hex(addr: str | None) -> str | None:
    """Decode a ``block1…`` address to the 32-byte holder id in hex, or
    ``None`` if it cannot be decoded to a 32-byte payload."""
    if not addr:
        return None
    data = _bech32_data(addr)
    if not data:
        return None
    decoded = _convertbits(data, 5, 8)
    if not decoded:
        return None
    raw = bytes(decoded)
    if len(raw) == 32:
        return raw.hex()
    if len(raw) == 33:  # leading version/witness byte
        return raw[1:].hex()
    return None


def _format_token_amount(balance, decimals) -> str:
    """Format a base-unit token balance by its decimals."""
    if balance is None:
        return "—"
    try:
        value = int(balance)
    except (TypeError, ValueError):
        return str(balance)
    try:
        d = int(decimals) if decimals is not None else 0
    except (TypeError, ValueError):
        d = 0
    if d <= 0:
        return str(value)
    sign = "-" if value < 0 else ""
    whole, frac = divmod(abs(value), 10 ** d)
    frac_str = str(frac).zfill(d).rstrip("0")
    return f"{sign}{whole}.{frac_str}" if frac_str else f"{sign}{whole}"


def _fetch_token(contract_id: str, holder_hex: str | None = None, timeout: float = 15) -> dict:
    """GET token metadata (+ balance when ``holder_hex`` is given) from the
    public API. Handles both ``{"result": {...}}`` and a bare object."""
    url = f"{TOKEN_API}/{contract_id}"
    if holder_hex:
        url += "?" + urllib.parse.urlencode({"holder": holder_hex})
    req = urllib.request.Request(url, headers={"User-Agent": "blockle-qt"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict) and "result" in payload:
        payload = payload["result"]
    if not isinstance(payload, dict):
        raise ValueError("unexpected token API response")
    return payload


class TokenWorker(QThread):
    """Fetches BLOCK-20 token metadata/balances off the UI thread."""

    ready = Signal(list)  # list[tuple[contract_id, dict | None, str | None]]

    def __init__(self, contract_ids: list[str], holder_hex: str | None):
        super().__init__()
        self.contract_ids = contract_ids
        self.holder_hex = holder_hex

    def run(self):  # noqa: D102
        results = []
        for cid in self.contract_ids:
            try:
                results.append((cid, _fetch_token(cid, self.holder_hex), None))
            except Exception as e:  # pragma: no cover - surfaced in UI
                results.append((cid, None, str(e)))
        self.ready.emit(results)


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


#: Friendly built-ins (also fed to the input's autocomplete).
BUILTIN_COMMANDS = [
    "help", "clear", "balance", "address", "height", "info", "history",
    "peers", "price", "pools", "tokeninfo", "snapshot", "send", "sign",
    "verify", "mine", "scan", "backup",
]

CONSOLE_HELP = """Blockle console — type a command and press Enter (↑/↓ history, Tab to complete).

Wallet & chain:
  balance                   spendable / total / immature / shielded
  address                   your transparent + shielded addresses
  height                    current chain height
  info                      network / name / height / mempool / tip
  history [n]               recent transactions (default 10)
  snapshot                  full wallet + chain state (pretty JSON)
  send <to> <amount> [fee]  send BLOCK (fee defaults to 0.0001)
  sign <message...>         sign a message with your key
  verify <addr> <sig> <message...>   verify a signed message
  scan                      rescan for shielded notes
  backup <path>             write a wallet backup
  mine [n]                  mine n blocks (regtest / new chains)

Network & DEX:
  peers                     connected peers (if in snapshot)
  price                     latest BLOCK curve price
  pools                     native AMM liquidity pools
  tokeninfo <contract-id>   a BLOCK-20 token's metadata + your balance

Console:
  help [command]            this help, or a subcommand's flags
  clear                     clear the console

Anything else is passed straight to the blockle-chain CLI, so every node and
wallet subcommand works here too — e.g. `getblockcount`, `getblockchaininfo`,
`ui-snapshot`. Use `help <command>` for its flags."""


def run_console_command(wallet: "ChainWallet", line: str) -> tuple[str, bool]:
    """Execute one console line → (output, is_error). Friendly wrappers map to
    ChainWallet methods; everything else is a raw blockle-chain CLI call."""
    try:
        toks = shlex.split(line)
    except ValueError as e:
        return (f"parse error: {e}", True)
    if not toks:
        return ("", False)
    cmd, args = toks[0].lower(), toks[1:]
    try:
        if cmd == "clear":
            return ("\x00clear", False)
        if cmd == "help":
            if args:
                return (wallet._run(args[0], "--help").rstrip("\n"), False)
            try:
                cli = "\n\n— blockle-chain —\n" + wallet._run("--help").rstrip("\n")
            except Exception:
                cli = ""
            return (CONSOLE_HELP + cli, False)
        if cmd == "snapshot":
            return (json.dumps(wallet.snapshot(), indent=2), False)
        if cmd == "send":
            if len(args) < 2:
                return ("usage: send <to> <amount> [fee]", True)
            fee = args[2] if len(args) > 2 else "0.0001"
            return (json.dumps(wallet.send(args[0], args[1], fee), indent=2), False)
        if cmd == "sign":
            if not args:
                return ("usage: sign <message>", True)
            return (json.dumps(wallet.sign_message(" ".join(args)), indent=2), False)
        if cmd == "verify":
            if len(args) < 3:
                return ("usage: verify <address> <signature> <message>", True)
            ok = wallet.verify_message(args[0], args[1], " ".join(args[2:]))
            return ("valid ✓" if ok else "INVALID ✗", not ok)
        if cmd == "mine":
            n = int(args[0]) if args else 1
            return (wallet.mine(n).rstrip("\n"), False)
        if cmd == "scan":
            return (wallet.scan().rstrip("\n"), False)
        if cmd == "backup":
            if not args:
                return ("usage: backup <path>", True)
            return (json.dumps(wallet.backup(args[0]), indent=2), False)
        if cmd == "height":
            return (str(wallet.snapshot().get("chain", {}).get("height", "—")), False)
        if cmd in ("balance", "bal"):
            w = wallet.snapshot().get("wallet", {})
            return ("\n".join([
                f"spendable: {w.get('spendable_fmt', w.get('balance_fmt', '—'))} BLOCK",
                f"total:     {w.get('balance_fmt', '—')} BLOCK",
                f"immature:  {w.get('immature_fmt', '0')} BLOCK",
                f"shielded:  {w.get('zbalance_fmt', '—')}",
            ]), False)
        if cmd == "address":
            w = wallet.snapshot().get("wallet", {})
            return (f"transparent: {w.get('address', '—')}\nshielded:    {w.get('zaddress', '—')}", False)
        if cmd == "info":
            c = wallet.snapshot().get("chain", {})
            return (json.dumps({"network": wallet.network, "name": c.get("name"),
                                "height": c.get("height"), "mempool": c.get("mempool"),
                                "tip": c.get("tip")}, indent=2), False)
        if cmd == "history":
            n = int(args[0]) if args and args[0].isdigit() else 10
            hist = wallet.snapshot().get("history", [])[:n]
            return (json.dumps(hist, indent=2) if hist else "(no transactions yet)", False)
        if cmd == "peers":
            p = wallet.snapshot().get("chain", {}).get("peers")
            return (json.dumps(p, indent=2) if p is not None
                    else "(peer detail isn't in the snapshot — see the Node tab)", False)
        if cmd == "price":
            hist = _http_json(API_BASE + "/buy/history")
            if not hist:
                return ("no price yet — the reserve curve is unfunded", False)
            return (f"BLOCK ≈ ${hist[-1].get('price')} ({len(hist)} snapshots)", False)
        if cmd == "pools":
            pools = _http_json(API_BASE + "/dex/pools").get("pools", [])
            if not pools:
                return ("no liquidity pools yet", False)
            out = [f"{'SYMBOL':<8} {'PRICE(BLOCK)':>16} {'LIQ(BLOCK)':>12}  CONTRACT"]
            for p in pools:
                dec = p.get("decimals") or 0
                br = (p.get("blockReserve", 0) or 0) / 1e8
                tr = (p.get("tokenReserve", 0) or 0) / (10 ** dec)
                price = (br / tr) if tr else 0
                out.append(f"{(p.get('symbol') or '?'):<8} {price:>16.8f} {br * 2:>12.2f}  {(p.get('token') or '')[:16]}…")
            return ("\n".join(out), False)
        if cmd in ("tokeninfo", "token"):
            if not args:
                return ("usage: tokeninfo <contract-id>", True)
            holder = _address_to_holder_hex(wallet.snapshot().get("wallet", {}).get("address"))
            url = f"{TOKEN_API}/{args[0]}" + (f"?holder={holder}" if holder else "")
            j = _http_json(url)
            return (json.dumps(j.get("result", j), indent=2), False)
        # raw CLI passthrough — every node/wallet subcommand
        return (wallet._run(*toks).rstrip("\n"), False)
    except Exception as e:
        return (str(e), True)


class ConsoleWorker(QThread):
    """Runs one console command off the UI thread."""

    done = Signal(str, bool)

    def __init__(self, wallet: ChainWallet, line: str):
        super().__init__()
        self.wallet = wallet
        self.line = line

    def run(self):  # noqa: D102
        text, is_err = run_console_command(self.wallet, self.line)
        self.done.emit(text, is_err)


class _ConsoleInput(QLineEdit):
    """A command input with ↑/↓ history recall."""

    def __init__(self):
        super().__init__()
        self._hist: list[str] = []
        self._idx = 0

    def add_history(self, line: str) -> None:
        if not self._hist or self._hist[-1] != line:
            self._hist.append(line)
        self._idx = len(self._hist)

    def keyPressEvent(self, e):  # noqa: D102, N802
        comp = self.completer()
        if comp and comp.popup().isVisible():
            return super().keyPressEvent(e)  # let the completer handle ↑/↓/Enter
        if e.key() == Qt.Key_Up and self._hist:
            self._idx = max(0, self._idx - 1)
            self.setText(self._hist[self._idx])
            return
        if e.key() == Qt.Key_Down and self._hist:
            self._idx = min(len(self._hist), self._idx + 1)
            self.setText(self._hist[self._idx] if self._idx < len(self._hist) else "")
            return
        super().keyPressEvent(e)


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
        tabs.addTab(self._tokens_tab(), "Tokens")
        tabs.addTab(self._wallet_tab(), "Wallet")
        tabs.addTab(self._node_tab(), "Node")
        tabs.addTab(self._console_tab(), "Console")

        # Multi-chain / Exchange / AI-agent panels (ADDITIVE): reuse the BLOCK
        # engine as the signer + BLOCK rail. Guarded so a missing multichain dep
        # never breaks the core BLOCK wallet or the console.
        self._mc_tabs = []
        try:
            from .qtmultichain import build_tabs as _mc_build_tabs
            self._mc_tabs = _mc_build_tabs(wallet, wallet.datadir)
            for widget, title in self._mc_tabs:
                tabs.addTab(widget, title)
        except Exception as e:  # pragma: no cover - optional feature
            print(f"blockle-qt: multi-chain panels unavailable ({e})", file=sys.stderr)

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
        self.immature_lbl = QLabel("—")
        self.zbal_lbl = QLabel("—")
        self.height_lbl = QLabel("—")
        for title, lbl in (("SPENDABLE", self.bal_lbl),
                           ("IMMATURE (MINED)", self.immature_lbl),
                           ("SHIELDED", self.zbal_lbl),
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

    def _tokens_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        box = QGroupBox("Import BLOCK-20 token")
        row = QHBoxLayout(box)
        self.token_input = QLineEdit()
        self.token_input.setPlaceholderText("contract id (64 hex characters)")
        self.token_input.setObjectName("mono")
        self.token_input.returnPressed.connect(self._do_import_token)
        import_btn = QPushButton("Import")
        import_btn.setObjectName("primary")
        import_btn.clicked.connect(self._do_import_token)
        refresh_btn = QPushButton("Refresh")
        refresh_btn.clicked.connect(self._do_refresh_tokens)
        row.addWidget(self.token_input, 1)
        row.addWidget(import_btn)
        row.addWidget(refresh_btn)
        lay.addWidget(box)

        lay.addWidget(QLabel("Imported BLOCK-20 tokens (balances for this wallet)"))
        self.tokens_table = QTableWidget(0, 5)
        self.tokens_table.setHorizontalHeaderLabels(
            ["Symbol", "Name", "Decimals", "Balance", "Contract"])
        self.tokens_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.tokens_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.tokens_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.tokens_table.verticalHeader().hide()
        lay.addWidget(self.tokens_table, 1)

        self.token_worker: TokenWorker | None = None
        self.token_data: dict[str, dict] = {}
        self.token_ids: list[str] = self._tokens_load()
        self._fill_tokens_table()
        # Kick off an initial fetch once the event loop is running.
        QTimer.singleShot(0, self._do_refresh_tokens)
        return w

    # ---------- BLOCK-20 tokens ----------

    def _tokens_file(self) -> Path:
        return Path(self.wallet.datadir) / "block20_tokens.json"

    def _tokens_load(self) -> list[str]:
        try:
            data = json.loads(self._tokens_file().read_text())
        except (OSError, ValueError):
            return []
        if isinstance(data, list):
            return [str(c).strip().lower() for c in data if str(c).strip()]
        return []

    def _tokens_save(self):
        try:
            self._tokens_file().write_text(json.dumps(self.token_ids, indent=2))
        except OSError as e:
            QMessageBox.warning(self, "Blockle", f"Could not save token list: {e}")

    def _token_holder_hex(self) -> str | None:
        addr = (self.snap or {}).get("wallet", {}).get("address")
        return _address_to_holder_hex(addr)

    def _do_import_token(self):
        cid = self.token_input.text().strip().lower()
        if cid.startswith("0x"):
            cid = cid[2:]
        if len(cid) != 64 or any(c not in "0123456789abcdef" for c in cid):
            QMessageBox.warning(self, "Blockle", "Enter a 64-character hex contract id.")
            return
        if cid in self.token_ids:
            QMessageBox.information(self, "Blockle", "That token is already imported.")
            return
        try:
            meta = _fetch_token(cid, self._token_holder_hex())
        except Exception as e:
            QMessageBox.critical(self, "Blockle", f"Could not fetch token:\n{e}")
            return
        if not (meta.get("isToken") or meta.get("symbol") or meta.get("name")):
            QMessageBox.critical(
                self, "Blockle", "That contract id is not a BLOCK-20 token.")
            return
        self.token_ids.append(cid)
        self.token_data[cid] = meta
        self._tokens_save()
        self.token_input.clear()
        self._fill_tokens_table()

    def _do_refresh_tokens(self):
        if not self.token_ids:
            self._fill_tokens_table()
            return
        if self.token_worker is not None and self.token_worker.isRunning():
            return
        self.token_worker = TokenWorker(list(self.token_ids), self._token_holder_hex())
        self.token_worker.ready.connect(self._on_tokens_fetched)
        self.token_worker.start()

    def _on_tokens_fetched(self, results: list):
        for cid, meta, _err in results:
            if meta is not None:
                self.token_data[cid] = meta
        self._fill_tokens_table()

    def _fill_tokens_table(self):
        self.tokens_table.setRowCount(len(self.token_ids))
        for r, cid in enumerate(self.token_ids):
            meta = self.token_data.get(cid, {})
            decimals = meta.get("decimals")
            vals = [
                meta.get("symbol") or "—",
                meta.get("name") or "—",
                str(decimals) if decimals is not None else "—",
                _format_token_amount(meta.get("balance"), decimals),
                f"{cid[:10]}…{cid[-6:]}",
            ]
            for c, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if c == 4:
                    item.setToolTip(cid)
                self.tokens_table.setItem(r, c, item)

    def _wallet_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.enc_lbl = QLabel("…")
        self.enc_lbl.setObjectName("sub")
        lay.addWidget(self.enc_lbl)

        sec = QGroupBox("Security")
        srow = QHBoxLayout(sec)
        for text, fn in (("Encrypt wallet…", self._do_encrypt),
                         ("Unlock for this session…", self._do_unlock),
                         ("Change passphrase…", self._do_change_pass)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            srow.addWidget(b)
        lay.addWidget(sec)

        keys = QGroupBox("Backup & keys")
        krow = QHBoxLayout(keys)
        for text, fn in (("Backup wallet…", self._do_backup),
                         ("Export private keys…", self._do_export),
                         ("Import wallet…", self._do_import_wallet)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            krow.addWidget(b)
        lay.addWidget(keys)

        msg = QGroupBox("Messages")
        mrow = QHBoxLayout(msg)
        for text, fn in (("Sign message…", self._do_sign),
                         ("Verify message…", self._do_verify)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            mrow.addWidget(b)
        lay.addWidget(msg)
        lay.addStretch(1)
        return w

    # ---------- wallet-parity actions ----------

    def _ask_password(self, title: str, label: str) -> str | None:
        text, ok = QInputDialog.getText(self, title, label, QLineEdit.Password)
        return text if ok and text else None

    def _ensure_unlocked(self) -> bool:
        """If the wallet is encrypted and no session passphrase is set,
        prompt for one (verified on first use by the operation itself)."""
        if not self.snap.get("wallet", {}).get("encrypted"):
            return True
        if self.wallet.passphrase:
            return True
        p = self._ask_password("Unlock wallet", "Wallet passphrase:")
        if p is None:
            return False
        self.wallet.passphrase = p
        return True

    def _do_encrypt(self):
        if self.snap.get("wallet", {}).get("encrypted"):
            QMessageBox.information(self, "Blockle", "The wallet is already encrypted.")
            return
        p1 = self._ask_password("Encrypt wallet", "New passphrase:")
        if p1 is None:
            return
        p2 = self._ask_password("Encrypt wallet", "Repeat passphrase:")
        if p1 != p2:
            QMessageBox.critical(self, "Blockle", "Passphrases do not match.")
            return
        if QMessageBox.warning(
            self, "Encrypt wallet",
            "If you forget this passphrase, your BLOCK are LOST.\n\nEncrypt the wallet?",
            QMessageBox.Yes | QMessageBox.Cancel,
        ) != QMessageBox.Yes:
            return
        self._guarded(lambda: self.wallet.encrypt(p1), "Wallet encrypted.")

    def _do_unlock(self):
        if not self.snap.get("wallet", {}).get("encrypted"):
            QMessageBox.information(self, "Blockle", "The wallet is not encrypted.")
            return
        self.wallet.passphrase = None
        if not self._ensure_unlocked():
            return
        try:  # verify by signing a probe message
            self.wallet.sign_message("blockle-unlock-check")
        except WalletError as e:
            self.wallet.passphrase = None
            QMessageBox.critical(self, "Blockle", str(e))
            return
        QMessageBox.information(self, "Blockle", "Wallet unlocked for this session.")
        self.refresh()

    def _do_change_pass(self):
        if not self.snap.get("wallet", {}).get("encrypted"):
            QMessageBox.information(self, "Blockle", "Encrypt the wallet first.")
            return
        if not self._ensure_unlocked():
            return
        p1 = self._ask_password("Change passphrase", "New passphrase:")
        if p1 is None:
            return
        p2 = self._ask_password("Change passphrase", "Repeat new passphrase:")
        if p1 != p2:
            QMessageBox.critical(self, "Blockle", "Passphrases do not match.")
            return
        self._guarded(lambda: self.wallet.change_passphrase(p1), "Passphrase changed.")

    def _do_backup(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "Backup wallet", "blockle-wallet-backup.json", "Wallet (*.json)")
        if path:
            self._guarded(lambda: self.wallet.backup(path), f"Wallet backed up to {path}.")

    def _do_export(self):
        if QMessageBox.warning(
            self, "Export private keys",
            "Anyone with the export string OWNS this wallet.\nTreat it like cash. Continue?",
            QMessageBox.Yes | QMessageBox.Cancel,
        ) != QMessageBox.Yes:
            return
        if not self._ensure_unlocked():
            return
        try:
            blob = self.wallet.export_keys()
        except WalletError as e:
            QMessageBox.critical(self, "Blockle", str(e))
            return
        dlg = QMessageBox(self)
        dlg.setWindowTitle("Private key export")
        dlg.setText("Copy the export string from the details below and store it offline.")
        dlg.setDetailedText(blob)
        dlg.exec()

    def _do_import_wallet(self):
        blob, ok = QInputDialog.getMultiLineText(
            self, "Import wallet",
            "Paste an export string (blockleexport1…) or wallet.json contents:")
        if not ok or not blob.strip():
            return
        force = False
        if self.wallet.exists():
            if QMessageBox.warning(
                self, "Import wallet",
                "This REPLACES the current wallet on this machine.\n"
                "Back it up first! Replace it?",
                QMessageBox.Yes | QMessageBox.Cancel,
            ) != QMessageBox.Yes:
                return
            force = True
        self.wallet.passphrase = None
        result = self._guarded(
            lambda: self.wallet.import_keys(blob.strip(), force=force), "Wallet imported.")
        if result:
            self.refresh()

    def _do_sign(self):
        msg, ok = QInputDialog.getMultiLineText(self, "Sign message", "Message to sign:")
        if not ok or not msg:
            return
        if not self._ensure_unlocked():
            return
        try:
            out = self.wallet.sign_message(msg)
        except WalletError as e:
            QMessageBox.critical(self, "Blockle", str(e))
            return
        dlg = QMessageBox(self)
        dlg.setWindowTitle("Signed message")
        dlg.setText(f"Signed as {out['address'][:24]}…\nSignature in details below.")
        dlg.setDetailedText(out["signature"])
        dlg.exec()

    def _do_verify(self):
        addr, ok = QInputDialog.getText(self, "Verify message", "Signer address (block1…):")
        if not ok or not addr.strip():
            return
        sig, ok = QInputDialog.getMultiLineText(self, "Verify message", "Signature (blocklesig1…):")
        if not ok or not sig.strip():
            return
        msg, ok = QInputDialog.getMultiLineText(self, "Verify message", "Message:")
        if not ok:
            return
        try:
            valid = self.wallet.verify_message(addr.strip(), sig.strip(), msg)
        except WalletError as e:
            QMessageBox.critical(self, "Blockle", str(e))
            return
        if valid:
            QMessageBox.information(self, "Blockle", "VALID — signed by the key behind that address.")
        else:
            QMessageBox.critical(self, "Blockle", "INVALID signature.")

    def _console_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.addWidget(QLabel("Debug console — drive the node & wallet directly. Type "
                             "<b>help</b> and press Enter."))
        self.console_out = QPlainTextEdit()
        self.console_out.setReadOnly(True)
        mono = QFont("Menlo")
        mono.setStyleHint(QFont.Monospace)
        mono.setPointSize(11)
        self.console_out.setFont(mono)
        self.console_out.setStyleSheet(
            "QPlainTextEdit { background: #0b0e16; color: #cdd6f4; border: 1px solid #23262e; "
            "border-radius: 8px; padding: 10px; }")
        self.console_out.setPlainText("Blockle console ready. Type `help` for commands.\n")
        lay.addWidget(self.console_out, 1)
        row = QHBoxLayout()
        self.console_in = _ConsoleInput()
        self.console_in.setFont(mono)
        self.console_in.setPlaceholderText("help")
        completer = QCompleter(BUILTIN_COMMANDS, self.console_in)
        completer.setCaseSensitivity(Qt.CaseInsensitive)
        completer.setCompletionMode(QCompleter.PopupCompletion)
        self.console_in.setCompleter(completer)
        run = QPushButton("Run")
        run.setObjectName("primary")
        row.addWidget(self.console_in, 1)
        row.addWidget(run)
        lay.addLayout(row)
        self.console_in.returnPressed.connect(self._console_submit)
        run.clicked.connect(self._console_submit)
        self._console_worker = None
        return w

    def _console_append(self, text: str) -> None:
        self.console_out.appendPlainText(text)
        sb = self.console_out.verticalScrollBar()
        sb.setValue(sb.maximum())

    def _console_submit(self) -> None:
        line = self.console_in.text().strip()
        if not line:
            return
        self.console_in.clear()
        self.console_in.add_history(line)
        self._console_append("» " + line)
        if line.lower() == "clear":
            self.console_out.clear()
            return
        self.console_in.setEnabled(False)
        self._console_worker = ConsoleWorker(self.wallet, line)
        self._console_worker.done.connect(self._console_done)
        self._console_worker.start()

    def _console_done(self, text: str, is_err: bool) -> None:
        if text == "\x00clear":
            self.console_out.clear()
        elif text:
            self._console_append(("error: " + text) if is_err else text)
        self.console_in.setEnabled(True)
        self.console_in.setFocus()

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
            self.bal_lbl.setText(wal.get("spendable_fmt", wal["balance_fmt"]))
            imm = wal.get("immature", 0)
            self.immature_lbl.setText(wal.get("immature_fmt", "0") if imm else "0")
            self.immature_lbl.setToolTip(
                f"Mined rewards unlock {wal.get('coinbase_maturity', 100)} blocks after the block that earned them."
            )
            self.zbal_lbl.setText(wal["zbalance_fmt"])
            self.addr_row.findChild(QLineEdit).setText(wal["address"])
            self.zaddr_row.findChild(QLineEdit).setText(wal["zaddress"])
            self._fill_notes(wal.get("notes", []))
        self.height_lbl.setText(str(chain.get("height", "—")))
        self._fill_history(snap.get("history", []))
        if wal:
            if wal.get("encrypted"):
                lock = "locked" if not self.wallet.passphrase else "unlocked (session)"
                self.enc_lbl.setText(f"Encryption: encrypted · {lock}")
            else:
                self.enc_lbl.setText("Encryption: not encrypted — consider Encrypt wallet…")
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
        # tear down the multi-chain controller: lock the vault (wipe the seed +
        # credentials from memory) and stop the agent loop.
        for widget, _title in getattr(self, "_mc_tabs", []):
            ctrl = getattr(widget, "ctrl", None)
            if ctrl is not None:
                try:
                    ctrl.vault.lock()
                except Exception:
                    pass
                if getattr(ctrl, "loop", None) is not None:
                    ctrl.loop.stop()
                break
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
    logo = Path(__file__).parent / "assets" / "logo.png"
    if logo.exists():
        app.setWindowIcon(QIcon(str(logo)))
    if sys.platform == "win32":  # taskbar shows the exe icon without this
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("blockle.wallet")

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
        peers=args.connect
        or [p for p in str(settings.value("peers", "")).split(",") if p]
        or ["blockle.org:18444"],
    )
    win = WalletWindow(wallet, node)
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
