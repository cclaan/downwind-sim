/**
 * What grows and lies where: the land cover of the gorge as rules on side, slope, height,
 * aspect and place (place report, section C), used both to colour the ground and to decide
 * where trees stand.
 *
 * Washington (south-facing, dry): cured gold grass, grey talus under dark basalt bands, oak
 * clumps and single pines, firs in the draws and above 250 m. The bluff behind the Hatchery
 * and the Underwood face east of it are wooded over most of their height; the Tunnel 5 burn
 * runs along the upper bluff west of the hatchery buildings; lawn and tall firs stand on the
 * Hatchery terrace; oak and pine woodland covers the Bingen bluff under White Salmon.
 * Oregon (north-facing, wet): closed dark fir, with bare basalt only in the band under the
 * level rim (the apron below it is wooded), orchards on the bench, the Hood River waterfront
 * and town downstream, Wells Island in cottonwood.
 */
import { LANDMARKS } from '../../sim/level'
import type { TerrainField } from './field'
import { HEADING_DEG, HOOD } from './field'
import { clamp, fbm, lerp, smoothstep } from './noise'
import { centreZ, type Survey } from './survey'

export type Rgb = readonly [number, number, number]

/** sRGB hex -> linear rgb */
export function hex(h: number): Rgb {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return [f((h >> 16) & 255), f((h >> 8) & 255), f(h & 255)]
}

/** albedos (the lit colour is roughly 0.6 to 1.1 times these) */
export const PAL = {
  grass: hex(0xecc680),
  grassPale: hex(0xf0dcae),
  grassGreen: hex(0xa7a865),
  dryEast: hex(0xcdb48c),
  talus: hex(0xa39a8e),
  basalt: hex(0x6f6257),
  basaltDark: hex(0x4d4640),
  basaltCool: hex(0x4b4f55),
  lichen: hex(0x8f8a52),
  ledge: hex(0xbfb3a1),
  riprap: hex(0x8f8880),
  wet: hex(0x4a4640),
  sand: hex(0xdccfb6),
  sandWet: hex(0xa39a86),
  lawn: hex(0x8a9a5c),
  riparian: hex(0x6f8a4c),
  fir: hex(0x2f4a30),
  firLit: hex(0x4a6740),
  pine: hex(0x3d5a36),
  oak: hex(0x55673a),
  cottonwood: hex(0x7a9650),
  maple: hex(0x5f8044),
  orchard: hex(0x66854a),
  vineyard: hex(0x93a060),
  field: hex(0xc7b98c),
  burnGround: hex(0x9a7c5f),
  /** standing dead timber over brush, seen from a distance */
  burnWood: hex(0x5b5a4c),
  oakwood: hex(0x4f5c3a),
  regrowth: hex(0x7d8f55),
  scorch: hex(0xa8876f),
  snag: hex(0x8b867f),
  trunk: hex(0x5b4a3c),
  gravel: hex(0xcbc1b6),
  asphalt: hex(0x67676b),
  concrete: hex(0xb9b4aa),
  ballast: hex(0x857b72),
  townGround: hex(0x9a9a84),
  snow: hex(0xffffff),
  alpine: hex(0x7c736c),
  farForest: hex(0x2f4a36),
  farDry: hex(0xb3a57e),
  farBurn: hex(0x4b433c),
} as const

export interface Cover {
  /** -1 Washington, +1 Oregon */
  side: number
  /** bare rock and scree, 0..1 */
  rock: number
  talus: number
  /** closed conifer canopy, 0..1 */
  conifer: number
  /** scattered oak and pine (savanna), 0..1 */
  savanna: number
  /** the 2023 burn: snags over regrowth */
  burn: number
  lawn: number
  sand: number
  gravel: number
  orchard: number
  town: number
  /** cottonwood, willow and maple by the water and on Wells Island */
  riparian: number
  /** far terrain beyond the level data */
  far: number
  snow: number
  /** dry country east of the White Salmon River */
  dry: number
  /** water-worn basalt ledges at the waterline */
  ledge: number
  /** closed oak and pine woodland on the dry bluff faces east of the White Salmon River */
  oakwood: number
  /** angular rock under a road or railway bench at the waterline */
  riprap: number
  /**
   * The wooded apron under a rim cliff (the Oregon cliff, the Underwood bluff). The data
   * gives the whole face one steep slope; the ground of the apron is really gentler, so
   * trees stand on it whatever the slope says.
   */
  apron: number
}

