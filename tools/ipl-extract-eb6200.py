#!/usr/bin/env python3
"""
tools/ipl-extract-eb6200.py
===========================
Builds the Zenoah EB6200 backpack blower IPL.

    python tools/ipl-extract-eb6200.py            build it
    python tools/ipl-extract-eb6200.py --proof    write the checking sheets

WHY THIS BOOK NEEDED ITS OWN SCRIPT
  ipl-import-csv.py     no portal CSV: this is an old-scheme Zenoah book, with
                        part numbers like 2750-12111 rather than Husqvarna's
                        nine-digit article numbers.
  ipl-extract.js        wants the callout numbers as text in the PDF. Here the
                        three drawings are flat 1-bit images pasted whole onto
                        their pages - nothing to read.
  ipl-ocr-callouts.py   used unchanged for the callouts, which is the only part
                        that needs OCR at all.

WHAT IS EXACT AND WHAT IS READ
The PARTS TABLES are real text in the PDF, so every part number, description
and quantity here is exact - lifted, not recognised. That is the half that
matters: a misread part number is one a technician orders without blinking,
and this book carries none of that risk.

Only the POSITION of each callout on the drawing is found by OCR, and a
position that is wrong is visible the moment anyone looks at the sheet - which
is what --proof is for.

THE TABLE'S OWN AWKWARDNESS
pdftotext gives the rows back in reading order, but not always tidily:

  "21 848L303611Band ass'y 2"     ten-character part numbers touch the
                                  description with no space
  "22 513 66 67-02Damper, upper"  and Husqvarna-scheme numbers carry spaces
                                  of their own
  "20" / "3495-21321 Clip 4"      a row split across two lines
  "26* ----- BODY 1"              a key with an asterisk, and no part number:
                                  the carburettor body is not sold separately
  "40" / "3699-90332 Spark plug 1NGK " / "BPMR7A"
                                  a row split, with the NOTE column trailing

So the parser reads the part number by SHAPE from the front of the line rather
than splitting on whitespace, and every line that does not parse is reported
rather than dropped. A silently skipped row is a part a technician cannot find.
"""

import json
import os
import re
import subprocess
import sys

import pymupdf
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IPL_DIR = os.path.join(REPO, "frontend", "ipl")

SRC = r"M:\SALES_&_MARKETING\PRODUCT_INFORMATION\ZENOAH\IPL\IPL 2023_2024\Leaf Blower\IPL,Zenoah,EB6200,2021-04.pdf"

BOOK_ID = "eb6200"
BOOK = {
    "id": BOOK_ID,
    "name": "Zenoah EB6200 Backpack Blower",
    "short": "EB6200",
    "brand": "Zenoah",
    "category": "Blower",
}

# Drawing page, table page, title as printed on the drawing.
FIGURES = [
    (2, 3, "ENGINE GROUP"),
    (4, 5, "BLOWER GROUP"),
    (6, 7, "CARBURETOR COMPONENTS"),
]

# The three characters the book sets that are not ASCII, as PyMuPDF hands them
# over. pypdf gives all three back as U+FFFD, which is why this reads the PDF
# with PyMuPDF instead: a bullet, an em dash and an apostrophe are three
# different facts, and one replacement character cannot tell them apart.
BULLET = "\u2022"      # this part belongs to the assembly above it
EMDASH = "\u2014"      # the part-number column of a part not sold separately

HEADERS = {"Key#", "PART", "NUMBER", "DESCRIPTION", "Q'TY", "/UNIT", "NOTE"}

# The model name, the figure title, and the footnote under Fig.3. Page
# furniture rather than rows, and skipped quietly - unlike anything else that
# fails to parse, which is reported.
FURNITURE = re.compile(
    r"^(EB6200|Fig\.\d|\[NOTE\]|" + BULLET + r"\s*\d|an individual|carburetor ass)"
)


def clean(s):
    """Typographic characters flattened to what a keyboard can type, so that
    someone searching a slip for "ass'y" finds a line that prints "ass\u2019y"."""
    return s.replace("\u2019", "'").replace(BULLET, "\u00b7")


