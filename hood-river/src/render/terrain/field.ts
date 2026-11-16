/**
 * The shape of the land as the renderer sees it.
 *
 * The level data (src/sim/level.ts) is a 30 m / 60 m grid of land heights and water depths.
 * Drawn as it is, the shoreline would be a 30 m staircase and every slope a row of facets, so
 * this module builds a smooth version of the same place:
 *
 *   shore(x, z)   > 0 on land, < 0 in water: the depth map, clamped and blurred, so its zero
 *                 line is the level's shoreline with the staircase taken out. The physics
 *                 puts a floating board aground where the water is under 0.35 m; the line
 *                 drawn here is the 0.45 m contour, so what looks like land is land.
 *   elev(x, z)    height of the ground above the river: the bicubic land height, a bank that
 *                 stands up from the waterline (so the water meets it cleanly), strata and
 *                 crags where the slope is steep, and beyond the level data the far terrain
 *                 from farData.ts.
 *
 * Ground coordinates throughout: +x downwind, +z toward Oregon, y up from the river.
 */
import { LEVEL } from '../../sim/level'
import { FAR_AZ_STEP, FAR_HEIGHTS, FAR_RANGES } from './farData'
import { clamp, fbm, ridged, smoothstep } from './noise'

/** extent of the level data */
export const RECT = { x0: -4320, x1: 6480, z0: -3720, z1: 3300 } as const

/** true bearing of +x (degrees) */
export const HEADING_DEG = 74.15309804590444

/**
 * The elevation behind the level data covers a latitude/longitude rectangle, which sits at
 * an angle in the level frame; the corners of RECT outside it hold stretched edge values.
 * East and north offsets from the level origin (m) of that rectangle:
 */
const SRC = { e0: -4367, e1: 6843, n0: -3378, n1: 3705 } as const
const SIN_H = Math.sin((HEADING_DEG * Math.PI) / 180)
const COS_H = Math.cos((HEADING_DEG * Math.PI) / 180)

/**
 * How the land's waterline comes out of the level's depth map. The shore indicator is
 * clamp((SHORE_DEPTH - depth) / SHORE_DEPTH, -1, 1) on a grid of SHORE_GRID_STEP metres,
 * blurred SHORE_BLUR_PASSES times with a 1-4-6-4-1 kernel; land is drawn where it is above
 * zero, and the bed shelves from the waterline to BED_DEPTH metres where it reaches
 * -BED_REACH. Anything that must sit on the drawn waterline (the water's foam line) has to
 * use these same numbers.
 */
export const SHORE_DEPTH = 0.45
export const SHORE_GRID_STEP = 15
export const SHORE_BLUR_PASSES = 2
export const BED_DEPTH = 3
export const BED_REACH = 0.55

const NO_CUT = 1e5

/** half width of the band, centred on the edge of the level data, where the far terrain takes over (m) */
const FAR_BLEND = 380

/** Mt Hood: 39.87 km at 195.92 degrees true, 3405 m above the river */
const HOOD_R = 39870
const HOOD_TH = ((195.92 - HEADING_DEG) * Math.PI) / 180
export const HOOD = { x: HOOD_R * Math.cos(HOOD_TH), z: HOOD_R * Math.sin(HOOD_TH), h: 3405 } as const

/**
 * Mitchell Point: the basalt dome on the Oregon shore that stands in front of the notch from
 * the Hatchery, 5.18 km at 251.4 degrees true, 322 m above the river, sheer on its river side.
 */
const MITCHELL_R = 5180
const MITCHELL_TH = ((251.4 - HEADING_DEG) * Math.PI) / 180
export const MITCHELL = { x: MITCHELL_R * Math.cos(MITCHELL_TH), z: MITCHELL_R * Math.sin(MITCHELL_TH), h: 322 } as const

interface Grid2 {
  x0: number
  z0: number
  step: number
  nx: number
  nz: number
  data: Float32Array
}

