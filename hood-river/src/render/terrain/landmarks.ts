/**
 * The built things that make the reach read as Hood River: the green truss bridge with its
 * two lift towers, the railway and highway on their riprap bench along the Washington
 * waterline, the railway under the Oregon cliff and I-84 on the bench above it, the
 * hatchery's long red-roofed buildings, vans at the launch, White Salmon's houses on the
 * bluff rim and Hood River climbing its hill. All of it is merged into the terrain's draw
 * calls with baked light.
 */
import { LANDMARKS } from '../../sim/level'
import type { GorgeBuilder } from './build'
import { PAL, hex, type Rgb } from './cover'
import type { MeshBuilder } from './geometry'
import { clamp, fbm, hash2, lerp, smoothstep } from './noise'
import { centreZ, sample } from './survey'

const STEEL = hex(0x6f8f7f)
const STEEL_DARK = hex(0x4f6a5c)
const PIER = hex(0xb8b2a6)
const DECK = hex(0x6c7068)
const ROOF_RED = hex(0x8e4b38)
const ROOF_GREY = hex(0x8d9093)
const ROOF_DARK = hex(0x55575c)
const ROOF_TAN = hex(0xa89a84)
const WALL_CREAM = hex(0xe3dac6)
const WALL_WHITE = hex(0xecebe6)
const WALL_GREY = hex(0xa9aaa6)
const WALL_BLUE = hex(0x8fa3b0)
const WALL_BROWN = hex(0x8b7460)
const VAN_COLS: Rgb[] = [hex(0xf2f2ee), hex(0xf2f2ee), hex(0xc9ccd0), hex(0x7d8288), hex(0x2f3338), hex(0xa33a2e), hex(0x3d5a7a), hex(0xd7c9a8)]
const SAIL_COLS: Rgb[] = [hex(0xf26a2e), hex(0xf2f2ee), hex(0x2fb6c9), hex(0xe9d23a), hex(0xe84c8a), hex(0x57c26b)]

export interface LandmarkOptions {
  /** 0.5 low ... 1 high: sets segment lengths and how many buildings are drawn */
  detail: number
}

/** a line of stations in ground coordinates with the height of the running surface above the river */
export interface TrackLine {
  px: Float64Array
  pz: Float64Array
  deck: Float64Array
}

export interface LandmarkPlan {
  corridors: Corridor[]
  /** lines the terrain network should have vertices along */
  rows: Float64Array[]
  /** centreline of the railway on the Washington waterline (for the train) */
  rail: TrackLine
}

/**
 * Before the terrain is meshed: lay out the road and rail benches, cut them into the
 * ground (gb.field) and say where the mesh needs vertices to hold the cut.
 */
export function planLandmarks(gb: GorgeBuilder, o: LandmarkOptions): LandmarkPlan {
  const corridors = planCorridors(gb, o)
  const rows: Float64Array[] = []
  for (const c of corridors) for (const r of c.rows) rows.push(r)
  gb.field.finishCuts()
  const wa = corridors[0]
  return { corridors, rows, rail: { px: wa.px, pz: wa.pz, deck: wa.deck } }
}

/** After the terrain: add everything built. Returns the triangles added. */
export function addLandmarks(gb: GorgeBuilder, plan: LandmarkPlan, o: LandmarkOptions): number {
  let before = 0
  for (const c of gb.chunks) before += c.triangles
  const w = new Writer(gb)
  addBridge(gb, w, o)
  for (const c of plan.corridors) emitCorridor(gb, w, c, o)
  addHatchery(gb, w, o)
  addTowns(gb, w, o)
  let after = 0
  for (const c of gb.chunks) after += c.triangles
  return after - before
}

// ---------------------------------------------------------------------------------------
// primitive writer: flat-shaded quads and boxes with baked light
// ---------------------------------------------------------------------------------------

class Writer {
  private lit = { sun: 0, sky: 0, bounce: 0 }
  constructor(readonly gb: GorgeBuilder) {}

