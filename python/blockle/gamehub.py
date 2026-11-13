"""Blockle Game Hub — the desktop store/library/launcher engine.

A crypto-native desktop game store: browse a catalog, buy with crypto (90% to the
developer, vs Steam's 30% cut), and own your games and items as BLOCK-721 NFTs in
the same wallet. This module is the Steam-like *core* — download, verify, install,
launch, update, uninstall — kept entirely free of Qt so it can be unit-tested
headlessly and reused by any front-end.

Design notes
------------
* **Self-custody / honest gating.** Free games install and launch end-to-end here
  and now. Paid games require an on-chain purchase entitlement; until the purchase
  backend is live, :meth:`GameHub.can_install` returns ``(False, reason)`` for paid
  titles rather than pretending. No money path is faked.
* **It runs downloaded code**, so safety is not optional: every build is pinned to
  a SHA-256 in the catalog and verified before extraction, and archive extraction
  refuses path traversal and absolute members (no zip-slip).
* Injected ``download``/``fetch`` callables keep the whole thing testable without a
  network.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from urllib.request import urlopen

from ._binary import no_window_kwargs


# --------------------------------------------------------------------------- #
# Catalog model
# --------------------------------------------------------------------------- #
@dataclass
class Build:
    """A per-OS downloadable build."""

    url: str
    sha256: str
    size: int = 0
    entry: str = ""  # executable relative to the extracted root

    @staticmethod
    def from_json(d: dict) -> "Build":
        return Build(
            url=str(d.get("url", "")),
            sha256=str(d.get("sha256", "")).lower(),
            size=int(d.get("size", 0) or 0),
            entry=str(d.get("entry", "")),
        )


@dataclass
class Game:
    """A catalog entry."""

    id: str
    name: str
    version: str
    developer: str = ""
    chain: str = "blockle"
    description: str = ""
    icon_url: str = ""
    paid: bool = False
    price_block: float = 0.0
    payout_address: str = ""
    builds: Dict[str, Build] = field(default_factory=dict)  # "win"/"mac"/"linux"

    @staticmethod
    def from_json(d: dict) -> "Game":
        builds = {k: Build.from_json(v) for k, v in (d.get("builds") or {}).items()}
        return Game(
            id=str(d["id"]),
            name=str(d.get("name", d["id"])),
            version=str(d.get("version", "0.0.0")),
            developer=str(d.get("developer", "")),
            chain=str(d.get("chain", "blockle")),
            description=str(d.get("description", "")),
            icon_url=str(d.get("icon_url", "")),
            paid=bool(d.get("paid", False)),
            price_block=float(d.get("price_block", 0) or 0),
            payout_address=str(d.get("payout_address", "")),
            builds=builds,
        )

    def build_for(self, platform: str) -> Optional[Build]:
        return self.builds.get(platform)


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class GameHubError(Exception):
    pass


class VerificationError(GameHubError):
    pass


class UnsafeArchiveError(GameHubError):
    pass


# --------------------------------------------------------------------------- #
# Engine
# --------------------------------------------------------------------------- #
def current_platform() -> str:
    if sys.platform.startswith("win"):
        return "win"
    if sys.platform == "darwin":
        return "mac"
    return "linux"


ProgressCb = Callable[[str, float], None]  # (phase, fraction 0..1)


class GameHub:
    def __init__(
        self,
        datadir,
        *,
        download: Optional[Callable[[str, Path, Optional[ProgressCb]], None]] = None,
        fetch: Optional[Callable[[str], bytes]] = None,
        entitlement: Optional[Callable[[Game], Tuple[bool, str]]] = None,
    ):
        self.root = Path(datadir) / "gamehub"
        self.games_dir = self.root / "games"
        self.library_path = self.root / "library.json"
        self.games_dir.mkdir(parents=True, exist_ok=True)
        self._download = download or _http_download
        self._fetch = fetch or _http_fetch
        # Purchase entitlement check for paid games. Default: not yet available.
        self._entitlement = entitlement or (lambda g: (False, "crypto purchases are rolling out — this game isn't buyable yet"))

    # ---- catalog ---------------------------------------------------------- #
    def catalog(self, url: str) -> List[Game]:
        data = json.loads(self._fetch(url).decode("utf-8"))
        items = data.get("games", data) if isinstance(data, dict) else data
        out = []
        for d in items:
            try:
                out.append(Game.from_json(d))
            except Exception:
                continue
        return out

    # ---- library ---------------------------------------------------------- #
    def _library(self) -> dict:
        if self.library_path.exists():
            try:
                return json.loads(self.library_path.read_text("utf-8"))
            except Exception:
                return {}
        return {}

    def _save_library(self, lib: dict) -> None:
        tmp = self.library_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(lib, indent=2), "utf-8")
        tmp.replace(self.library_path)

    def installed(self) -> List[dict]:
        return list(self._library().values())

    def is_installed(self, game_id: str) -> bool:
        return game_id in self._library()

    def installed_version(self, game_id: str) -> Optional[str]:
        e = self._library().get(game_id)
        return e.get("version") if e else None

    def update_available(self, g: Game) -> bool:
        cur = self.installed_version(g.id)
        return cur is not None and _ver(g.version) > _ver(cur)

    # ---- gating ----------------------------------------------------------- #
    def can_install(self, g: Game) -> Tuple[bool, str]:
        """Free games: always installable. Paid games: need a purchase entitlement."""
        if current_platform() not in g.builds:
            return (False, f"no {current_platform()} build for this game")
        if not g.paid:
            return (True, "")
        return self._entitlement(g)

    # ---- install ---------------------------------------------------------- #
    def install(self, g: Game, progress: Optional[ProgressCb] = None) -> dict:
        ok, reason = self.can_install(g)
        if not ok:
            raise GameHubError(reason)

        build = g.build_for(current_platform())
        if build is None:
            raise GameHubError(f"no {current_platform()} build")
        if not build.sha256:
            raise VerificationError("catalog build has no sha256 — refusing to install unverifiable code")

        target = self.games_dir / _safe_id(g.id)
        with tempfile.TemporaryDirectory(prefix="blockle-dl-", dir=str(self.root)) as td:
            tdp = Path(td)
            archive = tdp / "build.bin"
            if progress:
                progress("download", 0.0)
            self._download(build.url, archive, progress)

            if progress:
                progress("verify", 0.0)
            digest = _sha256_file(archive)
            if digest != build.sha256:
                raise VerificationError(
                    f"sha256 mismatch for {g.id}: catalog {build.sha256[:16]}… got {digest[:16]}…"
                )

            if progress:
                progress("extract", 0.0)
            staging = tdp / "unpacked"
            staging.mkdir()
            _safe_extract(archive, staging)

            # Flatten a single wrapping directory (common: archive/<name>/…).
            root = _single_child_dir(staging) or staging

            # Replace any previous install atomically-ish.
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(root), str(target))

        entry = build.entry or _guess_entry(target)
        lib = self._library()
        lib[g.id] = {
            "id": g.id,
            "name": g.name,
            "version": g.version,
            "developer": g.developer,
            "install_dir": str(target),
            "entry": entry,
            "installed_at": int(time.time()),
            "size": _dir_size(target),
        }
        self._save_library(lib)
        if progress:
            progress("done", 1.0)
        return lib[g.id]

    # ---- launch ----------------------------------------------------------- #
    def launch(self, game_id: str):
        import subprocess

        e = self._library().get(game_id)
        if not e:
            raise GameHubError(f"{game_id} is not installed")
        install_dir = Path(e["install_dir"])
        entry = e.get("entry") or _guess_entry(install_dir)
        if not entry:
            raise GameHubError("could not find an entry point to launch")
        exe = (install_dir / entry).resolve()
        # Keep the launch inside the install dir (defense-in-depth).
        if install_dir.resolve() not in exe.parents and exe != install_dir.resolve():
            raise GameHubError("entry point escapes the install directory")
        if not exe.exists():
            raise GameHubError(f"entry not found: {entry}")

        if current_platform() != "win":
            try:
                exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            except OSError:
                pass

        if current_platform() == "mac" and exe.suffix == ".app":
            return subprocess.Popen(["open", str(exe)])
        return subprocess.Popen([str(exe)], cwd=str(install_dir), **no_window_kwargs())

    # ---- uninstall -------------------------------------------------------- #
    def uninstall(self, game_id: str) -> None:
        lib = self._library()
        e = lib.pop(game_id, None)
        if e:
            shutil.rmtree(e.get("install_dir", ""), ignore_errors=True)
            self._save_library(lib)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _http_fetch(url: str) -> bytes:
    with urlopen(url, timeout=30) as r:  # noqa: S310 (catalog over https)
        return r.read()


def _http_download(url: str, dest: Path, progress: Optional[ProgressCb]) -> None:
    with urlopen(url, timeout=60) as r:  # noqa: S310
        total = int(r.headers.get("content-length", 0) or 0)
        read = 0
        with open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                read += len(chunk)
                if progress and total:
                    progress("download", min(1.0, read / total))


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def _safe_extract(archive: Path, dest: Path) -> None:
    """Extract a .zip or .tar.gz, refusing absolute paths, ``..`` traversal and
    symlinks that escape ``dest`` (zip-slip / tar-slip)."""
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                p = dest / name
                if name.startswith("/") or ".." in Path(name).parts or not _is_within(dest, p):
                    raise UnsafeArchiveError(f"unsafe archive member: {name}")
            z.extractall(dest)
        return
    if tarfile.is_tarfile(archive):
        with tarfile.open(archive) as t:
            for m in t.getmembers():
                p = dest / m.name
                if m.name.startswith("/") or ".." in Path(m.name).parts or not _is_within(dest, p):
                    raise UnsafeArchiveError(f"unsafe archive member: {m.name}")
                if m.issym() or m.islnk():
                    link_target = dest / m.name
                    if not _is_within(dest, (link_target.parent / m.linkname)):
                        raise UnsafeArchiveError(f"unsafe link member: {m.name} -> {m.linkname}")
            t.extractall(dest)
        return
    raise UnsafeArchiveError("unknown archive format (expected .zip or .tar.gz)")


def _single_child_dir(path: Path) -> Optional[Path]:
    kids = [p for p in path.iterdir()]
    if len(kids) == 1 and kids[0].is_dir():
        return kids[0]
    return None


_ENTRY_HINTS = ("game", "start", "run", "launch", "main")


def _guess_entry(install_dir: Path) -> str:
    """Best-effort entry detection when the catalog didn't name one."""
    plat = current_platform()
    cands: List[Path] = []
    for p in sorted(install_dir.rglob("*")):
        if p.is_dir():
            if plat == "mac" and p.suffix == ".app":
                cands.append(p)
            continue
        name = p.name.lower()
        if plat == "win" and p.suffix.lower() == ".exe":
            cands.append(p)
        elif plat == "mac" and p.suffix in ("", ".command"):
            if os.access(p, os.X_OK) or any(h in name for h in _ENTRY_HINTS):
                cands.append(p)
        elif plat == "linux" and (os.access(p, os.X_OK) or p.suffix in (".x86_64", ".sh", "")):
            cands.append(p)
    if not cands:
        return ""
    # Prefer a name that hints it's the launcher, else the shallowest path.
    cands.sort(key=lambda p: (0 if any(h in p.name.lower() for h in _ENTRY_HINTS) else 1, len(p.parts)))
    return str(cands[0].relative_to(install_dir))


def _dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def _safe_id(game_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in game_id) or "game"


def _ver(v: str) -> tuple:
    parts = []
    for chunk in str(v).replace("-", ".").split("."):
        parts.append(int(chunk) if chunk.isdigit() else 0)
    return tuple(parts)
