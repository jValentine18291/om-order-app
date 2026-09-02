#!/usr/bin/env python3
"""
tools/ipl-extract-ebz3000.py
============================
Builds the EBZ3000RH IPL. Written for a book shape none of the other
extractors handle.

    python tools/ipl-extract-ebz3000.py            build it
    python tools/ipl-extract-ebz3000.py --proof    write the checking sheets

WHY THIS BOOK NEEDED ITS OWN SCRIPT
  ipl-extract.js        the parts table is real text; here it is not
  ipl-ocr-callouts.py   used, unchanged, for the callouts
  ipl-import-csv.py      no portal CSV exists for this model

The tables were converted to vector outlines, so there is no text layer to
read: pdftotext returns almost nothing. But the page renders losslessly at any
size, so OCR gets a clean image rather than a scan - the input is good even
though the method is OCR.

Two of the four drawings (Figs 1 and 2) ARE scans, pasted whole onto the page.
Figs 3 and 4 are vector, and share their page with their table, so each
figure's drawing is cropped out before anything is read from it.

WHAT KEEPS THE PART NUMBERS HONEST
Three things, in order of authority:

  1. The PDF carries 21 part numbers as real text, stamped over the original
     print as corrections. Those are exact and beat everything else.
  2. Every cell is cropped and read on its own. Read whole-page, Tesseract
     merges a key into its neighbour and splits numbers.
  3. Every remaining cell was compared by eye against its own image, and the
     differences are listed in ipl-ebz3000.corrections.txt.

That third step is not optional here. Measured on this book, whole-page OCR
got about one part number in ten wrong, and always plausibly: a leading "T"
came back as 1 or 7, so T4023-25410 became 74023-25410 - a number a technician
would order without blinking. On the LEVER page, 7 of 20 were wrong.
"""

import json, os, re, subprocess, sys, tempfile
import pymupdf
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IPL_DIR = os.path.join(REPO, "frontend", "ipl")
PDF = r"M:\SALES_&_MARKETING\PRODUCT_INFORMATION\ZENOAH\IPL\IPL 2023_2024\Leaf Blower\IPL,ZENOAH,EBZ3000RH,2018-02.pdf"
TESS = os.environ.get("TESSERACT_BIN", r"C:\Program Files\Tesseract-OCR")
MODEL_ID, MODEL_NAME = "ebz3000rh", "Zenoah EBZ3000RH"
SHORT, BRAND, CATEGORY = "EBZ3000RH", "Zenoah", "Blower"
DPI = 400
OUT_W = 1240

# Column edges as a percentage of page width, for the two-column table layout
# on pages 3, 5 and 7. Five of the six come straight out of the page's own
# ruling lines; the Key#|PART divider is not drawn as a line, so it is taken
# from the right-hand table, which is the same table mirrored.
COLS_L = [11.7, 14.9, 25.1, 43.3, 46.7, 51.8]
COLS_R = [52.9, 56.1, 66.4, 84.5, 87.9, 93.0]

# Fig.3 and Fig.4 put their drawing and their table on one page. Measured off
# the rendered pages; only used to cut the two apart.
FIGURES = [
    {"no": "1", "title": "BLOWER GROUP",          "draw_page": 2, "draw_rect": None,
     "tables": [{"page": 3, "cols": [COLS_L, COLS_R], "ytop": 15.5, "ybot": 94.0}]},
    # Read at 500 rather than 300: this drawing is finer than the blower one,
    # and at 300 its assembly callouts merged with the dash-dot boundary lines
    # they sit against - 36 of 75 keys placed, against 47 at 500. The blower
    # figure goes the other way (53 at 300, 35 at 500), so the resolution
    # belongs to the figure, not the book.
    {"no": "2", "title": "ENGINE GROUP",          "draw_page": 4, "draw_rect": None, "dpi": 500,
     "tables": [{"page": 5, "cols": [COLS_L, COLS_R], "ytop": 15.5, "ybot": 94.0}]},
    # This table starts directly under its header, higher than the others -
    # ytop 16.5 silently ate its first two rows. The drawing is cropped to the
    # ink rather than the panel: a loose crop left the callouts tiny once the
    # image was scaled to 1240 wide, and almost none of them could be read.
    {"no": "3", "title": "CARBURETOR COMPONENTS", "draw_page": 6,
     "draw_rect": (0.120, 0.200, 0.490, 0.800),
     "tables": [{"page": 6, "cols": [[49.0, 52.2, 62.4, 80.5, 84.0, 89.4]], "ytop": 12.6, "ybot": 93.0}]},
    {"no": "4", "title": "LEVER (R) SET",         "draw_page": 7,
     "draw_rect": (0.100, 0.110, 0.940, 0.618),
     # ybot 94 stopped one line short and lost key 18, the last row of the
     # left column.
     "tables": [{"page": 7, "cols": [COLS_L, COLS_R], "ytop": 65.5, "ybot": 95.4}]},
]

