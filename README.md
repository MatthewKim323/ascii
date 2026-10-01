# ascii

A Claude Code skill for live ASCII art: a WebGL2 glyph shader as a React component, plus the tooling to match
an existing ASCII video 1:1 on your own (legal) source content.

- `SKILL.md`: the method (measure a reference, legal sources and cutouts, build, interact, verify, gotchas)
- `templates/AsciiField.tsx`: dependency-free React + WebGL2 renderer, config-driven (layers, ramp, glow,
  timeline with ping-pong, pointer lift, rush region, decode scramble, reduced motion, pause offscreen)
- `scripts/measure_grid.py`: cell pitch by autocorrelation, aspect, background, zoomed glyph crop
- `scripts/cutout.py`: saturation/warmth segmentation + polygon + feather to transparent PNG/WebP
- `scripts/compare.mjs`: your render beside the reference at fixed seconds, glyph zooms, hero shots

Install: clone into `~/.claude/skills/ascii`. Scripts need Python 3 with numpy + Pillow, ffmpeg, and
playwright for `compare.mjs`.
