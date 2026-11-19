#!/usr/bin/env python3
"""Generate the Blocklings app icon: a voxel 'B' (Blockle mark) in the
Blocklings homepage palette. Emits an SVG master to public/icon.svg."""
import os

SZ = 512
# Homepage palette (src/auth/title.css)
GREEN = "#7ed957"
GREEN_LT = "#8ae065"
GREEN_MD = "#6cc949"
GREEN_DP = "#5aa83f"
GREEN_SH = "#4e8a33"
GOLD = "#e8c15a"
GOLD_DP = "#b8860b"
BROWN = "#c98b4e"
BLUE = "#9fb7c9"
BG0 = "#101826"
BG1 = "#0a1018"

# 5x7 block grid forming a 'B'
GRID = [
    "11110",
    "10001",
    "10001",
    "11110",
    "10001",
    "10001",
    "11110",
]
# Per-cell color override; default by column/role below.
ACCENT = {(1, 4): GOLD, (4, 4): GOLD, (2, 4): GREEN_LT, (5, 4): GREEN_LT}

CUBE = 56
GAP = 8
COLS, ROWS = 5, 7
gw = COLS * CUBE + (COLS - 1) * GAP
gh = ROWS * CUBE + (ROWS - 1) * GAP
ox = (SZ - gw) / 2
oy = (SZ - gh) / 2


def cell_color(r, c):
    if (r, c) in ACCENT:
        return ACCENT[(r, c)]
    if c == 0:
        return GREEN_DP          # spine
    return GREEN                 # bars / body


def cube(x, y, color, r=11):
    # front + soft top highlight + bottom shadow = crisp pseudo-voxel
    s = CUBE
    return f"""  <g>
    <rect x="{x:.1f}" y="{y:.1f}" width="{s}" height="{s}" rx="{r}" fill="{color}"/>
    <rect x="{x+4:.1f}" y="{y+4:.1f}" width="{s-8}" height="{(s-8)*0.42:.1f}" rx="{r-3}" fill="#ffffff" opacity="0.20"/>
    <rect x="{x+4:.1f}" y="{y+s*0.64:.1f}" width="{s-8}" height="{s*0.30:.1f}" rx="{r-3}" fill="#000000" opacity="0.18"/>
  </g>"""


def drift(cx, cy, s, color, rot, op=0.85):
    return (f'  <rect x="{cx-s/2:.1f}" y="{cy-s/2:.1f}" width="{s}" height="{s}" rx="6" '
            f'fill="{color}" opacity="{op}" transform="rotate({rot} {cx} {cy})"/>')


parts = []
parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{SZ}" height="{SZ}" viewBox="0 0 {SZ} {SZ}">')
parts.append(f'''  <defs>
    <radialGradient id="glow" cx="50%" cy="38%" r="70%">
      <stop offset="0%" stop-color="{GREEN}" stop-opacity="0.26"/>
      <stop offset="55%" stop-color="{GREEN}" stop-opacity="0.0"/>
    </radialGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{BG0}"/>
      <stop offset="100%" stop-color="{BG1}"/>
    </linearGradient>
  </defs>''')
# rounded tile
parts.append(f'  <rect x="0" y="0" width="{SZ}" height="{SZ}" rx="112" fill="url(#bg)"/>')
parts.append(f'  <rect x="0" y="0" width="{SZ}" height="{SZ}" rx="112" fill="url(#glow)"/>')
# drifting homepage cubes (behind the B, in corners)
parts.append(drift(96, 104, 34, BLUE, -12, 0.55))
parts.append(drift(430, 120, 40, GOLD, 14, 0.6))
parts.append(drift(104, 420, 32, BROWN, 18, 0.5))
parts.append(drift(424, 410, 30, GREEN_LT, -16, 0.6))
# the voxel B
for r in range(ROWS):
    for c in range(COLS):
        if GRID[r][c] == "1":
            x = ox + c * (CUBE + GAP)
            y = oy + r * (CUBE + GAP)
            parts.append(cube(x, y, cell_color(r, c)))
parts.append('</svg>')

out = os.path.join(os.path.dirname(__file__), '..', 'public', 'icon.svg')
out = os.path.abspath(out)
with open(out, 'w') as f:
    f.write("\n".join(parts) + "\n")
print("wrote", out)
