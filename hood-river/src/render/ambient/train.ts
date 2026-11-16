/**
 * A BNSF freight on the Washington waterline: three orange locomotives and a mile of
 * double-stacked containers, eastbound at 58 km/h. At the start of a run its head is 700 m
 * upwind of the rider; it draws level about 45 s later, takes two minutes to go by, and
 * another comes every twelve minutes. Position is a pure function of the simulation time.
 *
 * The track. The terrain module cuts a railway bench into the Washington bank and draws it,
 * but does not publish where it is, so this file lays out the same line from the same
 * numbers (terrain/landmarks.ts, planCorridors: the shoreline from the level's depth map,
 * 14 m inland, swinging 105 to 165 m inland behind the Hatchery park, deck 5.2 to 7.5 m
 * above the river and up to 15 m behind the park). From the water the deck itself is above
 * eye level behind its riprap edge, so a metre of disagreement does not show. If the
 * terrain module ever exposes its line as `rail: { px, pz, deck }` (stations in ground
 * coordinates) it is used instead.
 */
import type { App } from '../../app/types'
import { LEVEL } from '../../sim/level'
import { mulberry32 } from '../../sim/rng'
import type { InstanceSet } from './instances'

const LOCOS = 3
const CARS = 68
export const TRAIN_BOXES = LOCOS + CARS

const SPEED = 16
/** a train every 12 minutes */
const PERIOD = 720
const LOCO_LEN = 22.5, CAR_LEN = 20.6

/** river centreline z against ground x (place research, reach table) */
const CENTRE: [number, number][] = [
  [-4300, -420], [-3800, -360], [-3000, -300], [-2400, -150], [-1986, -161], [-1487, -146], [-998, -43], [-500, -5], [0, 0], [500, -8], [996, -66],
  [1491, -135], [1967, 1], [2398, 254], [2862, 439], [3344, 574], [3815, 733], [4182, 1071], [4533, 1427], [5100, 1650],
]
/** how far inland of the shoreline the track runs, and the ceiling on its deck height (as the terrain module has them) */
const INLAND: [number, number][] = [
  [-4300, 14], [-760, 14], [-420, 105], [-150, 165], [150, 150], [420, 60], [640, 16], [2700, 16], [3000, 30], [4450, 16], [4750, 150], [5050, 190],
]
const MAX_DECK: [number, number][] = [[-4300, 7.5], [-760, 7.5], [-420, 15], [420, 15], [640, 7.5], [4450, 7.5], [4750, 14]]
const MIN_DECK = 5.2

const BNSF_ORANGE = 0xe36f1e, LOCO_ROOF = 0x1f2a22
const CONTAINERS = [0x9db4c6, 0xd4b04a, 0x2f6b4f, 0xd8691f, 0x1f4e8c, 0xcf2f79, 0xa83227, 0xe4e2da, 0x8c9297, 0x6e4a36, 0xe4e2da, 0x1f4e8c, 0xa83227]

function table(t: [number, number][], x: number): number {
  if (x <= t[0][0]) return t[0][1]
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) return t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (x - t[i - 1][0])) / (t[i][0] - t[i - 1][0])
  }
  return t[t.length - 1][1]
}

export class Train {
  private readonly app: App
  private px: Float32Array
  private pz: Float32Array
  private py: Float32Array
  private cum: Float32Array
  private length = 0
  private readonly colA = new Float32Array(TRAIN_BOXES)
  private readonly colB = new Float32Array(TRAIN_BOXES)
  private readonly high = new Float32Array(TRAIN_BOXES)
  private adopted = false
  /** how many boxes the last write() drew */
  drawn = 0