function makeGrid(step: number): Grid2 {
  const nx = Math.round((RECT.x1 - RECT.x0) / step) + 1
  const nz = Math.round((RECT.z1 - RECT.z0) / step) + 1
  return { x0: RECT.x0, z0: RECT.z0, step, nx, nz, data: new Float32Array(nx * nz) }
}

function sampleGrid(g: Grid2, x: number, z: number): number {
  let fx = (x - g.x0) / g.step
  let fz = (z - g.z0) / g.step
  fx = fx < 0 ? 0 : fx > g.nx - 1 ? g.nx - 1 : fx
  fz = fz < 0 ? 0 : fz > g.nz - 1 ? g.nz - 1 : fz
  const ix = Math.min(g.nx - 2, fx | 0)
  const iz = Math.min(g.nz - 2, fz | 0)
  const tx = fx - ix, tz = fz - iz
  const i = iz * g.nx + ix
  const d = g.data
  const a = d[i], b = d[i + 1], c = d[i + g.nx], e = d[i + g.nx + 1]
  return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz
}

/** separable 1-4-6-4-1 blur, `passes` times (each pass has a standard deviation of one cell) */
function blur(g: Grid2, passes: number): void {
  const { nx, nz, data } = g
  const tmp = new Float32Array(data.length)
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < nz; j++) {
      const row = j * nx
      for (let i = 0; i < nx; i++) {
        const a = data[row + Math.max(0, i - 2)], b = data[row + Math.max(0, i - 1)]
        const c = data[row + i]
        const d = data[row + Math.min(nx - 1, i + 1)], e = data[row + Math.min(nx - 1, i + 2)]
        tmp[row + i] = (a + e + 4 * (b + d) + 6 * c) * 0.0625
      }
    }
    for (let j = 0; j < nz; j++) {
      const j0 = Math.max(0, j - 2) * nx, j1 = Math.max(0, j - 1) * nx
      const j2 = j * nx
      const j3 = Math.min(nz - 1, j + 1) * nx, j4 = Math.min(nz - 1, j + 2) * nx
      for (let i = 0; i < nx; i++) {
        data[j2 + i] = (tmp[j0 + i] + tmp[j4 + i] + 4 * (tmp[j1 + i] + tmp[j3 + i]) + 6 * tmp[j2 + i]) * 0.0625
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// bicubic land height from the level grids
// ---------------------------------------------------------------------------------------

interface RawGrid { x0: number; z0: number; step: number; nx: number; nz: number }

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  // Catmull-Rom
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
}

function bicubic(a: ArrayLike<number>, g: RawGrid, x: number, z: number): number {
  let fx = (x - g.x0) / g.step
  let fz = (z - g.z0) / g.step
  fx = fx < 0 ? 0 : fx > g.nx - 1 ? g.nx - 1 : fx
  fz = fz < 0 ? 0 : fz > g.nz - 1 ? g.nz - 1 : fz
  const ix = Math.min(g.nx - 2, fx | 0)
  const iz = Math.min(g.nz - 2, fz | 0)
  const tx = fx - ix, tz = fz - iz
  const x0 = Math.max(0, ix - 1), x1 = ix, x2 = ix + 1, x3 = Math.min(g.nx - 1, ix + 2)
  let r0 = 0, r1 = 0, r2 = 0, r3 = 0
  for (let k = 0; k < 4; k++) {
    const jz = Math.min(g.nz - 1, Math.max(0, iz - 1 + k)) * g.nx
    const v = cubic(a[jz + x0], a[jz + x1], a[jz + x2], a[jz + x3], tx)
    if (k === 0) r0 = v
    else if (k === 1) r1 = v
    else if (k === 2) r2 = v
    else r3 = v
  }
  return cubic(r0, r1, r2, r3, tz)
}

function fineWeight(x: number, z: number): number {
  const f = LEVEL.fine
  const m = 240
  const dx = Math.min(x - f.x0, f.x0 + (f.nx - 1) * f.step - x)
  const dz = Math.min(z - f.z0, f.z0 + (f.nz - 1) * f.step - z)
  const d = Math.min(dx, dz)
  return d <= 0 ? 0 : d >= m ? 1 : d / m
}

/**
 * The 30 m grid carries single-cell spikes on the flat ground (road and rail embankments
 * caught by one sample, buildings): blur it where the land is gentle, leave the cliffs.
 */
function smoothGentle(a: ArrayLike<number>, g: RawGrid): Float32Array {
  const { nx, nz } = g
  const out = new Float32Array(nx * nz)
  for (let j = 0; j < nz; j++) {
    const j0 = Math.max(0, j - 1) * nx, j1 = j * nx, j2 = Math.min(nz - 1, j + 1) * nx
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i2 = Math.min(nx - 1, i + 1)
      const c = a[j1 + i]
      const sum = a[j0 + i0] + a[j0 + i2] + a[j2 + i0] + a[j2 + i2] + 2 * (a[j0 + i] + a[j2 + i] + a[j1 + i0] + a[j1 + i2]) + 4 * c
      const gx = (a[j1 + i2] - a[j1 + i0]) * 0.02 / (2 * g.step)
      const gz = (a[j2 + i] - a[j0 + i]) * 0.02 / (2 * g.step)
      const w = 1 - smoothstep(0.2, 0.55, Math.hypot(gx, gz))
      out[j1 + i] = c + (sum / 16 - c) * w
    }
  }
  return out
}