def rows_of(page):
    """The table rows on one page, read off the word COORDINATES.

    Reading the text in flow order does not work here: each page carries TWO
    tables side by side, so the lines come back interleaved - key 1's row, then
    key 52's, then key 2's. Worse, the columns are set tight enough that a
    ten-character part number touches its description with no space between
    them, so no amount of splitting on whitespace recovers the boundary.

    The coordinates have neither problem. Every "Key#" heading marks the left
    edge of a table; every word belongs to the one it sits inside; and within a
    row the columns are told apart by what they ARE - the key is a number on
    its own, the part number has one of four known shapes, the quantity sits
    under the Q'TY heading - rather than by where the spaces fell.
    """
    words = page.get_text("words")
    if not words:
        return []

    # Where each table starts, and where its Q'TY and NOTE columns are.
    blocks = []
    for x0, y0, x1, y1, txt, *_ in words:
        if txt == "Key#":
            blocks.append({"x0": x0, "qty": None, "note": None, "y": y0})
    if not blocks:
        return []
    blocks.sort(key=lambda b: b["x0"])
    for b in blocks:
        right = min((o["x0"] for o in blocks if o["x0"] > b["x0"] + 1), default=1e9)
        for x0, y0, x1, y1, txt, *_ in words:
            if not (b["x0"] - 6 <= x0 < right):
                continue
            if txt == "Q'TY" and b["qty"] is None:
                b["qty"] = x0
            elif txt == "NOTE" and b["note"] is None:
                b["note"] = x0
        b["right"] = right
        # Where the quantity column ends and the note column begins: halfway
        # between the two HEADINGS, not at the NOTE heading itself. The values
        # in this book are set eleven points to the left of the heading above
        # them, so "NGK" and "OPTION" both sat outside a boundary drawn at the
        # heading and were read as part of the description - the spark plug
        # came out as "Spark plug NGK" with its type lost. Halfway between the
        # two headings falls in the white space between the two columns of
        # values, which is what the eye uses.
        b["split"] = ((b["qty"] + b["note"]) / 2.0
                      if b["qty"] is not None and b["note"] is not None else None)

    out = []
    for b in blocks:
        # Group this table's words into printed rows.
        #
        # By DISTANCE from the row being built, not by rounding y into fixed
        # buckets. Rounding looks equivalent and is not: a row is set on one
        # baseline but the tops of its words vary by a point or two, and where
        # that straddles a bucket edge the row is torn in half. Three rows of
        # the blower table went that way - the part number in one bucket and
        # its own key and description in the next, so key 58 lost 848L0L65E0
        # and a headless part number was reported as unparseable.
        rows, cur, cur_y = [], [], None
        for x0, y0, x1, y1, txt, *_ in sorted(
                (w for w in words if b["x0"] - 6 <= w[0] < b["right"] and w[4] not in HEADERS),
                key=lambda w: (w[1], w[0])):
            if cur_y is None or abs(y0 - cur_y) <= 4.0:
                cur.append((x0, txt))
                cur_y = y0 if cur_y is None else cur_y
            else:
                rows.append(cur)
                cur, cur_y = [(x0, txt)], y0
        if cur:
            rows.append(cur)
        for r in rows:
            r.sort()
            out.append({
                "words": [w for _, w in r],
                "xs": [x for x, _ in r],
                "qty_x": b["qty"], "note_x": b["note"], "split": b["split"],
            })
    return out


# A part number, by shape. Four schemes live in this one book:
#   2750-12111 / 01252-30530 / T4019-21210   Zenoah, hyphenated
#   848L303611 / 84889F4200                  ten characters, no hyphen
#   513 66 67-02                             Husqvarna, in three words
#   -----                                    not supplied separately
HYPH = re.compile(r"^[0-9A-Z]{3,6}-[0-9A-Z]{4,6}$")
FLAT = re.compile(r"^[0-9A-Z]{10}$")
HVA1 = re.compile(r"^\d{3}$")
NONE = re.compile(r"^[" + EMDASH + r"\-]{3,}$")


def take_part(words):
    """The part number off the front of a row, and what is left after it."""
    if not words:
        return None, words
    w = words[0]
    if NONE.match(w):
        return "", words[1:]
    if HYPH.match(w) or FLAT.match(w):
        return w, words[1:]
    # 513 66 67-02, set as three separate words.
    if (HVA1.match(w) and len(words) >= 3 and re.match(r"^\d{2}$", words[1])
            and re.match(r"^\d{2}-\d{2}$", words[2])):
        return " ".join(words[:3]), words[3:]
    return None, words


