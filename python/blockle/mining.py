"""Blockle in-wallet mining config.

Blockle is merge-mined: you point a miner for a supported algorithm at a Blockle pool and earn
BLOCK alongside the parent chain (AuxPoW), no extra power. This module maps each algorithm to its
live pool stratum endpoint and builds a standard (cpuminer/ccminer-style) launch command. The
wallet does NOT hash in-process (Python is far too slow for these algos); it orchestrates an
external miner binary the user points to.

Pure + import-safe so it can be unit-tested without Qt.
"""
from __future__ import annotations

POOL_HOST = "blockle.org"  # the Blockle pool host (144.126.133.21)

# algorithm -> parent chain + stratum ports (pplns/solo). status "live" = pool is up now.
ALGOS = [
    {"algo": "sha256d",    "parent": "Perbug",   "pplns": 3377, "solo": 3357, "status": "live",
     "miner": "cpuminer (CPU) or any SHA-256 ASIC"},
    {"algo": "scrypt",     "parent": "Dogecoin", "pplns": 3375, "solo": 3355, "status": "live",
     "miner": "cpuminer or a scrypt ASIC"},
    {"algo": "x11",        "parent": "Dash",     "pplns": 3376, "solo": 3356, "status": "live",
     "miner": "ccminer (GPU) or an X11 ASIC"},
    {"algo": "equihash",   "parent": "—", "pplns": None, "solo": None, "status": "soon", "miner": "miniZ / lolMiner"},
    {"algo": "blake2b",    "parent": "—", "pplns": None, "solo": None, "status": "soon", "miner": "SRBMiner-Multi"},
    {"algo": "blake2s",    "parent": "—", "pplns": None, "solo": None, "status": "soon", "miner": "SRBMiner-Multi"},
    {"algo": "blake3",     "parent": "—", "pplns": None, "solo": None, "status": "soon", "miner": "SRBMiner-Multi"},
    {"algo": "eaglesong",  "parent": "—", "pplns": None, "solo": None, "status": "soon", "miner": "SRBMiner-Multi"},
    {"algo": "kheavyhash", "parent": "—", "pplns": None, "solo": None, "status": "soon", "miner": "lolMiner (Kaspa)"},
]

ALGO_NAMES = [a["algo"] for a in ALGOS]


def get_algo(name: str) -> dict | None:
    name = (name or "").lower().strip()
    for a in ALGOS:
        if a["algo"] == name:
            return a
    return None


def is_live(name: str) -> bool:
    a = get_algo(name)
    return bool(a and a["status"] == "live" and a.get("pplns"))


def stratum_url(name: str, mode: str = "pplns") -> str | None:
    """stratum+tcp URL for the pool, or None if the algo has no live pool."""
    a = get_algo(name)
    if not a:
        return None
    port = a.get("solo") if mode == "solo" else a.get("pplns")
    if not port:
        return None
    return f"stratum+tcp://{POOL_HOST}:{port}"


def miner_command(miner_path: str, name: str, payout_address: str,
                  mode: str = "pplns", worker: str = "blockle") -> list[str] | None:
    """A standard stratum miner invocation (cpuminer/ccminer/SRBMiner conventions):
       <miner> -a <algo> -o <stratum> -u <BLOCK payout>.<worker> -p x
    Returns None if the algo isn't live or inputs are missing. The caller launches this via
    subprocess; the BLOCK payout address is the wallet's own receive address."""
    url = stratum_url(name, mode)
    if not url or not miner_path or not payout_address:
        return None
    user = f"{payout_address}.{worker}" if worker else payout_address
    return [miner_path, "-a", name, "-o", url, "-u", user, "-p", "x"]