let fineSmooth: Float32Array | null = null

/** smooth land height above the river (m), 0 over water; inside the level data only */
export function landSmooth(x: number, z: number): number {
  if (!fineSmooth) fineSmooth = smoothGentle(LEVEL.fineHeight, LEVEL.fine)
  const w = fineWeight(x, z)
  const c = w < 1 ? bicubic(LEVEL.coarseHeight, LEVEL.coarse, x, z) : 0
  const f = w > 0 ? bicubic(fineSmooth, LEVEL.fine, x, z) : 0
  const h = (c * (1 - w) + f * w) * 0.02
  return h > 0 ? h : 0
}

// ---------------------------------------------------------------------------------------
// far terrain
// ---------------------------------------------------------------------------------------

const FAR_NAZ = Math.round(360 / FAR_AZ_STEP)
const FAR_NR = FAR_RANGES.length

function farTable(ia: number, ir: number): number {
  const a = ((ia % FAR_NAZ) + FAR_NAZ) % FAR_NAZ
  const r = ir < 0 ? 0 : ir > FAR_NR - 1 ? FAR_NR - 1 : ir
  return FAR_HEIGHTS[a * FAR_NR + r]
}

/** smooth height of the far terrain, without detail: negative where it is river */
function farBase(x: number, z: number): number {
  const r = Math.hypot(x, z)
  let az = HEADING_DEG + (Math.atan2(z, x) * 180) / Math.PI
  az = ((az % 360) + 360) % 360
  const fa = az / FAR_AZ_STEP
  const ia = Math.floor(fa)
  const ta = fa - ia
  // range index: piecewise linear in the table's own spacing
  let ir = 0
  while (ir < FAR_NR - 2 && r >= FAR_RANGES[ir + 1]) ir++
  const tr = clamp((r - FAR_RANGES[ir]) / (FAR_RANGES[ir + 1] - FAR_RANGES[ir]), 0, 1)
  let r0 = 0, r1 = 0, r2 = 0, r3 = 0
  for (let k = 0; k < 4; k++) {
    const a = ia - 1 + k
    const v = cubic(farTable(a, ir - 1), farTable(a, ir), farTable(a, ir + 1), farTable(a, ir + 2), tr)
    if (k === 0) r0 = v
    else if (k === 1) r1 = v
    else if (k === 2) r2 = v
    else r3 = v
  }
  let h = cubic(r0, r1, r2, r3, ta)
  // the bicubic rings next to the river: never let a spurious hill stand in open water
  const lo = Math.min(farTable(ia, ir), farTable(ia + 1, ir), farTable(ia, ir + 1), farTable(ia + 1, ir + 1))
  const hi = Math.max(farTable(ia, ir), farTable(ia + 1, ir), farTable(ia, ir + 1), farTable(ia + 1, ir + 1))
  h = clamp(h, lo - 0.15 * (hi - lo), hi + 0.15 * (hi - lo))
  return h
}

