/**
 * The terrain as one triangulated irregular network.
 *
 * Points are put where they pay: three rows along every shoreline (a toe under water, the
 * waterline itself, the top of the bank) so the water meets the land along mesh edges, with
 * two more along the Hatchery terrace where the bank is stepped in ledges; a graded scatter
 * over the land, fine where a rider can come close and where the ground faces the water,
 * coarse on bench tops and behind the rims; and rings of points out to 60 km for the far
 * ridges, closer together through the notch to the west and over the hills dead ahead to
 * the east. One Delaunay triangulation joins them, so there are no seams or T-junctions
 * between levels of detail.
 */
import { mulberry32 } from '../../sim/rng'
import { triangulate } from './delaunay'
import { HEADING_DEG, HOOD, MITCHELL, RECT, type TerrainField } from './field'
import { clamp } from './noise'
import type { Survey } from './survey'

/**
 * LEDGE and LEDGE_BACK are the two extra rows of the Hatchery shore: the lip of the first
 * step of water-worn basalt (just inside the waterline) and the foot of the cut bank behind it.
 */
export const KIND = { LAND: 0, SHORE: 1, TOE: 2, BANK: 3, FAR: 4, LEDGE: 5, LEDGE_BACK: 6 } as const

export interface Tin {
  count: number
  /** ground coordinates (far points at their true distance) */
  x: Float32Array
  y: Float32Array
  z: Float32Array
  kind: Uint8Array
  /**
   * where each vertex takes its ground cover from: itself, except the top of a bank with a
   * steep slope behind it, which looks one mesh spacing inland (so a coarse mesh does not
   * smear the pale shore up the foot of a cliff)
   */
  sx: Float32Array
  sz: Float32Array
  /** three vertex indices per triangle, front face up */
  tris: Uint32Array
  /** the mesh-size scale that was used (1 = finest) */
  scale: number
}

export interface TinOptions {
  /** triangle budget for the whole network */
  budget: number
  /** azimuth step of the far rings in the sectors that matter (degrees) and elsewhere */
  farStepFine: number
  farStepCoarse: number
  /** ratio between successive far rings */
  farRingRatio: number
  /** polylines [x0, z0, x1, z1, ...] the network must have vertices along (edges of road and rail benches) */
  rows?: Float64Array[]
}

/** height of the waterline row above the river: clear of the water plane, below any bank */
const SHORE_Y = 0.2
const TOE_Y = -3
/** how far inside the waterline the lip of the Hatchery's first ledge stands (m) */
const LEDGE_LIP = 1.5

// ---------------------------------------------------------------------------------------
// shoreline contours
// ---------------------------------------------------------------------------------------

