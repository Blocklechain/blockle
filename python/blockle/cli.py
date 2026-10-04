"""Console entry point: ``blockle`` delegates to the Rust core, so the CLI
documented everywhere (`blockle add-chain`, `blockle init`, `blockle
serve`, …) works identically after ``pip install blockle``."""

from __future__ import annotations

import os
import subprocess
import sys

from ._binary import BinaryNotFound, find_binary


def main() -> int:
    try:
        binary = find_binary()
    except BinaryNotFound as e:
        print(f"blockle: {e}", file=sys.stderr)
        return 1
    argv = [binary, *sys.argv[1:]]
    if hasattr(os, "execv"):
        os.execv(binary, argv)  # replaces this process; does not return
    return subprocess.call(argv)


if __name__ == "__main__":
    raise SystemExit(main())
