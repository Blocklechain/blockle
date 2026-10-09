"""blockle.qtmultichain — the multi-chain / exchange / AI-agent Qt panels.

This module is ADDITIVE: it is imported lazily by :mod:`blockle.qtwallet` and, if
anything here is unavailable (missing crypto deps, etc.), the core BLOCK wallet
still runs untouched. Everything reuses the audited Python port under
:mod:`blockle.multichain` and :mod:`blockle.agent` — no crypto or signing is
reimplemented here; BLOCK stays in the Rust engine via ``ChainWallet``.

Three panels, matching the browser extension and the Flutter app:

  * :class:`AccountsTab`  — one encrypted HD seed drives EVM / BTC / LTC / DOGE /
    Solana addresses alongside BLOCK; live balances (incl. ERC-20 USDC/USDT),
    per-chain Send (adapter build_send -> review fee/txid -> confirm ->
    broadcast), add-token, endpoints. Post-quantum labels are honest: only BLOCK.
  * :class:`ExchangeTab`  — sign in with the BLOCK key, markets + book, place /
    cancel orders, buy / sell BLOCK, against exchange.blockle.org.
  * :class:`AgentTab`     — the agent cockpit: connect a provider (Claude /
    ChatGPT / Copilot / Other) with its credential guide; multi-channel per
    wallet; per-channel caps, predefined prompts, a command box, P&L + audit; a
    REAL confirmation modal and an always-visible KILL switch. Value-moving
    channels refuse to start until caps are set.

HARD RULES honoured: the HD seed + LLM credentials live only inside the
scrypt+AES-256-GCM vault; they are decrypted into memory for the session and are
never logged or sent to any Blockle server. Signing is local.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtWidgets import (
    QComboBox, QDialog, QDialogButtonBox, QFormLayout, QFrame, QGridLayout,
    QGroupBox, QHBoxLayout, QHeaderView, QInputDialog, QLabel, QLineEdit,
    QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit, QPushButton,
    QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget,
)

from . import agent as agentpkg
from .multichain import crypto as K
from .multichain import exchange as exmod
from .multichain import venues as venuesmod
from .multichain.chains import create_registry

# --------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------

#: EVM networks — one secp256k1 address across all of them (m/44'/60').
EVM_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche"]
CHAIN_ORDER = ["block", *EVM_CHAINS, "bitcoin", "litecoin", "dogecoin", "solana"]
CHAIN_LABELS = {
    "block": "BLOCK", "ethereum": "Ethereum", "base": "Base",
    "arbitrum": "Arbitrum One", "optimism": "Optimism", "polygon": "Polygon",
    "bnb": "BNB Chain", "avalanche": "Avalanche C-Chain",
    "bitcoin": "Bitcoin", "litecoin": "Litecoin", "dogecoin": "Dogecoin",
    "solana": "Solana",
}
#: Only BLOCK signs post-quantum (ML-DSA-44). Every other chain is ECDSA/ed25519
#: — the vault hardens the stored key against theft, it is NOT a PQ signature.
CHAIN_PQ = {"block": True}
CHAIN_SCHEME = {
    "block": "ML-DSA-44 (post-quantum)",
    **{c: "secp256k1" for c in EVM_CHAINS},
    "bitcoin": "secp256k1", "litecoin": "secp256k1", "dogecoin": "secp256k1",
    "solana": "ed25519",
}

#: The treasury the non-bypassable 0.05% agent trade fee is routed to, per chain
#: (mirrors exchange/treasury.json). Fail-closed if a chain has no entry.
DEFAULT_TREASURY = {
    "agentTradeFeeBps": 5,
    "mainnet": {
        "solana": "EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j",
        "ethereum": "0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c",
        "base": "0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c",
    },
}

PREDEFINED_PROMPTS = [
    "DCA $50/week into BLOCK",
    "rebalance 50/50 BLOCK/USDC",
    "buy the dip -10%",
    "take profit +25%",
    "market-make BLOCK/USDC",
]


# --------------------------------------------------------------------------
# multichain vault — the sealed HD seed + agent credentials + settings
# --------------------------------------------------------------------------


class MultiVault:
    """Stores the HD seed (as a BIP39 mnemonic), per-chain endpoint/token config,
    agent channel records and LLM credentials inside ONE scrypt+AES-256-GCM blob
    (``blockle.multichain.vault``). Byte-portable with the extension / Flutter
    vaults. Nothing is written in plaintext."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._plain: Optional[Dict[str, Any]] = None  # decrypted, session-only
        self._password: Optional[str] = None

    # ---- lifecycle ----
    def exists(self) -> bool:
        return self.path.exists()

    def is_unlocked(self) -> bool:
        return self._plain is not None

    def _read_sealed(self) -> Dict[str, Any]:
        return json.loads(self.path.read_text())

    def _write_sealed(self, sealed: Dict[str, Any]) -> None:
        self.path.write_text(json.dumps(sealed, separators=(",", ":")))

    def create(self, password: str, mnemonic: Optional[str] = None) -> str:
        """Create a new vault with a fresh (or supplied) 12-word mnemonic."""
        mnemonic = (mnemonic or K.generate_mnemonic(128)).strip()
        if not K.validate_mnemonic(mnemonic):
            raise ValueError("invalid recovery phrase")
        self._plain = {
            "version": 2, "mnemonic": mnemonic,
            "endpoints": {}, "tokens": {}, "customNetworks": [],
            "channels": [], "agentCreds": {},
        }
        self._password = password
        self._seal()
        return mnemonic

    def unlock(self, password: str) -> None:
        from .multichain import vault as vaultmod
        sealed = self._read_sealed()
        self._plain = vaultmod.Vault.open(sealed, password)  # raises WrongPassword
        self._password = password
        if vaultmod.Vault.needs_upgrade(sealed):
            self._seal()  # transparent re-seal to the current (scrypt/v2) format

    def lock(self) -> None:
        self._plain = None
        self._password = None

    def _seal(self) -> None:
        from .multichain import vault as vaultmod
        if self._plain is None or self._password is None:
            raise RuntimeError("vault locked")
        self._write_sealed(vaultmod.Vault.seal(self._plain, self._password))

    # ---- accessors (require unlock) ----
    def _require(self) -> Dict[str, Any]:
        if self._plain is None:
            raise RuntimeError("vault locked")
        return self._plain

    def seed(self) -> bytes:
        return K.mnemonic_to_seed(self._require()["mnemonic"])

    def mnemonic(self) -> str:
        return self._require()["mnemonic"]

    def endpoints(self) -> Dict[str, Any]:
        return self._require().get("endpoints") or {}

    def tokens(self) -> Dict[str, Any]:
        return self._require().get("tokens") or {}

    def alchemy(self) -> Dict[str, Any]:
        """Per-network Alchemy indexer config for ERC-20 auto-detect (OFF until
        set). Shape: ``{"ethereum": "<alchemy-rpc-url-with-key>", ...}``. This is
        a READ-ONLY indexer key, not a wallet secret — stored in the sealed vault
        like other settings, and NEVER logged."""
        return self._require().get("alchemy") or {}

    def set_alchemy(self, network: str, url: str) -> None:
        self._require().setdefault("alchemy", {})[network] = url
        self._seal()

    def set_endpoint(self, chain: str, cfg: Dict[str, Any]) -> None:
        self._require().setdefault("endpoints", {})[chain] = cfg
        self._seal()

    def add_token(self, chain: str, token: Dict[str, Any]) -> None:
        toks = self._require().setdefault("tokens", {}).setdefault(chain, [])
        toks.append(token)
        self._seal()

    # ---- user-added custom networks --------------------------------------
    # Network definitions are NOT secrets (just RPC/explorer/indexer URLs); they
    # live here alongside the other per-chain config because the sealed vault is
    # this wallet's only persisted settings store. Validated via
    # ``normalize_custom_network`` before they are stored.
    def custom_networks(self) -> List[Dict[str, Any]]:
        return list(self._require().get("customNetworks") or [])

    def set_custom_networks(self, nets: List[Dict[str, Any]]) -> None:
        from .multichain.chains import normalize_custom_networks
        self._require()["customNetworks"] = normalize_custom_networks(nets)
        self._seal()

    def add_custom_network(self, net: Dict[str, Any]) -> Dict[str, Any]:
        """Validate + upsert one custom network (dedupe by id/chainId). Returns
        the normalized record. Raises ``ValueError`` on an invalid definition."""
        from .multichain.chains import (dedupe_custom_networks,
                                        normalize_custom_network)
        norm = normalize_custom_network(net)
        cur = self.custom_networks()
        self._require()["customNetworks"] = dedupe_custom_networks(cur + [norm])
        self._seal()
        return norm

    def remove_custom_network(self, net_id: str) -> None:
        cur = self.custom_networks()
        self._require()["customNetworks"] = [n for n in cur if n.get("id") != net_id]
        self._seal()

    # ---- agent channel persistence + credentials ----
    def channels(self) -> List[Dict[str, Any]]:
        return self._require().get("channels") or []

    def set_channels(self, recs: List[Dict[str, Any]]) -> None:
        self._require()["channels"] = recs
        self._seal()

    def set_credential(self, ref: str, cred: Dict[str, Any]) -> None:
        self._require().setdefault("agentCreds", {})[ref] = cred
        self._seal()

    def get_credential(self, ref: str) -> Optional[Dict[str, Any]]:
        return (self._require().get("agentCreds") or {}).get(ref)

    def credentials(self) -> Dict[str, Any]:
        return self._require().get("agentCreds") or {}


