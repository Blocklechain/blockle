#!/usr/bin/env python3
"""Blocklings — world art (tiles + directional character sprites) on the M2.

Pokémon-inspired but a bit more painterly/detailed. Outputs into
assets/images/{tiles,chars} (Flame's default image root is assets/images/).

  python3 tools/gen_world_art.py            # everything
  python3 tools/gen_world_art.py --tiles    # just terrain tiles
  python3 tools/gen_world_art.py --chars    # just characters

Deterministic seeds so art is reproducible.
"""

import argparse
import os
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

ROOT = Path(__file__).resolve().parents[1] / "assets" / "images"

STYLE = ("16-bit pixel art, classic Pokemon Game Boy Advance sprite, top-down, "
         "limited color palette, flat colors, crisp clean pixels, no gradients, no text, no letters")

# Terrain tiles (seamless-ish). name -> subject.
TILES = {
    "grass": "lush green grass terrain, small blades and flowers",
    "grassAlt": "darker green grass terrain, patchy",
    "tallGrass": "tall wild grass, dense blades",
    "path": "worn dirt path, packed earth",
    "water": "clear blue water surface, gentle ripples",
    "tree": "top of a round leafy green tree canopy",
    "rock": "grey rocky boulder ground, cracked stone",
    "blockstone": "glowing violet crystal stone ground, magical",
    "sand": "golden desert sand dunes texture",
    "snow": "fresh white snow terrain, soft drifts",
    "ash": "dark volcanic ash ground, charred",
    "bog": "murky green swamp mud, bubbling",
}

# Characters with 4 facings. key -> subject.
CHARS = {
    "player": "a cute brave young adventurer hero character sprite",
    "spark": "a small cute yellow lightning elemental creature",
    "stone": "a small cute rocky earth golem creature",
    "leaf": "a small cute green leafy plant creature",
    "tide": "a small cute blue water creature",
    "ember": "a small cute orange fire creature",
    "gust": "a small cute pale wind creature",
}
FACINGS = {
    "s": "facing the viewer, front view",
    "n": "seen from behind, back view",
    "e": "side view facing right",
    "w": "side view facing left",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", action="store_true")
    ap.add_argument("--chars", action="store_true")
    ap.add_argument("--model", default="stabilityai/sd-turbo")
    ap.add_argument("--steps", type=int, default=2)
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    do_tiles = args.tiles or not args.chars
    do_chars = args.chars or not args.tiles

    import torch
    from diffusers import AutoPipelineForText2Image

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained(args.model, torch_dtype=torch.float16).to(device)
    pipe.set_progress_bar_config(disable=True)
    try:
        pipe.safety_checker = None
    except Exception:
        pass

    from PIL import Image

    def gen(prompt, seed, size, pixelate=None, colors=16):
        g = torch.Generator(device=device).manual_seed(seed)
        img = pipe(prompt=prompt, num_inference_steps=args.steps, guidance_scale=0.0,
                   height=512, width=512, generator=g).images[0]
        if pixelate:
            # Downsample to a small pixel grid + crush to a limited palette (8-bit).
            img = img.resize((pixelate, pixelate), Image.BILINEAR)
            img = img.quantize(colors=colors, method=Image.FASTOCTREE).convert("RGB")
            if size != pixelate:
                img = img.resize((size, size), Image.NEAREST)
        else:
            img = img.resize((size, size))
        return img

    if do_tiles:
        out = ROOT / "tiles"
        out.mkdir(parents=True, exist_ok=True)
        for i, (name, subj) in enumerate(TILES.items()):
            dest = out / f"{name}.png"
            if dest.exists() and not args.overwrite:
                continue
            p = f"seamless tileable {subj}, {STYLE}, flat top-down overhead view, single terrain texture"
            gen(p, 1000 + i, 32, pixelate=32, colors=16).save(dest)
            print(f"tile {name}", flush=True)

    if do_chars:
        out = ROOT / "chars"
        out.mkdir(parents=True, exist_ok=True)
        for ci, (key, subj) in enumerate(CHARS.items()):
            # ONE sprite per character (the 4 facings must match exactly — the game
            # uses this single sprite for all directions and flips it for left).
            dest = out / f"{key}.png"
            if dest.exists() and not args.overwrite:
                continue
            p = f"front view facing the viewer, {subj}, {STYLE}, single centered character, plain dark background, full body, retro game sprite"
            gen(p, 5000 + ci, 160).save(dest)
            print(f"char {key}", flush=True)

    print("world art done", flush=True)


if __name__ == "__main__":
    main()
