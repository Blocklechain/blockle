"""The ChainRegistry: one ChainAdapter per ChainId, built from user config
(endpoints + enabled chains + imported tokens).

Python mirror of ``blockle-extension/chains/registry.js``. The UI, the exchange
layer and the AI agent talk to adapters only — never to a chain's RPC directly.
Endpoints are CONFIG, resolved with sane public defaults; no secret is ever
hardcoded here.
"""

from __future__ import annotations

from .chain_adapter import AssetRef, as_seed
from .evm import create_evm_adapter
from .solana import create_solana_adapter
from .utxo import create_utxo_adapter

try:  # BLOCK wrapper needs a ChainWallet; optional when none is wired in.
    from .block import create_block_adapter
except Exception:  # pragma: no cover
    create_block_adapter = None

DEFAULT_ENDPOINTS = {
    "ethereum": {"rpcUrl": "https://ethereum-rpc.publicnode.com", "chainId": 1},
    "base":     {"rpcUrl": "https://base-rpc.publicnode.com", "chainId": 8453},
    "solana":   {"rpcUrl": "https://api.mainnet-beta.solana.com"},
    "bitcoin":  {"esplora": "https://blockstream.info/api"},
    "litecoin": {"esplora": "https://litecoinspace.org/api"},
    "dogecoin": {"esplora": None},  # user must supply (no public Esplora default)
}

DEFAULT_TOKENS = {
    "ethereum": [
        AssetRef(chain="ethereum", kind="erc20", symbol="USDC", decimals=6, address="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        AssetRef(chain="ethereum", kind="erc20", symbol="USDT", decimals=6, address="0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    ],
    "base": [
        AssetRef(chain="base", kind="erc20", symbol="USDC", decimals=6, address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    ],
}

DEFAULT_ENABLED = ["block", "ethereum", "base", "solana", "bitcoin", "litecoin", "dogecoin"]


class ChainRegistry:
    def __init__(self, config=None):
        config = config or {}
        endpoints = {**DEFAULT_ENDPOINTS, **(config.get("endpoints") or {})}
        self._endpoints = endpoints
        self._tokens = {**DEFAULT_TOKENS, **(config.get("tokens") or {})}
        enabled = set(config.get("enabled") or DEFAULT_ENABLED)
        enabled.add("block")  # BLOCK is always enabled
        self._enabled = enabled

        a = {}
        a["ethereum"] = create_evm_adapter(id="ethereum", chainId=endpoints["ethereum"].get("chainId", 1),
                                           symbol="ETH", rpcUrl=endpoints["ethereum"].get("rpcUrl"),
                                           rpc=endpoints["ethereum"].get("rpc"),
                                           explorer="https://etherscan.io/tx/")
        a["base"] = create_evm_adapter(id="base", chainId=endpoints["base"].get("chainId", 8453),
                                       symbol="ETH", rpcUrl=endpoints["base"].get("rpcUrl"),
                                       rpc=endpoints["base"].get("rpc"),
                                       explorer="https://basescan.org/tx/")
        a["solana"] = create_solana_adapter(rpcUrl=endpoints["solana"].get("rpcUrl"),
                                            rpc=endpoints["solana"].get("rpc"))
        a["bitcoin"] = create_utxo_adapter("bitcoin", esplora=endpoints["bitcoin"].get("esplora"),
                                           http_get=endpoints["bitcoin"].get("http_get"),
                                           http_post=endpoints["bitcoin"].get("http_post"))
        a["litecoin"] = create_utxo_adapter("litecoin", esplora=endpoints["litecoin"].get("esplora"),
                                            http_get=endpoints["litecoin"].get("http_get"),
                                            http_post=endpoints["litecoin"].get("http_post"))
        a["dogecoin"] = create_utxo_adapter("dogecoin", esplora=endpoints["dogecoin"].get("esplora"),
                                            http_get=endpoints["dogecoin"].get("http_get"),
                                            http_post=endpoints["dogecoin"].get("http_post"))
        block_cfg = config.get("block") or {}
        wallet = block_cfg.get("wallet")
        if create_block_adapter and wallet is not None:
            a["block"] = create_block_adapter(**block_cfg)
        self._adapters = a

    def get(self, id):
        a = self._adapters.get(id)
        if not a:
            raise KeyError("no adapter for chain: " + id)
        return a

    def has(self, id):
        return id in self._adapters

    def enabled(self):
        return [i for i in self._enabled if i in self._adapters]

    def endpoints(self, id):
        return self._endpoints.get(id)

    def tokens_for(self, id):
        return self._tokens.get(id, [])

    def unlock(self, root):
        seed = as_seed(root)
        for a in self._adapters.values():
            if hasattr(a, "unlock"):
                a.unlock(seed)

    def lock(self):
        for a in self._adapters.values():
            if hasattr(a, "lock"):
                a.lock()

    @property
    def adapters(self):
        return self._adapters


def create_registry(config=None) -> ChainRegistry:
    return ChainRegistry(config)
