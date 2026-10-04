"""Process management for Blockle components: pools, simulated chains, and
the blockle.biz server — each a real subprocess with clean teardown."""

from __future__ import annotations

import socket
import subprocess
import time
from pathlib import Path

from ._binary import find_binary, find_biz_binary


class Process:
    """A managed Blockle subprocess. Use as a context manager, or call
    ``stop()`` explicitly."""

    def __init__(self, args: list[str], ready_port: int | None = None, timeout: float = 15.0):
        self.args = args
        self.proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        if ready_port is not None:
            wait_for_port(ready_port, timeout=timeout, proc=self.proc)

    def stop(self) -> str:
        """Terminate and return captured output."""
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        return self.proc.stdout.read() if self.proc.stdout else ""

    @property
    def running(self) -> bool:
        return self.proc.poll() is None

    def __enter__(self) -> "Process":
        return self

    def __exit__(self, *exc) -> None:
        self.stop()


def wait_for_port(port: int, host: str = "127.0.0.1", timeout: float = 15.0, proc=None) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            out = proc.stdout.read() if proc.stdout else ""
            raise RuntimeError(f"process exited during startup:\n{out}")
        try:
            with socket.create_connection((host, port), timeout=1):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"{host}:{port} did not come up within {timeout}s")


def simchain(port: int = 18980, name: str = "SimCoin") -> Process:
    """Launch a built-in simulated PoW chain (bitcoind-style RPC)."""
    return Process(
        [find_binary(), "simchain", "--listen", f"127.0.0.1:{port}", "--name", name],
        ready_port=port,
    )


def biz_server(
    port: int = 8900,
    data: str | Path = "blockle-biz-registry.json",
    monitor_interval: int = 30,
) -> Process:
    """Launch a blockle.biz directory/monitoring server.

    """
    args = [
        find_biz_binary(),
        "--listen",
        f"127.0.0.1:{port}",
        "--data",
        str(data),
        "--monitor-interval",
        str(monitor_interval),
    ]
    return Process(args, ready_port=port)


def mine(stratum: str, worker: str = "worker1", shares: int = 3, timeout: int = 120) -> dict:
    """Run the built-in CPU miner against a stratum endpoint (blocking)."""
    out = subprocess.run(
        [
            find_binary(),
            "mine",
            "--stratum",
            stratum,
            "--worker",
            worker,
            "--shares",
            str(shares),
            "--timeout-secs",
            str(timeout),
        ],
        capture_output=True,
        text=True,
        timeout=timeout + 30,
    )
    if out.returncode != 0:
        raise RuntimeError(f"miner failed: {out.stdout}{out.stderr}")
    # "mining done: N accepted, M rejected"
    words = out.stdout.split()
    return {
        "accepted": int(words[2]),
        "rejected": int(words[4]),
    }