class _DictStore:
    """A tiny sync Store the agent audit/channel layer can persist into. Backed
    by the MultiVault for channel records; everything else stays in memory for
    the session (audit logs are not secret but are large, so kept per-session)."""

    def __init__(self, vault: MultiVault):
        self._vault = vault
        self._mem: Dict[str, Any] = {}

    async def get(self, keys=None):
        if keys is None:
            out = dict(self._mem)
            out["agentChannels"] = self._vault.channels()
            return out
        lst = keys if isinstance(keys, list) else [keys]
        out = {}
        for k in lst:
            if k == "agentChannels":
                out[k] = self._vault.channels()
            elif k in self._mem:
                out[k] = self._mem[k]
        return out

    async def set(self, obj):
        for k, v in obj.items():
            if k == "agentChannels":
                self._vault.set_channels(v)
            else:
                self._mem[k] = v

    async def remove(self, keys):
        lst = keys if isinstance(keys, list) else [keys]
        for k in lst:
            self._mem.pop(k, None)


# --------------------------------------------------------------------------
# async agent loop + UI confirmation bridge
# --------------------------------------------------------------------------


class AgentLoop(threading.Thread):
    """A persistent asyncio loop on its own thread. The agent/channel layer is
    async; coroutines are submitted here and their futures bridged back to Qt."""

    def __init__(self):
        super().__init__(daemon=True)
        self.loop = asyncio.new_event_loop()
        self._ready = threading.Event()

    def run(self):
        asyncio.set_event_loop(self.loop)
        self._ready.set()
        self.loop.run_forever()

    def submit(self, coro):
        self._ready.wait()
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def stop(self):
        try:
            self.loop.call_soon_threadsafe(self.loop.stop)
        except Exception:
            pass


class ConfirmBridge(QObject):
    """Marshals the agent's (worker-thread) confirmation request onto the UI
    thread as a REAL modal, then resolves the awaiting coroutine's future."""

    requested = Signal(object, object)  # (summary, concurrent.future-like resolver)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.requested.connect(self._show, Qt.QueuedConnection)

    def _show(self, summary, resolver):
        dlg = QMessageBox()
        dlg.setWindowTitle("Agent action — confirm")
        dlg.setIcon(QMessageBox.Warning)
        dlg.setText("The AI agent wants to perform a value-moving action.\n"
                    "Review it carefully — this is the mandatory human gate.")
        dlg.setDetailedText(json.dumps(summary, indent=2, default=str))
        dlg.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        dlg.setDefaultButton(QMessageBox.No)
        ok = dlg.exec() == QMessageBox.Yes
        resolver(ok)


# --------------------------------------------------------------------------
# generic off-thread worker
# --------------------------------------------------------------------------


class Worker(QThread):
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, fn):
        super().__init__()
        self._fn = fn

    def run(self):
        try:
            self.done.emit(self._fn())
        except Exception as e:  # pragma: no cover - surfaced in UI
            self.failed.emit(str(e))


# --------------------------------------------------------------------------
# controller — owns the registry, adapters, exchange, venues, channel manager
# --------------------------------------------------------------------------


