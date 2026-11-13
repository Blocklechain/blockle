"""Headless end-to-end tests for the Game Hub engine (no Qt, no network)."""

import io
import json
import os
import tarfile
import tempfile
import zipfile
from pathlib import Path

from blockle.gamehub import (
    Game,
    GameHub,
    GameHubError,
    UnsafeArchiveError,
    VerificationError,
    _sha256_file,
    current_platform,
)


def _make_tar_gz(dest: Path, files: dict):
    with tarfile.open(dest, "w:gz") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            t.addfile(info, io.BytesIO(data))


def _entry_name():
    return {"win": "game.exe", "mac": "game.command", "linux": "game.sh"}[current_platform()]


def _launch_script():
    # A no-op "game" that exits 0.
    if current_platform() == "win":
        return b"@echo off\r\nexit /b 0\r\n"
    return b"#!/bin/sh\nexit 0\n"


def _hub_with(tmp, builds_bytes: bytes):
    """A GameHub whose downloader serves `builds_bytes` and whose entitlement
    grants paid games (so we can test the paid path too)."""
    def dl(url, dest, progress):
        Path(dest).write_bytes(builds_bytes)
    return GameHub(tmp, download=dl, entitlement=lambda g: (True, ""))


def test_install_launch_uninstall(tmp):
    entry = _entry_name()
    archive = tmp / "build.tar.gz"
    _make_tar_gz(archive, {f"mygame/{entry}": _launch_script(), "mygame/data.txt": b"hi"})
    blob = archive.read_bytes()
    sha = _sha256_file(archive)

    hub = _hub_with(tmp, blob)
    from blockle.gamehub import Build
    g = Game(
        id="com.dev.mygame", name="My Game", version="1.0.0", developer="Dev",
        builds={current_platform(): Build(url="http://x/build", sha256=sha, entry=entry)},
    )

    assert hub.can_install(g)[0]
    rec = hub.install(g)
    assert hub.is_installed("com.dev.mygame")
    assert Path(rec["install_dir"]).exists()
    # entry flattened (the wrapping "mygame/" dir was collapsed)
    assert (Path(rec["install_dir"]) / entry).exists()

    proc = hub.launch("com.dev.mygame")
    proc.wait(timeout=10)
    assert proc.returncode == 0

    hub.uninstall("com.dev.mygame")
    assert not hub.is_installed("com.dev.mygame")
    assert not Path(rec["install_dir"]).exists()
    print("PASS install/launch/uninstall")


def test_sha_mismatch_rejected(tmp):
    entry = _entry_name()
    archive = tmp / "b.tar.gz"
    _make_tar_gz(archive, {f"g/{entry}": _launch_script()})
    hub = _hub_with(tmp, archive.read_bytes())
    from blockle.gamehub import Build
    g = Game(id="g", name="g", version="1.0.0",
             builds={current_platform(): Build(url="http://x", sha256="deadbeef" * 8, entry=entry)})
    try:
        hub.install(g)
        raise AssertionError("expected VerificationError")
    except VerificationError:
        print("PASS sha256 mismatch rejected")


def test_zip_slip_rejected(tmp):
    # A malicious zip trying to escape via ../
    archive = tmp / "evil.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("../escape.txt", "pwned")
    blob = archive.read_bytes()
    sha = _sha256_file(archive)
    hub = _hub_with(tmp, blob)
    from blockle.gamehub import Build
    g = Game(id="evil", name="evil", version="1.0.0",
             builds={current_platform(): Build(url="http://x", sha256=sha, entry="x")})
    try:
        hub.install(g)
        raise AssertionError("expected UnsafeArchiveError")
    except UnsafeArchiveError:
        print("PASS zip-slip rejected")


def test_paid_gating_default(tmp):
    from blockle.gamehub import Build
    # Default hub (no entitlement override) must refuse a paid game.
    hub = GameHub(tmp)
    g = Game(id="paid", name="Paid", version="1.0.0", paid=True, price_block=100.0,
             builds={current_platform(): Build(url="http://x", sha256="a" * 64, entry="x")})
    ok, reason = hub.can_install(g)
    assert not ok and "rolling out" in reason
    # A free game with a build is installable (gating only blocks paid).
    gf = Game(id="free", name="Free", version="1.0.0", paid=False,
              builds={current_platform(): Build(url="http://x", sha256="a" * 64, entry="x")})
    assert hub.can_install(gf)[0]
    print("PASS paid gating (free ok, paid blocked until purchase backend live)")


def test_update_detection(tmp):
    from blockle.gamehub import Build
    entry = _entry_name()
    archive = tmp / "v1.tar.gz"
    _make_tar_gz(archive, {f"g/{entry}": _launch_script()})
    sha = _sha256_file(archive)
    hub = _hub_with(tmp, archive.read_bytes())
    g1 = Game(id="g", name="g", version="1.0.0",
              builds={current_platform(): Build(url="http://x", sha256=sha, entry=entry)})
    hub.install(g1)
    g2 = Game(id="g", name="g", version="1.2.0",
              builds={current_platform(): Build(url="http://x", sha256=sha, entry=entry)})
    assert hub.update_available(g2)
    assert not hub.update_available(g1)
    print("PASS update detection")


def test_catalog_parse(tmp):
    hub = GameHub(tmp, fetch=lambda url: json.dumps({"games": [
        {"id": "a", "name": "A", "version": "1.0.0", "builds": {"win": {"url": "u", "sha256": "s"}}},
        {"id": "b", "name": "B", "version": "2.0.0", "paid": True, "price_block": 50},
    ]}).encode())
    games = hub.catalog("http://x/catalog.json")
    assert len(games) == 2 and games[1].paid and games[1].price_block == 50
    print("PASS catalog parse")


if __name__ == "__main__":
    for fn in [test_install_launch_uninstall, test_sha_mismatch_rejected, test_zip_slip_rejected,
               test_paid_gating_default, test_update_detection, test_catalog_parse]:
        with tempfile.TemporaryDirectory() as d:
            fn(Path(d))
    print("\nALL GAMEHUB TESTS PASSED")
