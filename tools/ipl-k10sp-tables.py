# The four K-10-SP parts tables, turned into data from where the words sit.
#
# THREE THINGS THAT BROKE EARLIER ATTEMPTS, each recorded because each produced
# a plausible-looking parts list that was wrong:
#
#  1. pdftotext -layout. A description taller than one line is set with its
#     numbers centred against it, so the description's FIRST line prints above
#     the row's numbers. Flattened, that reads as a continuation of the row
#     ABOVE, and "Carburettor (red...)" was hung off "Clip size 80-100".
#
#  2. Anchoring a row on its Goliath number. A row need not have one: position
#     149, the dosing nozzle, has an Order No. and a description and no Goliath
#     number at all, and anchoring there dropped it silently.
#
#  3. Taking the "Description" heading's own x as the column boundary. That
#     heading is CENTRED over a wide column, so its left edge sits well right of
#     where descriptions actually start, and long descriptions were read as
#     Order numbers. The boundary is taken from the order numbers themselves.
# RUNNING IT
#   1. pdftotext -bbox -f <p> -l <p> "<the 2012 operating instructions>" #        tools/.ipl-k10sp/bbox-<p>.xml      for p in 20, 23, 27, 29
#   2. python tools/ipl-k10sp-tables.py     -> tools/.ipl-k10sp/tables.json
#   3. python tools/ipl-k10sp-build.py      -> frontend/ipl/k10sp.json + PNGs
#
import io, json, os, re, xml.etree.ElementTree as ET

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ipl-k10sp")
PAGES = {20: "Resonator side", 23: "Fog solution installation",
         27: "Starting installation", 29: "Primer and ignition installation"}
WORD = "{http://www.w3.org/1999/xhtml}word"
ORDER_NO = re.compile(r"^\d{3}\.\d{3}\.\d{2}$")
GOLIATH = re.compile(r"^[A-Z]\d{5}\.?$")
# A position is short and starts with a digit or S: 63, 63b, 122y, 165/1, S301,
# 8583, 209a. Never a word.
POS = re.compile(r"^(?:[Ss]\d{2,4}[a-z]?|\d{1,4}\s?[a-zA-Z]?(?:/\d)?)$")


def parse(page):
    root = ET.parse(os.path.join(S, "bbox-%d.xml" % page)).getroot()
    ws = []
    for w in root.iter(WORD):
        t = (w.text or "").strip()
        if t:
            ws.append({"t": t, "x": float(w.get("xMin")), "x2": float(w.get("xMax")),
                       "y": (float(w.get("yMin")) + float(w.get("yMax"))) / 2.0})

    hdr = {}
    for w in ws:
        for key, pre in (("gol", "Goliath"), ("pos", "Pos"), ("ord", "Order")):
            if w["t"].startswith(pre) and key not in hdr:
                hdr[key] = w
    top = hdr["gol"]["y"] + 6
    body = [w for w in ws if w["y"] > top]
    foot = min([w["y"] for w in body if w["t"] == "Page"] or [1e9])
    body = [w for w in body if w["y"] < foot - 4 and "Operating" not in w["t"]]

    b1 = (hdr["gol"]["x2"] + hdr["pos"]["x"]) / 2
    b2 = (hdr["pos"]["x2"] + hdr["ord"]["x"]) / 2
    # Where the Order column really ends: the rightmost order number on the
    # page, not where its centred heading happens to start.
    order_x2 = [w["x2"] for w in body if ORDER_NO.match(w["t"]) and b2 <= w["x"]]
    b3 = (max(order_x2) + 6) if order_x2 else (hdr["ord"]["x2"] + 40)

    lines = []
    for w in sorted(body, key=lambda w: (w["y"], w["x"])):
        if lines and abs(w["y"] - lines[-1]["y"]) <= 4:
            lines[-1]["w"].append(w)
            lines[-1]["y"] = sum(v["y"] for v in lines[-1]["w"]) / len(lines[-1]["w"])
        else:
            lines.append({"y": w["y"], "w": [w]})

    rows, orphans, headings = [], [], []
    for line in lines:
        g = [w for w in line["w"] if w["x"] < b1]
        p = [w for w in line["w"] if b1 <= w["x"] < b2]
        o = [w for w in line["w"] if b2 <= w["x"] < b3]
        d = sorted([w for w in line["w"] if w["x"] >= b3], key=lambda v: v["x"])
        gt = " ".join(w["t"] for w in g)
        pt = " ".join(w["t"] for w in p)
        ot = " ".join(w["t"] for w in o)
        dt = " ".join(w["t"] for w in d)

        has_num = bool(GOLIATH.match(gt)) or bool(POS.match(pt)) or bool(ORDER_NO.match(ot))
        if has_num:
            rows.append({"y": line["y"], "goliath": gt.rstrip("."), "pos": pt, "order": ot,
                         "desc": [(line["y"], dt)] if dt else []})
        elif gt or pt or ot or dt:
            # A line with words but no numbers. Starting at the far left it is a
            # sub-heading ("For K-10-SP with automatic cut-off device"); further
            # right it is a description that wrapped.
            text = " ".join(x for x in (gt, pt, ot, dt) if x)
            if g and not d:
                headings.append((line["y"], text))
            else:
                orphans.append((line["y"], text))

    if not rows:
        return [], []
    for y, d in orphans:
        min(rows, key=lambda r: abs(r["y"] - y))["desc"].append((y, d))

    def clean(s):
        s = re.sub(r"[´`�“”]", '"', s)
        return re.sub(r'\s+', " ", s).replace(' "', ' "').strip()

    out = []
    for r in rows:
        text = " ".join(t for _, t in sorted(r["desc"], key=lambda v: v[0]))
        out.append({"goliath": r["goliath"], "pos": r["pos"].replace(" ", ""),
                    "order": r["order"], "description": clean(text)})
    return out, [h for _, h in headings]


res = {}
for p, title in PAGES.items():
    rows, heads = parse(p)
    res[str(p)] = {"title": title, "rows": rows, "headings": heads}
    print("page %d  %-32s %3d rows  (%d no Goliath, %d no Pos)  headings: %s"
          % (p, title, len(rows),
             sum(1 for r in rows if not r["goliath"]),
             sum(1 for r in rows if not r["pos"]), heads or "-"))
io.open(os.path.join(S, "tables.json"), "w", encoding="utf-8").write(
    json.dumps(res, ensure_ascii=False, indent=1))
print("\nwrote tables.json")
