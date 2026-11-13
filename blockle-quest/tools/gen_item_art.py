#!/usr/bin/env python3
"""Blocklings — local M2 item-art generator.

Runs a text-to-image model ON THIS MACHINE (Apple Silicon / MPS) to render a
unique sprite for each procedurally-generated item. The item's catalog index is
used as the diffusion seed, so art is deterministic and reproducible — the same
image can be pinned as the item's NFT art.

The attribute lists MUST stay in sync with lib/models/item.dart (same order).

Usage:
    python3 tools/gen_item_art.py --count 16              # first 16 catalog items
    python3 tools/gen_item_art.py --start 0 --count 200   # a batch
    python3 tools/gen_item_art.py --indices 0,41,615      # specific items
    python3 tools/gen_item_art.py --all                   # the whole catalog (long!)

Output: assets/items/<catalogIndex>.png (256x256 by default).
"""

import argparse
import os
import sys
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")  # libomp double-init workaround
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# ---- mirror of lib/models/item.dart (keep in sync) ----------------------- #
BASES = [
    ("Sword", "weapon"), ("Axe", "weapon"), ("Dagger", "weapon"), ("Spear", "weapon"),
    ("Mace", "weapon"), ("Bow", "weapon"), ("Staff", "weapon"), ("Wand", "weapon"),
    ("Greatsword", "weapon"), ("Shield", "offhand"), ("Buckler", "offhand"), ("Tome", "offhand"),
    ("Helm", "head"), ("Hood", "head"), ("Crown", "head"), ("Breastplate", "chest"),
    ("Robe", "chest"), ("Tunic", "chest"), ("Gauntlets", "hands"), ("Gloves", "hands"),
    ("Greaves", "feet"), ("Boots", "feet"), ("Ring", "ring"), ("Band", "ring"),
    ("Signet", "ring"), ("Amulet", "amulet"), ("Pendant", "amulet"), ("Charm", "amulet"),
    ("Potion", "consumable"), ("Elixir", "consumable"), ("Scroll", "consumable"),
    ("Ore", "material"), ("Essence", "material"), ("Gem", "material"),
]
PREFIXES = [
    "Rusty", "Worn", "Iron", "Steel", "Bronze", "Silver", "Crystal", "Obsidian",
    "Ember", "Frost", "Storm", "Ancient", "Blessed", "Cursed", "Voltaic",
    "Verdant", "Tidal", "Gilded", "Shadow", "Radiant", "Runed", "Draconic",
    "Astral", "Blockforged",
]
SUFFIXES = [
    "of Power", "of the Bear", "of Swiftness", "of Embers", "of the Tide",
    "of Warding", "of Fortune", "of the Spark", "of Stone", "of Gales",
    "of Leeching", "of Precision", "of Vigor", "of the Ancients", "of BLOCK",
]
RARITIES = ["common", "uncommon", "rare", "epic", "legendary"]

CATALOG_SIZE = len(BASES) * len(PREFIXES) * len(SUFFIXES)


