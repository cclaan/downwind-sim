/**
 * The people on the river: wing-foilers and windsurfers reaching back and forth across the
 * wind off the Hatchery (and a few at Swell City upwind, off Underwood and off the Hood
 * River waterfront downwind), kiters off the sandbar. Purely visual; nothing here touches
 * the simulation.
 *
 * Each sailor reaches across the river between its own two limits (set at load from the
 * level's depth map, so no foil sails over the shoals and nobody onto a bank), gybes
 * downwind at the end of each reach and points a little high on the way back to hold its
 * lane.
 *
 * They never get in the rider's way. Water is kept clear around the rider (KEEP_OUT):
 *   - a circle round the rider: nobody sails within 45 m, nobody sails toward the rider
 *     within 60 m, and a sailor that has stopped to let it by is at least 40 m off;
 *   - a corridor from 80 m upwind of the rider to as far ahead as the rider will be in under
 *     a minute (110 m while paddling, 340 m on foil), 40 m either side at the rider widening
 *     to 59 m at the far end. It lies along the rider's course averaged over a dozen
 *     seconds, and spans the range that course has swept lately: the whole of a weave;
 *   - the line of a course the rider has held steady for a few seconds (a reach across the
 *     river), 160 m ahead and 30 m either side;
 *   - the tow (ambient/traffic.ts), with room ahead of its bow.
 * Beyond that they cross the whole channel, which from the rider's eye is the look of the
 * place: sails across the river ahead and turning back 45 to 60 m abeam, none in the way.
 *
 * How a sailor stays out. Several times a second each one near the rider or the tow looks a
 * few seconds ahead along its own course, with the rider and the tow carried forward at
 * their present speeds (`quickClear`). If that is clear it sails on. If not (the corridor,
 * the end of its lane, a shoal) it weighs everything a sailor can do (`plan`): reach on,
 * gybe and reach back, stop and wait, bear away on either tack, run downwind, pinch up. It
 * rolls each forward ten seconds (`evaluate`) and takes the one that keeps to deep water
 * and out of the kept-clear water, or does the least harm. Nothing is ever chosen that goes
 * aground, and crossing the rider's bow close ahead is the last thing chosen. So a sailor
 * about to enter the corridor gybes at its edge; one caught inside (the rider turned toward
 * it) leaves by the nearest open side at a sprint; one with its back to a shoal as the
 * rider reaches toward it bears away and runs off downwind along the shoal instead of
 * sailing back past the rider; one squeezed between the corridor and a bank, or left only
 * a stretch too short to sail, luffs up and waits for the rider to go by.
 *
 * What cannot be promised: a rider who turns straight back on a sailor that was 60 m off
 * its quarter closes faster than a gybe takes, and passes it at 30 to 45 m.
 *
 * Deterministic: seeded, and advanced only by the dt passed in.
 */
import type { App, QualityTier } from '../../app/types'
import { LEVEL } from '../../sim/level'
import { LEVEL_DATA } from '../../sim/levelData'
import { mulberry32 } from '../../sim/rng'
import type { InstanceSet } from './instances'
import { fairwayZ, type Tow } from './traffic'

export const WING = 0, WINDSURF = 1, KITE = 2

/** what a sailor is doing: reaching along its lane, holding a heading (to get out of the way), or stopped */
export const REACH = 0, AIM = 1, STOP = 2

/** water kept clear of sailors (m). The tuning panel can bind this object: it is read every frame. */
export const KEEP_OUT = {
  /** nobody sails inside this distance of the rider */
  bubble: 45,
  /** ...and nobody sails toward the rider inside this one */
  lookAhead: 60,
  /** a sailor that has stopped to let the rider by may be this close */
  parked: 40,
  /** the corridor: metres upwind of the rider, metres downwind while paddling and at full speed */
  behind: 80,
  aheadMin: 110,
  ahead: 340,
  /** half width at the rider (no less than `parked`: a sailor waiting at its edge is not then in the way), and how fast it widens downwind (m per m) */
  halfWidth: 40,
  widen: 0.055,
  /** however wide the rider weaves, the corridor reaches no further than this beyond its half width either side of the middle of the weave */
  band: 60,
  /** the line of a course the rider is holding steady: length ahead, half width, widening */
  courseLength: 160,
  courseHalf: 30,
  courseWiden: 0.07,
  /** the tow: clear water either side of its track, astern of the bow, ahead of it */
  towHalf: 55,
  towAstern: 290,
  towAhead: 140,
}
/** the old name, still read by checks written against the first version */
export const CORRIDOR = KEEP_OUT

interface Cluster {
  name: string
  /** sailors drawn on the low, mid and high tiers */
  count: [number, number, number]
  kind: 'sails' | 'kites'
  x0: number
  x1: number
  /** where along x the crowd is thickest (the middle if absent) */
  peak?: number
  /** where along z a sailor's reach may be centred */
  z0: number
  z1: number
  /** longest reach (m) */
  reach: number
  /** water shallower than this turns a foil back (m); windsurfers carry on to 0.7 m */
  minDepth: number
  /** fraction that are windsurfers */
  windsurf: number
  /** lanes stay this far to the Oregon side of the tow's track (m); absent = lanes may cross it */
  offFairway?: number
}

/**
 * Ground coordinates; see the depth map in the level data. The Hatchery crowd is the same
 * on every tier (it is what the player looks at from the start, and a sailor is 80
 * triangles); the far groups thin out on the smaller tiers.
 */
const CLUSTERS: Cluster[] = [
  { name: 'hatchery', count: [46, 46, 46], kind: 'sails', x0: -440, x1: 700, peak: -100, z0: -490, z1: -130, reach: 420, minDepth: 2.3, windsurf: 0.4 },
  { name: 'swell city', count: [4, 6, 8], kind: 'sails', x0: -1750, x1: -950, z0: -600, z1: -150, reach: 380, minDepth: 2.3, windsurf: 0.7 },
  { name: 'underwood', count: [5, 7, 8], kind: 'sails', x0: 1000, x1: 2350, z0: -430, z1: -80, reach: 380, minDepth: 2.3, windsurf: 0.5 },
  { name: 'waterfront', count: [9, 13, 16], kind: 'sails', x0: 2400, x1: 3300, z0: 110, z1: 560, reach: 300, minDepth: 2.3, windsurf: 0.35, offFairway: 75 },
  { name: 'sandbar', count: [10, 13, 16], kind: 'kites', x0: 2950, x1: 3460, z0: 250, z1: 600, reach: 320, minDepth: 0.9, windsurf: 0, offFairway: 75 },
]

// sail cloth, as seen in the references: mostly white, teal, orange, pink, yellow
const BRIGHT = [0xf4f4ef, 0x23b5ae, 0x4fd3c4, 0xf47c20, 0xef5c9c, 0xf6d32a, 0xe5392d, 0x2c6fd8, 0xa6da3a, 0x7c52d2, 0xf4f4ef, 0x23b5ae]
const TRIM = [0xf4f4ef, 0xf4f4ef, 0xf4f4ef, 0x202327, 0xf6d32a, 0xe5392d, 0x2c6fd8]

const HALF_PI = Math.PI / 2
/** how far above a beam reach a sailor that has stopped points (rad) */
const LUFF = 0.5
/** speed while leaving kept-clear water on a reach, and while holding a heading to get out of the way (x cruising speed) */
const HURRY = 1.3
const FLEE = 1.35
/** getting under way and stopping (m/s2) */
const ACCEL = 3
const BRAKE = 3.5
/** look-ahead of the plans: step (s) and number of steps */
const STEP = 0.6
const STEPS = 16

