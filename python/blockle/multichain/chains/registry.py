"""The ChainRegistry: one ChainAdapter per ChainId, built from user config
(endpoints + enabled chains + imported tokens).

Python mirror of ``blockle-extension/chains/registry.js``. The UI, the exchange
layer and the AI agent talk to adapters only — never to a chain's RPC directly.
Endpoints are CONFIG, resolved with sane public defaults; no secret is ever
hardcoded here.
"""

from __future__ import annotations

from .chain_adapter import AssetRef, as_seed, default_json_rpc
from .discovery import merge_balances
from .evm import create_evm_adapter
from .solana import create_solana_adapter
from .utxo import create_utxo_adapter

try:  # BLOCK wrapper needs a ChainWallet; optional when none is wired in.
    from .block import create_block_adapter
except Exception:  # pragma: no cover
    create_block_adapter = None

#: Every major EVM network — ALL driven by the SAME EVM adapter and the SAME
#: secp256k1 account (one address across every EVM chain; m/44'/60'). Native
#: symbol per chain (ETH/ETH/ETH/ETH/POL/BNB/AVAX); each entry is config.
EVM_NETWORKS = {
    "ethereum":  {"chainId": 1,     "symbol": "ETH",  "explorer": "https://etherscan.io/tx/",            "rpcUrl": "https://ethereum-rpc.publicnode.com"},
    "base":      {"chainId": 8453,  "symbol": "ETH",  "explorer": "https://basescan.org/tx/",            "rpcUrl": "https://base-rpc.publicnode.com"},
    "arbitrum":  {"chainId": 42161, "symbol": "ETH",  "explorer": "https://arbiscan.io/tx/",             "rpcUrl": "https://arbitrum-one-rpc.publicnode.com"},
    "optimism":  {"chainId": 10,    "symbol": "ETH",  "explorer": "https://optimistic.etherscan.io/tx/", "rpcUrl": "https://optimism-rpc.publicnode.com"},
    "polygon":   {"chainId": 137,   "symbol": "POL",  "explorer": "https://polygonscan.com/tx/",         "rpcUrl": "https://polygon-bor-rpc.publicnode.com"},
    "bnb":       {"chainId": 56,    "symbol": "BNB",  "explorer": "https://bscscan.com/tx/",             "rpcUrl": "https://bsc-rpc.publicnode.com"},
    "avalanche": {"chainId": 43114, "symbol": "AVAX", "explorer": "https://snowtrace.io/tx/",            "rpcUrl": "https://avalanche-c-chain-rpc.publicnode.com"},
}

DEFAULT_ENDPOINTS = {
    **{cid: {"rpcUrl": n["rpcUrl"], "chainId": n["chainId"]} for cid, n in EVM_NETWORKS.items()},
    "solana":   {"rpcUrl": "https://api.mainnet-beta.solana.com"},
    "bitcoin":  {"esplora": "https://blockstream.info/api"},
    "litecoin": {"esplora": "https://litecoinspace.org/api"},
    "dogecoin": {"esplora": None},  # user must supply (no public Esplora default)
}


def _erc20(chain, symbol, decimals, address):
    return AssetRef(chain=chain, kind="erc20", symbol=symbol, decimals=decimals, address=address)


#: Known-list fallback (canonical native USDC/USDT per network). Auto-detect
#: merges live holdings on top of this; where auto-detect is off (no key, or
#: BNB/Avalanche) this list is what shows.
DEFAULT_TOKENS = {
    "ethereum": [
        _erc20("ethereum", "USDC", 6, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        _erc20("ethereum", "USDT", 6, "0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    ],
    "base": [
        _erc20("base", "USDC", 6, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    ],
    "arbitrum": [
        _erc20("arbitrum", "USDC", 6, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        _erc20("arbitrum", "USDT", 6, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
    ],
    "optimism": [
        _erc20("optimism", "USDC", 6, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
        _erc20("optimism", "USDT", 6, "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"),
    ],
    "polygon": [
        _erc20("polygon", "USDC", 6, "0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359"),
        _erc20("polygon", "USDT", 6, "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"),
    ],
    "bnb": [  # BNB-Chain USDC/USDT are 18-decimal
        _erc20("bnb", "USDC", 18, "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
        _erc20("bnb", "USDT", 18, "0x55d398326f99059fF775485246999027B3197955"),
    ],
    "avalanche": [
        _erc20("avalanche", "USDC", 6, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
        _erc20("avalanche", "USDT", 6, "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7"),
    ],
}

DEFAULT_ENABLED = ["block", *EVM_NETWORKS.keys(), "solana", "bitcoin", "litecoin", "dogecoin"]


def _resolve_alchemy_rpc(cfg):
    """Turn an alchemy config entry into a JSON-RPC callable, or None (OFF).

    Accepts a full URL string (which embeds the read-only indexer key), a
    mapping ``{"url"|"rpcUrl": ...}``, or ``{"rpc": callable}`` for tests. The
    key is never logged here — it rides inside the URL into default_json_rpc."""
    if not cfg:
        return None
    if callable(cfg):
        return cfg
    if isinstance(cfg, dict):
        if callable(cfg.get("rpc")):
            return cfg["rpc"]
        url = cfg.get("url") or cfg.get("rpcUrl")
    else:
        url = cfg
    return default_json_rpc(url) if url else None


class ChainRegistry:
    def __init__(self, config=None):
        config = config or {}
        endpoints = {**DEFAULT_ENDPOINTS, **(config.get("endpoints") or {})}
        self._endpoints = endpoints
        self._tokens = {**DEFAULT_TOKENS, **(config.get("tokens") or {})}
        enabled = set(config.get("enabled") or DEFAULT_ENABLED)
        enabled.add("block")  # BLOCK is always enabled
        self._enabled = enabled
        #: Per-network Alchemy indexer config (OFF until set). See the GOAL:
        #: chainEndpoints.alchemy.{ethereum,base,arbitrum,optimism,polygon}.
        self._alchemy = config.get("alchemy") or {}

        a = {}
        for cid, net in EVM_NETWORKS.items():
            ep = endpoints.get(cid) or {}
            a[cid] = create_evm_adapter(
                id=cid, chainId=ep.get("chainId", net["chainId"]),
                symbol=net["symbol"], rpcUrl=ep.get("rpcUrl") or net["rpcUrl"],
                rpc=ep.get("rpc"), explorer=net["explorer"],
                alchemy_rpc=_resolve_alchemy_rpc(self._alchemy.get(cid)),
            )
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

    def discover_tokens(self, id, address):
        """Auto-detect the tokens ``address`` actually holds on chain ``id``.

        Delegates to the adapter's ``discover_tokens`` (Solana SPL scan, EVM
        Alchemy, BLOCK-20 holder scan); UTXO chains and any adapter without the
        method return ``[]``. Never raises — discovery is best-effort and
        additive on top of the always-present native + default-list balances."""
        a = self._adapters.get(id)
        if not a or not hasattr(a, "discover_tokens"):
            return []
        try:
            # Solana can borrow symbol/decimals/logo from the known list.
            if id == "solana":
                return a.discover_tokens(address, known=self.tokens_for(id))
            return a.discover_tokens(address)
        except Exception:
            return []

    def all_balances(self, id, address, hide_spam=False):
        """Native coin + default-list tokens + auto-detected held tokens, merged
        and deduped by ``(chain, contract)`` — the unified view the Accounts
        panel and the agent getBalance use."""
        adapter = self.get(id)
        primary = adapter.get_balance(address, self.tokens_for(id))
        discovered = self.discover_tokens(id, address)
        return merge_balances(primary, discovered, hide_spam=hide_spam)

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
