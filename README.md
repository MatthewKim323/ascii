# ascii

A Claude Code skill for live ASCII art: a WebGL2 glyph shader as a React component, plus the tooling to match
an existing ASCII video 1:1 on your own (legal) source content, or to turn your own footage into live ASCII.

- `SKILL.md`: the method (measure a reference, legal sources and cutouts, build, interact, verify, gotchas)
- `templates/AsciiField.tsx`: dependency-free React + WebGL2 renderer, config-driven (image or video layers,
  luma/chroma keys, ramp, glow, timeline with ping-pong, pointer lift, rush region, decode scramble,
  reduced motion, pause offscreen)
- `scripts/analyze_ref.py`: one-shot measurement of a reference ASCII video (grid, cell, glyph strip, color
  model, approach, glow window, loop style, contact sheet, curves, REPORT.md with a starting config)
- `scripts/prep_video.py`: your footage to a small web clip (trim, crop, ~2px per cell, ping-pong loop,
  mp4 + webm + poster)
- `scripts/measure_grid.py`: cell pitch by autocorrelation, aspect, background, zoomed glyph crop
- `scripts/cutout.py`: saturation/warmth segmentation + polygon + feather to transparent PNG/WebP
- `scripts/compare.mjs`: your render beside the reference at fixed seconds, glyph zooms, hero shots

Install: clone into `~/.claude/skills/ascii`. Scripts need Python 3 with numpy + Pillow, ffmpeg, and
playwright for `compare.mjs`.
