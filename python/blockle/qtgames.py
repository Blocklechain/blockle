"""blockle.qtgames — the Blockle Game Hub panel for the desktop (Qt) wallet.

A crypto-native desktop game store, built into the wallet — "the Blockle wallet
focused around games". Browse the catalog, install and launch native games, and
(when the purchase backend is live) buy them with crypto: developers keep 90% of
every sale, versus the 30% a traditional store takes.

The store/library/launcher logic lives in :mod:`blockle.gamehub` (Qt-free and
unit-tested); this panel is the UI over it. The catalog is read from
``{origin}/games/catalog.json``; until it exists the Store shows an opening-soon
state. Paid games are gated honestly — the engine refuses to "buy" until the
on-chain purchase flow ships.
"""

from __future__ import annotations

import os
from typing import Any, Callable, List, Optional

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QMessageBox,
    QProgressBar, QPushButton, QTabWidget, QVBoxLayout, QWidget,
)

from .gamehub import Game, GameHub, GameHubError

API_BASE = os.environ.get("BLOCKLE_ACCOUNT_ORIGIN", "https://blockle.org").rstrip("/")
CATALOG_URL = API_BASE + "/games/catalog.json"


class _Worker(QThread):
    done = Signal(object)
    failed = Signal(str)
    progress = Signal(str, float)

    def __init__(self, fn: Callable[..., Any]) -> None:
        super().__init__()
        self._fn = fn

    def run(self) -> None:
        try:
            self.done.emit(self._fn(self.progress.emit))
        except Exception as e:  # pragma: no cover - UI path
            self.failed.emit(str(e))