/** Mt Hood's cone (m above the river) at a distance d from its summit */
function hoodCone(d: number): number {
  const u = d / 2000
  return 1400 * smoothstep(15000, 5000, d) + 2005 * (0.6 * (1 + u) * Math.exp(-u) + 0.4 * Math.exp(-1.6 * u))
}

/**
 * The Columbia beyond the level data, as (true azimuth in degrees, range in m) from the level
 * origin: west toward Wind Mountain and east past Mosier. The polar table is too coarse to
 * keep a 1 km river open, so its course is cut in by hand along the table's zeros.
 */
const FAR_RIVER_POLAR: readonly (readonly [number, number])[][] = [
  [[258.8, 3900], [258.5, 6000], [258, 9000], [259, 12000], [260.5, 16000], [263, 20000], [264, 24500]],
  [[105.8, 5900], [105, 7200], [103.5, 9000], [101.5, 11500], [98, 14000], [95.5, 17000], [94.5, 21000]],
]
const FAR_RIVER: number[][] = FAR_RIVER_POLAR.map((line) => {
  const out: number[] = []
  for (const [az, r] of line) {
    const th = ((az - HEADING_DEG) * Math.PI) / 180
    out.push(r * Math.cos(th), r * Math.sin(th))
  }
  return out
})

/** distance to the far river's centreline (m) */
function farRiverDist(x: number, z: number): number {
  let best = Infinity
  for (const line of FAR_RIVER) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i], az = line[i + 1]
      const dx = line[i + 2] - ax, dz = line[i + 3] - az
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1)
      const d = Math.hypot(x - ax - t * dx, z - az - t * dz)
      if (d < best) best = d
    }
  }
  return best
}

/**
 * Headlands of the gorge west of the level, one behind another on alternate banks: what
 * makes the layered ridges of the notch. The polar table (5 degrees by a kilometre or more)
 * is too coarse to hold them, so they are put back by hand along the far river: distance
 * along it from the edge of the level (m), bank (+1 Oregon, -1 Washington), height above the
 * river (m) and half length along the river (m). Placed by eye from the drone clip and the
 * map (Viento, Shellrock, Starvation ridge; Dog and Wind Mountains), not surveyed.
 */
const HEADLANDS: readonly (readonly [number, number, number, number])[] = [
  [3900, 1, 440, 800], [6300, -1, 520, 1100], [8600, 1, 620, 1000], [11600, -1, 570, 950], [13900, 1, 780, 1400], [17200, -1, 840, 1600],
]

/** position along the western far river (m from its first point) and signed distance from it (+ on the Oregon bank) */
function westRiver(x: number, z: number, out: { s: number; d: number }): void {
  const line = FAR_RIVER[0]
  let best = Infinity, run = 0
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], az = line[i + 1]
    const dx = line[i + 2] - ax, dz = line[i + 3] - az
    const len = Math.hypot(dx, dz)
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (len * len), 0, 1)
    const px = x - ax - t * dx, pz = z - az - t * dz
    const d = Math.hypot(px, pz)
    if (d < best) {
      best = d
      out.s = run + t * len
      // the river runs toward -x here: the Oregon bank (+z) is on its left
      out.d = (dx * pz - dz * px > 0 ? -1 : 1) * d
    }
    run += len
  }
}

const _wr = { s: 0, d: 0 }

/** height of the hand-placed headlands at a point of the far terrain (m), 0 away from them */
function headlands(x: number, z: number): number {
  if (x > -3500) return 0
  westRiver(x, z, _wr)
  const side = _wr.d > 0 ? 1 : -1
  const off = Math.abs(_wr.d)
  if (off > 5200) return 0
  let h = 0
  for (const [s0, bank, height, half] of HEADLANDS) {
    if (bank !== side) continue
    const u = (_wr.s - s0) / half
    if (u < -2.2 || u > 2.2) continue
    // a spur coming down to the water: steep at its nose, falling away up and down the river,
    // its crest climbing back from the bank toward the high ground behind
    const along = Math.exp(-u * u)
    const nose = smoothstep(560, 1350, off) * (0.72 + 0.5 * smoothstep(1200, 4200, off)) * (1 - 0.5 * smoothstep(4200, 5200, off))
    h = Math.max(h, height * along * nose)
  }
  return h
}

