"""Pool lifecycle: interrogate chains, generate configs, serve, register."""

from __future__ import annotations

import json
import subprocess
import tomllib
import urllib.request
from pathlib import Path

from ._binary import find_binary
from .runner import Process, wait_for_port


def _run(args: list[str], timeout: int = 120) -> str:
    out = subprocess.run(
        [find_binary(), *args], capture_output=True, text=True, timeout=timeout
    )
    if out.returncode != 0:
        raise RuntimeError(f"blockle {' '.join(args)} failed:\n{out.stdout}{out.stderr}")
    return out.stdout


def inspect(rpc: str) -> dict:
    """Interrogate a chain's RPC; returns the full ChainProfile as a dict
    (dialect, algorithm + evidence, field map, confidence, unknowns…)."""
    return json.loads(_run(["inspect", "--rpc", rpc, "--json"]))


def discover(source: str) -> str:
    """Scan a chain's source repository (git URL or local path)."""
    return _run(["discover", source], timeout=600)


def init(source: str, out: str | Path = "pool.toml") -> str:
    """`blockle init`: chain source in, pool (or scaffold) out."""
    return _run(["init", source, "--out", str(out)], timeout=600)


def add_chain(
    name: str,
    rpc: str,
    config: str | Path = "pool.toml",
    stratum: str = "0.0.0.0:3333",
    dashboard: str = "127.0.0.1:8080",
    scheme: str = "pplns",
    fee: float = 1.0,
    payout_script: str | None = None,
) -> "Pool":
    """Interrogate `rpc` and generate a pool configuration. Raises if the
    chain cannot be driven by a built-in adapter."""
    args = [
        "add-chain",
        "--name", name,
        "--rpc", rpc,
        "--out", str(config),
        "--stratum", stratum,
        "--dashboard", dashboard,
        "--scheme", scheme,
        "--fee", str(fee),
    ]
    if payout_script:
        args += ["--payout-script", payout_script]
    _run(args)
    return Pool(config)


class Pool:
    """A generated pool configuration and its running process."""

    def __init__(self, config_path: str | Path):
        self.config_path = Path(config_path)
        if not self.config_path.exists():
            raise FileNotFoundError(self.config_path)

    @property
    def config(self) -> dict:
        return tomllib.loads(self.config_path.read_text())

    @property
    def stratum(self) -> str:
        return self.config["pool"]["stratum"]

    @property
    def dashboard(self) -> str:
        return self.config["pool"]["dashboard"]

    def set_heartbeat_secs(self, secs: int) -> None:
        text = self.config_path.read_text().replace(
            "heartbeat_secs = 60", f"heartbeat_secs = {secs}"
        )
        self.config_path.write_text(text)

    def add_aux(self, name: str, rpc: str, chain_id: int = 1) -> None:
        """Merge-mine an auxiliary chain (AuxPoW)."""
        with self.config_path.open("a") as f:
            f.write(
                f'\n[[chain.aux]]\nname = "{name}"\nrpc = "{rpc}"\nchain_id = {chain_id}\n'
            )

    def register(
        self,
        biz: str,
        public_stratum: str | None = None,
        public_chain_rpc: str | None = None,
        payout_address: str | None = None,
        aux_chain_rpcs: dict[str, str] | None = None,
        website: str | None = None,
        location: str | None = None,
    ) -> str:
        """Register with blockle.biz; the pairing token is stored in the
        config and `serve()` heartbeats automatically."""
        args = ["register", "--config", str(self.config_path), "--biz", biz]
        if public_stratum:
            args += ["--public-stratum", public_stratum]
        if public_chain_rpc:
            args += ["--public-chain-rpc", public_chain_rpc]
        if payout_address:
            args += ["--payout-address", payout_address]
        for chain, url in (aux_chain_rpcs or {}).items():
            args += ["--aux-chain-rpc", f"{chain}={url}"]
        if website:
            args += ["--website", website]
        if location:
            args += ["--location", location]
        return _run(args)

    def serve(self, ready_timeout: float = 20.0) -> Process:
        """Run the pool (stratum + dashboard + heartbeats). Returns a
        managed Process; use as a context manager."""
        port = int(self.stratum.rsplit(":", 1)[1])
        proc = Process(
            [find_binary(), "serve", str(self.config_path)], ready_port=None
        )
        wait_for_port(port, timeout=ready_timeout, proc=proc.proc)
        return proc

    def dashboard_stats(self) -> dict:
        host = self.dashboard
        with urllib.request.urlopen(f"http://{host}/stats.json", timeout=5) as r:
            return json.load(r)

    def payouts(self) -> dict:
        host = self.dashboard
        with urllib.request.urlopen(f"http://{host}/payouts.json", timeout=5) as r:
            return json.load(r)
