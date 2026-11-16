/**
 * Acceptance checks for the simulation: `npm test`. Headless, deterministic, a few seconds.
 * Each check states what a rider would expect and the band the numbers must fall in.
 */
import * as THREE from 'three'
import { riderMatrix } from '../src/app/frames'
import { makeScenario, paddleUpPilot } from '../src/app/scenarios'
import { Autopilot, Reader } from '../src/sim/autopilot'
import { Sim } from '../src/sim/harness'
import { STARTS } from '../src/sim/level'
import { groundX } from '../src/sim/physics'
import { cloneParams, type SimParams } from '../src/sim/params'
import { G, makeWaveSample } from '../src/sim/waves'

const ws = makeWaveSample()
const ws2 = makeWaveSample()
const f = (v: number, d = 2) => v.toFixed(d)
let failures = 0

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
}
const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi

function flat(): SimParams {
  const P = cloneParams()
  P.waves.hs = 0
  P.waves.useLevel = 0
  P.env.wind = 0
  P.env.current = 0
  return P
}

/** a Sim on open water: no riverbed, no banks (for flat-water and clean-wave checks) */
function openWater(P: SimParams): Sim {
  const sim = new Sim(P)
  sim.waves.level = null
  return sim
}

/** one clean wave train of height H (trough to crest) and period T, everywhere */
function regular(H = 1.2, T = 3.4): SimParams {
  const P = cloneParams()
  P.waves.count = 1
  P.waves.tp = T
  P.waves.hs = (H / 2) * 2 * Math.SQRT2
  P.waves.sharpen = 0
  P.waves.dirDeg = 0
  P.waves.useLevel = 0
  P.waves.channelHalfWidth = 1e6
  return P
}

// ---------------------------------------------------------------------------------------
// conventions (v1 had left and right swapped in one place; never again)
// ---------------------------------------------------------------------------------------
{
  const sim = openWater(flat())
  sim.start({ foilSpeed: 7 })
  sim.run(1.2, (m) => { m.c.steer = 1 })
  const s = sim.s
  check('steer right banks right and turns toward +z', s.bank > 0.2 && s.heading > 0.1 && s.vz > 0.2,
    `bank ${f(s.bank * 57.3, 0)} deg, heading ${f(s.heading * 57.3, 0)} deg, vz ${f(s.vz)}`)
  const m = riderMatrix({ ...s, heading: 0, pitch: 0, bank: 0.5 }, new THREE.Matrix4())
  const right = new THREE.Vector3().setFromMatrixColumn(m, 2)
  const up = new THREE.Vector3().setFromMatrixColumn(m, 1)
  const fwd = new THREE.Vector3().setFromMatrixColumn(m, 0)
  check('rider frame: +X nose, +Z starboard, right rail down when bank > 0',
    fwd.x > 0.99 && right.z > 0.8 && right.y < -0.4 && up.z > 0.4,
    `fwd ${fwd.toArray().map((v) => f(v)).join(',')} right ${right.toArray().map((v) => f(v)).join(',')}`)
  const mp = riderMatrix({ ...s, heading: 0, pitch: 0.3, bank: 0 }, new THREE.Matrix4())
  check('pitch > 0 lifts the nose', new THREE.Vector3().setFromMatrixColumn(mp, 0).y > 0.25, 'ok')
}

