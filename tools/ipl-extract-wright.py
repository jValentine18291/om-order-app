#!/usr/bin/env python3
"""
tools/ipl-extract-wright.py
===========================
Builds an IPL from a Wright parts-site print-out.

    python tools/ipl-extract-wright.py "<book.pdf>" --id wrightsb36 \\
        --name "Wright Stander B 36 (Kawasaki FS600)" --short "Stander B 36 FS600" \\
        --category "Stand-on Mower" --aliases WSB36SFS600E1B --dry-run

Written for the Stander B 36, WSB36SFS600E1B (26 Nov 2026), the first Wright
book. The copy on M: is parts.wrightmfg.com's "print all" page put through
Microsoft Print to PDF - no text at all - and the site itself does not load
from the office network, so everything here is read off the pictures.

THE LAYOUT
  page 1   the machine and the date the list was generated
  page 2   the top-level list of assemblies (WMI08016 ...) - not a figure
  then, per assembly, its drawing on one page and its table on the next one
  or two. A drawing with no table after it is a single sellable part (the
  "36" deck decal): its own number and name head the page.

  Reference | Part Number | Description | Quantity | Sellable
            | 11990012    | BOLT, FLANGE 5/16-18 X 3/4 Z5 | 8.00 EA | not sellable

Reference is always empty. THE CALLOUTS ON THE DRAWINGS ARE THE PART NUMBERS
THEMSELVES - "93420247" with a leader line - so the part number is the key.
That makes the drawings easy to read reliably: an eight-digit reading either
IS one of the table's numbers or it is nothing.

TABLES are drawn text (vector outlines), sharp at any size. Rendered at
300 dpi with the grid lines painted out, Tesseract reads them almost
perfectly; with the lines left in it reads nothing at all. Each word is then
placed in its cell by the grid it was painted out of.

DRAWINGS are one embedded picture each, about 2070 x 2390. Read whole with
sparse-text OCR (psm 11) at three sizes; a reading is kept only if it exactly
matches a number in that figure's table, and readings of the same number in
the same place are merged. A reading one digit off a single table number is
taken too, and printed, so it can be looked at. A table part with no reading
at all is printed as MISSING - add it by hand in tools/ipl-<id>.hotspots.txt
(see apply_hotspot_overrides in ipl-import-csv.py).

The figure image is the drawing picture itself, not the page: the page adds a
date, a URL and the site's chat button, none of which a technician needs.

REQUIRES PyMuPDF, Pillow, numpy, and Tesseract (TESSERACT_BIN, or on PATH; the
Invoice Processor bundles one at Invoice Processor Portable/_internal/tesseract).
"""
import argparse, csv, importlib.util, io, json, os, re, subprocess, sys, tempfile

import numpy as np
import pymupdf
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IPL_DIR = os.path.join(REPO, "frontend", "ipl")
TESS = os.environ.get("TESSERACT_BIN", "")
TMP = tempfile.mkdtemp(prefix="ipl-wright-")
OUT_W = 1600
COLS = ["ref", "part", "desc", "qty", "sell"]


def tess(path, psm, extra=()):
    exe = os.path.join(TESS, "tesseract") if TESS else "tesseract"
    r = subprocess.run([exe, path, "stdout", "--psm", str(psm), *extra, "tsv"],
                       capture_output=True, text=True, encoding="utf-8")
    rows = csv.DictReader(io.StringIO(r.stdout), delimiter="\t", quoting=csv.QUOTE_NONE)
    return [w for w in rows if (w.get("text") or "").strip()]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def drawing_of(doc, i):
    """The page's big picture, if it has one: (xref, bbox)."""
    infos = doc[i].get_image_info(xrefs=True)
    big = [x for x in infos if x["width"] >= 1000 and x["height"] >= 1000]
    if not big:
        return None
    b = max(big, key=lambda x: x["width"] * x["height"])
    return b["xref"], b["bbox"]


def runs(idx):
    out = []
    for i in idx:
        if out and i - out[-1][1] <= 3:
            out[-1][1] = i
        else:
            out.append([int(i), int(i)])
    return out


def page_grey(doc, i, dpi=300):
    pix = doc[i].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.stride)[:, :pix.width].copy()