export function makeCover(): Cover {
  return { side: -1, rock: 0, talus: 0, conifer: 0, savanna: 0, burn: 0, lawn: 0, sand: 0, gravel: 0, orchard: 0, town: 0, riparian: 0, far: 0, snow: 0, dry: 0, ledge: 0, oakwood: 0, riprap: 0, apron: 0 }
}

const L = LANDMARKS

/** Wells Island and the bars around it */
function onWellsIsland(x: number, z: number): boolean {
  return x > L.wellsIslandWest.x - 260 && x < L.wellsIslandEast.x + 260 && z > 330 && z < 800 && z < centreZ(x) + 760
}

/** how much of a Washington face is wooded, by place: 0..1 */
function woodedShare(x: number, y: number): number {
  // up-river wall: rather more than half (dark from the water in the owner's drone clip, with
  // talus and grass showing through); the bluff behind the Hatchery: most of the lower slope, less
  // among the cliff bands above; the Underwood face: nearly all; nothing east of the White Salmon
  const west = 0.72
  const hatch = 0.86 - 0.3 * smoothstep(150, 230, y)
  const underwood = 0.94
  let w = west + (hatch - west) * smoothstep(-900, -500, x)
  w += (underwood - w) * smoothstep(900, 1300, x)
  return w * (1 - smoothstep(2650, 2900, x))
}

export class LandCover {
  private face = { t: 0, relief: 0 }

  constructor(readonly F: TerrainField, readonly S: Survey) {}