// ---------------------------------------------------------------------------------------
// wave field is self-consistent
// ---------------------------------------------------------------------------------------
{
  const sim = new Sim(cloneParams())
  const w = sim.waves
  let worst = 0, worstT = 0, worstH = 0
  for (let i = 0; i < 200; i++) {
    const x = -300 + i * 13.7, z = -420 + (i * 37) % 300, t = i * 1.37
    const e = 0.01
    w.sample(x, z, t, Infinity, ws)
    const dx = (w.height(x + e, z, t) - w.height(x - e, z, t)) / (2 * e)
    const dz = (w.height(x, z + e, t) - w.height(x, z - e, t)) / (2 * e)
    // the envelope's own gradient is deliberately ignored by the analytic slope; allow for it
    worst = Math.max(worst, Math.abs(dx - ws.dEdx), Math.abs(dz - ws.dEdz))
    // time derivative at a point fixed in the water frame; the level's map slides past, which
    // etaDot leaves out, so compare with the map frozen
    w.params.useLevel = 0
    w.sample(x, z, t, Infinity, ws2)
    const dt = (w.height(x, z, t + 1e-3) - w.height(x, z, t - 1e-3)) / 2e-3
    worstT = Math.max(worstT, Math.abs(dt - ws2.etaDot))
    w.params.useLevel = 1
    worstH = Math.max(worstH, Math.abs(w.height(x, z, t) - ws.eta))
  }
  check('analytic slope matches the surface', worst < 0.01, `max error ${f(worst, 4)}`)
  check('analytic rise rate matches the surface', worstT < 0.003, `max error ${f(worstT, 4)} m/s`)
  check('height() equals sample().eta', worstH < 1e-9, `max error ${worstH.toExponential(1)} m`)
  // water rises ahead of a crest and runs forward on top of it
  const r = openWater(regular(1.2, 3.4)).waves
  const xc = -r.ph[0] / r.k[0] // a crest at t = 0
  r.sample(xc, 0, 0, Infinity, ws)
  const crestForward = ws.ux
  r.sample(xc + Math.PI / 2 / r.k[0], 0, 0, Infinity, ws)
  check('orbital motion: forward on the crest, rising on the face ahead of it',
    crestForward > 1.0 && ws.uy > 1.0 && ws.dEdx < -0.15,
    `crest ux ${f(crestForward)}, face uy ${f(ws.uy)}, face slope ${f(ws.dEdx, 3)}`)
}

// ---------------------------------------------------------------------------------------
// flat water: glide, stall, pump, turn
// ---------------------------------------------------------------------------------------
{
  const sim = openWater(flat())
  check('stall speed of the 980 cm2 wing', within(sim.D.vStall, 3.85, 4.15), `${f(sim.D.vStall)} m/s (${f(sim.D.vStall * 1.944, 1)} kn)`)
  sim.start({ foilSpeed: 7 })
  let v6 = 0, t6 = 0, v6b = 0
  sim.run(30, undefined, (m) => {
    if (!t6 && m.s.speed <= 6.3) { t6 = m.s.t; v6 = m.s.speed }
    if (t6 && !v6b && m.s.t >= t6 + 0.5) v6b = m.s.speed
    if (m.s.mode !== 'foil') return false
  })
  const decel = (v6 - v6b) / 0.5
  check('glide: loses 0.55-0.95 m/s every second around 6 m/s', within(decel, 0.55, 0.95), `${f(decel)} m/s2`)
  check('glide: from 7 m/s a rider with no push is down in 4-7 s', within(sim.s.t, 4, 7), `${f(sim.s.t, 1)} s, ${f(sim.s.x, 0)} m`)
}
{
  const sim = openWater(flat())
  sim.start({ foilSpeed: 6 })
  let next = 0
  sim.run(200, (m) => { if (m.s.t >= next) { m.c.actionPressed = true; next = m.s.t + 1 / 1.6 } }, (m) => m.s.mode === 'foil')
  check('steady pumping at 1.6 Hz holds flight for the better part of a minute on flat water', within(sim.s.t, 35, 95), `${f(sim.s.t, 0)} s, stamina left ${f(sim.s.stamina)}`)
  const rest = openWater(flat())
  rest.start({ foilSpeed: 6 })
  rest.s._fast = 0; rest.s._slow = 0
  rest.run(40)
  check('a spent rider gets a sprint back within 40 s of rest', rest.s._fast / (rest.P.stamina.reserve * rest.P.stamina.fastShare) > 0.6,
    `quick store ${f(rest.s._fast / (rest.P.stamina.reserve * rest.P.stamina.fastShare))}, bar ${f(rest.s.stamina)}`)
}
{
  const sim = openWater(flat())
  sim.P.handling.stallGuard = 0
  sim.start({ foilSpeed: 7.4 })
  sim.run(0.8)
  // hold 0.75 of full bank and measure the steady turn between 0.8 and 1.6 s into it
  let h0 = 0, t0 = 0, v0 = 0, h1 = 0, t1 = 0, v1 = 0, bank = 0
  const tStart = sim.s.t
  sim.run(1.7, (m) => { m.c.steer = 0.75 }, (m) => {
    const tt = m.s.t - tStart
    if (!t0 && tt >= 0.8) { t0 = m.s.t; h0 = m.s.heading; v0 = m.s.speed }
    if (!t1 && tt >= 1.6) { t1 = m.s.t; h1 = m.s.heading; v1 = m.s.speed; bank = m.s.bank }
  })
  const rate = (h1 - h0) / (t1 - t0)
  const v = 0.5 * (v0 + v1)
  const expected = (G * Math.tan(bank)) / v
  check('banked turn rate is g tan(bank) / V', within(rate / expected, 0.85, 1.15),
    `${f(rate * 57.3, 0)} deg/s at ${f(bank * 57.3, 0)} deg and ${f(v)} m/s (theory ${f(expected * 57.3, 0)}), radius ${f(v / rate, 1)} m`)
}
{
  // no free energy from waggling on flat water
  const base = openWater(flat())
  base.start({ foilSpeed: 6.5 })
  base.run(3)
  let best = 0
  for (const hz of [0.5, 1, 2, 4]) {
    const sim = openWater(flat())
    sim.start({ foilSpeed: 6.5 })
    sim.run(3, (m) => { m.c.steer = Math.sin(2 * Math.PI * hz * m.s.t) > 0 ? 1 : -1 })
    best = Math.max(best, sim.s.speed)
  }
  check('waggling the board on flat water never beats gliding straight', best <= base.s.speed + 0.02, `best waggle ${f(best)} vs straight ${f(base.s.speed)} m/s`)
}

