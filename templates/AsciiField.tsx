import { useEffect, useRef } from 'react'

/*
 * AsciiField: a scene of cutout layers rendered as live ASCII on a WebGL2 canvas.
 *
 * A layer is a still (transparent webp/png) or a video (mp4/webm, re-uploaded
 * every new frame; key out a flat background with `key` when it has no alpha).
 * Every frame the scene (up to 4 textured layers, an optional glow) is
 * evaluated once per grid cell at the cell's center. The cell's luminance
 * picks a glyph off the ramp, the scene color tints it, the background stays
 * black. Layer transforms are solved in JS each frame (keyframes, pointer
 * lift), so the shader only samples.
 *
 * No dependencies beyond React. Drop it into a sized parent (it fills it,
 * cover-fit like object-fit: cover).
 */

// ---------- config types ----------

export type Vec2 = [number, number]

/** one pose of a layer: center in design units, rotation in radians */
export type Pose = { x: number; y: number; rot?: number }

export type Tint =
  /** grey with a hint of the source color, then multiplied (cool white, etc) */
  | { mode: 'grey'; keep?: number; mul?: [number, number, number] }
  /** luminance pushed through a color (warm, neon, etc) */
  | { mode: 'color'; rgb: [number, number, number] }
  /** the texture's own color */
  | { mode: 'source' }

/** turn part of a layer transparent: footage shot on black, or on a flat screen color */
export type Key =
  /** dark is transparent: alpha ramps from 0 at `low` luma to 1 at `high` */
  | { mode: 'luma'; low?: number; high?: number }
  /** near `rgb` is transparent: alpha ramps from 0 inside `tol` (rgb distance) to 1 at `tol + soft` */
  | { mode: 'chroma'; rgb: [number, number, number]; tol?: number; soft?: number }

export type Layer = {
  /** url of a transparent image (webp/png cutout) or a video (mp4/webm/mov; treated as video by extension or `video`) */
  src: string
  /** force video handling for urls without a video extension */
  video?: boolean
  /** video playback rate (1 is real time) */
  rate?: number
  /** width in design units, height follows the source aspect. Default: covers the whole frame */
  width?: number
  /** pose at timeline start and at the end of the approach. Default: centered, still */
  from?: Pose
  to?: Pose
  key?: Key
  tint?: Tint
  /** a point of the layer (in its own uv, 0..1) that answers the pointer, e.g. a fingertip */
  anchor?: Vec2
}

export type Glow = {
  /** design-space position, or 'anchors' to sit between the first two layers' anchors */
  at: Vec2 | 'anchors'
  /** timeline seconds where it fades in */
  start: number
  end: number
  core?: [number, number, number]
  halo?: [number, number, number]
  /** halo falloff distance in design units */
  radius?: number
  strength?: number
}

export type AsciiConfig = {
  /** design frame width / height (match the reference video's aspect) */
  aspect: number
  /** cell size as a fraction of the covered frame's height (pitch px / frame height px) */
  cell: number
  /** dim to bright; ' ' first; the literal 'TILE' renders an inverted '?' block */
  ramp: string[]
  layers: Layer[]
  glow?: Glow
  /** pose keyframes; leave out for still layers or plain footage */
  timeline?: {
    /** seconds of approach + hold before it loops or reverses */
    loop: number
    /** seconds the from->to approach takes inside the loop */
    approach: number
    /** true: play forward then backward; false: hard cut back to the start */
    pingPong?: boolean
  }
  /** luminance exponent; higher is darker and more contrasty (1.6 to 2.0 is typical) */
  gamma?: number
  /** shade layers down away from this point so the subject carries the light */
  focus?: { at: Vec2 | 'anchors'; near: number; far: number; min: number; max: number }
  interact?: {
    /** max vertical drift toward the pointer, design units (keep it small, 0.02 to 0.03) */
    lift?: number
    near?: number
    far?: number
    stiffness?: number
    /** pointer near this point speeds the approach and holds the end on the way back */
    rushAt?: Vec2 | 'anchors'
    rushRadius?: number
    rush?: number
    /** glyph scramble radius around a moving pointer, design units (0 disables) */
    scramble?: number
  }
}