/** zero contours of the shore field as polylines [x0, z0, x1, z1, ...] */
function traceShore(F: TerrainField): Float64Array[] {
  const g = F.shoreGrid
  const { nx, nz, data, step } = g
  const links = new Map<number, number[]>()
  const add = (a: number, b: number) => {
    let l = links.get(a)
    if (!l) links.set(a, (l = []))
    l.push(b)
    l = links.get(b)
    if (!l) links.set(b, (l = []))
    l.push(a)
  }
  const H = (i: number, j: number) => 2 * (j * nx + i)
  const V = (i: number, j: number) => 2 * (j * nx + i) + 1
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i
      const v00 = data[k], v10 = data[k + 1], v01 = data[k + nx], v11 = data[k + nx + 1]
      const c = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0)
      if (c === 0 || c === 15) continue
      const B = H(i, j), R = V(i + 1, j), T = H(i, j + 1), L = V(i, j)
      switch (c) {
        case 1: case 14: add(L, B); break
        case 2: case 13: add(B, R); break
        case 3: case 12: add(L, R); break
        case 4: case 11: add(R, T); break
        case 6: case 9: add(B, T); break
        case 7: case 8: add(L, T); break
        default: {
          // saddle: join by the sign of the middle
          const mid = (v00 + v10 + v01 + v11) / 4 > 0
          if ((c === 5) === mid) { add(L, T); add(B, R) } else { add(L, B); add(R, T) }
        }
      }
    }
  }
  const point = (key: number, out: number[]) => {
    const cell = key >> 1
    const i = cell % nx, j = (cell - i) / nx
    if (key & 1) {
      const a = data[cell], b = data[cell + nx]
      out.push(g.x0 + i * step, g.z0 + (j + a / (a - b)) * step)
    } else {
      const a = data[cell], b = data[cell + 1]
      out.push(g.x0 + (i + a / (a - b)) * step, g.z0 + j * step)
    }
  }
  const seen = new Set<number>()
  const lines: Float64Array[] = []
  const walk = (start: number, first: number, out: number[]) => {
    let prev = start, cur = first
    while (cur !== -1 && !seen.has(cur)) {
      seen.add(cur)
      point(cur, out)
      const l = links.get(cur)!
      const next = l[0] === prev ? (l.length > 1 ? l[1] : -1) : l[0]
      prev = cur
      cur = next
    }
    return cur
  }
  for (const [key, l] of links) {
    if (seen.has(key)) continue
    seen.add(key)
    const fwd: number[] = []
    point(key, fwd)
    const end = walk(key, l[0], fwd)
    if (end === key) {
      // closed loop
      fwd.push(fwd[0], fwd[1])
      lines.push(new Float64Array(fwd))
      continue
    }
    const back: number[] = []
    if (l.length > 1) walk(key, l[1], back)
    // back is in walking order away from the start: reverse it in front of fwd
    const all: number[] = []
    for (let k = back.length - 2; k >= 0; k -= 2) all.push(back[k], back[k + 1])
    for (let k = 0; k < fwd.length; k++) all.push(fwd[k])
    lines.push(new Float64Array(all))
  }
  return lines
}

// ---------------------------------------------------------------------------------------
// point set
// ---------------------------------------------------------------------------------------

class PointSet {
  xs: number[] = []
  zs: number[] = []
  kinds: number[] = []
  /** cover sample position (bank tops), or NaN for the point itself */
  sxs: number[] = []
  szs: number[] = []
  /** far points: half the gap to the next ring and to the next spoke (m), for averaging the height */
  gapR: number[] = []
  gapA: number[] = []
  private head: Int32Array
  private next: number[] = []
  private readonly cell = 12
  private readonly gx: number
  private readonly gz: number

  constructor() {
    this.gx = Math.ceil((RECT.x1 - RECT.x0) / this.cell) + 1
    this.gz = Math.ceil((RECT.z1 - RECT.z0) / this.cell) + 1
    this.head = new Int32Array(this.gx * this.gz).fill(-1)
  }

  get count(): number { return this.xs.length }

  /** is any point of the set within r of (x, z)? (inside the level rectangle only) */
  near(x: number, z: number, r: number): boolean {
    const c = this.cell
    const i0 = Math.max(0, Math.floor((x - r - RECT.x0) / c)), i1 = Math.min(this.gx - 1, Math.floor((x + r - RECT.x0) / c))
    const j0 = Math.max(0, Math.floor((z - r - RECT.z0) / c)), j1 = Math.min(this.gz - 1, Math.floor((z + r - RECT.z0) / c))
    const r2 = r * r
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (let p = this.head[j * this.gx + i]; p !== -1; p = this.next[p]) {
          const dx = this.xs[p] - x, dz = this.zs[p] - z
          if (dx * dx + dz * dz < r2) return true
        }
      }
    }
    return false
  }

  add(x: number, z: number, kind: number, index = true): number {
    const id = this.xs.length
    this.xs.push(x)
    this.zs.push(z)
    this.kinds.push(kind)
    this.sxs.push(NaN)
    this.szs.push(NaN)
    this.gapR.push(0)
    this.gapA.push(0)
    let slot = -1
    if (index && x >= RECT.x0 && x <= RECT.x1 && z >= RECT.z0 && z <= RECT.z1) {
      slot = Math.floor((z - RECT.z0) / this.cell) * this.gx + Math.floor((x - RECT.x0) / this.cell)
    }
    if (slot >= 0) {
      this.next.push(this.head[slot])
      this.head[slot] = id
    } else this.next.push(-1)
    return id
  }
}