  /** a flat quad a-b-c-d (counter-clockwise seen from the lit side); `ground` is the terrain height under it */
  quad(
    m: MeshBuilder,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    col: Rgb, ground: number, tone = 1, twoSided = false, grain = 0,
  ): void {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (nx * nx + ny * ny + nz * nz < 1e-9) {
      // b and c coincide (a triangle passed as a quad): take the other corner
      nx = (cy - ay) * (dz - az) - (cz - az) * (dy - ay)
      ny = (cz - az) * (dx - ax) - (cx - ax) * (dz - az)
      nz = (cx - ax) * (dy - ay) - (cy - ay) * (dx - ax)
    }
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    const mx = (ax + bx + cx + dx) / 4, my = (ay + by + cy + dy) / 4, mz = (az + bz + cz + dz) / 4
    const lit = this.lit
    this.gb.light(mx, mz, Math.max(0, my - ground), nx, ny, nz, 1, lit)
    const r = col[0] * tone, g = col[1] * tone, b = col[2] * tone
    const v0 = m.vertex(ax, ay, az, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
    const v1 = m.vertex(bx, by, bz, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
    const v2 = m.vertex(cx, cy, cz, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
    const v3 = m.vertex(dx, dy, dz, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
    m.quad(v0, v1, v2, v3)
    if (twoSided) {
      this.gb.light(mx, mz, Math.max(0, my - ground), -nx, -ny, -nz, 1, lit)
      const u0 = m.vertex(ax, ay, az, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
      const u1 = m.vertex(bx, by, bz, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
      const u2 = m.vertex(cx, cy, cz, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
      const u3 = m.vertex(dx, dy, dz, r, g, b, lit.sun, lit.sky, lit.bounce, 0, 0, grain)
      m.quad(u3, u2, u1, u0)
    }
  }

  /** a flat triangle a-b-c, counter-clockwise seen from the lit side */
  tri(
    m: MeshBuilder,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
    col: Rgb, ground: number,
  ): void {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    const lit = this.lit
    this.gb.light((ax + bx + cx) / 3, (az + bz + cz) / 3, Math.max(0, (ay + by + cy) / 3 - ground), nx, ny, nz, 1, lit)
    const v0 = m.vertex(ax, ay, az, col[0], col[1], col[2], lit.sun, lit.sky, lit.bounce)
    const v1 = m.vertex(bx, by, bz, col[0], col[1], col[2], lit.sun, lit.sky, lit.bounce)
    const v2 = m.vertex(cx, cy, cz, col[0], col[1], col[2], lit.sun, lit.sky, lit.bounce)
    m.tri(v0, v1, v2)
  }

  /**
   * A box with its long axis along (ux, uz): centre (x, z), half length a, half width b,
   * from y0 to y1. Roof: 0 flat, >0 gable of that height along the long axis.
   */
  box(
    m: MeshBuilder, x: number, z: number, ux: number, uz: number, a: number, b: number, y0: number, y1: number,
    wall: Rgb, roof: Rgb, gable = 0, ground = y0, bottom = false,
  ): void {
    const vx = -uz, vz = ux
    const p = (su: number, sv: number): [number, number] => [x + ux * a * su + vx * b * sv, z + uz * a * su + vz * b * sv]
    const [x0, z0] = p(-1, -1), [x1, z1] = p(1, -1), [x2, z2] = p(1, 1), [x3, z3] = p(-1, 1)
    // walls (outward)
    this.quad(m, x0, y0, z0, x0, y1, z0, x1, y1, z1, x1, y0, z1, wall, ground)
    this.quad(m, x1, y0, z1, x1, y1, z1, x2, y1, z2, x2, y0, z2, wall, ground)
    this.quad(m, x2, y0, z2, x2, y1, z2, x3, y1, z3, x3, y0, z3, wall, ground)
    this.quad(m, x3, y0, z3, x3, y1, z3, x0, y1, z0, x0, y0, z0, wall, ground)
    if (gable > 0) {
      const [rx0, rz0] = p(-1, 0), [rx1, rz1] = p(1, 0)
      const yr = y1 + gable
      this.quad(m, x0, y1, z0, rx0, yr, rz0, rx1, yr, rz1, x1, y1, z1, roof, ground)
      this.quad(m, x2, y1, z2, rx1, yr, rz1, rx0, yr, rz0, x3, y1, z3, roof, ground)
      // gable ends
      this.tri(m, x3, y1, z3, rx0, yr, rz0, x0, y1, z0, wall, ground)
      this.tri(m, x1, y1, z1, rx1, yr, rz1, x2, y1, z2, wall, ground)
    } else {
      this.quad(m, x0, y1, z0, x3, y1, z3, x2, y1, z2, x1, y1, z1, roof, ground)
    }
    if (bottom) this.quad(m, x0, y0, z0, x1, y0, z1, x2, y0, z2, x3, y0, z3, wall, ground, 0.7)
  }

  /** a straight member between two points: a flat ribbon of width w standing in the vertical plane through them, seen from both sides */
  member(m: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, col: Rgb, ground: number, tone = 1): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const horiz = Math.hypot(dx, dz)
    const len = Math.hypot(horiz, dy) || 1
    // offset perpendicular to the member within the vertical plane (or sideways for a vertical member)
    let ox: number, oy: number, oz: number
    if (horiz < 1e-3) { ox = w / 2; oy = 0; oz = 0 }
    else {
      ox = (-dx / horiz) * (dy / len) * (w / 2)
      oz = (-dz / horiz) * (dy / len) * (w / 2)
      oy = (horiz / len) * (w / 2)
    }
    this.quad(m, ax - ox, ay - oy, az - oz, bx - ox, by - oy, bz - oz, bx + ox, by + oy, bz + oz, ax + ox, ay + oy, az + oz, col, ground, tone, true)
  }
}

// ---------------------------------------------------------------------------------------
// the Hood River bridge
// ---------------------------------------------------------------------------------------

function addBridge(gb: GorgeBuilder, w: Writer, o: LandmarkOptions): void {
  const S = LANDMARKS.bridgeSouthEnd, N = LANDMARKS.bridgeNorthEnd, L = LANDMARKS.bridgeLiftSpan
  const m = gb.chunks[gb.chunkAt(L.x, L.z + 250)]
  const len = Math.hypot(N.x - S.x, N.z - S.z)
  const ux = (N.x - S.x) / len, uz = (N.z - S.z) / len
  const vx = -uz, vz = ux
  const sLift = (L.x - S.x) * ux + (L.z - S.z) * uz
  const HALF = 40 // lift span is 80 m
  const WIDTH = 3.4 // half width of the deck
  const road = (s: number) => 12.5 + 8.5 * Math.max(0, 1 - ((s / len - sLift / len) / 0.5) ** 2)
  const at = (s: number, side: number): [number, number] => [S.x + ux * s + vx * side, S.z + uz * s + vz * side]
  const DEPTH = 6.5

  // pier stations: tower piers either side of the lift span, the rest spread evenly
  const stations: number[] = [0]
  const nSouth = Math.round((sLift - HALF) / 66)
  for (let i = 1; i < nSouth; i++) stations.push(((sLift - HALF) * i) / nSouth)
  stations.push(sLift - HALF, sLift + HALF)
  const nNorth = Math.round((len - sLift - HALF) / 66)
  for (let i = 1; i < nNorth; i++) stations.push(sLift + HALF + ((len - sLift - HALF) * i) / nNorth)
  stations.push(len)

  for (let k = 0; k + 1 < stations.length; k++) {
    const s0 = stations[k], s1 = stations[k + 1]
    const lift = Math.abs((s0 + s1) / 2 - sLift) < 1
    const y0 = road(s0), y1 = road(s1)
    const [ax, az] = at(s0, -WIDTH), [bx, bz] = at(s1, -WIDTH), [cx, cz] = at(s1, WIDTH), [dx, dz] = at(s0, WIDTH)
    // deck: open steel grating on top, dark from below, a green fascia each side
    w.quad(m, ax, y0, az, dx, y0, dz, cx, y1, cz, bx, y1, bz, DECK, 0)
    w.quad(m, ax, y0 - 1.1, az, bx, y1 - 1.1, bz, cx, y1 - 1.1, cz, dx, y0 - 1.1, dz, STEEL_DARK, 0, 0.7)
    w.quad(m, ax, y0 - 1.1, az, ax, y0 + 1.0, az, bx, y1 + 1.0, bz, bx, y1 - 1.1, bz, STEEL, 0, 1, true)
    w.quad(m, dx, y0 - 1.1, dz, cx, y1 - 1.1, cz, cx, y1 + 1.0, cz, dx, y0 + 1.0, dz, STEEL, 0, 1, true)
    // truss panels
    const panels = o.detail >= 0.7 ? 8 : 4
    for (const side of [-WIDTH, WIDTH]) {
      const top0 = lift ? 12 : -1.1, bot0 = lift ? 0.4 : -DEPTH
      // the lower chord of a deck truss / the upper chord of the through truss
      const [px0, pz0] = at(s0, side), [px1, pz1] = at(s1, side)
      const chord = lift ? top0 : bot0
      w.member(m, px0, y0 + chord, pz0, px1, y1 + chord, pz1, 0.7, STEEL, 0)
      for (let p = 0; p < panels; p++) {
        const t0 = p / panels, t1 = (p + 1) / panels
        const [qx0, qz0] = at(lerp(s0, s1, t0), side), [qx1, qz1] = at(lerp(s0, s1, t1), side)
        const ya = lerp(y0, y1, t0), yb = lerp(y0, y1, t1)
        const up = p % 2 === 0
        // diagonal, and a vertical at each panel point
        w.member(m, qx0, ya + (up ? bot0 : top0), qz0, qx1, yb + (up ? top0 : bot0), qz1, 0.5, STEEL, 0, 0.92)
        if (p > 0 && (o.detail >= 0.7 || lift)) w.member(m, qx0, ya + bot0, qz0, qx0, ya + top0, qz0, 0.4, STEEL, 0, 0.85)
      }
    }
    if (lift) {
      // overhead bracing of the through truss
      for (let p = 0; p <= 4; p++) {
        const s = lerp(s0, s1, p / 4)
        const [qx0, qz0] = at(s, -WIDTH), [qx1, qz1] = at(s, WIDTH)
        w.member(m, qx0, road(s) + 12, qz0, qx1, road(s) + 12, qz1, 0.5, STEEL_DARK, 0)
      }
    }
  }

  // piers: tapered concrete, from under the water to the truss
  for (let k = 1; k + 1 < stations.length; k++) {
    const s = stations[k]
    const tower = Math.abs(Math.abs(s - sLift) - HALF) < 1
    const [px, pz] = at(s, 0)
    const top = road(s) - (tower ? 1.1 : DEPTH)
    w.box(m, px, pz, vx, vz, tower ? 7.5 : 5.2, tower ? 2.6 : 1.5, -3, top, PIER, PIER, 0, 0)
    if (tower) {
      // lift tower: two braced legs to 58 m, a head frame, and the counterweight near the top
      const TOP = 58
      const y0 = road(s)
      for (const side of [-WIDTH - 0.6, WIDTH + 0.6]) {
        const [lx, lz] = at(s, side)
        w.box(m, lx, lz, ux, uz, 1.5, 0.9, y0 - 1.1, TOP, STEEL, STEEL_DARK, 0, 0)
      }
      const [tx0, tz0] = at(s, -WIDTH - 0.6), [tx1, tz1] = at(s, WIDTH + 0.6)
      for (let y = y0 + 9; y < TOP - 4; y += 9) {
        w.member(m, tx0, y, tz0, tx1, y + 9, tz1, 0.5, STEEL, 0, 0.9)
        w.member(m, tx1, y, tz1, tx0, y + 9, tz0, 0.5, STEEL, 0, 0.9)
        w.member(m, tx0, y, tz0, tx1, y, tz1, 0.4, STEEL_DARK, 0)
      }
      const [hx, hz] = at(s, 0)
      w.box(m, hx, hz, vx, vz, WIDTH + 2.4, 2.2, TOP, TOP + 3.2, STEEL, STEEL_DARK, 0, 0, true)
      // counterweight hangs on the landward side of the tower
      const out = s < sLift ? -3.4 : 3.4
      w.box(m, hx + ux * out, hz + uz * out, vx, vz, WIDTH - 0.2, 1.3, TOP - 11, TOP - 3, PIER, PIER, 0, 0, true)
    }
  }
}

// ---------------------------------------------------------------------------------------
// road and rail benches
// ---------------------------------------------------------------------------------------

interface Band {
  /** offsets from the path, + inland, of the band's two edges (m) and their heights relative to the deck (m) */
  o0: number; h0: number; o1: number; h1: number
  col: Rgb
  /** tone noise for rock slopes */
  rough: boolean
  /** false for an embankment skirt: drawn, but the ground is not cut down to pass under it */
  cut?: boolean
}

/** main shoreline z at ground x: the last water before solid land, scanning from mid-river */
function shoreScan(gb: GorgeBuilder, x: number, dir: number): number {
  const F = gb.field
  let z = centreZ(x)
  let run = 0, last = z
  for (; z > -3700 && z < 3300; z += dir * 4) {
    if (F.shore(x, z) < 0) { last = z; run = 0 } else if ((run += 4) > 150) break
  }
  return last
}

/**
 * The Oregon mainland's shoreline z at ground x, found walking from well inland toward the
 * river: the first water at least 24 m wide. (Scanning out from mid-river takes Wells Island
 * for the bank: it is twice as wide as any bar.)
 */
function oregonShore(gb: GorgeBuilder, x: number): number {
  const F = gb.field
  const c = centreZ(x)
  let run = 0
  for (let z = c + 1500; z > c - 100; z -= 4) {
    if (F.shore(x, z) < 0) {
      if ((run += 4) >= 24) return z + run
    } else run = 0
  }
  return c + 600
}

/** piecewise-linear lookup in a list of [x, value] pairs */
function table(t: readonly (readonly [number, number])[], x: number): number {
  if (x <= t[0][0]) return t[0][1]
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) return lerp(t[i - 1][1], t[i][1], (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]))
  }
  return t[t.length - 1][1]
}

export interface Corridor {
  name: string
  /** stations every 10 m: position, inland unit normal, deck height */
  px: Float64Array
  pz: Float64Array
  nx: Float64Array
  nz: Float64Array
  deck: Float64Array
  /** 1 at stations where nothing is built: the ground there could not be met at the grade allowed */
  skip: Uint8Array
  bands: Band[]
  side: number
  /** segment length to draw at (m) */
  seg: number
  rows: Float64Array[]
}

interface CorridorSpec {
  name: string
  x0: number
  x1: number
  seg: number
  /** centreline z at ground x, before smoothing */
  path: (x: number) => number
  /** -1 when inland is toward -z */
  side: number
  bands: Band[]
  /** the deck sits a metre over the ground under the path, kept between these heights above the river */
  minDeck: number
  maxDeck: (x: number) => number
  /** steepest grade the deck may have */
  maxGrade: number
  /**
   * A designed deck profile (height above the river at ground x). The path is then moved
   * sideways, up to `reach` metres, to where the ground stands at that height, so a road
   * crosses a hillside on the level instead of climbing over it.
   */
  profile?: (x: number) => number
  reach?: number
  /**
   * How far the deck may end up below and above the ground across its width before the
   * stretch is left out (m). A cut is carved into the hill; a fill hangs on its skirt bands.
   */
  maxCut?: number
  maxFill?: number
}

/** I-84: where it runs (ground x, z) and how high (m above the river), from the elevation data and the place report's rim heights */
const I84_PATH: [number, number][] = [
  [-2800, 462], [-2650, 593], [-2500, 656], [-2350, 675], [-2200, 640], [-2050, 615], [-1900, 700], [-1750, 805], [-1600, 846],
  [-1450, 880], [-1300, 895], [-1150, 882], [-1000, 915], [-700, 880], [-400, 830], [0, 870], [400, 880], [800, 880], [1000, 925],
  [1250, 1020], [1550, 1045], [1850, 1145], [2000, 1230], [2150, 1290], [2300, 1330], [2600, 1480], [2900, 1650], [3200, 1790], [3650, 1850],
]
const I84_DECK: [number, number][] = [
  [-4300, 13], [-2800, 13], [-1000, 92], [-550, 85], [0, 74], [500, 68], [950, 59], [1250, 50], [1550, 40], [1850, 32], [2000, 29],
  [2150, 22], [2300, 15], [2450, 9], [2600, 7], [3650, 7],
]

function planCorridors(gb: GorgeBuilder, o: LandmarkOptions): Corridor[] {
  const lean = o.detail < 0.7
  const seg = o.detail >= 0.95 ? 20 : o.detail >= 0.7 ? 30 : 50
  const out: Corridor[] = []
  // ---- Washington: BNSF on the riprap at the waterline, SR-14 just inside it. At the
  // Hatchery both swing inland behind the park (the launch is reached across the tracks).
  const waInland: [number, number][] = [
    [-4300, 14], [-760, 14], [-420, 105], [-150, 165], [150, 150], [420, 60], [640, 16], [2700, 16], [3000, 30], [4450, 16], [4750, 150], [5050, 190],
  ]
  const waMaxDeck: [number, number][] = [[-4300, 7.5], [-760, 7.5], [-420, 15], [420, 15], [640, 7.5], [4450, 7.5], [4750, 14]]
  // the shoreline where the scan is fooled (the White Salmon's mouth, the sandbar gap): bridge straight across
  const waFix = (x: number, z: number) =>
    x > 2720 && x < 3010 ? lerp(-412, -182, (x - 2720) / 290) : x > 3520 && x < 3880 ? lerp(6, 172, (x - 3520) / 360) : z
  // (the low tier leaves out the highway's gravel shoulders: two bands in seven)
  const rail: Band[] = [
    { o0: -9, h0: -6.5, o1: -3, h1: 0, col: PAL.riprap, rough: true },
    { o0: -3, h0: 0, o1: 3, h1: 0, col: PAL.ballast, rough: false },
    { o0: 3, h0: 0, o1: lean ? 8 : 7, h1: 2.4, col: PAL.riprap, rough: true },
    ...(lean ? [] : [{ o0: 7, h0: 2.4, o1: 9, h1: 2.4, col: PAL.gravel, rough: false }]),
    { o0: lean ? 8 : 9, h0: 2.4, o1: lean ? 18 : 17, h1: 2.4, col: PAL.asphalt, rough: false },
    ...(lean ? [] : [{ o0: 17, h0: 2.4, o1: 19, h1: 2.4, col: PAL.gravel, rough: false }]),
    { o0: lean ? 18 : 19, h0: 2.4, o1: 21.5, h1: -2, col: PAL.basalt, rough: true },
  ]
  out.push(planCorridor(gb, {
    name: 'wa-rail', x0: -4300, x1: 5050, seg, side: -1, bands: rail, minDeck: 5.2, maxDeck: (x) => table(waMaxDeck, x), maxGrade: 0.03,
    path: (x) => waFix(x, shoreScan(gb, x, -1)) - table(waInland, x),
  }))

  // ---- I-84's line, wanted by the railway too where the two run side by side into Hood River
  const i84Path = (x: number) => (x < I84_PATH[0][0] ? oregonShore(gb, x) + 46 : table(I84_PATH, x))

  // ---- Oregon: Union Pacific on riprap under the cliff, along the mainland bank behind Wells
  // Island, then beside the freeway into town
  const orRail: Band[] = [
    { o0: -8, h0: -6, o1: -3, h1: 0, col: PAL.riprap, rough: true },
    { o0: -3, h0: 0, o1: 3, h1: 0, col: PAL.ballast, rough: false },
    { o0: 3, h0: 0, o1: 5.5, h1: -2, col: PAL.riprap, rough: true },
  ]
  const orFix = (x: number, z: number) => (x > -1560 && x < -1440 ? 370 : z)
  // past the island the line leaves the water and follows the foot of the bluff into town
  const orTown: [number, number][] = [[1950, 1035], [2000, 1053], [2150, 1125], [2300, 1225], [2450, 1350], [2600, 1445]]
  out.push(planCorridor(gb, {
    name: 'or-rail', x0: -4300, x1: 2600, seg, side: 1, bands: orRail, minDeck: 4.6, maxDeck: () => 7, maxGrade: 0.03,
    path: (x) => (x < 1950 ? orFix(x, oregonShore(gb, x)) + 13 : table(orTown, x)),
  }))

  // ---- I-84: four lanes by the river under the Ruthton hill, up across its face to the bench
  // behind the cliff's rim, and down to the Hood River waterfront. Never steeper than 5 %.
  if (o.detail >= 0.7) {
    // the embankments are brush and young fir: from the river a road across a wooded hillside
    // shows as a thin line, not as a pale ramp
    const verge = hex(0x46543a)
    const i84: Band[] = [
      { o0: -34, h0: -15, o1: -15, h1: -2, col: verge, rough: false, cut: false },
      { o0: -15, h0: -2, o1: -13, h1: 0, col: PAL.gravel, rough: false },
      { o0: -13, h0: 0, o1: -2, h1: 0, col: PAL.concrete, rough: false },
      { o0: -2, h0: 0, o1: 2, h1: 0, col: PAL.grassGreen, rough: false },
      { o0: 2, h0: 0, o1: 13, h1: 0, col: PAL.concrete, rough: false },
      { o0: 13, h0: 0, o1: 15, h1: -2, col: PAL.gravel, rough: false },
      { o0: 15, h0: -2, o1: 34, h1: -15, col: verge, rough: false, cut: false },
    ]
    out.push(planCorridor(gb, {
      name: 'i84', x0: -4300, x1: 3650, seg: seg * 1.5, side: 1, bands: i84, minDeck: 6, maxDeck: () => 400, maxGrade: 0.05,
      path: i84Path, profile: (x) => table(I84_DECK, x), reach: 130, maxCut: 45, maxFill: 22,
    }))
  }
  return out
}

/** height of a corridor's surface above its deck datum at offset o, or NaN outside it */
function profile(bands: Band[], o: number): number {
  for (const b of bands) {
    if (b.cut === false) continue
    if (o >= b.o0 && o <= b.o1) return lerp(b.h0, b.h1, (o - b.o0) / (b.o1 - b.o0))
  }
  return NaN
}

/** ease a line of heights until no step between stations `ds` apart is steeper than `grade` */
function limitGrade(h: Float64Array, ds: number, grade: number): void {
  const lim = grade * ds
  for (let pass = 0; pass < 600; pass++) {
    let worst = 0
    for (let i = 1; i < h.length; i++) {
      const d = h[i] - h[i - 1]
      const over = Math.abs(d) - lim
      if (over > 0) {
        const e = 0.5 * over * Math.sign(d)
        h[i] -= e
        h[i - 1] += e
        if (over > worst) worst = over
      }
    }
    if (worst < 0.01) break
  }
}

/**
 * Lay out a bench of several bands following the spec's path, smoothed, ease its deck to the
 * grade allowed, and cut the ground down to pass under every band.
 */
function planCorridor(gb: GorgeBuilder, c: CorridorSpec): Corridor {
  const F = gb.field
  const STEP = 10
  const { x0, x1, side, bands } = c
  const n = Math.floor((x1 - x0) / STEP) + 1
  const rawZ = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = x0 + i * STEP
    let z = c.path(x)
    if (c.profile) {
      // slide across the slope to where the ground stands at the height the deck wants
      const want = c.profile(x), reach = c.reach ?? 100
      let best = Infinity, bz = z
      for (let d = -reach; d <= reach; d += 6) {
        if (F.shore(x, z + d) < 0.3) continue
        const err = Math.abs(F.natural(x, z + d) - want) + 0.03 * Math.abs(d)
        if (err < best) { best = err; bz = z + d }
      }
      z = bz
    }
    rawZ[i] = z
  }
  const px = new Float64Array(n), pz = new Float64Array(n), nx = new Float64Array(n), nz = new Float64Array(n)
  const deck = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0
    for (let k = -14; k <= 14; k++) {
      const wgt = 15 - Math.abs(k)
      s += rawZ[clamp(i + k, 0, n - 1)] * wgt
      w += wgt
    }
    px[i] = x0 + i * STEP
    pz[i] = s / w
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
    const dz = (pz[b] - pz[a]) / (px[b] - px[a])
    const l = Math.hypot(1, dz)
    nx[i] = (side < 0 ? dz : -dz) / l
    nz[i] = (side < 0 ? -1 : 1) / l
    deck[i] = c.profile ? c.profile(px[i]) : clamp(F.natural(px[i], pz[i]) + 1, c.minDeck, Math.max(c.minDeck, c.maxDeck(px[i])))
  }
  // ease the deck along the path
  const tmp = new Float64Array(n)
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < n; i++) tmp[i] = (deck[Math.max(0, i - 1)] + 2 * deck[i] + deck[Math.min(n - 1, i + 1)]) / 4
    deck.set(tmp)
  }
  limitGrade(deck, STEP, c.maxGrade)
  // a designed road is only built where its deck meets the ground
  const skip = new Uint8Array(n)
  if (c.profile) {
    const maxCut = c.maxCut ?? 10, maxFill = c.maxFill ?? 8
    for (let i = 0; i < n; i++) {
      // across the full width of the road, not just under its centre
      let lo = Infinity, hi = -Infinity, wet = false
      for (const o of [-13, 0, 13]) {
        const x = px[i] + nx[i] * o, z = pz[i] + nz[i] * o
        if (F.shore(x, z) < 0.15) wet = true
        const g = F.natural(x, z)
        lo = Math.min(lo, g)
        hi = Math.max(hi, g)
      }
      if (wet || hi - deck[i] > maxCut || deck[i] - lo > maxFill) skip[i] = 1
    }
    // widen each gap a little and drop stubs shorter than 200 m between gaps
    const wide = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (skip[i]) for (let k = -3; k <= 3; k++) wide[clamp(i + k, 0, n - 1)] = 1
    skip.set(wide)
    for (let i = 0; i < n;) {
      if (skip[i]) { i++; continue }
      let j = i
      while (j < n && !skip[j]) j++
      if (j - i < 20) for (let k = i; k < j; k++) skip[k] = 1
      i = j
    }
  }
  // cut the ground under the bands, and ask for mesh vertices just inside and outside
  let oMin = Infinity, oMax = -Infinity
  for (const b of bands) {
    if (b.cut === false) continue
    oMin = Math.min(oMin, b.o0)
    oMax = Math.max(oMax, b.o1)
  }
  const rows: Float64Array[] = []
  let rowA: number[] = [], rowB: number[] = [], rowC: number[] = []
  const flush = () => {
    if (rowA.length >= 4) rows.push(new Float64Array(rowA), new Float64Array(rowB), new Float64Array(rowC))
    rowA = []; rowB = []; rowC = []
  }
  for (let i = 0; i < n; i++) {
    if (skip[i]) { flush(); continue }
    for (let o = oMin; o <= oMax + 0.01; o += 2.5) {
      const h = profile(bands, o)
      if (h === h) F.addCut(px[i] + nx[i] * o, pz[i] + nz[i] * o, deck[i] + h - 0.7)
    }
    rowA.push(px[i] + nx[i] * (oMax + 1), pz[i] + nz[i] * (oMax + 1))
    rowB.push(px[i] + nx[i] * (oMax + 11), pz[i] + nz[i] * (oMax + 11))
    rowC.push(px[i] + nx[i] * (oMin + oMax) * 0.5, pz[i] + nz[i] * (oMin + oMax) * 0.5)
  }
  flush()
  return { name: c.name, px, pz, nx, nz, deck, skip, bands, side, seg: c.seg, rows }
}

