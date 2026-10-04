#!/usr/bin/env python3
"""
One-shot measurement of a reference ASCII video: everything section 1 of the
skill asks for, in one run. The video is only a measuring tool; nothing it
writes is meant to ship.

usage:
  analyze_ref.py <ref.mp4> [--out ref-analysis] [--fps 10] [--at <sec>] [--thresh 40]

writes into --out:
  report.json      every number below, machine readable
  REPORT.md        the same, plus a starting AsciiConfig skeleton
  frame.png        the full-res frame the grid was measured on (--at, default: busiest)
  zoom.png         3x nearest-neighbor crop of its busiest region (read glyphs here)
  glyphs.png       every distinct glyph shape found, sorted dim to bright, with counts
  sheet.jpg        one frame per second, for reading motion by eye
  curves.png       mean luminance and motion energy over time

what it measures:
  frame size, aspect, fps, duration, background color
  cell pitch (autocorrelation) and grid phase, cell = pitch / frame height
  glyph shapes: cells sliced on the grid, binarized, clustered, ordered by brightness
  color model: whether dim glyphs keep the hue of bright ones
  motion: luminance and frame-difference curves, approach end, glow onset,
          loop style (ping-pong, seamless, or hard cut)
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_grid import busiest, period  # noqa: E402


def sh(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def probe(path):
    out = json.loads(
        sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,r_frame_rate:format=duration", "-of", "json", path])
    )
    s = out["streams"][0]
    num, den = map(float, s["r_frame_rate"].split("/"))
    return int(s["width"]), int(s["height"]), num / den, float(out["format"]["duration"])


def frames_at(path, fps, width):
    """decode the whole video at `fps`, scaled to `width`, as an (n, h, w, 3) uint8 array"""
    w, h, _, _ = probe(path)
    sw = min(width, w) // 2 * 2
    shh = round(h * sw / w) // 2 * 2
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps={fps},scale={sw}:{shh}:flags=area",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, shh, sw, 3)


def full_frame(path, t, out):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", out], check=True)
    return np.asarray(Image.open(out).convert("RGB"))


def phase(profile, pitch):
    """grid offset: the shift where cell boundaries see the least ink"""
    n = len(profile) // pitch * pitch
    if n == 0:
        return 0
    folded = profile[:n].reshape(-1, pitch).sum(0)
    return int(np.argmin(folded))


def signature(shape, sig):
    """shape cropped to its own ink bbox, so the same glyph matches wherever it sits in the cell"""
    ys, xs = np.nonzero(shape)
    if not len(xs):
        return None, (0, 0)
    box = shape[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    img = Image.fromarray((box * 255).astype(np.uint8)).resize((sig, sig), Image.BOX)
    return np.asarray(img) > 76, (xs.max() - xs.min() + 1, ys.max() - ys.min() + 1)


def same_glyph(c, small, dims, merge, ink):
    # ink coverage separates glyphs with the same box (an '@' and a filled tile)
    if abs(c["ink"] / max(1, c["n"]) - ink) > 0.06:
        return False
    (bw, bh), (cw, ch) = dims, c["dims"]
    if abs(bw - cw) > max(1, 0.2 * max(bw, cw)) or abs(bh - ch) > max(1, 0.2 * max(bh, ch)):
        return False
    return np.count_nonzero(c["sig"] != small) <= max(2, merge * small.size)


def glyph_shapes(arr, pitch_x, pitch_y, ox, oy, thresh, sig=6, merge=0.2):
    """slice lit cells on the grid, normalize each by its own peak, cluster by binarized shape"""
    lum = arr.astype(float).mean(2)
    h, w = lum.shape
    clusters = {}
    hue_by_ink = []
    for y in range(oy, h - pitch_y + 1, pitch_y):
        for x in range(ox, w - pitch_x + 1, pitch_x):
            cell = lum[y : y + pitch_y, x : x + pitch_x]
            peak = cell.max()
            if peak < thresh:
                continue
            shape = cell / peak > 0.5
            ink = float(shape.mean())
            small, dims = signature(shape, sig)
            if small is None:
                continue
            # greedy merge: compression, antialiasing and subpixel jitter split one glyph into
            # near-identical shapes. Ink bbox size keeps '.', ':' and '-' apart.
            key = next((k for k, c in clusters.items() if c["n"] and same_glyph(c, small, dims, merge, ink)), (small.tobytes(), dims))
            c = clusters.setdefault(key, {"n": 0, "ink": 0.0, "peak": 0.0, "crop": (x, y), "sig": small, "dims": dims, "best": -1.0})
            # show the member closest to a typical brightness for this shape, not an outlier
            score = -abs(peak - c["peak"] / max(1, c["n"])) if c["n"] else 0
            if score > c["best"] or c["n"] < 1:
                c["best"], c["crop"] = score, (x, y)
            c["n"] += 1
            c["ink"] += ink
            c["peak"] += peak
            rgb = arr[y : y + pitch_y, x : x + pitch_x].reshape(-1, 3).astype(float)
            lit = rgb[lum[y : y + pitch_y, x : x + pitch_x].reshape(-1) > peak * 0.5]
            if len(lit):
                m = lit.mean(0)
                hue_by_ink.append((peak, m / max(m.max(), 1e-6)))
    # second pass, looser: fold leftover splits of the same glyph into its biggest cluster
    merged = []
    for c in sorted(clusters.values(), key=lambda c: -c["n"]):
        home = next((m for m in merged if same_glyph(m, c["sig"], c["dims"], merge * 1.4, c["ink"] / c["n"])), None)
        if home is None:
            merged.append(dict(c))
            continue
        home["n"] += c["n"]
        home["ink"] += c["ink"]
        home["peak"] += c["peak"]
    out = []
    for c in merged:
        out.append({"n": c["n"], "ink": c["ink"] / c["n"], "peak": c["peak"] / c["n"], "at": c["crop"]})
    out.sort(key=lambda c: -c["n"])
    return out, hue_by_ink


def glyph_strip(arr, shapes, pitch_x, pitch_y, out, zoom=4, top=24):
    # the shader picks a glyph by luminance, so mean cell brightness orders the ramp
    picks = sorted([s for s in shapes if s["n"] >= 3][:top], key=lambda s: s["peak"])
    if not picks:
        return []
    tw, th = pitch_x * zoom, pitch_y * zoom
    pad = 18
    im = Image.new("RGB", (len(picks) * (tw + 6) + 6, th + pad + 8), (24, 24, 24))
    d = ImageDraw.Draw(im)
    for i, s in enumerate(picks):
        x, y = s["at"]
        crop = Image.fromarray(arr[y : y + pitch_y, x : x + pitch_x]).resize((tw, th), Image.NEAREST)
        px = 6 + i * (tw + 6)
        im.paste(crop, (px, 6))
        d.text((px, th + 9), f"{s['n']} L{s['peak']:.0f}", fill=(160, 160, 160))
    im.save(out)
    return picks


def contact_sheet(path, dur, out, cols=4):
    n = max(1, int(dur))
    tiles = []
    for t in range(n):
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{t + 0.5:.2f}", "-i", path, "-frames:v", "1", "-vf", "scale=480:-2",
             "-f", "image2pipe", "-vcodec", "png", "-"],
            capture_output=True,
        ).stdout
        if raw:
            from io import BytesIO

            im = Image.open(BytesIO(raw)).convert("RGB")
            ImageDraw.Draw(im).text((8, 6), f"{t + 0.5:.1f}s", fill=(255, 255, 0))
            tiles.append(im)
    if not tiles:
        return
    w, h = tiles[0].size
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (w * cols, h * rows))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * w, (i // cols) * h))
    sheet.save(out, quality=85)


def plot_curves(series, fps, out, w=900, h=300):
    im = Image.new("RGB", (w, h), (12, 12, 12))
    d = ImageDraw.Draw(im)
    n = len(next(iter(series.values())))
    colors = {"luminance": (230, 230, 230), "motion": (255, 150, 60)}
    for name, ys in series.items():
        ys = np.asarray(ys, float)
        top = ys.max() or 1
        pts = [(i * (w - 1) / max(1, n - 1), h - 24 - (y / top) * (h - 40)) for i, y in enumerate(ys)]
        d.line(pts, fill=colors.get(name, (200, 200, 200)), width=2)
    for s in range(int(n / fps) + 1):
        x = s * fps * (w - 1) / max(1, n - 1)
        d.line([(x, h - 20), (x, h - 14)], fill=(90, 90, 90))
        d.text((x + 2, h - 14), f"{s}", fill=(110, 110, 110))
    x = 8
    for name, c in colors.items():
        d.text((x, 6), name, fill=c)
        x += 90
    im.save(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", default="ref-analysis")
    ap.add_argument("--fps", type=float, default=10)
    ap.add_argument("--at", type=float, help="second to measure the grid on (default: busiest)")
    ap.add_argument("--thresh", type=float, default=40)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    o = lambda n: os.path.join(a.out, n)  # noqa: E731

    W, H, fps, dur = probe(a.video)
    print(f"{W}x{H}  {fps:.2f}fps  {dur:.2f}s  aspect {W / H:.4f}")

    # ---- motion over time, on small frames ----
    fr = frames_at(a.video, a.fps, 480)
    lum = fr.astype(np.float32).mean(3)
    mean_l = lum.mean((1, 2)) / 255
    lit = (lum > a.thresh).mean((1, 2))
    motion = np.r_[0, np.abs(np.diff(lum, axis=0)).mean((1, 2)) / 255]
    t = np.arange(len(fr)) / a.fps

    busiest_i = int(np.argmax(lit))
    at = a.at if a.at is not None else float(t[busiest_i])

    # approach: smoothed motion energy falls to within 15% of its resting floor after the peak
    # (a flickering glow keeps it above zero, so measure against the floor, not zero)
    sm = np.convolve(np.pad(motion, 2, mode="edge"), np.ones(5) / 5, "valid")
    peak_i = int(np.argmax(sm))
    floor = float(np.median(sm[peak_i:])) if peak_i < len(sm) - 1 else 0.0
    floor = min(floor, float(np.percentile(sm[peak_i:], 25)))
    settle = next((i for i in range(peak_i, len(sm)) if sm[i] < floor + (sm[peak_i] - floor) * 0.15), None)
    approach = float(t[settle]) if settle else None

    # glow / flash: the steepest sustained rise in mean luminance, start to end
    glow_on = glow_full = None
    lsm = np.convolve(np.pad(mean_l, 2, mode="edge"), np.ones(5) / 5, "valid")
    dl = np.gradient(lsm)
    j = int(np.argmax(dl[2:-2])) + 2 if len(dl) > 6 else 0
    if j and dl[j] > 0 and (lsm.max() - lsm.min()) > 0.002 and dl[j] * a.fps > 3 * np.median(np.abs(dl)) * a.fps:
        s0 = j
        while s0 > 0 and dl[s0 - 1] > dl[j] * 0.3:
            s0 -= 1
        s1 = j
        while s1 < len(dl) - 1 and dl[s1 + 1] > dl[j] * 0.3:
            s1 += 1
        glow_on, glow_full = float(t[s0]), float(t[s1])

    # loop style: correlate the first and last frames (raw pixel diff is fooled by mostly-black frames)
    first, last = fr[0].astype(float).ravel(), fr[-1].astype(float).ravel()
    seam_corr = float(np.corrcoef(first, last)[0, 1]) if first.std() and last.std() else 1.0
    half = len(mean_l) // 2
    sym = float(np.corrcoef(mean_l[:half], mean_l[::-1][:half])[0, 1]) if half > 4 else 0.0
    if sym > 0.9:
        loop_style = "ping-pong (luminance curve mirrors itself)"
    elif seam_corr > 0.92:
        loop_style = "seamless loop (last frame matches the first)"
    else:
        loop_style = "hard cut (last frame differs from the first)"
    ramp_up = float(np.polyfit(t, mean_l, 1)[0]) if len(t) > 2 else 0.0

    # ---- grid on a full-res frame ----
    arr = full_frame(a.video, at, o("frame.png"))
    L = arr.astype(float).mean(2)
    bg = arr[: H // 10, : W // 10].reshape(-1, 3).mean(0).round(1).tolist()
    x, y, rw, rh = busiest(L, a.thresh)
    on = L[y : y + rh, x : x + rw] > a.thresh
    px = period(on.sum(0).astype(float))
    py = period(on.sum(1).astype(float)) or px
    if not px:
        sys.exit("no grid found: try --at on a busier second or lower --thresh")
    ox = phase((L > a.thresh).sum(0).astype(float), px)
    oy = phase((L > a.thresh).sum(1).astype(float), py)
    Image.fromarray(arr[y : y + rh, x : x + rw]).resize((rw * 3, rh * 3), Image.NEAREST).save(o("zoom.png"))
    print(f"grid: pitch {px}x{py}px, phase {ox},{oy}, cell = {px}/{H} = {px / H:.6f}")

    # ---- glyphs and color model ----
    shapes, hues = glyph_shapes(arr, px, py, ox, oy, a.thresh)
    picks = glyph_strip(arr, shapes, px, py, o("glyphs.png"))
    tiles = [s for s in shapes if s["ink"] > 0.3 and s["n"] >= 3]
    color_model = "unknown"
    if len(hues) > 20:
        hues.sort(key=lambda h: h[0])
        k = max(1, len(hues) // 4)
        dim = np.mean([h for _, h in hues[:k]], 0)
        hot = np.mean([h for _, h in hues[-k:]], 0)
        drift = float(np.abs(dim - hot).max())
        color_model = (
            "per-cell source color, dim glyphs keep the hue (template default)"
            if drift < 0.25
            else f"hue shifts with brightness (dim {dim.round(2).tolist()} vs bright {hot.round(2).tolist()}): use tints or the glow"
        )

    contact_sheet(a.video, dur, o("sheet.jpg"))
    plot_curves({"luminance": mean_l, "motion": sm}, a.fps, o("curves.png"))

    report = {
        "video": os.path.abspath(a.video),
        "size": [W, H], "aspect": W / H, "fps": fps, "duration": dur,
        "background": bg,
        "grid": {"pitch": [px, py], "phase": [ox, oy], "cell": px / H, "cells": [W / px, H / py], "measured_at": at},
        "glyphs": {"distinct": len(shapes), "strip_dim_to_bright": [{"n": p["n"], "brightness": round(p["peak"], 1), "ink": round(p["ink"], 3)} for p in picks],
                   "tile_like": len(tiles)},
        "color_model": color_model,
        "motion": {"approach_end": approach, "glow_onset": glow_on, "loop_style": loop_style,
                   "seam_corr": seam_corr, "glow_full": glow_full, "symmetry": sym, "luminance_trend_per_s": ramp_up,
                   "luminance": [round(v, 4) for v in mean_l.tolist()], "sample_fps": a.fps},
    }
    with open(o("report.json"), "w") as f:
        json.dump(report, f, indent=1)

    ping = "ping-pong" in loop_style
    loop_s = dur / 2 if ping else dur
    md = f"""# reference analysis

