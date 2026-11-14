#!/usr/bin/env python3
"""Soften patch seams: blend every scene variant's edges toward its THEME's
shared edge tone, so adjacent patches meet on near-identical colors.

Run once after gen_zone_scenes.py (re-running re-blends toward the new mean —
idempotent enough). Pure PIL, instant.
"""
from pathlib import Path
from collections import defaultdict

import numpy as np
from PIL import Image

DIR = Path(__file__).resolve().parents[1] / "assets" / "images" / "scenes"
EDGE = 28  # px of blend falloff


def main():
    groups = defaultdict(list)
    for p in sorted(DIR.glob("*.png")):
        theme = p.stem.rsplit("_", 1)[0]
        groups[theme].append(p)

    for theme, paths in groups.items():
        imgs = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in paths]
        # Shared tone = mean color of all border rings in this theme.
        rings = []
        for a in imgs:
            rings.append(a[:EDGE].reshape(-1, 3))
            rings.append(a[-EDGE:].reshape(-1, 3))
            rings.append(a[:, :EDGE].reshape(-1, 3))
            rings.append(a[:, -EDGE:].reshape(-1, 3))
        tone = np.concatenate(rings).mean(axis=0)

        for p, a in zip(paths, imgs):
            h, w = a.shape[:2]
            yy = np.arange(h)[:, None]
            xx = np.arange(w)[None, :]
            d = np.minimum(np.minimum(yy, h - 1 - yy), np.minimum(xx, w - 1 - xx)).astype(np.float32)
            # 0 at the very edge -> 1 at EDGE px inward; blend weight toward tone.
            wgt = (1.0 - np.clip(d / EDGE, 0, 1)) * 0.55  # max 55% pull at the edge
            out = a * (1 - wgt[..., None]) + tone[None, None, :] * wgt[..., None]
            Image.fromarray(out.astype(np.uint8), "RGB").save(p)
        print(f"blended {theme} ({len(paths)} variants)", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
