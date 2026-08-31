#!/usr/bin/env python3
"""
tools/ipl-extract-pulsfog.py
============================
Builds an IPL from a SCANNED book whose parts tables are printed on the page -
the shape PulsFOG's manuals take. Written for the K-10-SP; it should suit the
rest of the PulsFOG range and anything else built the same way.

    python tools/ipl-extract-pulsfog.py "<IPL.pdf>" <model-id> "<Model Name>" "<Category>"

HOW THIS DIFFERS FROM THE OTHER EXTRACTORS
  Zenoah PDF     callout positions come from the PDF's text layer
  Zenoah scan    callouts read off the picture by OCR (ipl-ocr-callouts.py)
  Husqvarna CSV  the manufacturer ships the callout coordinates outright
  THIS           no callouts at all, by request: flat images plus a parts list

NO HOTSPOTS, DELIBERATELY. John asked for this brand to be images only. The
drawings are scans with the numbers baked in, so reading them would mean the
same expensive OCR the old Zenoah books need, for a brand where nobody has
asked to tap them. The viewer already handles a figure with no hotspots - it
says so in the hint line and offers the parts list instead.

WHERE THE PARTS COME FROM
The book prints a table - Goliath No. | Pos. No. | Order No. | Description -
either under its drawing or on the facing page. There is no text layer, so the
table is read by OCR. Measured on this book: the page as scanned reads better
than one with the table rules erased first (mean confidence 85.5 against 77.1,
30 well-formed order numbers against 20) - the erased rules leave ghosts that
Tesseract reads as punctuation. So the scan is used as it is.

WHICH NUMBER IS THE PART NUMBER
The Order No. (101.100.00) is what anyone orders, so that is part_number. The
Goliath No. (G00001) is PulsFOG's own reference and goes in remarks, where the
viewer shows it without it being mistaken for something to type into AutoCount.

REQUIRES poppler (pdftoppm) and Tesseract, plus Pillow. Set POPPLER_BIN and
TESSERACT_BIN if they are not on PATH.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict

from PIL import Image

DPI = 300
POPPLER = os.environ.get("POPPLER_BIN", "")
TESSERACT = os.environ.get("TESSERACT_BIN", "")

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "ipl")


def tool(name):
    base = POPPLER if name.startswith("pdf") else TESSERACT
    return os.path.join(base, name) if base else name


def render(pdf, page, dpi=DPI):
    out = os.path.join(tempfile.gettempdir(), f"pf-{os.getpid()}-{page}")
    subprocess.run(
        [tool("pdftoppm"), "-png", "-r", str(dpi), "-f", str(page), "-l", str(page),
         "-singlefile", pdf, out],
        check=True, capture_output=True,
    )
    return out + ".png"


def page_count(pdf):
    r = subprocess.run([tool("pdfinfo"), pdf], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    raise SystemExit("could not read the page count")


# ---- OCR -------------------------------------------------------------------
def words(png):
    """Every word Tesseract finds, with its box. psm 11 (sparse text) rather
    than a layout mode: the ruled table defeats Tesseract's own row detection,
    but the words themselves come back cleanly and can be grouped by position."""
    r = subprocess.run(
        [tool("tesseract"), png, "stdout", "--psm", "11", "tsv"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = []
    for line in r.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        out.append({
            "text": f[11].strip(),
            "x": int(f[6]), "y": int(f[7]), "w": int(f[8]), "h": int(f[9]),
            "conf": float(f[10]),
        })
    return out


ORDER_RE = re.compile(r"^\d{3}[.,]\d{3}[.,]\d{2}$")
GOLIATH_RE = re.compile(r"^[A-Z]\d{5}$")
HEADERS = ("goliath", "pos", "order", "description")
# Every page carries the same footer, and it lands in the table's own columns.
FOOTER_RE = re.compile(r"pulsfog|revision\s*\d|se[il]te\s*\d|g[uiü]+ltig", re.I)


def column_edges(ws):
    """Where the four columns start.

    NOT from the header. "Description" is centred over a wide column while its
    text is left-aligned far to its left - taking the header's position put
    every description into the order-number column. The data says it better:
    an order number is unmistakable (999.999.99), so the columns are measured
    from where those actually sit, and the header is only a fallback for a page
    with too few of them to measure.
    """
    orders = [w for w in ws if ORDER_RE.match(w["text"].replace(" ", "").replace(",", "."))]
    goliaths = [w for w in ws if GOLIATH_RE.match(w["text"].rstrip(".").upper())]

    if len(orders) >= 5:
        order_left = min(w["x"] for w in orders)
        order_right = max(w["x"] + w["w"] for w in orders)
        gol_left = min((w["x"] for w in goliaths), default=order_left // 3)
        gol_right = max((w["x"] + w["w"] for w in goliaths), default=gol_left)
        # Between the Goliath codes and the order numbers sits the position
        # column; a third of the way across that gap is clear of both.
        pos_left = gol_right + max(8, (order_left - gol_right) // 4)
        return [gol_left - 8, pos_left, order_left - 12, order_right + 12]

    found = {}
    for w in ws:
        t = w["text"].lower().strip(".:")
        for h in HEADERS:
            if h not in found and t.startswith(h):
                found[h] = w["x"]
    if len(found) < 3:
        return None
    xs = [found.get(h) for h in HEADERS]
    for i, v in enumerate(xs):
        if v is None:
            known = [(j, x) for j, x in enumerate(xs) if x is not None]
            xs[i] = min(known, key=lambda p: abs(p[0] - i))[1]
    return xs


def rows_from(ws, edges, header_y):
    """Group words into printed rows, then into columns by where they sit."""
    body = [w for w in ws if w["y"] > header_y + 10]
    lines = defaultdict(list)
    for w in body:
        centre = w["y"] + w["h"] // 2
        hit = None
        for key in lines:
            if abs(key - centre) < 16:      # a printed row is ~30px at 300dpi
                hit = key
                break
        lines[hit if hit is not None else centre].append(w)

    out = []
    for y in sorted(lines):
        ws_line = sorted(lines[y], key=lambda w: w["x"])
        cols = ["", "", "", ""]
        for w in ws_line:
            # The column whose start is nearest to the left of this word.
            idx = 0
            for i, e in enumerate(edges):
                if w["x"] >= e - 12:
                    idx = i
            cols[idx] = (cols[idx] + " " + w["text"]).strip()
        conf = sum(w["conf"] for w in ws_line) / len(ws_line)
        out.append({"y": y, "cols": cols, "conf": conf})
    return out


def tidy_order(text):
    """Order numbers are 999.999.99. OCR drops a space into them more often
    than it gets a digit wrong, so close the gaps before judging the result."""
    t = text.replace(" ", "").replace(",", ".").rstrip(".")
    if ORDER_RE.match(t):
        return t
    # Stray ink read as punctuation - "9$00.312.00" - is safe to strip: the
    # result either forms a valid order number or it does not, and nothing is
    # invented either way. A number with a digit too many is NOT trimmed:
    # "4100.310.01" could lose either end and both look valid, so it is left
    # as it came and reported for someone to check against the book.
    stripped = re.sub(r"[^0-9.]", "", t)
    return stripped if ORDER_RE.match(stripped) else text.strip()


def tidy_goliath(text):
    """A Goliath code is a letter and five digits. OCR reliably mangles it -
    Z reads as 2, O as 0, S as 9 - and only ONE of those is safe to undo: a
    leading digit, because a code never starts with one.

    Everything else is left alone and the code is DROPPED rather than guessed.
    "NOOOSO" could be repaired to N00050, and the book says N00090; a wrong
    reference printed confidently is worse than no reference at all. The order
    number and the description carry what anyone actually needs.
    """
    t = re.sub(r"[^A-Za-z0-9]", "", text).upper()
    if len(t) == 6:
        head, tail = t[0], t[1:]
        # A code never starts with a digit, so a leading 2 or 6 is certain.
        head = {"2": "Z", "6": "G"}.get(head, head)
        # O for zero inside the digits is equally certain - O is not a digit.
        # S is NOT undone: it could be 5 or 9 and the book has both.
        tail = tail.replace("O", "0")
        t = head + tail
    return t if GOLIATH_RE.match(t) else ""


def parse_table(png):
    ws = words(png)
    edges = column_edges(ws)
    if not edges:
        return [], "no table header found on this page"
    header_y = min(w["y"] for w in ws
                   if w["text"].lower().strip(".:").startswith(HEADERS))
    parsed = rows_from(ws, edges, header_y)

    parts, problems, dropped = [], [], []
    for r in parsed:
        gol, pos, order, desc = r["cols"]
        gol, order = tidy_goliath(gol), tidy_order(order)
        pos = pos.strip().rstrip(".")

        # A description that wraps onto its own line belongs to the row above.
        if not gol and not pos and not order and desc and parts:
            parts[-1]["description"] = (parts[-1]["description"] + " " + desc).strip()
            continue
        # The footer sits in the same columns as the table and otherwise reads
        # as a part with a strange order number.
        line_text = " ".join(r["cols"]).lower()
        if FOOTER_RE.search(line_text):
            continue

        # A part row is identified by at least one of the three things that
        # identify a part. A sub-heading spanning the columns - "For K-10-SP
        # with automatic cut-off device" - has none of them.
        looks_like_pos = bool(re.match(r"^[A-Z]?\d{1,4}[a-zA-Z]?$", pos))
        if not (ORDER_RE.match(order) or GOLIATH_RE.match(gol) or (looks_like_pos and desc)):
            continue

        if not gol and re.search(r"[A-Za-z0-9]", r["cols"][0]):
            dropped.append(r["cols"][0].strip())
        parts.append({
            "key": pos,
            "part_number": order,
            "sub": False,
            "description": re.sub(r"\s+", " ", desc).strip(),
            "qty": "",
            "remarks": gol if GOLIATH_RE.match(gol) else "",
            "search": re.sub(r"[^A-Za-z0-9]", "", order),
        })
        # A blank order number is the book itself: several parts are listed
        # under a Goliath code with no order number of their own.
        if order and not ORDER_RE.match(order):
            problems.append(f"order number reads '{order}' ({r['conf']:.0f}% confident) — {desc[:44]}")
    if dropped:
        problems.append(f"{len(dropped)} Goliath code(s) too garbled to trust, left blank: {', '.join(dropped[:6])}")
    return parts, problems


# ---- images ----------------------------------------------------------------
def save_figure(png, dest, rotate=0):
    im = Image.open(png)
    if rotate:
        im = im.rotate(rotate, expand=True)
    # Line art: a small palette is indistinguishable and a fraction of the size.
    im = im.convert("L").convert("P", palette=Image.ADAPTIVE, colors=16)
    im.save(dest, optimize=True)
    return im.size


def main():
    if len(sys.argv) < 4:
        sys.exit('Usage: ipl-extract-pulsfog.py "<IPL.pdf>" <model-id> "<Model Name>" ["Category"]')
    pdf, model_id, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
    category = sys.argv[4] if len(sys.argv) > 4 else ""

    spec_path = os.path.join(os.path.dirname(__file__), f"ipl-{model_id}.sections.json")
    if not os.path.exists(spec_path):
        sys.exit(f"No section plan at {spec_path}.\n"
                 "It says which page is a drawing, which is its table, and what\n"
                 "to rotate — this book cannot be guessed at reliably.")
    spec = json.load(open(spec_path, encoding="utf-8"))

    n = page_count(pdf)
    print(f"{os.path.basename(pdf)}: {n} pages")
    os.makedirs(OUT_DIR, exist_ok=True)

    figures, all_problems = [], []
    for i, sec in enumerate(spec["sections"], start=1):
        drawing = sec["drawing"]
        table_pages = sec.get("tables", [])
        rotate = sec.get("rotate", 0)

        img_name = f"{model_id}-fig{i}.png"
        size = save_figure(render(pdf, drawing), os.path.join(OUT_DIR, img_name), rotate)

        parts, problems = [], []
        for tp in table_pages:
            p, pr = parse_table(render(pdf, tp))
            parts.extend(p)
            problems.extend(f"p{tp}: {x}" for x in pr)
        all_problems.extend(f"Fig.{i} {x}" for x in problems)

        figures.append({
            "id": str(i),
            "number": i,
            "title": sec["title"],
            "label": sec.get("label", f"Fig.{i} {sec['title']}"),
            "sheet": 1,
            "sheets": 1,
            "image": img_name,
            "hotspots": [],          # by request: this brand is images only
            "parts": parts,
        })
        rot = f", rotated {rotate}°" if rotate else ""
        print(f"  Fig.{i} {sec['title']}: page {drawing}{rot}, {size[0]}x{size[1]}, "
              f"{len(parts)} parts from page(s) {table_pages or '—'}")

    model = {"id": model_id, "name": model_name,
             "source": os.path.basename(pdf), "figures": figures}
    with open(os.path.join(OUT_DIR, f"{model_id}.json"), "w", encoding="utf-8") as f:
        json.dump(model, f, indent=1)

    total = sum(len(f["parts"]) for f in figures)
    print(f"\nwrote frontend/ipl/{model_id}.json — {len(figures)} figures, {total} parts")

    if all_problems:
        print(f"\n{len(all_problems)} row(s) worth checking against the book:")
        for p in all_problems:
            print("  " + p)
    else:
        print("\nEvery order number and Goliath code came out well-formed.")

    # The picker entry comes from the one place that writes them.
    subprocess.run(
        ["node", "-e",
         "const {writeIndex}=require('./tools/ipl-index');"
         "const m=require('./frontend/ipl/%s.json');"
         "console.log('  picker entry:', JSON.stringify(writeIndex('frontend/ipl', m, %s, %s, m.figures.length)));"
         % (model_id, json.dumps(pdf), json.dumps(category))],
        cwd=os.path.join(os.path.dirname(__file__), ".."), check=False,
    )


if __name__ == "__main__":
    main()
