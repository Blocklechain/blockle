#!/usr/bin/env python3
"""Village building sprites that BLEND with the top-down scenes: generated in
the same rich painted-pixel style, from a TOP-DOWN 3/4 angle (roof dominant,
front face peeking below - matching how the ground scenes are viewed), with
magenta chroma-key transparency for clean edges.
Output: assets/images/buildings/<name>.png (transparent, 112px)."""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from pathlib import Path
import numpy as np
import torch
from diffusers import AutoPipelineForText2Image
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "assets" / "images" / "buildings"
OUT.mkdir(parents=True, exist_ok=True)
STYLE = ("ultra detailed painted pixel art, HD-2D fantasy, chunky bold-outlined pixel clusters, "
         "warm golden light and glowing lanterns, deep rich shadows, moss and worn stone detail, "
         "vibrant saturated colors, seen from above in a top-down three quarter view with the roof "
         "dominant and the front door face visible below, like a building on a game town map, "
         "single building centered, isolated on a plain flat solid magenta background, no text")
BUILDINGS = {
    "house": "a cozy stone and timber cottage with a mossy green wooden shingle roof, lanterns by the wooden door, a red banner",
    "shop": "a village general store with a striped awning over the door, crates and barrels out front",
    "inn": "a two-story stone and timber inn tavern with warm glowing windows and a hanging wooden sign",
    "hall": "a grand stone town hall with columns, banners and lantern posts",
    "tower": "a stone wizard tower with a pointed green roof and glowing windows",
    "cabin": "a small log cabin with a stone chimney and warm window light",
    "blockhall": "a violet crystal guild hall with glowing runes and a stone base",
}
PX, COLORS = 112, 40


def chroma_key(img):
    a = np.asarray(img.convert("RGB"), dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mask = (r > 120) & (b > 110) & (g < (np.minimum(r, b) * 0.72))
    alpha = np.where(mask, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), "RGBA")


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float16).to(dev)
    pipe.set_progress_bar_config(disable=True)
    try:
        pipe.safety_checker = None
    except Exception:
        pass
    for i, (name, subj) in enumerate(BUILDINGS.items()):
        dest = OUT / f"{name}.png"
        if dest.exists():
            continue
        g = torch.Generator(device=dev).manual_seed(9100 + i)
        img = pipe(prompt=f"{subj}, {STYLE}", num_inference_steps=3, guidance_scale=0.0,
                   height=512, width=512, generator=g).images[0]
        cut = chroma_key(img).resize((PX, PX), Image.NEAREST)
        a = cut.split()[3].point(lambda x: 255 if x > 110 else 0)
        rgb = cut.convert("RGB").quantize(colors=COLORS, method=Image.FASTOCTREE).convert("RGB")
        Image.merge("RGBA", (*rgb.split(), a)).save(dest)
        print(f"building {name}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
