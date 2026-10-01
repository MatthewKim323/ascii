#!/usr/bin/env python3
"""
Cut a subject out of a still into a transparent layer for AsciiField.

Segmentation: keep pixels that are saturated and warm (skin, fabric, color)
against a flat, desaturated ground (plaster, sky, studio wall), then AND it
with a hand-drawn polygon so stray ground never leaks in, feather the edge,
crop to the alpha bbox, and save PNG + WebP.

usage:
  cutout.py <image> --crop x0,y0,x1,y1 --poly "x,y x,y x,y ..." --out name
            [--sat 0.12 --sat-span 0.12] [--warm 0.06 --warm-span 0.08]
            [--median 7] [--feather 3] [--preview]

  --crop     region of the source to work in (polygon coords are relative to it)
  --poly     polygon around the subject, in crop coordinates
  --sat      saturation where the mask starts; --sat-span ramps it to full
  --warm     (r - b) where the mask starts; set --warm -1 to ignore warmth
  --preview  also write <out>-preview.png composited on dark red, to eyeball leaks

Tip: run once without --poly to see the raw mask (writes <out>-mask.png),
then draw the polygon around what you want.
"""
import argparse

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--crop", required=True)
    ap.add_argument("--poly")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sat", type=float, default=0.12)
    ap.add_argument("--sat-span", type=float, default=0.12)
    ap.add_argument("--warm", type=float, default=0.06)
    ap.add_argument("--warm-span", type=float, default=0.08)
    ap.add_argument("--median", type=int, default=7)
    ap.add_argument("--feather", type=float, default=3)
    ap.add_argument("--webp-q", type=int, default=88)
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args()

    im = Image.open(a.image).convert("RGB")
    x0, y0, x1, y1 = map(int, a.crop.split(","))
    c = im.crop((x0, y0, x1, y1))
    rgb = np.asarray(c).astype(float) / 255
    mx, mn = rgb.max(2), rgb.min(2)
    sat = (mx - mn) / (mx + 1e-6)
    score = np.clip((sat - a.sat) / a.sat_span, 0, 1)
    if a.warm > -1:
        warm = rgb[..., 0] - rgb[..., 2]
        score *= np.clip((warm - a.warm) / a.warm_span, 0, 1)
    mask = Image.fromarray((score * 255).astype(np.uint8))
    if a.median > 1:
        mask = mask.filter(ImageFilter.MedianFilter(a.median | 1))
    mask = mask.filter(ImageFilter.GaussianBlur(1.5))

    if not a.poly:
        mask.save(f"{a.out}-mask.png")
        print(f"wrote {a.out}-mask.png ({c.size[0]}x{c.size[1]}); draw --poly around the subject in these coordinates")
        return

    pts = [tuple(map(float, p.split(","))) for p in a.poly.split()]
    pm = Image.new("L", c.size, 0)
    ImageDraw.Draw(pm).polygon(pts, fill=255)
    pm = pm.filter(ImageFilter.GaussianBlur(a.feather))
    alpha = (np.asarray(mask).astype(float) * np.asarray(pm).astype(float) / 255).astype(np.uint8)

    out = c.copy()
    out.putalpha(Image.fromarray(alpha))
    bbox = Image.fromarray(alpha).getbbox()
    out = out.crop(bbox)
    out.save(f"{a.out}.png")
    out.save(f"{a.out}.webp", quality=a.webp_q)
    print(f"wrote {a.out}.png / {a.out}.webp  {out.size[0]}x{out.size[1]}  (bbox in crop: {bbox})")
    if a.preview:
        bg = Image.new("RGB", out.size, (40, 0, 0))
        bg.paste(out, (0, 0), out)
        bg.save(f"{a.out}-preview.png")
        print(f"wrote {a.out}-preview.png")


if __name__ == "__main__":
    main()
