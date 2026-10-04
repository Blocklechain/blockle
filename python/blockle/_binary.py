"""Locate (or build) the Blockle core binary.

Resolution order:

1. ``BLOCKLE_BIN`` environment variable.
2. A binary bundled inside the wheel (``blockle/bin/blockle``) — present in
   platform wheels built by the release pipeline.
3. ``blockle-core``/``blockle`` on ``PATH`` (the Rust binary; the console
   script itself is excluded to avoid recursion).
4. A Cargo workspace next to this checkout (``target/release/blockle``),
   built on demand with ``cargo build --release`` if Cargo is available.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path


class BinaryNotFound(RuntimeError):
    pass


def _is_rust_core(path: str) -> bool:
    """The console script installed by pip is also called ``blockle``;
    make sure a PATH hit is the Rust core, not ourselves."""
    try:
        out = subprocess.run(
            [path, "--help"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "mining pool" in (out.stdout + out.stderr).lower()


def _workspace_root() -> Path | None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").exists() and (parent / "src" / "stratum.rs").exists():
            return parent
    return None


@lru_cache(maxsize=1)
def find_binary(name: str = "blockle") -> str:
    env = os.environ.get("BLOCKLE_BIN" if name == "blockle" else "BLOCKLE_BIZ_BIN")
    if env:
        if Path(env).exists():
            return env
        raise BinaryNotFound(f"BLOCKLE_BIN points to {env!r}, which does not exist")

    bundled = Path(__file__).parent / "bin" / name
    if bundled.exists():
        return str(bundled)

    for candidate in (f"{name}-core", name):
        hit = shutil.which(candidate)
        if hit and _is_rust_core(hit):
            return hit

    root = _workspace_root()
    if root is not None:
        built = root / "target" / "release" / name
        if not built.exists() and shutil.which("cargo"):
            print(
                f"[blockle] building the core from {root} (first run)…",
                file=sys.stderr,
            )
            subprocess.run(
                ["cargo", "build", "--release"], cwd=root, check=True
            )
        if built.exists():
            return str(built)

    raise BinaryNotFound(
        "Blockle core binary not found. Set BLOCKLE_BIN, put the Rust "
        "`blockle` binary on PATH, or install from a checkout with Cargo "
        "available."
    )


def find_biz_binary() -> str:
    return find_binary("blockle-biz")
