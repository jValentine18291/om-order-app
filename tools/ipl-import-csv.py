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

import argparse, csv, hashlib, io, json, math, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IPL_DIR = os.path.join(REPO, "frontend", "ipl")

# What the app serves. The coordinate page is read per sheet from the export.
OUT_W = 1240

# Husqvarna's own placeholder. A callout that is printed on the drawing but has
# no orderable part behind it is exported as article 900000002, "DUMMY PART",
# with the real answer written in the Comment:
#
#   900000002  DUMMY PART  "Blade - ***See Service Reference***"
#   900000002  DUMMY PART  "Fuel Tank - See Fuel tank page"
#   900000002  DUMMY PART  "Not Used"
#
# Imported as they stand, a technician taps the callout and is shown a part
# called DUMMY PART with the number 900000002 - a number AutoCount will never
# have and which is exactly the sort of thing that ends up copied onto a slip.
# The Comment is the only part of that row worth reading, so it becomes the
# description and the fake number is dropped. An empty search is safe: the
# server refuses a blank query, so the sheet says the part is not in AutoCount,
# which is true, and still offers the note and the replacement.
DUMMY_ARTICLE = "900000002"


def placeholder(comment):
    """(code, description, remarks) for a DUMMY PART row, from its Comment.

    The comments read "NAME - NOTE", with the note sometimes wrapped in stars
    for emphasis - "Blade - ***See Service Reference***". Some instead lead
    with a full stop: "Ended. SEE SB-B1201009A-07 & Rebuild-/Spare part-Kit
    599 20 97-01 Slide B3", where the whole thing as a description is seventy
    characters of wall in a parts row and "Ended" is the part a technician
    needs at a glance.

    So: split on the first dash, then on the first full stop, and failing both
    take it whole - which is still better than "DUMMY PART".
    """
    text = (comment or "").replace("*", "").strip()
    name, sep, note = text.partition(" - ")
    if not sep:
        name, sep, note = text.partition(". ")
    if not sep:
        name, note = text, ""
    name = name.strip()
    note = note.strip()
    return "", (name or "Not listed in this book"), (note or "No part number in this book.")


def maker_code(comment):
    """The maker's OWN part number, off the front of the Comment column.

    Husqvarna's article number is not always what AutoCount holds. On the
    Zenoah books the Comment carries the Kawasaki number that AutoCount is
    actually stocked under - "848A2J66B1,L600" is the blade AutoCount calls
    "SZEN 848A2J66B1" - and without it those parts find nothing. The app only
    reaches for this when the article number finds nothing, so it costs nothing
    when it is wrong.

    But the same column holds PROSE on the Husqvarna books - "For Asia and LA",
    "SERIAL 202522XXXXX AND LOWER", "Blade - ***See Service Reference***" - and
    a fallback search for those is noise at best. A part number has no spaces in
    it and carries real digits, so that is the test: whitespace anywhere in the
    first comma-separated field disqualifies it, as does fewer than five digits.
    Five is the same threshold the app uses to decide what looks like a part
    code inside a note.
    """
    first = (comment or "").split(",")[0].strip()
    if not first or any(ch.isspace() for ch in first):
        return ""
    code = "".join(ch for ch in first.upper() if ch.isalnum())
    return code if sum(ch.isdigit() for ch in code) >= 5 else ""


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