  /**
   * Land cover at a point on the ground. `slope` is the tangent of the slope there,
   * (nx, nz) the horizontal part of the unit normal (the downhill direction); pass zeros to
   * have it taken from the elevation data.
   */
  at(x: number, z: number, y: number, slope: number, nx: number, nz: number, out: Cover): Cover {
    const F = this.F, S = this.S
    out.rock = out.talus = out.conifer = out.savanna = out.burn = out.lawn = out.sand = 0
    out.gravel = out.orchard = out.town = out.riparian = out.far = out.snow = out.dry = out.ledge = 0
    out.oakwood = out.riprap = out.apron = 0
    const outside = F.outside(x, z)
    if (outside > 0) {
      this.farCover(x, z, y, slope, out)
      if (outside > 300) return out
    }
    const far = out.far
    const side = z < centreZ(x) ? -1 : 1
    out.side = side
    const shore = F.shore(x, z)
    const hollow = S.hollow(x, z)
    const n1 = fbm(x / 210, z / 210, 3, 101)
    const n2 = fbm(x / 60, z / 60, 2, 102)
    const steep = Math.max(slope, F.slope(x, z))
    if (nx === 0 && nz === 0) {
      // downhill direction from the data
      const e = 30
      nx = S.heightAt(x - e, z) - S.heightAt(x + e, z)
      nz = S.heightAt(x, z - e) - S.heightAt(x, z + e)
    }
    const gl = Math.hypot(nx, nz)
    // unit vector up the slope
    const ux = gl > 1e-4 ? -nx / gl : 0, uz = gl > 1e-4 ? -nz / gl : 0
    const face = this.face
    S.face(x, z, y, face)

    // bare rock by slope; talus on the ramp below a steep band
    out.rock = smoothstep(0.78, 1.15, steep + 0.12 * (n2 - 0.5))
    // a short steep face under a level rim (the Oregon cliff, the Underwood bluff): the data
    // gives one even slope where there is really a wooded apron under a wall, so the rock is
    // kept to the band below the rim
    let rimBand = 0
    if (gl > 1e-4 && face.relief > 28 && face.relief < 150 && steep > 0.4) {
      const above = Math.min(F.slope(x + ux * 70, z + uz * 70), F.slope(x + ux * 120, z + uz * 120), F.slope(x + ux * 170, z + uz * 170))
      const rim = 1 - smoothstep(0.22, 0.4, above)
      const place = side > 0 ? smoothstep(-2700, -2450, x) * (1 - smoothstep(2300, 2500, x)) : smoothstep(1050, 1300, x) * (1 - smoothstep(2650, 2850, x))
      if (rim * place > 0) {
        rimBand = rim * place
        const t = face.t + 0.14 * (n2 - 0.5) + 0.1 * (n1 - 0.5)
        const band = smoothstep(side > 0 ? 0.55 : 0.58, side > 0 ? 0.66 : 0.7, t) * (1 - smoothstep(0.93, 1.0, face.t)) * smoothstep(0.45, 0.62, steep)
        // ledges in the wall carry brush and small trees: the band is broken, not a stripe
        const ledges = 1 - 0.55 * smoothstep(0.56, 0.7, fbm(x / 48 + 4.4, z / 48 - 1.6, 2, 107))
        out.rock = out.rock * (1 - rimBand) + rimBand * Math.max(band * ledges, smoothstep(1.25, 1.6, steep))
        out.apron = rimBand * (1 - band)
      }
    }
    if (steep > 0.42 && steep < 0.95 && y > 12 && gl > 1e-4 && rimBand < 0.5) {
      // look up the slope: is there a wall above?
      const above = Math.max(F.slope(x + ux * 55, z + uz * 55), F.slope(x + ux * 110, z + uz * 110))
      const patch = fbm(x / 170 + 9.3, z / 170 - 4.1, 2, 103)
      out.talus = smoothstep(0.7, 1.0, above) * smoothstep(0.45, 0.58, steep) * (1 - out.rock) * smoothstep(0.44, 0.56, patch + (side < 0 ? 0 : -0.12))
    }

    if (side < 0) {
      // ---------------- Washington ----------------
      const east = smoothstep(2700, 3200, x) // beyond the White Salmon River: drier
      out.dry = east
      // conifer: the draws, and the upper wall
      const high = smoothstep(210, 330, y + 60 * (n1 - 0.5))
      const draw = smoothstep(2, 9, hollow) * smoothstep(8, 30, y)
      // wooded faces (the owner's photographs and the aerial view: fir and pine with oak and
      // maple under them): a share of each face, in patches, never on the flat bench tops
      const share = woodedShare(x, y)
      const thr = 0.62 - 0.27 * share
      // (the Underwood face and the wall up-river are wooded from the road at their foot; the Hatchery bluff from above the terrace)
      const foot = Math.max(smoothstep(900, 1200, x), 1 - smoothstep(-1000, -700, x))
      let wooded = 0
      if (share > 0.02) {
        // a part-wooded face carries its trees in strips and patches a couple of hundred
        // metres across; a wooded one is whole, with small gaps
        const patchy = smoothstep(thr - 0.06, thr + 0.06, n1 + 0.16 * (n2 - 0.5))
        const closedUp = smoothstep(0.78, 0.92, share)
        const whole = closedUp > 0 ? 1 - smoothstep(0.66, 0.76, fbm(x / 75 + 2.3, z / 75 - 7.7, 2, 106)) : 0
        wooded = lerp(patchy, whole, closedUp) * smoothstep(0.17, 0.3, steep) * smoothstep(9 - 5 * foot, 20 - 11 * foot, y)
      }
      // trees along the rim of a bench stand on the skyline from the water
      const rimWood = x < 2800 ? S.skylineAt(x, z) * (1 - smoothstep(0.25, 0.45, steep)) * smoothstep(60, 100, y) * smoothstep(0.3, 0.45, n2 + 0.15) : 0
      out.conifer = clamp(Math.max(0.9 * high * smoothstep(0.3, 0.52, n1 + 0.15), 0.85 * draw * smoothstep(0.3, 0.5, n2 + 0.2), 0.92 * wooded, 0.75 * rimWood), 0, 1) * (1 - 0.6 * east) * (1 - out.rock) * (1 - 0.85 * out.talus)
      // a gap in the trees on a steep face is scree and broken rock, not meadow
      if (rimBand > 0) {
        const bare = rimBand * (1 - out.conifer) * (1 - out.rock) * smoothstep(0.55, 0.8, steep)
        out.talus = Math.max(out.talus, 0.45 * bare)
        out.rock = Math.max(out.rock, 0.4 * bare)
      }
      out.savanna = (1 - out.conifer) * smoothstep(0.12, 0.3, steep) * (1 - smoothstep(0.6 + 0.3 * east, 0.8 + 0.3 * east, steep)) * smoothstep(0.35, 0.6, n1) * (1 - out.talus)
      // the Bingen bluff under White Salmon: oak and pine woodland in dark patches over the grass
      if (east > 0) {
        const patch = fbm(x / 150 - 3.7, z / 150 + 8.2, 3, 105)
        out.oakwood = east * smoothstep(0.24, 0.42, steep) * smoothstep(8, 18, y) * smoothstep(0.4, 0.52, patch + 0.1 * smoothstep(3, 10, hollow)) * (1 - out.rock) * (1 - out.talus) * (1 - out.conifer)
        out.savanna *= 1 - out.oakwood
      }
      // the Tunnel 5 burn: the bluff from two kilometres up-river to just past the launch.
      // Behind the terrace it ran along the upper slope; the lower stand came through green.
      const burnX = smoothstep(-2500, -2150, x) * (1 - smoothstep(420, 760, x + 240 * (n1 - 0.5)))
      if (burnX > 0) {
        const lower = smoothstep(-950, -500, x) * (1 - smoothstep(75, 125, y + 40 * (n2 - 0.5)))
        const mosaic = 0.35 + 0.65 * smoothstep(0.38, 0.56, fbm(x / 240 + 5.1, z / 240 - 2.9, 2, 104))
        out.burn = burnX * mosaic * (1 - lower) * smoothstep(14, 30, y) * (1 - smoothstep(300, 380, y + 80 * (n1 - 0.5))) * smoothstep(0.1, 0.2, steep)
      }
      // the Hatchery terrace: lawn and gravel under tall firs
      if (y < 19 && x > -520 && x < 1500 && steep < 0.3) {
        const t = smoothstep(19, 13, y) * smoothstep(-520, -380, x) * smoothstep(1500, 1300, x)
        // watered lawn in the state park by the launch and round the hatchery; the rest is dry grass and gravel
        const park = smoothstep(-330, -230, x) * smoothstep(330, 200, x) * smoothstep(-760, -700, z)
        const hatchery = smoothstep(400, 480, x) * smoothstep(1380, 1250, x) * smoothstep(0.35, 0.6, n1)
        out.lawn = t * Math.max(park * smoothstep(0.3, 0.45, n2 + 0.2), 0.7 * hatchery * smoothstep(0.45, 0.55, n2))
        out.gravel = t * (1 - out.lawn) * smoothstep(0.52, 0.62, n2) * 0.8
        out.conifer *= 1 - t
        out.savanna *= 1 - t
      }
      // White Salmon and Bingen: lawns, roofs and yards on the bench, mill flats at the water
      if (x > 2900) {
        const bench = smoothstep(95, 125, y) * (1 - smoothstep(250, 300, y)) * (1 - smoothstep(0.2, 0.34, steep))
        const flats = smoothstep(4400, 4700, x) * (1 - smoothstep(22, 32, y)) * (1 - smoothstep(0.12, 0.2, steep))
        out.town = Math.max(bench * 0.8, flats)
        out.gravel = Math.max(out.gravel, flats * 0.6)
        out.conifer *= 1 - out.town
        out.oakwood *= 1 - out.town
      }
      // the benches above the walls: vineyards, fields, woodlots (Underwood's at 125 to 160 m, the upper one above 285 m)
      if (steep < 0.2 && x < 2900) {
        const upper = smoothstep(275, 295, y)
        const underwood = smoothstep(1000, 1150, x) * smoothstep(95, 110, y)
        const west = 1 - smoothstep(2550, 2850, x + 200 * (n2 - 0.5))
        out.orchard = (1 - out.conifer) * smoothstep(0.45, 0.55, n1) * 0.8 * Math.max(upper, underwood) * west
      }
    } else {
      // ---------------- Oregon ----------------
      const waterfront = smoothstep(2150, 2450, x) * (1 - smoothstep(8, 13, y))
      const island = onWellsIsland(x, z) ? 1 : 0
      const townSlope = smoothstep(2250, 2600, x) * smoothstep(8, 16, y) * (1 - smoothstep(150, 190, y)) * (1 - smoothstep(4700, 5100, x))
      const bench = (1 - smoothstep(0.16, 0.26, steep)) * smoothstep(30, 45, y) * (1 - waterfront) * (1 - townSlope) * smoothstep(120, 260, sampleDist(S, x, z))
      const lowBench = x > -2100 && x < -950 ? (1 - smoothstep(0.14, 0.22, steep)) * smoothstep(8, 13, y) * (1 - smoothstep(30, 36, y)) : 0
      out.orchard = Math.max(bench * smoothstep(0.38, 0.5, n1), lowBench * 0.9)
      out.conifer = (1 - out.rock) * (1 - waterfront) * (1 - island) * (1 - out.orchard) * (1 - 0.75 * townSlope) * (1 - 0.6 * bench)
      // the wooded apron takes what talus the data suggests under the cliff
      out.talus *= 1 - 0.8 * rimBand
      out.town = Math.max(townSlope * 0.85, waterfront * smoothstep(0.5, 0.62, n1 + 0.2 * smoothstep(120, 400, sampleDist(S, x, z))))
      // sand: the Hood River delta and the bars; lawn in the waterfront parks
      const delta = smoothstep(2950, 3250, x) * (1 - smoothstep(3950, 4250, x)) * (1 - smoothstep(2.2, 3.5, y))
      out.sand = Math.max(delta, waterfront * (1 - smoothstep(1.2, 2.2, y)) * 0.9, island * (1 - smoothstep(0.8, 1.8, y)))
      out.lawn = waterfront * (1 - out.sand) * (1 - out.town) * smoothstep(0.4, 0.5, n2)
      out.gravel = waterfront * (1 - out.sand) * (1 - out.lawn) * 0.8
      out.riparian = Math.max(island * (1 - out.sand), (1 - waterfront) * (1 - smoothstep(4, 14, y)) * (1 - out.rock) * 0.8)
      out.conifer *= 1 - out.riparian
    }

    // the water's edge: sand where the bottom shelves, rock where it drops away, riprap under a road or railway
    // (where the shore is stepped in ledges the rock ends at the cut bank, 8 m in, not 30)
    const stepped = F.ledgeShore(x, z)
    const edge = 1 - smoothstep(0.35 - 0.2 * stepped, 0.95 - 0.67 * stepped, shore)
    if (edge > 0 && y < 9) {
      const rocky = F.steepShore(x, z)
      const e = edge * (1 - smoothstep(4, 9, y))
      const bench = F.benchNear(x, z)
      out.sand = Math.max(out.sand * (1 - e * bench), e * (1 - rocky) * (1 - bench))
      out.ledge = e * rocky * (1 - bench)
      out.riprap = e * bench
      out.lawn *= 1 - e
      out.conifer *= 1 - e
      out.savanna *= 1 - e
      out.oakwood *= 1 - e
      out.riparian *= 1 - 0.7 * e
    }
    if (far > 0) {
      // fade the level's rules out toward the far terrain
      const k = 1 - far
      out.lawn *= k; out.sand *= k; out.gravel *= k; out.town *= k; out.orchard *= k; out.riparian *= k
      out.oakwood *= k; out.riprap *= k; out.ledge *= k
    }
    return out
  }