// ---------- shader ----------

const MAX_LAYERS = 4

const vert = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const frag = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 u_res;
uniform float u_cell;
uniform float u_time;
uniform float u_wall;
uniform float u_aspect;
uniform float u_gamma;
uniform sampler2D u_atlas;
uniform float u_glyphs;

uniform int u_count;
uniform sampler2D u_tex0;
uniform sampler2D u_tex1;
uniform sampler2D u_tex2;
uniform sampler2D u_tex3;
uniform vec3 u_xf[${MAX_LAYERS}];     // center xy, rotation
uniform vec2 u_size[${MAX_LAYERS}];   // design units
uniform vec4 u_tint[${MAX_LAYERS}];   // mode (0 grey, 1 color, 2 source), keep
uniform vec3 u_mul[${MAX_LAYERS}];
uniform vec4 u_key[${MAX_LAYERS}];    // mode (0 none, 1 luma, 2 chroma), low/tol, high/soft
uniform vec3 u_keyRgb[${MAX_LAYERS}];

uniform vec4 u_focus;   // near, far, min, max (max <= 0 disables)
uniform vec2 u_focusAt;
uniform vec4 u_glow;    // start, end, radius, strength (strength <= 0 disables)
uniform vec2 u_glowAt;
uniform vec3 u_core;
uniform vec3 u_halo;
uniform float u_k;      // approach progress 0..1
uniform vec2 u_pointer;
uniform float u_scramble;
uniform float u_scrambleR;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec4 sampleLayer(int i, vec2 p) {
  vec3 xf = u_xf[i];
  vec2 d = p - xf.xy;
  float c = cos(-xf.z), s = sin(-xf.z);
  d = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  vec2 uv = d / u_size[i] + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  vec4 px;
  if (i == 0) px = texture(u_tex0, uv);
  else if (i == 1) px = texture(u_tex1, uv);
  else if (i == 2) px = texture(u_tex2, uv);
  else px = texture(u_tex3, uv);
  vec4 k = u_key[i];
  if (k.x > 1.5) px.a *= smoothstep(k.y, k.y + k.z, distance(px.rgb, u_keyRgb[i]));
  else if (k.x > 0.5) px.a *= smoothstep(k.y, k.z, dot(px.rgb, vec3(0.299, 0.587, 0.114)));
  return px;
}

