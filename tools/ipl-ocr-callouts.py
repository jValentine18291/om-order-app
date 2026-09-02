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

# 300 suits the older Zenoah scans. The EBZ3000RH's engine drawing is finer,
# and its assembly callouts sit against dash-dot boundary lines that merge
# with the digits at 300 - twenty of them were lost that way. Overridable so a
# book can be read at the resolution it needs.
DPI = int(os.environ.get("IPL_OCR_DPI", "300"))
POPPLER = os.environ.get("POPPLER_BIN", "")
TESSERACT = os.environ.get("TESSERACT_BIN", "")
DEBUG = os.environ.get("IPL_OCR_DEBUG", "") not in ("", "0")


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


def enclosed(mask):
    """How many holes a shape has — background regions it closes off entirely.
    Padding with background first means the paper around the shape is one
    region connected to the outside, so only true holes are counted."""
    padded = np.pad(~mask, 1, constant_values=True)
    _, n = ndimage.label(padded)
    return n - 1


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
        # Every character we accept is taller than it is wide. Measured across
        # all 358 glyphs of every accepted callout in this book: 0.34 at the
        # narrowest, 0.88 at the widest — and 0.88 is the "A" of 4A, 5A and 6A,
        # the bar and chain options, so the ceiling cannot go below that. A
        # screw drawn below callout 60 is 1.10 and read as "2".
        if w < h * 0.30:
            continue
        # Above that ceiling the blob is not one character - but on this book it
        # is very often two, printed touching. The G621AVS sets "106" with the 0
        # and 6 joined, and "90" likewise; connected-component labelling sees one
        # shape, it failed the ceiling, and all that survived was the lone "1" -
        # a false hotspot for part 1 where 106 should have been, and 106 itself
        # unreachable. Nine callouts on Fig.1 went that way.
        #
        # Two digits at their widest measure 0.850 each, so a touching pair
        # reaches about 1.7; 1.90 allows for the join. Wider than that is not a
        # number and is still refused. Admitting the pair is not a loosening:
        # the blob is now declared to be TWO characters, so a reading has to
        # produce two that match a key. The drawn screw that once read as "2"
        # cannot satisfy that, where before only its width excluded it.
        if w <= h * 0.95:
            nsub = 1
        elif w <= h * 1.90:
            nsub = 2
        else:
            continue
        # How many enclosed spaces the shape has. No character we accept has
        # more than two — "8" has two, "0", "4", "6", "9", "A", "B", "D" have
        # one or two, the rest none. A drawn part often has more: the screw head
        # below callout 63 has three and read as "8", and a fitting beside
        # callout 48 has four and read as "5". Both sat within every other
        # measure, and both are single digits, which is where a false reading
        # does real harm - it matches a key on its own.
        # Per character, so a touching pair is allowed its two shares: "08"
        # joined has three holes between them and would fail a flat limit.
        if enclosed(blob) > 2 * nsub:
            continue
        glyphs.append([s[1].start, s[0].start, s[1].stop, s[0].stop, nsub,
                       [(s[1].start, s[0].start, s[1].stop, s[0].stop, nsub)]])

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
    if DEBUG:
        print(f"med={med:.1f} same_line<{med*0.15:.1f} "
              f"height<{med*0.25:.1f} gap<{med*0.55:.1f}", file=sys.stderr)
    def can_join(a, b):
        """Are these two boxes parts of one printed number?

        Digits of one number are set on a shared baseline and their tops agree
        to within a tenth of a glyph height — measured across all four figures,
        758 same-line pairs, none between 0.10 and 0.20. Two SEPARATE callouts
        standing side by side do not agree nearly so well: "54" and "51" sit
        0.36 apart on Fig.2, and a tolerance of 0.55 let the "4" of 54 join the
        51 beside it. That left "541", which matches no key and was dropped, and
        a widowed "5" — which does match a key, so callout 54 offered part 5.

        Height has to match too, or a drawn part standing beside a number gets
        taken for another digit: a small bolt beside callout 38 joined it, the
        crop read "383", and that callout was lost.

        The GAP stays generous. Tightening it to 0.35 looked reasonable — real
        digits sit 3 to 4 pixels apart — and split genuine pairs across three
        figures instead, leaving "15" as a "1" and a "5" side by side, each
        matching a key of its own.
        """
        same_line = abs(a[1] - b[1]) < med * 0.15
        similar_height = abs((a[3] - a[1]) - (b[3] - b[1])) < med * 0.25
        # Distance whichever way round they sit; negative means they overlap.
        gap = max(b[0] - a[2], a[0] - b[2])
        return same_line and similar_height and gap < med * 0.55

    def absorb(a, b):
        a[0] = min(a[0], b[0]); a[1] = min(a[1], b[1])
        a[2] = max(a[2], b[2]); a[3] = max(a[3], b[3])
        a[4] += b[4]        # how many characters this number is made of
        a[5].extend(b[5])   # and the box of each, kept for the width check

    groups = []
    for g in glyphs:
        placed = False
        for grp in groups:
            if can_join(grp, g):
                absorb(grp, g)
                placed = True
                break
        if not placed:
            groups.append(list(g))

    # Belonging to the same number is symmetric, so the answer must not depend
    # on which digit was visited first — and it did. The three digits of "114"
    # are set with the "4" one pixel higher than the two "1"s, and the sort
    # buckets rows by band: 1600 and 1601 fall either side of a band boundary,
    # so the "4" was visited a whole row early, made its own group, and was too
    # far from the "1"s to be taken back. The book showed "1" and "14" as two
    # separate hotspots on one printed number, and part 114 was unreachable.
    #
    # Merging until nothing more can merge removes the dependency on order
    # altogether, and with it a whole class of one-pixel accidents.
    changed = True
    while changed:
        changed = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if can_join(groups[i], groups[j]):
                    absorb(groups[i], groups[j])
                    groups.pop(j)
                    changed = True
                    break
            if changed:
                break

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

    # A "1" is unmistakably narrower than any other character, and that settles
    # the one confusion Tesseract cannot: 11 against 17. On the G621AVS's
    # accessories the printed "11" read as 17 five times out of six, because a
    # crop tight enough to isolate it is too tight to show the 7 has no bar.
    # The shape does not care about the crop.
    #
    # Measured over all 347 glyphs of every accepted callout in this book's two
    # largest figures: "1" runs 0.318 to 0.400 of its own height, and every
    # other digit 0.591 to 0.850. Nothing lands between. The threshold sits in
    # that gap, a quarter clear of the widest "1" and a fifth clear of the
    # narrowest of the rest.
    ONE_MAX_RATIO = 0.50

    def width_agrees(reading, boxes):
        """Does each character match the shape of the blob it claims to be?

        A blob holding two touching digits is skipped rather than guessed at:
        its width says nothing about either character on its own."""
        if sum(b[4] for b in boxes) != len(reading):
            return False
        i = 0
        for b in sorted(boxes, key=lambda b: b[0]):
            if b[4] == 1:
                narrow = (b[2] - b[0]) / max(1, b[3] - b[1]) < ONE_MAX_RATIO
                if (reading[i] == "1") != narrow:
                    return False
            i += b[4]
        return True

    # How much paper to leave round the crop, and which segmentation mode.
    # Tried in order, first full reading wins, so an easy callout still costs
    # one attempt. Padding is not a detail: on Fig.2 the "59" read as "5" at
    # 14px of margin, and as "59" at 85-90% confidence at 10px. Tesseract is
    # simply sensitive to what else falls inside the box, and there is no way
    # to know in advance which framing suits a given number.
    CROPS = [(int(med * 0.45), 8), (int(med * 0.45), 7),
             (int(med * 0.30), 8), (int(med * 0.30), 7),
             (int(med * 0.60), 8), (int(med * 0.60), 7)]

    spots = []
    for x1, y1, x2, y2, nglyphs, boxes in groups:
        if in_lettering(x1, y1, x2, y2):
            continue
        # Measured across a whole figure: every genuine callout sits under
        # 0.062, most under 0.02, while the gasket cut-out that Tesseract read
        # as "24" sat at 0.192. Three times clear of anything real.
        #
        # A lone NARROW glyph is held to a stricter standard. Narrow means it
        # can only be read as a "1" (see the width test below), and that is the
        # one shape the drawing itself produces all the time: a slot milled in a
        # bracket on the G621AVS is the same height, width, ink density and hole
        # count as a printed 1, and put part 1 on that bracket. No other digit
        # is at that risk - line art rarely closes a curve to exactly callout
        # height - so no other digit pays for it.
        #
        # Holding every lone character to this was the wrong rule and cost a
        # real one: the "6" beside callout 17 on Fig.3 sits at 0.074 and was
        # thrown away. Genuine lone "1"s measure 0.002, 0.003, 0.012 and 0.041
        # across the two books; the slot is 0.089. The limit is the midpoint of
        # those two - and it is a thin margin, about 1.5x either way, so a book
        # that breaks it should be looked at rather than trusted.
        narrow_single = (
            nglyphs == 1 and len(boxes) == 1 and
            (boxes[0][2] - boxes[0][0]) / max(1, boxes[0][3] - boxes[0][1]) < ONE_MAX_RATIO
        )
        crowd_limit = 0.06 if narrow_single else 0.12
        if crowding(x1, y1, x2, y2) > crowd_limit:
            continue
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
        ballot = {}   # every reading this glyph got, across all framings
        for pad2, psm in CROPS:
            crop = im.crop((max(0, x1 - pad2), max(0, y1 - pad2),
                            min(W, x2 + pad2), min(H, y2 + pad2)))
            a, ca = read_one(crop, 3, psm)
            # The reading has to account for every glyph in the group. On these
            # scans one blob is one character, so a two-glyph number read as a
            # single digit is a partial reading — and a partial reading is not
            # a miss, it is a wrong part: "11" on the carburetor figure came
            # back as "1", putting CARBURETOR ASS'Y on the shaft's callout.
            # Confidence gives no warning at all here; that one read as 0, and
            # so do dozens of perfectly good callouts.
            if a not in keys or len(a) != nglyphs or not width_agrees(a, boxes):
                continue
            # Best of three scales rather than agreement between two. Fig.2's
            # "11" reads as 11, 11, 17 across scales — one dissenting "17" was
            # enough to veto it under the old rule, and the callout was lost.
            # A majority still means a wrong number needs two independent
            # readings to agree on it, which is the point of the check.
            votes = [(a, ca)] + [read_one(crop, sc, psm) for sc in (4, 5)]
            tally = {}
            for t, c in votes:
                # A vote for a reading the shapes contradict is not evidence.
                if t in keys and width_agrees(t, boxes):
                    tally.setdefault(t, []).append(c)
            for t, cs in tally.items():
                ballot.setdefault(t, []).extend(cs)
            # Unanimous, so nothing later can outweigh it: take it and stop.
            # Anything short of that is a glyph the reader is unsure of, and
            # stopping at the first bare majority let one unlucky framing
            # settle it. The G621AVS's accessories "11" read as 11 ten times
            # out of twelve across the crops, and shipped as 17 - the one
            # crop that happened to agree with itself first decided it, and
            # put the piston-pin guide's number on the rotor puller.
            if len(tally.get(a, [])) == 3:
                hit = (a, min(tally[a]))
                break
        # No crop was certain. Decide on the whole ballot rather than on
        # whichever framing was asked first: most readings wins, and ties go
        # to the better-supported one. Still at least two agreeing readings,
        # so a single stray glyph never becomes a part number.
        if not hit and ballot:
            best = max(ballot.items(), key=lambda kv: (len(kv[1]), sum(kv[1])))
            if len(best[1]) >= 2:
                hit = (best[0], min(best[1]))

        # Set IPL_OCR_DEBUG=1 to see how each callout was decided. Chasing a
        # wrong number without this means guessing at the crop the reader used,
        # and a guessed crop reads differently from the real one - which is how
        # an afternoon goes.
        # IPL_OCR_WIDTHS=1 dumps every accepted character with the width of its
        # own blob, which is how the "1" threshold above was measured. Merged
        # pairs are skipped: their width belongs to neither character.
        if os.environ.get("IPL_OCR_WIDTHS") and hit:
            i = 0
            for b in sorted(boxes, key=lambda b: b[0]):
                if b[4] == 1:
                    print(f"WIDTH	{hit[0][i]}	{(b[2]-b[0])/max(1,b[3]-b[1]):.3f}", file=sys.stderr)
                i += b[4]
        if DEBUG:
            print(f"  group ({x1},{y1})-({x2},{y2}) glyphs={nglyphs} "
                  f"crowd={crowding(x1, y1, x2, y2):.3f} "
                  f"-> {hit[0] if hit else None}  ballot={ {t: [round(c) for c in cs] for t, cs in ballot.items()} }",
                  file=sys.stderr)
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
