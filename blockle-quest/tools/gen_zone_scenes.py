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

STYLE = ("ultra detailed painted pixel art, HD-2D fantasy, chunky bold-outlined pixel clusters, warm golden light and glowing lanterns, deep rich shadows, moss and worn stone detail, vibrant saturated colors, "
         "straight top-down overhead view, seamless game ground scene, "
         "no text, no characters, no people, no buildings")

SCENES = {
    # theme -> scene subject (ground only; buildings/characters billboard on top).
    # Each scene carries a LANDMARK + mood, like the reference frames.
    "meadow": "a lush sunny green meadow crossed by a winding worn cobblestone path, "
              "clusters of red and white flowers, mossy stones, a glowing lantern post, golden sunlight",
    "forest": "a mossy forest floor clearing dappled with golden sun rays, dirt path, ferns, "
              "red mushrooms, gnarled roots, fireflies",
    "swamp": "murky green swamp ground at dusk, shallow bog pools glowing with fireflies, "
             "lily pads, reeds, muddy plank path",
    "desert": "golden desert sand at sunset with long warm shadows, a worn ancient stone path, "
              "dune ripples, dry shrubs, a weathered stone obelisk",
    "tundra": "snow field at blue dusk with a trodden path, warm glowing lantern post, "
              "ice patches sparkling, small drifts",
    "volcanic": "dark basalt cavern floor lit by glowing torch braziers, ember cracks, "
                "cooled lava path, scattered skulls and rubble, ominous mood",
    "crystal": "dark cave floor lit by glowing violet crystal clusters, magical blue runes, "
               "shimmering reflective path, mystical glow",
    "ruins": "ancient broken stone ruins floor, cracked mossy flagstones, fallen carved pillars, "
             "faintly glowing blue runes, grass tufts, melancholy mood",
    "shore": "grassy lakeshore at golden hour, clear sparkling blue water edge, sandy bank, "
             "smooth pebbles, a weathered wooden walkway, warm glow",
    "blocklands": "deep violet crystalline ground with glowing neon geometric block runes, "
                  "purple grass, pulsing energy veins, otherworldly glow",
    # Village grounds: FLAT plaza only — buildings are billboards on top.
    "village_ground": "a cozy village square viewed straight from directly above: circular grey "
                      "cobblestone paving around a carved stone statue plinth in the centre, "
                      "flower beds with red flowers, glowing lantern posts, moss between worn stones, "
                      "flat ground only, no buildings, no roofs, no walls",
}
VARIANTS = 4
SIZE = 768
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
