"""Client for the blockle.biz directory and monitoring API."""

from __future__ import annotations

import json
import urllib.request


class BizClient:
    def __init__(self, url: str = "https://blockle.biz", timeout: float = 10.0):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str) -> dict:
        with urllib.request.urlopen(f"{self.url}{path}", timeout=self.timeout) as r:
            return json.load(r)

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            f"{self.url}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.load(r)

    # -- public API --
    def health(self) -> dict:
        return self._get("/api/health")

    def stats(self) -> dict:
        return self._get("/api/stats")

    def pools(self) -> list[dict]:
        return self._get("/api/pools")["pools"]

    def pool(self, pool_id: str) -> dict:
        return self._get(f"/api/pools/{pool_id}")

    def chains(self) -> list[dict]:
        return self._get("/api/chains")["chains"]

    def chain(self, name: str) -> dict:
        return self._get(f"/api/chains/{name}")

    def pob(self) -> dict:
        """Proof-of-Blocks state: whitelist, totals, claims."""
        return self._get("/api/pob")

    def settlement_batch(self) -> dict:
        """Credited BLOCK grouped per epoch and payout address."""
        return self._get("/api/pob/settlement-batch")

    # -- registration (normally done via `blockle register`; exposed for
    #    external pools that run no Blockle software at all) --
    def register_external(
        self,
        name: str,
        chain: str,
        stratum: str,
        chain_rpc: str,
        coinbase_tag: str,
        payout_address: str = "",
        algorithm: str = "unknown",
        pool_fee: float = 0.0,
        website: str = "",
    ) -> dict:
        """Register an existing (non-Blockle) pool. blockle.biz watches the
        chain itself and attributes blocks by coinbase signature — no
        infrastructure change required on the pool's side."""
        return self._post(
            "/api/register",
            {
                "name": name,
                "chain": chain,
                "algorithm": algorithm,
                "stratum": stratum,
                "pool_fee": pool_fee,
                "website": website,
                "external": True,
                "chain_rpc": chain_rpc,
                "coinbase_tag": coinbase_tag,
                "payout_address": payout_address,
            },
        )

    def heartbeat(self, pool_id: str, token: str, **stats) -> dict:
        payload = {"pool_id": pool_id, "token": token, **stats}
        return self._post("/api/heartbeat", payload)