class GamesTab(QWidget):
    def __init__(self, hub: GameHub) -> None:
        super().__init__()
        self.hub = hub
        self._games: List[Game] = []
        self._workers: List[_Worker] = []

        root = QVBoxLayout(self)
        header = QLabel("Blockle Game Hub")
        header.setStyleSheet("font-size:18px;font-weight:700;")
        sub = QLabel(
            "Own your games and items. Developers keep 90% — a store that takes 10%, not 30%."
        )
        sub.setStyleSheet("color:#9aa;")
        sub.setWordWrap(True)
        root.addWidget(header)
        root.addWidget(sub)

        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)

        # Store tab
        store = QWidget()
        sl = QVBoxLayout(store)
        self.store_list = QListWidget()
        self.store_empty = QLabel("")
        self.store_empty.setAlignment(Qt.AlignCenter)
        self.store_empty.setWordWrap(True)
        self.store_empty.setStyleSheet("color:#889;padding:28px;")
        sl.addWidget(self.store_empty)
        sl.addWidget(self.store_list, 1)
        refresh = QPushButton("Refresh store")
        refresh.clicked.connect(self.load_catalog)
        sl.addWidget(refresh)
        self.tabs.addTab(store, "Store")

        # Library tab
        lib = QWidget()
        ll = QVBoxLayout(lib)
        self.lib_list = QListWidget()
        self.lib_empty = QLabel("No games installed yet. Install one from the Store.")
        self.lib_empty.setAlignment(Qt.AlignCenter)
        self.lib_empty.setStyleSheet("color:#889;padding:28px;")
        ll.addWidget(self.lib_empty)
        ll.addWidget(self.lib_list, 1)
        self.tabs.addTab(lib, "Library")
        self.tabs.currentChanged.connect(lambda _: self.refresh_library())

        self.status = QLabel("")
        self.status.setStyleSheet("color:#9aa;")
        root.addWidget(self.status)
        self.progress = QProgressBar()
        self.progress.setVisible(False)
        root.addWidget(self.progress)

        self.refresh_library()
        self.load_catalog()

    # ---- store ----------------------------------------------------------- #
    def load_catalog(self) -> None:
        self.store_empty.setText("Loading store…")
        self.store_list.clear()
        w = _Worker(lambda _p: self.hub.catalog(CATALOG_URL))
        w.done.connect(self._on_catalog)
        w.failed.connect(self._on_catalog_failed)
        self._run(w)

    def _on_catalog_failed(self, _err: str) -> None:
        self.store_empty.setText(
            "The Blockle Game Hub store is opening soon.\n\n"
            "Developers: submit your game for free with the blockle-game CLI and keep 90% of sales."
        )

    def _on_catalog(self, games: List[Game]) -> None:
        self._games = games
        self.store_list.clear()
        if not games:
            self._on_catalog_failed("")
            return
        self.store_empty.setText("")
        for g in games:
            self.store_list.addItem(self._store_row(g))

    def _store_row(self, g: Game) -> QListWidgetItem:
        item = QListWidgetItem()
        card = QFrame()
        row = QHBoxLayout(card)
        meta = QVBoxLayout()
        title = QLabel(f"<b>{g.name}</b>  <span style='color:#889'>v{g.version}</span>")
        desc = QLabel(g.description or "")
        desc.setStyleSheet("color:#9aa;")
        desc.setWordWrap(True)
        price = QLabel(f"{g.price_block:g} BLOCK" if g.paid else "Free")
        price.setStyleSheet("color:#7c5cff;font-weight:700;")
        meta.addWidget(title)
        meta.addWidget(desc)
        meta.addWidget(price)
        row.addLayout(meta, 1)

        btn = QPushButton()
        installed = self.hub.is_installed(g.id)
        if installed and self.hub.update_available(g):
            btn.setText("Update")
            btn.clicked.connect(lambda _=False, game=g: self._install(game))
        elif installed:
            btn.setText("Installed")
            btn.setEnabled(False)
        else:
            ok, reason = self.hub.can_install(g)
            if ok:
                btn.setText("Install" if not g.paid else "Buy & install")
                btn.clicked.connect(lambda _=False, game=g: self._install(game))
            else:
                btn.setText("Buy with crypto (soon)" if g.paid else "Unavailable")
                btn.setEnabled(False)
                btn.setToolTip(reason)
        row.addWidget(btn, 0, Qt.AlignTop)

        item.setSizeHint(card.sizeHint())
        self.store_list.setItemWidget(item, card)
        return item

    def _install(self, g: Game) -> None:
        self.progress.setVisible(True)
        self.progress.setValue(0)
        self.status.setText(f"Installing {g.name}…")

        w = _Worker(lambda report, game=g: self.hub.install(game, progress=lambda phase, frac: report(phase, frac)))
        w.progress.connect(self._on_progress)
        w.done.connect(lambda _rec, game=g: self._install_done(game))
        w.failed.connect(self._install_failed)
        self._run(w)

    def _on_progress(self, phase: str, frac: float) -> None:
        self.progress.setValue(int(frac * 100))
        self.status.setText(f"{phase.capitalize()}… {int(frac * 100)}%")

    def _install_done(self, g: Game) -> None:
        self.progress.setVisible(False)
        self.status.setText(f"Installed {g.name}.")
        self._on_catalog(self._games)  # refresh store buttons
        self.refresh_library()

    def _install_failed(self, err: str) -> None:
        self.progress.setVisible(False)
        self.status.setText("")
        QMessageBox.warning(self, "Install failed", err)

    # ---- library ---------------------------------------------------------- #
    def refresh_library(self) -> None:
        self.lib_list.clear()
        games = self.hub.installed()
        self.lib_empty.setVisible(not games)
        for e in games:
            self.lib_list.addItem(self._lib_row(e))

    def _lib_row(self, e: dict) -> QListWidgetItem:
        item = QListWidgetItem()
        card = QFrame()
        row = QHBoxLayout(card)
        meta = QVBoxLayout()
        meta.addWidget(QLabel(f"<b>{e.get('name', e['id'])}</b>  <span style='color:#889'>v{e.get('version','')}</span>"))
        size_mb = (e.get("size", 0) or 0) / (1024 * 1024)
        info = QLabel(f"{size_mb:.0f} MB  ·  {e.get('developer','')}")
        info.setStyleSheet("color:#9aa;")
        meta.addWidget(info)
        row.addLayout(meta, 1)

        play = QPushButton("Play")
        play.clicked.connect(lambda _=False, gid=e["id"]: self._launch(gid))
        row.addWidget(play, 0, Qt.AlignTop)
        rm = QPushButton("Uninstall")
        rm.clicked.connect(lambda _=False, gid=e["id"], name=e.get("name", e["id"]): self._uninstall(gid, name))
        row.addWidget(rm, 0, Qt.AlignTop)

        item.setSizeHint(card.sizeHint())
        self.lib_list.setItemWidget(item, card)
        return item

    def _launch(self, gid: str) -> None:
        try:
            self.hub.launch(gid)
            self.status.setText("Launched.")
        except GameHubError as e:
            QMessageBox.warning(self, "Can't launch", str(e))

    def _uninstall(self, gid: str, name: str) -> None:
        if QMessageBox.question(self, "Uninstall", f"Remove {name} and its files?") != QMessageBox.Yes:
            return
        self.hub.uninstall(gid)
        self.refresh_library()
        self._on_catalog(self._games)

    # ---- worker lifecycle ------------------------------------------------- #
    def _run(self, w: _Worker) -> None:
        self._workers.append(w)
        w.finished.connect(lambda: self._workers.remove(w) if w in self._workers else None)
        w.start()


def build_games_tab(ctrl) -> tuple:
    """Return ``(widget, "Games")`` for the desktop tab bar."""
    hub = GameHub(ctrl.datadir)
    return (GamesTab(hub), "Games")
