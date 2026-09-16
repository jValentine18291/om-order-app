# Build the PulsFOG K-10-SP book: real parts lists, drawings the right way up.
#
# WHAT REPLACES WHAT
# The old book was eight page images with no parts list at all - the tables were
# left as pictures because OCR of the 2012 PHOTOCOPY got 6 of 22 rows wrong, and
# a parts list that wrong is worse than none. That reasoning was sound and no
# longer applies: the operating instructions PDF carries the same tables as a
# real TEXT LAYER, so nothing here is recognised from a picture.
#
# WHICH DOCUMENT EACH PIECE COMES FROM, and why they are not all the same one:
#
#   Resonator      drawing + its own table are on one upright page of the 2008
#                  parts PDF. The 2012 manual has no plain K-10-SP resonator
#                  drawing - only the SAN/ANTEATER and O/STD variants - so the
#                  drawing comes from 2008 and the TABLE from 2012, which is
#                  newer. The two were compared row by row: identical but for
#                  2012 dropping the orange primer and adding two 1-piece ones.
#   the other three  drawing and table both from the 2012 manual, facing pages,
#                  so a callout and its row cannot be from different revisions.
#
# ROTATION
# Only the fog-solution drawing is set sideways. Which way was not assumed: the
# page was cropped, turned both ways and read, and clockwise is the one that
# comes out the right way up.
#
# THE COLUMNS, as John asked for them:
#   Goliath No. -> part_number   what AutoCount is searched by, and it resolves:
#                                Z00047 finds SPUL K10SP 187 Z00047
#   Pos. No.    -> key           the number printed on the drawing
#   Order No.   -> remarks       pulsFOG's own order number, kept but never
#                                confused with the part number
import io, json, os, re, subprocess, sys

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ipl-k10sp")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IPL = os.path.join(REPO, "frontend", "ipl")
POPPLER = r"C:\Claude Code\Invoice Processor Portable\_internal\poppler\Library\bin"
MANUAL = (r"M:\SALES_&_MARKETING\PRODUCT_INFORMATION\PULSFOG"
          r"\01 Operating instructions, K-10 SP, K-10-O, K-10-STD, K-10-SP-SAN, K-10-DESERT, 17-Oct-2012.pdf")
PARTS08 = r"M:\SALES_&_MARKETING\PRODUCT_INFORMATION\PULSFOG\PulsFOG_K10SP_Parts.pdf"

from PIL import Image

# section title, table page (2012), drawing source, drawing page, clockwise turn
SECTIONS = [
    ("Resonator side",                  "20", PARTS08, 1,  0),
    ("Fog solution installation",       "23", MANUAL, 22, 90),
    ("Starting installation",           "27", MANUAL, 26,  0),
    ("Primer and ignition installation","29", MANUAL, 28,  0),
]
OUT_W = 1240


def render(pdf, page, turn, dest):
    stem = os.path.join(S, "_r%d" % page)
    subprocess.run([os.path.join(POPPLER, "pdftoppm.exe"), "-png", "-r", "200",
                    "-f", str(page), "-l", str(page), "-singlefile", pdf, stem],
                   check=True)
    im = Image.open(stem + ".png").convert("L")
    if turn:
        im = im.rotate(-turn, expand=True)      # PIL rotates anticlockwise
    if im.width > OUT_W:
        im = im.resize((OUT_W, round(im.height * OUT_W / im.width)), Image.LANCZOS)
    im.save(dest, optimize=True)
    return im.size


tables = json.load(io.open(os.path.join(S, "tables.json"), encoding="utf-8"))
figures = []
for i, (title, tpage, pdf, dpage, turn) in enumerate(SECTIONS, 1):
    img = "k10sp-fig%d.png" % i
    size = render(pdf, dpage, turn, os.path.join(IPL, img))
    tbl = tables[tpage]
    # A sub-heading in the book ("For K-10-SP with automatic cut-off device")
    # qualifies the rows under it. There is nowhere on a part to put a heading,
    # so it is folded into the remarks of the rows that have no Pos. No. - which
    # is exactly the rows it applies to.
    heads = tbl.get("headings") or []
    parts = []
    for r in tbl["rows"]:
        gol = r["goliath"].strip()
        bits = []
        if r["order"]:
            bits.append("Order No. " + r["order"])
        if heads and not r["pos"].strip():
            bits.append(heads[0])
        parts.append({
            "key": r["pos"].strip(),
            "part_number": gol,
            "depth": 0,
            "sub": False,
            "description": r["description"].strip(),
            "qty": "",
            "remarks": " · ".join(bits),
            "search": gol,
        })
    figures.append({
        "id": str(i), "number": str(i), "title": title, "image": img,
        "ocr": False, "hotspots": [], "parts": parts,
        "sheets": 1, "sheet": 1, "label": "Fig.%d %s" % (i, title),
    })
    print("fig%d %-34s %3d parts  %s  %s" % (i, title, len(parts), size,
                                             "turned clockwise" if turn else "upright"))

doc = {
    "id": "k10sp",
    "name": "PulsFOG K-10-SP",
    "source": ("Operating Instructions K-10-SP, Revision 01, 17-OCT-2012 (parts tables, "
               "text layer) + PulsFOG_K10SP_Parts.pdf 01/2008 (resonator drawing)"),
    "figures": figures,
}
with io.open(os.path.join(IPL, "k10sp.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
print()
print("wrote frontend/ipl/k10sp.json -", sum(len(g["parts"]) for g in figures),
      "parts in", len(figures), "figures")