source: `{a.video}` ({W}x{H}, {fps:.2f}fps, {dur:.2f}s). A measuring tool only: never ship it or its frames.

| | |
|---|---|
| aspect | {W / H:.4f} (`{W} / {H}`) |
| background | {bg} {"(true black)" if max(bg) < 4 else "(not black: check the color model)"} |
| grid pitch | {px} x {py} px, phase {ox},{oy} (measured at {at:.1f}s) |
| cell | `{px} / {H}` = {px / H:.6f} |
| cells across / down | {W / px:.1f} / {H / py:.1f} |
| distinct glyph shapes | {len(shapes)} ({len(tiles)} tile-like, ink > 30%) |
| color model | {color_model} |
| approach ends | {f"{approach:.1f}s" if approach else "no clear settle"} |
| glow / flash | {f"{glow_on:.1f}s to {glow_full:.1f}s (steepest luminance rise)" if glow_on else "none"} |
| loop | {loop_style} |
| exposure trend | {ramp_up:+.4f} mean luminance per second {"(rising ramp)" if ramp_up > 0.002 else ""} |

Read next, in order:
1. `glyphs.png`: distinct shapes sorted by mean cell brightness (count and `L` under each). That order is
   the ramp, dim to bright.
   Merge near-duplicates (antialiasing splits one glyph into a few shapes), drop one-offs. A solid or
   knocked-out block at the bright end is `'TILE'`.
2. `zoom.png`: confirm the glyphs and the per-cell color by eye.
3. `sheet.jpg` + `curves.png`: what moves, when it settles, when the glow lands. The curves are
   numbers to start from; positions still come from reading the frames (fractions of the frame).

Starting config (layers, poses and the ramp still to fill in):

```ts
const CONFIG: AsciiConfig = {{
  aspect: {W} / {H},
  cell: {px} / {H},
  ramp: [' ', /* from glyphs.png, dim to bright */],
  layers: [/* your own cutouts or footage */],
{f"  glow: {{ at: 'anchors', start: {glow_on:.1f}, end: {glow_full:.1f} }}," if glow_on else ""}
  timeline: {{ loop: {loop_s:.2f}, approach: {(approach or loop_s * 0.7):.2f}, pingPong: {"true" if ping or seam_corr <= 0.92 else "false"} }},
  gamma: 1.9,
}}
```
"""
    with open(o("REPORT.md"), "w") as f:
        f.write(md)
    print(f"wrote {a.out}/REPORT.md, report.json, frame.png, zoom.png, glyphs.png, sheet.jpg, curves.png")


if __name__ == "__main__":
    main()
