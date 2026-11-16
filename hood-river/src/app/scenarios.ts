/**
 * Scripted pilots. They drive the same Controls the player does, so they are used for
 * headless physics checks, for rendering reference clips (?scenario=carve) and as demos.
 */
import { Autopilot, Reader } from '../sim/autopilot'
import type { Sim } from '../sim/harness'
import { makeWaveSample, type WaveField } from '../sim/waves'
import type { RiderState } from '../sim/types'
import { STARTS } from '../sim/level'

/** where scripted runs begin: the best water off the Hatchery, in the frame of the water */
function launch(sim: Sim, foilSpeed?: number) {
  const spot = STARTS.hatchery
  sim.start({ x: spot.x + sim.waves.groundShiftAt(sim.s.t), z: spot.z, foilSpeed, onFace: true, t: sim.s.t })
}

export interface Scenario {
  name: string
  describe: string
  /** place the rider; called once when the scenario starts */
  start(sim: Sim): void
  /** set sim.c for the coming step */
  pilot(sim: Sim): void
}

const DEG = Math.PI / 180
const ws = makeWaveSample()

/** steer toward a heading (rad, 0 = downwind) with a proportional lean */
function steerTo(sim: Sim, heading: number, gain = 2.2, limit = 1): number {
  let e = heading - sim.s.heading
  while (e > Math.PI) e -= 2 * Math.PI
  while (e < -Math.PI) e += 2 * Math.PI
  return Math.max(-limit, Math.min(limit, e * gain))
}

function clearControls(sim: Sim) {
  sim.c.steer = 0
  sim.c.pitch = 0
  sim.c.action = false
}

/** weave either side of downwind: the basic surfy line */
function makeCarve(name: string, describe: string, angleDeg: number, lean: number, foilSpeed: number): Scenario {
  let dir = 1
  return {
    name, describe,
    start(sim) { dir = 1; launch(sim, foilSpeed) },
    pilot(sim) {
      clearControls(sim)
      const s = sim.s
      if (s.mode === 'paddle') { paddleUpPilot(sim); return }
      if (s.mode !== 'foil') return
      const lim = angleDeg * DEG
      if (s.heading > lim) dir = -1
      else if (s.heading < -lim) dir = 1
      sim.c.steer = dir * lean
      // keep it alive: pump when slow
      if (s.speed < sim.D.vStall * 1.2) sim.c.action = true
    },
  }
}

/** paddle through the trough, sprint when the face behind starts to lift the tail */
/**
 * The paddle-up cue: true while the board is on a face, or a face is about to arrive from
 * behind. The scripted pilot sprints on it and the HUD lights its sprint prompt on it, so
 * what the game tells the player and what the bots do cannot drift apart.
 */
export function paddleFace(s: RiderState, waves: WaveField): boolean {
  const fx = Math.cos(s.heading), fz = Math.sin(s.heading)
  // slope along the heading: negative = downhill ahead = on a face
  const slope = s.slopeX * fx + s.slopeZ * fz
  waves.sample(s.x - fx * 5, s.z - fz * 5, s.t, Infinity, ws)
  const behindHigher = ws.eta - s.eta
  return slope < -0.05 || (behindHigher > 0.12 && slope < 0.04)
}

export function paddleUpPilot(sim: Sim) {
  const s = sim.s
  // point downwind
  sim.c.steer = steerTo(sim, 0, 1.5)
  if (paddleFace(s, sim.waves)) {
    // sprint: tap as fast as strokes allow
    sim.c.action = true
    if (s.strokePhase < 0 || s.strokePhase > 0.55) sim.c.actionPressed = true
  } else {
    // cruise only while there is breath to spare
    const slope = s.slopeX * Math.cos(s.heading) + s.slopeZ * Math.sin(s.heading)
    sim.c.action = s.stamina > 0.5 && slope < 0.08
  }
}

export const SCENARIOS: Record<string, () => Scenario> = {
  carve: () => makeCarve('carve', 'S-turns 50 degrees either side of downwind', 50, 0.85, 6.8),
  longturns: () => makeCarve('longturns', 'drawn-out turns, 65 degrees either side, gentle lean', 65, 0.5, 7.2),
  glide: () => ({
    name: 'glide', describe: 'on foil, no input',
    start(sim) { launch(sim, 7) },
    pilot(sim) { clearControls(sim) },
  }),
  pump: () => ({
    name: 'pump', describe: 'on foil, pumping steadily, straight downwind',
    start(sim) { launch(sim, 5.5) },
    pilot(sim) {
      clearControls(sim)
      if (sim.s.mode === 'foil') { sim.c.steer = steerTo(sim, 0, 1.2, 0.4); sim.c.action = true }
    },
  }),
  paddleup: () => ({
    name: 'paddleup', describe: 'start floating, time the sprint to a bump, then carve',
    start(sim) { launch(sim) },
    pilot: (() => {
      let dir = 1
      return (sim: Sim) => {
        clearControls(sim)
        const s = sim.s
        if (s.mode === 'paddle') { paddleUpPilot(sim); return }
        if (s.mode !== 'foil') return
        if (s.modeTime < 2.5) {
          // first seconds on foil: straight, pumping to get clear of the stall
          sim.c.steer = steerTo(sim, 0, 1.2, 0.4)
          if (s.speed < sim.D.vStall * 1.35) sim.c.action = true
          return
        }
        const lim = 45 * DEG
        if (s.heading > lim) dir = -1
        else if (s.heading < -lim) dir = 1
        sim.c.steer = dir * 0.75
        if (s.speed < sim.D.vStall * 1.2) sim.c.action = true
      }
    })(),
  }),
}

