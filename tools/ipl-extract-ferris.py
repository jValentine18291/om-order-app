#!/usr/bin/env python3
"""
tools/ipl-extract-ferris.py
===========================
Builds an IPL from a Ferris / Briggs & Stratton "Parts Manual" PDF.

    python tools/ipl-extract-ferris.py "<parts manual.pdf>" --id ferrisis600 \\
        --name "Ferris IS600Z Zero-Turn Mower" --short IS600Z \\
        --brand Ferris --category "Zero-Turn Mower"

Written for the IS600Z (Mfg. No. 5902112, 5 Nov 2026), the first Ferris book.

WHERE TO GET THE BOOK
ferrismowers.com -> Support -> Manuals & Parts -> search the Mfg. No. on the
machine's data tag. "PARTS MANUAL - <Mfg. No.>" downloads from Briggs &
Stratton's Power Portal (thepowerportal.com/ipls/ipl.htm?md=<No.>~_IPLURL_LO.pdf).
The copies OM had on the M: drive were "Microsoft Print to PDF" print-outs
with no text at all; the download carries real text, so the parts tables come
out exact. Get the download.

THE LAYOUT
Every group is a pair of pages: the drawing, then its table, both headed with
the group's name. A group that needs two drawings (the IS600's ZT3200
transaxle) is two pairs with the same name - two sheets of one figure.

  REF NO   PART NO      QTY  DESCRIPTION
  0010     5050878X2    2    HANGER, FRONT DECK - 2 LINK
                             -(S/N: 4001989359 and below)    <- a note: remarks

"-----" in PART NO is a part sold only inside a kit; it keeps its row (it is on
the drawing) with no number. Several rows can share a REF NO, told apart by
their S/N notes; one callout then lights both, as in the Husqvarna books.

The table pages carry a "Not For Reproduction" watermark as text, diagonally
across the columns. Its words fall anywhere - "Not" beside a ref,
"Reproduction" in the description column, where it would read as a note - so
they are dropped by what they are, the only rotated line on the page, not by
where they land.

The electrical schematics' tables have one row each, the wiring harness, with
its part number in the REF NO column too; a ref of up to 8 characters is
allowed for that.

THE DRAWINGS are one picture each, callout numbers baked in. They are read by
ipl-ocr-callouts.py against the keys of their own table, which is what makes
it reliable here: four-digit, bold, and only ever one of a known list. About
27 s a page; the readings are cached (tools/.ipl-cache/<id>-ocr.json) so a
second run - after a correction, a title - takes seconds.

Corrections go in tools/ipl-<id>.hotspots.txt, the format every book uses
(see apply_hotspot_overrides in ipl-import-csv.py).

PART NUMBERS AND AUTOCOUNT. The book adds a finish code - 5025156FS,
5102864YP - that AutoCount sometimes keeps (SBNS 5050878X2YP) and sometimes
does not (SBNS 5025156). The search term is the number without its trailing
letters, which the parts search finds either way.

REQUIRES PyMuPDF, Pillow, numpy, scipy and Tesseract (TESSERACT_BIN).
"""