/**
 * The courses a sailor can choose between, in order of preference:
 *   manoeuvre, tack (1 = the present one, -1 = the other), heading off dead downwind (AIM only, rad), reluctance.
 * Reluctance is what a course costs when it is perfectly safe, so the first safe one in
 * this order wins: reach on, gybe, stop, bear away, bear away on the other tack, run, pinch.
 */
const C_MAN = [REACH, REACH, STOP, AIM, AIM, AIM, AIM]
const C_TACK = [1, -1, 1, 1, -1, 1, 1]
const C_AIM = [0, 0, 0, 0.87, 0.87, 0.3, 2.2]
const C_COST = [0, 3, 6, 8, 9, 10, 11]

export class Fleet {
  readonly n: number
  private readonly app: App
  private readonly tierCount: [number, number, number]
  private readonly kind: Uint8Array
  private readonly gx: Float32Array
  private readonly z: Float32Array
  private readonly y: Float32Array
  private readonly psi: Float32Array
  private readonly dir: Int8Array
  /** cruising speed (m/s) and speed now */
  private readonly speed: Float32Array
  private readonly vel: Float32Array
  private readonly zMin: Float32Array
  private readonly zMax: Float32Array
  private readonly homeX: Float32Array
  private readonly minDepth: Float32Array
  /** REACH, AIM or STOP, and the heading held while AIM */
  private readonly man: Uint8Array
  private readonly aim: Float32Array
  /** rate of turn now (rad/s) */
  private readonly om: Float32Array
  /** seconds a gybe takes */
  private readonly turnTime: Float32Array
  /** gybes made (for tests) */
  private readonly gybes: Uint32Array
  /** seconds before a course chosen to get out of the way is reconsidered; seconds of sprinting left */
  private readonly hold: Float32Array
  private readonly hurry: Float32Array
  /** seconds stopped, and seconds since the last gybe */
  private readonly still: Float32Array
  private readonly sinceGybe: Float32Array
  private readonly phase: Float32Array
  private readonly lean: Float32Array
  private readonly colA: Float32Array
  private readonly colB: Float32Array
  private frame = 0
  /** how many are drawn (the quality tier can lower it) */
  active: number
  /** the tow to keep clear of (set by the ambient module) */
  tow: Tow | null = null

  // ---- the rider, in ground coordinates, refreshed every update ----
  private rgx = 0
  private rz = 0
  /** ground velocity now; averaged over a second (the course being steered), over six (the progress being made) and over twelve (the line of a whole weave) */
  private rvx = 0
  private rvz = 0
  private fvx = 0
  private fvz = 0
  private cvx = 0
  private cvz = 0
  private wvx = 0
  private wvz = 0
  /** the corridor: range of the averaged course's direction lately (rad from downwind), as unit vectors, and its length (m) */
  private angLo = 0
  private angHi = 0
  private loX = 1
  private loZ = 0
  private hiX = 1
  private hiZ = 0
  private midX = 1
  private midZ = 0
  private ahead = KEEP_OUT.aheadMin
  /** the rider is under way along (fux, fuz): a second line no sailor may cross ahead of it */
  private underWay = false
  private fux = 1
  private fuz = 0
  /** seconds the rider has held the course it is steering (within 20 degrees of `steadyAng`), and how firmly that makes its line count, 0..1 */
  private steadyT = 0
  private steadyAng = 0
  private course = 0
  /** how far the rider's present heading is to be believed for the seconds ahead, 0..1 */
  private meant = 0
  // Registers. Numbers that pass between the routines below go through these fields and not
  // through arguments and return values: V8 boxes a floating-point number that crosses a call
  // it has not inlined (12 bytes each time), these routines run hundreds of times a frame,
  // and nothing here is to feed the garbage collector.
  /** zone(): the ground point asked about */
  private qx = 0
  private qz = 0
  /** zone()'s results: metres inside the corridor, the line of the held course and the tow's water, and where the point is from the rider then */
  private pWedge = 0
  private pStrip = 0
  private pTow = 0
  private zox = 0
  private zoz = 0
  /** evaluate(): where to stop counting, and the result */
  private bail = 0
  private cost = 0
  /** update(): the time and the land's shift this frame, for ride() */
  private now = 0
  private shift = 0
  /** sound(): the ground point asked about, and the water's depth there (m) */
  private wx = 0
  private wz = 0
  private depth = 0
  /** false if the level's own depth function has to be called after all (see the constructor) */
  private ownDepth = true
  // ---- the tow's kept-clear water: a capsule from (tax, taz) to (tbx, tbz), moving at (tvx, tvz) ----
  private towOn = false
  private readonly towSeg = new Float32Array(6)
  private tax = 0
  private taz = 0
  private tex = 0
  private tez = 0
  private tInv = 0
  private tvx = 0
  private tvz = 0
  // ---- the water mesh's rings, for riding on the surface as it is drawn (see ride) ----
  private waterMesh: { parent: unknown; material?: { uniforms?: Record<string, { value: unknown } | undefined> } } | null = null
  private readonly ring = new Float32Array(3 * 8)
  private ringCount = 0
  private rimLo = 0
  private rimHi = 0
  private cell0 = 0.5

  /** @param override  total number of sailors on every tier (the ?sails= flag), or -1 for the tiers' own numbers */
  constructor(app: App, override = -1, seed = 7202023) {
    this.app = app
    const rand = mulberry32(seed)
    const pick = (list: number[]) => list[Math.floor(rand() * list.length) % list.length]

    // how many of each cluster on each tier
    const counts = CLUSTERS.map((c) => c.count.slice() as [number, number, number])
    if (override >= 0) {
      const total = CLUSTERS.reduce((s, c) => s + c.count[2], 0)
      let left = override
      CLUSTERS.forEach((c, k) => {
        const m = k === CLUSTERS.length - 1 ? left : Math.min(left, Math.round((override * c.count[2]) / total))
        counts[k] = [m, m, m]
        left -= m
      })
    }
    const n = counts.reduce((s, c) => s + c[2], 0)
    this.n = n
    this.tierCount = [0, 1, 2].map((t) => counts.reduce((s, c) => s + c[t], 0)) as [number, number, number]
    this.active = n
    this.kind = new Uint8Array(n)
    this.gx = new Float32Array(n)
    this.z = new Float32Array(n)
    this.y = new Float32Array(n)
    this.psi = new Float32Array(n)
    this.dir = new Int8Array(n)
    this.speed = new Float32Array(n)
    this.vel = new Float32Array(n)
    this.zMin = new Float32Array(n)
    this.zMax = new Float32Array(n)
    this.homeX = new Float32Array(n)
    this.minDepth = new Float32Array(n)
    this.man = new Uint8Array(n)
    this.aim = new Float32Array(n)
    this.om = new Float32Array(n)
    this.turnTime = new Float32Array(n)
    this.gybes = new Uint32Array(n)
    this.hold = new Float32Array(n)
    this.hurry = new Float32Array(n)
    this.still = new Float32Array(n)
    this.sinceGybe = new Float32Array(n).fill(30)
    this.phase = new Float32Array(n)
    this.lean = new Float32Array(n)
    this.colA = new Float32Array(n)
    this.colB = new Float32Array(n)

    // The list is in tiers: everyone the low tier draws first, then the mid tier's extra
    // sailors, then the high tier's, each block taking from the clusters in turn. Lowering
    // `active` therefore thins the far groups and leaves the Hatchery crowd whole.
    let i = 0
    for (let tier = 0; tier < 3; tier++) {
      const want = counts.map((c) => c[tier] - (tier > 0 ? c[tier - 1] : 0))
      for (let more = true; more; ) {
        more = false
        for (let k = 0; k < CLUSTERS.length; k++) {
          if (want[k] <= 0) continue
          want[k]--
          more = true
          this.create(i++, CLUSTERS[k], rand, pick)
        }
      }
    }
    // sound() repeats the level's depth interpolation; if level.ts has changed since it was
    // written, fall back to calling it (which costs a little garbage per call)
    const probe = mulberry32(99)
    for (let k = 0; k < 400 && this.ownDepth; k++) {
      this.wx = -4400 + 9600 * probe()
      this.wz = -1700 + 3500 * probe()
      this.sound()
      if (Math.abs(this.depth - LEVEL.waterDepth(this.wx, this.wz)) > 1e-6) this.ownDepth = false
    }
    // (the app calls reset() once the rider has been placed, which clears the water round it)
  }