function emitCorridor(gb: GorgeBuilder, w: Writer, c: Corridor, _o: LandmarkOptions): void {
  const n = c.px.length
  const stride = Math.max(1, Math.round(c.seg / 10))
  for (let i = 0; i + 1 < n; i += stride) {
    const j = Math.min(n - 1, i + stride)
    let gap = false
    for (let k = i; k <= j; k++) if (c.skip[k]) gap = true
    if (gap) continue
    const m = gb.chunks[gb.chunkAt((c.px[i] + c.px[j]) / 2, (c.pz[i] + c.pz[j]) / 2)]
    for (const b of c.bands) {
      const ax = c.px[i] + c.nx[i] * b.o0, az = c.pz[i] + c.nz[i] * b.o0, ay = c.deck[i] + b.h0
      const bx = c.px[j] + c.nx[j] * b.o0, bz = c.pz[j] + c.nz[j] * b.o0, by = c.deck[j] + b.h0
      const cx = c.px[j] + c.nx[j] * b.o1, cz = c.pz[j] + c.nz[j] * b.o1, cy = c.deck[j] + b.h1
      const dx = c.px[i] + c.nx[i] * b.o1, dz = c.pz[i] + c.nz[i] * b.o1, dy = c.deck[i] + b.h1
      const tone = b.rough ? 0.8 + 0.4 * hash2(i, Math.round(b.o0), 77) : 1
      const ground = Math.min(ay, dy) - 1
      // wind the quad so its face points up
      if (c.side < 0) w.quad(m, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, b.col, ground, tone, false, b.rough ? 0.8 : 0.3)
      else w.quad(m, ax, ay, az, dx, dy, dz, cx, cy, cz, bx, by, bz, b.col, ground, tone, false, b.rough ? 0.8 : 0.3)
    }
  }
}