def parse_rows(rows):
    """Rows to parts. Returns (parts, unparsed)."""
    parts, unparsed = [], []
    footnote = []
    for r in rows:
        words, xs = r["words"], r["xs"]
        if not words:
            continue
        joined = " ".join(words)
        # The note under the table, and any stray page furniture.
        if not re.match(r"^\d{1,3}\*?$", words[0]):
            # A NOTE that ran to a second line belongs to the row above it: the
            # spark plug's "NGK BPMR7A" is set over two, and dropping the
            # second half would leave the technician with "NGK" and no type.
            if (parts and r["split"] is not None
                    and all(x >= r["split"] for x in xs)):
                parts[-1]["remarks"] = (parts[-1]["remarks"] + " " + clean(joined)).strip()
                continue
            if joined.strip() and not FURNITURE.match(joined):
                unparsed.append(joined)
            # The [NOTE] block under the table. Kept, because on this book it
            # is the answer to the question a technician asks when they tap a
            # part with no number: "26*-Body and 27*-Valve ass'y are not
            # supplied as an individual part respectively, but supplied as a
            # carburetor ass'y (P/NO. 2750-81000)."
            elif joined.strip() and not re.match(r"^(EB6200|Fig\.\d|\[NOTE\])", joined):
                footnote.append(clean(joined))
            continue
        key = words[0]
        rest, rest_xs = words[1:], xs[1:]

        number, rest2 = take_part(rest)
        if number is None:
            unparsed.append(joined)
            continue
        rest_xs = rest_xs[len(rest) - len(rest2):]
        rest = rest2

        # The quantity sits under the Q'TY heading; the note to the right of
        # the NOTE heading. Asking where they SIT is what keeps a description
        # of "Grip, right" from having its "right" taken for something else.
        qty, remarks, desc_words = "", [], []
        for w, x in zip(rest, rest_xs):
            if r["split"] is not None and x >= r["split"]:
                remarks.append(w)
            elif r["qty_x"] is not None and abs(x - r["qty_x"]) <= 22 and not desc_only(w):
                qty = w if not qty else qty + w
            else:
                desc_words.append(w)

        depth = 0
        while desc_words and desc_words[0] in (BULLET, "\u00b7"):
            depth += 1
            desc_words.pop(0)

        # Spaces only. The full stop is part of the word - "Cable comp." and
        # "Frame comp." are abbreviations, and stripping it changes what the
        # book says.
        desc = clean(" ".join(desc_words)).strip()
        if not desc:
            unparsed.append(joined)
            continue

        parts.append({
            "key": key,
            "part_number": number,
            "depth": depth,
            "sub": depth > 0,
            "description": desc,
            "qty": qty,
            "remarks": clean(" ".join(remarks)).strip(),
            # What the app searches AutoCount with. Punctuation removed, the
            # way every other book in the catalogue does it.
            "search": "".join(c for c in number.upper() if c.isalnum()),
        })
    # A part with no number is one the book does not sell on its own, and the
    # footnote is where it says so. Without it the app can only offer "not
    # found in AutoCount under this number", which is true and useless - there
    # is no number. With it the line carries the assembly to order instead.
    note = " ".join(footnote).strip().lstrip("· ").strip()
    if note:
        for p in parts:
            if not p["part_number"]:
                p["remarks"] = (p["remarks"] + " " + note).strip()

    return parts, unparsed


def desc_only(w):
    """Words that sit near the quantity column but are plainly not a quantity."""
    return not re.match(r"^\d+(?:~\d+)?$", w)


def tables(doc):
    out = []
    for draw_page, table_page, title in FIGURES:
        parts, bad = parse_rows(rows_of(doc[table_page - 1]))
        out.append({"title": title, "draw_page": draw_page, "parts": parts, "unparsed": bad})
    return out