vec3 tinted(int i, vec3 rgb) {
  float g = dot(rgb, vec3(0.299, 0.587, 0.114));
  vec4 t = u_tint[i];
  if (t.x < 0.5) return mix(vec3(g), rgb, t.y) * u_mul[i];
  if (t.x < 1.5) return g * u_mul[i];
  return rgb;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 cell = floor(frag / u_cell);
  vec2 local = (frag - cell * u_cell) / u_cell;
  vec2 center = (cell + 0.5) * u_cell;

  // cover-fit the design frame: x in [0, aspect], y in [0, 1]
  float unit = max(u_res.x / u_aspect, u_res.y);
  vec2 p = (center - u_res * 0.5) / unit + vec2(u_aspect * 0.5, 0.5);

  // later layers paint over earlier ones
  vec3 col = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < ${MAX_LAYERS}; i++) {
    if (i >= u_count) break;
    vec4 L = sampleLayer(i, p);
    col = mix(col, tinted(i, L.rgb), L.a);
    a = max(a, L.a);
  }

  if (u_focus.w > 0.0) col *= mix(u_focus.z, u_focus.w, smoothstep(u_focus.y, u_focus.x, distance(p, u_focusAt)));
  col *= mix(0.8, 1.15, u_k);

  if (u_glow.w > 0.0) {
    float on = smoothstep(u_glow.x, u_glow.y, u_time);
    float dist = distance(p, u_glowAt);
    vec2 d = p - u_glowAt;
    float rays = 0.6 + 0.4 * pow(abs(sin(atan(d.y, d.x) * 3.0 + 0.4)), 6.0);
    float flick = 0.85 + 0.15 * sin(u_time * 23.0 + hash(cell) * 6.28);
    float core = exp(-dist * dist / 0.0012);
    float halo = exp(-dist / u_glow.z) * rays;
    float g = on * flick * (core + halo) * u_glow.w;
    col += mix(u_halo, u_core, clamp(core * 1.6, 0.0, 1.0)) * g;
    a = max(a, clamp(g, 0.0, 1.0));
  }

  float lum = pow(clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0) * a, u_gamma);
  float idx = floor(clamp(lum, 0.0, 0.999) * u_glyphs);

  // decode scramble: glyphs near a moving pointer flip to random characters
  float near = u_scramble * smoothstep(u_scrambleR, u_scrambleR * 0.2, distance(p, u_pointer));
  float tick = floor(u_wall * 18.0 + hash(cell) * 7.0);
  float roll = hash(cell + tick * 0.137);
  if (idx >= 1.0 && roll < near) {
    idx = 1.0 + floor(hash(cell * 1.31 + tick) * (u_glyphs - 1.0));
  } else if (idx < 1.0 && roll < near * 0.35) {
    idx = 1.0 + floor(hash(cell + tick * 0.71) * 3.0);
    col = vec3(0.32, 0.3, 0.3);
    lum = 0.18;
  }
  if (idx < 1.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float ink = texture(u_atlas, vec2((idx + local.x) / u_glyphs, local.y)).r;
  vec3 tint = col / max(max(col.r, max(col.g, col.b)), 1e-3);
  outColor = vec4(tint * mix(0.35, 1.0, lum) * ink, 1.0);
}
`

// ---------- helpers ----------

function buildAtlas(ramp: string[], cellPx: number) {
  const size = Math.max(8, Math.round(cellPx))
  const canvas = document.createElement('canvas')
  canvas.width = size * ramp.length
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const font = `${Math.round(size * 0.92)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ramp.forEach((g, i) => {
    const cx = i * size + size / 2
    const cy = size / 2 + size * 0.04
    if (g === 'TILE') {
      const inset = size * 0.14
      ctx.fillStyle = '#fff'
      ctx.fillRect(i * size + inset, inset * 0.6, size - inset * 2, size - inset * 1.2)
      ctx.fillStyle = '#000'
      ctx.font = `bold ${font}`
      ctx.fillText('?', cx, cy)
      return
    }
    ctx.fillStyle = '#fff'
    ctx.font = font
    ctx.fillText(g, cx, cy)
  })
  return canvas
}

type Source = { el: HTMLImageElement | HTMLVideoElement; w: number; h: number; video: HTMLVideoElement | null }

const isVideo = (l: Layer) => l.video ?? /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(l.src)

function loadSource(l: Layer) {
  return new Promise<Source>((resolve, reject) => {
    if (!isVideo(l)) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve({ el: img, w: img.naturalWidth, h: img.naturalHeight, video: null })
      img.onerror = reject
      img.src = l.src
      return
    }
    // muted + playsInline or mobile browsers refuse to autoplay it
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.loop = true
    v.playsInline = true
    v.preload = 'auto'
    v.playbackRate = l.rate ?? 1
    v.onloadeddata = () => resolve({ el: v, w: v.videoWidth, h: v.videoHeight, video: v })
    v.onerror = () => reject(new Error(`video failed: ${l.src}`))
    v.src = l.src
    v.load()
  })
}

/** seek a video and wait until that frame is decoded */
function seek(v: HTMLVideoElement, t: number) {
  return new Promise<void>((resolve) => {
    const d = v.duration || 0
    const to = d > 0 ? t % d : 0
    if (Math.abs(v.currentTime - to) < 1e-3 && v.readyState >= 2) return resolve()
    v.addEventListener('seeked', () => resolve(), { once: true })
    v.currentTime = to
  })
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader')
  return sh
}

