#!/usr/bin/env python3
"""Clean sprite cutouts with rembg (U2Net matting) — replaces the flood-fill
halo with a proper alpha matte. Overwrites assets/images/chars/*.png.
"""
import os, sys
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
from pathlib import Path
from PIL import Image
from rembg import remove, new_session

d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "assets" / "images" / "chars"
sess = new_session("u2net")
pngs = sorted(d.glob("*.png"))
for p in pngs:
    img = Image.open(p).convert("RGBA")
    # Composite onto neutral grey so the matte model sees the original subject
    # (the flood-fill left transparent pixels with stale RGB).
    bg = Image.new("RGBA", img.size, (128, 128, 128, 255))
    bg.alpha_composite(img)
    out = remove(bg.convert("RGB"), session=sess)
    out.save(p)
    print(f"matted {p.name}", flush=True)
print(f"done: {len(pngs)}", flush=True)
