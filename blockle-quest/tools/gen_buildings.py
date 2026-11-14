#!/usr/bin/env python3
"""8-bit cartoon building sprites for villages (gen -> matte -> pixelate), on the
M2. Output: assets/images/buildings/<name>.png (transparent, ~96px)."""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from pathlib import Path
import torch
from diffusers import AutoPipelineForText2Image
from rembg import remove, new_session
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "assets" / "images" / "buildings"
OUT.mkdir(parents=True, exist_ok=True)
STYLE = ("detailed painted pixel art building, HD-2D fantasy RPG, stone and timber, "
         "warm glowing lanterns, rich saturated colors, cozy storybook, front 3/4 view, "
         "single building, plain dark background, no text")
BUILDINGS = {
    "house": "a cozy stone and timber cottage with a mossy green wooden shingle roof, lanterns by the wooden door, a red banner",
    "shop": "a village general store with a striped awning, crates and barrels out front, lantern glow",
    "inn": "a two-story stone and timber inn tavern with warm glowing windows and a hanging wooden sign",
    "hall": "a grand stone town hall with columns, banners and lantern posts",
    "tower": "a tall stone wizard tower with a pointed green roof and glowing windows",
    "cabin": "a small log cabin with a stone chimney and warm window light",
    "blockhall": "a violet crystal guild hall, glowing runes, stone base",
}
PX, COLORS = 112, 40


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float16).to(dev)
    pipe.set_progress_bar_config(disable=True)
    try: pipe.safety_checker = None
    except Exception: pass
    sess = new_session("u2net")
    for i, (name, subj) in enumerate(BUILDINGS.items()):
        g = torch.Generator(device=dev).manual_seed(9000 + i)
        img = pipe(prompt=f"{subj}, {STYLE}", num_inference_steps=3, guidance_scale=0.0,
                   height=512, width=512, generator=g).images[0]
        bg = Image.new("RGBA", img.size, (128, 128, 128, 255)); bg.alpha_composite(img.convert("RGBA"))
        cut = remove(bg.convert("RGB"), session=sess).convert("RGBA").resize((PX, PX), Image.NEAREST)
        a = cut.split()[3].point(lambda x: 255 if x > 110 else 0)
        rgb = cut.convert("RGB").quantize(colors=COLORS, method=Image.FASTOCTREE).convert("RGB")
        Image.merge("RGBA", (*rgb.split(), a)).save(OUT / f"{name}.png")
        print("building", name, flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