/** rows of points along every shoreline */
function addShoreRows(P: PointSet, F: TerrainField, S: Survey, lines: Float64Array[], scale: number, rand: () => number): void {
  const grad = { x: 0, z: 0 }
  for (const line of lines) {
    const n = line.length >> 1
    if (n < 2) continue
    // total length; drop specks
    let total = 0
    for (let i = 1; i < n; i++) total += Math.hypot(line[2 * i] - line[2 * i - 2], line[2 * i + 1] - line[2 * i - 1])
    if (total < 45) continue
    const closed = line[0] === line[2 * n - 2] && line[1] === line[2 * n - 1]
    let seg = 0, segStart = 0
    let segLen = Math.hypot(line[2] - line[0], line[3] - line[1])
    let s = closed ? 0 : 1e-3
    while (s < total) {
      while (seg < n - 2 && s > segStart + segLen) {
        segStart += segLen
        seg++
        segLen = Math.hypot(line[2 * seg + 2] - line[2 * seg], line[2 * seg + 3] - line[2 * seg + 1])
      }
      const t = segLen > 0 ? clamp((s - segStart) / segLen, 0, 1) : 0
      let x = line[2 * seg] + (line[2 * seg + 2] - line[2 * seg]) * t
      let z = line[2 * seg + 1] + (line[2 * seg + 3] - line[2 * seg + 1]) * t
      const spacing = clamp(S.edgeLength(x, z) * scale * 1.05, 5, 90)
      // inland direction, and pull the point onto the contour
      F.shoreGrad(x, z, grad)
      let gl = Math.hypot(grad.x, grad.z)
      if (gl > 1e-6) {
        const c = F.shore(x, z)
        const k = clamp((-c * 12) / gl, -6, 6) // shoreGrad spans 12 m
        x += (grad.x / gl) * k
        z += (grad.z / gl) * k
        F.shoreGrad(x, z, grad)
        gl = Math.hypot(grad.x, grad.z)
      }
      if (gl > 1e-6) {
        const nx = grad.x / gl, nz = grad.z / gl
        const jx = (rand() - 0.5) * 0.06 * spacing, jz = (rand() - 0.5) * 0.06 * spacing
        if (!P.near(x, z, 0.45 * spacing)) {
          P.add(x + jx, z + jz, KIND.SHORE)
          const wToe = clamp(0.75 * spacing, 5, 16)
          const tx = x - nx * wToe, tz = z - nz * wToe
          if (F.shore(tx, tz) < -0.04 && !P.near(tx, tz, 0.4 * spacing)) P.add(tx - jz, tz + jx, KIND.TOE)
          // (the ledge rows need the shore row to be finer than 13 m, or the step between
          // them is a string of long slivers: the low tier gets a plain cut bank instead)
          const stepped = F.ledgeShore(x, z) > 0.5
          const ledges = stepped && spacing <= 13
          const wTop = ledges ? clamp(0.6 * spacing, 6.5, 14) : clamp(0.6 * spacing, 4, 14)
          const bx = x + nx * wTop, bz = z + nz * wTop
          const bankOk = F.shore(bx, bz) > 0.04 && !P.near(bx, bz, 0.4 * spacing)
          if (ledges && bankOk) {
            // the Hatchery shore: a dark riser out of the water, a flat pale ledge, then the cut bank
            P.add(x + nx * LEDGE_LIP + jx, z + nz * LEDGE_LIP + jz, KIND.LEDGE)
            P.add(x + nx * (wTop - 1.4) + jx, z + nz * (wTop - 1.4) + jz, KIND.LEDGE_BACK)
          }
          if (bankOk) {
            const id = P.add(bx + jz, bz - jx, KIND.BANK)
            // a slope climbing straight up behind the bank: take its colour, not the shore's
            const reach = clamp(0.9 * spacing, 8, 45)
            const ix = bx + nx * reach, iz = bz + nz * reach
            if (F.shore(ix, iz) > 0.3 && F.slope(ix, iz) > 0.38) {
              P.sxs[id] = ix
              P.szs[id] = iz
            } else if (stepped) {
              // the top of the cut bank above the ledges is the terrace's grass, not rock
              P.sxs[id] = bx + nx * 12
              P.szs[id] = bz + nz * 12
            }
          }
        }
      }
      s += spacing
    }
  }
}

