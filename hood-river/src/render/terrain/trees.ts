/**
 * Trees, merged into the terrain's draw calls as plain cones and blobs with baked light.
 *
 * Where they stand comes from the land cover (cover.ts) at the place report's densities:
 * closed fir on the Oregon side, firs in the Washington draws and on the upper wall, a
 * wooded bluff behind the Hatchery and along the Underwood face, oak clumps and single pines
 * on the grass, oak and pine woodland on the Bingen bluff, grey snags in the Tunnel 5 burn,
 * tall firs and cottonwoods on the Hatchery terrace, cottonwood on Wells Island.
 *
 * There are far more real trees than any phone can draw, so the tier's budget is spent in
 * order of what a rider looks at:
 *   1. the Hatchery terrace gets every tree its rule asks for, on every tier (the closed stand
 *      of tall firs behind the launch is what the place is known by);
 *   2. the rest is shared out by weight: the bluff behind the launch first, then rims that
 *      make the skyline, faces seen squarely from the water and the first rows behind any
 *      shore along the whole run; ground that is hidden or seen edge-on gets next to nothing.
 * Where the share is short the trees that are drawn grow into clumps that stand for several
 * (only at a distance: near the water a tree keeps its own shape).
 *
 * Level of detail is fixed at build time by distance from the water a rider can be on:
 * trunk and three stacked cones near the bank, two cones farther off, a single pyramid beyond.
 */
import { PAL, makeCover, type Rgb } from './cover'
import type { GorgeBuilder } from './build'
import type { MeshBuilder } from './geometry'
import { fbm, hash2, smoothstep, clamp } from './noise'
import { PLAY_X0, PLAY_X1, sample } from './survey'
import { RECT } from './field'
import { clearOfBuildings } from './landmarks'

const SPECIES = { FIR: 0, PINE: 1, OAK: 2, COTTONWOOD: 3, MAPLE: 4, WILLOW: 5, SNAG: 6, RUST: 7 } as const
const KINDS = 8

/** crown albedos (linear) */
const TREE_COL: Rgb[] = [
  [0.062, 0.1, 0.057], // fir
  [0.095, 0.136, 0.067], // pine
  [0.105, 0.13, 0.062], // oak
  [0.185, 0.245, 0.105], // cottonwood
  [0.118, 0.185, 0.07], // maple
  [0.2, 0.255, 0.118], // willow
  [0.172, 0.158, 0.14], // snag: weathered grey, #6B6660 once lit
  [0.19, 0.135, 0.09], // dead, leaves or needles still on: dull brown
]
/** typical height of each kind (m), for judging how much of one shows over a rim */
const TALL = [30, 22, 9, 17, 12, 5, 16, 14]

/**
 * Trees per hectare on the Hatchery terrace (the place report's 20 to 30 firs and pines, with
 * maple between them and cottonwood and willow at the water). From the water this is a tree
 * every four or five metres of shore: a closed stand.
 */
const TERRACE = { fir: 13, pine: 7, maple: 7, cottonwood: 12, willow: 8 }
/** the stretch of terrace the launch looks back at carries a denser grove */
const GROVE_X0 = -420, GROVE_X1 = 520, GROVE = 1.6
/**
 * The terrace is filled before anything else, but may take at most this share of a tier's
 * budget (about 390 of the low tier's 3,000 trees; the higher tiers get every tree).
 */
const TERRACE_SHARE = 0.13

/** the reach a run covers, start to bridge (ground x): trees here count in full */
const RUN_X0 = -700, RUN_X1 = 4500

const CELL = 30
const TWO_PI = Math.PI * 2

export interface TreeStats { count: number; triangles: number }

/**
 * `level` is the tier: 0 (low) draws nothing finer than two cones and turns to single
 * three-sided pyramids 240 m from the water; 1 (mid) keeps the full shape within 170 m;
 * 2 (high) within 320 m. `record` is told about every tree placed (for maps and counts).
 */