// ---------------------------------------------------------------------------------------
// riding a clean bump
// ---------------------------------------------------------------------------------------
{
  const sim = openWater(regular(1.2, 3.4))
  const w = sim.waves
  const x0 = (Math.PI / 3 - w.ph[0]) / w.k[0]
  sim.start({ x: x0, foilSpeed: w.cp + 0.5 })
  sim.run(90, undefined, (m) => m.s.mode === 'foil')
  const lead = ((sim.s.x - x0 - w.cp * sim.s.t) * w.k[0]) / (2 * Math.PI)
  check('a clean 1.2 m bump carries a rider straight downwind indefinitely', sim.s.mode === 'foil' && Math.abs(lead) < 1.2,
    `${sim.s.mode} at ${f(sim.s.t, 0)} s, ${f(lead, 1)} waves from where it started`)
}
{
  const sim = openWater(regular(1.2, 3.4))
  const w = sim.waves
  sim.start({ x: (Math.PI / 3 - w.ph[0]) / w.k[0], foilSpeed: w.cp + 1 })
  let dir = 1, vSum = 0, n = 0
  const x0 = sim.s.x
  sim.run(120, (m) => {
    const lim = (50 * Math.PI) / 180
    if (m.s.heading > lim) dir = -1
    else if (m.s.heading < -lim) dir = 1
    m.c.steer = dir * 0.75
  }, (m) => { vSum += m.s.speed; n++; return m.s.mode === 'foil' })
  const vmg = (sim.s.x - x0) / sim.s.t
  check('carving either side of a clean bump keeps up with it, faster through the water, with no pumping',
    sim.s.mode === 'foil' && within(vmg / w.cp, 0.93, 1.1) && vSum / n > w.cp + 1,
    `${sim.s.mode}, ${f(vSum / n)} m/s through the water, ${f(vmg)} m/s downwind (bump ${f(w.cp)} m/s)`)
}

