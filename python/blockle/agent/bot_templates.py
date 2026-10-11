"""agent/bot_templates.py — starter bot presets + template export/import (§6).
Faithful Python port of ``blockle-extension/agent/bot-templates.js``.

A bot config is an exportable/importable JSON "Blockle Bot template". The starter
set lets a first-timer create a working bot in seconds (§5a). IMPORT NEVER auto-
starts a live bot — it always lands as ``paper`` + ``disabled`` + ``testnet`` with
a zero allocation, so the user must explicitly review + arm it (the arming +
allocation + mainnet gates are never skipped).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from . import bots as _bots

TEMPLATE_VERSION = 1

# Each template is a safe, paper-friendly preset. ``pair`` is a placeholder the
# create flow / a signal substitutes. All default paper + disabled + testnet.
TEMPLATES: Dict[str, Dict[str, Any]] = {
    "conservative_dca": {
        "name": "Conservative DCA",
        "type": "dca",
        "blurb": "Steady accumulation: small base order, patient safety ladder, modest take-profit.",
        "universe": {"pairs": ["SOL/USDC"]},
        "config": {
            "baseOrderUsd": 20, "safetyOrderUsd": 20, "maxSafetyOrders": 3,
            "safetyStepPct": 2, "safetyStepScale": 1.0, "safetyVolumeScale": 1.0,
            "takeProfitPct": 2, "trailingTpPct": 0, "stopLossPct": 0,
            "cooldownSec": 0, "startCondition": "asap",
        },
    },
    "aggressive_dca": {
        "name": "Aggressive DCA",
        "type": "dca",
        "blurb": "Wider steps, martingale sizing, higher take-profit. Higher risk.",
        "universe": {"pairs": ["SOL/USDC"]},
        "config": {
            "baseOrderUsd": 25, "safetyOrderUsd": 25, "maxSafetyOrders": 4,
            "safetyStepPct": 3, "safetyStepScale": 1.2, "safetyVolumeScale": 1.5,
            "takeProfitPct": 3, "trailingTpPct": 1, "stopLossPct": 0,
            "cooldownSec": 0, "startCondition": "asap",
        },
    },
    "wide_grid": {
        "name": "Wide Grid",
        "type": "grid",
        "blurb": "A broad ladder for ranging markets — buy low, sell a grid up, repeat.",
        "universe": {"pairs": ["BLOCK/USDC"]},
        "config": {"lowerPrice": 0.8, "upperPrice": 1.2, "gridCount": 8, "totalUsd": 80,
                   "takeProfitPct": 0, "stopLossPct": 0},
    },
    "scalp_grid": {
        "name": "Scalp Grid",
        "type": "grid",
        "blurb": "A tight ladder for small, frequent moves.",
        "universe": {"pairs": ["BLOCK/USDC"]},
        "config": {"lowerPrice": 0.97, "upperPrice": 1.03, "gridCount": 12, "totalUsd": 60,
                   "takeProfitPct": 0, "stopLossPct": 0},
    },
    "block_accumulator": {
        "name": "BLOCK Accumulator",
        "type": "dca",
        "blurb": "Accumulate BLOCK on dips with a deep safety ladder; no stop-loss, no rush.",
        "universe": {"pairs": ["BLOCK/USDC"]},
        "config": {
            "baseOrderUsd": 15, "safetyOrderUsd": 15, "maxSafetyOrders": 5,
            "safetyStepPct": 4, "safetyStepScale": 1.1, "safetyVolumeScale": 1.2,
            "takeProfitPct": 5, "trailingTpPct": 2, "stopLossPct": 0,
            "cooldownSec": 3600, "startCondition": "dip", "dipPct": 3,
        },
    },
}


def list() -> List[Dict[str, Any]]:  # noqa: A001 — mirrors the JS `list` export name
    return [{"key": key, "name": t["name"], "type": t["type"], "blurb": t["blurb"]}
            for key, t in TEMPLATES.items()]


def from_template(key: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build a Bot spec from a template. The caller supplies pair + allocationUsd;
    the result is ALWAYS paper + disabled + testnet (never auto-armed)."""
    opts = opts or {}
    t = TEMPLATES.get(key)
    if not t:
        raise ValueError("unknown template: " + str(key))
    if opts.get("pair"):
        pairs = [str(opts["pair"]).upper()]
    else:
        pairs = [*((t.get("universe") or {}).get("pairs") or [])]
    return {
        "name": opts.get("name") or t["name"],
        "type": t["type"],
        "universe": {"pairs": [*pairs]},
        "config": dict(t["config"]),
        "allocationUsd": 0,          # must be set explicitly at live-arm time
        "mode": "paper",
        "enabled": False,
        "network": "testnet",
        "template": key,
    }


def export_bot(bot: Any) -> Dict[str, Any]:
    """Export a bot's config as a portable template JSON (NO state, NO keys, NO
    allocation/mode/enabled — a template is a recipe, not a running bot)."""
    return {
        "kind": "blockle-bot-template",
        "version": TEMPLATE_VERSION,
        "name": bot.name,
        "type": bot.type,
        "universe": bot.universe or {"pairs": []},
        "chainPrefs": bot.chain_prefs,
        "venuePrefs": bot.venue_prefs,
        "config": bot.config,
    }


def import_template(data: Any) -> Any:
    """Import a template JSON into a fresh Bot. ALWAYS lands paper + disabled +
    testnet with zero allocation, regardless of what the JSON claimed — import can
    never auto-arm or carry live funds."""
    obj = data
    if isinstance(data, str):
        obj = json.loads(data)
    if not obj or not isinstance(obj, dict):
        raise ValueError("invalid template JSON")
    if obj.get("kind") and obj.get("kind") != "blockle-bot-template":
        raise ValueError("not a blockle-bot-template")
    if obj.get("type") not in _bots.TYPES:
        raise ValueError("unknown bot type in template: " + str(obj.get("type")))
    spec = {
        "name": obj.get("name") or (obj["type"] + " bot"),
        "type": obj["type"],
        "universe": obj.get("universe") or {"pairs": []},
        "chainPrefs": obj.get("chainPrefs"),
        "venuePrefs": obj.get("venuePrefs"),
        "config": obj.get("config") or {},
        # HARD safety: import is always paper + disabled + testnet + no allocation.
        "allocationUsd": 0,
        "mode": "paper",
        "enabled": False,
        "network": "testnet",
        "imported": True,
    }
    return _bots.Bot(spec)
