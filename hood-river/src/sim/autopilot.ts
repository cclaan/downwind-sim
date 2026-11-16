/**
 * A look-ahead autopilot: the stand-in for a skilled rider.
 *
 * Every decision it tries a handful of steering plans on a copy of the rider, rolls the
 * real physics forward a couple of seconds over the real (deterministic) wave field, and
 * keeps the plan that ends with the most energy without getting close to a stall. It reads
 * the bumps the only honest way a program can: by trying them.
 *
 * Used to check that the sea is rideable by carving alone, to render reference clips, and
 * later perhaps as a ghost or coach line.
 */
import type { Sim } from './harness'
import { makeRider, stepRider } from './physics'
import { makeControls, type RiderState } from './types'
import { makeWaveSample } from './waves'

export interface AutopilotOptions {
  /** seconds of look-ahead */
  horizon: number
  /** seconds between decisions */
  interval: number
  /** pump when even the best plan dips below this multiple of stall speed */
  pumpBelow: number
  /** weight on downwind progress (m of progress per unit score) */
  downwind: number
  /** allow pumping at all */
  allowPump: boolean
  /** largest heading away from downwind the pilot will plan for (rad) */
  maxHeading: number
}

export const DEFAULT_AUTOPILOT: AutopilotOptions = {
  horizon: 2.4,
  interval: 0.15,
  pumpBelow: 1.25,
  downwind: 0.35,
  allowPump: true,
  maxHeading: (80 * Math.PI) / 180,
}

const STEERS = [-1, -0.55, 0, 0.55, 1]
const STEERS3 = [-0.9, 0, 0.9]
const ONE = [0]

export class Autopilot {
  opt: AutopilotOptions
  private scratch: RiderState = makeRider()
  private ctl = makeControls()
  private nextDecision = -1
  private steer = 0
  private pump = false
  /** score of the chosen plan and of the worst one, for debugging and HUD hints */
  lastBest = 0
  lastWorst = 0

  constructor(opt: Partial<AutopilotOptions> = {}) {
    this.opt = { ...DEFAULT_AUTOPILOT, ...opt }
  }

  reset() {
    this.nextDecision = -1
    this.steer = 0
    this.pump = false
  }

  /** Set sim.c for the coming step (foil mode only; other modes are left to the caller). */
  drive(sim: Sim): void {
    const s = sim.s
    if (s.mode !== 'foil') return
    if (s.t >= this.nextDecision) {
      this.decide(sim)
      this.nextDecision = s.t + this.opt.interval
    }
    sim.c.steer = this.steer
    sim.c.pitch = 0
    sim.c.action = this.pump
  }

  private decide(sim: Sim) {
    const o = this.opt
    const dt = sim.dt * 2 // plan at half rate: plenty for choosing a line
    const n = Math.round(o.horizon / dt)
    const seg = this.plan
    let best = -Infinity
    let worst = Infinity
    let bestSteer = 0
    let bestMinV = 0
    const S = o.horizon > 3.2 ? STEERS3 : STEERS
    for (const a of STEERS) {
      for (const b of S) {
        for (const c of o.horizon > 3.2 ? S : ONE) {
          seg[0] = a; seg[1] = b; seg[2] = o.horizon > 3.2 ? c : b
          const r = this.rollout(sim, seg, n, dt)
          // prefer plans that start the way we are already leaning (less twitchy)
          const score = r.score - 0.08 * Math.abs(a - this.steer)
          if (score > best) { best = score; bestSteer = a; bestMinV = r.minV }
          if (score < worst) worst = score
        }
      }
    }
    this.steer = bestSteer
    this.lastBest = best
    this.lastWorst = worst
    // pump early: a pump only works with lift to spare, so waiting for the stall is too late
    this.pump = o.allowPump && (bestMinV < o.pumpBelow * sim.D.vStall || sim.s.speed < (o.pumpBelow + 0.08) * sim.D.vStall)
  }

  private plan = [0, 0, 0]

