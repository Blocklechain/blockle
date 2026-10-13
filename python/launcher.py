"""PyInstaller entry point for the Blockle desktop wallet.

Launches the FULL multi-chain app (:func:`blockle.qtapp.main`) — the native
BLOCK wallet PLUS the Accounts / Exchange / Agent / Bots / Wallet panels — not
the legacy BLOCK-only :func:`blockle.qtwallet.main`.
"""
import sys

from blockle.qtapp import main

if __name__ == "__main__":
    sys.exit(main())
