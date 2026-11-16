/**
 * Builds the gorge: terrain network, lighting factors, trees and landmarks, sorted into a
 * handful of draw calls. Pure data in, typed arrays out (no renderer), so it also runs
 * headless for checks.
 */
import { LandCover, PAL, groundColour, makeCover, type Cover } from './cover'
import { RECT, TerrainField } from './field'
import { MeshBuilder } from './geometry'
import { KIND, buildTin, type Tin } from './mesh'
import { clamp, fbm, smoothstep } from './noise'
import { Survey, centreZ, sample } from './survey'
import { addTrees } from './trees'
import { addLandmarks, planLandmarks, type LandmarkPlan, type TrackLine } from './landmarks'

export interface BuildOptions {
  /** app.quality.terrainDetail: 0.5 low, 0.75 mid, 1 high */
  terrainDetail: number
  /** trees to draw (the tier's budget: see treeBudget() in ../terrain.ts) */
  treeCount: number
  /** unit vector toward the sun, ground axes (the shared atmosphere's) */
  sun: { x: number; y: number; z: number }
  /** degrees the land's light is swung toward the south; LAND_SUN_SWING when left out */
  sunSwing?: number
}

/**
 * The shared 5 pm sun stands 8 degrees to the Washington side of the river's axis, which
 * rakes along both walls: taken literally a steep Washington face gets less direct light
 * than the Oregon cliff opposite. The place at that hour reads the other way round (gold
 * wall in full sun on the left, the Oregon cliff in sky-lit shade), so the land's baked light
 * is worked out with the sun swung this many degrees toward the south, where it stood an hour
 * earlier. The rider, the water and the sky keep the shared vector.
 */
export const LAND_SUN_SWING = 20

export interface BuildStats {
  terrainTriangles: number
  terrainVertices: number
  treeCount: number
  treeTriangles: number
  landmarkTriangles: number
  triangles: number
  vertices: number
  bytes: number
  chunks: { name: string; triangles: number; vertices: number }[]
  ms: Record<string, number>
  meshScale: number
}

export interface Built {
  chunks: { name: string; mesh: MeshBuilder; cull: boolean }[]
  stats: BuildStats
  /** the Washington railway's centreline, for whatever runs on it */
  rail: TrackLine | null
}

/** draw calls: three stretches of each bank near the river, and everything far */
export const CHUNKS = ['wa-west', 'wa-hatchery', 'wa-east', 'or-west', 'or-mid', 'or-east', 'far'] as const
const FAR_CHUNK = 6
/** spacing of the grid the drawn terrain is sampled on for setting things on the ground (m) */
const DRAWN_STEP = 12
/** unit offsets of the three extra points a coarse vertex takes its colour from */
const SPREAD = [1, 0, -0.5, 0.866, -0.5, -0.866]
/** numbers kept per terrain vertex while shading: albedo (3), light (3), detail weights (3), strata shift */
const STRIDE = 11
/** sunlight bounced off sunlit ground onto a vertical face, as a fraction of direct sun */
const GROUND_BOUNCE = 0.3

/** terrain triangle budget for a detail setting: 25k at 0.5, 80k at 0.75, 250k at 1 */
export function terrainBudget(detail: number): number {
  const d = clamp(detail, 0.2, 1.2)
  const pts: [number, number][] = [[0.5, Math.log(25000)], [0.75, Math.log(80000)], [1, Math.log(250000)]]
  const [a, b] = d <= 0.75 ? [pts[0], pts[1]] : [pts[1], pts[2]]
  return Math.exp(a[1] + ((b[1] - a[1]) * (d - a[0])) / (b[0] - a[0]))
}

export class GorgeBuilder {
  readonly field: TerrainField
  readonly survey: Survey
  readonly cover: LandCover
  readonly chunks: MeshBuilder[] = []
  readonly ms: Record<string, number> = {}
  tin!: Tin
  /** height of the drawn triangle network on a grid of DRAWN_STEP metres (NaN where there is none) */
  private drawn: Float32Array | null = null
  private drawnNx = 0
  private drawnNz = 0
  plan: LandmarkPlan | null = null
  /** unit vector toward the sun as the land is lit (see LAND_SUN_SWING) */
  readonly sun: { x: number; y: number; z: number }
  private t0 = 0