def read_table_page(doc, i):
    """(title_lines, rows) for one table page. rows: dicts of the five columns."""
    im = page_grey(doc, i)
    dark = im < 160
    hr = runs(np.where(dark.mean(axis=1) > 0.5)[0])
    if len(hr) < 3:
        return None
    top, bot = hr[0][0], hr[-1][1]
    vr = runs(np.where(dark[top:bot].mean(axis=0) > 0.6)[0])
    clean = im.copy()
    for a, b in hr:
        clean[max(0, a - 1):b + 3, :] = 255
    for a, b in vr:
        clean[top:bot + 1, max(0, a - 1):b + 3] = 255
    path = os.path.join(TMP, f"t{i}.png")
    Image.fromarray(clean).save(path)
    words = tess(path, 6)

    # Rows are the gaps between horizontal rules; columns, between the last
    # five vertical ones (the title box above the header has its own two).
    bands = [(hr[k][1], hr[k + 1][0]) for k in range(len(hr) - 1)]
    edges = [v[0] for v in vr][-6:]
    cols = [(edges[k], edges[k + 1]) for k in range(len(edges) - 1)]
    cells = {}
    title = []
    for w in words:
        x = int(w["left"]) + int(w["width"]) / 2
        y = int(w["top"]) + int(w["height"]) / 2
        band = next((n for n, (a, b) in enumerate(bands) if a <= y <= b), None)
        if band is None:
            continue
        col = next((n for n, (a, b) in enumerate(cols) if a <= x <= b), None)
        cells.setdefault(band, {}).setdefault(col, []).append(w)

    rows, seen_header = [], False
    for band in sorted(cells):
        c = cells[band]
        # Every cell is one line, so left to right is the order - sorting on
        # height first put "EA" ahead of "2.00" whenever Tesseract set the
        # unit a pixel higher than the number.
        text = {k: " ".join(w["text"] for w in sorted(v, key=lambda w: int(w["left"])))
                for k, v in c.items()}
        if not seen_header:
            if re.search(r"Part\s*Number", " ".join(text.values()), re.I):
                seen_header = True
            else:
                title.append(" ".join(text[k] for k in sorted(text, key=lambda k: -1 if k is None else k)))
            continue
        rows.append({COLS[k]: text.get(k, "") for k in range(len(COLS))})
    return title, rows


def clean_part(s):
    return re.sub(r"[^0-9A-Z]", "", s.upper().replace("O", "0"))


def clean_qty(s):
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*([A-Z]*)", s.upper())
    if not m:
        return s.strip()
    n = float(m.group(1))
    num = str(int(n)) if n == int(n) else str(n)
    return num if m.group(2) in ("", "EA") else f"{num} {m.group(2)}"


def clean_desc(s):
    s = re.sub(r"\s+", " ", s).strip()
    # Tesseract reads a fraction's slash as a 7 now and then: "378 X 1 1/2".
    # Only where the result is a fraction a fastener is sized in.
    s = re.sub(r"(?<![\d./])([1357])7(2|4|8|16|32)(?![\d/])",
               lambda m: f"{m.group(1)}/{m.group(2)}" if int(m.group(1)) < int(m.group(2)) else m.group(0), s)
    # And "OD" (outside diameter) as "0D" after a number: "1.140D", "5/160D".
    s = re.sub(r"(?<=\d)0D\b", "OD", s)
    return s


