#!/usr/bin/env python3
"""Whole-zone scene backgrounds — the look rewrite.

Instead of per-tile textures (which can never cohere), each zone's ground is ONE
AI-painted scene image in the Thronebound-Realms style: detailed painted pixel
art, coherent paths/flower beds/lighting across the whole chunk. Generated at
512px, palette-crushed, drawn in-game scaled to the 1536px zone with nearest-
neighbour (3x chunky pixels — matches the reference's painted-pixel clusters).

Output: assets/images/scenes/<theme>_<variant>.png  (+ village_ground_*)
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from pathlib import Path
import torch
from diffusers import AutoPipelineForText2Image
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "assets" / "images" / "scenes"
OUT.mkdir(parents=True, exist_ok=True)

STYLE = ("detailed painted pixel art, HD-2D fantasy RPG, chunky pixel clusters, "
         "warm sunny lighting, soft shadows, rich saturated colors, "
         "straight top-down overhead view, seamless game ground background, "
         "no text, no characters, no people, no buildings")

SCENES = {
    # theme -> scene subject (ground only; buildings/characters billboard on top)
    "meadow": "a lush green grass meadow crossed by winding grey cobblestone paths, "
              "clusters of red and white flowers, small green bushes, grass growing between path stones",
    "forest": "a mossy forest floor clearing, dirt path, ferns, scattered leafy green bushes and roots",
    "swamp": "murky green swamp ground, shallow bog pools, lily pads, reeds, muddy paths",
    "desert": "golden desert sand with a worn stone path, dune ripples, sparse dry shrubs and small rocks",
    "tundra": "fresh white snow field with a trodden path, soft blue shadows, small pine shrubs, ice patches",
    "volcanic": "dark volcanic ash ground with glowing ember cracks, basalt rocks, a cooled lava path",
    "crystal": "pale ground studded with glowing violet crystal clusters, magical runes, shimmering path",
    "ruins": "ancient broken stone ruins floor, cracked flagstones, moss, fallen pillars, grass tufts",
    "shore": "grassy lakeshore with a clear blue water edge, sandy bank, smooth pebbles, a wooden walkway",
    "blocklands": "violet crystalline ground with glowing geometric block runes, purple grass, energy veins",
    # Village grounds: FLAT plaza only — buildings are billboards on top.
    "village_ground": "flat empty village plaza ground viewed straight from directly above, "
                      "grey cobblestone pavement crossing lush green grass lawns, flower beds with "
                      "red flowers along the path edges, small bushes, flat ground only, "
                      "no buildings, no roofs, no walls, no structures",
}
VARIANTS = 4
SIZE = 512
COLORS = 56


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float16).to(dev)
    pipe.set_progress_bar_config(disable=True)
    try:
        pipe.safety_checker = None
    except Exception:
        pass
    n = 0
    for ti, (theme, subj) in enumerate(SCENES.items()):
        for v in range(VARIANTS):
            dest = OUT / f"{theme}_{v}.png"
            if dest.exists():
                continue
            g = torch.Generator(device=dev).manual_seed(12000 + ti * 10 + v)
            img = pipe(prompt=f"{subj}, {STYLE}", num_inference_steps=3, guidance_scale=0.0,
                       height=SIZE, width=SIZE, generator=g).images[0]
            img = img.quantize(colors=COLORS, method=Image.FASTOCTREE).convert("RGB")
            img.save(dest)
            n += 1
            print(f"scene {theme} v{v}", flush=True)
    print(f"done: {n} scenes", flush=True)


if __name__ == "__main__":
    main()
