"""PyInstaller entry point for the Blockle desktop wallet.

POINTS AT `qtapp`, NOT `qtwallet`, AND THE DIFFERENCE IS THE WHOLE APP.

`blockle.qtapp.main` is the multi-chain wallet: Accounts, Exchange, Agent,
Bots, and the native BLOCK wallet as one tab among them.
`blockle.qtwallet.main` is only that last tab — the BLOCK-only window.

This file imported `qtwallet.main` after the production-server sync
(fde0c53d) rewrote that module, so every packaged desktop build — Windows,
macOS and Linux — started the BLOCK-only wallet, and none of the multichain
tabs existed for anyone who installed a download rather than running from
source. `test_launcher_points_at_full_app` asserts the identity below; it was
failing in CI, and because the Python suite gates the packaging step, that
failure was also why no bundle could be attached to a release.
"""
import sys

from blockle.qtapp import main

if __name__ == "__main__":
    sys.exit(main())
