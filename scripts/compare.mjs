#!/usr/bin/env node
/*
 * Render your AsciiField at fixed timeline seconds next to the reference
 * video's frame at the same second, plus zoomed glyph crops and a hero
 * screenshot with console errors.
 *
 * usage:
 *   node compare.mjs --url "http://localhost:5173/?ascii" --ref ref.mp4 --out cmp \
 *     [--times 1,4,7,9] [--w 1848 --h 1152] [--crop 700,380,380,240] [--hero http://localhost:5173/]
 *
 * --url    page that renders ONLY the field, full-bleed on black, and freezes on
 *          `&t=<seconds>` (pass the `time` prop from the query string)
 * --w/--h  the reference's frame size at 1x (recordings are often 2x: halve them)
 * --crop   x,y,w,h region to zoom 2x nearest-neighbor on both sides for glyph checks
 *
 * Needs playwright (npm i -D playwright, npx playwright install chromium) and ffmpeg.
 * Headless WebGL needs the swiftshader flags below or the canvas renders black.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
)
const url = args.url
const ref = args.ref
const out = args.out ?? 'cmp'
const times = (args.times ?? '1,4,7,9').split(',').map(Number)
const W = +(args.w ?? 1848)
const H = +(args.h ?? 1152)
if (!url) {
  console.error('need --url (and --ref for side-by-side)')
  process.exit(1)
}
if (ref && !fs.existsSync(ref)) {
  console.error(`reference not found: ${ref}`)
  process.exit(1)
}
fs.mkdirSync(out, { recursive: true })

// resolve playwright from the project being checked (cwd), then from this script's folder
let chromium
try {
  const { createRequire } = await import('node:module')
  const fromCwd = createRequire(path.join(process.cwd(), 'noop.js'))
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(fromCwd.resolve('playwright')).href).catch(() => import('playwright'))
  chromium = mod.chromium ?? mod.default?.chromium
  if (!chromium) throw new Error('no chromium export')
} catch {
  console.error('playwright not found: npm i -D playwright && npx playwright install chromium')
  process.exit(1)
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const sh = (cmd) => execSync(cmd, { stdio: 'pipe' })
const pairs = []
for (const t of times) {
  const sep = url.includes('?') ? '&' : '?'
  await page.goto(`${url}${sep}t=${t}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const mine = path.join(out, `mine-${t}.png`)
  await page.screenshot({ path: mine })
  if (!ref) continue
  const orig = path.join(out, `ref-${t}.png`)
  sh(`ffmpeg -v error -y -ss ${t} -i "${ref}" -frames:v 1 -vf scale=${W}:${H} "${orig}"`)
  const pair = path.join(out, `pair-${t}.jpg`)
  sh(`ffmpeg -v error -y -i "${orig}" -i "${mine}" -filter_complex "[0][1]hstack=2,scale=1800:-1" "${pair}"`)
  pairs.push(pair)
  if (args.crop) {
    const [x, y, w, h] = args.crop.split(',').map(Number)
    const z = path.join(out, `zoom-${t}.png`)
    sh(
      `ffmpeg -v error -y -i "${orig}" -i "${mine}" -filter_complex "[0]crop=${w}:${h}:${x}:${y},scale=${w * 2}:-1:flags=neighbor[a];[1]crop=${w}:${h}:${x}:${y},scale=${w * 2}:-1:flags=neighbor[b];[a][b]vstack" "${z}"`,
    )
  }
}
if (pairs.length > 1) {
  const inputs = pairs.map((p) => `-i "${p}"`).join(' ')
  sh(`ffmpeg -v error -y ${inputs} -filter_complex "vstack=${pairs.length},scale=1200:-1" "${path.join(out, 'grid.jpg')}"`)
}

if (args.hero) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } })
    p.on('pageerror', (e) => errors.push(e.message))
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    await p.goto(args.hero, { waitUntil: 'networkidle' })
    await p.waitForTimeout(7500)
    await p.screenshot({ path: path.join(out, `hero-${w}.png`) })
    await p.close()
  }
}

await browser.close()
console.log(`wrote ${out}/ (${pairs.length ? 'pair-*.jpg left=reference right=yours' : 'mine-*.png'})`)
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
if (errors.length) process.exitCode = 1