// ---------------------------------------------------------------------------------------
// the Hatchery: buildings, vans, rigged wings on the lawn
// ---------------------------------------------------------------------------------------

/** building footprints from the map: [x, z] centres (ground coordinates) */
const HATCHERY_SHEDS: [number, number][] = [
  [999, -898], [820, -856], [901, -916], [946, -927], [846, -932], [815, -937], [747, -927], [752, -947], [672, -979], [649, -993],
  [729, -962], [706, -960], [715, -863], [684, -867], [557, -846], [433, -931],
]
const HATCHERY_OFFICES: [number, number][] = [[1230, -748], [1293, -767], [1276, -738], [1331, -762], [1181, -787], [1527, -916]]
const PARK_BUILDINGS: [number, number][] = [
  [-340, -649], [-324, -694], [-308, -674], [-353, -679], [-119, -808], [-233, -796], [-326, -797], [-217, -694], [-147, -692],
  [-122, -709], [-129, -749], [-26, -774], [-26, -857], [3, -867], [51, -859], [99, -767], [131, -803], [192, -778], [-229, -731], [-209, -735],
]
/** parking by the launch and along the park road: [x, z, number of vans] */
const PARKING: [number, number, number][] = [[-129, -588, 9], [-60, -610, 5], [46, -676, 5], [105, -711, 4], [159, -711, 4], [318, -738, 3]]