def diagram(doc, page, path):
    """The drawing itself, straight out of the PDF.

    Taken as it is rather than re-rendering the page: it is a 1-bit line
    drawing at about 400dpi, and lifting it keeps every hairline exactly as
    drawn where a re-render would resample it.

    Returns (width, height, placement), where placement is where the image sits
    on its page as fractions of the page - which is what the callout
    coordinates have to be mapped through. See place().
    """
    pg = doc[page - 1]
    imgs = pg.get_images(full=True)
    if len(imgs) != 1:
        raise SystemExit(f"page {page}: expected one image, found {len(imgs)}")
    xref = imgs[0][0]
    pix = pymupdf.Pixmap(doc, xref)
    if pix.n > 1:
        pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
    pix.save(path)

    im = Image.open(path).convert("L")
    # These are stored as image MASKS - ink where the bit is set - so lifting
    # the bitmap gives white lines on black paper. Printed that way the whole
    # book reads as a photographic negative. Decided by looking at the paper
    # rather than by trusting a flag: the corners of an IPL sheet are always
    # margin, and margin is always paper.
    corners = [im.getpixel(p) for p in
               ((0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1))]
    if sum(corners) / 4.0 < 128:
        im = Image.eval(im, lambda v: 255 - v)
    im.save(path)

    rects = pg.get_image_rects(xref)
    if len(rects) != 1:
        raise SystemExit(f"page {page}: image placed {len(rects)} times")
    r = rects[0]
    placement = (r.x0 / pg.rect.width, r.y0 / pg.rect.height,
                 r.width / pg.rect.width, r.height / pg.rect.height)
    return im.width, im.height, placement


def place(x, y, placement):
    """A callout's position on the PAGE, as a position on the DRAWING.

    ipl-ocr-callouts.py works on a render of the whole page and answers in
    percentages of it. The app draws hotspots in percentages of the IMAGE - and
    the drawing is not the whole page. On Fig.1 it occupies 10.3% to 87.9%
    across and 13.7% to 90.6% down, so an unmapped coordinate lands up and to
    the left of the callout it belongs to, by a quarter of the sheet at the far
    corner. Every ring on the first proof sheet sat in white space.
    """
    px, py, pw, ph = placement
    return ((x / 100.0 - px) / pw * 100.0, (y / 100.0 - py) / ph * 100.0)


CORRECTIONS = os.path.join(HERE, "ipl-eb6200.hotspots.txt")