export function addTrees(gb: GorgeBuilder, budget: number, level = 2, record?: (sp: number, x: number, z: number) => void): TreeStats {
  const F = gb.field, S = gb.survey
  const nx = Math.floor((RECT.x1 - RECT.x0) / CELL), nz = Math.floor((RECT.z1 - RECT.z0) / CELL)
  // per cell: true number of trees of each kind, and the weight of the cell (-1: draw them all)
  const dens = new Float32Array(nx * nz * KINDS)
  const weight = new Float32Array(nx * nz)
  const cov = makeCover()
  const ha = (CELL * CELL) / 10000
  let terraceTotal = 0
  for (let j = 0; j < nz; j++) {
    const z = RECT.z0 + (j + 0.5) * CELL
    for (let i = 0; i < nx; i++) {
      const x = RECT.x0 + (i + 0.5) * CELL
      if (F.outside(x, z) > -60 || F.shore(x, z) < 0.25) continue
      // ground no one on the water can see a tree on is not worth looking at; ground seen only
      // edge-on, well back from any shore, carries so few that one cell in three stands for it
      if (S.seen(x, z, 34) <= 0) continue
      const shoreD = sample(S.shoreDist, x, z)
      let thin = 1
      if (shoreD > 200 && sample(S.graze, x, z) < 0.02 && sample(S.skyline, x, z) < 0.05) {
        if (hash2(i, j, 900) > 0.34) continue
        thin = 1 / 0.34
      }
      const slope = F.slope(x, z)
      const y = sample(S.height, x, z)
      // zeros for the normal: the cover takes the downhill direction from the data, so talus is found
      gb.cover.at(x, z, y, slope, 0, 0, cov)
      const k = (j * nx + i) * KINDS
      // nothing on the cliffs or the scree (the apron under a rim cliff is gentler than the data's slope says)
      const open = Math.max(1 - smoothstep(0.85, 1.2, slope), cov.apron) * (1 - cov.talus)
      const wash = cov.side < 0
      // closed canopy
      const con = cov.conifer * open * 120
      if (wash) {
        dens[k + SPECIES.FIR] += con * 0.55
        dens[k + SPECIES.PINE] += con * 0.45
        // oak and maple under and between them
        dens[k + SPECIES.OAK] += cov.conifer * open * 28
        dens[k + SPECIES.MAPLE] += cov.conifer * open * 14
      } else {
        // bigleaf maple along the foot of the slope, fir above
        const low = 1 - smoothstep(10, 45, y)
        dens[k + SPECIES.FIR] += con * (1 - 0.5 * low)
        dens[k + SPECIES.MAPLE] += con * 0.5 * low
      }
      // savanna: oak clumps and single pines on the grass
      dens[k + SPECIES.OAK] += cov.savanna * open * (1 - cov.burn) * 11
      dens[k + SPECIES.PINE] += cov.savanna * open * (1 - cov.burn) * 3.5
      // oak and pine woodland on the dry bluff faces
      dens[k + SPECIES.OAK] += cov.oakwood * open * 46
      dens[k + SPECIES.PINE] += cov.oakwood * open * 13
      // the burn, three summers on: most of what stood there is a grey snag, a few dead
      // trees still hold brown leaves, and the oak and maple have come back from the root
      if (cov.burn > 0) {
        const b = cov.burn
        const fir = dens[k + SPECIES.FIR], pine = dens[k + SPECIES.PINE], oak = dens[k + SPECIES.OAK], maple = dens[k + SPECIES.MAPLE]
        const stand = fir + pine + 0.4 * (oak + maple) + b * open * 14
        dens[k + SPECIES.FIR] = fir * (1 - 0.7 * b)
        dens[k + SPECIES.PINE] = pine * (1 - 0.7 * b)
        dens[k + SPECIES.OAK] = oak * (1 - 0.25 * b)
        dens[k + SPECIES.MAPLE] = maple * (1 - 0.25 * b)
        dens[k + SPECIES.SNAG] += stand * b * 0.42
        dens[k + SPECIES.RUST] += stand * b * 0.06
      }
      // the Hatchery terrace
      let terrace = 0
      if (wash && y < 19 && x > -520 && x < 1500 && slope < 0.3) {
        const park = smoothstep(-520, -380, x) * smoothstep(1500, 1300, x)
        // more of them toward the water, where they stand in front of everything else;
        // few on the lawn where the sails are rigged
        const front = 0.55 + 0.9 * smoothstep(260, 40, shoreD)
        const rigging = x > -190 && x < 80 && z > -615 ? 0.3 : 1
        // they stand in groves with open grass between, not as a plantation
        const stand = 0.45 + 1.1 * smoothstep(0.36, 0.62, fbm(x / 55 + 3.1, z / 55 - 6.4, 2, 913))
        const grove = (1 + (GROVE - 1) * smoothstep(GROVE_X0 - 80, GROVE_X0, x) * smoothstep(GROVE_X1 + 80, GROVE_X1, x)) * front * rigging * stand
        dens[k + SPECIES.FIR] += park * grove * TERRACE.fir
        dens[k + SPECIES.PINE] += park * grove * TERRACE.pine
        dens[k + SPECIES.MAPLE] += park * grove * TERRACE.maple
        const edge = 1 - smoothstep(20, 75, shoreD)
        dens[k + SPECIES.COTTONWOOD] += park * edge * rigging * TERRACE.cottonwood
        dens[k + SPECIES.WILLOW] += park * edge * rigging * TERRACE.willow
        terrace = park
      }
      // riparian strips and Wells Island
      dens[k + SPECIES.COTTONWOOD] += cov.riparian * open * 70
      dens[k + SPECIES.WILLOW] += cov.riparian * open * 30
      // towns: street and yard trees
      dens[k + SPECIES.MAPLE] += cov.town * 9
      dens[k + SPECIES.FIR] += cov.town * 5
      // sand, gravel and riprap grow nothing
      const bare = 1 - Math.max(cov.sand, 0.8 * cov.gravel, cov.riprap)
      let total = 0, tall = 0
      for (let s = 0; s < KINDS; s++) {
        dens[k + s] *= ha * bare
        total += dens[k + s]
        tall += dens[k + s] * TALL[s]
      }
      if (total <= 0) continue
      if (terrace > 0.5) {
        weight[j * nx + i] = -1
        terraceTotal += total
        continue
      }
      // ---- what the cell is worth from the water ----
      // how much of a tree standing here shows over whatever is in front of it
      const seen = S.seen(x, z, tall / total)
      if (seen <= 0) continue
      const rim = sample(S.skyline, x, z)
      // faces seen squarely, the skyline, and the first rows behind any shore count in full;
      // ground seen edge-on (bench tops, flats) hides its trees behind one another
      const facing = Math.max(smoothstep(0.03, 0.22, sample(S.graze, x, z)), rim, smoothstep(170, 60, shoreD))
      const near = 1 / (1 + shoreD / 600)
      // the run itself in full, the wall a rider starts under up-river a little less, the ends least
      const reach = x < PLAY_X0 || x > PLAY_X1 ? 0.2 : x < RUN_X0 ? 0.55 + 0.45 * smoothstep(RUN_X0 - 500, RUN_X0, x) : x > RUN_X1 ? 0.6 : 1
      // the wooded face of the bluff behind the launch is the backdrop of every start
      const bluff = wash && x > -800 && x < 1150 ? 1 + 5 * smoothstep(-800, -600, x) * smoothstep(1150, 950, x) * smoothstep(520, 330, shoreD) : 1
      // the Oregon bank is a kilometre off for most of a run, but its cliff is the other wall
      // of the picture: the trees on its rim count double and the wooded apron under it, which
      // faces the rider for the whole run, more again. Wells Island is passed close by.
      const island = !wash && x > 970 && x < 2170 && z > 330 && z < 800 && cov.riparian > 0.3
      const cliff = !wash && x > -2700 && x < 2400 && shoreD < 260
      const far = wash ? 1 : island ? 3 : cliff ? (cov.apron > 0.3 ? 3.4 : 1.7) : 0.8
      // stands are never even: groves and gaps, so a rim does not carry a picket fence
      const grove = 0.35 + 1.3 * smoothstep(0.36, 0.64, fbm(x / 85, z / 85, 2, 912))
      weight[j * nx + i] = seen * (0.03 + facing) * (0.12 + near * near * 1.7 + 1.2 * rim * near) * reach * bluff * far * grove * thin
    }
  }

  // ---- share out the budget: the terrace in full, the rest n = min(true, k * weight * true) ----
  const terraceShare = terraceTotal > 0 ? Math.min(1, (TERRACE_SHARE * budget) / terraceTotal) : 0
  const rest = Math.max(0, budget - terraceTotal * terraceShare)
  // the cells that take part in the share-out, packed: true count and weight
  const packT: number[] = [], packW: number[] = []
  for (let c = 0; c < nx * nz; c++) {
    const w = weight[c]
    if (w <= 0) continue
    let t = 0
    for (let s = 0; s < KINDS; s++) t += dens[c * KINDS + s]
    packT.push(t)
    packW.push(w)
  }
  const expected = (k: number) => {
    let sum = 0
    for (let c = 0; c < packT.length; c++) sum += packT[c] * Math.min(1, k * packW[c])
    return sum
  }
  let lo = 0, hi = 4
  while (expected(hi) < rest && hi < 65536) hi *= 2
  for (let it = 0; it < 34; it++) {
    const mid = (lo + hi) / 2
    if (expected(mid) < rest) lo = mid
    else hi = mid
  }
  const k = (lo + hi) / 2

  const w = new TreeWriter(gb, level)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      const wt = weight[c]
      if (wt === 0) continue
      let total = 0
      for (let s = 0; s < KINDS; s++) total += dens[c * KINDS + s]
      const share = wt < 0 ? terraceShare : Math.min(1, k * wt)
      const want = total * share
      let n = Math.floor(want)
      if (hash2(i, j, 901) < want - n) n++
      if (n === 0) continue
      // thinned stands grow into clumps
      const clump = clamp(Math.pow(1 / share, 0.3), 1, 2.1)
      for (let t = 0; t < n; t++) {
        const x = RECT.x0 + (i + hash2(i * 7 + t, j, 902)) * CELL
        const z = RECT.z0 + (j + hash2(i, j * 7 + t, 903)) * CELL
        if (F.shore(x, z) < 0.3) continue
        // pick a kind in proportion
        let pick = hash2(i * 13 + t, j * 11, 904) * total
        let sp = 0
        for (; sp < KINDS - 1; sp++) {
          pick -= dens[c * KINDS + sp]
          if (pick <= 0) break
        }
        const before = w.count
        w.tree(sp, x, z, clump, hash2(i * 17 + t, j * 19, 905), hash2(i * 23 + t, j * 29, 906), wt < 0)
        if (record && w.count > before) record(sp, x, z)
      }
    }
  }
  return { count: w.count, triangles: w.triangles }
}