function upload(gl: WebGL2RenderingContext, src: TexImageSource, unit: number) {
  const tex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const smooth = (e0: number, e1: number, x: number) => {
  if (e1 === e0) return x >= e1 ? 1 : 0
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return k * k * (3 - 2 * k)
}
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])
const rotate = ([x, y]: Vec2, r: number): Vec2 => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]

type Xf = [number, number, number]
type Placed = Layer & { from: Pose; to: Pose }
const poseAt = (l: Placed, k: number): Xf => [lerp(l.from.x, l.to.x, k), lerp(l.from.y, l.to.y, k), lerp(l.from.rot ?? 0, l.to.rot ?? 0, k)]
const pointOf = (xf: Xf, size: Vec2, uv: Vec2): Vec2 => {
  const [ox, oy] = rotate([(uv[0] - 0.5) * size[0], (uv[1] - 0.5) * size[1]], xf[2])
  return [xf[0] + ox, xf[1] + oy]
}

// ---------- component ----------

type Props = {
  config: AsciiConfig
  /** pause the clock (pass false when scrolled away or the tab is hidden) */
  playing?: boolean
  /** freeze on this timeline second (for side-by-side checks against a reference) */
  time?: number
  className?: string
}

export function AsciiField({ config, playing = true, time, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const playingRef = useRef(playing)
  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false })
    if (!gl) return
    const cfg = config
    const center: Pose = { x: cfg.aspect / 2, y: 0.5 }
    const layers: Placed[] = cfg.layers.slice(0, MAX_LAYERS).map((l) => {
      const from = l.from ?? l.to ?? center
      return { ...l, from, to: l.to ?? from }
    })
    const ix = cfg.interact ?? {}
    const lift = ix.lift ?? 0
    const near = ix.near ?? 0.12
    const far = ix.far ?? 0.6
    const stiffness = ix.stiffness ?? 2.2
    const rushR = ix.rushRadius ?? 0.22
    const rushK = ix.rush ?? 0
    const scrambleR = ix.scramble ?? 0
    const { loop, approach, pingPong = true } = cfg.timeline ?? { loop: 10, approach: 0 }

    let raf = 0
    let disposed = false
    let cleanup = () => {}
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let videos: HTMLVideoElement[] = []
    Promise.all(layers.map(loadSource)).then(async (srcs) => {
      videos = srcs.flatMap((s) => (s.video ? [s.video] : []))
      // pinned time: show that second of the footage (wraps at its duration); reduced motion: hold the first frame
      if (time !== undefined) await Promise.all(videos.map((v) => seek(v, time)))
      if (disposed) return
      const prog = gl.createProgram()!
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vert))
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag))
      gl.linkProgram(prog)
      gl.useProgram(prog)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'a_pos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      const u = (n: string) => gl.getUniformLocation(prog, n)

      // textures: unit 0 is the glyph atlas, layers on 1..4
      const sizes: Vec2[] = layers.map((l, i) => {
        const ar = srcs[i].w / srcs[i].h
        const w = l.width ?? Math.max(cfg.aspect, ar) // default: cover the frame
        return [w, w / ar]
      })
      const texs = srcs.map((s, i) => upload(gl, s.el, i + 1))
      for (let i = 0; i < MAX_LAYERS; i++) gl.uniform1i(u(`u_tex${i}`), Math.min(i, srcs.length - 1) + 1)
      // video layers re-upload only when a new frame was presented (every rAF where unsupported)
      const fresh = srcs.map(() => true)
      const vfc: number[] = []
      srcs.forEach((s, i) => {
        const v = s.video as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null
        if (!v?.requestVideoFrameCallback) return
        const tick = () => {
          fresh[i] = true
          if (!disposed) vfc[i] = v.requestVideoFrameCallback!(tick)
        }
        vfc[i] = v.requestVideoFrameCallback(tick)
      })
      const hasVfc = (i: number) => vfc[i] !== undefined
      gl.uniform1i(u('u_atlas'), 0)
      gl.uniform1i(u('u_count'), layers.length)
      gl.uniform1f(u('u_glyphs'), cfg.ramp.length)
      gl.uniform1f(u('u_aspect'), cfg.aspect)
      gl.uniform1f(u('u_gamma'), cfg.gamma ?? 1.9)
      gl.uniform2fv(u('u_size'), sizes.flat().concat(Array((MAX_LAYERS - sizes.length) * 2).fill(1)))
      const tintV: number[] = []
      const mulV: number[] = []
      for (let i = 0; i < MAX_LAYERS; i++) {
        const t = layers[i]?.tint ?? { mode: 'source' }
        if (t.mode === 'grey') {
          tintV.push(0, t.keep ?? 0.18, 0, 0)
          mulV.push(...(t.mul ?? [1, 1, 1]))
        } else if (t.mode === 'color') {
          tintV.push(1, 0, 0, 0)
          mulV.push(...t.rgb)
        } else {
          tintV.push(2, 0, 0, 0)
          mulV.push(1, 1, 1)
        }
      }
      gl.uniform4fv(u('u_tint'), tintV)
      gl.uniform3fv(u('u_mul'), mulV)
      const keyV: number[] = []
      const keyRgb: number[] = []
      for (let i = 0; i < MAX_LAYERS; i++) {
        const k = layers[i]?.key
        if (k?.mode === 'luma') keyV.push(1, k.low ?? 0.04, k.high ?? 0.18, 0)
        else if (k?.mode === 'chroma') keyV.push(2, k.tol ?? 0.25, k.soft ?? 0.15, 0)
        else keyV.push(0, 0, 0, 0)
        keyRgb.push(...(k?.mode === 'chroma' ? k.rgb : [0, 0, 0]))
      }
      gl.uniform4fv(u('u_key'), keyV)
      gl.uniform3fv(u('u_keyRgb'), keyRgb)
      const f = cfg.focus
      gl.uniform4f(u('u_focus'), f?.near ?? 0, f?.far ?? 1, f?.min ?? 1, f ? f.max : 0)
      const g = cfg.glow
      gl.uniform4f(u('u_glow'), g?.start ?? 0, g?.end ?? 1, g?.radius ?? 0.075, g ? (g.strength ?? 1.4) : 0)
      gl.uniform3fv(u('u_core'), g?.core ?? [1, 0.86, 0.22])
      gl.uniform3fv(u('u_halo'), g?.halo ?? [0.95, 0.3, 0.08])
      gl.uniform1f(u('u_scrambleR'), scrambleR)
      const uXf = u('u_xf'), uTime = u('u_time'), uWall = u('u_wall'), uK = u('u_k')
      const uGlowAt = u('u_glowAt'), uFocusAt = u('u_focusAt'), uPointer = u('u_pointer'), uScramble = u('u_scramble')

      // 'anchors' resolves to the midpoint of the first two layers' anchors at rest (end pose)
      const restAnchors = (): Vec2 => {
        const pts = layers.slice(0, 2).map((l, i) => pointOf(poseAt(l, 1), sizes[i], l.anchor ?? [0.5, 0.5]))
        return pts.length === 2 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : pts[0] ?? [cfg.aspect / 2, 0.5]
      }
      const resolve = (v: Vec2 | 'anchors' | undefined): Vec2 => (v === 'anchors' || v === undefined ? restAnchors() : v)
      const rushAt = resolve(ix.rushAt)

      let pointer: Vec2 | null = null
      const interactive = time === undefined && !reduced
      const onMove = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect()
        const x = e.clientX - r.left
        const y = e.clientY - r.top
        if (x < 0 || y < 0 || x > r.width || y > r.height) {
          pointer = null
          return
        }
        const unitPx = Math.max(r.width / cfg.aspect, r.height)
        pointer = [(x - r.width / 2) / unitPx + cfg.aspect / 2, (y - r.height / 2) / unitPx + 0.5]
      }
      const onLeave = () => {
        pointer = null
      }
      if (interactive) {
        window.addEventListener('pointermove', onMove, { passive: true })
        document.documentElement.addEventListener('pointerleave', onLeave)
        window.addEventListener('blur', onLeave)
      }

      let atlasCell = 0
      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        gl.viewport(0, 0, w, h)
        // cells scale with the covered frame so grid density matches the reference at any size
        const cell = Math.max(w / cfg.aspect, h) * cfg.cell
        gl.uniform2f(u('u_res'), w, h)
        gl.uniform1f(u('u_cell'), cell)
        if (Math.round(cell) !== atlasCell) {
          atlasCell = Math.round(cell)
          gl.activeTexture(gl.TEXTURE0)
          upload(gl, buildAtlas(cfg.ramp, cell), 0)
        }
      }
      resize()
      const ro = new ResizeObserver(resize)
      ro.observe(canvas)

      const lifts = layers.map(() => 0)
      let scramble = 0
      let lastPointer: Vec2 | null = null
      let clock = 0
      let last = performance.now()
      let drawn = false

      const frame = (now: number) => {
        const dt = Math.min(0.1, (now - last) / 1000)
        last = now
        const live = interactive && playingRef.current
        for (const v of videos) {
          if (live && v.paused) v.play().catch(() => {})
          else if (!live && !v.paused) v.pause()
        }
        if (interactive && !live && drawn) {
          raf = requestAnimationFrame(frame)
          return
        }
        drawn = true
        srcs.forEach((s, i) => {
          if (!s.video || s.video.readyState < 2 || (hasVfc(i) && !fresh[i])) return
          fresh[i] = false
          gl.activeTexture(gl.TEXTURE0 + i + 1)
          gl.bindTexture(gl.TEXTURE_2D, texs[i])
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.video)
        })

        const span = pingPong ? 2 * loop : loop
        const t0 = time ?? (reduced ? loop - 0.5 : pingPong && clock >= loop ? 2 * loop - clock : clock)
        const k = smooth(0, approach, t0)

        const rush = live && pointer && rushK > 0 ? smooth(rushR, rushR * 0.25, dist(pointer, rushAt)) : 0
        const speed = clock < loop ? 1 + rushK * rush : 1 - rush
        if (live) clock = (clock + dt * speed) % span

        const xfs: number[] = []
        const anchorsNow: Vec2[] = []
        layers.forEach((l, i) => {
          const base = poseAt(l, k)
          let target = 0
          if (lift > 0 && live && pointer && l.anchor) {
            const tip = pointOf(base, sizes[i], l.anchor)
            const pull = smooth(far, near, dist(pointer, tip))
            target = Math.max(-lift, Math.min(lift, pointer[1] - tip[1])) * pull
          }
          lifts[i] = lerp(lifts[i], target, 1 - Math.exp(-dt * stiffness))
          const xf: Xf = [base[0], base[1] + lifts[i], base[2]]
          xfs.push(...xf)
          anchorsNow.push(pointOf(xf, sizes[i], l.anchor ?? [0.5, 0.5]))
        })
        while (xfs.length < MAX_LAYERS * 3) xfs.push(-99, -99, 0)
        gl.uniform3fv(uXf, xfs)

        const mid: Vec2 =
          anchorsNow.length >= 2 ? [(anchorsNow[0][0] + anchorsNow[1][0]) / 2, (anchorsNow[0][1] + anchorsNow[1][1]) / 2] : (anchorsNow[0] ?? [0, 0])
        gl.uniform2fv(uGlowAt, g?.at === 'anchors' || !g ? mid : g.at)
        gl.uniform2fv(uFocusAt, f?.at === 'anchors' || !f ? mid : f.at)

        let target = 0
        if (scrambleR > 0 && live && pointer && lastPointer && dt > 0) target = Math.min(1, dist(pointer, lastPointer) / dt / 0.5)
        lastPointer = live && pointer ? [pointer[0], pointer[1]] : null
        scramble = lerp(scramble, target, 1 - Math.exp(-dt * (target > scramble ? 14 : 2.2)))
        gl.uniform2fv(uPointer, pointer ?? [-10, -10])
        gl.uniform1f(uScramble, interactive ? scramble : 0)

        gl.uniform1f(uK, k)
        gl.uniform1f(uTime, t0)
        gl.uniform1f(uWall, now / 1000)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (interactive) raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)

      cleanup = () => {
        srcs.forEach((s, i) => {
          const v = s.video as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | null
          if (v && vfc[i] !== undefined) v.cancelVideoFrameCallback?.(vfc[i])
        })
        ro.disconnect()
        window.removeEventListener('pointermove', onMove)
        document.documentElement.removeEventListener('pointerleave', onLeave)
        window.removeEventListener('blur', onLeave)
      }
    })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      cleanup()
      for (const v of videos) {
        v.pause()
        v.removeAttribute('src')
        v.load()
      }
    }
  }, [config, time])

  return <canvas ref={ref} className={className} style={{ display: 'block', width: '100%', height: '100%' }} aria-hidden="true" />
}