def corrections(fig, hotspots):
    """Hand-placed callouts, from ipl-eb6200.hotspots.txt.

        <figure> add|drop <key> <x%> <y%>

    The reader is built to drop anything it is not sure of rather than guess,
    which is the right way round - a hotspot on the wrong part is worse than no
    hotspot. What it drops still has to be placed, and the only honest way is
    to look at the sheet and read the position off it. Same file format as the
    MD431 and HB2302 books, which needed the same thing.
    """
    if not os.path.exists(CORRECTIONS):
        return 0
    n = 0
    with open(CORRECTIONS, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#")[0].strip()
            if not line:
                continue
            f, op, key, *rest = line.split()
            if int(f) != fig:
                continue
            if op == "drop":
                before = len(hotspots)
                hotspots[:] = [h for h in hotspots if h["key"] != key]
                n -= before - len(hotspots)
            elif op == "add":
                hotspots.append({"key": key, "x": float(rest[0]), "y": float(rest[1])})
                n += 1
    return n


def main():
    proof = "--proof" in sys.argv
    doc = pymupdf.open(SRC)
    figs = tables(doc)

    total_bad = 0
    for f in figs:
        print(f"Fig {f['draw_page']}  {f['title']}: {len(f['parts'])} parts")
        for b in f["unparsed"]:
            total_bad += 1
            print("   UNPARSED:", repr(b))
    if total_bad:
        raise SystemExit(f"\n{total_bad} line(s) did not parse - fix the parser before writing anything")

    os.makedirs(IPL_DIR, exist_ok=True)
    figures = []
    for i, f in enumerate(figs, 1):
        png = os.path.join(IPL_DIR, f"{BOOK_ID}-fig{i}.png")
        w, h, placement = diagram(doc, f["draw_page"], png)
        keys = sorted({p["key"] for p in f["parts"]})

        # The reader is told to expect digits and nothing else, so it can never
        # return "26*" - it returns "26", which matches no key, and the
        # carburettor body and its valve went unplaced. Both are exactly the
        # parts someone looks for on that sheet.
        #
        # So it is ASKED for the bare numbers and the asterisks are put back
        # afterwards. That is only safe while no figure carries both forms of
        # the same number, which is checked rather than assumed.
        bare = {}
        for k in keys:
            b = k.rstrip("*")
            if b in bare and bare[b] != k:
                raise SystemExit(f"Fig.{i}: keys {bare[b]} and {k} are the same number - "
                                 "the asterisk cannot be put back unambiguously")
            bare[b] = k

        print(f"  Fig.{i} drawing {w}x{h}, {len(keys)} distinct keys - reading callouts…")
        spots = subprocess.run(
            [sys.executable, os.path.join(HERE, "ipl-ocr-callouts.py"),
             SRC, str(f["draw_page"]), ",".join(sorted(bare))],
            capture_output=True, text=True,
        )
        if spots.returncode != 0:
            print(spots.stderr[-2000:])
            raise SystemExit("callout OCR failed")
        found = json.loads(spots.stdout)

        hotspots = []
        for s in found:
            x, y = place(s["x"], s["y"], placement)
            hotspots.append({"key": bare.get(s["key"], s["key"]), "x": x, "y": y})

        # Callouts the reader could not manage, placed by hand off the sheet.
        added = corrections(i, hotspots)
        print(f"        {len(found)} read, {added} placed by hand, "
              f"{len({h['key'] for h in hotspots})} of {len(keys)} keys reached")

        # The same shape every other book uses. The app reads "label" for the
        # sheet buttons and "number" to say which figure a part is on, so a
        # figure without them shows as "Fig.undefined".
        figures.append({
            "id": str(i),
            "number": str(i),
            "title": f["title"],
            "label": f"Fig.{i} {f['title']}",
            "image": os.path.basename(png),
            # True: the callout POSITIONS on this book were read off the
            # drawing rather than lifted from the PDF. Its part numbers were
            # not - those are text, and exact.
            "ocr": True,
            "sheets": 1,
            "sheet": 1,
            "parts": f["parts"],
            "hotspots": hotspots,
        })

    book = dict(BOOK, figures=figures,
                source="IPL,Zenoah,EB6200,2021-04.pdf - tables lifted as text, callouts read off the drawings")
    with open(os.path.join(IPL_DIR, f"{BOOK_ID}.json"), "w", encoding="utf-8") as fh:
        json.dump(book, fh, ensure_ascii=False, indent=1)
    print("wrote", os.path.join("frontend", "ipl", BOOK_ID + ".json"))

    # The row in index.json, built by the same code every other book uses.
    # ipl-index.js is a module, not a command - running it as one, which is
    # what this did at first, silently does nothing at all and leaves the book
    # written to disk but absent from the picker.
    # With `node -e SCRIPT a b c`, argv is [node, a, b, c] - the script is not
    # an argument, so the first value sits at argv[1].
    script = (
        "const {writeIndex} = require(process.argv[1]);"
        "const fs = require('fs');"
        "const model = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));"
        "console.log(JSON.stringify(writeIndex("
        "  process.argv[2], model, process.argv[4], '', (model.figures || []).length)));"
    )
    r = subprocess.run(
        ["node", "-e", script, os.path.join(HERE, "ipl-index.js"), IPL_DIR,
         os.path.join(IPL_DIR, f"{BOOK_ID}.json"), SRC],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stderr[-1500:])
        raise SystemExit("could not write the index row")
    print("index row:", r.stdout.strip())

    if proof:
        for i, fig in enumerate(figures, 1):
            im = Image.open(os.path.join(IPL_DIR, fig["image"])).convert("RGB")
            d = ImageDraw.Draw(im)
            r = max(im.width, im.height) * 0.008
            for s in fig["hotspots"]:
                x, y = im.width * s["x"] / 100.0, im.height * s["y"] / 100.0
                d.ellipse([x - r, y - r, x + r, y + r], outline=(220, 0, 0), width=4)
            out = os.path.join(HERE, f"{BOOK_ID}-fig{i}-proof.png")
            im.save(out)
            print("proof:", out)


if __name__ == "__main__":
    main()