class TreeWriter {
  count = 0
  triangles = 0
  private lit = { sun: 0, sky: 0, bounce: 0 }

  private readonly lean: boolean
  /** distance from the water within which a tree gets its full shape, and its two-cone shape (m) */
  private readonly full: number
  private readonly half: number

  constructor(private gb: GorgeBuilder, level: number) {
    this.lean = level < 1
    this.full = level >= 2 ? 320 : level >= 1 ? 170 : 0
    this.half = level >= 2 ? 1050 : level >= 1 ? 700 : 240
  }

  tree(sp: number, x: number, z: number, clump: number, r1: number, r2: number, grove: boolean): void {
    const gb = this.gb
    const natural = gb.field.elev(x, z)
    if (natural < 0.3) return
    // not on a road or railway bench, nor on the bank cut beside one; not through a roof or a row of vans
    if (gb.field.cutAt(x, z) < natural + 5) return
    if (!clearOfBuildings(x, z)) return
    // rooted in the ground as it is drawn
    const base = gb.ground(x, z)
    const d = sample(gb.survey.shoreDist, x, z)
    // the full shape near the water, two cones farther off, a single pyramid beyond
    const lod = d < this.full ? 0 : d < this.half ? 1 : 2
    const shape = lod
    // a trunk under anything near enough to see daylight beneath its crown
    const trunk = shape === 0 || (shape === 1 && d < 260)
    const m = gb.chunks[gb.chunkAt(x, z)]
    const before = m.triangles
    const tone = 0.82 + 0.36 * r2
    const col = TREE_COL[sp]
    const cr = col[0] * tone, cg = col[1] * tone * (0.96 + 0.08 * r1), cb = col[2] * tone
    const y0 = base - 0.4
    // a clump stands for several trees, but only where it is too far off to be told from one
    clump = Math.min(clump, d < 150 ? 1.12 : d < 320 ? 1.35 : d < 600 ? 1.7 : 2.1)
    const wide = lod === 2 ? clump * 1.2 : clump
    // sides of the single pyramid a far tree is drawn as (three on the low tier: a triangle a tree)
    const far = this.lean ? 3 : 4
    const tall = 1 + 0.25 * (clump - 1)
    const rot = r1 * TWO_PI
    switch (sp) {
      case SPECIES.FIR: {
        // mostly 18 to 30 m with a few giants; the terrace firs are the old ones, 27 to 42 m
        const h = (grove ? 27 + 15 * r1 * r1 : 17 + 25 * Math.pow(r1, 1.6)) * tall
        const r = h * 0.145 * wide
        if (trunk) this.trunk(m, x, z, y0, y0 + 0.4 * h, Math.max(0.45, h * 0.017))
        if (shape === 0) {
          this.cone(m, x, z, y0 + 0.13 * h, y0 + 0.62 * h, r, 6, rot, cr, cg, cb, 0.62, y0)
          this.cone(m, x, z, y0 + 0.37 * h, y0 + 0.83 * h, r * 0.72, 6, rot + 0.5, cr, cg, cb, 0.8, y0)
          this.cone(m, x, z, y0 + 0.6 * h, y0 + h, r * 0.45, 5, rot + 1.1, cr, cg, cb, 1, y0)
        } else if (shape === 1) {
          this.cone(m, x, z, y0 + (trunk ? 0.12 : 0.06) * h, y0 + 0.7 * h, r, 5, rot, cr, cg, cb, 0.7, y0)
          this.cone(m, x, z, y0 + 0.45 * h, y0 + h, r * 0.6, 4, rot + 0.6, cr, cg, cb, 1, y0)
        } else this.cone(m, x, z, y0, y0 + h, r, far, rot, cr, cg, cb, 0.85, y0)
        break
      }
      case SPECIES.PINE: {
        // ponderosa: a long bare trunk under a rounder crown
        const h = (grove ? 22 + 10 * r1 : 17 + 11 * r1) * tall
        const r = h * 0.2 * wide
        if (trunk) this.trunk(m, x, z, y0, y0 + 0.6 * h, Math.max(0.45, h * 0.02))
        if (shape === 0) {
          this.cone(m, x, z, y0 + 0.38 * h, y0 + 0.8 * h, r, 6, rot, cr, cg, cb, 0.75, y0)
          this.cone(m, x, z, y0 + 0.6 * h, y0 + h, r * 0.7, 5, rot + 0.8, cr, cg, cb, 1, y0)
        } else if (shape === 1) {
          this.cone(m, x, z, y0 + (trunk ? 0.36 : 0.3) * h, y0 + h, r, 5, rot, cr, cg, cb, 0.9, y0)
        } else this.cone(m, x, z, y0 + 0.2 * h, y0 + h, r, far, rot, cr, cg, cb, 0.85, y0)
        break
      }
      case SPECIES.OAK:
      case SPECIES.MAPLE:
      case SPECIES.COTTONWOOD:
      case SPECIES.WILLOW: {
        const h = (sp === SPECIES.OAK ? 6.5 + 5 * r1 : sp === SPECIES.MAPLE ? 9 + 6 * r1 : sp === SPECIES.COTTONWOOD ? 13 + 9 * r1 : 3.5 + 3 * r1) * tall
        const aspect = sp === SPECIES.OAK ? 0.6 : sp === SPECIES.MAPLE ? 0.5 : sp === SPECIES.COTTONWOOD ? 0.36 : 0.85
        const r = h * aspect * Math.min(wide, 1.6)
        // crowns start low: a bushy mass, not a ball on a stick
        const low = sp === SPECIES.COTTONWOOD ? 0.14 : 0.04
        if (trunk && sp === SPECIES.COTTONWOOD) this.trunk(m, x, z, y0, y0 + 0.4 * h, h * 0.03)
        if (shape === 0) this.blob(m, x, z, y0 + low * h, y0 + 0.42 * h, y0 + h, r * 0.78, r, 6, rot, cr, cg, cb, y0, true)
        else if (shape === 1) this.blob(m, x, z, y0 + low * h, y0 + 0.42 * h, y0 + h, r * 0.78, r, this.lean ? 4 : 5, rot, cr, cg, cb, y0, false)
        else this.cone(m, x, z, y0, y0 + h * 0.9, r, far, rot, cr, cg, cb, 0.8, y0)
        break
      }
      default: {
        const h = 11 + 12 * r1
        if (sp === SPECIES.RUST && r2 > 0.5) {
          // an oak or maple that died with its leaves on
          const hh = (7 + 6 * r1) * tall
          const r = hh * 0.42 * Math.min(wide, 1.4)
          if (shape === 0) this.blob(m, x, z, y0 + 0.05 * hh, y0 + 0.45 * hh, y0 + hh, r * 0.75, r, 6, rot, cr, cg, cb, y0, true)
          else if (shape === 1) this.blob(m, x, z, y0 + 0.05 * hh, y0 + 0.45 * hh, y0 + hh, r * 0.75, r, this.lean ? 4 : 5, rot, cr, cg, cb, y0, false)
          else this.cone(m, x, z, y0, y0 + hh * 0.9, r, far, rot, cr, cg, cb, 0.8, y0)
        } else if (sp === SPECIES.RUST) {
          // a conifer still holding its dead needles
          const hh = h * tall
          const w2 = Math.min(wide, 1.4)
          if (shape === 0) {
            this.cone(m, x, z, y0 + 0.12 * hh, y0 + 0.7 * hh, hh * 0.13 * w2, 5, rot, cr, cg, cb, 0.75, y0)
            this.cone(m, x, z, y0 + 0.45 * hh, y0 + hh, hh * 0.09 * w2, 4, rot + 0.7, cr, cg, cb, 1, y0)
          } else this.cone(m, x, z, y0 + 0.1 * hh, y0 + hh, hh * 0.13 * w2, 4, rot, cr, cg, cb, 0.9, y0)
        } else {
          // a snag: a bare grey spar, a little stouter with distance so it does not thin to nothing
          const r = lod === 0 ? Math.max(0.42, h * 0.032) : lod === 1 ? Math.max(0.8, h * 0.055) : Math.max(1.3, h * 0.085)
          this.cone(m, x, z, y0, y0 + h, r, 3, rot, cr, cg, cb, 1, y0)
          if (shape === 0) {
            // a broken limb or two
            const a = rot + 2.1
            this.cone(m, x + Math.cos(a) * h * 0.1, z + Math.sin(a) * h * 0.1, y0 + 0.42 * h, y0 + 0.62 * h, h * 0.02, 3, rot, cr, cg, cb, 1, y0)
          }
        }
      }
    }
    this.count++
    this.triangles += m.triangles - before
  }