class MultiChainController:
    def __init__(self, block_wallet, datadir: Path):
        self.block_wallet = block_wallet
        self.datadir = Path(datadir)
        self.vault = MultiVault(self.datadir / "multichain-vault.json")
        self.registry = None
        self.exchange = None
        self.venues = None
        self.channel_mgr = None
        self.accounts: Dict[str, Any] = {}      # chain -> DerivedAccount
        self._store: Optional[_DictStore] = None
        self.loop: Optional[AgentLoop] = None
        self.confirm_bridge: Optional[ConfirmBridge] = None

    # ---- unlock everything from the sealed seed ----
    def unlock(self, password: str) -> None:
        self.vault.unlock(password)
        self._build()

    def create(self, password: str, mnemonic: Optional[str] = None) -> str:
        m = self.vault.create(password, mnemonic)
        self._build()
        return m

    def is_unlocked(self) -> bool:
        return self.vault.is_unlocked()

    def _build(self) -> None:
        seed = self.vault.seed()
        cfg = {
            "endpoints": self.vault.endpoints(),
            "tokens": self.vault.tokens(),
            "alchemy": self.vault.alchemy(),
            "customNetworks": self.vault.custom_networks(),
            "block": {"wallet": self.block_wallet},
        }
        self.registry = create_registry(cfg)
        self.registry.unlock(seed)
        self.accounts = {}
        for cid in self.registry.enabled():
            try:
                self.accounts[cid] = self.registry.get(cid).derive_account(seed, 0)
            except Exception:
                self.accounts[cid] = None

        # exchange client signs with the local BLOCK key (ML-DSA, in the engine)
        snap = {}
        try:
            snap = self.block_wallet.snapshot().get("wallet", {})
        except Exception:
            snap = {}
        self.exchange = exmod.ExchangeClient(
            wallet=self.block_wallet,
            address=snap.get("address"),
            public_key=snap.get("publicKey") or snap.get("public_key"),
        )
        self.venues = venuesmod.create({"treasury": DEFAULT_TREASURY})

        if self.loop is None:
            self.loop = AgentLoop()
            self.loop.start()
        self._store = _DictStore(self.vault)

    # ---- chain ordering + labels (built-ins first, then custom networks) ----
    def ordered_chains(self) -> List[str]:
        reg = self.registry
        if not reg:
            return []
        base = [c for c in CHAIN_ORDER if reg.has(c)]
        customs = [n["id"] for n in reg.custom_networks()
                   if n["id"] not in base and reg.has(n["id"])]
        return base + customs

    def chain_label(self, cid: str) -> str:
        if cid in CHAIN_LABELS:
            return CHAIN_LABELS[cid]
        if self.registry:
            for n in self.registry.custom_networks():
                if n["id"] == cid:
                    return n["name"]
        return cid

    # ---- agent ctx wiring the tools call into ----
    def _ctx(self, meta=None) -> Dict[str, Any]:
        reg = self.registry
        accts = self.accounts

        def get_address(chain):
            a = accts.get(chain)
            return a.address if a else None

        def get_balance(chain, tokens=None):
            a = accts.get(chain)
            addr = a.address if a else None
            if tokens is not None:
                # Caller pinned an explicit token set — honour it verbatim.
                bals = reg.get(chain).get_balance(addr, tokens)
            else:
                # Default view: native + known list + auto-detected held tokens,
                # merged and deduped by (chain, contract), non-zero first.
                bals = reg.all_balances(chain, addr)
            return [
                {"asset": b.asset.to_json(), "confirmed": b.confirmed,
                 "display": b.display, "error": b.error}
                for b in bals
            ]

        def list_assets():
            out = []
            for cid in reg.enabled():
                out.append({"chain": cid, "native": reg.get(cid).native.to_json()})
                for t in reg.tokens_for(cid):
                    out.append({"chain": cid, "token": t.to_json()})
            return out

        def build_send(chain, req):
            return reg.get(chain).build_send(accts.get(chain), req)

        def broadcast(chain, built):
            res = reg.get(chain).broadcast(built)
            return {"txid": res.txid, "accepted": res.accepted}

        def send_fee(fee_xfer):
            chain = fee_xfer["chain"]
            built = reg.get(chain).build_send(accts.get(chain), {
                "asset": _asset_for(reg, chain, fee_xfer.get("asset")),
                "to": fee_xfer["to"], "amount": str(fee_xfer["amount"]),
            })
            res = reg.get(chain).broadcast(built)
            return {"txid": res.txid, "accepted": res.accepted}

        def execute_swap(built):
            chain = built.get("chain")
            tx = built.get("tx") or {}
            adapter = reg.get(chain)
            if chain in ("ethereum", "base") and tx.get("to"):
                signed = adapter.sign_arbitrary_tx(accts.get(chain), tx)
                res = adapter.broadcast(signed)
                return {"txid": res.txid}
            if chain == "solana" and tx.get("swapTransaction"):
                signed = adapter.sign_tx(accts.get(chain), tx["swapTransaction"])
                res = adapter.broadcast(signed)
                return {"txid": res.txid}
            # native blockle route -> the non-custodial exchange
            return self.exchange.swap(built.get("from"), built.get("to"), built.get("amountIn"))

        def explorer_tx(chain, txid):
            try:
                return reg.get(chain).explorer_tx(txid) if txid else None
            except Exception:
                return None

        return {
            "getAddress": get_address, "getBalance": get_balance, "listAssets": list_assets,
            "buildSend": build_send, "broadcast": broadcast, "sendFee": send_fee,
            "executeSwap": execute_swap, "explorerTx": explorer_tx,
            "exchange": self.exchange, "venues": self.venues,
        }

    # ---- channel manager (multi-channel per wallet) ----
    def channel_manager(self, on_event=None, on_channel_kill=None) -> Any:
        async def confirm(summary):
            fut = self.loop.loop.create_future()

            def resolve(ok):
                self.loop.loop.call_soon_threadsafe(fut.set_result, bool(ok))
            self.confirm_bridge.requested.emit(summary, resolve)
            return await fut

        async def resolve_credential(cred_ref, meta):
            return self.vault.get_credential(cred_ref)

        self.channel_mgr = agentpkg.channels.create({
            "store": self._store,
            "resolveCredential": resolve_credential,
            "confirm": confirm,
            "ctxFor": self._ctx,
            "onEvent": on_event,
            "onChannelKill": on_channel_kill,
        })
        return self.channel_mgr


def _asset_for(reg, chain, asset_id):
    """Resolve an asset id/symbol to an AssetRef for build_send; None = native."""
    if not asset_id:
        return None
    for t in reg.tokens_for(chain):
        if asset_id in (t.symbol, t.address):
            return t
    return None


# --------------------------------------------------------------------------
# ACCOUNTS tab
# --------------------------------------------------------------------------