import argparse, importlib.util, io, json, os, re, sys

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IPL_DIR = os.path.join(REPO, "frontend", "ipl")
OUT_W = 1240


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Column left edges on the table page, in PDF points (measured on 5902112:
# REF 60, PART 130, QTY 225, DESCRIPTION 270; notes indent to 273).
PART_X, QTY_X, DESC_X = 125, 220, 265


def page_title(page):
    lines = page.get_text().split("\n")
    return lines[0].strip() if lines else ""


def is_table(page):
    return "REF NO" in page.get_text()


def search_term(number):
    """The number AutoCount can be searched by: without the finish letters."""
    n = re.sub(r"\s+", "", number or "")
    return re.sub(r"(?<=\d)[A-Z]+$", "", n)


def read_table(page):
    """The table's rows, in order, with their notes in remarks."""
    # The watermark: the one line on the page that is not horizontal.
    rotated = {(b["number"], li)
               for b in page.get_text("dict")["blocks"]
               for li, l in enumerate(b.get("lines", []))
               if abs(l["dir"][1]) > 0.01}
    words = [w for w in page.get_text("words") if (w[5], w[6]) not in rotated]
    rows = {}
    for w in words:
        rows.setdefault(round(w[1] / 2), []).append(w)
    parts, started = [], False
    for y in sorted(rows):
        line = sorted(rows[y], key=lambda w: w[0])
        first = line[0][4]
        if first == "REF" and line[0][0] < PART_X:
            started = True
            continue
        if not started:
            continue
        # The footnotes, or the footer: "31  04-Nov-2026", then the copyright.
        if (first.startswith("Footnotes") or first == "Copyright" or
                any(re.fullmatch(r"\d{2}-[A-Z][a-z]{2}-\d{4}", w[4]) for w in line)):
            break
        ref = [w for w in line if w[0] < PART_X]
        # "0030-10" is piece 10 of assembly 0030, printed that way on the
        # drawing too; it is a row of its own, indented under the assembly.
        if ref and re.fullmatch(r"\d{1,8}(-\d{1,3})?[A-Z]?", ref[0][4]):
            num = " ".join(w[4] for w in line if PART_X <= w[0] < QTY_X)
            qty = " ".join(w[4] for w in line if QTY_X <= w[0] < DESC_X)
            desc = " ".join(w[4] for w in line if w[0] >= DESC_X)
            number = "" if set(num) <= {"-"} else num
            piece = "-" in ref[0][4]
            parts.append({
                "key": ref[0][4], "part_number": number, "depth": 1 if piece else 0, "sub": piece,
                "description": desc, "qty": qty, "remarks": "",
                "search": search_term(number),
            })
        elif parts and line[0][0] >= DESC_X:
            # A note under the row above: "-(S/N: ... and below)", a torque.
            note = " ".join(w[4] for w in line)
            # "-(S/N: 4001989359 and below)" loses its wrapping. The book does
            # not always close it: "-(Torque ... 65 ft-lbs (88 Nm)" has one ")"
            # for two "(" - so a ")" goes only when there is one too many.
            if note.startswith("-("):
                note = note[2:]
                if note.endswith(")") and note.count(")") > note.count("("):
                    note = note[:-1]
            note = note.lstrip("-").strip()
            prev = parts[-1]
            prev["remarks"] = (prev["remarks"] + " · " if prev["remarks"] else "") + note
    for p in parts:
        if not p["part_number"]:
            p["remarks"] = ("Part of a kit - no number of its own" +
                            (" · " + p["remarks"] if p["remarks"] else ""))
    return parts


def pieces(doc, page_index, spots, keys, ocr, cache, cache_path):
    """Put "0030-10" back on the callouts read as plain "0030".

    For every callout of an assembly that has pieces, the label is read again
    with the hyphen allowed, wide enough to take in "-10" to its right. If it
    reads as one of that assembly's pieces it becomes that piece, centred on
    the whole label; if it reads as the assembly alone it stays.
    """
    with_pieces = {k.split("-")[0] for k in keys if "-" in k}
    if not with_pieces or not any(s["key"] in with_pieces for s in spots):
        return spots
    import subprocess, tempfile
    from PIL import Image
    page = doc[page_index]
    pix = page.get_pixmap(dpi=300, colorspace=pymupdf.csGRAY)
    im = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    W, H = im.size
    out = []
    for s in spots:
        if s["key"] not in with_pieces:
            out.append(s)
            continue
        ck = f"piece:{page_index + 1}:{s['key']}:{s['x']}:{s['y']}"
        if ck not in cache:
            cx, cy = s["x"] / 100 * W, s["y"] / 100 * H
            crop = im.crop((int(cx - 80), int(cy - 30), int(cx + 175), int(cy + 30)))
            crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
            path = os.path.join(tempfile.gettempdir(), f"ferris-piece-{os.getpid()}.png")
            crop.save(path)
            r = subprocess.run([ocr.tool("tesseract"), path, "stdout", "--psm", "7",
                                "-c", "tessedit_char_whitelist=0123456789-"],
                               capture_output=True, text=True)
            cache[ck] = r.stdout.strip()
            json.dump(cache, open(cache_path, "w"))
        m = re.search(re.escape(s["key"]) + r"-(\d{1,3})", cache[ck].replace(" ", ""))
        piece = f"{s['key']}-{m.group(1)}" if m else ""
        if piece in keys:
            # Centred on the whole "0030-10" rather than its first half.
            out.append({**s, "key": piece, "x": round(s["x"] + 1.1, 3)})
        else:
            out.append(s)
    return out


def stragglers(doc, page_index, spots, keys, ocr, cache, cache_path):
    """Find, anywhere on the page, the callouts the reader never ringed.

    The callout reader finds a number by the leader line running into it. A
    label printed clear of one - "0111" beside the exhaust, "0030-40" in the
    roll-bar inset - it never sees. So whatever is still missing is looked for
    in a plain read of the whole page, hyphen allowed.

    Only for numbers of four digits or more, or a piece ("0030-10"): those do
    not turn up by accident. A "1" or a "7" turns up in every note and
    dimension on a page, so the transaxle's short numbers are left to the
    hand corrections.
    """
    have = {s["key"] for s in spots}
    missing = {k for k in keys if k not in have and (len(k) >= 4 or "-" in k)}
    if not missing:
        return spots
    ck = f"page:{page_index + 1}"
    if ck not in cache:
        import subprocess, tempfile
        pix = doc[page_index].get_pixmap(dpi=300, colorspace=pymupdf.csGRAY)
        path = os.path.join(tempfile.gettempdir(), f"ferris-page-{os.getpid()}.png")
        pix.save(path)
        words = []
        for psm in ("11", "12"):
            r = subprocess.run([ocr.tool("tesseract"), path, "stdout", "--psm", psm,
                                "-c", "tessedit_char_whitelist=0123456789-", "tsv"],
                               capture_output=True, text=True)
            for line in r.stdout.splitlines()[1:]:
                f = line.split("\t")
                if len(f) >= 12 and f[11].strip():
                    x, y, w, h = map(int, f[6:10])
                    words.append([f[11].strip(), round(100 * (x + w / 2) / pix.width, 3),
                                  round(100 * (y + h / 2) / pix.height, 3)])
        cache[ck] = words
        json.dump(cache, open(cache_path, "w"))
    out = list(spots)
    for txt, x, y in cache[ck]:
        if txt in missing and not any(s["key"] == txt and abs(s["x"] - x) < 1.5 and abs(s["y"] - y) < 1.5
                                      for s in out):
            out.append({"key": txt, "x": x, "y": y, "conf": 0, "page": True})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--short", required=True)
    ap.add_argument("--brand", default="Ferris")
    ap.add_argument("--category", required=True)
    ap.add_argument("--aliases", default="")
    ap.add_argument("--titles", help="text file, one title per figure, '-' keeps the book's")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    doc = pymupdf.open(a.pdf)
    # Drawing + table pairs, in book order.
    pairs = []
    for i in range(doc.page_count - 1):
        p, q = doc[i], doc[i + 1]
        if p.get_images() and not is_table(p) and is_table(q) and page_title(p) == page_title(q):
            pairs.append((i, i + 1, page_title(p)))
    print(f"{len(pairs)} drawing/table pairs")

    titles = None
    if a.titles:
        with io.open(a.titles, encoding="utf-8") as f:
            titles = [l.rstrip("\n") for l in f if l.strip() and not l.startswith("#")]

    # Same title, consecutive: sheets of one figure.
    figures, number = [], 0
    for n, (dp, tp, title) in enumerate(pairs):
        same = figures and figures[-1]["_title"] == title
        if not same:
            number += 1
        figures.append({"_title": title, "_draw": dp, "_table": tp, "number": str(number),
                        "parts": read_table(doc[tp])})
    for f in figures:
        group = [g for g in figures if g["number"] == f["number"]]
        f["sheets"], f["sheet"] = len(group), group.index(f) + 1

    for n, f in enumerate(figures):
        t = f["_title"]
        if titles:
            if len(titles) != len(set(g["number"] for g in figures)):
                sys.exit(f"--titles has {len(titles)} for {len(set(g['number'] for g in figures))} figures")
            override = titles[int(f["number"]) - 1]
            t = t if override == "-" else override
        f["title"] = t
        print(f"  {n + 1:>2}. Fig.{f['number']:<3} p{f['_draw'] + 1:<3} {len(f['parts']):>3} parts  {t}")
    if a.dry_run:
        print("(dry run - nothing written)")
        return

    ocr = load("ocr", "ipl-ocr-callouts.py")
    cache_path = os.path.join(HERE, ".ipl-cache", f"{a.id}-ocr.json")
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}

    os.makedirs(IPL_DIR, exist_ok=True)
    out_figs = []
    for n, f in enumerate(figures):
        idx = n + 1
        page = doc[f["_draw"]]
        # The whole page, as every other book: the hotspots are page percentages.
        zoom = OUT_W / page.rect.width
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY)
        image = f"{a.id}-fig{idx}.png"
        pix.save(os.path.join(IPL_DIR, image))

        # The callout reader reads digits only, so it is asked for the plain
        # numbers; a piece's "0030-10" comes back as "0030" and is put right
        # below.
        keys = sorted(set(p["key"] for p in f["parts"] if "-" not in p["key"]))
        ck = f"{f['_draw'] + 1}:{','.join(keys)}"
        if ck not in cache:
            print(f"    reading callouts, page {f['_draw'] + 1} ({len(keys)} keys)…", flush=True)
            cache[ck] = ocr.callouts(a.pdf, f["_draw"] + 1, set(keys))
            json.dump(cache, open(cache_path, "w"))
        spots = [{"key": h["key"], "x": h["x"], "y": h["y"], "conf": h["conf"]} for h in cache[ck]]
        all_keys = set(p["key"] for p in f["parts"])
        spots = pieces(doc, f["_draw"], spots, all_keys, ocr, cache, cache_path)
        spots = stragglers(doc, f["_draw"], spots, all_keys, ocr, cache, cache_path)
        label = f"Fig.{f['number']} {f['title']}" + (f" ({f['sheet']} of {f['sheets']})" if f["sheets"] > 1 else "")
        out_figs.append({
            "id": str(idx), "number": f["number"], "title": f["title"], "image": image,
            "ocr": True, "sheets": f["sheets"], "sheet": f["sheet"], "label": label,
            "parts": f["parts"], "hotspots": spots,
        })

    imp = load("imp", "ipl-import-csv.py")
    imp.apply_hotspot_overrides(out_figs, a.id, HERE)

    total = sum(len(f["parts"]) for f in out_figs)
    book = {"id": a.id, "name": a.name, "source": os.path.basename(a.pdf), "figures": out_figs}
    with io.open(os.path.join(IPL_DIR, f"{a.id}.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(book, fh, ensure_ascii=False, indent=1)

    index_path = os.path.join(IPL_DIR, "index.json")
    index = json.load(io.open(index_path, encoding="utf-8"))
    entry = {"id": a.id, "name": a.name, "short": a.short, "brand": a.brand,
             "category": a.category, "figures": len(out_figs), "parts": total}
    extra = [x.strip() for x in a.aliases.split(",") if x.strip()]
    if extra:
        entry["aliases"] = extra
    index = [e for e in index if e.get("id") != a.id] + [entry]
    with io.open(index_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    print(f"{len(out_figs)} sheets, {total} parts, {sum(len(f['hotspots']) for f in out_figs)} hotspots")
    print(f"wrote frontend/ipl/{a.id}.json and updated index.json")


if __name__ == "__main__":
    main()