  /** light for a foliage point with outward normal (nx, ny, nz) at height y */
  private shade(x: number, z: number, y: number, ground: number, nx: number, ny: number, nz: number, ao: number): void {
    const gb = this.gb
    gb.light(x, z, y - ground, nx, ny, nz, ao, this.lit)
    // leaves pass a little light round the edge of the crown
    const s = gb.sun
    const wrap = (nx * s.x + ny * s.y + nz * s.z + 0.3) / 1.3
    if (wrap > 0) this.lit.sun = Math.max(this.lit.sun, wrap * gb.survey.sunlit(x, z, y - ground) * 0.9)
  }

  /** a cone of foliage: ring at y0, tip at y1 */
  private cone(
    m: MeshBuilder, x: number, z: number, y0: number, y1: number, r: number, sides: number, rot: number,
    cr: number, cg: number, cb: number, tip: number, ground: number,
  ): void {
    const lit = this.lit
    const slant = r / Math.max(0.1, y1 - y0)
    const inv = 1 / Math.hypot(1, slant)
    this.shade(x, z, y1, ground, 0, 1, 0, 1)
    // the tip takes the light of the side that faces the sun, so it does not go dark
    const top = m.vertex(x, y1, z, cr * 1.25 * tip, cg * 1.25 * tip, cb * 1.2 * tip, Math.max(lit.sun, 0.35), lit.sky, lit.bounce, 0, 0, 0.3)
    let first = -1, prev = -1
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TWO_PI
      const ca = Math.cos(a), sa = Math.sin(a)
      this.shade(x, z, y0, ground, ca * inv, slant * inv, sa * inv, 0.7)
      const rr = r * (0.84 + 0.32 * hash2(i, Math.round(x * 5 + z * 3 + y0), 909))
      const v = m.vertex(x + ca * rr, y0, z + sa * rr, cr * 0.74, cg * 0.76, cb * 0.8, lit.sun, lit.sky, lit.bounce, 0, 0, 0.3)
      if (prev >= 0) m.tri(top, v, prev)
      else first = v
      prev = v
    }
    m.tri(top, first, prev)
  }

  /** a rounded crown: narrow skirt at y0, widest at y1, an optional shoulder ring above it, cap at y2 */
  private blob(
    m: MeshBuilder, x: number, z: number, y0: number, y1: number, y2: number, r0: number, r1: number, sides: number, rot: number,
    cr: number, cg: number, cb: number, ground: number, shoulder: boolean,
  ): void {
    const lit = this.lit
    // lumps: the crown is pushed off-centre and each ring is uneven
    const seed = Math.round(x * 3 + z * 7)
    const ox = (hash2(seed, 1, 908) - 0.5) * r1 * 0.3, oz = (hash2(seed, 2, 908) - 0.5) * r1 * 0.3
    const ys = y1 + 0.62 * (y2 - y1)
    const yTop = shoulder ? y2 : y1 + 0.8 * (y2 - y1)
    this.shade(x, z, yTop, ground, 0, 1, 0, 1)
    const top = m.vertex(x + ox, yTop, z + oz, cr * 1.28, cg * 1.28, cb * 1.2, Math.max(lit.sun, 0.4), lit.sky, lit.bounce, 0, 0, 0.3)
    let fA = -1, fB = -1, fC = -1, pA = -1, pB = -1, pC = -1
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TWO_PI
      const ca = Math.cos(a), sa = Math.sin(a)
      const rr = r1 * (0.82 + 0.36 * hash2(i, seed, 907))
      let vc = -1
      if (shoulder) {
        this.shade(x, z, ys, ground, ca * 0.6, 0.8, sa * 0.6, 1)
        vc = m.vertex(x + ox + ca * rr * 0.62, ys, z + oz + sa * rr * 0.62, cr * 1.15, cg * 1.15, cb * 1.1, lit.sun, lit.sky, lit.bounce, 0, 0, 0.3)
      }
      this.shade(x, z, y1, ground, ca * 0.94, 0.34, sa * 0.94, 0.85)
      const vb = m.vertex(x + ox * 0.5 + ca * rr, y1, z + oz * 0.5 + sa * rr, cr * 0.95, cg * 0.95, cb * 0.95, lit.sun, lit.sky, lit.bounce, 0, 0, 0.3)
      this.shade(x, z, y0, ground, ca * 0.8, -0.6, sa * 0.8, 0.5)
      const va = m.vertex(x + ca * r0, y0, z + sa * r0, cr * 0.55, cg * 0.57, cb * 0.62, lit.sun, lit.sky, lit.bounce, 0, 0, 0.3)
      if (pA >= 0) {
        if (shoulder) {
          m.tri(top, vc, pC)
          m.quad(pC, vc, vb, pB)
        } else m.tri(top, vb, pB)
        m.quad(pB, vb, va, pA)
      } else { fA = va; fB = vb; fC = vc }
      pA = va; pB = vb; pC = vc
    }
    if (shoulder) {
      m.tri(top, fC, pC)
      m.quad(pC, fC, fB, pB)
    } else m.tri(top, fB, pB)
    m.quad(pB, fB, fA, pA)
  }

  /** a bare trunk: a three-sided spike from the ground up into the crown (three triangles) */
  private trunk(m: MeshBuilder, x: number, z: number, y0: number, y1: number, r: number): void {
    const lit = this.lit
    const [tr, tg, tb] = PAL.trunk
    this.gb.light(x, z, y1 - y0, 0, 1, 0, 0.6, lit)
    const top = m.vertex(x, y1, z, tr, tg, tb, lit.sun * 0.5, lit.sky, lit.bounce)
    let first = -1, prev = -1
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TWO_PI + 0.4
      const ca = Math.cos(a), sa = Math.sin(a)
      this.gb.light(x, z, 1.5, ca, 0.05, sa, 0.75, lit)
      const v = m.vertex(x + ca * r * 1.5, y0, z + sa * r * 1.5, tr, tg, tb, lit.sun, lit.sky, lit.bounce)
      if (prev >= 0) m.tri(top, v, prev)
      else first = v
      prev = v
    }
    m.tri(top, first, prev)
  }
}
