# Corrections to a portal import, and what they refuse.
#
#   python tools/test-ipl-overrides.py
#
# WHY THIS EXISTS
# The portal export is the manufacturer's own data and needs correcting rarely -
# which is exactly why the corrections have to be trustworthy. They are written
# once, months apart, by someone reading a drawing, and then they sit in a file
# nobody looks at again. A correction that quietly stops matching is worse than
# no correction: the book silently goes back to being wrong.
#
# So every failure aborts the run. This checks that it does.
#
# The format is shared with ipl-extract.js, which does the PDF books, so a
# correction can move between the two tools unchanged.
import importlib.util, io, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ipl_import", os.path.join(HERE, "ipl-import-csv.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

failures = 0


def check(what, got, want):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print("%s %s: %r%s" % ("  ok  " if ok else " FAIL ", what, got, "" if ok else " (expected %r)" % (want,)))


def figures():
    """Two sheets, shaped the way the importer builds them."""
    return [
        {"label": "Fig.1 ENGINE - 1", "parts": [{"key": "1"}, {"key": "2"}],
         "hotspots": [{"key": "1", "x": 17.35, "y": 4.97}, {"key": "1", "x": 72.2, "y": 35.9},
                      {"key": "2", "x": 40.0, "y": 50.0}]},
        {"label": "Fig.2 FRAME", "parts": [{"key": "1"}, {"key": "25"}],
         "hotspots": [{"key": "1", "x": 10.0, "y": 10.0}]},
    ]


def run(lines, figs=None):
    """Apply a corrections file; return the figures, or the message it died with."""
    figs = figs if figs is not None else figures()
    d = tempfile.mkdtemp()
    with io.open(os.path.join(d, "ipl-test.hotspots.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    try:
        mod.apply_hotspot_overrides(figs, "test", d)
        return figs
    except SystemExit as e:
        return str(e)


print("-- the P525DX case: a box on the sheet's own title --")
# Husqvarna boxed the numeral in "ENGINE - 1", so tapping the title offered a
# screw. Dropped by position, which is the only thing that identifies it - the
# other two hotspots for key 1 are the real callouts and must survive.
figs = run(["1 drop 1 17.35 4.97"])
check("the title hotspot is gone",
      [(h["key"], h["x"]) for h in figs[0]["hotspots"]], [("1", 72.2), ("2", 40.0)])

print("\n-- the Z242F case: a number the book prints and lists no part for --")
figs = run(["2 unlisted 24 50.0 60.0"])
spot = [h for h in figs[1]["hotspots"] if h["key"] == "24"]
check("it is placed", len(spot), 1)
check("and marked, so the app can say the book lists no part",
      [spot[0].get("unlisted"), spot[0].get("byHand")], [True, True])

print("\n-- a hotspot the export missed --")
figs = run(["2 add 25 30.0 40.0"])
spot = [h for h in figs[1]["hotspots"] if h["key"] == "25"]
check("placed and marked by hand", [len(spot), spot[0].get("byHand")], [1, True])
check("and NOT marked unlisted - the table does list it", spot[0].get("unlisted"), None)

print("\n-- the two verbs cannot be used for each other's job --")
# This is the whole guard. "add" checks the key against the parts list, which is
# what stops a typo becoming a hotspot that leads nowhere; "unlisted" would be
# the way around that check if it did not refuse a key the table does list.
check("add refuses a key the table does not list",
      "lists no part 24" in run(["2 add 24 50.0 60.0"]), True)
check("and points at the right verb",
      "unlisted" in run(["2 add 24 50.0 60.0"]), True)
check("unlisted refuses a key the table DOES list",
      "DOES list 25" in run(["2 unlisted 25 50.0 60.0"]), True)

print("\n-- a drop has to hit something --")
check("nothing near that spot is an error, not a shrug",
      "nothing to drop near" in run(["1 drop 2 80.0 80.0"]), True)
check("and it says how far off it was",
      "% away" in run(["1 drop 2 80.0 80.0"]), True)
check("a key with no hotspot at all says so",
      "no hotspot keyed 9" in run(["1 drop 9 10.0 10.0"]), True)
# 1.5% is about a callout's own width on these sheets: close enough to survive a
# position typed to one decimal place, far enough that the neighbouring callout
# cannot be taken by mistake. Key 2 sits at 40.0,50.0 —
figs = run(["1 drop 2 41.0 50.7"])        # 1.22% away: found
check("a position typed a little loose still finds it", len(figs[0]["hotspots"]), 2)
check("but 1.7% away does not, and says so",             # just outside
      "nothing to drop near" in run(["1 drop 2 41.2 51.2"]), True)

print("\n-- and the rest of the refusals --")
check("a figure the book does not have",
      "no figure 9" in run(["9 add 1 10.0 10.0"]), True)
check("a position off the sheet",
      "off the sheet" in run(["1 add 1 120.0 10.0"]), True)
check("a position that is not a number",
      "must be percentages" in run(["1 add 1 left 10.0"]), True)
check("a line with the wrong number of words",
      "expected:" in run(["1 drop 1"]), True)
check("an instruction nobody wrote",
      'unknown instruction "move"' in run(["1 move 1 10.0 10.0"]), True)

print("\n-- comments and blank lines are skipped --")
figs = run(["# the P525DX title box", "", "   ", "1 drop 1 17.35 4.97", "# done"])
check("only the real line ran", len(figs[0]["hotspots"]), 2)

print("\n-- no file at all is not an error --")
d = tempfile.mkdtemp()
figs = figures()
mod.apply_hotspot_overrides(figs, "nothing-here", d)
check("most books need no corrections", len(figs[0]["hotspots"]), 3)

print("\n-- corrections are applied in order, and all of them --")
figs = run(["1 drop 1 17.35 4.97", "2 unlisted 24 50.0 60.0", "2 add 25 30.0 40.0"])
check("the drop took", len(figs[0]["hotspots"]), 2)
check("and both additions", sorted(h["key"] for h in figs[1]["hotspots"]), ["1", "24", "25"])

# ---- Husqvarna's DUMMY PART placeholder --------------------------------------
# A callout with no orderable part behind it is exported as article 900000002,
# "DUMMY PART", with the real answer buried in the Comment. Left alone a
# technician is shown a part number that AutoCount will never have and that
# looks exactly like one they could order, so the comment becomes the
# description and the fake number is dropped.
#
# The comments are written by hand and the shapes vary, which is the whole
# reason to pin them down here.
print("\n-- DUMMY PART rows are rewritten from their comment --")
check("name and note split on the dash",
      mod.placeholder("Fuel Tank - See Fuel tank page"),
      ("", "Fuel Tank", "See Fuel tank page"))
check("stars are decoration, not content",
      mod.placeholder("Blade - ***See Service Reference***"),
      ("", "Blade", "See Service Reference"))
check("no dash means it is all name",
      mod.placeholder("Not Used"),
      ("", "Not Used", "No part number in this book."))
check("and an empty comment still says something true",
      mod.placeholder(""),
      ("", "Not listed in this book", "No part number in this book."))
# The fake number must never survive into the book: an empty search is what
# stops the app asking AutoCount about a part that cannot be there.
check("the number is always dropped",
      [mod.placeholder(c)[0] for c in ("Blade - x", "", "Not Used")],
      ["", "", ""])

print("" if failures else "\nAll good." if not failures else "")
print("%d FAILED" % failures if failures else "")
sys.exit(1 if failures else 0)
