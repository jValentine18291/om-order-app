#!/usr/bin/env python3
"""
tools/ipl-ocr-callouts.py
=========================
Finds the callout numbers on a SCANNED IPL drawing and reports where they sit.

Most Zenoah books carry their callout numbers as real text, and
tools/ipl-extract.js lifts the coordinates straight out of the PDF. The older
ones - roughly one in four, and everything before about 2015 - are scans, where
the numbers are part of the picture. This reads them instead.

    python tools/ipl-ocr-callouts.py "<IPL.pdf>" <page> <key,key,key,...>

Prints JSON: [{"key": "27", "x": 41.2, "y": 63.8, "conf": 96}, ...]
x and y are percentages of the page, the same as the extractor emits.

WHY NOT JUST RUN TESSERACT OVER THE PAGE
Because it merges neighbours. Callouts sit close together - "26" beside "27" -
and page-level OCR reads them as one token "2627", which matches no key and is
dropped. Whole-page OCR found 37 of the G3800's 52 callouts; nearly every miss
was a merged pair. So each callout is cut out first, by finding the ink and
grouping it, and read on its own.

Two things keep the readings honest:
  - the number must match a key in that figure's parts table, and
  - it is read twice, at two scales, and both must agree.
A callout that fails either is dropped rather than guessed at, so a wrong
hotspot is far less likely than a missing one.

Needs Pillow, numpy, scipy, and Tesseract (POPPLER_BIN / TESSERACT_BIN, or on
PATH).
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy import ndimage

DPI = 300
POPPLER = os.environ.get("POPPLER_BIN", "")
TESSERACT = os.environ.get("TESSERACT_BIN", "")


def tool(name):
    base = POPPLER if name.startswith("pdf") else TESSERACT
    return os.path.join(base, name) if base else name


def render(pdf, page):
    out = os.path.join(tempfile.gettempdir(), f"ipl-ocr-{os.getpid()}")
    subprocess.run(
        [tool("pdftoppm"), "-png", "-r", str(DPI), "-f", str(page), "-l", str(page),
         "-singlefile", pdf, out],
        check=True, capture_output=True,
    )
    return out + ".png"


def read_one(crop, scale):
    """Read a single cropped callout. --psm 8 is 'one word', which is what a
    callout is once it has been cut out."""
    big = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
    path = os.path.join(tempfile.gettempdir(), f"ipl-crop-{os.getpid()}-{scale}.png")
    big.save(path)
    r = subprocess.run(
        [tool("tesseract"), path, "stdout", "--psm", "8",
         "-c", "tessedit_char_whitelist=0123456789ABCD", "tsv"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    best = ("", -1.0)
    for line in r.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) >= 12 and f[11].strip():
            conf = float(f[10])
            if conf > best[1]:
                best = (f[11].strip(), conf)
    try:
        os.remove(path)
    except OSError:
        pass
    return best


def survey(png, keys):
    """One pass over the whole page, for the two things it is good at even
    though it merges neighbouring callouts: how tall a callout is on this
    drawing, and where the lettering is.

    Returns (median callout height in px, boxes of words containing letters).
    """
    r = subprocess.run(
        [tool("tesseract"), png, "stdout", "--psm", "11", "tsv"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    hs, words = [], []
    for line in r.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        txt = f[11].strip()
        x, y, w, h = int(f[6]), int(f[7]), int(f[8]), int(f[9])
        if txt in keys:
            hs.append(h)
        # "Fig. 1 POWER UNIT" is lettering, and its 1 is a clean printed glyph
        # that reads at 96% confidence — the single most confident false
        # callout on the page, which is why confidence alone cannot filter it.
        # Note where the words are so their digits can be skipped.
        if any(c.isalpha() for c in txt) and float(f[10]) >= 50:
            words.append((x, y, x + w, y + h))
    return (float(np.median(hs)) if len(hs) >= 5 else None), words


def callouts(pdf, page, keys, max_y=100.0):
    png = render(pdf, page)
    im = Image.open(png).convert("L")
    W, H = im.size
    # Some figures print the drawing and its parts table on one sheet. The
    # table's Key# column is a column of small numbers that all match a key, so
    # without a limit every one of them becomes a hotspot down the parts list.
    # max_y is where the drawing stops, as a percentage of the page.
    limit = H * max_y / 100.0
    ink = np.array(im) < 128
    if limit < H:
        ink[int(limit):, :] = False

    # Every blob of ink on the page. A callout digit is a blob; so is every
    # line of the drawing, which is why they get filtered by shape next.
    lab, n = ndimage.label(ink, structure=np.ones((3, 3), int))
    objs = ndimage.find_objects(lab)

    # How tall is a callout? Ask Tesseract. A pass over the whole page is poor
    # at separating neighbours but perfectly good at sizing what it does read,
    # and the callouts on a given drawing are strikingly uniform - 31 to 33px
    # at 300dpi on the G3800.
    #
    # Measuring it from the blobs instead does not work: the drawing's own
    # small marks outnumber the digits, so the median blob is 16px and a filter
    # built around it excludes every callout. That version placed 7.
    med, words = survey(png, keys)
    if not med:
        return []
    lo, hi = med * 0.78, med * 1.28

    def in_lettering(x1, y1, x2, y2):
        """Is this candidate sitting in, or right beside, a word?"""
        pad = med * 0.8
        return any(
            x2 > wx1 - pad and x1 < wx2 + pad and y2 > wy1 - pad and y1 < wy2 + pad
            for wx1, wy1, wx2, wy2 in words
        )

    glyphs = []
    for s in objs:
        h = s[0].stop - s[0].start
        w = s[1].stop - s[1].start
        if not (lo <= h <= hi):
            continue
        # Width matters more than it looks. A printed digit in these books is
        # about two thirds as wide as it is tall, and even a "1" - with its
        # flag and base - is a good third. A bare line from the drawing is a
        # twentieth, and Tesseract reads a lone vertical stroke as "1" with
        # real confidence, so a loose lower bound put six false "1"s on the
        # first figure and confidence could not tell them apart.
        if w > h * 1.6 or w < h * 0.30:
            continue
        glyphs.append([s[1].start, s[0].start, s[1].stop, s[0].stop])

    # Group digits into numbers: same line, touching distance apart.
    glyphs.sort(key=lambda g: (g[1], g[0]))
    groups = []
    for g in glyphs:
        placed = False
        for grp in groups:
            same_line = abs(g[1] - grp[1]) < med * 0.55
            near = 0 <= g[0] - grp[2] < med * 0.55
            if same_line and near:
                grp[0] = min(grp[0], g[0]); grp[1] = min(grp[1], g[1])
                grp[2] = max(grp[2], g[2]); grp[3] = max(grp[3], g[3])
                placed = True
                break
        if not placed:
            groups.append(list(g))

    pad = int(med * 0.45)
    spots = []
    for x1, y1, x2, y2 in groups:
        if in_lettering(x1, y1, x2, y2):
            continue
        crop = im.crop((max(0, x1 - pad), max(0, y1 - pad),
                        min(W, x2 + pad), min(H, y2 + pad)))
        # Read twice at different scales; disagreement means drop it.
        a, ca = read_one(crop, 3)
        if a not in keys:
            continue
        b, cb = read_one(crop, 5)
        if b != a:
            continue
        spots.append({
            "key": a,
            "x": round((x1 + x2) / 2 / W * 100, 3),
            "y": round((y1 + y2) / 2 / H * 100, 3),
            "conf": round(min(ca, cb)),
        })

    try:
        os.remove(png)
    except OSError:
        pass

    # The same key can legitimately be called out twice; identical duplicates
    # from one blob split two ways cannot.
    seen, out = set(), []
    for s in sorted(spots, key=lambda s: (s["key"], s["x"])):
        tag = (s["key"], round(s["x"], 1), round(s["y"], 1))
        if tag in seen:
            continue
        seen.add(tag)
        out.append(s)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit('Usage: ipl-ocr-callouts.py "<IPL.pdf>" <page> <key,key,...> [max-y%]')
    keys = set(k for k in sys.argv[3].split(",") if k)
    max_y = float(sys.argv[4]) if len(sys.argv) > 4 else 100.0
    print(json.dumps(callouts(sys.argv[1], int(sys.argv[2]), keys, max_y)))
