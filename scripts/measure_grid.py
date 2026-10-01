#!/usr/bin/env python3
"""
Measure an ASCII reference frame: cell pitch, background, frame aspect, and a
zoomed nearest-neighbor crop for reading the glyph ramp by eye.

usage:
  measure_grid.py <frame.png> [--region x,y,w,h] [--crop x,y,w,h] [--zoom 3] [--out zoom.png]

  --region  area with lots of glyphs used for the pitch autocorrelation
            (default: the busiest quarter of the frame)
  --crop    area to blow up for reading glyph shapes (default: same as region)

Get frames first:
  ffmpeg -i ref.mp4 -vf fps=1 frames/%02d.png
  ffmpeg -ss 8 -i ref.mp4 -frames:v 1 full8.png        # one full-res frame
"""
import argparse
import sys

import numpy as np
from PIL import Image


def period(profile, lo=4, hi=120):
    p = profile - profile.mean()
    if not p.any():
        return None
    ac = np.correlate(p, p, "full")[len(p) - 1 :]
    hi = min(hi, len(ac) - 1)
    return int(np.argmax(ac[lo:hi]) + lo)


def busiest(lum, thresh):
    h, w = lum.shape
    best, box = -1, (0, 0, w // 2, h // 2)
    for y in range(0, h - h // 4, h // 8):
        for x in range(0, w - w // 4, w // 8):
            n = (lum[y : y + h // 4, x : x + w // 4] > thresh).sum()
            if n > best:
                best, box = n, (x, y, w // 4, h // 4)
    return box


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frame")
    ap.add_argument("--region")
    ap.add_argument("--crop")
    ap.add_argument("--zoom", type=int, default=3)
    ap.add_argument("--thresh", type=float, default=40)
    ap.add_argument("--out", default="zoom.png")
    a = ap.parse_args()

    im = Image.open(a.frame).convert("RGB")
    arr = np.asarray(im).astype(float)
    lum = arr.mean(2)
    h, w = lum.shape
    print(f"frame {w}x{h}  aspect {w / h:.4f}  ({w}/{h})")
    corner = arr[: h // 10, : w // 10].reshape(-1, 3)
    print(f"background (top-left corner mean rgb) {corner.mean(0).round(1).tolist()}")

    if a.region:
        x, y, rw, rh = map(int, a.region.split(","))
    else:
        x, y, rw, rh = busiest(lum, a.thresh)
    reg = lum[y : y + rh, x : x + rw]
    on = reg > a.thresh
    px, py = period(on.sum(0).astype(float)), period(on.sum(1).astype(float))
    print(f"region {x},{y},{rw},{rh}: column pitch {px}px  row pitch {py}px")
    if px:
        print(f"cell as fraction of frame height: {px}/{h} = {px / h:.6f}  (AsciiConfig.cell)")
        print(f"cells across: {w / px:.1f}  down: {h / (py or px):.1f}")

    cx, cy, cw, ch = map(int, a.crop.split(",")) if a.crop else (x, y, rw, rh)
    crop = im.crop((cx, cy, cx + cw, cy + ch))
    crop = crop.resize((cw * a.zoom, ch * a.zoom), Image.NEAREST)
    crop.save(a.out)
    print(f"wrote {a.out}: read the glyphs dim to bright off it, note any filled or inverted tiles")


if __name__ == "__main__":
    sys.exit(main())
