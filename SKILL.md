---
name: ascii
description: |
  Turn an image, cutout, video or scene into live ASCII art: a WebGL2 glyph shader as a React component,
  with a measured glyph ramp, per-cell color, a timeline (approach, glow, hold, ping-pong) and optional
  pointer interaction. Two modes: recreate an existing ASCII video or effect 1:1 from a reference (measure
  pitch, ramp, color model, motion, layout, then rebuild it on legal source content), or make new ASCII art
  from your own image/video/scene. Use when asked for an "ascii shader", "ascii background", "ascii hero",
  "turn this into ascii", "glyph art", "text-mode art", "character art", "match this ascii video 1:1",
  "make our own version of this ascii animation", "replace this ascii video with a shader", "ascii".
---

# ascii

Live ASCII art as a shader. The scene (cutout layers plus an optional glow) is evaluated once per grid
cell at the cell's center; luminance picks a glyph off a ramp, the scene color tints it, the background
stays black. Ships a dependency-free React component, three helper scripts and a verification rig.

Files in this skill:

- `templates/AsciiField.tsx`: the renderer. Copy it into the project. Config-driven: aspect, cell size,
  ramp, up to 4 layers with keyframed poses and tints, glow, focus shading, timeline, interaction.
- `scripts/measure_grid.py`: cell pitch by autocorrelation, frame aspect, background, zoomed glyph crop.
- `scripts/cutout.py`: segment a subject off a flat ground into a transparent PNG/WebP layer.
- `scripts/compare.mjs`: render your field at fixed seconds beside the reference frame, zoomed glyph
  crops, hero screenshots, console errors.

## Pick the mode

- **Recreate (1:1 from a reference):** someone has an ASCII video or effect and wants their own version
  that looks the same. Measure everything first (section 1), rebuild on legal content (section 2).
- **Create (new art):** the user has their own image/video/scene. Skip measuring; pick a ramp, a cell size
  and a palette, then go to sections 2 and 3.

Either way the deliverable is the shader component, not a video file: crisp at any size, a few KB of
textures instead of megabytes of video, and it can react to the pointer.

## 1. Measure the reference (recreate mode)

Never eyeball a number. Pull frames and measure.

```bash
ffmpeg -i ref.mp4 -vf "fps=1,scale=900:-1" frames/%02d.jpg       # overview, one per second
ffmpeg -ss 8 -i ref.mp4 -frames:v 1 full8.png                     # one full-res frame
python3 ~/.claude/skills/ascii/scripts/measure_grid.py full8.png --region x,y,w,h --crop x,y,w,h --zoom 3
```

1. **Grid:** `measure_grid.py` autocorrelates column and row activity in a busy region and prints the pitch
   and `cell = pitch / frameHeight`. That fraction is `AsciiConfig.cell`. Screen recordings are usually 2x,
   so 21px in a 3696px-wide recording is 10.5 CSS px; the fraction makes that irrelevant.