  private rollout(sim: Sim, seg: number[], n: number, dt: number) {
    const s = this.scratch
    Object.assign(s, sim.s)
    const c = this.ctl
    c.pitch = 0
    c.action = false
    c.actionPressed = false
    let minV = Infinity
    let penalty = 0
    const x0 = s.x
    const n1 = Math.round(n * 0.28), n2 = Math.round(n * 0.62)
    for (let i = 0; i < n; i++) {
      c.steer = i < n1 ? seg[0] : i < n2 ? seg[1] : seg[2]
      stepRider(s, c, sim.waves, sim.P, sim.D, dt)
      if (s.mode !== 'foil') { penalty += 60; break }
      if (s.speed < minV) minV = s.speed
      if (s.touching) penalty += 0.02
      if (s.breached) penalty += 0.05
      if (Math.abs(s.heading) > this.opt.maxHeading) penalty += 0.03
    }
    const vs = sim.D.vStall
    // energy per unit mass at the end, plus progress downwind, minus stall risk
    const energy = 0.5 * s.speed * s.speed
    const margin = minV / vs
    const risk = margin < 1.25 ? (1.25 - margin) * 40 : 0
    const score = energy + this.opt.downwind * (s.x - x0) - risk - penalty
    return { score, minV }
  }
}


// ---------------------------------------------------------------------------------------
// the reader: steering by what a rider can see
// ---------------------------------------------------------------------------------------

export interface ReaderOptions {
  /** how far ahead in time the rider imagines the line (s) */
  look: number
  /** seconds between decisions */
  interval: number
  /** widest course off downwind it will choose (rad) */
  maxHeading: number
  /** how hard it leans to get there, 0..1 */
  lean: number
  /** reluctance to change course (score per radian) */
  turnCost: number
  /** stay within this many metres either side of the line the ride started on */
  band: number
}

export const DEFAULT_READER: ReaderOptions = {
  look: 1.5,
  interval: 0.25,
  maxHeading: (60 * Math.PI) / 180,
  lean: 0.9,
  turnCost: 0.15,
  band: 120,
}

const _rs = makeWaveSample()

/**
 * A human-like pilot. It uses only the surface as it is now: for each course it could
 * steer, it looks along that line (sliding the picture back at bump speed, as the eye
 * does) and picks the one over the most rising water, the steep faces. No knowledge of
 * the future and no trial runs. It is the benchmark for "reading the bumps": it should
 * out-ride a straight line easily and need few pumps.
 */
export class Reader {
  opt: ReaderOptions
  private next = -1
  private target = 0
  private homeZ = NaN

  constructor(opt: Partial<ReaderOptions> = {}) {
    this.opt = { ...DEFAULT_READER, ...opt }
  }

  reset() {
    this.next = -1
    this.target = 0
    this.homeZ = NaN
  }

  /** the course it is steering for (rad off downwind), for drawing a coach line */
  get course(): number {
    return this.target
  }

  /** Set sim.c.steer for the coming step (foil mode). Pumping is left to the caller. */
  drive(sim: Sim): void {
    const s = sim.s
    if (s.mode !== 'foil') return
    const o = this.opt
    if (s.t >= this.next) {
      this.next = s.t + o.interval
      const w = sim.waves
      const dir = (w.params.dirDeg * Math.PI) / 180
      const cx = Math.cos(dir) * w.cp, cz = Math.sin(dir) * w.cp
      const track = s.heading - s.slip
      if (Number.isNaN(this.homeZ)) this.homeZ = s.z
      let best = -Infinity
      const step = (10 * Math.PI) / 180
      for (let h = -o.maxHeading; h <= o.maxHeading + 1e-6; h += step) {
        let score = 0, n = 0
        for (let tau = 0.3; tau <= o.look + 1e-6; tau += 0.3) {
          // where I would be, on the present picture slid back by the bumps' own travel
          const px = s.x + Math.cos(h) * s.speed * tau - cx * tau
          const pz = s.z + Math.sin(h) * s.speed * tau - cz * tau
          w.sample(px, pz, s.t, Infinity, _rs)
          score += _rs.uy
          n++
        }
        const zAhead = s.z + Math.sin(h) * s.speed * 4
        score = score / n - o.turnCost * Math.abs(h - track) + 0.05 * Math.cos(h) - 0.02 * Math.max(0, Math.abs(zAhead - this.homeZ) - o.band)
        if (score > best) { best = score; this.target = h }
      }
    }
    let e = this.target - (s.heading - s.slip)
    while (e > Math.PI) e -= 2 * Math.PI
    while (e < -Math.PI) e += 2 * Math.PI
    sim.c.steer = Math.max(-o.lean, Math.min(o.lean, e * 2.2))
  }
}
