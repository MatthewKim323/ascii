#!/usr/bin/env python3
"""
Turn your own footage into a small, web-ready video layer for AsciiField.

The shader samples one texel per glyph cell, so the clip only needs about two
pixels per cell: a 90-cells-tall grid wants ~180px of height. Shipping 4K
footage under an ASCII field is megabytes of nothing.

usage:
  prep_video.py <clip> --out public/art/clip [--ss 2 --t 6] [--crop x,y,w,h]
                [--cell 0.011 | --height 360] [--fps 30] [--pingpong] [--alpha]

  --ss/--t    trim: start second and duration
  --crop      crop in source pixels before scaling (frame the subject)
  --cell      AsciiConfig.cell; sizes the clip to ~2px per cell (overrides --height)
  --height    output height in px (default 360)
  --pingpong  append the clip reversed so the loop has no seam
  --alpha     keep the source's alpha (prores 4444, png sequence, vp9 alpha): writes
              a VP9-alpha webm only, since mp4/h264 has no alpha. No alpha in the source?
              Key it in the shader instead (Layer.key, luma or chroma).

writes <out>.mp4 (h264) and <out>.webm (vp9), <out>-poster.webp (first frame),
and prints the AsciiConfig layer to paste.
"""
import argparse
import json
import os
import subprocess
import sys
from io import BytesIO

from PIL import Image


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ffmpeg failed:\n{r.stderr[-1500:]}")
    return r.stdout


def probe(path):
    out = json.loads(
        sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,pix_fmt:format=duration", "-of", "json", path])
    )
    s = out["streams"][0]
    return int(s["width"]), int(s["height"]), s.get("pix_fmt", ""), float(out["format"].get("duration", 0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ss", type=float)
    ap.add_argument("--t", type=float)
    ap.add_argument("--crop")
    ap.add_argument("--cell", type=float)
    ap.add_argument("--height", type=int, default=360)
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--pingpong", action="store_true")
    ap.add_argument("--alpha", action="store_true")
    ap.add_argument("--crf", type=int, default=26)
    a = ap.parse_args()

    W, H, pix, dur = probe(a.clip)
    if a.alpha and not any(k in pix for k in ("yuva", "rgba", "argb", "bgra", "ya")):
        print(f"warning: source pix_fmt {pix} has no alpha; the webm will be opaque. Use Layer.key instead.")

    height = round(2 / a.cell) if a.cell else a.height
    height = max(64, height // 2 * 2)

    chain = []
    if a.crop:
        x, y, w, h = map(int, a.crop.split(","))
        chain.append(f"crop={w}:{h}:{x}:{y}")
        W, H = w, h
    chain += [f"fps={a.fps}", f"scale=-2:{height}:flags=area"]
    vf = ",".join(chain)
    if a.pingpong:
        vf = f"{vf},split[f][r];[r]reverse[b];[f][b]concat=n=2:v=1:a=0"

    trim = (["-ss", str(a.ss)] if a.ss is not None else []) + (["-t", str(a.t)] if a.t else [])
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    base = ["ffmpeg", "-v", "error", "-y", *trim, "-i", a.clip, "-an", "-filter_complex" if a.pingpong else "-vf", vf]

    outs = []
    if not a.alpha:
        sh(base + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(a.crf), "-preset", "slow",
                   "-movflags", "+faststart", f"{a.out}.mp4"])
        outs.append(f"{a.out}.mp4")
    sh(base + ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(a.crf + 8), "-row-mt", "1",
               "-pix_fmt", "yuva420p" if a.alpha else "yuv420p", *(["-auto-alt-ref", "0"] if a.alpha else []),
               f"{a.out}.webm"])
    outs.append(f"{a.out}.webm")
    # many ffmpeg builds ship without a webp encoder, so grab a png and let Pillow encode it
    png = subprocess.run(["ffmpeg", "-v", "error", "-i", outs[0], "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                         capture_output=True, check=True).stdout
    Image.open(BytesIO(png)).save(f"{a.out}-poster.webp", quality=80)

    ow, oh, _, odur = probe(outs[0])
    for o in outs:
        print(f"wrote {o}  {ow}x{oh}  {odur:.2f}s  {os.path.getsize(o) / 1024:.0f} KB")
    print(f"wrote {a.out}-poster.webp")

    url = "/" + a.out.split("public/", 1)[1] if "public/" in a.out else a.out
    src = f"{url}.webm" if a.alpha else f"{url}.mp4"
    print(f"""
layer (full frame, the clip is the motion):
  {{ src: '{src}', tint: {{ mode: 'source' }} }}
  with aspect: {ow} / {oh} to frame it exactly
layer (placed like a cutout; key out a flat background if it has no alpha):
  {{ src: '{src}', width: 0.8, from: {{ x: 0.5, y: 0.5 }}, key: {{ mode: 'luma', low: 0.05, high: 0.2 }} }}""")


if __name__ == "__main__":
    main()
