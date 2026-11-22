#!/usr/bin/env python3
"""Cut the sprites out of the sprite sheets in assets/ into transparent PNGs.

The sheets have no real alpha channel: spritesheet.jpeg sits on a dark-navy grid,
spritesheet2.webp on a *painted* grey checkerboard. For each sprite we crop a box
and flood-fill the background from the crop's border. Each sheet has its own test
for "background colour"; sprites have near-black outlines, so the fill stops at
their edge and interior pixels are never touched, even if they share a colour
with the background.

Usage: python3 tools/extract_sprites.py   (requires Pillow + numpy)
"""
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
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


# Sheet 2: explosive asteroid frames and the ship's destruction, in original pixels.
BOXES_2 = {
    "explosive": (40, 30, 320, 305),
    "explosive_cracking": (370, 25, 650, 305),
    "explosive_burst": (700, 35, 990, 305),
    "ship_hit": (35, 415, 345, 725),
    "ship_breaking": (380, 420, 690, 725),
    "ship_wreck": (730, 410, 1000, 712),
}


def navy_grid(px: np.ndarray, x0: int, y0: int) -> np.ndarray:
    """Sheet 1: the navy fill and grid lines are dark and bluish."""
    r, g, b = (px[..., i].astype(int) for i in range(3))
    return (b - r >= 8) & (b >= 20) & (b <= 100)


def grey_checkerboard(px: np.ndarray, x0: int, y0: int) -> np.ndarray:
    """Sheet 2: a painted checkerboard with 25.6 px squares (~59 / ~112 grey, plus a
    lighter band). Grey parts of the ship would match a plain colour test, so we work out
    which colour each square *should* be (its most frequent grey) and only accept pixels
    matching that. Pixels on a square's edge are blended, so there any background grey is fine."""
    full = SHEET2_EXPECTED
    exp = full["expected"][y0:y0 + px.shape[0], x0:x0 + px.shape[1]]
    edge = full["on_edge"][y0:y0 + px.shape[0], x0:x0 + px.shape[1]]
    v, neutral = grey_value(px)
    return neutral & ((np.abs(v - exp) <= 10) | (edge & (v >= 50) & (v <= 125)))


def grey_value(px: np.ndarray):
    r, g, b = (px[..., i].astype(int) for i in range(3))
    v = (r + g + b) // 3
    neutral = (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)) <= 8
    return v, neutral


def checkerboard_model(img: np.ndarray, size: float = 25.6, ox: float = 0.6, oy: float = -1.6):
    h, w = img.shape[:2]
    v, neutral = grey_value(img)
    ys, xs = np.mgrid[0:h, 0:w]
    cx, cy = np.floor((xs - ox) / size).astype(int), np.floor((ys - oy) / size).astype(int)
    expected = np.zeros((h, w), dtype=int)
    for j in range(cy.min(), cy.max() + 1):
        for i in range(cx.min(), cx.max() + 1):
            cell = (cx == i) & (cy == j)
            # The most frequent grey in the square is its background colour: sprite pixels
            # are varied, the painted square is flat (the band's squares are other shades).
            vals = v[cell & neutral]
            vals = vals[(vals >= 46) & (vals <= 128)]
            expected[cell] = int(np.argmax(np.bincount(vals))) if len(vals) else 0
    fx, fy = (xs - ox) / size, (ys - oy) / size
    on_edge = (np.abs(fx - np.round(fx)) * size < 1.5) | (np.abs(fy - np.round(fy)) * size < 1.5)
    return {"expected": expected, "on_edge": on_edge}


SHEET2_EXPECTED = None


SHEETS = [
    ("spritesheet.jpeg", SCALE, navy_grid, BOXES),
    ("spritesheet2.webp", 1.0, grey_checkerboard, BOXES_2),
]


def cut(img: np.ndarray, box, scale: float, is_background) -> Image.Image:
    x0, y0, x1, y1 = (round(v * scale) for v in box)
    crop = img[y0:y1, x0:x1]
    h, w = crop.shape[:2]
    bg = is_background(crop, x0, y0)
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
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, scale, is_background, boxes in SHEETS:
        img = np.array(Image.open(ROOT / "assets" / filename).convert("RGB"))
        if is_background is grey_checkerboard:
            global SHEET2_EXPECTED
            SHEET2_EXPECTED = checkerboard_model(img)
        for name, box in boxes.items():
            sprite = cut(img, box, scale, is_background)
            sprite.save(OUT / f"{name}.png", optimize=True)
            print(f"{name:20s} {sprite.size}")


if __name__ == "__main__":
    main()