doc = pymupdf.open(PDF)


def tool(name):
    return os.path.join(TESS, name) if TESS else name


def corrections():
    """OCR reading -> what the page actually prints, per page."""
    path = os.path.join(HERE, "ipl-ebz3000.corrections.txt")
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        bits = line.split()
        if len(bits) == 4 and bits[1] == "KEY":
            # A key misread, addressed by the part number, which is unique.
            out[("KEY", int(bits[0]), bits[2])] = bits[3]
        else:
            page, wrong, right = bits
            out[(int(page), wrong)] = right
    return out


def render(pno, dpi=DPI):
    png = os.path.join(tempfile.gettempdir(), f"ebz3000-p{pno}-{dpi}.png")
    if not os.path.exists(png):
        doc[pno - 1].get_pixmap(dpi=dpi).save(png)
    return png


def ocr_cell(img, box, psm="7", whitelist=None):
    """One table cell, read on its own."""
    crop = img.crop(box)
    if crop.size[0] < 4 or crop.size[1] < 4:
        return ""
    # A little air around the glyphs; Tesseract reads a tight crop badly.
    pad = Image.new("RGB", (crop.size[0] + 24, crop.size[1] + 24), "white")
    pad.paste(crop, (12, 12))
    tmp = os.path.join(tempfile.gettempdir(), "ebz-cell.png")
    pad.save(tmp)
    cmd = [tool("tesseract"), tmp, "stdout", "--psm", psm]
    if whitelist:
        cmd += ["-c", f"tessedit_char_whitelist={whitelist}"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    return " ".join(r.stdout.split())


def overlays(pno):
    """Part numbers the PDF carries as real text - stamped corrections."""
    pg = doc[pno - 1]
    W, H = pg.rect.width, pg.rect.height
    out = []
    for w in pg.get_text("words"):
        t = w[4].strip()
        if re.fullmatch(r"[0-9A-Z][0-9A-Z\-]{6,13}", t):
            out.append({"text": t, "x": (w[0] + w[2]) / 2 / W * 100, "y": (w[1] + w[3]) / 2 / H * 100})
    return out


def row_bands(img, x0, x1, ytop, ybot):
    """Find the printed rows between ytop and ybot by looking for ink.

    Scanned INSIDE one column, never across the table: the vertical ruling
    lines put ink on every scanline, so a full-width scan sees one unbroken
    band from the header to the footer and finds no rows at all."""
    W, H = img.size
    g = img.convert("L").crop((int(x0 / 100 * W), int(ytop / 100 * H),
                               int(x1 / 100 * W), int(ybot / 100 * H)))
    px = g.load()
    gw, gh = g.size
    dark = []
    for y in range(gh):
        n = 0
        for x in range(0, gw, 2):
            if px[x, y] < 128:
                n += 1
        dark.append(n)
    bands, run = [], None
    for y, n in enumerate(dark):
        if n > 0 and run is None:
            run = y
        elif n == 0 and run is not None:
            if y - run >= 6:
                bands.append((run, y))
            run = None
    if run is not None and gh - run >= 6:
        bands.append((run, gh))
    off = int(ytop / 100 * H)
    return [(a + off, b + off) for a, b in bands]


def row_grid(img, x0, x1, ytop, ybot):
    """The rows, on the pitch the table is actually printed at.

    Ink-gap detection alone is not enough: rows sit close, and two whose
    descriptions nearly touch come back as one band. But a parts table is set
    on a fixed line pitch, so the bands only have to establish that pitch and
    where the first line sits - after which every line can be stepped out,
    including the ones that merged and the ones that are blank."""
    bands = row_bands(img, x0, x1, ytop, ybot)
    if len(bands) < 3:
        return bands
    starts = [a for a, _ in bands]
    gaps = sorted(starts[i + 1] - starts[i] for i in range(len(starts) - 1))
    pitch = gaps[len(gaps) // 2]                 # median: robust to merges and blank lines
    if pitch < 4:
        return bands
    h = max(3, int(pitch * 0.72))
    out, y = [], starts[0]
    end = int(ybot / 100 * img.size[1])
    while y + h <= end:
        out.append((y, y + h))
        y += pitch
    return out


DIGITS = "0123456789"
# No letter O. Zenoah leave it out of their part numbers for the same reason
# every parts catalogue does - it cannot be told from a zero - so every O-shape
# in this book IS a zero, and offering Tesseract the letter only gives it a way
# to be wrong. It took 848L2055K0 to 848L2055KO, 848L2037H0 to ...HO, and
# 848L0L65E0 to 848LOL65E0: four numbers on the blower page alone, each one
# still looking entirely orderable.
PARTCH = "0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ-"


def read_table(t, fixes):
    pno = t["page"]
    img = Image.open(render(pno)).convert("RGB")
    W, H = img.size
    rows = []
    for cols in t["cols"]:
        kx0, kx1, px1, dx1, qx1, _ = cols
        # Banded on the description column: every real row has a description,
        # while a part number can be missing on a sub-component line. Then
        # regularised onto the table's own pitch - two descriptions whose
        # letters nearly touch merge into one band, which silently swallowed
        # a fifth of the rows.
        for (ya, yb) in row_grid(img, px1 + 0.4, dx1 - 0.4, t["ytop"], t["ybot"]):
            # Inset off the ruling lines. A cell cropped edge to edge carries
            # the rule with it, and a vertical rule beside a number reads as a
            # 1: key 19 came back as 119, and its part number gained a digit.
            IN = 0.30
            box = lambda a, b: (int((a + IN) / 100 * W), ya - 2, int((b - IN) / 100 * W), yb + 2)
            # The key decides whether this band is a row at all, so a failed
            # read loses the part entirely - three went missing on the LEVER
            # page that way. Try again with more of the cell and a
            # single-character mode before giving up on the row.
            key = ocr_cell(img, box(kx0, kx1), whitelist=DIGITS)
            if not re.fullmatch(r"\d{1,3}", key):
                for psm, pad in (("7", 0.9), ("8", 0.9), ("8", 1.6), ("10", 1.6)):
                    b = (int((kx0 + IN) / 100 * W), int(ya - pad * (yb - ya) * 0.18),
                         int((kx1 - IN) / 100 * W), int(yb + pad * (yb - ya) * 0.18))
                    key = ocr_cell(img, b, psm=psm, whitelist=DIGITS)
                    if re.fullmatch(r"\d{1,3}", key):
                        break
            if not re.fullmatch(r"\d{1,3}", key):
                continue
            part = ocr_cell(img, box(kx1, px1), whitelist=PARTCH).replace(" ", "")
            desc = ocr_cell(img, box(px1, dx1), psm="7")
            qty = ocr_cell(img, box(dx1, qx1), whitelist=DIGITS)
            ycen = (ya + yb) / 2 / H * 100
            rows.append({"key": key, "part": part, "desc": desc, "qty": qty,
                         "y": ycen, "xmid": (kx1 + px1) / 2, "page": pno})
    # 1. the PDF's own stamped corrections win
    for o in overlays(pno):
        for r in rows:
            if abs(o["y"] - r["y"]) < 0.75 and abs(o["x"] - r["xmid"]) < 6:
                if r["part"] != o["text"]:
                    r["was"] = r["part"]
                r["part"] = o["text"]
                r["exact"] = True
    # 2. then the readings checked by eye
    for r in rows:
        if not r.get("exact"):
            fix = fixes.get((pno, r["part"]))
            if fix:
                r["was"] = r["part"]
                r["part"] = fix
        kfix = fixes.get(("KEY", pno, r["part"]))
        if kfix and r["key"] != kfix:
            r["was_key"] = r["key"]
            r["key"] = kfix
    return rows


def clean_desc(s):
    """The bullets marking a sub-component come through as punctuation."""
    s = s.replace("¢", "•").replace("e ", "• ").replace("*", "•")
    depth = 0
    while True:
        m = re.match(r"^\s*[•·\-]\s*", s)
        if not m:
            break
        s = s[m.end():]
        depth += 1
    return re.sub(r"\s+", " ", s).strip(), depth


def crop_pdf(pno, rect):
    """A one-page PDF holding just the drawing, so the callout reader sees
    nothing but the drawing - on Figs 3 and 4 the parts table shares the page,
    and its key numbers would otherwise be read as callouts."""
    src = doc[pno - 1]
    out = pymupdf.open()
    if rect is None:
        out.insert_pdf(doc, from_page=pno - 1, to_page=pno - 1)
    else:
        r = src.rect
        box = pymupdf.Rect(r.x0 + rect[0] * r.width, r.y0 + rect[1] * r.height,
                           r.x0 + rect[2] * r.width, r.y0 + rect[3] * r.height)
        pg = out.new_page(width=box.width, height=box.height)
        pg.show_pdf_page(pg.rect, doc, pno - 1, clip=box)
    path = os.path.join(tempfile.gettempdir(), f"ebz3000-draw{pno}.pdf")
    out.save(path)
    return path


def callouts(pdf_path, keys, dpi=300):
    script = os.path.join(HERE, "ipl-ocr-callouts.py")
    r = subprocess.run([sys.executable, script, pdf_path, "1", ",".join(keys)],
                       capture_output=True, text=True, encoding="utf-8",
                       env={**os.environ, "TESSERACT_BIN": TESS, "PYTHONIOENCODING": "utf-8",
                            "IPL_OCR_DPI": str(dpi)})
    try:
        return json.loads(r.stdout)
    except Exception:
        sys.stderr.write(r.stdout[-800:] + "\n" + r.stderr[-800:] + "\n")
        return []


def write_image(pdf_path, dest):
    d2 = pymupdf.open(pdf_path)
    pix = d2[0].get_pixmap(dpi=200)
    tmp = dest + ".tmp.png"
    pix.save(tmp)
    im = Image.open(tmp)
    h = round(im.size[1] * OUT_W / im.size[0])
    im = im.convert("L").resize((OUT_W, h), Image.LANCZOS)
    im.save(dest, optimize=True)
    os.remove(tmp)
    return im.size


def proof():
    """Every part-number cell beside what this script decided it says.

    The whole safety of this book rests on someone reading these sheets, so
    they are produced by the SAME code path that writes the JSON - a proof
    sheet built by a second, kinder reading of the page would prove nothing."""
    fixes = corrections()
    try: font = ImageFont.truetype("consolab.ttf", 30)
    except Exception: font = ImageFont.load_default()
    for F in FIGURES:
        for t in F["tables"]:
            pno = t["page"]
            img = Image.open(render(pno)).convert("RGB")
            W, H = img.size
            rows = read_table(t, fixes)
            ROW, LBL = 54, 420
            sheet = Image.new("RGB", (LBL + 430, len(rows) * ROW + 20), "white")
            dr = ImageDraw.Draw(sheet)
            for i, r in enumerate(rows):
                y = i * ROW + 10
                cols = t["cols"][0] if r["xmid"] < (t["cols"][0][2] + 3) else t["cols"][-1]
                ya = int(r["y"] / 100 * H - ROW * 0.30)
                crop = img.crop((int(cols[1] / 100 * W), ya,
                                 int(cols[2] / 100 * W), ya + int(ROW * 0.62)))
                # Fit the cell inside its own lane. Overlapping the label
                # would make the sheet unreadable, and an unreadable proof
                # sheet is worse than none - it looks like it was checked.
                sc = min((LBL - 24) / max(1, crop.size[0]), (ROW - 8) / max(1, crop.size[1]))
                crop = crop.resize((int(crop.size[0] * sc), int(crop.size[1] * sc)), Image.LANCZOS)
                sheet.paste(crop, (10, y))
                tag = r["part"] + ("  <<" if r.get("was") else "")
                dr.text((LBL, y + 8), f'{r["key"]:>3} {tag}', fill=(200, 0, 0), font=font)
            out = os.path.join(tempfile.gettempdir(), f"ebz3000-proof-fig{F['no']}-p{pno}.png")
            sheet.save(out)
            print(f"  Fig.{F['no']} page {pno}: {len(rows)} rows -> {out}")


def hotspot_overrides(figures):
    """Corrections to the callouts, from tools/ipl-ebz3000.hotspots.txt.

        <figure> add|drop <key> <x%> <y%>

    Needed because the callout reader cannot resolve a three-digit number on
    this book's engine drawing. Offered ONLY the 1xx keys it still found five
    of twenty-nine, so this is not competition with the short keys - it cannot
    read them. What it does instead is worse than missing them: it circles the
    trailing digit and files it under that key, so the recoil spring 115 became
    a hotspot for key 5, GASKET TR - and separately circles the leading 1, so
    114 carried two hotspots, neither of them its own.

    A drop that matches nothing aborts the build."""
    path = os.path.join(HERE, "ipl-ebz3000.hotspots.txt")
    if not os.path.exists(path):
        return
    added = dropped = 0
    for line in open(path, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if not line:
            continue
        fno, verb, key, xs, ys = line.split()
        fig = next((f for f in figures if f["number"] == fno), None)
        if not fig:
            sys.exit(f"ipl-ebz3000.hotspots.txt: no figure {fno} - {line!r}")
        x, y = float(xs), float(ys)
        if verb == "add":
            if not any(p["key"] == key for p in fig["parts"]):
                sys.exit(f"ipl-ebz3000.hotspots.txt: figure {fno} has no part {key} - {line!r}")
            fig["hotspots"].append({"key": key, "x": x, "y": y, "byHand": True})
            added += 1
        elif verb == "drop":
            best, bestd = -1, 9e9
            for i, h in enumerate(fig["hotspots"]):
                if h["key"] != key:
                    continue
                dd = ((h["x"] - x) ** 2 + (h["y"] - y) ** 2) ** 0.5
                if dd < bestd:
                    best, bestd = i, dd
            if best < 0 or bestd > 1.2:
                sys.exit(f"ipl-ebz3000.hotspots.txt: nothing to drop near {x},{y} for key {key}"
                         f"{' (no hotspot has that key)' if best < 0 else f' (nearest {bestd:.2f}% away)'}"
                         f" - {line!r}")
            fig["hotspots"].pop(best)
            dropped += 1
        else:
            sys.exit(f"ipl-ebz3000.hotspots.txt: expected add or drop - {line!r}")
    for f in figures:
        f["hotspots"].sort(key=lambda h: (len(h["key"]), h["key"]))
    print(f"  hotspots.txt: {added} placed by hand, {dropped} removed")


def main():
    if "--proof" in sys.argv:
        proof(); return
    fixes = corrections()
    figures, used_fixes = [], set()
    for i, F in enumerate(FIGURES, 1):
        rows = []
        for t in F["tables"]:
            rows += read_table(t, fixes)
        for r in rows:
            if r.get("was"):
                used_fixes.add((r["page"], r["was"]))
            if r.get("was_key"):
                used_fixes.add(("KEY", r["page"], r["part"]))
        parts = []
        for r in rows:
            desc, depth = clean_desc(r["desc"])
            parts.append({"key": r["key"], "part_number": r["part"], "depth": depth,
                          "sub": depth > 0, "description": desc, "qty": r["qty"],
                          "remarks": "",
                          "search": "".join(c for c in r["part"].upper() if c.isalnum())})
        keys = sorted({p["key"] for p in parts}, key=lambda k: int(k))
        draw_pdf = crop_pdf(F["draw_page"], F["draw_rect"])
        image = f"{MODEL_ID}-fig{i}.png"
        size = write_image(draw_pdf, os.path.join(IPL_DIR, image))
        spots = callouts(draw_pdf, keys, F.get("dpi", 300))
        hit = {h["key"] for h in spots}
        print(f"  Fig.{F['no']} {F['title']}: {len(parts)} parts, {len(spots)} hotspots, "
              f"{len(hit & set(keys))}/{len(keys)} numbered parts reachable   image {size[0]}x{size[1]}")
        figures.append({"id": str(i), "number": F["no"], "title": F["title"], "image": image,
                        "ocr": True, "hotspots": spots, "parts": parts,
                        "sheets": 1, "sheet": 1,
                        "label": f"Fig.{F['no']} {F['title']}"})

    hotspot_overrides(figures)
    for F, fig in zip(FIGURES, figures):
        keys = {p["key"] for p in fig["parts"]}
        hit = {h["key"] for h in fig["hotspots"]}
        print(f"    Fig.{F['no']}: now {len(hit & keys)}/{len(keys)} reachable, "
              f"{len(fig['hotspots'])} hotspots")

    stale = set(fixes) - used_fixes
    if stale:
        sys.exit(f"\ncorrections file has {len(stale)} line(s) that matched nothing: "
                 f"{sorted(stale)}\nThe OCR has moved under the file - re-check it.")

    model = {"id": MODEL_ID, "name": MODEL_NAME,
             "source": f"{os.path.basename(PDF)} (vector tables read by OCR, checked by eye)",
             "figures": figures}
    with open(os.path.join(IPL_DIR, f"{MODEL_ID}.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
    idx_path = os.path.join(IPL_DIR, "index.json")
    idx = json.load(open(idx_path, encoding="utf-8"))
    idx = [e for e in idx if e.get("id") != MODEL_ID] + [{
        "id": MODEL_ID, "name": MODEL_NAME, "short": SHORT, "brand": BRAND,
        "category": CATEGORY, "figures": len(figures),
        "parts": sum(len(f["parts"]) for f in figures)}]
    with open(idx_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    print(f"\nwrote frontend/ipl/{MODEL_ID}.json ({len(figures)} figures, "
          f"{sum(len(f['parts']) for f in figures)} parts) and updated index.json")
    print(f"  {len(used_fixes)} OCR reading(s) corrected from the checked list")


if __name__ == "__main__":
    main()