  constructor(readonly opts: BuildOptions) {
    this.lap()
    // swing the sun's bearing from up-river toward the Oregon side, keeping its height
    const swing = ((opts.sunSwing ?? LAND_SUN_SWING) * Math.PI) / 180
    const horiz = Math.hypot(opts.sun.x, opts.sun.z)
    const th = Math.atan2(opts.sun.z, opts.sun.x) - swing
    this.sun = horiz > 1e-6 ? { x: horiz * Math.cos(th), y: opts.sun.y, z: horiz * Math.sin(th) } : { ...opts.sun }
    this.field = new TerrainField()
    this.lap('field')
    this.survey = new Survey(this.field)
    this.survey.castShadows(this.sun.x, this.sun.y, this.sun.z)
    this.lap('survey')
    this.cover = new LandCover(this.field, this.survey)
    for (let i = 0; i < CHUNKS.length; i++) this.chunks.push(new MeshBuilder())
  }

  lap(name?: string): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (name) this.ms[name] = Math.round(now - this.t0)
    this.t0 = now
  }

  /**
   * Height of the ground as it is drawn. Where the mesh is fine this is the field's
   * elevation; where it is coarse (the low tier's slopes, bench tops on every tier) the
   * triangles cut across swells and hollows by metres, so anything standing on the ground
   * (trees, houses) is set on the triangles instead, or it floats or is buried.
   */
  ground(x: number, z: number): number {
    const natural = this.field.elev(x, z)
    const d = this.drawn
    if (!d) return natural
    const w = smoothstep(10, 24, this.survey.edgeLength(x, z) * this.tin.scale)
    if (w <= 0) return natural
    const fx = (x - RECT.x0) / DRAWN_STEP, fz = (z - RECT.z0) / DRAWN_STEP
    const i = Math.floor(fx), j = Math.floor(fz)
    if (i < 0 || j < 0 || i >= this.drawnNx - 1 || j >= this.drawnNz - 1) return natural
    const k = j * this.drawnNx + i
    const a = d[k], b = d[k + 1], c = d[k + this.drawnNx], e = d[k + this.drawnNx + 1]
    // (NaN where a node has no triangle over it: open water, the edge of the data)
    if (!(a === a && b === b && c === c && e === e)) return natural
    const tx = fx - i, tz = fz - j
    const h = (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz
    return natural + (h - natural) * w
  }

  /** sample the triangle network onto the grid `ground()` reads */
  private rasterise(): void {
    const { x, y, z, tris } = this.tin
    const nx = Math.floor((RECT.x1 - RECT.x0) / DRAWN_STEP) + 1, nz = Math.floor((RECT.z1 - RECT.z0) / DRAWN_STEP) + 1
    const d = new Float32Array(nx * nz).fill(NaN)
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2]
      const ax = (x[a] - RECT.x0) / DRAWN_STEP, az = (z[a] - RECT.z0) / DRAWN_STEP
      const bx = (x[b] - RECT.x0) / DRAWN_STEP, bz = (z[b] - RECT.z0) / DRAWN_STEP
      const cx = (x[c] - RECT.x0) / DRAWN_STEP, cz = (z[c] - RECT.z0) / DRAWN_STEP
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx)))
      const j0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), j1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz)))
      if (i0 > i1 || j0 > j1) continue
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(det) < 1e-9) continue
      const inv = 1 / det
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const w0 = ((bz - cz) * (i - cx) + (cx - bx) * (j - cz)) * inv
          const w1 = ((cz - az) * (i - cx) + (ax - cx) * (j - cz)) * inv
          const w2 = 1 - w0 - w1
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
          d[j * nx + i] = w0 * y[a] + w1 * y[b] + w2 * y[c]
        }
      }
    }
    this.drawn = d
    this.drawnNx = nx
    this.drawnNz = nz
  }

  /** which draw call a point of the ground belongs to */
  chunkAt(x: number, z: number): number {
    if (this.field.outside(x, z) > -100) return FAR_CHUNK
    if (sample(this.survey.shoreDist, x, z) > 1250) return FAR_CHUNK
    if (z < centreZ(x)) return x < -1300 ? 0 : x < 1700 ? 1 : 2
    return x < 0 ? 3 : x < 2700 ? 4 : 5
  }

  /**
   * Sun, sky and bounce factors for a surface point with unit normal n, `above` m over the
   * ground. Faces turned away from the sky also catch sunlight thrown back by the ground
   * in front of them (dry grass and gravel are bright), which keeps shaded walls and
   * cliff faces from going flat blue.
   */
  light(x: number, z: number, above: number, nx: number, ny: number, nz: number, ao: number, out: { sun: number; sky: number; bounce: number }): void {
    const s = this.sun
    const ndl = nx * s.x + ny * s.y + nz * s.z
    const up = 0.5 + 0.5 * ny
    out.sun = (ndl > 0 ? ndl * this.survey.sunlit(x, z, above) : 0) + GROUND_BOUNCE * (1 - up) * ao * Math.max(0, s.y)
    out.sky = up * ao
    out.bounce = (1 - up) * ao
  }

  /** what the ground cover does to the light on the ground under it */
  shadeGround(cov: Cover, lit: { sun: number; sky: number; bounce: number }): void {
    // closed canopy shades itself when the light is low across it
    const canopy = Math.max(cov.conifer, 0.8 * cov.oakwood)
    if (canopy > 0) lit.sun *= 1 - 0.35 * canopy * (1 - smoothstep(0.25, 0.8, lit.sun))
    // the Oregon cliff stands steeper than the mesh can and faces north: its rock is in sky
    // light at this hour and reads as a dark band. Washington's bands take what sun reaches them.
    if (cov.rock > 0 && cov.side > 0 && cov.far < 0.5) lit.sun *= 1 - 0.6 * smoothstep(0.3, 0.9, cov.rock)
  }

  buildTerrain(): void {
    const F = this.field, S = this.survey
    const d = this.opts.terrainDetail
    S.coarsen = d >= 0.95 ? 2.6 : d >= 0.7 ? 3.6 : 5
    const tin = buildTin(F, S, {
      budget: terrainBudget(d),
      farStepFine: d >= 0.95 ? 1 : d >= 0.7 ? 1.5 : 2,
      farStepCoarse: d >= 0.95 ? 4 : d >= 0.7 ? 5 : 7,
      farRingRatio: d >= 0.95 ? 1.075 : d >= 0.7 ? 1.105 : 1.15,
      rows: this.plan ? this.plan.rows : undefined,
    })
    this.tin = tin
    this.rasterise()
    this.lap('tin')
    const n = tin.count
    const { x, y, z, kind, tris, sx, sz } = tin

    // vertex normals from the faces
    const nrm = new Float32Array(n * 3)
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2]
      const ux = x[b] - x[a], uy = y[b] - y[a], uz = z[b] - z[a]
      const vx = x[c] - x[a], vy = y[c] - y[a], vz = z[c] - z[a]
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
      nrm[3 * a] += cx; nrm[3 * a + 1] += cy; nrm[3 * a + 2] += cz
      nrm[3 * b] += cx; nrm[3 * b + 1] += cy; nrm[3 * b + 2] += cz
      nrm[3 * c] += cx; nrm[3 * c + 1] += cy; nrm[3 * c + 2] += cz
    }

    // colour and light per vertex
    const attr = new Float32Array(n * STRIDE)
    const used = new Uint8Array(n)
    for (let t = 0; t < tris.length; t++) used[tris[t]] = 1
    const cov = makeCover(), cov2 = makeCover()
    const col = { r: 0, g: 0, b: 0, rock: 0, canopy: 0, grain: 0 }
    const col2 = { r: 0, g: 0, b: 0, rock: 0, canopy: 0, grain: 0 }
    const lit = { sun: 0, sky: 0, bounce: 0 }
    for (let i = 0; i < n; i++) {
      if (!used[i]) continue
      let nx = nrm[3 * i], ny = nrm[3 * i + 1], nz = nrm[3 * i + 2]
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len; ny /= len; nz /= len
      if (ny < 0.02) ny = 0.02
      const px = x[i], pz = z[i], py = y[i]
      const k = kind[i]
      const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / ny
      const waterline = k === KIND.SHORE || k === KIND.TOE
      this.cover.at(sx[i], sz[i], Math.max(py, 0), waterline ? 0 : slope, nx, nz, cov)
      groundColour(cov, sx[i], sz[i], py, col)
      if (k === KIND.LAND) {
        // a vertex of a coarse mesh stands for the ground half-way to its neighbours: take its
        // colour from three more points round it, or one vertex in a clearing paints a
        // hectare of wood as grass
        const r = 0.33 * S.edgeLength(px, pz) * tin.scale
        if (r > 9) {
          let wsum = 1
          for (let a = 0; a < 3; a++) {
            const qx = px + r * SPREAD[2 * a], qz = pz + r * SPREAD[2 * a + 1]
            if (F.shore(qx, qz) < 0.12 || F.outside(qx, qz) > 0) continue
            this.cover.at(qx, qz, Math.max(F.elev(qx, qz), 0), slope, nx, nz, cov2)
            groundColour(cov2, qx, qz, py, col2)
            col.r += col2.r; col.g += col2.g; col.b += col2.b
            col.rock += col2.rock; col.canopy += col2.canopy; col.grain += col2.grain
            wsum++
          }
          col.r /= wsum; col.g /= wsum; col.b /= wsum
          col.rock /= wsum; col.canopy /= wsum; col.grain /= wsum
        }
      }
      // hollows see less sky
      const ao = k === KIND.FAR ? 1 : 1 - 0.3 * smoothstep(1, 22, S.hollow(px, pz))
      this.light(px, pz, 0, nx, ny, nz, ao, lit)
      if (waterline) {
        // the wet line: dark where it is rock or riprap, damp sand elsewhere
        const rocky = Math.max(cov.ledge, cov.riprap)
        const w = k === KIND.TOE ? 0.4 : 0.72
        col.r = col.r * w * (1 - rocky) + PAL.wet[0] * rocky * (k === KIND.TOE ? 0.6 : 1)
        col.g = col.g * w * (1 - rocky) + PAL.wet[1] * rocky * (k === KIND.TOE ? 0.6 : 1)
        col.b = col.b * w * 1.03 * (1 - rocky) + PAL.wet[2] * rocky * (k === KIND.TOE ? 0.6 : 1)
      } else if (k === KIND.LEDGE) {
        // the lip of the ledge: pale water-worn basalt, lit from above
        const t = 0.82 + 0.3 * fbm(px / 9, pz / 9, 2, 71)
        col.r = PAL.ledge[0] * t; col.g = PAL.ledge[1] * t; col.b = PAL.ledge[2] * t
        col.rock = 0.35; col.canopy = 0; col.grain = 0.7
        this.light(px, pz, 0, 0, 1, 0, 1, lit)
      } else if (k === KIND.LEDGE_BACK) {
        // the foot of the cut bank: in its own shade
        col.r = PAL.basaltDark[0]; col.g = PAL.basaltDark[1]; col.b = PAL.basaltDark[2]
        col.rock = 0.35; col.canopy = 0; col.grain = 0.7
        lit.sun *= 0.35
        lit.sky *= 0.7
      }
      this.shadeGround(cov, lit)
      if (cov.snow > 0) {
        // Mt Hood's snow: bright whichever way a face is turned (what is not in the sun is lit by the snow around it)
        lit.sun = Math.max(lit.sun, 0.82 * cov.snow)
        lit.sky = Math.max(lit.sky, cov.snow)
      }
      const q = i * STRIDE
      attr[q] = col.r; attr[q + 1] = col.g; attr[q + 2] = col.b
      attr[q + 3] = lit.sun; attr[q + 4] = lit.sky; attr[q + 5] = lit.bounce
      attr[q + 6] = col.rock; attr[q + 7] = col.canopy; attr[q + 8] = col.grain
      // the strata rise and dip along a wall (only read where there is rock)
      attr[q + 9] = col.rock > 0 ? clamp(0.5 + 1.9 * (fbm(px / 240, pz / 240, 2, 331) - 0.5), 0, 1) : 0.5
      // the dry far hills take the detail texture at the scale of woods: oak and pine in
      // clumps on cured grass. (The forested ridges to the west stay smooth: they are read as
      // layers of haze, not as ground.)
      attr[q + 10] = cov.far * cov.dry * (1 - cov.snow)
    }
    this.lap('shade')

    // into draw calls
    const map = new Int32Array(n * CHUNKS.length).fill(-1)
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2]
      const ci = this.chunkAt((x[a] + x[b] + x[c]) / 3, (z[a] + z[b] + z[c]) / 3)
      const m = this.chunks[ci]
      const base = ci * n
      let ia = map[base + a], ib = map[base + b], ic = map[base + c]
      if (ia < 0) ia = map[base + a] = this.emit(m, a, attr)
      if (ib < 0) ib = map[base + b] = this.emit(m, b, attr)
      if (ic < 0) ic = map[base + c] = this.emit(m, c, attr)
      m.tri(ia, ib, ic)
    }
    this.lap('chunks')
  }

  private emit(m: MeshBuilder, i: number, attr: Float32Array): number {
    const q = i * STRIDE
    const t = this.tin
    return m.vertex(t.x[i], t.y[i], t.z[i], attr[q], attr[q + 1], attr[q + 2], attr[q + 3], attr[q + 4], attr[q + 5], attr[q + 6], attr[q + 7], attr[q + 8], attr[q + 9], attr[q + 10])
  }

  finish(extra: Partial<BuildStats> = {}): Built {
    let triangles = 0, vertices = 0, bytes = 0
    const chunks = this.chunks.map((mesh, i) => {
      triangles += mesh.triangles
      vertices += mesh.nv
      bytes += mesh.bytes
      return { name: CHUNKS[i], mesh, cull: i !== FAR_CHUNK }
    })
    const stats: BuildStats = {
      terrainTriangles: this.tin ? this.tin.tris.length / 3 : 0,
      terrainVertices: this.tin ? this.tin.count : 0,
      treeCount: 0, treeTriangles: 0, landmarkTriangles: 0,
      triangles, vertices, bytes,
      chunks: chunks.map((c) => ({ name: c.name, triangles: c.mesh.triangles, vertices: c.mesh.nv })),
      ms: this.ms,
      meshScale: this.tin ? this.tin.scale : 0,
      ...extra,
    }
    return { chunks, stats, rail: this.plan ? this.plan.rail : null }
  }
}