  /** sailors drawn on a tier */
  activeFor(tier: QualityTier): number {
    return this.tierCount[tier === 'low' ? 0 : tier === 'mid' ? 1 : 2]
  }

  private create(i: number, cl: Cluster, rand: () => number, pick: (list: number[]) => number) {
    const k = cl.kind === 'kites' ? KITE : rand() < cl.windsurf ? WINDSURF : WING
    this.kind[i] = k
    // find water: a lane and a point on it deep enough, then how far the reach can run
    // either way (turning takes room: it stops 65 m short of a bank or a shoal)
    const reach = cl.reach * (0.4 + 0.6 * rand())
    // a foil needs its mast's depth; a windsurfer's fin clears the shoals in mid-river
    const minDepth = k === WINDSURF ? Math.min(cl.minDepth, 0.7) : cl.minDepth
    // (deep over the 25 m either side of the line that a sailor wanders: gybes lose ground downwind)
    const open = (x: number, z: number) =>
      LEVEL.waterDepth(x, z) > minDepth && LEVEL.waterDepth(x - 25, z) > minDepth && LEVEL.waterDepth(x + 25, z) > minDepth &&
      (cl.offFairway === undefined || z > fairwayZ(x) + cl.offFairway - 55)
    const clear0 = (x: number, z: number) => {
      for (let m = 15; m <= 55; m += 10) if (!open(x, z - m) || !open(x, z + m)) return false
      return true
    }
    let x = 0, zc = 0, lo = 0, hi = 0
    let best = -1, bx = 0, blo = 0, bhi = 0
    for (let tries = 0; tries < 80; tries++) {
      const u = rand()
      if (cl.peak === undefined) x = cl.x0 + (cl.x1 - cl.x0) * (u + rand()) * 0.5
      else {
        // triangular, thickest at the peak
        const left = rand() < (cl.peak - cl.x0) / (cl.x1 - cl.x0)
        x = cl.peak + (left ? cl.x0 - cl.peak : cl.x1 - cl.peak) * (1 - Math.sqrt(u))
      }
      zc = cl.z0 + (cl.z1 - cl.z0) * rand()
      lo = hi = zc
      if (LEVEL.waterDepth(x, zc) < minDepth + 0.5 || !open(x, zc) || !clear0(x, zc)) continue
      // (every 10 m out to 65 m beyond the end: a turn takes room, and no ledge is stepped over)
      const clear = (z: number, d: number) => open(x, z + d * 65) && open(x, z + d * 55) && open(x, z + d * 45) && open(x, z + d * 35) && open(x, z + d * 25) && open(x, z + d * 15)
      while (zc - lo < reach * 0.5 && clear(lo - 10, -1)) lo -= 10
      while (hi - zc < reach * 0.5 && clear(hi + 10, 1)) hi += 10
      if (hi - lo > best) { best = hi - lo; bx = x; blo = lo; bhi = hi }
      // a reach worth sailing
      if (hi - lo >= 90) break
    }
    this.homeX[i] = bx
    this.zMin[i] = blo
    this.zMax[i] = bhi
    this.minDepth[i] = minDepth
    this.gx[i] = bx + (rand() - 0.5) * 20
    this.z[i] = blo + (bhi - blo) * rand()
    this.dir[i] = rand() < 0.5 ? 1 : -1
    this.psi[i] = this.dir[i] * HALF_PI
    this.speed[i] = k === WINDSURF ? 9.5 + 3.5 * rand() : k === KITE ? 8 + 3 * rand() : 7.5 + 3 * rand()
    this.vel[i] = this.speed[i]
    this.turnTime[i] = k === WINDSURF ? 2.6 + rand() : k === KITE ? 2.2 + rand() : 3 + 1.2 * rand()
    this.phase[i] = rand()
    this.lean[i] = k === WING ? -0.1 + 0.2 * rand() : k === WINDSURF ? -0.05 + 0.12 * rand() : 0
    this.colA[i] = pick(BRIGHT)
    this.colB[i] = k === WINDSURF ? (rand() < 0.5 ? pick(BRIGHT) : 0xf4f4ef) : pick(TRIM)
  }

  // -------------------------------------------------------------------------------------
  // kept-clear water
  // -------------------------------------------------------------------------------------

