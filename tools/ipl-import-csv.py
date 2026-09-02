#!/usr/bin/env python
"""Build an IPL from a Husqvarna portal CSV export.

    python tools/ipl-import-csv.py --csv "IPL_967634301.csv" \
        --id sr3100 --name "Zenoah SR3100 Chipper Shredder" \
        --short SR3100 --brand Zenoah --category "Chipper Shredder"

WHY THIS EXISTS
Every IPL before this one was built by reading a PDF: text where we were lucky,
OCR where we were not. OCR of a scanned parts table put roughly one order number
in four at risk on the PulsFOG book, and the callout numbers on each diagram had
to be found by measuring glyph shapes, with confidence scores in the 50s-90s.

The portal will export the same book as a CSV, and that CSV carries the part
rows AND the hotspot boxes as Husqvarna themselves recorded them. Nothing is
guessed: the numbers are exact and the hotspots land where the manufacturer put
them. If a portal CSV exists for a model, it beats the PDF every time.

SHEET TITLES
The CSV names each sheet the way the portal files it - FRAME, THROTTLE CONTROLS
- which is not always what is printed on the drawing the technician is looking
at: BLOWER GROUP, LEVER SET. Where they disagree, the drawing wins, because that
is the page in front of them. The titles are not in the export, so --titles
takes them as a small text file, one line per sheet:

    python tools/ipl-import-csv.py ... --dry-run          # lists the sheets
    python tools/ipl-import-csv.py ... --titles ebz5100.titles.txt

A line of "-" keeps the CSV's name for that sheet.

WHAT IT PRODUCES
frontend/ipl/<id>.json plus one PNG per sheet, and the index.json row, matching
the format the earlier books already use so the app needs no changes.

THE COORDINATE SPACE
Boxes are pixel coordinates in the exported sheet's OWN pixel space, so the page
has to be read from the image rather than assumed. The SR3100's sheets happened
to come at 1240x1754 and this script used to hard-code that; the EBZ5100's come
at 1573x2205, and against the old fixed page a fifth of its hotspots landed in
the blank margins - some off the sheet entirely.

Reading the size from the image is also resolution-proof: a sheet exported at
double size gives the same percentages, because both the boxes and the page
double together.

Hotspots are stored as the box's CENTRE, as a percentage of the image, which is
what the app draws.
"""

import argparse, csv, hashlib, io, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IPL_DIR = os.path.join(REPO, "frontend", "ipl")

# What the app serves. The coordinate page is read per sheet from the export.
OUT_W = 1240


def read_rows(path):
    with io.open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    need = ["IPL Name", "Ref", "Article Number", "Article Name", "Qty", "IPL Image"]
    missing = [c for c in need if rows and c not in rows[0]]
    if missing:
        sys.exit(f"CSV is missing column(s): {', '.join(missing)}")
    return [r for r in rows if (r.get("Article Number") or "").strip()]


def hotspots_for(coord_text, ref, page_w, page_h):
    """Each box becomes one hotspot at its centre, as a percentage of the sheet.

    A part bolted on in four places has four boxes, comma-separated, and each
    one is a place a technician might tap - so all of them are kept rather than
    only the first.

    page_w/page_h are the exported sheet's own pixel size. Pass the wrong page
    and every hotspot drifts, which is a thing you have to look at a diagram to
    notice - so main() checks the results land on the sheet."""
    out = []
    for box in (coord_text or "").split(","):
        nums = [n.strip() for n in box.split(";")]
        if len(nums) != 4:
            continue
        try:
            x1, y1, x2, y2 = (float(n) for n in nums)
        except ValueError:
            continue
        out.append({
            "key": ref,
            "x": round((x1 + x2) / 2 / page_w * 100, 3),
            "y": round((y1 + y2) / 2 / page_h * 100, 3),
            # Read from the export rather than recognised from a picture, so
            # there is no confidence to report - it is simply right.
            "conf": 100,
        })
    return out