def decompose(index: int):
    i = index % CATALOG_SIZE
    suffix = i % len(SUFFIXES)
    rest = i // len(SUFFIXES)
    prefix = rest % len(PREFIXES)
    base = rest // len(PREFIXES)
    rarity = max(0, min(4, prefix * 5 // len(PREFIXES)))  # matches Item.at default
    return base, prefix, suffix, rarity


# Material look hints so the prefix actually changes the render.
MATERIAL_HINT = {
    "Rusty": "rusted corroded metal", "Worn": "weathered worn", "Iron": "dark iron",
    "Steel": "polished steel", "Bronze": "bronze", "Silver": "shining silver",
    "Crystal": "translucent crystal", "Obsidian": "black obsidian glass",
    "Ember": "glowing ember orange", "Frost": "icy frost blue", "Storm": "crackling lightning",
    "Ancient": "ancient mossy", "Blessed": "holy golden glow", "Cursed": "dark cursed purple aura",
    "Voltaic": "electric neon", "Verdant": "overgrown green", "Tidal": "aquatic teal",
    "Gilded": "ornate gold", "Shadow": "shadowy black", "Radiant": "radiant white light",
    "Runed": "glowing blue runes", "Draconic": "dragon-scaled", "Astral": "cosmic starry purple",
    "Blockforged": "violet crystalline energy",
}


# Affixes become VISUAL themes, never quoted words — quoting "of Fortune" etc. is
# what makes the model render gibberish text onto the sprite.
SUFFIX_THEME = [
    "radiating power, faint energy glow",       # of Power
    "rugged and heavy, bear motif",             # of the Bear
    "sleek aerodynamic, motion lines",          # of Swiftness
    "burning with small flames",                # of Embers
    "dripping with water, aquatic sheen",       # of the Tide
    "surrounded by a protective shimmer",       # of Warding
    "glinting with luck, four-leaf clover motif",# of Fortune
    "arcing with tiny lightning sparks",        # of the Spark
    "heavy carved stone texture",               # of Stone
    "swirling wind currents around it",         # of Gales
    "dark draining mist",                       # of Leeching
    "sharp precise edges, pristine",            # of Precision
    "robust and sturdy, warm vitality glow",    # of Vigor
    "weathered ancient relic, worn carvings",   # of the Ancients
    "infused with violet crystalline blockchain energy",  # of BLOCK
]

# 4 overworld angles so the in-world/equipped graphic matches the item sprite.
ANGLE_HINT = {
    "s": "front view, facing the viewer",
    "n": "back view, seen from behind",
    "e": "side profile view, facing right",
    "w": "side profile view, facing left",
}

_NO_TEXT = "wordless, no text, no letters, no words, no writing, no inscription, no numbers, no label, no logo, no watermark, no frame, no border"


def prompt_for(index: int, angle: str | None = None):
    base, prefix, suffix, rarity = decompose(index)
    noun, _slot = BASES[base]
    mat = MATERIAL_HINT.get(PREFIXES[prefix], "")
    theme = SUFFIX_THEME[suffix]
    view = f"{ANGLE_HINT[angle]}, " if angle else ""
    p = (f"{view}a {RARITIES[rarity]} {noun} made of {mat}, {theme}, "
         f"fantasy RPG item icon, single centered object, 2D game asset sprite, "
         f"clean dark neutral background, soft rim lighting, crisp high detail, "
         f"inventory icon, {_NO_TEXT}")
    neg = ("text, letters, words, writing, typography, caption, label, watermark, "
           "signature, multiple objects, hands, person, blurry, frame, border, ui")
    return p, neg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="stabilityai/sd-turbo")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "assets" / "items"))
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--steps", type=int, default=2)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--count", type=int, default=16)
    ap.add_argument("--indices", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()

    if args.indices:
        todo = [int(x) for x in args.indices.split(",") if x.strip()]
    elif args.all:
        todo = list(range(CATALOG_SIZE))
    else:
        todo = list(range(args.start, min(args.start + args.count, CATALOG_SIZE)))

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    import torch
    from diffusers import AutoPipelineForText2Image

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"catalog={CATALOG_SIZE} items | generating {len(todo)} | device={device} | model={args.model}",
          file=sys.stderr)

    pipe = AutoPipelineForText2Image.from_pretrained(args.model, torch_dtype=torch.float16)
    pipe = pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    try:
        pipe.safety_checker = None  # sprites; skip the NSFW classifier for speed
    except Exception:
        pass

    native = 512  # sd-turbo native resolution
    done = 0
    for idx in todo:
        dest = out / f"{idx}.png"
        if dest.exists() and not args.overwrite:
            continue
        prompt, neg = prompt_for(idx)
        g = torch.Generator(device=device).manual_seed(idx)  # deterministic per item
        img = pipe(
            prompt=prompt,
            negative_prompt=neg,
            num_inference_steps=args.steps,
            guidance_scale=0.0,  # sd-turbo is distilled; no CFG
            height=native, width=native,
            generator=g,
        ).images[0]
        if args.size != native:
            img = img.resize((args.size, args.size))
        img.save(dest)
        done += 1
        if done % 10 == 0 or done == len(todo):
            print(f"  {done}/{len(todo)} (last: {Path(dest).name} '{prompt[:48]}…')", file=sys.stderr)
    print(f"done: {done} images -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