class AccountsTab(QWidget):
    def __init__(self, ctrl: MultiChainController):
        super().__init__()
        self.ctrl = ctrl
        self._workers: List[Worker] = []
        lay = QVBoxLayout(self)

        self.lock_lbl = QLabel("The multi-chain vault is locked.")
        self.lock_lbl.setObjectName("sub")
        lay.addWidget(self.lock_lbl)

        row = QHBoxLayout()
        self.unlock_btn = QPushButton("Unlock / create vault…")
        self.unlock_btn.setObjectName("primary")
        self.unlock_btn.clicked.connect(self._unlock)
        self.refresh_btn = QPushButton("Refresh balances")
        self.refresh_btn.clicked.connect(self._refresh_balances)
        self.refresh_btn.setEnabled(False)
        self.phrase_btn = QPushButton("Show recovery phrase…")
        self.phrase_btn.clicked.connect(self._show_phrase)
        self.phrase_btn.setEnabled(False)
        self.endpoints_btn = QPushButton("Endpoints…")
        self.endpoints_btn.clicked.connect(self._edit_endpoints)
        self.endpoints_btn.setEnabled(False)
        self.networks_btn = QPushButton("Custom networks…")
        self.networks_btn.clicked.connect(self._edit_custom_networks)
        self.networks_btn.setEnabled(False)
        for b in (self.unlock_btn, self.refresh_btn, self.phrase_btn,
                  self.endpoints_btn, self.networks_btn):
            row.addWidget(b)
        row.addStretch(1)
        lay.addLayout(row)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["Chain", "Scheme", "Address", "Balance", ""])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Stretch)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.verticalHeader().hide()
        lay.addWidget(self.table, 1)

        trow = QHBoxLayout()
        self.send_btn = QPushButton("Send…")
        self.send_btn.clicked.connect(self._send)
        self.add_token_btn = QPushButton("Add ERC-20 token…")
        self.add_token_btn.clicked.connect(self._add_token)
        for b in (self.send_btn, self.add_token_btn):
            b.setEnabled(False)
            trow.addWidget(b)
        trow.addStretch(1)
        note = QLabel("Post-quantum signatures: BLOCK only (ML-DSA-44). "
                      "Other chains sign with ECDSA/ed25519; the vault protects the stored key.")
        note.setObjectName("sub")
        note.setWordWrap(True)
        lay.addLayout(trow)
        lay.addWidget(note)

    # ---- actions ----
    def _unlock(self):
        v = self.ctrl.vault
        if not v.exists():
            self._create_flow()
            return
        pw, ok = QInputDialog.getText(self, "Unlock multi-chain vault",
                                      "Vault passphrase:", QLineEdit.Password)
        if not ok or not pw:
            return
        try:
            self.ctrl.unlock(pw)
        except Exception as e:
            QMessageBox.critical(self, "Blockle", f"Could not unlock vault:\n{e}")
            return
        self._on_unlocked()

    def _create_flow(self):
        from .multichain import vault as vaultmod  # noqa: F401 (ensures dep present)
        if QMessageBox.question(
            self, "Create multi-chain vault",
            "No multi-chain vault yet. Create one? A fresh 12-word recovery phrase "
            "will be generated and sealed (scrypt + AES-256-GCM).",
        ) != QMessageBox.Yes:
            return
        p1, ok = QInputDialog.getText(self, "Create vault", "New passphrase:", QLineEdit.Password)
        if not ok or not p1:
            return
        p2, ok = QInputDialog.getText(self, "Create vault", "Repeat passphrase:", QLineEdit.Password)
        if not ok or p1 != p2:
            QMessageBox.critical(self, "Blockle", "Passphrases do not match.")
            return
        try:
            mnemonic = self.ctrl.create(p1)
        except Exception as e:
            QMessageBox.critical(self, "Blockle", f"Could not create vault:\n{e}")
            return
        dlg = QMessageBox(self)
        dlg.setWindowTitle("Recovery phrase — write it down")
        dlg.setText("These 12 words restore every non-BLOCK account. Store them offline; "
                    "anyone with them owns these funds.")
        dlg.setDetailedText(mnemonic)
        dlg.exec()
        self._on_unlocked()

    def _on_unlocked(self):
        self.lock_lbl.setText("Vault unlocked for this session.")
        for b in (self.refresh_btn, self.phrase_btn, self.endpoints_btn,
                  self.networks_btn, self.send_btn, self.add_token_btn):
            b.setEnabled(True)
        self.unlock_btn.setText("Re-lock on exit")
        self._fill_accounts()
        self._refresh_balances()

    def _fill_accounts(self):
        reg = self.ctrl.registry
        chains = self.ctrl.ordered_chains()
        self.table.setRowCount(len(chains))
        self._rows = chains
        for r, cid in enumerate(chains):
            acct = self.ctrl.accounts.get(cid)
            addr = acct.address if acct else "—"
            # Custom networks are EVM — same secp256k1 scheme, never PQ.
            scheme = CHAIN_SCHEME.get(cid, "secp256k1")
            self.table.setItem(r, 0, QTableWidgetItem(self.ctrl.chain_label(cid)))
            self.table.setItem(r, 1, QTableWidgetItem(scheme))
            self.table.setItem(r, 2, QTableWidgetItem(addr or "—"))
            self.table.setItem(r, 3, QTableWidgetItem("…"))
            self.table.setItem(r, 4, QTableWidgetItem("PQ" if CHAIN_PQ.get(cid) else ""))

    def _refresh_balances(self):
        if not self.ctrl.is_unlocked():
            return
        reg = self.ctrl.registry
        for r, cid in enumerate(getattr(self, "_rows", [])):
            acct = self.ctrl.accounts.get(cid)
            addr = acct.address if acct else None

            def fetch(cid=cid, addr=addr):
                # native + known list + auto-detected held tokens (merged)
                return reg.all_balances(cid, addr)

            w = Worker(fetch)
            w.done.connect(lambda bals, r=r: self._show_balance(r, bals))
            w.failed.connect(lambda e, r=r: self.table.setItem(r, 3, QTableWidgetItem("err: " + e[:24])))
            self._workers.append(w)
            w.start()

    def _show_balance(self, r, bals):
        parts = []
        for b in bals:
            if getattr(b, "error", None):
                parts.append(f"{b.asset.symbol}: err")
            else:
                parts.append(f"{b.display} {b.asset.symbol}")
        self.table.setItem(r, 3, QTableWidgetItem("  ".join(parts) or "—"))

    def _send(self):
        reg = self.ctrl.registry
        chains = [c for c in getattr(self, "_rows", [])
                  if c != "block" and hasattr(reg.get(c), "build_send")]
        if not chains:
            QMessageBox.information(self, "Blockle",
                                    "Use the BLOCK Send tab for BLOCK; other chains appear once unlocked.")
            return
        dlg = SendDialog(self.ctrl, chains, self)
        dlg.exec()
        self._refresh_balances()

    def _add_token(self):
        chain, ok = QInputDialog.getItem(self, "Add ERC-20 token", "Chain:",
                                         EVM_CHAINS, 0, False)
        if not ok:
            return
        addr, ok = QInputDialog.getText(self, "Add ERC-20 token", "Contract address (0x…):")
        if not ok or not addr.strip():
            return
        sym, ok = QInputDialog.getText(self, "Add ERC-20 token", "Symbol:")
        if not ok or not sym.strip():
            return
        dec, ok = QInputDialog.getInt(self, "Add ERC-20 token", "Decimals:", 6, 0, 36)
        if not ok:
            return
        token = {"chain": chain, "kind": "erc20", "symbol": sym.strip(),
                 "decimals": dec, "address": addr.strip()}
        try:
            self.ctrl.vault.add_token(chain, token)
            # rebuild so the registry picks up the new token
            self.ctrl._build()
        except Exception as e:
            QMessageBox.critical(self, "Blockle", f"Could not add token:\n{e}")
            return
        self._fill_accounts()
        self._refresh_balances()

    def _show_phrase(self):
        if QMessageBox.warning(
            self, "Recovery phrase",
            "Anyone with these 12 words controls every non-BLOCK account. Reveal?",
            QMessageBox.Yes | QMessageBox.Cancel,
        ) != QMessageBox.Yes:
            return
        dlg = QMessageBox(self)
        dlg.setWindowTitle("Recovery phrase")
        dlg.setText("Store offline.")
        dlg.setDetailedText(self.ctrl.vault.mnemonic())
        dlg.exec()

    def _edit_endpoints(self):
        dlg = EndpointsDialog(self.ctrl, self)
        if dlg.exec() == QDialog.Accepted:
            self.ctrl._build()
            self._fill_accounts()
            self._refresh_balances()

    def _edit_custom_networks(self):
        dlg = CustomNetworksDialog(self.ctrl, self)
        dlg.exec()
        if dlg.changed:
            self.ctrl._build()
            self._fill_accounts()
            self._refresh_balances()