/** Mitchell Point's dome (m above the river) */
function mitchellPoint(x: number, z: number): number {
  const dx = x - MITCHELL.x, dz = z - MITCHELL.z
  // sheer toward the river (-z), running back into the hillside behind
  const r = Math.hypot(dx / 340, dz / (dz < 0 ? 210 : 520))
  return r >= 1 ? 0 : MITCHELL.h * Math.pow(1 - r * r, 0.55)
}

/** far terrain height with ridges and drainage; below zero where the far river runs */
export function farHeight(x: number, z: number): number {
  let h = farBase(x, z)
  const dr = farRiverDist(x, z)
  if (dr < 560) return -4
  if (h < 4) {
    // the table reads as river here: only the hand-placed headlands stand in it
    const hand = Math.max(headlands(x, z), mitchellPoint(x, z))
    h = hand > 4 ? hand : -4
  } else {
    // ridges: relief in proportion to the height of the hills, valleys left where they are
    const rel = smoothstep(15, 300, h)
    const rg = ridged(x / 1900 + 3.1, z / 1900 - 1.7, 4, 11)
    const bm = fbm(x / 7000 - 2.2, z / 7000 + 0.6, 2, 23)
    h = Math.max(4, h * (1 + rel * (0.5 * (rg - 0.4) + 0.2 * (bm - 0.5))))
    // banks rise from the far river
    if (dr < 1500) h = 4 + (h - 4) * smoothstep(560, 1500, dr)
    h = Math.max(h, headlands(x, z), mitchellPoint(x, z))
  }
  const dh = Math.hypot(x - HOOD.x, z - HOOD.z)
  if (dh < 16000) {
    const crag = 1 + 0.06 * (ridged(x / 1500, z / 1500, 3, 77) - 0.5) * smoothstep(200, 2500, dh)
    h = Math.max(h, hoodCone(dh) * crag)
  }
  return h
}

// ---------------------------------------------------------------------------------------
// the field
// ---------------------------------------------------------------------------------------

export class TerrainField {
  /** shore indicator, 15 m grid: +1 land, -1 water more than 0.9 m deep, blurred */
  readonly shoreGrid: Grid2
  /** how deep the water is close by (0 = shelving sand, 1 = 3 m or more), blurred */
  readonly deepGrid: Grid2
  /** tangent of the slope of the level data, 30 m grid, lightly blurred */
  readonly slopeGrid: Grid2
  /** ceiling on the ground height where a road or railway bench is cut into it (10 m grid), or null */
  private cutGrid: Grid2 | null = null

  constructor() {
    const sg = makeGrid(SHORE_GRID_STEP)
    const dg = makeGrid(SHORE_GRID_STEP)
    for (let j = 0; j < sg.nz; j++) {
      const z = sg.z0 + j * sg.step
      for (let i = 0; i < sg.nx; i++) {
        const d = LEVEL.waterDepth(sg.x0 + i * sg.step, z)
        sg.data[j * sg.nx + i] = clamp((SHORE_DEPTH - d) / SHORE_DEPTH, -1, 1)
        dg.data[j * sg.nx + i] = Math.min(d, 3) / 3
      }
    }
    blur(sg, SHORE_BLUR_PASSES)
    blur(dg, 4)
    this.shoreGrid = sg
    this.deepGrid = dg

    const sl = makeGrid(30)
    for (let j = 0; j < sl.nz; j++) {
      const z = sl.z0 + j * sl.step
      for (let i = 0; i < sl.nx; i++) {
        const x = sl.x0 + i * sl.step
        const gx = (LEVEL.landHeight(x + 30, z) - LEVEL.landHeight(x - 30, z)) / 60
        const gz = (LEVEL.landHeight(x, z + 30) - LEVEL.landHeight(x, z - 30)) / 60
        sl.data[j * sl.nx + i] = Math.hypot(gx, gz)
      }
    }
    blur(sl, 1)
    this.slopeGrid = sl
  }

