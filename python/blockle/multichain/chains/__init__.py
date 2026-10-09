"""Chain adapters for the multi-chain wallet.

Each adapter implements the uniform :class:`ChainAdapter` interface
(deriveAccount / getBalance / buildSend / broadcast / explorerTx plus the
chain-specific sign paths). Mirrors ``blockle-extension/chains/*.js`` and
``blockle-app/lib/multichain/chains/*.dart``.
"""

from __future__ import annotations

from . import block, custom_networks, discovery, evm, registry, solana, utxo
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            ChainAdapter, DerivedAccount, RootSecret, as_seed,
                            format_units)
from .custom_networks import (dedupe_custom_networks, explorer_tx_prefix,
                              normalize_custom_network, normalize_custom_networks,
                              probe_chain_id)
from .discovery import (is_spam, merge_balances, parse_alchemy_balances,
                        parse_alchemy_metadata, parse_spl_accounts)
from .evm import EvmAdapter, create_evm_adapter
from .registry import ChainRegistry, create_registry
from .solana import SolanaAdapter, create_solana_adapter
from .utxo import NETWORKS, UtxoAdapter, create_utxo_adapter
from .block import BlockAdapter, create_block_adapter

__all__ = [
    "AssetRef", "Balance", "BroadcastResult", "BuiltTx", "ChainAdapter",
    "DerivedAccount", "RootSecret", "as_seed", "format_units",
    "EvmAdapter", "create_evm_adapter",
    "UtxoAdapter", "NETWORKS", "create_utxo_adapter",
    "SolanaAdapter", "create_solana_adapter",
    "BlockAdapter", "create_block_adapter",
    "ChainRegistry", "create_registry",
    "merge_balances", "is_spam", "parse_spl_accounts",
    "parse_alchemy_balances", "parse_alchemy_metadata",
    "normalize_custom_network", "normalize_custom_networks",
    "dedupe_custom_networks", "explorer_tx_prefix", "probe_chain_id",
    "block", "evm", "solana", "utxo", "registry", "discovery", "custom_networks",
]