class SendDialog(QDialog):
    """Per-chain Send: build_send (fee + txid preview) -> confirm -> broadcast."""

    def __init__(self, ctrl: MultiChainController, chains: List[str], parent=None):
        super().__init__(parent)
        self.ctrl = ctrl
        self.built = None
        self.setWindowTitle("Send")
        self.resize(520, 320)
        lay = QVBoxLayout(self)
        form = QFormLayout()
        self.chain = QComboBox()
        self.chain.addItems([ctrl.chain_label(c) for c in chains])
        self._chains = chains
        self.chain.currentIndexChanged.connect(self._reload_assets)
        self.asset = QComboBox()
        self.to = QLineEdit()
        self.amount = QLineEdit()
        self.amount.setPlaceholderText("base units (integer)")
        form.addRow("Chain", self.chain)
        form.addRow("Asset", self.asset)
        form.addRow("To", self.to)
        form.addRow("Amount", self.amount)
        lay.addLayout(form)

        self.review = QPlainTextEdit()
        self.review.setReadOnly(True)
        self.review.setPlaceholderText("Press Build to review the fee + txid before broadcasting.")
        lay.addWidget(self.review, 1)

        btns = QHBoxLayout()
        self.build_btn = QPushButton("Build")
        self.build_btn.clicked.connect(self._build)
        self.send_btn = QPushButton("Confirm + broadcast")
        self.send_btn.setObjectName("primary")
        self.send_btn.setEnabled(False)
        self.send_btn.clicked.connect(self._broadcast)
        cancel = QPushButton("Close")
        cancel.clicked.connect(self.reject)
        btns.addWidget(self.build_btn)
        btns.addWidget(self.send_btn)
        btns.addStretch(1)
        btns.addWidget(cancel)
        lay.addLayout(btns)
        self._reload_assets()

    def _cur_chain(self):
        return self._chains[self.chain.currentIndex()]

    def _reload_assets(self):
        self.asset.clear()
        cid = self._cur_chain()
        self.asset.addItem(self.ctrl.chain_label(cid) + " (native)", None)
        for t in self.ctrl.registry.tokens_for(cid):
            self.asset.addItem(t.symbol, t)

    def _build(self):
        cid = self._cur_chain()
        acct = self.ctrl.accounts.get(cid)
        asset = self.asset.currentData()
        req = {"asset": asset, "to": self.to.text().strip(), "amount": self.amount.text().strip()}
        if not req["to"] or not req["amount"]:
            QMessageBox.warning(self, "Blockle", "Recipient and amount are required.")
            return

        def do():
            return self.ctrl.registry.get(cid).build_send(acct, req)

        self._w = Worker(do)
        self._w.done.connect(self._built)
        self._w.failed.connect(lambda e: QMessageBox.critical(self, "Blockle", f"Build failed:\n{e}"))
        self.review.setPlainText("building…")
        self._w.start()

    def _built(self, built):
        self.built = built
        sym = self.asset.currentText()
        self.review.setPlainText(json.dumps({
            "chain": built.chain, "asset": sym, "to": self.to.text().strip(),
            "amount": self.amount.text().strip(), "fee": built.fee, "txid": built.txid,
        }, indent=2))
        self.send_btn.setEnabled(True)

    def _broadcast(self):
        if not self.built:
            return
        cid = self._cur_chain()
        if QMessageBox.question(
            self, "Confirm broadcast",
            f"Broadcast this {self.ctrl.chain_label(cid)} transaction?\n"
            f"fee {self.built.fee}  txid {self.built.txid[:20]}…",
        ) != QMessageBox.Yes:
            return

        def do():
            return self.ctrl.registry.get(cid).broadcast(self.built)

        self._w2 = Worker(do)
        self._w2.done.connect(lambda res: (
            QMessageBox.information(self, "Blockle", f"Broadcast.\ntxid: {res.txid}"), self.accept()))
        self._w2.failed.connect(lambda e: QMessageBox.critical(self, "Blockle", f"Broadcast failed:\n{e}"))
        self.send_btn.setEnabled(False)
        self._w2.start()


class EndpointsDialog(QDialog):
    def __init__(self, ctrl: MultiChainController, parent=None):
        super().__init__(parent)
        self.ctrl = ctrl
        self.setWindowTitle("Chain endpoints")
        self.resize(640, 360)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("RPC / Esplora endpoints (blank = public default). "
                             "Dogecoin needs an Esplora URL to be usable."))
        self.fields: Dict[str, QLineEdit] = {}
        form = QFormLayout()
        eps = ctrl.vault.endpoints() if ctrl.is_unlocked() else {}
        for cid in ["ethereum", "base", "solana", "bitcoin", "litecoin", "dogecoin"]:
            f = QLineEdit()
            cur = (eps.get(cid) or {})
            f.setText(cur.get("rpcUrl") or cur.get("esplora") or "")
            self.fields[cid] = f
            form.addRow(CHAIN_LABELS.get(cid, cid), f)
        lay.addLayout(form)
        bb = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)

    def _save(self):
        for cid, f in self.fields.items():
            val = f.text().strip()
            if not val:
                continue
            key = "esplora" if cid in ("bitcoin", "litecoin", "dogecoin") else "rpcUrl"
            self.ctrl.vault.set_endpoint(cid, {key: val})
        self.accept()


class CustomNetworkForm(QDialog):
    """Add / edit ONE custom EVM network. Validates via
    ``normalize_custom_network`` and, on save, OPTIONALLY probes ``eth_chainId``
    to confirm the RPC matches the entered chainId — a non-blocking warning, not
    a gate."""

    FIELDS = [
        ("name", "Name", "My Rollup"),
        ("chainId", "Chain ID", "7777 (positive integer)"),
        ("rpcUrl", "RPC URL", "https://rpc.example.com"),
        ("nativeSymbol", "Native symbol", "ETH"),
        ("decimals", "Native decimals", "18 (default)"),
        ("explorerUrl", "Explorer URL (optional)", "https://scan.example.com"),
        ("tokenIndexerUrl", "Token indexer URL (optional)",
         "Alchemy-style URL for ERC-20 auto-detect"),
    ]

    def __init__(self, existing=None, parent=None):
        super().__init__(parent)
        self.result_net = None
        self.setWindowTitle("Custom network")
        self.resize(560, 360)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("Add an EVM network. It uses the same account/address "
                             "as the other EVM chains. URLs only — no secrets."))
        form = QFormLayout()
        self.fields: Dict[str, QLineEdit] = {}
        existing = existing or {}
        for key, label, ph in self.FIELDS:
            f = QLineEdit()
            f.setPlaceholderText(ph)
            val = existing.get(key)
            if val is not None:
                f.setText(str(val))
            self.fields[key] = f
            form.addRow(label, f)
        lay.addLayout(form)
        self.msg = QLabel("")
        self.msg.setObjectName("sub")
        self.msg.setWordWrap(True)
        lay.addWidget(self.msg)
        bb = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)

    def _raw(self):
        return {k: f.text().strip() for k, f in self.fields.items()}

    def _save(self):
        from .multichain.chains import normalize_custom_network, probe_chain_id
        try:
            net = normalize_custom_network(self._raw())
        except ValueError as e:
            QMessageBox.warning(self, "Invalid network", str(e))
            return
        # Non-blocking eth_chainId confirmation.
        try:
            seen = probe_chain_id(net["rpcUrl"])
            if seen != net["chainId"]:
                if QMessageBox.question(
                    self, "Chain ID mismatch",
                    f"The RPC reports chain ID {seen}, but you entered "
                    f"{net['chainId']}.\nSave anyway?",
                ) != QMessageBox.Yes:
                    return
        except Exception:
            pass  # probe is best-effort; offline/unreachable RPC must not block
        self.result_net = net
        self.accept()