  /** where the rider and the tow are and where they are going; call before any of the tests below */
  private look(dt: number) {
    const app = this.app
    const K = KEEP_OUT
    const cur = app.sim.waves.current
    this.rgx = app.view.x - app.groundShift
    this.rz = app.view.z
    const rvx = app.view.vx - cur, rvz = app.view.vz
    this.rvx = rvx
    this.rvz = rvz
    if (dt > 0) {
      const kf = 1 - Math.exp(-dt / 1), ks = 1 - Math.exp(-dt / 6), kw = 1 - Math.exp(-dt / 12)
      this.fvx += (rvx - this.fvx) * kf
      this.fvz += (rvz - this.fvz) * kf
      this.cvx += (rvx - this.cvx) * ks
      this.cvz += (rvz - this.cvz) * ks
      this.wvx += (rvx - this.wvx) * kw
      this.wvz += (rvz - this.wvz) * kw
    } else {
      this.fvx = this.cvx = this.wvx = rvx
      this.fvz = this.cvz = this.wvz = rvz
    }
    const fs = Math.sqrt(this.fvx * this.fvx + this.fvz * this.fvz)
    this.underWay = fs > 2.5
    if (fs > 1) { this.fux = this.fvx / fs; this.fuz = this.fvz / fs } else { this.fux = 1; this.fuz = 0 }
    // A course held steady for longer than a carve lasts is a line the rider is going down:
    // it counts for nothing in the first two seconds and in full after five.
    const fa = Math.atan2(this.fuz, this.fux)
    let turn = fa - this.steadyAng
    if (turn > Math.PI) turn -= 2 * Math.PI
    else if (turn < -Math.PI) turn += 2 * Math.PI
    if (this.underWay && turn > -0.35 && turn < 0.35) {
      this.steadyT += dt
      this.steadyAng += turn * Math.min(1, dt * 0.5)
    } else {
      this.steadyT = 0
      this.steadyAng = fa
    }
    this.course = this.steadyT < 2 ? 0 : this.steadyT > 5 ? 1 : (this.steadyT - 2) / 3
    this.meant = this.steadyT > 2 ? 1 : this.steadyT / 2
    // The corridor lies along the rider's course averaged over a dozen seconds of carving
    // (straight downwind while it is paddling; and leaning downwind always, by 2 m/s, since
    // that is the way every run goes in the end), and spans the range that course has swept
    // lately: a rider weaving through S-turns gets one steady wedge that covers the whole
    // weave, not a corridor that swings like a wiper; one who settles on a diagonal across
    // the river gets it along that line.
    const cs = Math.sqrt(this.cvx * this.cvx + this.cvz * this.cvz)
    let ang = this.wvx * this.wvx + this.wvz * this.wvz > 2.25 ? Math.atan2(this.wvz, this.wvx + 2) : 0
    ang = ang < -2.4 ? -2.4 : ang > 2.4 ? 2.4 : ang
    const relax = dt > 0 ? 1 - Math.exp(-dt / 12) : 1
    this.angLo = Math.min(ang, this.angLo + (ang - this.angLo) * relax)
    this.angHi = Math.max(ang, this.angHi + (ang - this.angHi) * relax)
    if (this.angHi - this.angLo > 2.6) {
      // (never a reflex angle: the tests below take the wedge to be convex)
      const mid = ang
      this.angLo = Math.max(this.angLo, mid - 1.3)
      this.angHi = Math.min(this.angHi, mid + 1.3)
    }
    this.loX = Math.cos(this.angLo); this.loZ = Math.sin(this.angLo)
    this.hiX = Math.cos(this.angHi); this.hiZ = Math.sin(this.angHi)
    const mid = 0.5 * (this.angLo + this.angHi)
    this.midX = Math.cos(mid); this.midZ = Math.sin(mid)
    // as far ahead as the rider will be in under a minute (at once when it gets up on the foil)
    this.ahead = Math.max(K.aheadMin, Math.min(K.ahead, 60 + 40 * Math.max(cs, fs)))

    this.towOn = !!this.tow && this.tow.keepOut(this.towSeg, K.towAstern, K.towAhead)
    if (this.towOn) {
      const s = this.towSeg
      this.tax = s[0]; this.taz = s[1]
      this.tex = s[2] - s[0]; this.tez = s[3] - s[1]
      this.tInv = 1 / Math.max(1, this.tex * this.tex + this.tez * this.tez)
      this.tvx = s[4]; this.tvz = s[5]
    }
  }

  /**
   * How far inside the corridor (pWedge), the line of a held course (pStrip) and the tow's
   * water (pTow) the ground point (qx, qz) will be `steps` steps of the plans' look-ahead
   * from now (m, 0 = outside); returns true if it is inside any of them. The rider is
   * carried forward on the course it is steering for the first seconds and at its averaged
   * progress after that; (zox, zoz) is the point relative to where that puts it.
   */
  private zone(steps: number): boolean {
    const K = KEEP_OUT
    const x = this.qx, z = this.qz
    const tau = steps * STEP
    const t1 = tau < 2.5 ? tau : 2.5, t2 = tau - t1
    const ox = x - this.rgx - this.fvx * t1 - this.cvx * t2, oz = z - this.rz - this.fvz * t1 - this.cvz * t2
    this.zox = ox
    this.zoz = oz
    let pw = 0, ps = 0, pt = 0
    if (this.course > 0) {
      const along = ox * this.fux + oz * this.fuz
      if (along > 0 && along < K.courseLength) {
        const half = K.courseHalf + K.courseWiden * along
        const lat = Math.abs(oz * this.fux - ox * this.fuz)
        if (lat < half) ps = half - lat
      }
    }
    const aMid = ox * this.midX + oz * this.midZ
    if (aMid >= 0) {
      // which side of the wedge's two edges (positive = toward the wedge's inside)
      const cLo = this.loX * oz - this.loZ * ox
      const cHi = this.hiZ * ox - this.hiX * oz
      if (cLo >= 0 && cHi >= 0) {
        const r = Math.sqrt(ox * ox + oz * oz)
        if (r < this.ahead) pw = K.halfWidth + K.widen * r + (cLo < cHi ? cLo : cHi)
      } else {
        // beside the wedge: within the corridor's half width of the nearer edge
        const lo = cLo < cHi
        const along = lo ? ox * this.loX + oz * this.loZ : ox * this.hiX + oz * this.hiZ
        if (along < this.ahead) {
          const half = K.halfWidth + K.widen * (along > 0 ? along : 0)
          const lat = lo ? -cLo : -cHi
          if (lat < half) pw = half - lat
        }
      }
      if (pw > 0) {
        // a wide weave sweeps a band, not a fan: the rider is back across before it is far along either edge
        const cap = K.halfWidth + K.widen * aMid + K.band - Math.abs(this.midX * oz - this.midZ * ox)
        if (cap < pw) pw = cap > 0 ? cap : 0
      }
    } else if (aMid > -K.behind) {
      // the water just upwind of the rider (it is where a camera looking back is)
      const lat = Math.abs(this.midX * oz - this.midZ * ox)
      if (lat < K.halfWidth) pw = K.halfWidth - lat
    }
    if (this.towOn) {
      const px = x - this.tax - this.tvx * tau, pz = z - this.taz - this.tvz * tau
      let t = (px * this.tex + pz * this.tez) * this.tInv
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const dx = px - this.tex * t, dz = pz - this.tez * t
      const d2 = dx * dx + dz * dz
      if (d2 < K.towHalf * K.towHalf) pt = K.towHalf - Math.sqrt(d2)
    }
    this.pWedge = pw
    this.pStrip = ps
    this.pTow = pt
    return pw > 0 || ps > 0 || pt > 0
  }

  /** how far above a beam reach sailor i points to get back up to its lane (rad); a little below it when upwind of the lane */
  private high(i: number): number {
    const h = (this.gx[i] - this.homeX[i]) * 0.006
    return h < -0.08 ? -0.08 : h > 0.42 ? 0.42 : h
  }

  /**
   * The water's depth at the ground point (wx, wz), into `depth`: LEVEL.waterDepth() written
   * out, because that takes its point as two arguments and is too big for V8 to inline, so
   * every call from here would box them (24 bytes, a hundred times a frame).
   */
  private sound() {
    const x = this.wx, z = this.wz
    if (!this.ownDepth) { this.depth = LEVEL.waterDepth(x, z); return }
    const F = LEVEL.fine, C = LEVEL.coarse
    // weight of the fine grid: 1 well inside it, 0 outside
    const ex = Math.min(x - F.x0, F.x0 + (F.nx - 1) * F.step - x), ez = Math.min(z - F.z0, F.z0 + (F.nz - 1) * F.step - z)
    const e = ex < ez ? ex : ez
    const w = e <= 0 ? 0 : e >= 240 ? 1 : e / 240
    let coarse = 0, fine = 0
    if (w < 1) {
      let fx = (x - C.x0) / C.step, fz = (z - C.z0) / C.step
      fx = fx < 0 ? 0 : fx > C.nx - 1 ? C.nx - 1 : fx
      fz = fz < 0 ? 0 : fz > C.nz - 1 ? C.nz - 1 : fz
      const ix = Math.min(C.nx - 2, Math.floor(fx)), iz = Math.min(C.nz - 2, Math.floor(fz))
      const tx = fx - ix, tz = fz - iz
      const a = LEVEL.coarseDepth, j = iz * C.nx + ix
      coarse = (a[j] + (a[j + 1] - a[j]) * tx) * (1 - tz) + (a[j + C.nx] + (a[j + C.nx + 1] - a[j + C.nx]) * tx) * tz
    }
    if (w > 0) {
      let fx = (x - F.x0) / F.step, fz = (z - F.z0) / F.step
      fx = fx < 0 ? 0 : fx > F.nx - 1 ? F.nx - 1 : fx
      fz = fz < 0 ? 0 : fz > F.nz - 1 ? F.nz - 1 : fz
      const ix = Math.min(F.nx - 2, Math.floor(fx)), iz = Math.min(F.nz - 2, Math.floor(fz))
      const tx = fx - ix, tz = fz - iz
      const a = LEVEL.fineDepth, j = iz * F.nx + ix
      fine = (a[j] + (a[j + 1] - a[j]) * tx) * (1 - tz) + (a[j + F.nx] + (a[j + F.nx + 1] - a[j + F.nx]) * tx) * tz
    }
    this.depth = (coarse * (1 - w) + fine * w) * LEVEL_DATA.depthUnit
  }

