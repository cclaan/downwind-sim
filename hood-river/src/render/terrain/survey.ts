/**
 * What the builder needs to know about the place before it spends triangles and trees:
 * how far a point is from water a rider can be on, whether it can be seen from there and
 * how squarely (a cliff across the river fills the view; a bench top seen edge-on is a line),
 * where the skyline runs, and how high the face a point stands on is. Coarse grids over the
 * level data, computed once at load.
 */
import { LEVEL } from '../../sim/level'
import { RECT, type TerrainField } from './field'
import { clamp, smoothstep } from './noise'

export interface SurveyGrid {
  x0: number
  z0: number
  step: number
  nx: number
  nz: number
  data: Float32Array
}

function grid(step: number): SurveyGrid {
  const nx = Math.round((RECT.x1 - RECT.x0) / step) + 1
  const nz = Math.round((RECT.z1 - RECT.z0) / step) + 1
  return { x0: RECT.x0, z0: RECT.z0, step, nx, nz, data: new Float32Array(nx * nz) }
}

export function sample(g: SurveyGrid, x: number, z: number): number {
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

/** separable 1-4-6-4-1 blur, `passes` times */
function blurGrid(g: SurveyGrid, passes: number): void {
  const { nx, nz, data } = g
  const tmp = new Float32Array(data.length)
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < nz; j++) {
      const row = j * nx
      for (let i = 0; i < nx; i++) {
        const a = data[row + Math.max(0, i - 2)], b = data[row + Math.max(0, i - 1)]
        const d = data[row + Math.min(nx - 1, i + 1)], e = data[row + Math.min(nx - 1, i + 2)]
        tmp[row + i] = (a + e + 4 * (b + d) + 6 * data[row + i]) * 0.0625
      }
    }
    for (let j = 0; j < nz; j++) {
      const j0 = Math.max(0, j - 2) * nx, j1 = Math.max(0, j - 1) * nx, j2 = j * nx
      const j3 = Math.min(nz - 1, j + 1) * nx, j4 = Math.min(nz - 1, j + 2) * nx
      for (let i = 0; i < nx; i++) {
        data[j2 + i] = (tmp[j0 + i] + tmp[j4 + i] + 4 * (tmp[j1 + i] + tmp[j3 + i]) + 6 * tmp[j2 + i]) * 0.0625
      }
    }
  }
}

/** radius over which a face's rim and foot are looked for (m) */
const FACE_REACH = 150
/** depth below the line of sight given to ground no ray reached (m) */
const HIDDEN = 400

/** the reach a rider can be on (ground x) */
export const PLAY_X0 = -2900
export const PLAY_X1 = 5300

/** river centreline z at ground x (from the reach table of the place report) */
const CENTRE: readonly (readonly [number, number])[] = [
  [-4320, -350], [-3000, -250], [-1986, -161], [-1487, -146], [-500, -5], [0, 0], [500, -8], [996, -66],
  [1491, -135], [1967, 1], [2398, 254], [2862, 439], [3344, 574], [3815, 733], [4182, 1071], [4533, 1427],
  [4900, 1950], [5300, 2650], [6480, 4300],
]

export function centreZ(x: number): number {
  if (x <= CENTRE[0][0]) return CENTRE[0][1]
  for (let i = 1; i < CENTRE.length; i++) {
    if (x <= CENTRE[i][0]) {
      const a = CENTRE[i - 1], b = CENTRE[i]
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])
    }
  }
  return CENTRE[CENTRE.length - 1][1]
}

export class Survey {
  /** raw land height, 30 m */
  readonly height: SurveyGrid
  /** distance to the nearest shore a rider can come near (m), 30 m grid; larger outside the playable reach */
  readonly shoreDist: SurveyGrid
  /**
   * How far the ground lies below the lowest line of sight from the water (m), 60 m grid:
   * 0 where the ground itself is seen, 20 where only the top of a tree taller than 20 m
   * shows over the rim in front of it.
   */
  readonly hide: SurveyGrid
  /**
   * How squarely the ground faces someone on the water, 60 m grid: the sine of the angle
   * between the ground and the best line of sight to it. Near 1 on a cliff seen from across
   * the river, a few hundredths on a bench or a terrace seen edge-on, 0 where it is hidden.
   */
  readonly graze: SurveyGrid
  /** 1 where the ground can be seen from the water ... 0 where it is well hidden, 60 m grid */
  readonly visible: SurveyGrid
  /** 1 where the ground makes the skyline for someone on the water (rims and ridge tops), 60 m grid */
  readonly skyline: SurveyGrid
  /** highest and lowest ground within FACE_REACH of a point (m), 30 m grid: the rim over a face and its foot */
  readonly rimHeight: SurveyGrid
  readonly footHeight: SurveyGrid
  /** height of the sun's shadow above the river (m), 30 m grid: a point below it is shaded */
  shadow: SurveyGrid
  /** land height blurred over about 75 m, for telling hollows from ridges */
  readonly heightBlur: SurveyGrid