# ---- Corrections -------------------------------------------------------------
#
# The export is the manufacturer's own data and is right almost everywhere, but
# "almost" has now cost us twice:
#
#   P525DX   the ENGINE - 1 sheet has a box on the numeral in its own TITLE, so
#            tapping the "1" in "ENGINE - 1" offered part 1, a screw.
#   Z242F    several drawings print a callout their own parts table skips -
#            FRAME 24, MOWER LIFT 6 and 13, WHEELS AND TIRES 17. Tapping those
#            did nothing at all, and silence reads as a broken app rather than
#            an incomplete book.
#
# Hand-editing the generated JSON would not survive the next run, so corrections
# live in tools/ipl-<id>.hotspots.txt, one instruction a line. The format is
# deliberately the SAME as ipl-extract.js uses for the PDF books - one format to
# learn, and a correction can be moved between the two tools unchanged:
#
#     <figure> add      <key> <x%> <y%>    put a hotspot here
#     <figure> unlisted <key> <x%> <y%>    a number the book prints and lists
#                                          no part for; the app says so
#     <figure> drop     <key> <x%> <y%>    remove the one already here
#
# <figure> is the figure's position in the finished book, 1-based, AFTER --order
# has been applied - the number --dry-run prints beside each sheet.
#
# Every failure here stops the run rather than warning. A drop that matches
# nothing means the export has changed underneath the file, and the rest of it
# should be re-read before any of it is trusted.
def apply_hotspot_overrides(figures, model_id, here):
    path = os.path.join(here, "ipl-%s.hotspots.txt" % model_id)
    if not os.path.exists(path):
        return
    name = os.path.basename(path)
    added = dropped = 0
    with io.open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            where = '%s line %d: "%s"' % (name, lineno, line)
            bits = line.split()
            if len(bits) != 5:
                sys.exit("%s - expected: <figure> add|unlisted|drop <key> <x%%> <y%%>" % where)
            fig_no, verb, key, xs, ys = bits
            if not fig_no.isdigit() or not (1 <= int(fig_no) <= len(figures)):
                sys.exit("%s - no figure %s (the book has %d)" % (where, fig_no, len(figures)))
            fig = figures[int(fig_no) - 1]
            try:
                x, y = float(xs), float(ys)
            except ValueError:
                sys.exit("%s - x and y must be percentages" % where)
            if not (0 <= x <= 100 and 0 <= y <= 100):
                sys.exit("%s - %s,%s is off the sheet" % (where, xs, ys))

            listed = any(p["key"] == key for p in fig["parts"])
            if verb == "add":
                if not listed:
                    sys.exit("%s - figure %s lists no part %s. Use \"unlisted\" if the "
                             "book prints the number without listing a part." % (where, fig_no, key))
                fig["hotspots"].append({"key": key, "x": x, "y": y, "byHand": True})
                added += 1
            elif verb == "unlisted":
                # Deliberately NOT spelled "add": that verb's check against the
                # parts list is what stops a mistyped key becoming a hotspot
                # that leads nowhere, and this must not be the way around it.
                if listed:
                    sys.exit("%s - figure %s DOES list %s - use \"add\"" % (where, fig_no, key))
                fig["hotspots"].append({"key": key, "x": x, "y": y, "byHand": True, "unlisted": True})
                added += 1
            elif verb == "drop":
                # Nearest hotspot for that key, and it has to be close: a drop
                # aimed at a callout that has since moved should fail rather
                # than silently delete a different one.
                best, best_d = None, None
                for h in fig["hotspots"]:
                    if h["key"] != key:
                        continue
                    d = math.hypot(h["x"] - x, h["y"] - y)
                    if best_d is None or d < best_d:
                        best, best_d = h, d
                if best is None:
                    sys.exit("%s - figure %s has no hotspot keyed %s" % (where, fig_no, key))
                if best_d > 1.5:
                    sys.exit("%s - nothing to drop near %s,%s (nearest %s is %.2f%% away)"
                             % (where, xs, ys, key, best_d))
                fig["hotspots"].remove(best)
                dropped += 1
            else:
                sys.exit("%s - unknown instruction \"%s\"" % (where, verb))

    for fig in figures:
        fig["hotspots"].sort(key=lambda h: (len(h["key"]), h["key"]))
    bits = []
    if added:
        bits.append("%d placed by hand" % added)
    if dropped:
        bits.append("%d removed" % dropped)
    if bits:
        print("    %s: %s" % (name, ", ".join(bits)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, action="append",
                    help="the portal export. Repeat it to build ONE book from "
                         "several exports, in the order given - for a machine "
                         "the portal splits into separate IPLs, like the CEORA's "
                         "drive unit and cutting deck. Sheets keep their own "
                         "identity either way; a repeated --csv only means they "
                         "arrive from more than one file. Name the halves in "
                         "--titles, because sheet names repeat across them.")
    ap.add_argument("--id", required=True, help="file name stem, e.g. sr3100")
    ap.add_argument("--name", required=True, help="full display name")
    ap.add_argument("--short", required=True, help="what AutoCount calls it, e.g. SR3100")
    ap.add_argument("--brand", required=True)
    ap.add_argument("--category", required=True)
    ap.add_argument("--aliases", help="other names this machine goes by, comma "
                                      "separated - what AutoCount calls it, what "
                                      "the workshop writes. Matching only; the "
                                      "picker still shows --short.")
    ap.add_argument("--order", help="sheet order, as the positions --dry-run "
                                    "printed, e.g. \"2,3,4,5,1,7,6\". Use when the "
                                    "export does not list them the way the book runs.")
    ap.add_argument("--titles", help="text file of sheet titles, one per sheet, "
                                     "in the order --dry-run lists them")
    ap.add_argument("--cache", default=os.path.join(HERE, ".ipl-cache"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    # Several exports concatenate into one book. Sheets are grouped by IPL ID
    # further down, and the portal's IDs are unique across exports, so nothing
    # merges by accident - two sheets both called COVER stay two sheets.
    rows = [r for path in a.csv for r in read_rows(path)]
    print(f"{len(rows)} part rows" + (f" from {len(a.csv)} exports" if len(a.csv) > 1 else ""))

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

    # --order puts the sheets in the book's own order, given as the positions
    # --dry-run printed.
    #
    # The export does not always list them the way the printed book runs. The
    # T536Li XP is filed D2, A, B, C, D1, E, D3 - so its three control-unit
    # sheets, which a technician picks between by serial number, arrive as
    # figures 1, 5 and 7 with four unrelated sheets in among them. The book
    # itself runs A, B, C, D1, D2, D3, E, which is the order somebody reading
    # it expects and the order the letters on the drawings say.
    #
    # Applied HERE, before anything else reads `order`, so --titles lines up
    # with the sheets as reordered - which is also why the two belong in one
    # command rather than a reordered copy of somebody's CSV.
    if a.order:
        want = [int(x) for x in a.order.replace(",", " ").split()]
        if sorted(want) != list(range(1, len(order) + 1)):
            sys.exit(f"--order needs each of 1..{len(order)} exactly once, "
                     f"got {a.order!r}. Run with --dry-run to list the sheets.")
        order = [order[i - 1] for i in want]
        # Figure numbers follow the new order, or Fig.1 would still be whatever
        # the export happened to put first.
        fig_no = {}
        for name, _img in order:
            if name not in fig_no:
                fig_no[name] = len(fig_no) + 1

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

    # Figure numbers. Normally a figure IS a name, so the four sheets of a
    # CONTROLS section all read Fig.9 and the label says which one.
    fig_num = [fig_no[name] for name, _img in order]

    # A book built from several exports is our own construction rather than a
    # page the portal publishes, and the names repeat across the halves: the
    # CEORA's drive unit and its cutting deck each have a COVER, a FRAME,
    # WHEELS AND TIRES and an ACCESSORIES. Numbering by name would hand the
    # deck's COVER the drive's Fig.1 and then run the rest of the deck 9, 6,
    # 10, 11, 7 - every shared name borrowing a number from the other half.
    # So here a sheet is a figure, numbered straight through, and the titles
    # are what say which half you are in. They are required, and required to
    # be distinct, because nothing else distinguishes the sheets.
    if len(a.csv) > 1:
        if not titles:
            sys.exit("--titles is required when more than one --csv is given: "
                     "sheet names repeat across exports, so the titles are the "
                     "only thing telling the halves apart. Run --dry-run to "
                     "list the sheets in order.")
        if any(t is None for t in titles):
            sys.exit("a \"-\" line (keep the export's own name) cannot be used "
                     "when more than one --csv is given - every sheet needs a "
                     "title of its own.")
        repeated = sorted({t for t in titles if titles.count(t) > 1})
        if repeated:
            sys.exit("--titles must all differ when more than one --csv is "
                     "given; repeated: " + ", ".join(repeated))
        fig_num = list(range(1, len(order) + 1))

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
            desc = (r["Article Name"] or "").strip()
            note = (r.get("Comment") or "").strip()
            # Read before the placeholder rewrite consumes the comment. A
            # placeholder has no part to find, so it gets no fallback either.
            alt = "" if code == DUMMY_ARTICLE else maker_code(note)
            if code == DUMMY_ARTICLE:
                code, desc, note = placeholder(note)
            part = {
                "key": ref,
                "part_number": code,
                "depth": 0,
                "sub": False,
                "description": desc,
                "qty": (r["Qty"] or "").strip(),
                "remarks": note,
                "search": "".join(ch for ch in code.upper() if ch.isalnum()),
            }
            # Only when there is one, and only when it says something the
            # article number does not - so a book without maker codes is
            # byte-for-byte what it was before this existed.
            if alt and alt != part["search"]:
                part["search_alt"] = alt
            parts.append(part)
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
        label = f"Fig.{fig_num[i - 1]} {title}"
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

    # Corrections last, once every figure exists and its position is settled -
    # the file addresses figures by their place in the finished book.
    apply_hotspot_overrides(figures, a.id, HERE)
    # Recounted, not carried: a sheet the export left bare may have been given
    # its callouts by hand just above, and reporting it as bare afterwards
    # would send somebody looking for a problem that has been fixed.
    total_spots = sum(len(f["hotspots"]) for f in figures)
    no_spots = [f["label"] for f in figures if not f["hotspots"]]

    doc = {
        "id": a.id,
        "name": a.name,
        "source": "Husqvarna portal CSV export (%s)"
                  % ", ".join(os.path.basename(p) for p in a.csv),
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
    # Other names the same machine answers to, for MATCHING a slip to this book.
    # The picker still shows `short`; see modelKeys() in machine-ipl.js for why
    # the two are separate fields.
    extra = [x.strip() for x in (a.aliases or "").split(",") if x.strip()]
    if extra:
        entry["aliases"] = extra
    index = [e for e in index if e.get("id") != a.id] + [entry]
    with io.open(index_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"wrote frontend/ipl/{a.id}.json and updated index.json")


if __name__ == "__main__":
    main()