  /** Is the water deep enough for sailor i for 60 m along z from where it is? (Sampled every 10 m: the depth map's cells are 30 m, so no ledge is jumped.) */
  private deepAhead(i: number, d: number): boolean {
    const m = this.minDepth[i], z = this.z[i]
    this.wx = this.gx[i]
    for (let k = 1; k <= 6; k++) {
      this.wz = z + d * 10 * k
      this.sound()
      if (this.depth < m) return false
    }
    return true
  }

  /** the same from any point (reset only) */
  private deepFrom(i: number, x: number, z: number, d: number): boolean {
    const m = this.minDepth[i]
    for (let k = 1; k <= 6; k++) if (LEVEL.waterDepth(x, z + d * 10 * k) < m) return false
    return true
  }

  /** Is sailor i's reach clear for the next few seconds (lane, depth, kept-clear water)? */
  private quickClear(i: number): boolean {
    const K = KEEP_OUT
    const d = this.dir[i], x = this.gx[i], z = this.z[i]
    if ((d > 0 && z > this.zMax[i]) || (d < 0 && z < this.zMin[i])) return false
    if (!this.deepAhead(i, d)) return false
    const psi = this.psi[i], v = this.vel[i]
    const vx = Math.cos(psi) * v, vz = Math.sin(psi) * v
    this.qx = x
    this.qz = z
    if (this.zone(0)) return false
    let dist = Math.sqrt(this.zox * this.zox + this.zoz * this.zoz)
    if (dist < K.bubble) return false
    // the corridor's edge is watched as far ahead as a gybe takes to turn back from it; the
    // rider itself (who may be coming this way) further
    for (let k = 1; k <= 6; k++) {
      const tau = k * STEP
      this.qx = x + vx * tau
      this.qz = z + vz * tau
      const inside = this.zone(k)
      const dk = Math.sqrt(this.zox * this.zox + this.zoz * this.zoz)
      if (dk < K.bubble || (dk < K.lookAhead && dk < dist - 0.2)) return false
      dist = dk
      if (k <= 3 && inside) return false
    }
    return true
  }

  /**
   * What a course would cost sailor i over the next ten seconds: 0 if it keeps to deep
   * water, to its lane and out of the kept-clear water throughout. In order of weight:
   * never aground; not near the rider, nor toward it; not across its bow; not in the tow's
   * water; not on the line of a course the rider is holding; not in the corridor (the nearer
   * the rider and the deeper in, the worse); not past the end of the lane. The course is one
   * of the list above (`c`), or the one the sailor is on (c < 0). The answer is left in
   * `cost`; counting stops once it passes `bail`.
   */
  private evaluate(i: number, man: number, d: number, c: number) {
    const K = KEEP_OUT
    const aim = c < 0 ? this.aim[i] : d * C_AIM[c]
    const bail = this.bail
    let x = this.gx[i], z = this.z[i], psi = this.psi[i], v = this.vel[i]
    const rate = (Math.PI / this.turnTime[i]) * STEP
    const cruise = this.speed[i]
    const tgt = man === REACH ? d * (HALF_PI + this.high(i)) : man === AIM ? aim : d * (HALF_PI + LUFF)
    const vT = man === STOP ? 0 : man === AIM ? aimSpeed(cruise, aim) : this.hurry[i] > 0 ? cruise * HURRY : cruise
    const minDepth = this.minDepth[i]
    const inner = man === STOP ? K.parked : K.bubble
    const outer = man === STOP ? K.parked : K.lookAhead
    const zMax = this.zMax[i] + 4, zMin = this.zMin[i] - 4
    // which side of the rider's two lines it is on now: the course it is steering and the
    // middle of the corridor (0 = on the line, or no such line)
    const fux = this.fux, fuz = this.fuz, mx = this.midX, mz = this.midZ
    const rx = x - this.rgx, rz = z - this.rz
    let sideC = this.underWay ? rz * fux - rx * fuz : 0
    let sideM = rz * mx - rx * mz
    // (a sailor already on a line may leave it by either side)
    if (sideC > -30 && sideC < 30) sideC = 0
    if (sideM > -30 && sideM < 30) sideM = 0
    let dist = Math.sqrt(rx * rx + rz * rz)
    let cost = 0
    for (let k = 1; k <= STEPS; k++) {
      const tau = k * STEP
      const e = tgt - psi
      let turning = 1
      if (e > rate) psi += rate
      else if (e < -rate) psi -= rate
      else { psi = tgt; turning = 0 }
      const dv = vT * (turning ? 0.8 : 1) - v
      v += dv > 0 ? Math.min(dv, ACCEL * STEP) : Math.max(dv, -BRAKE * STEP)
      const cp = Math.cos(psi), sp = Math.sin(psi)
      x += cp * v * STEP
      z += sp * v * STEP
      // sooner matters more: the rider may be somewhere else by the end
      const w = tau <= 2.4 ? 1 : Math.max(0.15, 1 - (tau - 2.4) * 0.15)
      this.qx = x
      this.qz = z
      const inside = this.zone(k)
      const ox = this.zox, oz = this.zoz
      // how near the rider: by the guess zone() made (a carve comes back), or, if nearer, with
      // the rider holding the heading it has now (a turn that was meant: believed as far as
      // the heading has been held, in full after two seconds)
      const hx = x - this.rgx - this.rvx * tau, hz = z - this.rz - this.rvz * tau
      let dk = Math.sqrt(ox * ox + oz * oz)
      const dh = Math.sqrt(hx * hx + hz * hz)
      if (dh < dk) dk += (dh - dk) * (tau <= 2.5 ? 1 : this.meant)
      if (inside) {
        if (this.pTow > 0) cost += w * (60 + 3 * this.pTow)
        if (this.pStrip > 0) cost += w * this.course * (40 + 2 * this.pStrip)
        if (this.pWedge > 0) {
          // far down the corridor, and in the last quarter of its length, being a few metres
          // inside is no one's business
          let near = dk < 78 ? 1 : dk > 260 ? 0.3 : 1.3 - dk / 260
          const tail = (ox * mx + oz * mz) / this.ahead
          if (tail > 0.75) near *= tail > 1 ? 0.2 : 1 - (tail - 0.75) * 3.2
          cost += w * near * (4 + 0.6 * (this.pWedge < 45 ? this.pWedge : 45))
        }
      }
      // the rider itself: not near, and not toward it (a stopped sailor is slow to get going,
      // so one the rider will pass too close to moves while there is time)
      if (dk < inner) cost += (man === STOP && w < 0.6 ? 0.6 : w) * (150 + 8 * (inner - dk))
      else if (dk < outer && dk < dist - 0.2) cost += w * (60 + 3 * (outer - dk))
      dist = dk
      // never aground: the water where it would be, and as far on as it would carry in a few seconds
      if (v > 0.5) {
        const carry = v * 2.5 < 8 ? 8 : v * 2.5 > 30 ? 30 : v * 2.5
        let aground = false
        for (let m = 0; m <= 2 && !aground; m++) {
          this.wx = x + cp * carry * 0.5 * m
          this.wz = z + sp * carry * 0.5 * m
          this.sound()
          aground = this.depth < minDepth
        }
        if (aground) {
          this.cost = cost + 5000
          return
        }
      }
      // a reach ends at the end of its lane, and getting out of the way does not go far past it
      if (man === REACH) { if ((d > 0 && z > zMax) || (d < 0 && z < zMin)) cost += 60 * w }
      else if (man === AIM && (z > zMax + 80 || z < zMin - 80)) cost += 20 * w
      // never across the rider's bow (within 60 m; further off it matters less, and not at all by 150 m)
      if (sideC !== 0) {
        const lat = oz * fux - ox * fuz
        if (lat * sideC < 0) {
          const along = ox * fux + oz * fuz
          if (along > -10 && along < 150) cost += along < 60 ? 300 : (300 * (150 - along)) / 90
          sideC = 0
        }
      }
      if (sideM !== 0) {
        const lat = oz * mx - ox * mz
        if (lat * sideM < 0) {
          const along = ox * mx + oz * mz
          if (along > -10 && along < 150) cost += along < 60 ? 300 : (300 * (150 - along)) / 90
          sideM = 0
        }
      }
      if (cost > bail) break
    }
    this.cost = cost
  }

