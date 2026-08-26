#!/usr/bin/env python3
"""
tools/build-brand-logos.py
==========================
Builds the brand plates shown on each heading of the IPL picker, from the logo
files marketing keeps at:

    M:\\SALES_&_MARKETING\\WEBSITE IMAGES\\Brand Logos

Run it when a brand is added or its logo is redrawn:

    python tools/build-brand-logos.py

Writes frontend/ipl/brands/<brand>.png, one per brand, and prints the CSS width
of each - which has to go into IPL_BRAND_COLOUR in frontend/app.js so the
browser reserves the right space and the heading does not jump.

WHY A PLATE RATHER THAN THE BARE LOGO
These seven were drawn for different grounds. Husqvarna's is white on navy,
Zenoah's is white lettering that disappears entirely on a white page, and the
rest are coloured artwork made for white. Dropping them all onto the app's
background would lose two of them, so each is baked onto the ground its artwork
expects, trimmed, and sized to one common height.

Needs Pillow: python -m pip install pillow
(Node has no image library in this project, so this one tool is Python.)
"""

import os
import sys

from PIL import Image

BRAND_DIR = "M:/SALES_&_MARKETING/WEBSITE IMAGES/Brand Logos"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "ipl", "brands")

PLATE_H = 60     # 2x, so a 30px-tall plate stays sharp on a phone screen
PAD = 6          # inner margin, in plate pixels - NOT derived from the source
MAX_W = 168      # 2x of 84px: a wide wordmark must not crowd the brand name

BRANDS = [
    # key            source file                                          plate ground
    ("husqvarna",   "P:/1-SCAN/husqvarna-presentation/assets/images/logo-husqvarna-navy.png", "#183060"),
    ("zenoah",      f"{BRAND_DIR}/Zenoah/Zenoah Logo Dark (No BG).png",   "#000000"),
    ("grasshopper", f"{BRAND_DIR}/Grasshopper/Grasshopper Logo.png",      "#ffffff"),
    ("pulsfog",     f"{BRAND_DIR}/PulsFOG/PulsFOG Logo.png",              "#ffffff"),
    ("rayco",       f"{BRAND_DIR}/Rayco/Rayco.jpg",                       "#ffffff"),
    ("ferris",      f"{BRAND_DIR}/Ferris/Ferris Logo.png",                "#ffffff"),
    ("billygoat",   f"{BRAND_DIR}/Billygoat/Billy Goat Logo.jpg",         "#ffffff"),
]


def parse(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


def content_box(im, bg):
    """Bounding box of everything that is neither transparent nor the plate
    colour. Pillow's getbbox is no use on its own here: half of these files are
    flattened JPEGs with a solid background baked in, so there is no alpha to
    measure."""
    px = im.load()
    w, h = im.size
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 24:
                continue
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 40:
                continue
            x0, y0 = min(x0, x), min(y0, y)
            x1, y1 = max(x1, x), max(y1, y)
    return None if x1 < x0 else (x0, y0, x1 + 1, y1 + 1)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    widths, total = [], 0

    for key, src, bg_hex in BRANDS:
        if not os.path.exists(src):
            print(f"  {key:12s} SKIPPED - not found: {src}")
            continue

        bg = parse(bg_hex)
        im = Image.open(src).convert("RGBA")
        im.thumbnail((400, 400))

        box = content_box(im, bg)
        if not box:
            print(f"  {key:12s} FAILED - nothing found against {bg_hex}")
            return 1
        art = im.crop(box)

        # The inner margin belongs to the plate, not to the source image.
        # Deriving it from the artwork made it 40px on the larger files, which
        # drove the scale negative and printed Ferris and Billy Goat as a
        # single pixel.
        scale = min((PLATE_H - PAD * 2) / art.height, (MAX_W - PAD * 2) / art.width)
        art = art.resize(
            (max(1, round(art.width * scale)), max(1, round(art.height * scale))),
            Image.LANCZOS,
        )

        plate = Image.new("RGBA", (art.width + PAD * 2, PLATE_H), bg + (255,))
        plate.alpha_composite(art, (PAD, (PLATE_H - art.height) // 2))

        out = os.path.join(OUT_DIR, f"{key}.png")
        plate.convert("RGB").save(out, optimize=True)

        # A blank plate is the failure that slips through, because it still
        # writes a valid PNG of the right size. Count the colours and refuse.
        colours = len(plate.convert("RGB").getcolors(70000) or [])
        if colours < 20:
            print(f"  {key:12s} FAILED - only {colours} colours, the plate is blank")
            return 1

        kb = os.path.getsize(out) / 1024
        total += kb
        widths.append((key, plate.width // 2))
        print(f"  {key:12s} {plate.width // 2:>3}x{PLATE_H // 2} css px  {colours:>5} colours  {kb:5.1f}KB")

    print(f"\n  {len(widths)} plates, {total:.1f}KB total")
    print("\n  widths for IPL_BRAND_COLOUR in frontend/app.js:")
    for key, w in widths:
        print(f"    {key}: w: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