  /** cover of the far terrain: forest to the west and south, dry hills to the east, snow on Hood */
  private farCover(x: number, z: number, y: number, slope: number, out: Cover): void {
    out.far = smoothstep(0, 300, this.F.outside(x, z))
    out.side = z < centreZ(clamp(x, -4320, 6480)) ? -1 : 1
    let az = HEADING_DEG + (Math.atan2(z, x) * 180) / Math.PI
    az = ((az % 360) + 360) % 360
    // dry east of the Hood River valley and the White Salmon: 20 to 130 degrees true
    const dry = smoothstep(15, 40, az) * (1 - smoothstep(118, 140, az))
    out.dry = dry
    const n = fbm(x / 1700, z / 1700, 3, 211)
    // the dry hills carry oak and pine in dark patches a few hundred metres across, more of
    // them higher up; their steeper faces are rimrock
    const woods = smoothstep(0.5, 0.6, fbm(x / 520, z / 520, 3, 212) + 0.1 * smoothstep(250, 700, y) + 0.12 * (n - 0.5))
    out.conifer = clamp((1 - dry) * smoothstep(0.25, 0.5, n + 0.25) + dry * woods, 0, 1)
    out.rock = Math.max(smoothstep(0.75, 1.2, slope), dry * smoothstep(0.42, 0.8, slope))
    // Burdoin Mountain's 2025 burn: a mosaic of black and tan over the mountain dead ahead of a run
    const db = Math.hypot(x - L.burdoinMountain.x, z - L.burdoinMountain.z)
    out.burn = dry * smoothstep(4300, 2300, db) * (0.4 + 0.6 * smoothstep(0.42, 0.58, fbm(x / 430 + 1.7, z / 430 - 3.3, 2, 321)))
    const dh = Math.hypot(x - HOOD.x, z - HOOD.z)
    if (dh < 14000) {
      // July: solid snow above about 2400 m, patches down to 1900 m, bare rock ribs between
      const line = 2150 + 420 * (fbm(x / 900, z / 900, 3, 221) - 0.5)
      out.snow = smoothstep(line - 180, line + 220, y)
      out.rock = Math.max(out.rock, smoothstep(1650, 1950, y) * (1 - out.snow))
      out.conifer *= 1 - smoothstep(1500, 1850, y)
    }
  }
}