{
  // The owner's "long turns" drone clip, measured frame by frame: a clean 1.5 m bump 21 m
  // long (5.7 m/s); the rider S-turns 75 degrees either side of downwind, 6 to 10.5 m/s
  // through the water (mean 8.35), banking 40-48 degrees, and stays with the same bump.
  const sim = openWater(regular(1.5, 3.67))
  const pilot = makeScenario('sturn')!
  pilot.start(sim)
  const x0 = sim.s.x
  let n = 0, vSum = 0, vMin = 99, vMax = 0, bank = 0
  sim.run(90, (m) => pilot.pilot(m), (m) => {
    if (m.s.t > 10 && m.s.mode === 'foil') {
      n++; vSum += m.s.speed; vMin = Math.min(vMin, m.s.speed); vMax = Math.max(vMax, m.s.speed)
      bank = Math.max(bank, Math.abs(m.s.bank))
    }
  })
  const vmg = (sim.s.x - x0) / sim.s.t
  check('long-turns clip: S-turns on a 1.5 m bump run 6-10.5 m/s and stay with it',
    sim.s.takeoffs === 1 && within(vSum / n, 7.4, 10.2) && vMax < 11.8 && vMin > 5 && within(vmg / sim.waves.cp, 0.95, 1.06) && sim.s.pumpCount < 12,
    `mean ${f(vSum / n)} (${f(vMin)}..${f(vMax)}) m/s, ${f(vmg)} m/s downwind (bump ${f(sim.waves.cp)}), max bank ${f(bank * 57.3, 0)} deg, pumps ${sim.s.pumpCount}`)
}

// ---------------------------------------------------------------------------------------
// with the wind on (25 knots at the gauge, 0.8 of it at the rider)
// ---------------------------------------------------------------------------------------
{
  const P = cloneParams()
  P.waves.hs = 0
  P.waves.useLevel = 0
  const sim = openWater(P)
  sim.start({ foilSpeed: 7 })
  let t6 = 0, v6 = 0, v6b = 0
  sim.run(40, undefined, (m) => {
    if (!t6 && m.s.speed <= 6.3) { t6 = m.s.t; v6 = m.s.speed }
    if (t6 && !v6b && m.s.t >= t6 + 0.5) v6b = m.s.speed
    return m.s.mode === 'foil'
  })
  check('tailwind helps a glide but does not carry it', within((v6 - v6b) / 0.5, 0.4, 0.68) && within(sim.s.t, 6, 11),
    `${f((v6 - v6b) / 0.5)} m/s2 at 6 m/s, down after ${f(sim.s.t, 1)} s (still air: 0.73 m/s2, 5.8 s)`)
  const held = openWater(P)
  held.start({ foilSpeed: 6 })
  held.run(400, (m) => { m.c.action = true }, (m) => m.s.mode === 'foil')
  check('holding the pump key downwind on flat water still runs out', within(held.s.t, 25, 240), `${f(held.s.t, 0)} s`)
}

// ---------------------------------------------------------------------------------------
// pumping is a rhythm
// ---------------------------------------------------------------------------------------
{
  const fly = (press: (m: Sim, st: { next: number }) => void) => {
    const sim = openWater(flat())
    sim.start({ foilSpeed: 6.2 })
    const st = { next: 0 }
    let v = 0, n = 0
    sim.run(6, (m) => press(m, st), (m) => { if (m.s.t > 2) { v += m.s.speed; n++ } return m.s.mode === 'foil' })
    return { speed: n ? v / n : 0, t: sim.s.t }
  }
  const cyc = cloneParams().pump.cycle
  const beat = fly((m, st) => { if (m.s.t >= st.next) { m.c.actionPressed = true; st.next = m.s.t + cyc } })
  const mash = fly((m, st) => { if (m.s.t >= st.next) { m.c.actionPressed = true; st.next = m.s.t + 1 / 5 } })
  const hold = fly((m) => { m.c.action = true })
  check('pumping on the beat beats mashing the key, and beats holding it', beat.speed > mash.speed + 0.15 && beat.speed > hold.speed + 0.1,
    `mean speed over 4 s: on the beat ${f(beat.speed)}, mashed at 5 Hz ${f(mash.speed)}, held ${f(hold.speed)} m/s`)
  check('six hard pumps on the beat hold 6 m/s for a few seconds, as in the footage', within(beat.speed, 5.7, 6.9), `${f(beat.speed)} m/s`)
}

