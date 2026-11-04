"""Headless wallet layer for the BLOCK chain.

Wraps the ``blockle-chain`` Rust binary: all keys, signing, consensus and
networking stay in Rust; this module provides binary resolution, the
machine-readable ``ui-snapshot``/``--json`` interface, and management of an
embedded node process so a wallet can sync from the P2P network. The Qt GUI
(:mod:`blockle.qtwallet`) is a thin view over this.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from ._binary import BinaryNotFound

UNITS_PER_BLOCK = 100_000_000


def format_block(units: int) -> str:
    sign = "-" if units < 0 else ""
    units = abs(units)
    whole, frac = divmod(units, UNITS_PER_BLOCK)
    if frac == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{str(frac).zfill(8).rstrip('0')}"


def _is_chain_binary(path: str) -> bool:
    try:
        out = subprocess.run([path, "--help"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "equihash" in (out.stdout + out.stderr).lower()


def _chain_workspace() -> Path | None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "chain"
        if (candidate / "Cargo.toml").exists() and (candidate / "crates" / "node").exists():
            return candidate
    return None


EXE = ".exe" if os.name == "nt" else ""


@lru_cache(maxsize=1)
def find_chain_binary() -> str:
    """Locate (or build) the ``blockle-chain`` binary.

    Order: ``BLOCKLE_CHAIN_BIN`` env var → bundled binary (wheel or
    PyInstaller app) → PATH → a ``chain/`` Cargo workspace next to this
    checkout (built on demand).
    """
    env = os.environ.get("BLOCKLE_CHAIN_BIN")
    if env:
        if Path(env).exists():
            return env
        raise BinaryNotFound(f"BLOCKLE_CHAIN_BIN points to {env!r}, which does not exist")

    candidates = [Path(__file__).parent / "bin" / f"blockle-chain{EXE}"]
    # PyInstaller bundles: next to the executable (onedir `_internal`
    # layout and onefile `_MEIPASS` extraction).
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent
        candidates += [
            exe_dir / "_internal" / "blockle" / "bin" / f"blockle-chain{EXE}",
            exe_dir / "blockle" / "bin" / f"blockle-chain{EXE}",
        ]
        if meipass := getattr(sys, "_MEIPASS", None):
            candidates.append(Path(meipass) / "blockle" / "bin" / f"blockle-chain{EXE}")
    for bundled in candidates:
        if bundled.exists():
            return str(bundled)

    hit = shutil.which(f"blockle-chain{EXE}") or shutil.which("blockle-chain")
    if hit and _is_chain_binary(hit):
        return hit

    root = _chain_workspace()
    if root is not None:
        built = root / "target" / "release" / f"blockle-chain{EXE}"
        if not built.exists() and shutil.which("cargo"):
            print(f"[blockle] building blockle-chain from {root} (first run)…", file=sys.stderr)
            subprocess.run(["cargo", "build", "--release"], cwd=root, check=True)
        if built.exists():
            return str(built)

    raise BinaryNotFound(
        "blockle-chain binary not found. Set BLOCKLE_CHAIN_BIN, put it on "
        "PATH, or install from a checkout with Cargo available."
    )


class WalletError(RuntimeError):
    pass


@dataclass
class ChainWallet:
    """A BLOCK wallet bound to a data directory.

    Every operation shells out to ``blockle-chain``; mutating calls pass
    ``--json`` and return the parsed result. When :attr:`node` is set (an
    embedded or remote node's P2P address), transactions are submitted
    through it instead of the local mempool file.
    """

    datadir: Path
    network: str = "mainnet"
    node: str | None = None
    #: Session passphrase for an encrypted wallet (never written to disk).
    passphrase: str | None = None

    def _run(self, *args: str, json_mode: bool = False, timeout: float = 600) -> str:
        cmd = [find_chain_binary(), "--datadir", str(self.datadir), "--network", self.network]
        if json_mode:
            cmd.append("--json")
        cmd += list(args)
        env = os.environ.copy()
        if self.passphrase:
            env["BLOCKLE_WALLET_PASSPHRASE"] = self.passphrase
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        if out.returncode != 0:
            msg = (out.stderr.strip() or out.stdout.strip()).splitlines()
            raise WalletError(msg[-1] if msg else f"blockle-chain {args[0]} failed")
        return out.stdout

    def _run_json(self, *args: str, **kw) -> dict:
        out = self._run(*args, json_mode=True, **kw)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("{"):
                return json.loads(line)
        raise WalletError(f"no JSON in blockle-chain output: {out!r}")

    # ---- wallet lifecycle ----

    def exists(self) -> bool:
        return (self.datadir / "wallet.json").exists()

    def create(self) -> None:
        """Generate keys (no-op if the wallet already exists)."""
        self._run("keygen")

    def has_chain(self) -> bool:
        return self.snapshot()["chain"]["height"] is not None

    def init_chain(self) -> None:
        """Create keys if needed and mine the genesis block (new chains and
        regtest; on an existing network the chain arrives via P2P sync)."""
        self._run("init")

    # ---- reads ----

    def snapshot(self) -> dict:
        """The full wallet + chain + history state as one dict."""
        out = self._run("ui-snapshot")
        for line in out.splitlines():
            if line.startswith("{"):
                return json.loads(line)
        raise WalletError(f"no JSON in ui-snapshot output: {out!r}")

    # ---- transparent ----

    def send(self, to: str, amount: str, fee: str = "0.0001") -> dict:
        args = ["send", "--to", to, "--amount", amount, "--fee", fee]
        if self.node:
            args += ["--node", self.node]
        return self._run_json(*args)

    # ---- shielded ----

    def shield(self, amount: str, fee: str = "0.0001") -> dict:
        args = ["shield", "--amount", amount, "--fee", fee]
        if self.node:
            args += ["--node", self.node]
        return self._run_json(*args)

    def unshield(self, note: int, to: str | None = None, fee: str = "0.0001") -> dict:
        args = ["unshield", "--note", str(note), "--fee", fee]
        if to:
            args += ["--to", to]
        if self.node:
            args += ["--node", self.node]
        return self._run_json(*args)

    def zsend(self, note: int, amount: str | None = None, to: str | None = None,
              fee: str = "0.0001") -> dict:
        args = ["zsend", "--note", str(note), "--fee", fee]
        if amount:
            args += ["--amount", amount]
        if to:
            args += ["--to", to]
        if self.node:
            args += ["--node", self.node]
        return self._run_json(*args)

    def note_import(self, voucher: str) -> None:
        self._run("note-import", voucher.strip())

    def scan(self) -> str:
        """Scan the chain for encrypted incoming notes; returns the report."""
        return self._run("scan")

    # ---- Bitcoin-Core-style wallet management ----

    def encrypt(self, passphrase: str) -> dict:
        """Encrypt the wallet (scrypt + ChaCha20-Poly1305 over the keys)."""
        old, self.passphrase = self.passphrase, passphrase
        try:
            return self._run_json("wallet", "encrypt")
        except WalletError:
            self.passphrase = old
            raise

    def decrypt_wallet(self) -> dict:
        """Remove encryption (requires :attr:`passphrase`)."""
        out = self._run_json("wallet", "decrypt")
        self.passphrase = None
        return out

    def change_passphrase(self, new_passphrase: str) -> dict:
        out = self._run_json("wallet", "change-passphrase", "--new-passphrase", new_passphrase)
        self.passphrase = new_passphrase
        return out

    def backup(self, out_path: str | Path) -> dict:
        return self._run_json("wallet", "backup", str(out_path))

    def export_keys(self) -> str:
        """Portable secret export (treat as cash)."""
        return self._run_json("wallet", "export")["export"]

    def import_keys(self, source: str, force: bool = False) -> dict:
        args = ["wallet", "import", source]
        if force:
            args.append("--force")
        return self._run_json(*args)

    def sign_message(self, message: str) -> dict:
        """Sign with the wallet key; returns {signature, address}."""
        return self._run_json("wallet", "sign-message", message)

    def verify_message(self, address: str, signature: str, message: str) -> bool:
        return bool(
            self._run_json("wallet", "verify-message", address, signature, message)["valid"]
        )

    # ---- regtest helpers ----

    def mine(self, blocks: int = 1) -> str:
        return self._run("mine", "--blocks", str(blocks))


@dataclass
class NodeProcess:
    """An embedded ``blockle-chain start`` process: listens for peers,
    connects out, syncs, gossips — the wallet's link to the network."""

    datadir: Path
    network: str = "mainnet"
    listen: str = "127.0.0.1:18444"
    peers: list[str] = field(default_factory=list)
    mine: bool = False
    proc: subprocess.Popen | None = None
    _log: list[str] = field(default_factory=list)
    _log_lock: threading.Lock = field(default_factory=threading.Lock)

    def start(self) -> None:
        if self.running:
            return
        cmd = [
            find_chain_binary(), "--datadir", str(self.datadir),
            "--network", self.network, "start", "--listen", self.listen,
        ]
        for p in self.peers:
            if p.strip():
                cmd += ["--connect", p.strip()]
        if self.mine:
            cmd.append("--mine")
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            with self._log_lock:
                self._log.append(line.rstrip())
                del self._log[:-500]

    def log_tail(self, n: int = 200) -> list[str]:
        with self._log_lock:
            return self._log[-n:]

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def p2p_address(self) -> str:
        return self.listen

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc = None