function sampleDist(S: Survey, x: number, z: number): number {
  const g = S.shoreDist
  const i = clamp(Math.round((x - g.x0) / g.step), 0, g.nx - 1)
  const j = clamp(Math.round((z - g.z0) / g.step), 0, g.nz - 1)
  return g.data[j * g.nx + i]
}

/**
 * How much of the ground a stand hides, from its cover weight. Cured grass is thirty times
 * brighter than fir, so a tenth of it showing through turns a wood khaki: once the crowns
 * mostly touch, nothing of the ground shows.
 */
function closed(cover: number): number {
  return smoothstep(0.1, 0.72, cover)
}

/** ground albedo and detail weights for a cover */
export function groundColour(
  c: Cover, x: number, z: number, y: number,
  out: { r: number; g: number; b: number; rock: number; canopy: number; grain: number },
): void {
  const n1 = fbm(x / 130, z / 130, 3, 301)
  const n2 = fbm(x / 37, z / 37, 2, 302)
  let r: number, g: number, b: number
  const mix = (col: Rgb, w: number) => {
    r += (col[0] - r) * w
    g += (col[1] - g) * w
    b += (col[2] - b) * w
  }
  // cured grass, paler on the swells, a little green in the hollows
  ;[r, g, b] = PAL.grass
  mix(PAL.grassPale, smoothstep(0.5, 0.75, n1) * 0.6)
  mix(PAL.grassGreen, smoothstep(0.5, 0.28, n1) * (c.side < 0 ? 0.16 : 0.35))
  if (c.dry > 0) mix(PAL.dryEast, c.dry * 0.7)
  if (c.side > 0 && c.far < 1) mix(PAL.grassGreen, 0.5 * (1 - c.far)) // what little grass Oregon has is greener
  if (c.burn > 0) {
    // three summers on: bleached soil showing through, green coming back in patches
    mix(PAL.burnGround, c.burn * (0.35 + 0.4 * smoothstep(0.42, 0.62, n1)))
    mix(PAL.regrowth, c.burn * smoothstep(0.58, 0.72, n2) * 0.4)
  }
  if (c.savanna > 0) mix(PAL.oak, c.savanna * smoothstep(0.55, 0.7, n2) * 0.5)
  if (c.oakwood > 0) {
    const ow = closed(c.oakwood)
    mix(PAL.oakwood, ow * 0.95)
    mix(PAL.pine, ow * smoothstep(0.6, 0.8, n2) * 0.4)
  }
  if (c.orchard > 0) {
    // rows: stripes a few metres apart, blocks turned to different headings
    const blockN = fbm(x / 260, z / 260, 1, 311)
    const ang = Math.floor(blockN * 5) * 0.9
    const stripe = 0.5 + 0.5 * Math.sin((x * Math.cos(ang) + z * Math.sin(ang)) * 0.9)
    mix(blockN > 0.72 ? PAL.field : c.side < 0 ? PAL.vineyard : PAL.orchard, c.orchard * (0.75 + 0.25 * stripe))
  }
  if (c.conifer > 0) {
    // closed canopy; in the burn, standing dead timber over brush: lighter and greyer, but
    // still a dark stand from the water, not open grass
    const cf = closed(c.conifer)
    mix(PAL.fir, cf)
    mix(PAL.firLit, cf * smoothstep(0.5, 0.8, n2) * 0.5)
    if (c.burn > 0) {
      mix(PAL.burnWood, cf * c.burn * 0.8)
      mix(PAL.regrowth, cf * c.burn * smoothstep(0.55, 0.75, n2) * 0.3)
    }
  }
  if (c.riparian > 0) mix(n2 > 0.5 ? PAL.cottonwood : PAL.riparian, closed(c.riparian))
  if (c.lawn > 0) mix(PAL.lawn, c.lawn)
  if (c.gravel > 0) mix(PAL.gravel, c.gravel)
  if (c.town > 0) mix(PAL.townGround, c.town * 0.8)
  if (c.talus > 0) mix(PAL.talus, c.talus)
  if (c.rock > 0) {
    mix(PAL.basalt, c.rock)
    mix(PAL.basaltDark, c.rock * smoothstep(0.45, 0.7, n2) * 0.6)
    if (c.side < 0) mix(PAL.lichen, c.rock * smoothstep(0.62, 0.8, n1) * 0.35)
    else mix(PAL.basaltCool, c.rock * 0.75) // the Oregon cliff: damp, mossy, never in full sun
  }
  if (c.sand > 0) mix(PAL.sand, c.sand)
  if (c.ledge > 0) {
    mix(PAL.ledge, c.ledge)
    mix(PAL.riprap, c.ledge * smoothstep(0.45, 0.6, n2) * 0.7)
  }
  if (c.riprap > 0) {
    mix(PAL.riprap, c.riprap)
    mix(PAL.basaltDark, c.riprap * smoothstep(0.4, 0.6, n2) * 0.45)
  }
  if (c.far > 0) {
    // far country: only the broad tone
    let fr: number, fg: number, fb: number
    ;[fr, fg, fb] = c.dry > 0.5 ? PAL.farDry : PAL.grass
    const cf = c.conifer
    fr += (PAL.farForest[0] - fr) * cf; fg += (PAL.farForest[1] - fg) * cf; fb += (PAL.farForest[2] - fb) * cf
    if (c.dry > 0) {
      // lighter and darker stretches of cured grass, then the burn: tan and black
      const pale = smoothstep(0.42, 0.62, n1)
      fr *= 0.84 + 0.3 * pale; fg *= 0.84 + 0.28 * pale; fb *= 0.86 + 0.22 * pale
      const burnt = c.burn * 0.85
      fr += (PAL.farBurn[0] - fr) * burnt; fg += (PAL.farBurn[1] - fg) * burnt; fb += (PAL.farBurn[2] - fb) * burnt
    }
    // rimrock on the dry hills, grey alpine rock on the high peaks
    const rk = c.rock
    const stone = c.dry > 0.5 ? PAL.basalt : PAL.alpine
    fr += (stone[0] - fr) * rk; fg += (stone[1] - fg) * rk; fb += (stone[2] - fb) * rk
    fr += (PAL.snow[0] - fr) * c.snow; fg += (PAL.snow[1] - fg) * c.snow; fb += (PAL.snow[2] - fb) * c.snow
    r += (fr - r) * c.far; g += (fg - g) * c.far; b += (fb - b) * c.far
  }
  // a little overall variation so no large area is one flat tone
  const v = 0.9 + 0.2 * n2
  out.r = r * v
  out.g = g * v
  out.b = b * v
  out.rock = Math.max(smoothstep(0.35, 0.9, c.rock), 0.5 * c.ledge) * (1 - c.far)
  out.canopy = clamp(closed(c.conifer) + closed(c.riparian) + 0.9 * closed(c.oakwood) + 0.6 * c.orchard, 0, 1) * (1 - c.snow)
  out.grain = Math.max(0.55, 0.9 * c.riprap) * (1 - 0.7 * c.far)
  void y
}