  /**
   * Cut a bench: the ground at (x, z) may not stand higher than y. Call for points a few
   * metres apart over the whole footprint, then finishCuts() once.
   */
  addCut(x: number, z: number, y: number): void {
    if (!this.cutGrid) {
      this.cutGrid = makeGrid(10)
      this.cutGrid.data.fill(NO_CUT)
    }
    const g = this.cutGrid
    const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step
    const i0 = Math.floor(fx), j0 = Math.floor(fz)
    for (let j = j0; j <= j0 + 1; j++) {
      for (let i = i0; i <= i0 + 1; i++) {
        if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue
        const k = j * g.nx + i
        if (y < g.data[k]) g.data[k] = y
      }
    }
  }

  /** let the cut banks rise away from the benches at `slope` (tangent) */
  finishCuts(slope = 1.2): void {
    const g = this.cutGrid
    if (!g) return
    const { nx, nz, data } = g
    const d1 = g.step * slope, d2 = d1 * Math.SQRT2
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        let v = data[k]
        if (i > 0) v = Math.min(v, data[k - 1] + d1)
        if (j > 0) {
          v = Math.min(v, data[k - nx] + d1)
          if (i > 0) v = Math.min(v, data[k - nx - 1] + d2)
          if (i < nx - 1) v = Math.min(v, data[k - nx + 1] + d2)
        }
        data[k] = v
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i
        let v = data[k]
        if (i < nx - 1) v = Math.min(v, data[k + 1] + d1)
        if (j < nz - 1) {
          v = Math.min(v, data[k + nx] + d1)
          if (i < nx - 1) v = Math.min(v, data[k + nx + 1] + d2)
          if (i > 0) v = Math.min(v, data[k + nx - 1] + d2)
        }
        data[k] = v
      }
    }
  }

  /** ceiling on the ground height at a point (a large number where nothing is cut) */
  cutAt(x: number, z: number): number {
    return this.cutGrid ? sampleGrid(this.cutGrid, x, z) : NO_CUT
  }

  /** 0..1: a road or railway bench stands within about 25 m (its riprap comes down to here) */
  benchNear(x: number, z: number): number {
    return this.cutGrid ? 1 - smoothstep(22, 38, sampleGrid(this.cutGrid, x, z)) : 0
  }

  /** > 0 on land, < 0 in water; about +-1 some 40 m from the shoreline */
  shore(x: number, z: number): number {
    return sampleGrid(this.shoreGrid, x, z)
  }

  /** gradient of shore(), pointing inland (not normalised) */
  shoreGrad(x: number, z: number, out: { x: number; z: number }): void {
    const e = 6
    out.x = sampleGrid(this.shoreGrid, x + e, z) - sampleGrid(this.shoreGrid, x - e, z)
    out.z = sampleGrid(this.shoreGrid, x, z + e) - sampleGrid(this.shoreGrid, x, z - e)
  }

  /** 0 where the water shelves gently off this shore (sand), 1 where it drops off (rock) */
  steepShore(x: number, z: number): number {
    return smoothstep(0.1, 0.36, sampleGrid(this.deepGrid, x, z))
  }

  /** tangent of the slope of the underlying data (30 m scale) */
  slope(x: number, z: number): number {
    return sampleGrid(this.slopeGrid, x, z)
  }

  /**
   * 0..1: the shore of the Hatchery terrace, where the bank is two steps of water-worn basalt
   * (ground x -500 to 1150 on the Washington side, wherever the water drops off and no road
   * or railway bench stands at the waterline)
   */
  ledgeShore(x: number, z: number): number {
    if (z > -300 || x < -560 || x > 1210) return 0
    return smoothstep(-560, -470, x) * smoothstep(1210, 1120, x) * this.steepShore(x, z) * (1 - this.benchNear(x, z))
  }

  /** height of the lip of the first ledge above the river (m): 0.7 to 1.9, stepping along the shore */
  ledgeHeight(x: number, z: number): number {
    const n = fbm(x / 26, z / 26, 2, 61)
    // flat stretches with steps between them, as slabs of one flow break off
    return 0.7 + 1.2 * smoothstep(0.3, 0.7, n) * (0.6 + 0.4 * smoothstep(0.45, 0.55, fbm(x / 9, z / 9, 1, 62)))
  }

  /** height of the bank just inside the waterline (m) */
  bankHeight(x: number, z: number): number {
    return 0.7 + 1.2 * this.steepShore(x, z) + 1.4 * this.ledgeShore(x, z)
  }

  /**
   * Signed distance to the edge of the trustworthy level data (m): negative inside,
   * positive outside.
   */
  outside(x: number, z: number): number {
    const east = x * SIN_H + z * COS_H
    const north = x * COS_H - z * SIN_H
    const dx = Math.max(RECT.x0 - x, x - RECT.x1)
    const dz = Math.max(RECT.z0 - z, z - RECT.z1)
    const de = Math.max(SRC.e0 - east, east - SRC.e1)
    const dn = Math.max(SRC.n0 - north, north - SRC.n1)
    const a = dx > 0 && dz > 0 ? Math.hypot(dx, dz) : Math.max(dx, dz)
    const b = de > 0 && dn > 0 ? Math.hypot(de, dn) : Math.max(de, dn)
    return Math.max(a, b)
  }

  /** the ground before any road or railway bench was cut into it (inside the level data) */
  natural(x: number, z: number): number {
    const g = this.cutGrid
    this.cutGrid = null
    const h = this.elevLevel(x, z)
    this.cutGrid = g
    return h
  }

  /** elevation inside the level data */
  private elevLevel(x: number, z: number): number {
    const c = this.shore(x, z)
    if (c <= 0) return -BED_DEPTH * smoothstep(0, -BED_REACH, c)
    const bank = this.bankHeight(x, z) * smoothstep(0, 0.2, c)
    let h = landSmooth(x, z) * smoothstep(0, 0.5, c)
    if (h > 3) {
      const s = this.slope(x, z)
      // basalt flows are level sheets: where the wall is steep, break it into bands
      const cliff = smoothstep(0.62, 1.05, s)
      if (cliff > 0) {
        const T = 34
        const t = (h + 9 * fbm(x / 420, z / 420, 2, 5)) / T
        const k = Math.floor(t)
        const f = t - k
        const f2 = f * f, g2 = (1 - f) * (1 - f)
        const sharp = f2 / (f2 + g2)
        h += cliff * 0.6 * (sharp - f) * T
        h += cliff * 5 * (ridged(x / 46, z / 46, 3, 31) - 0.45)
      }
      // gentle swell and hollow everywhere else, so nothing is a perfect ramp
      h += smoothstep(3, 30, h) * 1.6 * (fbm(x / 90, z / 90, 3, 41) - 0.5) * (1 + 2 * smoothstep(0.25, 0.6, s))
    }
    if (this.cutGrid) {
      const ceil = sampleGrid(this.cutGrid, x, z)
      if (ceil < h) h = ceil
    }
    // smooth maximum of the bank and the hill
    const d = h - bank
    return 0.5 * (h + bank + Math.sqrt(d * d + 0.16))
  }

  /** height of the ground above the river (m); negative under water (never below -4) */
  elev(x: number, z: number): number {
    const out = this.outside(x, z)
    if (out <= -FAR_BLEND) return this.elevLevel(x, z)
    const far = farHeight(x, z)
    if (out >= FAR_BLEND) return far
    const edge = this.elevLevel(clamp(x, RECT.x0, RECT.x1), clamp(z, RECT.z0, RECT.z1))
    const t = smoothstep(-FAR_BLEND, FAR_BLEND, out)
    return edge + (far - edge) * t
  }

  /** true where a point is open water (inside or outside the level data) */
  isWater(x: number, z: number): boolean {
    return this.elev(x, z) < 0
  }
}