  private setCourse(i: number, man: number, d: number, aim: number) {
    if (man === REACH && d !== this.dir[i]) { this.gybes[i]++; this.sinceGybe[i] = 0 }
    this.man[i] = man
    this.dir[i] = d
    this.aim[i] = aim
    this.hold[i] = man === REACH ? 0 : 1.2
    this.still[i] = 0
  }

  /** the heading sailor i is steering for (rad from downwind) */
  private wanted(i: number): number {
    const man = this.man[i]
    return man === REACH ? this.dir[i] * (HALF_PI + this.high(i)) : man === AIM ? this.aim[i] : this.dir[i] * (HALF_PI + LUFF)
  }

  /** choose sailor i's course */
  private plan(i: number) {
    const man = this.man[i]
    const d = this.dir[i]
    // a turn once begun is finished (a gybe cannot be thought better of every half second),
    // unless it has become a turn into trouble
    const err = this.wanted(i) - this.psi[i]
    const turning = err > 0.3 || err < -0.3
    if (turning) {
      this.bail = 100
      this.evaluate(i, man, d, -1)
      if (this.cost < 100) return
    }
    if (man === REACH) {
      if (!turning && this.quickClear(i)) return
    } else {
      if (this.hold[i] <= 0) {
        // stopped, or holding a heading to get clear: back to the lane as soon as a reach is clean
        this.bail = 1
        this.evaluate(i, REACH, d, 0)
        if (this.cost < 1) { this.setCourse(i, REACH, d, 0); return }
        this.evaluate(i, REACH, -d, 0)
        if (this.cost < 1) { this.setCourse(i, REACH, -d, 0); return }
        // no reach yet, but clear enough to stop running: wait here for the rider to go by
        // (and stop anyway, if that is nearly as good, once well downwind of the lane)
        if (man === AIM) {
          this.bail = 25
          this.evaluate(i, STOP, d, 2)
          if (this.cost < (this.gx[i] - this.homeX[i] > 150 ? 25 : 1)) { this.setCourse(i, STOP, d, 0); return }
        }
        // stopped a long time with no way back along the lane (carried somewhere odd getting
        // out of the way): work round on whichever other heading is open, toward the lane
        if (man === STOP && this.still[i] > 15) {
          const back = this.z[i] > 0.5 * (this.zMin[i] + this.zMax[i]) ? -1 : 1
          this.bail = 1
          for (let c = 3; c < C_MAN.length; c++) {
            if (C_TACK[c] < 0) continue
            this.evaluate(i, AIM, back, c)
            if (this.cost < 1) {
              this.setCourse(i, AIM, back, back * C_AIM[c])
              this.hold[i] = 6
              return
            }
          }
          this.still[i] = 0
        }
      }
      // otherwise carry on while that keeps clear
      this.bail = 25
      this.evaluate(i, man, d, -1)
      if (this.cost < 25) return
    }
    // in or near the kept-clear water now: sprint
    this.qx = this.gx[i]
    this.qz = this.z[i]
    if (this.zone(0) || this.zox * this.zox + this.zoz * this.zoz < KEEP_OUT.lookAhead * KEEP_OUT.lookAhead) this.hurry[i] = 1.5
    // The least bad of everything a sailor can do. The present course wins a near tie, and
    // a way of getting clear, once chosen, is given up only for one that is a good deal
    // better: half the cost in its first second, three quarters after (a sailor that changes
    // its mind every second gets nowhere, and looks lost).
    let cur = 0
    if (man === STOP) cur = 2
    else if (man === AIM) {
      const a = Math.abs(this.aim[i])
      for (let c = 3; c < C_MAN.length; c++) if (C_TACK[c] === 1 && Math.abs(C_AIM[c] - a) < 0.01) cur = c
    }
    // (a sailor already carried well downwind of its lane is the more reluctant to run further:
    // it stops, or works out to the side, and lets the rider go by)
    const off = this.gx[i] - this.homeX[i] - 100
    const far = off > 0 ? off * 0.15 : 0
    // (and one that has just gybed would sooner stop than gybe straight back: no pacing up and down a short stretch)
    const again = this.sinceGybe[i] < 9 ? 18 - 2 * this.sinceGybe[i] : 0
    this.bail = Infinity
    this.evaluate(i, man, d, -1)
    const curCost = this.cost + C_COST[cur] + (man === AIM ? (cur === 5 ? far : 0.5 * far) : 0)
    let best = cur, bestCost = man === REACH ? curCost - 4 : this.hold[i] > 0 ? 0.5 * curCost - 20 : 0.75 * curCost - 10
    for (let c = 0; c < C_MAN.length; c++) {
      if (c === cur) continue
      const cm = C_MAN[c]
      this.bail = bestCost
      this.evaluate(i, cm, d * C_TACK[c], c)
      const cost = this.cost + C_COST[c] + (cm === AIM ? (c === 5 ? far : 0.5 * far) : c === 1 ? again : 0)
      if (cost < bestCost) { bestCost = cost; best = c }
    }
    if (best === cur) return
    const bm = C_MAN[best]
    const bd = d * C_TACK[best]
    this.setCourse(i, bm, bd, bm === AIM ? bd * C_AIM[best] : 0)
  }

