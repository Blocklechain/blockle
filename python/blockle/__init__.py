"""Blockle — the universal deployment system for PoW mining pools.

Python wrapper around the Blockle core (Rust). The heavy lifting — chain
interrogation, stratum, share validation, merged mining, payouts — runs in
the core binary; this package provides a Pythonic interface, process
management, and clients for blockle.biz and pool dashboards.

Quick start::

    import blockle

    profile = blockle.inspect("http://127.0.0.1:8332")
    pool = blockle.add_chain("MyCoin", "http://127.0.0.1:8332")
    pool.add_aux("BLOCK", "http://127.0.0.1:18981/")
    pool.register("https://blockle.biz",
                  public_chain_rpc="http://mynode.example:8332")
    with pool.serve():
        print(pool.dashboard_stats())
"""

from ._binary import BinaryNotFound, find_binary, find_biz_binary
from .biz import BizClient
from .pool import Pool, add_chain, discover, init, inspect
from .runner import Process, biz_server, mine, simchain

__version__ = "0.1.0"

__all__ = [
    "BinaryNotFound",
    "BizClient",
    "Pool",
    "Process",
    "add_chain",
    "biz_server",
    "discover",
    "find_binary",
    "find_biz_binary",
    "init",
    "inspect",
    "mine",
    "simchain",
    "__version__",
]