/** vertices along given lines, at the local mesh spacing */
function addRows(P: PointSet, F: TerrainField, S: Survey, rows: Float64Array[], scale: number, rand: () => number): void {
  for (const line of rows) {
    const n = line.length >> 1
    let next = 0, walked = 0
    for (let i = 0; i + 1 < n; i++) {
      const ax = line[2 * i], az = line[2 * i + 1], bx = line[2 * i + 2], bz = line[2 * i + 3]
      const len = Math.hypot(bx - ax, bz - az)
      while (next <= walked + len) {
        const t = len > 0 ? (next - walked) / len : 0
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t
        const spacing = clamp(S.edgeLength(x, z) * scale * 0.9, 8, 40)
        if (F.outside(x, z) < 0 && F.shore(x, z) > 0.1 && !P.near(x, z, 0.5 * spacing)) {
          P.add(x + (rand() - 0.5) * 0.4, z + (rand() - 0.5) * 0.4, KIND.LAND)
        }
        next += spacing
      }
      walked += len
    }
  }
}

/** graded scatter over the land inside the level data */
function addLand(P: PointSet, F: TerrainField, S: Survey, scale: number, rand: () => number, count: { n: number } | null): void {
  const ROOT = 432
  const visit = (cx: number, cz: number, size: number) => {
    const half = size / 2
    // nothing to do in open water or wholly beyond the data
    if (F.outside(cx, cz) > size * 0.71) return
    if (size <= 216) {
      const a = F.shore(cx, cz), b = F.shore(cx - half, cz - half), c = F.shore(cx + half, cz - half)
      const d = F.shore(cx - half, cz + half), e = F.shore(cx + half, cz + half)
      if (a < -0.6 && b < -0.6 && c < -0.6 && d < -0.6 && e < -0.6) return
    }
    const L = S.edgeLength(cx, cz) * scale
    if (size > L && size > 5) {
      const q = size / 4
      visit(cx - q, cz - q, half)
      visit(cx + q, cz - q, half)
      visit(cx - q, cz + q, half)
      visit(cx + q, cz + q, half)
      return
    }
    const x = cx + (rand() - 0.5) * 0.5 * size
    const z = cz + (rand() - 0.5) * 0.5 * size
    if (F.outside(x, z) > 0) return
    if (F.shore(x, z) < 0.1) return
    if (P.near(x, z, 0.55 * Math.min(size, L))) return
    if (count) count.n++
    else P.add(x, z, KIND.LAND)
  }
  for (let z = RECT.z0 + ROOT / 2; z < RECT.z1 + ROOT / 2; z += ROOT) {
    for (let x = RECT.x0 + ROOT / 2; x < RECT.x1; x += ROOT) visit(x, z, ROOT)
  }
}

/** true bearing (degrees) -> unit vector in ground coordinates */
function bearing(az: number): { x: number; z: number } {
  const th = ((az - HEADING_DEG) * Math.PI) / 180
  return { x: Math.cos(th), z: Math.sin(th) }
}