/**
 * True where a tree may stand on the Hatchery terrace: not through a roof, not in a parking
 * row, and not in the open ground in front of the hatchery's sheds (kept clear so their red
 * roofs show from the water between the trees).
 */
export function clearOfBuildings(x: number, z: number): boolean {
  if (x < -420 || x > 1600 || z < -1060 || z > -540) return true
  for (const [bx, bz] of HATCHERY_SHEDS) {
    // the sheds lie along the terrace: 33 m either way along it, 16 m across, and a gap toward the river
    if (Math.abs(x - bx) < 33 && z - bz > -16 && z - bz < 34) return false
  }
  for (const [bx, bz] of HATCHERY_OFFICES) if (Math.abs(x - bx) < 21 && Math.abs(z - bz) < 13) return false
  for (const [bx, bz] of PARK_BUILDINGS) if (Math.abs(x - bx) < 14 && Math.abs(z - bz) < 12) return false
  for (const [bx, bz, n] of PARKING) {
    const r = n * 1.7 + 7
    if ((x - bx) * (x - bx) + (z - bz) * (z - bz) < r * r) return false
  }
  // the launch's toilet block
  return !(Math.abs(x + 41) < 10 && Math.abs(z + 602) < 9)
}

function addHatchery(gb: GorgeBuilder, w: Writer, o: LandmarkOptions): void {
  const F = gb.field
  const base = (x: number, z: number, a: number, b: number, ux: number, uz: number) => {
    let lo = Infinity, hi = -Infinity
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const e = gb.ground(x + ux * a * su - uz * b * sv, z + uz * a * su + ux * b * sv)
      lo = Math.min(lo, e); hi = Math.max(hi, e)
    }
    return [lo, hi]
  }
  const put = (x: number, z: number, a: number, b: number, h: number, gable: number, wall: Rgb, roof: Rgb, ang: number) => {
    if (F.shore(x, z) < 0.3) return
    const ux = Math.cos(ang), uz = Math.sin(ang)
    const [lo, hi] = base(x, z, a, b, ux, uz)
    w.box(gb.chunks[gb.chunkAt(x, z)], x, z, ux, uz, a, b, lo - 0.6, hi + h, wall, roof, gable, lo)
  }
  // long low sheds over the rearing ponds, red roofs, lying along the terrace
  HATCHERY_SHEDS.forEach(([x, z], i) => {
    const long = 15 + 12 * hash2(i, 1, 501)
    put(x, z, long, 6 + 2 * hash2(i, 2, 501), 4.2, 2.2, i % 5 === 0 ? WALL_WHITE : WALL_CREAM, i % 4 === 3 ? ROOF_GREY : ROOF_RED, 0.12 + 0.1 * (hash2(i, 3, 501) - 0.5))
  })
  HATCHERY_OFFICES.forEach(([x, z], i) => put(x, z, 9 + 5 * hash2(i, 1, 502), 5.5, 4, 1.8, WALL_CREAM, ROOF_RED, 0.25))
  PARK_BUILDINGS.forEach(([x, z], i) => {
    if (o.detail < 0.7 && i % 2) return
    put(x, z, 5 + 3.5 * hash2(i, 1, 503), 3.6 + 1.2 * hash2(i, 2, 503), 3.1, 1.6, i % 3 === 0 ? WALL_BROWN : i % 3 === 1 ? WALL_WHITE : WALL_GREY, i % 2 ? ROOF_DARK : ROOF_GREY, hash2(i, 3, 503) * 3.1)
  })
  // the launch's toilet block
  put(-41, -602, 4.5, 3, 3, 1.2, WALL_BROWN, ROOF_DARK, 0.3)

  // vans and trucks, nose in
  let k = 0
  for (const [cx, cz, count] of PARKING) {
    const n = o.detail < 0.7 ? Math.ceil(count * 0.6) : count
    const ang = 0.25 + 0.5 * hash2(Math.round(cx), Math.round(cz), 504)
    const ux = Math.cos(ang), uz = Math.sin(ang)
    for (let i = 0; i < n; i++, k++) {
      const x = cx + ux * (i - (n - 1) / 2) * 3.4, z = cz + uz * (i - (n - 1) / 2) * 3.4
      if (F.shore(x, z) < 0.3) continue
      const g = gb.ground(x, z)
      const big = hash2(k, 1, 505) > 0.45
      const col = VAN_COLS[Math.floor(hash2(k, 2, 505) * VAN_COLS.length)]
      const m = gb.chunks[gb.chunkAt(x, z)]
      // body across the row, glass band as a darker lid
      w.box(m, x, z, -uz, ux, big ? 2.9 : 2.4, 1.0, g - 0.2, g + (big ? 2.5 : 1.75), col, col, 0, g)
      w.box(m, x - uz * 0.3, z + ux * 0.3, -uz, ux, big ? 2.2 : 1.5, 0.94, g + (big ? 2.5 : 1.75), g + (big ? 2.56 : 2.25), hex(0x2c3238), col, 0, g)
    }
  }

  // wings and sails rigged on the lawn above the launch
  const sails = o.detail < 0.7 ? 8 : 16
  for (let i = 0; i < sails; i++) {
    const x = -150 + 190 * hash2(i, 1, 506), z = -548 - 46 * hash2(i, 2, 506)
    if (F.shore(x, z) < 0.25) continue
    const g = gb.ground(x, z)
    const col = SAIL_COLS[i % SAIL_COLS.length]
    const m = gb.chunks[gb.chunkAt(x, z)]
    const a = hash2(i, 3, 506) * 6.28
    const ux = Math.cos(a), uz = Math.sin(a)
    if (i % 3 === 0) {
      // a windsurf sail standing rigged: a tall triangle
      w.quad(m, x, g + 0.2, z, x + ux * 2.2, g + 0.5, z + uz * 2.2, x + ux * 0.25, g + 4.6, z + uz * 0.25, x + ux * 0.1, g + 4.6, z + uz * 0.1, col, g, 1, true)
    } else {
      // a wing lying on the grass: a shallow arch
      w.quad(m, x - ux * 2.3, g + 0.25, z - uz * 2.3, x + ux * 2.3, g + 0.25, z + uz * 2.3, x + ux * 1.4 - uz * 1.5, g + 1.1, z + uz * 1.4 + ux * 1.5, x - ux * 1.4 - uz * 1.5, g + 1.1, z - uz * 1.4 + ux * 1.5, col, g, 1, true)
    }
  }
}

