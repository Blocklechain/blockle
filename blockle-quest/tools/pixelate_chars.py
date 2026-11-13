#!/usr/bin/env python3
"""Crush matted character sprites to 8-bit: downscale to a small pixel grid,
quantize to a limited palette, and hard-edge the alpha (no soft transparency).
Run AFTER rembg_chars.py. Overwrites assets/images/chars/*.png.
"""
import sys
from pathlib import Path
from PIL import Image

PX = 48       # pixel grid
COLORS = 16   # palette size

d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "assets" / "images" / "chars"
for p in sorted(d.glob("*.png")):
    im = Image.open(p).convert("RGBA").resize((PX, PX), Image.NEAREST)
    a = im.split()[3].point(lambda x: 255 if x > 110 else 0)          # hard alpha
    rgb = im.convert("RGB").quantize(colors=COLORS, method=Image.FASTOCTREE).convert("RGB")
    out = Image.merge("RGBA", (*rgb.split(), a))
    out.save(p)
    print(f"pixelated {p.name}", flush=True)
print("done", flush=True)