/** rings of points beyond the level data, out to 60 km */
function addFar(P: PointSet, F: TerrainField, o: TinOptions, rand: () => number): void {
  // sectors a rider looks into: the notch and its ridges to the west, the gorge to the east
  const west = (az: number) => az >= 226 && az <= 294
  const east = (az: number) => az >= 36 && az <= 138
  // rings close together out to 12 km (hills a rider comes near), opening up beyond
  const radii: number[] = []
  for (let r = 3000; r < 61000; r *= r < 12000 ? o.farRingRatio : 1 + (o.farRingRatio - 1) * 1.8) radii.push(r)
  // the hills dead ahead of a run (Burdoin Mountain, 5 to 11 km east) get a ring between each
  // pair, and so do the headlands of the notch (4 to 24 km west): they lie along the river,
  // which is the direction the rings are farthest apart in
  const between = (lo: number, hi: number) => {
    const out = radii.slice()
    for (let k = 0; k + 1 < radii.length; k++) if (radii[k] > lo && radii[k + 1] < hi) out.push(Math.sqrt(radii[k] * radii[k + 1]))
    return out.sort((p, q) => p - q)
  }
  const ringsEast = between(4200, 11500), ringsWest = between(4200, 24000)
  // only the notch itself (the river and its two walls) needs them in the west
  const notch = (az: number) => az >= 244 && az <= 276
  let az = 0
  while (az < 360) {
    const fine = west(az) || east(az)
    const step = fine ? o.farStepFine : o.farStepCoarse
    const d = bearing(az + (rand() - 0.5) * 0.15 * step)
    const rings = east(az) ? ringsEast : notch(az) ? ringsWest : radii
    for (let k = 0; k < rings.length; k++) {
      const r = rings[k] * (1 + (rand() - 0.5) * 0.06)
      const x = d.x * r, z = d.z * r
      if (F.outside(x, z) <= 60) continue
      const id = P.add(x, z, KIND.FAR, false)
      const next = k + 1 < rings.length ? rings[k + 1] : rings[k] * 1.2
      P.gapR[id] = 0.5 * (next - rings[k])
      P.gapA[id] = 0.5 * r * ((step * Math.PI) / 180)
    }
    az += step
  }
  // Mt Hood: its own little fan so the cone has a point and flanks
  P.add(HOOD.x, HOOD.z, KIND.FAR, false)
  const rings = [450, 1000, 1800, 3000, 4800, 7500]
  for (let k = 0; k < rings.length; k++) {
    const m = 7 + k
    for (let a = 0; a < m; a++) {
      const th = ((a + 0.5 * (k & 1) + (rand() - 0.5) * 0.2) / m) * Math.PI * 2
      P.add(HOOD.x + Math.cos(th) * rings[k], HOOD.z + Math.sin(th) * rings[k], KIND.FAR, false)
    }
  }
  // Mitchell Point: the cliff dome at the water on the Oregon side of the notch
  P.add(MITCHELL.x, MITCHELL.z, KIND.FAR, false)
  const dome = [110, 230, 380, 600]
  for (let k = 0; k < dome.length; k++) {
    const m = 6 + 2 * k
    for (let a = 0; a < m; a++) {
      const th = ((a + 0.5 * (k & 1)) / m) * Math.PI * 2
      const x = MITCHELL.x + Math.cos(th) * dome[k], z = MITCHELL.z + Math.sin(th) * dome[k]
      if (F.outside(x, z) > 60) P.add(x, z, KIND.FAR, false)
    }
  }
}

// ---------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------

