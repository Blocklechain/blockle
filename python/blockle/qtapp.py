"""blockle.qtapp — the FULL multi-chain desktop app window.

This is what the shipped desktop binary launches (:mod:`launcher`). The legacy
entry point imported :func:`blockle.qtwallet.main` — the BLOCK-only wallet — so
the packaged app shipped with NONE of the multichain / exchange / agent / bots /
wallet / hosted-agent features. This module hosts every engine layer in ONE
window:

  * (optional) the native BLOCK wallet (:class:`blockle.qtwallet.WalletWindow`),
    with its embedded-node controls; and
  * the Accounts / Exchange / Agent / Bots / Wallet panels returned by
    :func:`blockle.qtmultichain.build_tabs` — all sharing ONE
    :class:`~blockle.qtmultichain.MultiChainController` (one vault, one async
    loop, one audited gate).

Headless-test-safe: importing this module and calling :func:`build_app_window`
under ``QT_QPA_PLATFORM=offscreen`` builds the entire tab stack without a
network, a node, or a real LLM.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, List, Optional, Tuple

from PySide6.QtWidgets import QApplication, QMainWindow, QTabWidget, QWidget

from .qtmultichain import build_tabs


def build_app_window(block_wallet: Any, datadir: Any,
                     extra_tabs: Optional[List[Tuple[QWidget, str]]] = None,
                     title: str = "Blockle Wallet") -> QMainWindow:
    """Build the full desktop window: a :class:`QMainWindow` whose central widget
    is a :class:`QTabWidget` of every panel. ``extra_tabs`` (e.g. the native
    BLOCK wallet) are prepended before the multichain tabs. Does NOT call
    ``show()``/``exec()`` — safe to build headless."""
    win = QMainWindow()
    win.setWindowTitle(title)
    tabw = QTabWidget()
    tabw.setDocumentMode(True)
    for widget, label in (extra_tabs or []):
        if widget is not None:
            tabw.addTab(widget, label)
    for widget, label in build_tabs(block_wallet, datadir):
        tabw.addTab(widget, label)
    win.setCentralWidget(tabw)
    # keep handles so tests (and later wiring) can introspect the tab stack.
    win.tabs = tabw
    return win


def tab_titles(win: QMainWindow) -> List[str]:
    """The ordered tab labels of a window built by :func:`build_app_window`."""
    tabw = getattr(win, "tabs", None)
    if tabw is None:
        return []
    return [tabw.tabText(i) for i in range(tabw.count())]


def _build_block_tab(wallet: Any, datadir: Path, args: argparse.Namespace):
    """Build the native BLOCK wallet window to embed as the first tab. Guarded —
    returns ``None`` (never raises) so a BLOCK/node problem never drops the
    multichain app."""
    try:
        from PySide6.QtCore import QSettings

        from .qtwallet import NodeProcess, WalletWindow
        settings = QSettings("blockle", "wallet")
        node = NodeProcess(
            datadir=datadir, network=args.network,
            listen=args.listen or settings.value("listen", "0.0.0.0:18444"),
            peers=args.connect
            or [p for p in str(settings.value("peers", "")).split(",") if p]
            or ["blockle.org:18444"],
        )
        return WalletWindow(wallet, node)
    except Exception as e:  # pragma: no cover - optional feature
        print(f"blockle-qt: native BLOCK wallet tab unavailable ({e})", file=sys.stderr)
        return None


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="blockle", description="Blockle multi-chain desktop wallet")
    ap.add_argument("--datadir", default=str(Path.home() / ".blockle"))
    ap.add_argument("--network", default="mainnet", choices=["mainnet", "regtest"])
    ap.add_argument("--connect", action="append", default=[],
                    help="peer to connect the embedded BLOCK node to (repeatable)")
    ap.add_argument("--listen", default=None, help="P2P listen address for the embedded BLOCK node")
    ap.add_argument("--no-block-tab", action="store_true",
                    help="skip the native BLOCK wallet tab (multichain panels only)")
    args = ap.parse_args(argv)

    from PySide6.QtGui import QFont, QIcon

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("Blockle Wallet")
    app.setFont(QFont(app.font().family(), 13))
    logo = Path(__file__).parent / "assets" / "logo.png"
    if logo.exists():
        app.setWindowIcon(QIcon(str(logo)))
    if sys.platform == "win32":  # taskbar shows the exe icon without this
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("blockle.wallet")

    datadir = Path(args.datadir)
    datadir.mkdir(parents=True, exist_ok=True)

    from .chainwallet import ChainWallet
    wallet = ChainWallet(datadir=datadir, network=args.network)
    if not wallet.exists():
        wallet.create()
    if args.network == "regtest" and hasattr(wallet, "has_chain") and not wallet.has_chain():
        wallet.init_chain()

    extra: List[Tuple[QWidget, str]] = []
    if not args.no_block_tab:
        block_tab = _build_block_tab(wallet, datadir, args)
        if block_tab is not None:
            extra.append((block_tab, "BLOCK"))

    win = build_app_window(wallet, datadir, extra_tabs=extra, title="Blockle Wallet")
    win.resize(1240, 860)
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