// ---------------------------------------------------------------------------------------
// paddling
// ---------------------------------------------------------------------------------------
type Strat = 'none' | 'cruise' | 'mash' | 'timed'
function paddleRun(P: SimParams, strat: Strat, seconds: number) {
  const sim = new Sim(P)
  if (P.waves.useLevel < 0.5) sim.waves.level = null
  sim.start({ x: STARTS.hatchery.x, z: STARTS.hatchery.z })
  let maxV = 0
  sim.run(seconds, (m) => {
    m.c.steer = 0
    m.c.action = false
    if (m.s.mode !== 'paddle') return
    if (strat === 'cruise') m.c.action = true
    else if (strat === 'mash') { m.c.action = true; if (m.s.strokePhase < 0 || m.s.strokePhase > 0.55) m.c.actionPressed = true }
    else if (strat === 'timed') paddleUpPilot(m)
  }, (m) => {
    if (m.s.mode === 'paddle') maxV = Math.max(maxV, m.s.speed)
    if (m.s.mode === 'foil') return false
  })
  return { sim, maxV, up: sim.s.takeoffs > 0 }
}
{
  const cruise = paddleRun(flat(), 'cruise', 30)
  const sprint = paddleRun(flat(), 'mash', 14)
  check('flat water: cruising 1.8-2.4 m/s', within(cruise.maxV, 1.8, 2.4), `${f(cruise.maxV)} m/s`)
  check('flat water: an all-out sprint tops out near 3 m/s and does not fly the 980', within(sprint.maxV, 2.7, 3.5) && !sprint.up,
    `${f(sprint.maxV)} m/s, took off: ${sprint.up}`)
  const long = paddleRun(flat(), 'cruise', 300)
  check('cruise paddling can be kept up: five minutes leaves the tank nearly full', long.sim.s.stamina > 0.8,
    `stamina ${f(long.sim.s.stamina)}, quick store ${f(long.sim.s._fast / (long.sim.P.stamina.reserve * long.sim.P.stamina.fastShare))}`)
}
{
  let drift = 0, cruise = 0, mash = 0, timed = 0, tTimed = 0, strokes = 0
  const seeds = [7, 8, 9, 10, 11, 12, 13, 14]
  for (const seed of seeds) {
    const P = cloneParams()
    P.waves.seed = seed
    if (paddleRun(P, 'none', 60).up) drift++
    if (paddleRun(P, 'cruise', 60).up) cruise++
    if (paddleRun(P, 'mash', 40).up) mash++
    const r = paddleRun(P, 'timed', 40)
    if (r.up) { timed++; tTimed += r.sim.s.t; strokes += r.sim.s.strokeCount }
  }
  check('in the bumps: a drifting board never flies, and cruising strokes alone do not either', drift === 0 && cruise <= 1,
    `drifting ${drift}/${seeds.length}, cruising ${cruise}/${seeds.length}`)
  check('in the bumps: a sprint timed to the face gets up', timed >= seeds.length - 1,
    `${timed}/${seeds.length}, mean ${f(tTimed / Math.max(1, timed), 1)} s and ${f(strokes / Math.max(1, timed), 1)} strokes`)
  check('in the bumps: mashing the key is no better than timing the sprint', mash <= timed, `mashed ${mash}/${seeds.length}, timed ${timed}/${seeds.length}`)
}
{
  // Which side the paddle is on. Paddling up, a rider keeps it on the right (left hand on
  // top) through his steering: here he starts 30 degrees off downwind and has to turn
  // right, which would put the paddle on the left under a "paddle on the outside of the
  // turn" rule.
  let strokes = 0, left = 0, ups = 0, steered = 0
  const seeds = [7, 8, 9, 10, 11, 12, 13, 14]
  for (const seed of seeds) {
    const P = cloneParams()
    P.waves.seed = seed
    const sim = new Sim(P)
    sim.start({ x: STARTS.hatchery.x, z: STARTS.hatchery.z, heading: -30 * Math.PI / 180 })
    let seen = sim.s.strokeCount
    sim.run(40, (m) => {
      m.c.steer = 0
      m.c.action = false
      if (m.s.mode !== 'paddle') return
      paddleUpPilot(m)
      if (Math.abs(m.c.steer) > 0.3) steered++
    }, (m) => {
      if (m.s.strokeCount !== seen) { seen = m.s.strokeCount; strokes++; if (m.s.strokeSide < 0) left++ }
      if (m.s.mode === 'foil') { ups++; return false }
    })
  }
  check('paddling up, the paddle stays on the right through steering corrections', strokes > 0 && left === 0 && steered > 0,
    `${strokes} strokes, ${left} on the left; ${ups}/${seeds.length} up; ${f(steered / 120, 1)} s of hard steering`)

  // Paddling around, a real turn takes it to the outside of the turn, and it comes back to
  // the right once the board points within 50 degrees of downwind.
  const sim = openWater(flat())
  sim.start({ x: 0, z: 0, heading: -100 * Math.PI / 180 })
  let wide = 0, wideOutside = 0, near = 0, nearRight = 0, seen = sim.s.strokeCount
  sim.run(20, (m) => { m.c.steer = 1; m.c.action = true }, (m) => {
    if (m.s.strokeCount === seen) return
    seen = m.s.strokeCount
    const off = (Math.abs(m.s.heading) * 180) / Math.PI
    if (off > 55) { wide++; if (m.s.strokeSide < 0) wideOutside++ }
    else if (off < 45) { near++; if (m.s.strokeSide > 0) nearRight++ }
  })
  check('paddling in circles, the paddle goes to the outside of the turn, and back to the right near downwind',
    wide > 3 && wideOutside === wide && near > 0 && nearRight === near,
    `well off downwind ${wideOutside}/${wide} strokes on the outside; near downwind ${nearRight}/${near} on the right`)
}