def fetch(url, cache_dir, index):
    """Download a sheet once, keyed by its URL.

    This used to name the file after the sheet's POSITION - 001.png, 002.png -
    and skip the download when that file already existed. The cache is shared
    across books, so the second book imported reused the first book's sheets
    for however many it had: the 360BT silently came out carrying five of the
    EBZ5100's diagrams, with hotspots measured against the wrong pages.

    The URL is the only thing that actually identifies a sheet, so it is the
    key. `index` is now only for the message."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, hashlib.sha1(url.encode("utf-8")).hexdigest()[:16] + ".png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    print(f"    downloading sheet {index}…")
    req = urllib.request.Request(url, headers={"User-Agent": "om-service-ipl-import"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
        f.write(r.read())
    return path


def page_size(path):
    """The pixel space the portal measured this sheet's boxes in."""
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def write_image(src, dest):
    """Match the house format: 1240px wide, indexed colour, small enough that a
    workshop phone loads it over the office wifi without waiting.

    Resizing here does not disturb the hotspots: they are percentages."""
    from PIL import Image
    im = Image.open(src)
    im.load()
    if im.size[0] != OUT_W:
        h = round(im.size[1] * OUT_W / im.size[0])
        im = im.convert("L").resize((OUT_W, h), Image.LANCZOS)
    if im.mode not in ("P", "L"):
        im = im.convert("L")
    im.save(dest, optimize=True)
    return im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--id", required=True, help="file name stem, e.g. sr3100")
    ap.add_argument("--name", required=True, help="full display name")
    ap.add_argument("--short", required=True, help="what AutoCount calls it, e.g. SR3100")
    ap.add_argument("--brand", required=True)
    ap.add_argument("--category", required=True)
    ap.add_argument("--titles", help="text file of sheet titles, one per sheet, "
                                     "in the order --dry-run lists them")
    ap.add_argument("--cache", default=os.path.join(HERE, ".ipl-cache"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    rows = read_rows(a.csv)
    print(f"{len(rows)} part rows")

    # One sheet per image, in the order the export lists them. Figures are
    # numbered by NAME, so a four-sheet CONTROLS section stays "Fig.9" and the
    # label says which sheet - rather than becoming four unrelated figures with
    # the same title.
    sheets, order, fig_no = {}, [], {}
    for r in rows:
        key = (r["IPL Name"], r["IPL Image"])
        if key not in sheets:
            sheets[key] = []
            order.append(key)
            if r["IPL Name"] not in fig_no:
                fig_no[r["IPL Name"]] = len(fig_no) + 1
        sheets[key].append(r)

    per_name = {}
    for name, _img in order:
        per_name[name] = per_name.get(name, 0) + 1

    # The titles printed on the drawings, if we were given them. Counted
    # against the sheets rather than zipped: a file one line short would
    # otherwise retitle the wrong sheets from that point on and look fine.
    titles = None
    if a.titles:
        with io.open(a.titles, encoding="utf-8") as f:
            lines = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
        if len(lines) != len(order):
            sys.exit(f"--titles has {len(lines)} title(s) for {len(order)} sheet(s). "
                     "Run with --dry-run to list them in order.")
        titles = [None if ln == "-" else ln for ln in lines]

    # A group whose sheets are titled apart - ENGINE GROUP 01 and 02 - does not
    # also need "(1 of 2)" bolted on.
    distinct = {}
    for i, (name, _img) in enumerate(order):
        distinct.setdefault(name, set()).add(titles[i] if titles else None)
    self_titling = {n: len(v) > 1 and None not in v for n, v in distinct.items()}

    print("sheets, in order:")
    for i, (name, _img) in enumerate(order):
        shown = (titles[i] if titles else None) or name
        print(f"  {i + 1:2}. {shown}" + (f"   (CSV: {name})" if shown != name else ""))

    figures, seen_sheet, total_parts, total_spots, no_spots = [], {}, 0, 0, []
    cache_index = {}
    for i, key in enumerate(order, 1):
        name, img_url = key
        cache_index[img_url] = cache_index.get(img_url, len(cache_index) + 1)

    for i, key in enumerate(order, 1):
        name, img_url = key
        group = sheets[key]
        seen_sheet[name] = seen_sheet.get(name, 0) + 1
        sheet_no, sheet_of = seen_sheet[name], per_name[name]
        image_name = f"{a.id}-fig{i}.png"

        # Fetched first: the boxes cannot be turned into percentages until we
        # know the page they were drawn on. Cached, so a dry run is cheap and
        # still checks the hotspots.
        src = fetch(img_url, a.cache, cache_index[img_url])
        page_w, page_h = page_size(src)

        parts, spots = [], []
        for r in group:
            ref = (r["Ref"] or "").strip()
            code = (r["Article Number"] or "").strip()
            parts.append({
                "key": ref,
                "part_number": code,
                "depth": 0,
                "sub": False,
                "description": (r["Article Name"] or "").strip(),
                "qty": (r["Qty"] or "").strip(),
                "remarks": (r.get("Comment") or "").strip(),
                "search": "".join(ch for ch in code.upper() if ch.isalnum()),
            })
            spots.extend(hotspots_for(r.get("Coordinates"), ref, page_w, page_h))

        # One callout can list several parts - the 345BT's muffler is catalyst
        # or not depending on the market, both under "7", both boxed in the
        # same place. That is two parts and one place to tap, so identical
        # hotspots collapse. A part bolted on in four places keeps its four:
        # those differ by position.
        seen_spot, unique = set(), []
        for h in spots:
            k = (h["key"], h["x"], h["y"])
            if k in seen_spot:
                continue
            seen_spot.add(k)
            unique.append(h)
        dropped = len(spots) - len(unique)
        spots = unique

        title = (titles[i - 1] if titles else None) or name
        label = f"Fig.{fig_no[name]} {title}"
        if sheet_of > 1 and not self_titling.get(name):
            label += f" ({sheet_no} of {sheet_of})"

        if not spots:
            no_spots.append(name if sheet_of == 1 else f"{name} ({sheet_no} of {sheet_of})")
        total_parts += len(parts)
        total_spots += len(spots)
        if dropped:
            print(f"    {name}: {dropped} hotspot(s) collapsed - a callout listing more than one part")

        # A hotspot off the sheet means the page was read wrong, and the rest
        # of them are quietly wrong too - they just happen to still be on the
        # paper. Worth stopping for.
        off = [h for h in spots if not (0 <= h["x"] <= 100 and 0 <= h["y"] <= 100)]
        if off:
            sys.exit(
                f"{label}: {len(off)} of {len(spots)} hotspots fall outside the "
                f"{page_w}x{page_h} sheet (worst {max(max(h['x'], h['y']) for h in off):.1f}%). "
                "Nothing written."
            )

        if not a.dry_run:
            write_image(src, os.path.join(IPL_DIR, image_name))

        figures.append({
            "id": str(i),
            "number": str(fig_no[name]),
            "title": title,
            "image": image_name,
            # Not recognised from a picture: taken from the manufacturer's own
            # export, which is why every hotspot is worth trusting.
            "ocr": False,
            "hotspots": sorted(spots, key=lambda h: (len(h["key"]), h["key"])),
            "parts": parts,
            "sheets": sheet_of,
            "sheet": sheet_no,
            "label": label,
        })

    doc = {
        "id": a.id,
        "name": a.name,
        "source": f"Husqvarna portal CSV export ({os.path.basename(a.csv)})",
        "figures": figures,
    }

    print(f"{len(figures)} sheets, {total_parts} parts, {total_spots} hotspots")
    if no_spots:
        print(f"no hotspots on: {', '.join(no_spots)}")
    if a.dry_run:
        print("(dry run - nothing written)")
        return

    with io.open(os.path.join(IPL_DIR, f"{a.id}.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    # The index the IPL screen lists models from.
    index_path = os.path.join(IPL_DIR, "index.json")
    with io.open(index_path, encoding="utf-8") as f:
        index = json.load(f)
    entry = {
        "id": a.id, "name": a.name, "short": a.short, "brand": a.brand,
        "category": a.category, "figures": len(figures), "parts": total_parts,
    }
    index = [e for e in index if e.get("id") != a.id] + [entry]
    with io.open(index_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"wrote frontend/ipl/{a.id}.json and updated index.json")


if __name__ == "__main__":
    main()