  constructor(app: App) {
    this.app = app
    const rand = mulberry32(471)
    const pick = () => CONTAINERS[Math.floor(rand() * CONTAINERS.length) % CONTAINERS.length]
    for (let i = 0; i < TRAIN_BOXES; i++) {
      if (i < LOCOS) { this.colA[i] = BNSF_ORANGE; this.colB[i] = LOCO_ROOF; this.high[i] = 4.7; continue }
      this.colA[i] = pick()
      // mostly two containers high; now and then a single
      const single = rand() < 0.16
      this.colB[i] = single ? this.colA[i] : pick()
      this.high[i] = single ? 3.6 : 6.0
    }
    // lay out the line from the level data
    const STEP = 20
    const x0 = -4300, x1 = 5050
    const n = Math.floor((x1 - x0) / STEP) + 1
    const raw = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = x0 + i * STEP
      // main shoreline: the last water before 150 m of unbroken land, scanning toward Washington
      let z = table(CENTRE, x), last = z, run = 0
      for (; z > -3700; z -= 4) {
        if (LEVEL.waterDepth(x, z) > 0.45) { last = z; run = 0 } else if ((run += 4) > 150) break
      }
      // the White Salmon's mouth and the sandbar gap: straight across
      if (x > 2720 && x < 3010) last = -412 + ((-182 + 412) * (x - 2720)) / 290
      else if (x > 3520 && x < 3880) last = 6 + ((172 - 6) * (x - 3520)) / 360
      raw[i] = last - table(INLAND, x)
    }
    this.px = new Float32Array(n)
    this.pz = new Float32Array(n)
    this.py = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0
      for (let k = -7; k <= 7; k++) {
        const w = 8 - Math.abs(k)
        s += raw[Math.max(0, Math.min(n - 1, i + k))] * w
        c += w
      }
      this.px[i] = x0 + i * STEP
      this.pz[i] = s / c
      this.py[i] = Math.max(MIN_DECK, Math.min(Math.max(MIN_DECK, table(MAX_DECK, this.px[i])), LEVEL.landHeight(this.px[i], this.pz[i]) + 1))
    }
    const tmp = new Float32Array(n)
    for (let pass = 0; pass < 12; pass++) {
      for (let i = 0; i < n; i++) tmp[i] = (this.py[Math.max(0, i - 1)] + 2 * this.py[i] + this.py[Math.min(n - 1, i + 1)]) / 4
      this.py.set(tmp)
    }
    this.cum = new Float32Array(n)
    this.measure()
  }

  private measure() {
    const n = this.px.length
    this.cum = new Float32Array(n)
    for (let i = 1; i < n; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(this.px[i] - this.px[i - 1], this.pz[i] - this.pz[i - 1])
    this.length = this.cum[n - 1]
  }

  /** use the terrain module's own line if it publishes one */
  private adopt() {
    this.adopted = true
    const rail = (this.app.modules.terrain as unknown as { rail?: { px: ArrayLike<number>; pz: ArrayLike<number>; deck: ArrayLike<number> } } | undefined)?.rail
    if (!rail || !(rail.px.length > 2)) return
    const n = rail.px.length
    this.px = new Float32Array(n)
    this.pz = new Float32Array(n)
    this.py = new Float32Array(n)
    for (let i = 0; i < n; i++) { this.px[i] = rail.px[i]; this.pz[i] = rail.pz[i]; this.py[i] = rail.deck[i] }
    this.measure()
  }

  /** write the train's boxes starting at index `at`; returns the next free index */
  write(set: InstanceSet, at: number): number {
    if (!this.adopted) this.adopt()
    const time = this.app.time
    // arc length of the head: abeam the rider's usual start (ground x -220) 45 s into a run
    const headAtStart = 4160 - 45 * SPEED
    const loop = SPEED * PERIOD
    let head = (headAtStart + SPEED * time) % loop
    if (head < 0) head += loop
    let i = at
    let back = 0
    let seg = this.px.length - 2
    for (let k = 0; k < TRAIN_BOXES; k++) {
      const len = k < LOCOS ? LOCO_LEN : CAR_LEN
      const s = head - back - len * 0.5
      back += len
      if (s <= 0 || s >= this.length) continue
      while (seg > 0 && this.cum[seg] > s) seg--
      const t = (s - this.cum[seg]) / Math.max(1e-3, this.cum[seg + 1] - this.cum[seg])
      const x = this.px[seg] + (this.px[seg + 1] - this.px[seg]) * t
      const z = this.pz[seg] + (this.pz[seg + 1] - this.pz[seg]) * t
      const y = this.py[seg] + (this.py[seg + 1] - this.py[seg]) * t
      const h = Math.atan2(this.pz[seg + 1] - this.pz[seg], this.px[seg + 1] - this.px[seg])
      if (k < LOCOS) set.setBox(i++, x, y + 0.2, z, h, len - 1.2, this.high[k], 3.1, 0.72, this.colA[k], this.colB[k])
      else set.setBox(i++, x, y + 0.5, z, h, len - 1.4, this.high[k], 2.6, 0.5, this.colA[k], this.colB[k])
    }
    this.drawn = i - at
    return i
  }

  /** ground position of the head of the train, or null when none is on the reach (for the report) */
  where(): { x: number; z: number } | null {
    const loop = SPEED * PERIOD
    let head = (4160 - 45 * SPEED + SPEED * this.app.time) % loop
    if (head < 0) head += loop
    if (head <= 0 || head >= this.length) return null
    let seg = 0
    while (seg < this.px.length - 2 && this.cum[seg + 1] < head) seg++
    return { x: this.px[seg], z: this.pz[seg] }
  }
}