// ---------------------------------------------------------------------------------------
// reading the bumps is what keeps a rider up
// ---------------------------------------------------------------------------------------
{
  const session = (make: () => (m: Sim) => void, seed: number) => {
    const P = cloneParams()
    P.waves.seed = seed
    const sim = new Sim(P)
    sim.start({ x: STARTS.hatchery.x, z: STARTS.hatchery.z, foilSpeed: 6.8, onFace: true })
    sim.run(180, make())
    return sim.s
  }
  const steerTo = (m: Sim, h: number) => {
    let e = h - (m.s.heading - m.s.slip)
    while (e > Math.PI) e -= 2 * Math.PI
    while (e < -Math.PI) e += 2 * Math.PI
    return Math.max(-0.6, Math.min(0.6, e * 2.2))
  }
  const off = (m: Sim) => { m.c.steer = 0; m.c.pitch = 0; m.c.action = false }
  const straight = () => (m: Sim) => { off(m); if (m.s.mode === 'paddle') paddleUpPilot(m); else if (m.s.mode === 'foil') { m.c.steer = steerTo(m, 0); if (m.s.speed < m.D.vStall * 1.2) m.c.action = true } }
  const reader = () => { const r = new Reader(); return (m: Sim) => { off(m); if (m.s.mode === 'paddle') paddleUpPilot(m); else if (m.s.mode === 'foil') { r.drive(m); if (m.s.speed < m.D.vStall * 1.2) m.c.action = true } } }
  const auto = () => { const ap = new Autopilot(); return (m: Sim) => { off(m); if (m.s.mode === 'paddle') paddleUpPilot(m); else if (m.s.mode === 'foil') ap.drive(m) } }
  const seeds = [7, 8, 9, 10, 11, 12]
  const sum = (make: () => (m: Sim) => void) => {
    let foil = 0, pumps = 0, stam = 0
    for (const seed of seeds) { const s = session(make, seed); foil += s.foilTime; pumps += s.pumpCount; stam += s.stamina }
    return { foil: foil / seeds.length, ppm: (pumps / Math.max(1, foil)) * 60, stam: stam / seeds.length }
  }
  const a = sum(straight), b = sum(reader), c = sum(auto)
  check('a rider who reads the faces stays up far longer than one who runs straight, on fewer pumps',
    b.foil > 1.8 * a.foil && b.foil > 100 && b.ppm < a.ppm && b.stam > a.stam + 0.2,
    `of 180 s: straight ${f(a.foil, 0)} s on foil (${f(a.ppm, 0)} pumps/min, tank ${f(a.stam)}), reader ${f(b.foil, 0)} s (${f(b.ppm, 0)}/min, ${f(b.stam)})`)
  check('the look-ahead pilot rides the default sea almost without pumping', c.foil > 165 && c.ppm < 12,
    `${f(c.foil, 0)} s on foil of 180, ${f(c.ppm, 0)} pumps a minute, tank ${f(c.stam)}`)
}

