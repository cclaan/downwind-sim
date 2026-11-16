/**
 * The pilot league: `npx tsx test/league.ts [conditions=classic] [foil=s980] [seeds=7,8,..] [T=180] [p=path:value,...]`
 * How long each kind of rider stays on foil, and what it costs them. This is the yardstick
 * for tuning the sea and the rider: reading the bumps must clearly beat riding straight.
 */
import { paddleUpPilot } from '../src/app/scenarios'
import { Autopilot, Reader } from '../src/sim/autopilot'
import { Sim } from '../src/sim/harness'
import { STARTS } from '../src/sim/level'
import { applyOverrides, applyPatch, CONDITION_PRESETS, FOIL_PRESETS, HANDLING_PRESETS } from '../src/sim/presets'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')))
const seeds = (args.seeds ?? '7,8,9,10,11,12,13,14').split(',').map(Number)
const T = Number(args.T ?? 180)
const f = (v: number, d = 1) => v.toFixed(d)
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)

function mk(seed: number): Sim {
  const sim = new Sim()
  if (args.conditions) applyPatch(sim.P, CONDITION_PRESETS[args.conditions].patch)
  if (args.foil) applyPatch(sim.P, FOIL_PRESETS[args.foil].patch)
  if (args.handling) applyPatch(sim.P, HANDLING_PRESETS[args.handling].patch)
  if (args.p) applyOverrides(sim.P, args.p)
  sim.P.waves.seed = seed
  sim.refresh(true)
  return sim
}

type Pilot = (sim: Sim) => void
const steerTo = (m: Sim, h: number, gain = 2.2, lim = 0.6) => {
  let e = h - (m.s.heading - m.s.slip)
  while (e > Math.PI) e -= 2 * Math.PI
  while (e < -Math.PI) e += 2 * Math.PI
  return Math.max(-lim, Math.min(lim, e * gain))
}
const clear = (m: Sim) => { m.c.steer = 0; m.c.pitch = 0; m.c.action = false }
const slowPump = (m: Sim) => { if (m.s.speed < m.D.vStall * 1.2) m.c.action = true }

const PILOTS: [string, () => Pilot][] = [
  ['hands off', () => (m) => { clear(m); if (m.s.mode === 'paddle') paddleUpPilot(m) }],
  ['straight downwind, pumps when slow', () => (m) => { clear(m); if (m.s.mode === 'paddle') return paddleUpPilot(m); if (m.s.mode === 'foil') { m.c.steer = steerTo(m, 0); slowPump(m) } }],
  ['one diagonal (40 deg), pumps when slow', () => (m) => { clear(m); if (m.s.mode === 'paddle') return paddleUpPilot(m); if (m.s.mode === 'foil') { m.c.steer = steerTo(m, 0.7); slowPump(m) } }],
  ['reader (steers for the faces it sees)', () => { const r = new Reader(); return (m) => { clear(m); if (m.s.mode === 'paddle') return paddleUpPilot(m); if (m.s.mode === 'foil') { r.drive(m); slowPump(m) } } }],
  ['look-ahead autopilot', () => { const ap = new Autopilot(); return (m) => { clear(m); if (m.s.mode === 'paddle') return paddleUpPilot(m); if (m.s.mode === 'foil') ap.drive(m) } }],
]

console.log(`conditions ${args.conditions ?? 'default'}, foil ${args.foil ?? 'default'}, ${seeds.length} seeds x ${T} s${args.p ? ', ' + args.p : ''}`)
console.log('pilot'.padEnd(42), 'on foil s', 'drops', 'pumps/min', 'stamina', 'mean m/s', 'downwind m/s', 'longest glide s')
for (const [name, make] of PILOTS) {
  const foil: number[] = [], drops: number[] = [], ppm: number[] = [], stam: number[] = [], v: number[] = [], vmg: number[] = [], glide: number[] = []
  for (const seed of seeds) {
    const sim = mk(seed)
    const spot = STARTS.hatchery
    sim.start({ x: spot.x + sim.waves.groundShiftAt(0), z: spot.z, foilSpeed: 6.8, onFace: true, t: 0 })
    const pilot = make()
    let vs = 0, n = 0, nd = 0
    const x0 = sim.s.x
    let prevMode = sim.s.mode
    sim.run(T, pilot, (m) => {
      if (m.s.mode === 'foil') { vs += m.s.speed; n++ }
      if (prevMode === 'foil' && m.s.mode !== 'foil') nd++
      prevMode = m.s.mode
    })
    foil.push(sim.s.foilTime); drops.push(nd); ppm.push((sim.s.pumpCount / Math.max(1, sim.s.foilTime)) * 60)
    stam.push(sim.s.stamina); v.push(n ? vs / n : 0); vmg.push((sim.s.x - x0) / T - sim.P.env.current); glide.push(sim.s.longestGlide)
  }
  console.log(name.padEnd(42), f(mean(foil), 0).padStart(9), f(mean(drops)).padStart(5), f(mean(ppm), 0).padStart(9), f(mean(stam), 2).padStart(7), f(mean(v), 1).padStart(8), f(mean(vmg), 1).padStart(12), f(mean(glide), 0).padStart(15))
}