class CustomNetworksDialog(QDialog):
    """List + Add / Edit / Remove user-added custom networks (persisted in the
    vault). ``changed`` tells the caller whether to rebuild the registry."""

    def __init__(self, ctrl: MultiChainController, parent=None):
        super().__init__(parent)
        self.ctrl = ctrl
        self.changed = False
        self.setWindowTitle("Custom networks")
        self.resize(560, 380)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("Your custom EVM networks. They merge with the built-ins; "
                             "a custom net sharing a built-in's chain ID overrides its RPC."))
        self.list = QListWidget()
        lay.addWidget(self.list, 1)
        row = QHBoxLayout()
        add_btn = QPushButton("Add…")
        add_btn.clicked.connect(self._add)
        edit_btn = QPushButton("Edit…")
        edit_btn.clicked.connect(self._edit)
        rm_btn = QPushButton("Remove")
        rm_btn.clicked.connect(self._remove)
        for b in (add_btn, edit_btn, rm_btn):
            row.addWidget(b)
        row.addStretch(1)
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.accept)
        row.addWidget(close_btn)
        lay.addLayout(row)
        self._reload()

    def _reload(self):
        self.list.clear()
        for net in self.ctrl.vault.custom_networks():
            label = f"{net.get('name')}  ·  chainId {net.get('chainId')}  ·  {net.get('rpcUrl')}"
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, net)
            self.list.addItem(item)

    def _selected(self):
        item = self.list.currentItem()
        return item.data(Qt.UserRole) if item else None

    def _add(self):
        dlg = CustomNetworkForm(parent=self)
        if dlg.exec() == QDialog.Accepted and dlg.result_net:
            try:
                self.ctrl.vault.add_custom_network(dlg.result_net)
            except ValueError as e:
                QMessageBox.warning(self, "Invalid network", str(e))
                return
            self.changed = True
            self._reload()

    def _edit(self):
        net = self._selected()
        if not net:
            return
        dlg = CustomNetworkForm(existing=net, parent=self)
        if dlg.exec() == QDialog.Accepted and dlg.result_net:
            # id may change if the name changed — drop the old record, add the new.
            self.ctrl.vault.remove_custom_network(net["id"])
            try:
                self.ctrl.vault.add_custom_network(dlg.result_net)
            except ValueError as e:
                QMessageBox.warning(self, "Invalid network", str(e))
                self._reload()
                return
            self.changed = True
            self._reload()

    def _remove(self):
        net = self._selected()
        if not net:
            return
        if QMessageBox.question(
            self, "Remove network", f"Remove '{net.get('name')}'?",
        ) != QMessageBox.Yes:
            return
        self.ctrl.vault.remove_custom_network(net["id"])
        self.changed = True
        self._reload()


# --------------------------------------------------------------------------
# EXCHANGE tab
# --------------------------------------------------------------------------


class ExchangeTab(QWidget):
    def __init__(self, ctrl: MultiChainController):
        super().__init__()
        self.ctrl = ctrl
        self._workers: List[Worker] = []
        lay = QVBoxLayout(self)

        top = QHBoxLayout()
        self.status = QLabel("Signed out — sign in with your BLOCK key.")
        self.status.setObjectName("sub")
        self.signin_btn = QPushButton("Sign in")
        self.signin_btn.setObjectName("primary")
        self.signin_btn.clicked.connect(self._sign_in)
        top.addWidget(self.status, 1)
        top.addWidget(self.signin_btn)
        lay.addLayout(top)

        grid = QGridLayout()
        self.markets = QListWidget()
        self.markets.currentTextChanged.connect(self._load_book)
        grid.addWidget(QLabel("Markets"), 0, 0)
        grid.addWidget(self.markets, 1, 0)
        self.book = QTableWidget(0, 3)
        self.book.setHorizontalHeaderLabels(["Side", "Price", "Amount"])
        self.book.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.book.setEditTriggers(QTableWidget.NoEditTriggers)
        self.book.verticalHeader().hide()
        grid.addWidget(QLabel("Order book"), 0, 1)
        grid.addWidget(self.book, 1, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 2)
        lay.addLayout(grid, 1)

        box = QGroupBox("Place order (signed locally with your BLOCK key)")
        f = QFormLayout(box)
        self.o_side = QComboBox(); self.o_side.addItems(["buy", "sell"])
        self.o_type = QComboBox(); self.o_type.addItems(["limit", "market"])
        self.o_amount = QLineEdit(); self.o_amount.setPlaceholderText("base units")
        self.o_price = QLineEdit(); self.o_price.setPlaceholderText("base units (quote per base)")
        f.addRow("Side", self.o_side)
        f.addRow("Type", self.o_type)
        f.addRow("Amount", self.o_amount)
        f.addRow("Price", self.o_price)
        obtns = QHBoxLayout()
        self.place_btn = QPushButton("Place order")
        self.place_btn.clicked.connect(self._place)
        self.cancel_btn = QPushButton("Cancel order by id…")
        self.cancel_btn.clicked.connect(self._cancel)
        self.buy_btn = QPushButton("Buy BLOCK (USDC/x402)…")
        self.buy_btn.clicked.connect(self._buy)
        self.sell_btn = QPushButton("Sell BLOCK…")
        self.sell_btn.clicked.connect(self._sell)
        for b in (self.place_btn, self.cancel_btn, self.buy_btn, self.sell_btn):
            obtns.addWidget(b)
        f.addRow(obtns)
        lay.addWidget(box)

        self._refresh_markets()

    def _ex(self):
        if not self.ctrl.exchange:
            raise RuntimeError("Unlock the multi-chain vault first (Accounts tab).")
        return self.ctrl.exchange

    def _run(self, fn, ok_cb=None, label="working…"):
        self.status.setText(label)
        w = Worker(fn)
        w.done.connect(lambda res: (ok_cb(res) if ok_cb else None,
                                    self.status.setText(self._status_text())))
        w.failed.connect(lambda e: (QMessageBox.critical(self, "Exchange", e),
                                    self.status.setText(self._status_text())))
        self._workers.append(w)
        w.start()

    def _status_text(self):
        try:
            ex = self._ex()
        except Exception:
            return "Unlock the vault to use the exchange."
        return f"Signed in as {ex.session_address()}" if ex.is_signed_in() else \
            "Signed out — sign in with your BLOCK key."

    def _sign_in(self):
        self._run(lambda: self._ex().sign_in(), lambda r: None, "signing in…")

    def _refresh_markets(self):
        try:
            ex = self._ex()
        except Exception:
            self.status.setText("Unlock the vault to use the exchange.")
            return
        self._run(ex.get_markets, self._fill_markets, "loading markets…")

    def _fill_markets(self, markets):
        self.markets.clear()
        for m in markets or []:
            self.markets.addItem(m.get("market") if isinstance(m, dict) else str(m))

    def _load_book(self, market):
        if not market:
            return
        self._run(lambda: self._ex().get_book(market), self._fill_book, f"loading {market}…")

    def _fill_book(self, book):
        book = book or {}
        asks = [("ask", lv) for lv in (book.get("asks") or [])]
        bids = [("bid", lv) for lv in (book.get("bids") or [])]
        rows = asks[::-1] + bids
        self.book.setRowCount(len(rows))
        for r, (side, lv) in enumerate(rows):
            self.book.setItem(r, 0, QTableWidgetItem(side))
            self.book.setItem(r, 1, QTableWidgetItem(str(lv.get("price"))))
            self.book.setItem(r, 2, QTableWidgetItem(str(lv.get("amount"))))

    def _place(self):
        market = self.markets.currentItem().text() if self.markets.currentItem() else None
        if not market:
            QMessageBox.warning(self, "Exchange", "Pick a market first.")
            return
        p = {"market": market, "side": self.o_side.currentText(),
             "type": self.o_type.currentText(), "amount": self.o_amount.text().strip(),
             "price": self.o_price.text().strip() or None}
        if not p["amount"]:
            QMessageBox.warning(self, "Exchange", "Amount is required.")
            return
        if QMessageBox.question(self, "Confirm order",
                                json.dumps(p, indent=2)) != QMessageBox.Yes:
            return
        self._run(lambda: self._ex().place_order(p),
                  lambda r: QMessageBox.information(self, "Exchange", f"Order: {r}"), "placing…")

    def _cancel(self):
        oid, ok = QInputDialog.getText(self, "Cancel order", "Order id:")
        if not ok or not oid.strip():
            return
        self._run(lambda: self._ex().cancel_order(oid.strip()),
                  lambda r: QMessageBox.information(self, "Exchange", f"Cancelled: {r}"), "cancelling…")

    def _buy(self):
        usdc, ok = QInputDialog.getText(self, "Buy BLOCK", "USDC to spend (base units, 6 dp):")
        if not ok or not usdc.strip():
            return
        self._run(lambda: self._ex().buy_block(usdc.strip()), self._buy_result, "buying…")

    def _buy_result(self, res):
        if res.get("paymentRequired"):
            dlg = QMessageBox(self)
            dlg.setWindowTitle("x402 payment required")
            dlg.setText("The seller returned an x402 challenge. Settle it from the Agent cockpit "
                        "or an EVM USDC transfer; no payment was fabricated.")
            dlg.setDetailedText(json.dumps(res.get("challenge"), indent=2, default=str))
            dlg.exec()
        else:
            QMessageBox.information(self, "Exchange", f"Receipt: {res.get('receipt')}")

    def _sell(self):
        amt, ok = QInputDialog.getText(self, "Sell BLOCK", "BLOCK amount (base units):")
        if not ok or not amt.strip():
            return
        addr, ok = QInputDialog.getText(self, "Sell BLOCK", "Base USDC payout address (0x…):")
        if not ok or not addr.strip():
            return
        if QMessageBox.question(
            self, "Confirm sell",
            f"Send {amt} base-unit BLOCK to the reserve and settle USDC to {addr}?",
        ) != QMessageBox.Yes:
            return
        self._run(lambda: self._ex().sell_block(amt.strip(), {"userUsdcAddr": addr.strip()}),
                  lambda r: QMessageBox.information(self, "Exchange", f"Sold: {r}"), "selling…")