// ---------------------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------------------
{
  const run = () => {
    const sim = new Sim(cloneParams())
    sim.start({ x: STARTS.hatchery.x, z: STARTS.hatchery.z, foilSpeed: 6.5 })
    sim.run(20, (m) => { m.c.steer = Math.sin(m.s.t * 1.3); m.c.action = m.s.t % 3 < 1 })
    return `${sim.s.x},${sim.s.y},${sim.s.z},${sim.s.stamina}`
  }
  check('same inputs, same ride', run() === run(), 'bit-identical after 20 s')
}
{
  const sim = new Sim(cloneParams())
  sim.start({ x: STARTS.hatchery.x, z: STARTS.hatchery.z, foilSpeed: 6.5 })
  sim.run(1)
  sim.c.steer = NaN
  sim.c.pitch = undefined as unknown as number
  sim.step()
  sim.run(3, (m) => { m.c.steer = 0.5; m.c.pitch = 0 })
  const s = sim.s
  check('a bad control value cannot poison the state', Number.isFinite(s.x + s.y + s.z + s.vx + s.vy + s.vz + s.bank + s.heading + s.stamina), `x ${f(s.x, 1)}, bank ${f(s.bank * 57.3, 0)} deg`)
}
{
  // moving a slider mid-ride must not move the world
  const sim = new Sim(cloneParams())
  sim.start({ x: STARTS.hatchery.x + 0.85 * 0, z: STARTS.hatchery.z, foilSpeed: 6.5, onFace: true })
  sim.run(60, (m) => { m.c.steer = 0.3 * Math.sin(m.s.t) })
  const g0 = groundX(sim.s, sim.waves)
  const eta0 = sim.waves.height(sim.s.x, sim.s.z, sim.s.t)
  sim.P.env.current = 1.3
  sim.P.waves.tp = 3.3
  sim.P.waves.spreadDeg = 20
  sim.refresh(true)
  const g1 = groundX(sim.s, sim.waves)
  const eta1 = sim.waves.height(sim.s.x, sim.s.z, sim.s.t)
  check('changing the current or the wave period mid-ride leaves the land and the water under the rider where they were',
    Math.abs(g1 - g0) < 0.01 && Math.abs(eta1 - eta0) < 0.05, `land moved ${f(Math.abs(g1 - g0), 3)} m, surface ${f(Math.abs(eta1 - eta0), 3)} m`)
}
{
  // paddling in circles must not wind the heading up
  const sim = openWater(flat())
  sim.start({})
  sim.run(60, (m) => { m.c.steer = 1; m.c.action = true })
  check('heading stays wrapped while circling', Math.abs(sim.s.heading) <= Math.PI + 1e-6, `${f(sim.s.heading)} rad after a minute of circles`)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
