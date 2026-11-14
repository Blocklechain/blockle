#!/usr/bin/env python3
"""Hero appearance variants: hair colour x outfit colour grid, so the player can
edit their look and see a REAL sprite change. gen -> rembg -> pixelate, M2.
Output: assets/images/chars/hero_<hair>_<outfit>.png (64px, transparent)."""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from pathlib import Path
import torch
from diffusers import AutoPipelineForText2Image
from rembg import remove, new_session
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "assets" / "images" / "chars"
HAIR = ["red", "black", "blond", "blue", "purple", "white"]
OUTFIT = ["red", "blue", "green", "purple"]
STYLE = ("detailed painted pixel art, HD-2D fantasy RPG, chunky pixel clusters, "
         "warm lighting, rich saturated colors, no text")
PX, COLORS = 64, 32


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float16).to(dev)
    pipe.set_progress_bar_config(disable=True)
    try: pipe.safety_checker = None
    except Exception: pass
    sess = new_session("u2net")
    n = 0
    for hi, hair in enumerate(HAIR):
        for oi, outfit in enumerate(OUTFIT):
            dest = OUT / f"hero_{hair}_{outfit}.png"
            if dest.exists():
                continue
            p = (f"front view facing the viewer, a chibi hero character sprite with spiky {hair} hair "
                 f"and a {outfit} tunic, big head small body, {STYLE}, single centered character, "
                 f"plain dark background, full body, retro game sprite")
            g = torch.Generator(device=dev).manual_seed(6000 + hi * 10 + oi)
            img = pipe(prompt=p, num_inference_steps=3, guidance_scale=0.0,
                       height=512, width=512, generator=g).images[0]
            bg = Image.new("RGBA", img.size, (128, 128, 128, 255)); bg.alpha_composite(img.convert("RGBA"))
            cut = remove(bg.convert("RGB"), session=sess).convert("RGBA").resize((PX, PX), Image.NEAREST)
            a = cut.split()[3].point(lambda x: 255 if x > 110 else 0)
            rgb = cut.convert("RGB").quantize(colors=COLORS, method=Image.FASTOCTREE).convert("RGB")
            Image.merge("RGBA", (*rgb.split(), a)).save(dest)
            n += 1
            print(f"hero {hair}/{outfit}", flush=True)
    print(f"done: {n} variants", flush=True)


if __name__ == "__main__":
    main()