// ---------------------------------------------------------------------------------------
// towns: White Salmon and Bingen on the Washington side, Hood River on the Oregon side
// ---------------------------------------------------------------------------------------

function addTowns(gb: GorgeBuilder, w: Writer, o: LandmarkOptions): void {
  const F = gb.field, S = gb.survey
  // the low tier keeps three houses in ten, with flat roofs (ten triangles each)
  const lean = o.detail < 0.7
  const scale = o.detail >= 0.95 ? 1 : o.detail >= 0.7 ? 0.55 : 0.3
  const walls = [WALL_WHITE, WALL_CREAM, WALL_GREY, WALL_BLUE, WALL_BROWN, WALL_WHITE]
  const roofs = [ROOF_DARK, ROOF_GREY, ROOF_DARK, ROOF_TAN, ROOF_RED, ROOF_DARK]
  // candidates on a jittered grid; keep those the rules like
  const CELL = 46
  let id = 0
  for (let z = -3600; z < 3200; z += CELL) {
    for (let x = 2250; x < 6300; x += CELL) {
      id++
      const hx = x + CELL * hash2(id, 1, 601), hz = z + CELL * hash2(id, 2, 601)
      if (F.outside(hx, hz) > -150 || F.shore(hx, hz) < 0.6) continue
      const y = sample(S.height, hx, hz)
      const slope = F.slope(hx, hz)
      const wash = hz < centreZ(hx)
      const vis = sample(S.visible, hx, hz)
      const rim = sample(S.skyline, hx, hz)
      let p = 0, big = 0
      if (wash) {
        // White Salmon along the bluff rim and back over the bench; Bingen on the flats below
        if (hx > 2950 && hx < 5300 && y > 105 && y < 265 && slope < 0.3) p = 0.03 + 0.42 * Math.max(vis, rim)
        if (hx > 4550 && y < 28 && slope < 0.15) { p = 0.28; big = hash2(id, 3, 601) < 0.3 ? 1 : 0 }
      } else {
        const d = sample(S.shoreDist, hx, hz)
        // the port on the fill, then the town climbing the hill
        if (hx > 2350 && hx < 4350 && y < 9 && y > 1.6 && d > 70) { p = 0.3 * smoothstep(0.45, 0.6, fbm(hx / 240, hz / 240, 2, 602)); big = 1 }
        if (hx > 2300 && hx < 4700 && y >= 9 && y < 165 && slope < 0.33) p = 0.04 + 0.34 * vis
      }
      if (hash2(id, 4, 601) > p * scale) continue
      const ang = (wash ? 0.3 : 0.2) + (hash2(id, 5, 601) < 0.5 ? 0 : Math.PI / 2) + 0.2 * (hash2(id, 6, 601) - 0.5)
      const ux = Math.cos(ang), uz = Math.sin(ang)
      const a = big ? 16 + 22 * hash2(id, 7, 601) : 5 + 4 * hash2(id, 7, 601)
      const b = big ? 10 + 10 * hash2(id, 8, 601) : 3.6 + 1.6 * hash2(id, 8, 601)
      let lo = Infinity, hi = -Infinity
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const e = gb.ground(hx + ux * a * su - uz * b * sv, hz + uz * a * su + ux * b * sv)
        lo = Math.min(lo, e); hi = Math.max(hi, e)
      }
      if (lo < 0.5 || hi - lo > 6) continue
      const c = Math.floor(hash2(id, 9, 601) * walls.length)
      const h = big ? 6 + 5 * hash2(id, 10, 601) : 3.2 + (hash2(id, 10, 601) < 0.35 ? 2.8 : 0) + (lean ? 0.9 : 0)
      w.box(gb.chunks[gb.chunkAt(hx, hz)], hx, hz, ux, uz, a, b, lo - 0.5, hi + h, big ? (c % 2 ? WALL_GREY : WALL_WHITE) : walls[c], big ? ROOF_GREY : roofs[c], big || lean ? 0 : 1.7, lo)
    }
  }
}