  constructor(readonly field: TerrainField) {
    const h = grid(30)
    for (let j = 0; j < h.nz; j++) {
      const z = h.z0 + j * h.step
      for (let i = 0; i < h.nx; i++) h.data[j * h.nx + i] = LEVEL.landHeight(h.x0 + i * h.step, z)
    }
    this.height = h
    const hb = grid(30)
    hb.data.set(h.data)
    blurGrid(hb, 6)
    this.heightBlur = hb
    this.shoreDist = this.buildShoreDist()
    this.skyline = grid(60)
    this.hide = grid(60)
    this.graze = grid(60)
    this.visible = this.buildVisible()
    this.shadow = grid(30)
    this.rimHeight = grid(30)
    this.footHeight = grid(30)
    this.buildRelief()
  }

  /** running maximum and minimum of the height over a square of half-side FACE_REACH (two separable passes), softened */
  private buildRelief(): void {
    const h = this.height
    const { nx, nz } = h
    const R = Math.round(FACE_REACH / h.step)
    const hi = this.rimHeight.data, lo = this.footHeight.data
    const tmpHi = new Float32Array(nx * nz), tmpLo = new Float32Array(nx * nz)
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let a = -1e9, b = 1e9
        for (let k = Math.max(0, i - R); k <= Math.min(nx - 1, i + R); k++) {
          const v = h.data[j * nx + k]
          if (v > a) a = v
          if (v < b) b = v
        }
        tmpHi[j * nx + i] = a
        tmpLo[j * nx + i] = b
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let a = -1e9, b = 1e9
        for (let k = Math.max(0, j - R); k <= Math.min(nz - 1, j + R); k++) {
          const u = tmpHi[k * nx + i], v = tmpLo[k * nx + i]
          if (u > a) a = u
          if (v < b) b = v
        }
        hi[j * nx + i] = a
        lo[j * nx + i] = b
      }
    }
    blurGrid(this.rimHeight, 1)
    blurGrid(this.footHeight, 1)
  }

  /**
   * Where a point stands on the face it belongs to: `t` 0 at the foot ... 1 at the rim, and
   * `relief` the height of that face (m). On flat ground relief is small and t means nothing.
   */
  face(x: number, z: number, y: number, out: { t: number; relief: number }): void {
    const hi = sample(this.rimHeight, x, z), lo = sample(this.footHeight, x, z)
    const r = hi - lo
    out.relief = r
    out.t = r > 1 ? clamp((y - lo) / r, 0, 1) : 0
  }

  private buildShoreDist(): SurveyGrid {
    const g = grid(30)
    const { nx, nz, data } = g
    const F = this.field
    const land = new Uint8Array(nx * nz)
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) land[j * nx + i] = F.shore(g.x0 + i * 30, g.z0 + j * 30) > 0 ? 1 : 0
    const BIG = 1e9
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        const l = land[k]
        const edge =
          (i > 0 && land[k - 1] !== l) || (i < nx - 1 && land[k + 1] !== l) ||
          (j > 0 && land[k - nx] !== l) || (j < nz - 1 && land[k + nx] !== l)
        if (!edge) { data[k] = BIG; continue }
        const x = g.x0 + i * 30, z = g.z0 + j * 30
        // shores outside the playable reach count as farther away; the Oregon side a little
        const beyond = Math.max(0, PLAY_X0 - x, x - PLAY_X1)
        data[k] = 0.55 * beyond + (z > centreZ(x) ? 40 : 0)
      }
    }
    // two-pass chamfer distance
    const D1 = 30, D2 = 42.43
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        let v = data[k]
        if (i > 0) v = Math.min(v, data[k - 1] + D1)
        if (j > 0) {
          v = Math.min(v, data[k - nx] + D1)
          if (i > 0) v = Math.min(v, data[k - nx - 1] + D2)
          if (i < nx - 1) v = Math.min(v, data[k - nx + 1] + D2)
        }
        data[k] = v
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i
        let v = data[k]
        if (i < nx - 1) v = Math.min(v, data[k + 1] + D1)
        if (j < nz - 1) {
          v = Math.min(v, data[k + nx] + D1)
          if (i < nx - 1) v = Math.min(v, data[k + nx + 1] + D2)
          if (i > 0) v = Math.min(v, data[k + nx - 1] + D2)
        }
        data[k] = v
      }
    }
    return g
  }

  /**
   * Sweep sight lines out from points on the water (eye 10 m up: the highest camera). Along
   * each ray the running skyline angle says how far below the line of sight every cell lies;
   * the least of those over all rays is kept, so a cell is "seen" if any place on the water
   * sees it, and a tree on it shows by as much as it stands above that depth.
   */
  private buildVisible(): SurveyGrid {
    const v = grid(60)
    const hide = this.hide
    const h = this.height
    const F = this.field
    const graze = this.graze.data
    const EYE = 10
    const RAYS = 128
    hide.data.fill(HIDDEN)
    // ground gradient on the height grid, for the angle the ground makes with a line of sight
    const gx = new Float32Array(h.nx * h.nz), gz = new Float32Array(h.nx * h.nz)
    for (let j = 0; j < h.nz; j++) {
      const j0 = Math.max(0, j - 1) * h.nx, j1 = Math.min(h.nz - 1, j + 1) * h.nx
      for (let i = 0; i < h.nx; i++) {
        gx[j * h.nx + i] = (h.data[j * h.nx + Math.min(h.nx - 1, i + 1)] - h.data[j * h.nx + Math.max(0, i - 1)]) / 60
        gz[j * h.nx + i] = (h.data[j1 + i] - h.data[j0 + i]) / 60
      }
    }
    for (let x = PLAY_X0 + 100; x <= PLAY_X1; x += 620) {
      for (let z = -1150; z <= 2700; z += 290) {
        if (F.shore(x, z) > -0.9 || LEVEL.waterDepth(x, z) < 0.5) continue
        for (let a = 0; a < RAYS; a++) {
          const th = ((a + 0.5) / RAYS) * Math.PI * 2
          const cx = Math.cos(th), cz = Math.sin(th)
          let maxAng = -1
          let last = -1
          for (let d = 45; d < 7000; d += d < 1500 ? 30 : 75) {
            const px = x + cx * d, pz = z + cz * d
            if (px < RECT.x0 || px > RECT.x1 || pz < RECT.z0 || pz > RECT.z1) break
            // nearest sample of the 30 m grid: the rays step no finer than that
            const g = Math.round((pz - h.z0) / 30) * h.nx + Math.round((px - h.x0) / 30)
            const hh = h.data[g]
            const k = Math.round((pz - v.z0) / 60) * v.nx + Math.round((px - v.x0) / 60)
            const ang = (hh - EYE) / d
            const below = ang >= maxAng ? 0 : EYE + maxAng * d - hh
            if (below < hide.data[k]) hide.data[k] = below
            if (below < 2) {
              // unit vector to the eye, dotted with the ground's unit normal
              const sx = gx[g], sz = gz[g]
              const dy = EYE - hh
              const sin = (sx * cx * d + dy + sz * cz * d) / (Math.sqrt(d * d + dy * dy) * Math.sqrt(1 + sx * sx + sz * sz))
              if (sin > graze[k]) graze[k] = sin
            }
            if (ang > maxAng) {
              maxAng = ang
              if (hh > 2) last = k
            }
          }
          if (last >= 0) this.skyline.data[last] = 1
        }
      }
    }
    // rays spread with distance: a cell no ray crossed takes the least of its neighbours
    const { nx, nz } = v
    const tmp = new Float32Array(nx * nz)
    for (let pass = 0; pass < 2; pass++) {
      const src = hide.data
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          let m = src[j * nx + i]
          if (m >= HIDDEN) {
            for (let dj = -1; dj <= 1; dj++) {
              const jj = clamp(j + dj, 0, nz - 1)
              for (let di = -1; di <= 1; di++) m = Math.min(m, src[jj * nx + clamp(i + di, 0, nx - 1)] + 4)
            }
          }
          tmp[j * nx + i] = m
        }
      }
      src.set(tmp)
    }
    blurGrid(hide, 1)
    // the angle: fill cells the rays missed from their neighbours, then soften
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let m = 0
        for (let dj = -1; dj <= 1; dj++) {
          const jj = clamp(j + dj, 0, nz - 1)
          for (let di = -1; di <= 1; di++) m = Math.max(m, graze[jj * nx + clamp(i + di, 0, nx - 1)])
        }
        tmp[j * nx + i] = Math.max(graze[j * nx + i], 0.7 * m)
      }
    }
    graze.set(tmp)
    blurGrid(this.graze, 1)
    for (let k = 0; k < nx * nz; k++) v.data[k] = 1 - smoothstep(3, 22, hide.data[k])
    // the skyline marks: spread each over its neighbours
    const sk = this.skyline.data
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let m = 0
        for (let dj = -1; dj <= 1; dj++) {
          const jj = clamp(j + dj, 0, nz - 1)
          for (let di = -1; di <= 1; di++) m = Math.max(m, sk[jj * nx + clamp(i + di, 0, nx - 1)])
        }
        tmp[j * nx + i] = m
      }
    }
    sk.set(tmp)
    return v
  }

  /** raw land height at a point (m) */
  heightAt(x: number, z: number): number {
    return sample(this.height, x, z)
  }

  /** 0..1: the ground here makes the skyline from somewhere on the water */
  skylineAt(x: number, z: number): number {
    return sample(this.skyline, x, z)
  }

  /** 0..1: how much of something `tall` metres high standing at a point shows from the water */
  seen(x: number, z: number, tall: number): number {
    const d = sample(this.hide, x, z)
    return d <= 0 ? 1 : clamp(1 - d / Math.max(1, tall), 0, 1)
  }

  /**
   * Sun shadows over the heightfield in one sweep: the shadow's upper surface at a cell is
   * the higher of the ground there and the shadow surface one step up-sun, lowered by the
   * step times the tangent of the sun's elevation.
   */
  castShadows(sx: number, sy: number, sz: number): void {
    const g = this.shadow
    const h = this.height
    const { nx, nz, data } = g
    const horiz = Math.hypot(sx, sz)
    if (sy <= 0.02 || horiz < 1e-4) {
      // sun overhead or below the horizon: no cast shadows / everything in shade
      for (let k = 0; k < data.length; k++) data[k] = sy <= 0.02 ? 1e6 : h.data[k]
      return
    }
    const tanEl = sy / horiz
    const ux = sx / horiz, uz = sz / horiz // toward the sun
    if (Math.abs(ux) >= Math.abs(uz)) {
      // march along x: the up-sun neighbour is the previous column in the sweep
      const dir = ux > 0 ? -1 : 1 // sweep away from the sun
      const stepLen = 30 / Math.abs(ux)
      const dz = (uz / Math.abs(ux)) * 1 // rows per column toward the sun
      for (let n = 0; n < nx; n++) {
        const i = dir > 0 ? n : nx - 1 - n
        const ip = i - dir
        for (let j = 0; j < nz; j++) {
          const k = j * nx + i
          let s = h.data[k]
          if (ip >= 0 && ip < nx) {
            const fj = clamp(j + dz, 0, nz - 1)
            const j0 = Math.min(nz - 2, fj | 0)
            const t = fj - j0
            const up = data[j0 * nx + ip] * (1 - t) + data[(j0 + 1) * nx + ip] * t
            s = Math.max(s, up - stepLen * tanEl)
          }
          data[k] = s
        }
      }
    } else {
      const dir = uz > 0 ? -1 : 1
      const stepLen = 30 / Math.abs(uz)
      const dx = ux / Math.abs(uz)
      for (let n = 0; n < nz; n++) {
        const j = dir > 0 ? n : nz - 1 - n
        const jp = j - dir
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i
          let s = h.data[k]
          if (jp >= 0 && jp < nz) {
            const fi = clamp(i + dx, 0, nx - 1)
            const i0 = Math.min(nx - 2, fi | 0)
            const t = fi - i0
            const up = data[jp * nx + i0] * (1 - t) + data[jp * nx + i0 + 1] * t
            s = Math.max(s, up - stepLen * tanEl)
          }
          data[k] = s
        }
      }
    }
  }

  /**
   * 0 in full shadow ... 1 in full sun, for a point `above` metres over the ground (a tree
   * top can stand in the light while its foot is shaded).
   */
  sunlit(x: number, z: number, above: number): number {
    if (x < RECT.x0 || x > RECT.x1 || z < RECT.z0 || z > RECT.z1) return 1
    const depth = sample(this.shadow, x, z) - sample(this.height, x, z)
    return smoothstep(0, 1, 1 - (depth - above) / 6)
  }

  /** metres the ground lies below its surroundings: positive in draws and at the foot of walls */
  hollow(x: number, z: number): number {
    return sample(this.heightBlur, x, z) - sample(this.height, x, z)
  }

  /**
   * How many times coarser the mesh is drawn where the ground is hidden from the water or
   * seen edge-on (bench tops, flats well back from the shore). Small budgets need more.
   */
  coarsen = 2.6

  /** target edge length of the terrain mesh at a point (m), before the tier's scale */
  edgeLength(x: number, z: number): number {
    const d = sample(this.shoreDist, x, z)
    let L = 7 + 0.075 * d
    // faces a rider looks at squarely get the triangles; ground seen edge-on or not at all needs few
    const facing = smoothstep(0.04, 0.3, sample(this.graze, x, z))
    L *= 1 + (this.coarsen - 1) * (1 - facing) * smoothstep(50, 200, d)
    const s = this.field.slope(x, z)
    L *= 1 - 0.3 * smoothstep(0.45, 1.0, s)
    return L
  }
}