export function buildTin(F: TerrainField, S: Survey, o: TinOptions): Tin {
  const lines = traceShore(F)

  // find the mesh-size scale that meets the triangle budget (a few dry runs: the count
  // goes roughly as 1 / scale^2)
  const farProbe = new PointSet()
  addFar(farProbe, F, o, mulberry32(3))
  const farCount = farProbe.count
  const target = Math.max(2000, o.budget / 2 - farCount)
  let scale = 2
  let P = new PointSet()
  for (let iter = 0; iter < 4; iter++) {
    P = new PointSet()
    addShoreRows(P, F, S, lines, scale, mulberry32(1))
    if (o.rows) addRows(P, F, S, o.rows, scale, mulberry32(4))
    const c = { n: 0 }
    addLand(P, F, S, scale, mulberry32(2), c)
    const total = P.count + c.n
    const ratio = total / target
    if (Math.abs(ratio - 1) < 0.04) break
    scale = Math.max(1, scale * Math.pow(ratio, 0.55))
    if (scale === 1 && ratio < 1) break
  }
  P = new PointSet()
  addShoreRows(P, F, S, lines, scale, mulberry32(1))
  if (o.rows) addRows(P, F, S, o.rows, scale, mulberry32(4))
  addLand(P, F, S, scale, mulberry32(2), null)
  addFar(P, F, o, mulberry32(3))

  const n = P.count
  const coords = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    coords[2 * i] = P.xs[i]
    coords[2 * i + 1] = P.zs[i]
  }
  const raw = triangulate(coords)

  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n)
  const sx = new Float32Array(n), sz = new Float32Array(n)
  const kind = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const px = P.xs[i], pz = P.zs[i]
    const k = P.kinds[i]
    x[i] = px
    z[i] = pz
    kind[i] = k
    sx[i] = P.sxs[i] === P.sxs[i] ? P.sxs[i] : px
    sz[i] = P.szs[i] === P.szs[i] ? P.szs[i] : pz
    if (k === KIND.SHORE) y[i] = SHORE_Y
    else if (k === KIND.TOE) y[i] = TOE_Y
    else if (k === KIND.BANK) y[i] = Math.max(F.elev(px, pz), F.bankHeight(px, pz))
    else if (k === KIND.LAND) y[i] = Math.max(F.elev(px, pz), 0.6)
    else if (k === KIND.LEDGE) y[i] = F.ledgeHeight(px, pz)
    else if (k === KIND.LEDGE_BACK) y[i] = F.ledgeHeight(px, pz) + 0.22
    else if (P.gapR[i] > 0) {
      // a far ring point stands for the ground half-way to its neighbours: average over that,
      // so a coarse ring cannot catch one summit and draw it as a spike
      const r = Math.hypot(px, pz)
      const ux = px / r, uz = pz / r
      const gr = P.gapR[i], ga = P.gapA[i]
      y[i] = (2 * F.elev(px, pz) + F.elev(px + ux * gr, pz + uz * gr) + F.elev(px - ux * gr, pz - uz * gr) + F.elev(px - uz * ga, pz + ux * ga) + F.elev(px + uz * ga, pz - ux * ga)) / 6
      // ...but the river stays a river
      if (F.elev(px, pz) < 0) y[i] = F.elev(px, pz)
    } else y[i] = F.elev(px, pz)
  }

  // keep triangles that have something above water; drop the rest (open river)
  const keep = new Uint32Array(raw.length)
  let m = 0
  for (let t = 0; t < raw.length; t += 3) {
    const a = raw[t], b = raw[t + 1], c = raw[t + 2]
    if (y[a] < 0 && y[b] < 0 && y[c] < 0) continue
    // over open water (strung between the two banks where a toe point is missing, or from
    // waterline to waterline across an inlet): let the water show
    const cx = (x[a] + x[b] + x[c]) / 3, cz = (z[a] + z[b] + z[c]) / 3
    if (kind[a] !== KIND.FAR && kind[b] !== KIND.FAR && kind[c] !== KIND.FAR) {
      const sa = kind[a] === KIND.SHORE, sb = kind[b] === KIND.SHORE, sc = kind[c] === KIND.SHORE
      const toe = kind[a] === KIND.TOE || kind[b] === KIND.TOE || kind[c] === KIND.TOE
      const lim = toe ? -0.8 : sa && sb && sc ? 0 : -0.15
      if ((toe || sa || sb || sc) && F.shore(cx, cz) < lim) continue
    }
    keep[m++] = a
    keep[m++] = b
    keep[m++] = c
  }
  return { count: n, x, y, z, kind, sx, sz, tris: keep.slice(0, m), scale }
}
