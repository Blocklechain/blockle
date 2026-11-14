#!/usr/bin/env python3
"""World props: standalone trees + an upright wall/fence segment, painted-pixel
style, with MAGENTA CHROMA-KEY transparency (deterministic — no matting model):
generate on a flat magenta background, key out magenta-ish pixels.
Output: assets/images/props/<name>.png"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from pathlib import Path
import numpy as np
import torch
from diffusers import AutoPipelineForText2Image
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "assets" / "images" / "props"
OUT.mkdir(parents=True, exist_ok=True)
STYLE = ("detailed painted pixel art, HD-2D fantasy RPG, chunky pixel clusters, "
         "warm sunny lighting, rich saturated colors, front view, single object "
         "centered, isolated on a plain flat solid magenta background, no text")
PROPS = {
    "oak_0": ("a single oak tree with a huge round lush green leafy canopy, short thick brown trunk", 13021),
    "oak_1": ("a single bushy deciduous tree, big fluffy green leaf canopy, small trunk", 13022),
    "pine_0": ("a single evergreen pine tree, wide layered dark green triangular canopy, dense", 13023),
    "pine_1": ("a single dense evergreen fir tree, rich green layered branches", 13024),
    "fence_0": ("a low wide stone block garden wall segment topped with a thick wooden rail and a glowing lantern on a post", 13025),
    "fence_1": ("a low wide stone block garden wall segment topped with a thick wooden rail", 13026),
}
PX, COLORS = 96, 32


def chroma_key(img: Image.Image) -> Image.Image:
    a = np.asarray(img.convert("RGB"), dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # Magenta-ish: red+blue high, green clearly lower than both.
    mask = (r > 120) & (b > 110) & (g < (np.minimum(r, b) * 0.72))
    alpha = np.where(mask, 0, 255).astype(np.uint8)
    out = np.dstack([a.astype(np.uint8), alpha])
    return Image.fromarray(out, "RGBA")


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float16).to(dev)
    pipe.set_progress_bar_config(disable=True)
    try:
        pipe.safety_checker = None
    except Exception:
        pass
    for name, (subj, seed) in PROPS.items():
        dest = OUT / f"{name}.png"
        if dest.exists():
            continue
        g = torch.Generator(device=dev).manual_seed(seed)
        img = pipe(prompt=f"{subj}, {STYLE}", num_inference_steps=3, guidance_scale=0.0,
                   height=512, width=512, generator=g).images[0]
        cut = chroma_key(img).resize((PX, PX), Image.NEAREST)
        a = cut.split()[3].point(lambda x: 255 if x > 110 else 0)
        rgb = cut.convert("RGB").quantize(colors=COLORS, method=Image.FASTOCTREE).convert("RGB")
        Image.merge("RGBA", (*rgb.split(), a)).save(dest)
        print(f"prop {name}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
