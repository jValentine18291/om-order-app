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


def read_one(crop, scale, psm):
    """Read a single cropped callout at one scale, in one segmentation mode."""
    big = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
    path = os.path.join(tempfile.gettempdir(), f"ipl-crop-{os.getpid()}-{scale}.png")
    big.save(path)
    r = subprocess.run(
        [tool("tesseract"), path, "stdout", "--psm", str(psm),
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
        #
        # But a key can carry a letter of its own: the G3800's accessories are
        # 4A and 4B for the 14" and 16" bars. Treating a single letter as
        # lettering threw away all six of those - the bars, chains and
        # protectors, which are among the parts most often ordered.
        # Confidence has to be high, not merely decent. The real lettering on
        # these pages is set clean and reads at 93-97% ("Fig.", "POWER",
        # "UNIT"). Everything between 50 and 75 was Tesseract finding letters
        # in the line drawing - "oe", "Ms", "ZZ", "Ber", "xX" - and one of
        # those, an "oe" spanning 216x80 pixels of dashed rectangle, sat right
        # on top of callout 39 and excluded it.
        letters = sum(1 for c in txt if c.isalpha())
        if letters >= 2 and txt not in keys and float(f[10]) >= 80:
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
    for idx, s in enumerate(objs):
        h = s[0].stop - s[0].start
        w = s[1].stop - s[1].start
        if not (lo <= h <= hi):
            continue
        # How much of the box is actually ink. A printed digit is a solid
        # thing and fills a third to a half of its box; the corner of a dashed
        # rectangle fills an eighth, and Tesseract read one of those as a "4"
        # at 79% confidence, right between callouts 14 and 15. Confidence
        # cannot tell them apart but density can: on this book every genuine
        # digit is above 0.25 and every piece of line art below 0.22.
        blob = lab[s] == idx + 1
        if blob.sum() / blob.size < 0.24:
            continue
        # Width matters more than it looks. A printed digit in these books is
        # about two thirds as wide as it is tall, and even a "1" - with its
        # flag and base - is a good third. A bare line from the drawing is a
        # twentieth, and Tesseract reads a lone vertical stroke as "1" with
        # real confidence, so a loose lower bound put six false "1"s on the
        # first figure and confidence could not tell them apart.
        if w > h * 1.6 or w < h * 0.30:
            continue
        glyphs.append([s[1].start, s[0].start, s[1].stop, s[0].stop, 1])

    # Group digits into numbers: same line, touching distance apart.
    #
    # Sorted by row band and then by x, NOT by raw y then x. Sorting on the raw
    # top edge put the "0" of "70" one pixel higher than its own "7", so the
    # zero was visited first and the seven - being to its LEFT - failed a test
    # that only ever looked rightwards. The pair never joined: the figure ended
    # up with a "70" hotspot and a stray "7" on the same printed number, and
    # tapping it could give either part.
    band = max(1.0, med * 0.6)
    glyphs.sort(key=lambda g: (int(g[1] / band), g[0]))
    groups = []
    for g in glyphs:
        placed = False
        for grp in groups:
            same_line = abs(g[1] - grp[1]) < med * 0.55
            # Height has to match, or a drawn part standing beside a number
            # gets taken for another digit: a small bolt beside callout 38
            # joined it, the crop read "383", and that callout was lost.
            #
            # The GAP stays generous. Tightening it to 0.35 looked reasonable -
            # real digits sit 3 to 4 pixels apart - and split genuine pairs
            # across three figures instead, leaving "15" as a "1" and a "5"
            # sitting side by side, each matching a key of its own. Two rings
            # on one number is the fault we are trying to remove, so the height
            # test does the work and the distance stays where it was.
            similar_height = abs((g[3] - g[1]) - (grp[3] - grp[1])) < med * 0.25
            # Distance between the two boxes whichever way round they sit;
            # negative means they overlap.
            gap = max(g[0] - grp[2], grp[0] - g[2])
            if same_line and similar_height and gap < med * 0.55:
                grp[0] = min(grp[0], g[0]); grp[1] = min(grp[1], g[1])
                grp[2] = max(grp[2], g[2]); grp[3] = max(grp[3], g[3])
                grp[4] += 1          # how many glyphs this number is made of
                placed = True
                break
        if not placed:
            groups.append(list(g))

    def crowding(x1, y1, x2, y2):
        """How much ink surrounds this candidate. A printed callout stands in
        clear paper with a thin leader line touching it, so almost nothing is
        around it. A shape that merely looks like a digit — a cut-out in a
        gasket, say — is embedded in artwork and hemmed in on every side."""
        r = int(med * 0.75)
        oy0, oy1 = max(0, y1 - r), min(H, y2 + r)
        ox0, ox1 = max(0, x1 - r), min(W, x2 + r)
        outer = ink[oy0:oy1, ox0:ox1]
        inner = ink[y1:y2, x1:x2]
        around = outer.size - inner.size
        return (outer.sum() - inner.sum()) / max(1, around)

    pad = int(med * 0.45)
    spots = []
    for x1, y1, x2, y2, nglyphs in groups:
        if in_lettering(x1, y1, x2, y2):
            continue
        # Measured across a whole figure: every genuine callout sits under
        # 0.062, most under 0.02, while the gasket cut-out that Tesseract read
        # as "24" sat at 0.192. Three times clear of anything real.
        if crowding(x1, y1, x2, y2) > 0.12:
            continue
        crop = im.crop((max(0, x1 - pad), max(0, y1 - pad),
                        min(W, x2 + pad), min(H, y2 + pad)))

        # Two segmentation modes, because neither wins on its own. "one word"
        # is the better all-rounder but returns nothing at all for "11" — two
        # identical thin strokes it will not commit to. "one text line" reads
        # that at 94%, and "70" at 97% against 83%, but loses seven other
        # callouts on the same figure. Asking the second only when the first
        # finds nothing usable gets 96% where either alone gets 87.
        #
        # Within a mode the crop is read at two scales and both must agree,
        # which is what stops a doubtful glyph becoming a confident wrong part.
        hit = None
        for psm in (8, 7):
            a, ca = read_one(crop, 3, psm)
            # The reading has to account for every glyph in the group. On these
            # scans one blob is one character, so a two-glyph number read as a
            # single digit is a partial reading — and a partial reading is not
            # a miss, it is a wrong part: "11" on the carburetor figure came
            # back as "1", putting CARBURETOR ASS'Y on the shaft's callout.
            # Confidence gives no warning at all here; that one read as 0, and
            # so do dozens of perfectly good callouts.
            if a not in keys or len(a) != nglyphs:
                continue
            b, cb = read_one(crop, 5, psm)
            if b == a:
                hit = (a, min(ca, cb))
                break
        if not hit:
            continue

        spots.append({
            "key": hit[0],
            "x": round((x1 + x2) / 2 / W * 100, 3),
            "y": round((y1 + y2) / 2 / H * 100, 3),
            "conf": round(hit[1]),
            "box": (x1, y1, x2, y2),
        })

    try:
        os.remove(png)
    except OSError:
        pass

    # Two hotspots on one printed number is worse than none: tapping "70" could
    # give part 7. Grouping is fixed so it should not happen, but a scan can
    # always break a digit apart in some new way, so refuse to emit an
    # overlapping pair. The longer reading wins - a fragment is a piece of the
    # whole number, never the other way round.
    def overlaps(p, q):
        return (p["box"][0] < q["box"][2] and q["box"][0] < p["box"][2]
                and p["box"][1] < q["box"][3] and q["box"][1] < p["box"][3])

    spots.sort(key=lambda s: (-len(s["key"]), -s["conf"]))
    kept = []
    for s in spots:
        if any(overlaps(s, k) for k in kept):
            continue
        kept.append(s)

    # The same key can legitimately be called out twice; identical duplicates
    # from one blob read two ways cannot.
    seen, out = set(), []
    for s in sorted(kept, key=lambda s: (s["key"], s["x"])):
        tag = (s["key"], round(s["x"], 1), round(s["y"], 1))
        if tag in seen:
            continue
        seen.add(tag)
        out.append({k: v for k, v in s.items() if k != "box"})
    return out


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit('Usage: ipl-ocr-callouts.py "<IPL.pdf>" <page> <key,key,...> [max-y%]')
    keys = set(k for k in sys.argv[3].split(",") if k)
    max_y = float(sys.argv[4]) if len(sys.argv) > 4 else 100.0
    print(json.dumps(callouts(sys.argv[1], int(sys.argv[2]), keys, max_y)))