/** the look-ahead pilot: paddles up on a bump, then rides by trying lines a few seconds ahead */
SCENARIOS.auto = () => {
  const ap = new Autopilot()
  return {
    name: 'auto', describe: 'look-ahead autopilot: paddle up, then read the bumps',
    start(sim) { ap.reset(); launch(sim) },
    pilot(sim) {
      clearControls(sim)
      if (sim.s.mode === 'paddle') paddleUpPilot(sim)
      else if (sim.s.mode === 'foil') ap.drive(sim)
    },
  }
}
SCENARIOS.autofoil = () => {
  const ap = new Autopilot()
  return {
    name: 'autofoil', describe: 'look-ahead autopilot, starting on foil',
    start(sim) { ap.reset(); launch(sim, 6.8) },
    pilot(sim) {
      clearControls(sim)
      if (sim.s.mode === 'paddle') paddleUpPilot(sim)
      else if (sim.s.mode === 'foil') ap.drive(sim)
    },
  }
}

/**
 * The line from the owner's "long turns" clip: traverse back up to the crest, top turn
 * through downwind, drop, bottom turn in the trough, traverse the other way. Timed off the
 * wave under the rider (state.crest: +1 on a crest, -1 in a trough), so it holds one bump
 * for as long as the bump lasts. Best seen with ?conditions=clean or nuking.
 */
SCENARIOS.sturn = () => {
  let side = 1
  let phase: 'traverse' | 'top' | 'drop' | 'bottom' = 'drop'
  const TRAV = 72 * DEG, DROP = 25 * DEG
  const track = (sim: Sim) => sim.s.heading - sim.s.slip
  const aim = (sim: Sim, target: number, gain: number, limit: number) => {
    let e = target - track(sim)
    while (e > Math.PI) e -= 2 * Math.PI
    while (e < -Math.PI) e += 2 * Math.PI
    return Math.max(-limit, Math.min(limit, e * gain))
  }
  return {
    name: 'sturn', describe: 'S-turns timed to the bump: top turn, drop, bottom turn, traverse',
    start(sim) { side = 1; phase = 'drop'; launch(sim, sim.waves.cp + 2) },
    pilot(sim) {
      clearControls(sim)
      const s = sim.s
      if (s.mode === 'paddle') { paddleUpPilot(sim); phase = 'drop'; return }
      if (s.mode !== 'foil') return
      if (s.modeTime < 1.5 && s.takeoffs > 1) { sim.c.steer = aim(sim, 0, 1.2, 0.4); sim.c.action = true; return }
      const slow = s.speed < sim.D.vStall * 1.25
      if (phase === 'traverse') {
        sim.c.steer = aim(sim, side * TRAV, 2, 0.6)
        // the bump has caught up (high on the face) or the speed is gone: turn back down it
        if (s.crest > 0.3 || slow) { phase = 'top'; side = -side }
      } else if (phase === 'top') {
        sim.c.steer = side
        if (side * track(sim) > DROP * 0.6) phase = 'drop'
      } else if (phase === 'drop') {
        sim.c.steer = aim(sim, side * (DROP + 15 * DEG), 1.5, 0.45)
        if (s.crest < -0.35) phase = 'bottom'
      } else {
        sim.c.steer = aim(sim, side * TRAV, 2.5, 0.85)
        if (side * track(sim) > TRAV - 8 * DEG) phase = 'traverse'
      }
      // a pump or two if the bump has gone soft
      if (s.speed < sim.D.vStall * 1.18) sim.c.action = true
    },
  }
}

/** the reader: steers for the steep faces it can see, pumps only when slow. The demo of how the level is meant to be ridden. */
SCENARIOS.reader = () => {
  const r = new Reader()
  return {
    name: 'reader', describe: 'reads the bumps as a rider would: steers for rising water, pumps when slow',
    start(sim) { r.reset(); launch(sim) },
    pilot(sim) {
      clearControls(sim)
      const s = sim.s
      if (s.mode === 'paddle') { paddleUpPilot(sim); return }
      if (s.mode !== 'foil') return
      r.drive(sim)
      // pump in rhythm while slow
      if (s.speed < sim.D.vStall * 1.2) sim.c.action = true
    },
  }
}
SCENARIOS.readerfoil = () => {
  const base = SCENARIOS.reader()
  return { ...base, name: 'readerfoil', describe: 'the reader, starting on foil', start(sim) { base.start(sim); launch(sim, 6.8) } }
}

export function makeScenario(name: string): Scenario | null {
  const f = SCENARIOS[name]
  return f ? f() : null
}