2. **Ramp:** read the zoomed nearest-neighbor crop, dim to bright. Typical: `. : - + * % # @`. Watch for a
   filled or inverted cell at the very top (a solid block, or a box with a dark `?` cut out, which is a
   font's missing-glyph tile). The template supports it as the literal `'TILE'`.
3. **Color model:** usually each glyph takes the source pixel's color on pure black; dim glyphs are dim in
   the same hue. Check the background is truly `[0,0,0]` (the script prints it).
4. **Motion:** sample at 10fps and track what moves: bounding boxes of each colored region per second, mean
   luminance over time (a rising exposure ramp is common), when a glow appears, and whether the loop
   hard-cuts or plays back. Classification by color is noisy; read trends, then confirm by eye on a frame grid
   (`ffmpeg ... -filter_complex "[0][1][2]hstack=3[a];[3][4][5]hstack=3[b];[a][b]vstack=2"`).
5. **Layout:** write every key position as a fraction of the frame (x as a fraction of width times the aspect,
   y as a fraction of height). Those are the template's design units, so they survive any canvas size.
6. **Easing:** if the motion starts slow and lands slow, it is in-out. Measure two or three positions over
   time before choosing; an ease-out makes things meet far too early.

## 2. Legal source content

Never run someone else's video or footage through the shader. The output would still be their work. The
shader treatment (grid, ramp, color model, timing) is the part you are matching; the pixels underneath
must be the user's own or public domain.

- **Public domain:** query Wikimedia Commons and check the license field before downloading:
  `curl "https://commons.wikimedia.org/w/api.php?action=query&titles=File:<Name>.jpg&prop=imageinfo&iiprop=url|size|extmetadata&format=json"`
  then read `extmetadata.LicenseShortName` (want "Public domain") and use `imageinfo[0].url`.
  Old paintings, NASA imagery and similar are good sources.
- **The user's own** photos, renders or video.

Cut subjects out into transparent layers with `scripts/cutout.py`:

```bash
python3 ~/.claude/skills/ascii/scripts/cutout.py src.jpg --crop x0,y0,x1,y1 --out arm-left          # raw mask first
python3 ~/.claude/skills/ascii/scripts/cutout.py src.jpg --crop x0,y0,x1,y1 --out arm-left \
  --poly "0,215 250,192 470,165 ..." --preview                                                       # then bound it
```

It keeps saturated, warm pixels against a flat desaturated ground (plaster, sky, studio wall), ANDs that with a
hand-drawn polygon so the ground never leaks, feathers the edge, crops to the alpha bbox and writes PNG + WebP.
A thin fringe of ground under the dimmest glyph does not matter at typical cell sizes. Ship the WebP: a few
tens of KB per layer.

## 3. Build the renderer

Copy `templates/AsciiField.tsx` into the project (any React stack, no other deps) and describe the scene with
an `AsciiConfig`. The bottom of the template has a full worked config (two reaching arms) to start from.

What the template does, and the knobs:

- **Glyph atlas:** the ramp is drawn once onto a 2D canvas (monospace, white on black), rebuilt only when the
  cell size changes. `'TILE'` draws a filled block with a dark bold `?` knocked out.
- **Cell size is a fraction of the frame**, not pixels: `cell = max(w / aspect, h) * config.cell`. The grid then
  has the same number of cells across the covered frame at every canvas size, which is what a video
  `object-fit: cover`'d into the box would show.
- **Cover-fit mapping:** design space is x in `[0, aspect]`, y in `[0, 1]` top-down. Each cell center maps into
  it the way `object-fit: cover` would.
- **Layers** (up to 4): a transparent image, a width in design units, `from` and `to` poses (x, y, rot), a tint
  (`grey` with a keep amount and multiplier, `color` pushes luminance through an RGB, or `source`), and an
  optional `anchor` in the layer's own uv (a fingertip, a nose) that the glow, focus and pointer use.
  Later layers paint over earlier ones. Poses are solved in JS each frame, so the shader only samples.
- **Luminance to glyph:** `lum = pow(luma * alpha, gamma)`, `idx = floor(lum * rampLength)`. `gamma` 1.6 to 2.0
  keeps most of a subject on dim glyphs with only highlights climbing to `@` and tiles, which is what
  reference ASCII video usually looks like.
- **Glyph color:** the scene color normalized to its max channel, scaled by `mix(0.35, 1, lum)`, so dim glyphs
  stay legible in the right hue.
- **Focus:** optional shading that darkens layers away from a point so the subject carries the light.
- **Glow:** optional hot core plus rayed halo that fades in between two timeline seconds, at a fixed point or
  between the first two layers' anchors.
- **Timeline:** `approach` seconds of smoothstep (in-out) from `from` to `to` inside a `loop`; `pingPong: true`
  plays back instead of hard-cutting, which reads better on a hero that loops forever.
- **Pausing:** pass `playing={inView && !document.hidden}`; when paused it holds the last frame and skips GPU
  work. Reduced motion freezes on the end state with no listeners.
- **Freeze for checks:** the `time` prop pins a timeline second. Wire a route like `/?ascii&t=6.5` that
  renders only the field full-bleed on black with `time` from the query; the compare script uses it.

Keep the `config` object stable (module scope or `useMemo`); a new object every render rebuilds the GL program.

## 4. Interaction menu

All optional, all in `config.interact`. Offer these, build what the user picks.

- **Lift toward the pointer** (`lift`, `near`, `far`, `stiffness`): layers with an `anchor` drift up or down
  toward the pointer's height on a spring. Vertical only; turning or stretching toward the pointer reads as
  twitchy. Start at `lift: 0.03`, `far: 0.6`, `stiffness: 2.2`. **Keep it subtle**: the first pass is almost
  always too reactive (a user's exact feedback was "too reactive"); halve it before showing.
- **Rush region** (`rushAt`, `rushRadius`, `rush`): pointer near a point (default between the anchors) speeds
  the approach up to `1 + rush` times, and on the way back in ping-pong it holds the end state instead of
  rushing apart.
- **Decode scramble** (`scramble` radius): while the pointer moves, glyphs near it flip to random characters
  (plus faint grey noise in empty cells), then resolve back as it rests. Strength follows pointer speed:
  fast rise, slow settle. It runs on a separate wall clock (`u_wall`), never the timeline clock, or it would
  freeze when the timeline pauses or ping-pongs.

The listeners sit on `window` so the art still reacts under overlaid headlines and buttons.

## 5. Verify

```bash
node ~/.claude/skills/ascii/scripts/compare.mjs --url "http://localhost:5173/?ascii" --ref ref.mp4 \
  --out cmp --times 1,4,7,9 --w 1848 --h 1152 --crop 700,380,380,240 --hero http://localhost:5173/
```

- `pair-<t>.jpg`: reference left, yours right, at the same second. `grid.jpg` stacks them. Check composition,
  timing, overall darkness.
- `zoom-<t>.png`: the same crop from both at 2x nearest-neighbor. Check glyph shapes, ramp, tile frequency, hue.
- `hero-1440.png`, `hero-390.png`: the field in place, after 7.5s, with console errors listed.
- Headless WebGL needs `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` (the script sets
  them) or the canvas renders black. Swiftshader is slow; it is fine for stills, not for judging smoothness.
- Interaction: drive `page.mouse.move` in playwright, screenshot at rest, with the pointer held near, and
  mid-sweep, then zoom the sweep to confirm the scramble.

Iterate one knob at a time: positions and scale, then gamma, then tints, then glow, re-rendering pairs each time.

## 6. Gotchas

- **Fixed px cells** look right at one size and too chunky elsewhere. Always the fraction of the frame.
- **Overexposed glow** floods a big area with tiles. Shrink the halo radius and strength before touching gamma.
- **Gamma crushes one layer:** raising gamma for contrast can push a warm layer (lower luma) to nothing.
  Rebalance its tint multiplier so its luminance roughly matches the other layers.
- **React StrictMode** runs effects twice in dev. Everything created in the effect must be torn down in its
  cleanup (the template does).
- **Refs written during render** trip the React lint rule; sync props into refs in an effect.
- **Ease-out** makes things meet too early. Use in-out unless measurement says otherwise.
- **Hard-cut loops** jump; ping-pong unless the reference really cuts.
- **Cutout leaks:** if ground shows as dim glyphs around a subject, tighten the polygon, not the thresholds.
- **Never ship the reference video** in the project or its git history; it is only a measuring tool. If it was
  committed earlier, say so; removing it from the working tree does not remove it from history.
