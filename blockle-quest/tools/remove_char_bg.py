#!/usr/bin/env python3
"""Make character sprite backgrounds transparent.

SD-Turbo renders an opaque background. We flood-fill inward from the border,
clearing pixels connected to the edge whose color is close to the corner color,
then feather the edge. Subjects that don't touch the border come out clean.
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

TOL = 52


def strip(path: Path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im)
    h, w = a.shape[:2]
    rgb = a[:, :, :3].astype(int)
    corners = [rgb[0, 0], rgb[0, w - 1], rgb[h - 1, 0], rgb[h - 1, w - 1]]
    ref = np.mean(corners, axis=0)

    close = (np.abs(rgb - ref).sum(axis=2) <= TOL)
    visited = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if close[y, x]:
                q.append((y, x)); visited[y, x] = True
    for y in range(h):
        for x in (0, w - 1):
            if close[y, x] and not visited[y, x]:
                q.append((y, x)); visited[y, x] = True
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and close[ny, nx]:
                visited[ny, nx] = True; q.append((ny, nx))

    a[visited, 3] = 0
    out = Image.fromarray(a, "RGBA")
    # Soften the cut edge a touch.
    alpha = out.split()[3].filter(ImageFilter.GaussianBlur(0.6))
    out.putalpha(alpha)
    out.save(path)


if __name__ == "__main__":
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "assets" / "images" / "chars"
    pngs = sorted(d.glob("*.png"))
    for p in pngs:
        strip(p)
        print(f"stripped {p.name}", flush=True)
    print(f"done: {len(pngs)} sprites", flush=True)
