#!/usr/bin/env python3
"""
tools/ipl-check-hotspots.py
===========================
Draws a model's hotspots onto its diagrams so they can be looked at.

    python tools/ipl-check-hotspots.py <model-id> [out-dir]

Writes one PNG per figure with a ring round every hotspot, and prints the
checks that can be made without eyes:

  - every hotspot sits on ink, not on blank paper
  - no two hotspots are close enough to share one printed number
  - every hotspot's key exists in that figure's parts table

WHY THIS EXISTS
Because the number the extractor prints - "62 of 62 numbered parts reachable" -
counts KEYS, not printed callouts. A book that prints "38" twice counts as
covered the moment either one is found. That reading said 98% on a figure where
one of the two 38s had no hotspot at all, and it took John tapping it to find
out. There is no honest substitute for looking at the drawing.
"""

import json
import os
import sys
from itertools import combinations

import numpy as np
from PIL import Image, ImageDraw

IPL_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "ipl")


def main(model_id, out_dir):
    path = os.path.join(IPL_DIR, f"{model_id}.json")
    model = json.load(open(path, encoding="utf-8"))
    os.makedirs(out_dir, exist_ok=True)

    total = on_ink = 0
    problems = []

    for fig in model["figures"]:
        img_path = os.path.join(IPL_DIR, fig["image"])
        im = Image.open(img_path).convert("RGB")
        grey = np.array(im.convert("L"))
        H, W = grey.shape
        d = ImageDraw.Draw(im)

        keys = {p["key"] for p in fig["parts"]}
        for s in fig["hotspots"]:
            x, y = int(s["x"] / 100 * W), int(s["y"] / 100 * H)
            total += 1
            patch = grey[max(0, y - 9):y + 9, max(0, x - 9):x + 9]
            ink = (patch < 160).sum() > 0
            if ink:
                on_ink += 1
            else:
                problems.append(f"Fig.{fig['number']} key {s['key']} sits on blank paper")
            if s["key"] not in keys:
                problems.append(f"Fig.{fig['number']} key {s['key']} is not in the parts table")
            colour = (220, 30, 30) if ink else (255, 140, 0)
            d.ellipse([x - 13, y - 13, x + 13, y + 13], outline=colour, width=3)

        # Two rings on one printed number means a tap could give either part.
        for a, b in combinations(fig["hotspots"], 2):
            if abs(a["x"] - b["x"]) < 1.2 and abs(a["y"] - b["y"]) < 0.8:
                problems.append(
                    f"Fig.{fig['number']} keys {a['key']} and {b['key']} share one number"
                )

        out = os.path.join(out_dir, f"{model_id}-fig{fig['id']}-check.png")
        im.save(out)
        reached = len({s["key"] for s in fig["hotspots"]})
        tops = len({p["key"] for p in fig["parts"] if not p.get("depth")})
        print(f"  Fig.{fig['number']:<3} {len(fig['hotspots']):>3} hotspots, "
              f"{reached}/{tops} keys reached  ->  {os.path.basename(out)}")

    print(f"\n  {on_ink} of {total} hotspots on ink")
    if problems:
        print(f"  {len(problems)} problem(s):")
        for p in problems:
            print("    " + p)
    else:
        print("  no overlaps, no strays, nothing on blank paper")
    print("\n  Now LOOK at the images: a callout with no ring is a miss, and only")
    print("  your eyes can find those.")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: ipl-check-hotspots.py <model-id> [out-dir]")
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "."))