# --------------------------------------------------------------------------
# AGENT cockpit tab
# --------------------------------------------------------------------------


class AgentTab(QWidget):
    # cross-thread marshalling: the agent runs on the AgentLoop thread, so UI
    # updates are delivered via (queued) signals, never touched directly.
    _log = Signal(str)
    _refresh = Signal(list)
    _warn = Signal(str)

    def __init__(self, ctrl: MultiChainController):
        super().__init__()
        self.ctrl = ctrl
        self.mgr = None
        self._run_futs = []
        self._log.connect(self._append)
        self._refresh.connect(self._fill_list)
        self._warn.connect(lambda m: QMessageBox.warning(self, "Agent", m))
        lay = QVBoxLayout(self)

        warn = QLabel("Safety rails are enforced in code: a per-session spend cap, a REQUIRED "
                      "human confirmation on every value-moving action, a tool allowlist, and a "
                      "kill switch. Value-moving channels refuse to start until caps are set.")
        warn.setObjectName("sub")
        warn.setWordWrap(True)
        lay.addWidget(warn)

        top = QHBoxLayout()
        self.connect_btn = QPushButton("Connect a provider…")
        self.connect_btn.setObjectName("primary")
        self.connect_btn.clicked.connect(self._connect_provider)
        self.new_ch_btn = QPushButton("New channel…")
        self.new_ch_btn.clicked.connect(self._new_channel)
        self.kill_btn = QPushButton("KILL ALL")
        self.kill_btn.setStyleSheet("QPushButton{background:#7a1f1f;color:white;border:none}")
        self.kill_btn.clicked.connect(self._kill_all)
        for b in (self.connect_btn, self.new_ch_btn):
            top.addWidget(b)
        top.addStretch(1)
        top.addWidget(self.kill_btn)
        lay.addLayout(top)

        grid = QGridLayout()
        self.ch_list = QListWidget()
        self.ch_list.currentRowChanged.connect(self._select_channel)
        grid.addWidget(QLabel("Channels (one isolated agent per wallet)"), 0, 0)
        grid.addWidget(self.ch_list, 1, 0)

        right = QVBoxLayout()
        self.ch_info = QLabel("No channel selected.")
        self.ch_info.setWordWrap(True)
        self.ch_info.setObjectName("sub")
        right.addWidget(self.ch_info)

        cbtns = QHBoxLayout()
        self.start_btn = QPushButton("Start")
        self.start_btn.clicked.connect(self._start_channel)
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.clicked.connect(self._stop_channel)
        self.caps_btn = QPushButton("Set caps…")
        self.caps_btn.clicked.connect(self._set_caps)
        self.kill_ch_btn = QPushButton("Kill channel")
        self.kill_ch_btn.clicked.connect(self._kill_channel)
        for b in (self.start_btn, self.stop_btn, self.caps_btn, self.kill_ch_btn):
            cbtns.addWidget(b)
        right.addLayout(cbtns)

        self.prompts = QComboBox()
        self.prompts.addItem("— predefined strategies —", None)
        for p in PREDEFINED_PROMPTS:
            self.prompts.addItem(p, p)
        self.prompts.currentIndexChanged.connect(self._use_prompt)
        right.addWidget(self.prompts)

        self.cmd = QLineEdit()
        self.cmd.setPlaceholderText("Message the agent (e.g. 'swap 10 BLOCK for USDC')")
        self.cmd.returnPressed.connect(self._send_cmd)
        send = QPushButton("Send")
        send.clicked.connect(self._send_cmd)
        crow = QHBoxLayout()
        crow.addWidget(self.cmd, 1)
        crow.addWidget(send)
        right.addLayout(crow)

        self.transcript = QPlainTextEdit()
        self.transcript.setReadOnly(True)
        right.addWidget(self.transcript, 1)

        rw = QWidget()
        rw.setLayout(right)
        grid.addWidget(rw, 1, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 2)
        lay.addLayout(grid, 1)

    # ---- manager lifecycle ----
    def _ensure_mgr(self):
        if not self.ctrl.is_unlocked():
            raise RuntimeError("Unlock the multi-chain vault first (Accounts tab).")
        if self.ctrl.confirm_bridge is None:
            self.ctrl.confirm_bridge = ConfirmBridge(self)
        if self.mgr is None:
            self.mgr = self.ctrl.channel_manager(on_event=self._on_event)
            fut = self.ctrl.loop.submit(self.mgr.load())
            fut.add_done_callback(lambda f: self._refresh_list())
        return self.mgr

    def _on_event(self, cid, ev):
        # called on the AgentLoop thread -> marshal to the UI via a queued signal
        self._log.emit(f"[{cid[:6]}] {ev.get('type')}: {json.dumps(ev, default=str)[:300]}")

    def _append(self, text):
        self.transcript.appendPlainText(text)
        sb = self.transcript.verticalScrollBar()
        sb.setValue(sb.maximum())

    # ---- providers ----
    def _connect_provider(self):
        try:
            self._ensure_mgr()
        except Exception as e:
            QMessageBox.warning(self, "Agent", str(e))
            return
        dlg = ProviderDialog(self)
        if dlg.exec() != QDialog.Accepted:
            return
        guide = dlg.selected_guide()
        api_key = dlg.api_key()
        if not api_key:
            QMessageBox.warning(self, "Agent", "An API key is required.")
            return
        ref = "cred:" + guide["provider"] + ":" + format(int(time.time()), "x")
        cred = {"provider": guide["provider"], "apiKey": api_key,
                "model": dlg.model() or guide.get("defaultModel"), "baseUrl": dlg.base_url() or None}
        self.ctrl.vault.set_credential(ref, cred)
        self._pending_cred_ref = ref
        self._pending_provider = guide["provider"]
        self._pending_model = cred["model"]
        self._pending_base = cred["baseUrl"]
        QMessageBox.information(self, "Agent",
                                f"{guide['label']} connected and sealed in the vault. "
                                "Create a channel to use it.")

    # ---- channels ----
    def _new_channel(self):
        try:
            mgr = self._ensure_mgr()
        except Exception as e:
            QMessageBox.warning(self, "Agent", str(e))
            return
        if not getattr(self, "_pending_cred_ref", None):
            QMessageBox.warning(self, "Agent", "Connect a provider first.")
            return
        label, ok = QInputDialog.getText(self, "New channel", "Channel name:")
        if not ok or not label.strip():
            return
        wallet_id = (self.ctrl.block_wallet.network if self.ctrl.block_wallet else "wallet")
        spec = {
            "label": label.strip(), "walletId": str(wallet_id),
            "provider": self._pending_provider, "model": self._pending_model,
            "baseUrl": self._pending_base, "credRef": self._pending_cred_ref,
        }
        fut = self.ctrl.loop.submit(mgr.create(spec))
        fut.add_done_callback(lambda f: self._refresh_list())

    def _refresh_list(self):
        if not self.mgr:
            return
        # may be called from the AgentLoop thread -> marshal via queued signal
        self._refresh.emit(self.mgr.list())

    def _fill_list(self, rows):
        self.ch_list.clear()
        self._rows = rows
        for ch in rows:
            state = "running" if ch["running"] else ("killed" if ch["killed"] else "stopped")
            it = QListWidgetItem(f"{ch['label']} — {ch['provider']} [{state}]")
            self.ch_list.addItem(it)

    def _current(self):
        i = self.ch_list.currentRow()
        rows = getattr(self, "_rows", [])
        if 0 <= i < len(rows):
            return rows[i]
        return None

    def _select_channel(self, _i):
        ch = self._current()
        if not ch:
            self.ch_info.setText("No channel selected.")
            return
        rem = ch.get("remaining")
        self.ch_info.setText(
            f"{ch['label']} · {ch['provider']}/{ch.get('model')} · "
            f"{'RUNNING' if ch['running'] else 'stopped'} · caps {json.dumps(ch.get('caps'))} · "
            f"P&L ${ch['pnl']['realizedUsd']} ({ch['pnl']['tradeCount']} trades) · "
            f"remaining {json.dumps(rem) if rem else '—'}")

    def _set_caps(self):
        ch = self._current()
        if not ch:
            return
        usd, ok = QInputDialog.getDouble(self, "Session cap",
                                         "Max USD this agent may spend per session:", 50, 0, 1e9, 2)
        if not ok:
            return
        block_cap, ok = QInputDialog.getText(
            self, "Per-asset cap",
            "Max BLOCK (base units) this agent may spend (blank = none):")
        if not ok:
            return
        caps = {"sessionUsd": usd, "perAsset": {}}
        if block_cap.strip():
            caps["perAsset"]["BLOCK"] = block_cap.strip()
        ch_obj = self.mgr.get(ch["id"])
        fut = self.ctrl.loop.submit(ch_obj.set_caps(caps))
        fut.add_done_callback(lambda f: self._refresh_list())

    def _start_channel(self):
        ch = self._current()
        if not ch:
            return
        fut = self.ctrl.loop.submit(self.mgr.start(ch["id"]))

        def done(f):
            try:
                f.result()
            except Exception as e:
                self._warn.emit(str(e))
            self._refresh_list()
        fut.add_done_callback(done)

    def _stop_channel(self):
        ch = self._current()
        if not ch:
            return
        fut = self.ctrl.loop.submit(self.mgr.stop(ch["id"]))
        fut.add_done_callback(lambda f: self._refresh_list())

    def _kill_channel(self):
        ch = self._current()
        if not ch:
            return
        ch_obj = self.mgr.get(ch["id"])
        fut = self.ctrl.loop.submit(ch_obj.kill("user"))
        fut.add_done_callback(lambda f: self._refresh_list())
        self._append(f"[{ch['id'][:6]}] killed by user")

    def _kill_all(self):
        if not self.mgr:
            return
        if QMessageBox.question(self, "Kill all",
                                "Stop and kill EVERY channel now?") != QMessageBox.Yes:
            return
        self.ctrl.loop.submit(self.mgr.kill_all("kill all"))
        self._append("KILL ALL requested")
        QTimer.singleShot(400, self._refresh_list)

    def _use_prompt(self, _i):
        p = self.prompts.currentData()
        if p:
            self.cmd.setText(p)

    def _send_cmd(self):
        ch = self._current()
        if not ch:
            QMessageBox.warning(self, "Agent", "Select a channel.")
            return
        if not ch["running"]:
            QMessageBox.warning(self, "Agent", "Start the channel first.")
            return
        text = self.cmd.text().strip()
        if not text:
            return
        self.cmd.clear()
        self._append(f"» {text}")
        ch_obj = self.mgr.get(ch["id"])
        fut = self.ctrl.loop.submit(ch_obj.run(text))

        def done(f):
            try:
                res = f.result()
                self._log.emit("agent: " + str((res or {}).get("text") or "(no text)"))
            except Exception as e:
                self._log.emit("error: " + str(e))
            self._refresh_list()
        fut.add_done_callback(done)


class ProviderDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Connect an AI provider")
        self.resize(560, 360)
        lay = QVBoxLayout(self)
        self.picker = QComboBox()
        self._keys = list(agentpkg.channels.PROVIDER_GUIDES.keys())
        for k in self._keys:
            self.picker.addItem(agentpkg.channels.PROVIDER_GUIDES[k]["label"], k)
        self.picker.currentIndexChanged.connect(self._reload)
        lay.addWidget(self.picker)

        self.guide = QLabel()
        self.guide.setWordWrap(True)
        self.guide.setObjectName("sub")
        self.guide.setTextInteractionFlags(Qt.TextBrowserInteraction)
        self.guide.setOpenExternalLinks(True)
        lay.addWidget(self.guide)

        form = QFormLayout()
        self.key = QLineEdit(); self.key.setEchoMode(QLineEdit.Password)
        self.model_f = QLineEdit()
        self.base_f = QLineEdit()
        self.base_f.setPlaceholderText("only for 'Other (OpenAI-compatible)'")
        form.addRow("API key", self.key)
        form.addRow("Model", self.model_f)
        form.addRow("Base URL", self.base_f)
        lay.addLayout(form)

        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)
        self._reload()

    def _reload(self):
        g = self.selected_guide()
        url = g.get("url")
        link = f' <a href="{url}">{url}</a>' if url else ""
        self.guide.setText(g.get("how", "") + link)
        self.model_f.setText(g.get("defaultModel") or "")

    def selected_guide(self):
        return agentpkg.channels.PROVIDER_GUIDES[self.picker.currentData()]

    def api_key(self):
        return self.key.text().strip()

    def model(self):
        return self.model_f.text().strip()

    def base_url(self):
        return self.base_f.text().strip()


# --------------------------------------------------------------------------
# entry point used by qtwallet
# --------------------------------------------------------------------------


def build_tabs(block_wallet, datadir) -> List:
    """Return ``[(widget, title), …]`` for the multi-chain / exchange / agent
    panels, sharing one :class:`MultiChainController`. Raises only if PySide6 or
    the multichain deps are unavailable (the caller guards the import)."""
    ctrl = MultiChainController(block_wallet, Path(datadir))
    tabs = [
        (AccountsTab(ctrl), "Accounts"),
        (ExchangeTab(ctrl), "Exchange"),
        (AgentTab(ctrl), "Agent"),
    ]
    return tabs
