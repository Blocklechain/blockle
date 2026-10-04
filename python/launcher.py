"""PyInstaller entry point for the Blockle Qt wallet."""
import sys

from blockle.qtwallet import main

if __name__ == "__main__":
    sys.exit(main())
