#!/usr/bin/env python3
"""Cut the sprites out of assets/spritesheet.jpeg into transparent PNGs.

The sheet is a JPEG on a dark-navy grid, so there's no alpha channel. For each
sprite we crop a box and flood-fill the background from the crop's border.
A pixel counts as background if it's "dark and bluish" (the navy fill and the
grid lines both are); sprites have near-black outlines or warm/bright colours,
so the fill stops at their edge and interior pixels are never touched.

Usage: python3 tools/extract_sprites.py   (requires Pillow + numpy)
"""
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "spritesheet.jpeg"
OUT = ROOT / "assets" / "sprites"
# Longest side of the output PNGs: ~2x the on-screen size, so they stay sharp on retina.
MAX_SIZE = 220

# Boxes measured on a 2000px-wide preview; scaled x1.2 to the 2400px original.
SCALE = 1.2
BOXES = {
    "ship_a": (60, 35, 380, 410),
    "ship_b": (440, 35, 760, 410),
    "stone_a": (55, 435, 350, 735),
    "stone_b": (375, 435, 670, 735),
    "stone_debris_a": (700, 435, 1000, 735),
    "metal_a": (1015, 435, 1315, 735),
    "metal_b": (1340, 430, 1635, 735),
    "ice_a": (1665, 430, 1945, 735),
    "stone_c": (55, 765, 350, 1070),
    "stone_cracked": (375, 765, 670, 1070),
    "stone_debris_b": (700, 765, 1000, 1070),
    "metal_c": (1015, 765, 1315, 1070),
    "ice_b": (1355, 765, 1625, 1070),
    "ice_shards": (1665, 765, 1945, 1070),
    "laser_a": (100, 1145, 455, 1235),
    "laser_b": (140, 1285, 455, 1410),
    "spark_a": (665, 1100, 950, 1245),
    "spark_b": (700, 1255, 940, 1430),
    "explosion": (1090, 1110, 1430, 1430),
    "smoke": (1540, 1115, 1875, 1415),
}


def is_background(px: np.ndarray) -> np.ndarray:
    r, g, b = (px[..., i].astype(int) for i in range(3))
    return (b - r >= 8) & (b >= 20) & (b <= 100)


def cut(img: np.ndarray, box) -> Image.Image:
    x0, y0, x1, y1 = (round(v * SCALE) for v in box)
    crop = img[y0:y1, x0:x1]
    h, w = crop.shape[:2]
    bg = is_background(crop)
    clear = np.zeros((h, w), dtype=bool)
    queue = deque()
    for x in range(w):
        queue.extend([(0, x), (h - 1, x)])
    for y in range(h):
        queue.extend([(y, 0), (y, w - 1)])
    while queue:
        y, x = queue.popleft()
        if clear[y, x] or not bg[y, x]:
            continue
        clear[y, x] = True
        if y > 0: queue.append((y - 1, x))
        if y < h - 1: queue.append((y + 1, x))
        if x > 0: queue.append((y, x - 1))
        if x < w - 1: queue.append((y, x + 1))
    alpha = np.where(clear, 0, 255).astype(np.uint8)
    rgba = np.dstack([crop, alpha])
    out = Image.fromarray(rgba, "RGBA")
    out = out.crop(out.getbbox())
    out.thumbnail((MAX_SIZE, MAX_SIZE), Image.LANCZOS)
    return out


def main():
    img = np.array(Image.open(SRC).convert("RGB"))
    OUT.mkdir(parents=True, exist_ok=True)
    for name, box in BOXES.items():
        sprite = cut(img, box)
        sprite.save(OUT / f"{name}.png", optimize=True)
        print(f"{name:16s} {sprite.size}")


if __name__ == "__main__":
    main()