/** The stages of a build, in order; each returns nothing and leaves its work on the builder. */
function stages(b: GorgeBuilder, opts: BuildOptions, extra: Partial<BuildStats>): (() => void)[] {
  const lm = { detail: opts.terrainDetail }
  return [
    () => { b.plan = planLandmarks(b, lm); b.lap('plan') },
    () => b.buildTerrain(),
    () => {
      const trees = addTrees(b, opts.treeCount, opts.terrainDetail >= 0.95 ? 2 : opts.terrainDetail >= 0.7 ? 1 : 0)
      extra.treeCount = trees.count
      extra.treeTriangles = trees.triangles
      b.lap('trees')
    },
    () => { extra.landmarkTriangles = addLandmarks(b, b.plan!, lm); b.lap('landmarks') },
  ]
}

/** Build everything in one go (blocks for a few hundred milliseconds). */
export function buildGorge(opts: BuildOptions): Built {
  const b = new GorgeBuilder(opts)
  const extra: Partial<BuildStats> = {}
  for (const stage of stages(b, opts, extra)) stage()
  return b.finish(extra)
}

/** The same build, giving the browser a turn between stages so a loading screen stays alive. */
export async function buildGorgeAsync(opts: BuildOptions): Promise<Built> {
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  await pause()
  const b = new GorgeBuilder(opts)
  const extra: Partial<BuildStats> = {}
  for (const stage of stages(b, opts, extra)) {
    await pause()
    stage()
  }
  return b.finish(extra)
}