  /** The rider was placed somewhere: clear the kept-clear water at once (the camera cuts too). */
  reset() {
    const K = KEEP_OUT
    this.angLo = this.angHi = 0
    this.steadyT = 0
    this.look(0)
    for (let i = 0; i < this.n; i++) {
      this.man[i] = REACH
      this.om[i] = 0
      this.hold[i] = 0
      this.hurry[i] = 0
      this.still[i] = 0
      this.vel[i] = this.speed[i]
      this.psi[i] = this.dir[i] * HALF_PI
      const x = this.gx[i], z0 = this.z[i]
      const blocked = (z: number) => { this.qx = x; this.qz = z; return this.zone(0) || this.zox * this.zox + this.zoz * this.zoz < K.lookAhead * K.lookAhead }
      if (!blocked(z0)) continue
      // out to the nearer side, a little way clear, unless that is a bank or a shoal
      const extra = 8 + (i % 5) * 7
      const depth = this.minDepth[i]
      let found = 0, at = z0
      for (let step = 6; step <= 420 && !found; step += 6) {
        for (let side = -1; side <= 1; side += 2) {
          const z = z0 + side * step
          if (blocked(z) || blocked(z + side * extra)) continue
          if (LEVEL.waterDepth(x, z + side * extra) < depth || LEVEL.waterDepth(x, z + side * (extra + 40)) < depth) continue
          found = side
          at = z + side * extra
          break
        }
      }
      if (found) {
        this.z[i] = at
        this.dir[i] = found
        this.psi[i] = found * HALF_PI
      } else {
        // no room abeam: wait where it is, and let the plan find the way out
        this.man[i] = STOP
        this.vel[i] = 0
      }
    }
    // A few sails close at hand from the first frame, for the look of the place (the camera
    // has just cut, so nobody sees them put there): two either side, just outside the
    // corridor 48 and 90 m ahead of the rider, sailing away from it. Each is the sailor whose
    // lane is nearest that spot (within 150 m; it works back to its lane from there).
    const taken: number[] = []
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < 2; k++) {
        const ox = 48 + 42 * k
        const x = this.rgx + ox
        const z = this.rz + side * (K.halfWidth + K.widen * ox + 10 + 8 * k)
        this.qx = x
        this.qz = z
        if (this.zone(0) || this.zox * this.zox + this.zoz * this.zoz < (K.lookAhead + 4) * (K.lookAhead + 4)) continue
        let best = -1, bestOff = 150
        for (let i = 0; i < this.active; i++) {
          if (this.kind[i] === KITE || taken.includes(i)) continue
          const off = Math.abs(this.homeX[i] - x)
          if (off >= bestOff || z < this.zMin[i] + 10 || z > this.zMax[i] - 10) continue
          if (LEVEL.waterDepth(x, z) < this.minDepth[i] || !this.deepFrom(i, x, z, side)) continue
          best = i
          bestOff = off
        }
        if (best < 0) continue
        taken.push(best)
        this.gx[best] = x
        this.z[best] = z
        this.dir[best] = side
        this.psi[best] = side * HALF_PI
        this.man[best] = REACH
        this.vel[best] = this.speed[best]
      }
    }
  }

  update(dt: number) {
    const app = this.app
    this.now = app.time
    this.shift = app.groundShift
    this.look(dt)
    this.readWaterGrid()
    const rgx = this.rgx, rz = this.rz
    const reachX = this.ahead + 110
    // the tow's bow, for a cheap test of who is anywhere near it
    const towX = this.tax + this.tex * 0.6, towZ = this.taz + this.tez * 0.6
    this.frame++
    const n = this.active
    for (let i = 0; i < n; i++) {
      const ox = this.gx[i] - rgx, oz = this.z[i] - rz
      if (this.hold[i] > 0) this.hold[i] -= dt
      if (this.hurry[i] > 0) this.hurry[i] -= dt
      let d = this.dir[i]
      let man = this.man[i]
      if (man === STOP) this.still[i] += dt
      this.sinceGybe[i] += dt

      // ---- choose a course ----
      let near = (ox > -170 && ox < reachX && Math.abs(oz) < 120 + 0.9 * (ox > 0 ? ox : 0)) || ox * ox + oz * oz < 240 * 240
      if (!near && this.towOn) {
        const tx = this.gx[i] - towX, tz = this.z[i] - towZ
        near = tx * tx + tz * tz < 420 * 420
      }
      if (near || man !== REACH) {
        if (((this.frame + i) & 3) === 0 || man !== REACH || this.hurry[i] > 0) {
          this.plan(i)
          d = this.dir[i]
          man = this.man[i]
        }
      } else if (((this.frame + i) & 7) === 0 && this.psi[i] * d > 0) {
        // far from the rider and the tow: sail the lane, and think only at its ends and off the shoals
        const z = this.z[i]
        if ((d > 0 && z > this.zMax[i]) || (d < 0 && z < this.zMin[i]) || !this.deepAhead(i, d)) {
          this.plan(i)
          d = this.dir[i]
          man = this.man[i]
        }
      }

      // ---- steer and move ----
      // The heading swings toward the one wanted at up to the rate of a gybe, gathering and
      // losing that rate smoothly, and always round through downwind (headings never wrap,
      // so a change of tack is a gybe). A change of mind in mid-turn carries the turn on.
      const want = man === REACH ? d * (HALF_PI + this.high(i)) : man === AIM ? this.aim[i] : d * (HALF_PI + LUFF)
      const rateMax = (1.25 * Math.PI) / this.turnTime[i]
      let rate = (want - this.psi[i]) * 2
      rate = rate > rateMax ? rateMax : rate < -rateMax ? -rateMax : rate
      let om = this.om[i]
      const dOm = rate - om, step = rateMax * 2.2 * dt
      om += dOm > step ? step : dOm < -step ? -step : dOm
      this.om[i] = om
      this.psi[i] += om * dt
      // a turn costs speed
      const dip = 0.32 * Math.min(1, Math.abs(om) / rateMax)
      const cruise = this.speed[i]
      const vT = (man === STOP ? 0 : man === AIM ? aimSpeed(cruise, this.aim[i]) : this.hurry[i] > 0 ? cruise * HURRY : cruise) * (1 - dip)
      let v = this.vel[i]
      const dv = vT - v
      v += dv > 0 ? Math.min(dv, ACCEL * dt) : Math.max(dv, -BRAKE * dt)
      this.vel[i] = v
      const psi = this.psi[i]
      this.gx[i] += Math.cos(psi) * v * dt
      this.z[i] += Math.sin(psi) * v * dt

      // ---- ride height: on the water as it is drawn there ----
      this.ride(i)
    }
  }

  /**
   * Find the water mesh and read the sizes of its rings from its uniforms. (The water module
   * does not publish them; they are what decides how much of each wave is drawn at a given
   * distance from the rider: see ride.) Without them the height fades out between 60 and 240 m.
   */
  private readWaterGrid() {
    if (this.waterMesh && this.waterMesh.parent === null) this.waterMesh = null
    if (!this.waterMesh) {
      this.ringCount = 0
      if ((this.frame & 31) !== 0) return
      this.waterMesh = (this.app.scene.getObjectByName('water') as unknown as Fleet['waterMesh']) ?? null
      if (!this.waterMesh) return
    }
    const u = this.waterMesh.material?.uniforms
    const morph = u?.uMorph?.value as { x: number; y: number; z: number }[] | undefined
    const grid = u?.uGrid?.value as { x: number; z: number; w: number } | undefined
    if (!morph || !grid || !(morph.length > 0) || !(grid.w > grid.z) || !(grid.x > 0)) { this.ringCount = 0; return }
    const count = Math.min(8, morph.length)
    for (let l = 0; l < count; l++) {
      const m = morph[l]
      if (!m || !(m.x > 0)) { this.ringCount = 0; return }
      this.ring[l * 3] = m.x
      this.ring[l * 3 + 1] = m.y
      this.ring[l * 3 + 2] = m.z
    }
    this.ringCount = count
    this.cell0 = grid.x
    this.rimLo = grid.z
    this.rimHi = grid.w
  }

  /**
   * Put sailor i on the water as the water module draws it there: the physics surface near
   * the rider, with each wave fading out where the mesh's cells grow too coarse to carry it,
   * and flat beyond the mesh's rim. Mirrors the vertex shader in water/shaders.ts.
   */
  private ride(i: number) {
    const gx = this.gx[i], z = this.z[i]
    const qx = gx - this.rgx, qz = z - this.rz
    const dist = Math.sqrt(qx * qx + qz * qz)
    let h = 0
    let cell = 0
    let drawn = true
    if (this.ringCount > 0) {
      const cheb = Math.max(Math.abs(qx), Math.abs(qz))
      if (cheb >= this.rimHi) drawn = false
      else {
        let c = 1, w = 1
        const ring = this.ring
        for (let l = 0; l < this.ringCount; l++) {
          const a = (dist / ring[l * 3] - ring[l * 3 + 1]) * ring[l * 3 + 2]
          c += w * (a < 0 ? 0 : a > 1 ? 1 : a)
          w *= 2
        }
        cell = c * this.cell0
        if (cheb > this.rimLo) {
          const u = (cheb - this.rimLo) / (this.rimHi - this.rimLo)
          cell += 1000 * u * u * (3 - 2 * u)
        }
      }
    } else if (dist > 240) drawn = false
    if (drawn) {
      const x = gx + this.shift, t = this.now
      const waves = this.app.sim.waves
      const n = waves.n, a = waves.a, k = waves.k, w = waves.w, dx = waves.dx, dz = waves.dz, ph = waves.ph
      let s1 = 0, sh = 0
      for (let j = 0; j < n; j++) {
        const kc = k[j] * cell
        if (kc >= 2.1) continue
        let amp = a[j]
        if (kc > 0.9) {
          const u = (kc - 0.9) / 1.2
          amp *= 1 - u * u * (3 - 2 * u)
        }
        const th = k[j] * (dx[j] * x + dz[j] * z) - w[j] * t + ph[j]
        s1 += amp * Math.cos(th)
        sh += amp * Math.sin(th)
      }
      if (s1 !== 0 || sh !== 0) {
        const E = waves.envelope(x, z, t)
        h = E * s1 + E * E * (waves.K * (s1 * s1 - sh * sh) + 2 * waves.S * s1 * sh)
        if (this.ringCount === 0 && dist > 60) h *= (240 - dist) / 180
      }
    }
    if (this.kind[i] === WING) {
      // a foil flies through the chop, 0.7 m up on its mast; stopped, the board is down on the water
      const v = this.vel[i]
      const down = v > 5.5 ? 0 : v < 2.5 ? 1 : (5.5 - v) / 3
      this.y[i] = (0.45 + 0.55 * down) * h - 0.66 * down
    } else {
      this.y[i] = h
    }
  }

  /** write the instance buffers */
  write(wings: InstanceSet, windsurfers: InstanceSet, kites: InstanceSet) {
    let nw = 0, ns = 0, nk = 0
    const n = this.active
    for (let i = 0; i < n; i++) {
      const psi = this.psi[i]
      // rig to leeward; it swings across the board as the bow passes through downwind
      let side = -Math.sin(psi) * 3
      side = side > 1 ? 1 : side < -1 ? -1 : side
      const k = this.kind[i]
      if (k === WING) {
        if (nw < wings.capacity) wings.setCraft(nw++, this.gx[i], this.y[i], this.z[i], psi, side, this.phase[i], this.lean[i], this.colA[i], this.colB[i])
      } else if (k === WINDSURF) {
        if (ns < windsurfers.capacity) windsurfers.setCraft(ns++, this.gx[i], this.y[i], this.z[i], psi, side, this.phase[i], this.lean[i], this.colA[i], this.colB[i])
      } else if (nk < kites.capacity) {
        kites.setCraft(nk++, this.gx[i], this.y[i], this.z[i], psi, side, this.phase[i], this.lean[i], this.colA[i], this.colB[i])
      }
    }
    wings.commit(nw)
    windsurfers.commit(ns)
    kites.commit(nk)
  }

  private readonly _where = { x: 0, y: 0, z: 0, kind: 0 }
  /** ground position of sailor i (a shared object: read it at once) */
  where(i: number): { x: number; y: number; z: number; kind: number } {
    const w = this._where
    w.x = this.gx[i]; w.y = this.y[i]; w.z = this.z[i]; w.kind = this.kind[i]
    return w
  }

  /** for tests: everything about sailor i (`turn` is the progress of a gybe, -1 when not gybing) */
  describe(i: number) {
    // (still on the other tack's side of downwind, or not yet round to the reach)
    const err = Math.abs(this.wanted(i) - this.psi[i])
    const gybing = this.man[i] === REACH && err > 0.3 && (this.psi[i] * this.dir[i] < 0 || err > 1)
    return {
      kind: this.kind[i], x: this.gx[i], z: this.z[i], y: this.y[i], heading: this.psi[i], dir: this.dir[i], turn: gybing ? Math.max(0, 1 - err / Math.PI) : -1, gybes: this.gybes[i],
      zMin: this.zMin[i], zMax: this.zMax[i], homeX: this.homeX[i], speed: this.speed[i], vel: this.vel[i], man: this.man[i], aim: this.aim[i],
      minDepth: this.minDepth[i],
    }
  }

  /** for tests: what each course in the list above would cost sailor i now (reluctance included) */
  explain(i: number): number[] {
    const d = this.dir[i]
    const out: number[] = []
    for (let c = 0; c < C_MAN.length; c++) {
      const cd = d * C_TACK[c]
      this.bail = Infinity
      this.evaluate(i, C_MAN[c], cd, c)
      out.push(Math.round(this.cost + C_COST[c]))
    }
    return out
  }

  /** for tests: is a ground point in the kept-clear water now (0 = no, else metres inside)? */
  keptClear(x: number, z: number): number {
    this.qx = x
    this.qz = z
    this.zone(0)
    const d = Math.sqrt(this.zox * this.zox + this.zoz * this.zoz)
    return Math.max(this.pWedge, this.pStrip, this.pTow, d < KEEP_OUT.bubble ? KEEP_OUT.bubble - d : 0)
  }

  /** for tests: the shallowest water under any drawn sailor right now */
  shallowest(): { depth: number; x: number; z: number; kind: number } {
    let best = { depth: Infinity, x: 0, z: 0, kind: 0 }
    for (let i = 0; i < this.active; i++) {
      const d = LEVEL.waterDepth(this.gx[i], this.z[i])
      if (d < best.depth) best = { depth: d, x: this.gx[i], z: this.z[i], kind: this.kind[i] }
    }
    return best
  }

  /** for the report and for tests: ground positions of the drawn sailors */
  positions(): { kind: number; x: number; z: number }[] {
    const out: { kind: number; x: number; z: number }[] = []
    for (let i = 0; i < this.active; i++) out.push({ kind: this.kind[i], x: this.gx[i], z: this.z[i] })
    return out
  }
}

/** speed while holding a heading to get out of the way: a sprint off the wind, slow when pinching up */
function aimSpeed(cruise: number, aim: number): number {
  if (aim > 1.8 || aim < -1.8) return cruise * 0.75
  return Math.max(cruise, Math.min(cruise * FLEE, 13.5))
}