def read_callouts(doc, xref, keys):
    """[{key, x, y, conf}] in percent of the drawing picture."""
    pix = pymupdf.Pixmap(doc, xref)
    if pix.alpha or pix.n - pix.alpha != 1:
        pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
    base = os.path.join(TMP, f"d{xref}.png")
    pix.save(base)
    W, H = pix.width, pix.height
    grey = np.array(Image.open(base).convert("L"))
    ink = grey < 128
    found, odd = [], []

    def near_key(t):
        """The one key this reading is a digit away from, or None."""
        if len(t) == 8:
            c = [k for k in keys if len(k) == 8 and sum(a != b for a, b in zip(k, t)) == 1]
        elif len(t) == 7:
            # A digit lost to a leader line touching it.
            c = [k for k in keys if len(k) == 8 and any(k[:i] + k[i + 1:] == t for i in range(8))]
        else:
            c = []
        return c[0] if len(c) == 1 else None

    def passes(path, scale):
        for w in tess(path, 11, ("-c", "tessedit_char_whitelist=0123456789")):
            t = w["text"].strip()
            if not re.fullmatch(r"\d{7,12}", t):
                continue
            box = [int(w["left"]) / scale, int(w["top"]) / scale,
                   (int(w["left"]) + int(w["width"])) / scale, (int(w["top"]) + int(w["height"])) / scale]
            conf = float(w["conf"])
            # "13990041 X 7": a callout that says how many. With only digits
            # allowed the X and the count run on, so the number is the first
            # eight and the box is cut back to them.
            if len(t) > 8 and t[:8] in keys:
                box[2] = box[0] + (box[2] - box[0]) * 8 / len(t)
                found.append((t[:8], box, conf, False))
                continue
            if t in keys:
                found.append((t, box, conf, False))
                continue
            k = near_key(t)
            if k:
                found.append((k, box, min(conf, 60), True))
                odd.append(f"{t}->{k}")

    def scaled(img, scale, tag):
        path = base.replace(".png", f"-{tag}-{scale}.png")
        im = img if scale == 1.0 else img.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
        im.save(path)
        return path

    plain = Image.open(base).convert("L")
    for scale in (1.0, 1.5, 2.0):
        passes(scaled(plain, scale, "p"), scale)

    # THE SECOND LOOK: the drawing with everything that is not digit-sized
    # painted out. Callouts that a line runs into, or that sit across one, are
    # the ones the first look misses; with the lines gone they stand alone.
    heights = sorted(b[3] - b[1] for _, b, _, fz in found if not fz)
    med = heights[len(heights) // 2] if heights else 22
    from scipy import ndimage
    lab, _ = ndimage.label(ink, structure=np.ones((3, 3), int))
    keep = np.zeros(lab.max() + 1, bool)
    for n, s in enumerate(ndimage.find_objects(lab), 1):
        h, w = s[0].stop - s[0].start, s[1].stop - s[1].start
        keep[n] = 0.55 * med <= h <= 1.1 * med and w <= 1.1 * h
    only = np.where(keep[lab], 0, 255).astype(np.uint8)
    digits = Image.fromarray(only)
    for scale in (1.0, 1.5, 2.0):
        passes(scaled(digits, scale, "d"), scale)

    def centre(box):
        """The middle of the digits in a word box, not of the box: a leader
        line that touches a number is read as part of the word and drags the
        box sideways. Digit columns carry ink a good part of the way down;
        a leader line's columns carry one or two pixels."""
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(W, x2), min(H, y2)
        cols = ink[y1:y2, x1:x2].sum(axis=0)
        tall = np.where(cols >= max(3, 0.25 * (y2 - y1)))[0]
        if len(tall):
            x1, x2 = x1 + tall[0], x1 + tall[-1] + 1
        return (x1 + x2) / 2 / W * 100, (y1 + y2) / 2 / H * 100

    # Merge: one callout read several times becomes one hotspot. Exact
    # readings first, then by confidence; a later reading that lands on a spot
    # already taken - same key or not - is the same printed number read again.
    # The same NUMBER close by is given more room: a reading that took in the
    # leader line sits a little off its twin, and was a second, stray hotspot.
    spots = []
    for k, box, c, fuzzy in sorted(found, key=lambda f: (f[3], -f[2])):
        x, y = centre(box)
        if any(abs(s["x"] - x) < 2.5 and abs(s["y"] - y) < 0.8 for s in spots):
            continue
        if any(s["key"] == k and abs(s["x"] - x) < 6 and abs(s["y"] - y) < 1.6 for s in spots):
            continue
        spots.append({"key": k, "x": round(x, 3), "y": round(y, 3), "conf": int(c)})
    return spots, sorted(set(odd)), (W, H), base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--short", required=True)
    ap.add_argument("--brand", default="Wright")
    ap.add_argument("--category", required=True)
    ap.add_argument("--aliases", default="")
    ap.add_argument("--titles", help="text file, one title per figure, '-' keeps the book's")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    doc = pymupdf.open(a.pdf)
    figures, cur = [], None
    for i in range(2, doc.page_count):
        d = drawing_of(doc, i)
        if d:
            cur = {"page": i, "xref": d[0], "title_lines": [], "parts": []}
            figures.append(cur)
            continue
        if cur is None:
            continue
        t = read_table_page(doc, i)
        if not t:
            continue
        title, rows = t
        if not cur["title_lines"]:
            cur["title_lines"] = title
        for r in rows:
            part = clean_part(r["part"])
            if not part:
                continue
            cur["parts"].append({"key": part, "part_number": part, "depth": 0, "sub": False,
                                 "description": clean_desc(r["desc"]), "qty": clean_qty(r["qty"]),
                                 "remarks": "", "search": part})

    # A drawing with no table: the sellable single part, named at the top.
    for f in figures:
        if f["parts"]:
            continue
        im = page_grey(doc, f["page"])
        path = os.path.join(TMP, f"h{f['page']}.png")
        Image.fromarray(im[: im.shape[0] // 9]).save(path)
        lines = {}
        for w in tess(path, 6):
            lines.setdefault((w["block_num"], w["par_num"], w["line_num"]), []).append(w["text"])
        text = [" ".join(v) for v in lines.values()]
        num = next((clean_part(l) for l in text if re.fullmatch(r"\s*\d{8}\s*", l)), "")
        name = next((l for l in text if re.search(r"[A-Z]{3}", l) and "WRIGHT_" not in l.upper()), "")
        f["title_lines"] = [num, name]
        if num:
            desc = re.sub(r"\s*\((not )?sellable\)\s*$", "", name, flags=re.I)
            f["parts"].append({"key": num, "part_number": num, "depth": 0, "sub": False,
                               "description": clean_desc(desc), "qty": "1", "remarks": "", "search": num})

    titles = None
    if a.titles:
        with io.open(a.titles, encoding="utf-8") as fh:
            titles = [l.rstrip("\n") for l in fh if l.strip() and not l.startswith("#")]
        if len(titles) != len(figures):
            sys.exit(f"--titles has {len(titles)} for {len(figures)} figures")

    for n, f in enumerate(figures):
        raw = " / ".join(x for x in f["title_lines"] if x)
        f["raw"] = raw
        f["title"] = raw if not titles or titles[n] == "-" else titles[n]
        print(f"  {n + 1:>2}. p{f['page'] + 1:<3} {len(f['parts']):>3} parts  {f['title']}   [{raw}]")
    print(f"{len(figures)} figures, {sum(len(f['parts']) for f in figures)} parts")
    if a.dry_run:
        for n, f in enumerate(figures):
            for p in f["parts"]:
                flag = "" if re.fullmatch(r"\d{8}", p["key"]) else "   <-- not 8 digits"
                print(f"     {n + 1:>2} {p['key']:<10} {p['qty']:<7} {p['description']}{flag}")
        print("(dry run - nothing written)")
        return

    os.makedirs(IPL_DIR, exist_ok=True)
    out = []
    for n, f in enumerate(figures):
        keys = set(p["key"] for p in f["parts"])
        spots, odd, (W, H), png = read_callouts(doc, f["xref"], keys)
        image = f"{a.id}-fig{n + 1}.png"
        # Read at full size, stored smaller: 1600 wide and 16 greys keeps
        # every eight-digit number crisp at a third of the bytes (300 KB a
        # drawing instead of 510, against a median of 150 across the books,
        # and phones keep every book for use off Wi-Fi). Hotspots are
        # percentages, so the size does not move them.
        im = Image.open(png).convert("L")
        if im.width > OUT_W:
            im = im.resize((OUT_W, round(im.height * OUT_W / im.width)), Image.LANCZOS)
        im.quantize(16, dither=Image.Dither.NONE).save(os.path.join(IPL_DIR, image), optimize=True)
        got = set(s["key"] for s in spots)
        missing = sorted(keys - got)
        print(f"  fig {n + 1:>2}: {len(spots):>3} hotspots for {len(keys):>3} parts"
              + (f"; one digit off: {', '.join(odd)}" if odd else "")
              + (f"; MISSING {', '.join(missing)}" if missing else ""))
        out.append({"id": str(n + 1), "number": str(n + 1), "title": f["title"], "image": image,
                    "ocr": True, "parts": f["parts"], "hotspots": spots})

    imp = load("imp", "ipl-import-csv.py")
    imp.apply_hotspot_overrides(out, a.id, HERE)

    total = sum(len(f["parts"]) for f in out)
    book = {"id": a.id, "name": a.name, "source": os.path.basename(a.pdf), "figures": out}
    with io.open(os.path.join(IPL_DIR, f"{a.id}.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(book, fh, ensure_ascii=False, indent=1)

    index_path = os.path.join(IPL_DIR, "index.json")
    index = json.load(io.open(index_path, encoding="utf-8"))
    entry = {"id": a.id, "name": a.name, "short": a.short, "brand": a.brand,
             "category": a.category, "figures": len(out), "parts": total}
    extra = [x.strip() for x in a.aliases.split(",") if x.strip()]
    if extra:
        entry["aliases"] = extra
    index = [e for e in index if e.get("id") != a.id] + [entry]
    with io.open(index_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    print(f"{len(out)} figures, {total} parts, {sum(len(f['hotspots']) for f in out)} hotspots")
    print(f"wrote frontend/ipl/{a.id}.json and updated index.json")


if __name__ == "__main__":
    main()