/*
 * Example: two reaching arms (the config the template was generalized from).
 * Sizes and poses are in design units: x 0..aspect, y 0..1 top-down.
 *
 * const ARMS: AsciiConfig = {
 *   aspect: 3696 / 2304,
 *   cell: 21 / 2304,
 *   ramp: [' ', '.', ':', '-', '+', '*', '%', '#', '@', 'TILE'],
 *   layers: [
 *     { src: '/art/arm-left.webp', width: 1.15, from: { x: 0.052, y: 0.634, rot: -0.18 }, to: { x: 0.212, y: 0.544, rot: -0.18 },
 *       tint: { mode: 'grey', keep: 0.18, mul: [0.96, 0.95, 0.97] }, anchor: [0.978, 0.45] },
 *     { src: '/art/arm-right.webp', width: 1.4, from: { x: 1.505, y: 0.172, rot: -0.2 }, to: { x: 1.375, y: 0.207, rot: -0.2 },
 *       tint: { mode: 'color', rgb: [1.4, 0.6, 0.32] }, anchor: [0.07, 0.62] },
 *   ],
 *   glow: { at: 'anchors', start: 5.0, end: 6.6, radius: 0.075, strength: 1.4 },
 *   focus: { at: 'anchors', near: 0.12, far: 1.1, min: 0.55, max: 1.25 },
 *   timeline: { loop: 9.55, approach: 6.8, pingPong: true },
 *   gamma: 1.9,
 *   interact: { lift: 0.03, near: 0.12, far: 0.6, stiffness: 2.2, rushAt: 'anchors', rushRadius: 0.22, rush: 2, scramble: 0.16 },
 * }
 * // keep the config object stable (module scope or useMemo) or the effect rebuilds every render
 * <AsciiField config={ARMS} playing={inView && !document.hidden} />
 *
 * Example: your own footage as the whole frame (no poses, no timeline: the video is the motion).
 *
 * const CLIP: AsciiConfig = {
 *   aspect: 16 / 9,
 *   cell: 1 / 90,
 *   ramp: [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'],
 *   layers: [{ src: '/art/clip.mp4', tint: { mode: 'source' } }],
 *   gamma: 1.4,
 *   interact: { scramble: 0.14 },
 * }
 *
 * Example: a subject shot on black, keyed out and drifting in like a cutout.
 *
 *   layers: [{ src: '/art/dancer.webm', width: 0.9, from: { x: 0.6, y: 0.55 }, to: { x: 0.8, y: 0.5 },
 *     key: { mode: 'luma', low: 0.05, high: 0.2 }, tint: { mode: 'grey', keep: 0.3 } }],
 *   timeline: { loop: 8, approach: 5, pingPong: true },
 */
