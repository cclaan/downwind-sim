/**
 * A self-contained simulation instance: parameters, wave field, rider and a fixed-step
 * loop. Used by the game loop, the headless bots and the capture tool alike.
 */
import { cloneParams, derive, type Derived, type SimParams } from './params'
import { makeRider, startRider, stepRider, type StartOptions } from './physics'
import { makeControls, type Controls, type RiderState } from './types'
import { WaveField } from './waves'
import { LEVEL } from './level'

export const SIM_DT = 1 / 120

/** Keep numbers a slider or a URL can reach inside the range the model can run with. */
function sanitize(P: SimParams): void {
  const fix = (o: Record<string, number>, key: string, lo: number, hi: number, fallback: number) => {
    const v = o[key]
    o[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
  }
  fix(P.rider as unknown as Record<string, number>, 'mass', 30, 200, 92)
  fix(P.foil as unknown as Record<string, number>, 'area', 0.03, 0.4, 0.098)
  fix(P.foil as unknown as Record<string, number>, 'span', 0.3, 2, 0.965)
  fix(P.foil as unknown as Record<string, number>, 'clMax', 0.4, 2.5, 1.15)
  fix(P.foil as unknown as Record<string, number>, 'mastLength', 0.4, 1.3, 0.8)
  fix(P.pump as unknown as Record<string, number>, 'cycle', 0.2, 2, 0.65)
  fix(P.pump as unknown as Record<string, number>, 'energy', 1, 2000, 285)
  fix(P.pump as unknown as Record<string, number>, 'holdCadence', 0.2, 5, 1.54)
  fix(P.paddle as unknown as Record<string, number>, 'sprintPower', 1, 2000, 300)
  fix(P.paddle as unknown as Record<string, number>, 'strokeTime', 0.25, 3, 0.6)
  fix(P.paddle as unknown as Record<string, number>, 'holdCadence', 0.2, 4, 0.9)
  fix(P.paddle as unknown as Record<string, number>, 'costFactor', 0.1, 10, 1.8)
  fix(P.paddle as unknown as Record<string, number>, 'keepSideDeg', 0, 180, 50)
  fix(P.stamina as unknown as Record<string, number>, 'criticalPower', 1, 2000, 150)
  fix(P.stamina as unknown as Record<string, number>, 'reserve', 100, 1e6, 10000)
  fix(P.stamina as unknown as Record<string, number>, 'fastShare', 0.02, 0.98, 0.2)
  fix(P.handling as unknown as Record<string, number>, 'alphaTau', 0.02, 1, 0.12)
  fix(P.handling as unknown as Record<string, number>, 'bankOmega', 0.5, 40, 7)
  fix(P.env as unknown as Record<string, number>, 'current', -5, 5, 0.85)
  fix(P.env as unknown as Record<string, number>, 'wind', -40, 40, 12.9)
}

export class Sim {
  P: SimParams
  D: Derived
  waves: WaveField
  s: RiderState
  c: Controls
  dt = SIM_DT

  constructor(P?: SimParams) {
    // a private copy: two Sims built from one parameter object must not share numbers
    this.P = cloneParams(P)
    sanitize(this.P)
    this.D = derive(this.P)
    this.waves = new WaveField(this.P.waves)
    this.waves.level = LEVEL
    this.waves.current = this.P.env.current
    this.s = makeRider()
    this.c = makeControls()
    startRider(this.s, this.waves, this.P, {})
  }

  /**
   * Call after editing this.P (foil, rider or wave numbers), also mid-ride: the land stays
   * where it is when the current changes, and the sea keeps its phase under the rider when
   * the wave numbers change.
   */
  refresh(wavesChanged = false): void {
    sanitize(this.P)
    this.D = derive(this.P)
    this.waves.setCurrent(this.P.env.current, this.s.t)
    if (wavesChanged) this.waves.set(this.P.waves, { x: this.s.x, z: this.s.z, t: this.s.t })
  }

  start(o: StartOptions = {}): void {
    startRider(this.s, this.waves, this.P, o)
  }

  /** One fixed physics step with the current controls. Clears the press edge afterwards. */
  step(): void {
    stepRider(this.s, this.c, this.waves, this.P, this.D, this.dt)
    this.c.actionPressed = false
    // belt and braces: a non-finite state can never get out by itself, so put the rider
    // back on the water where the run started rather than freeze the game
    const s = this.s
    if (!Number.isFinite(s.x + s.y + s.z + s.vx + s.vy + s.vz + s.bank + s.heading)) {
      console.warn('[hood-river] rider state went non-finite; restarting the rider')
      const t = Number.isFinite(s.t) ? s.t : 0
      startRider(s, this.waves, this.P, { x: this.waves.groundShiftAt(t), z: 0, t })
    }
  }

  /** Run for `seconds`, calling `pilot` before every step and `probe` after it. */
  run(seconds: number, pilot?: (sim: Sim) => void, probe?: (sim: Sim) => boolean | void): void {
    const n = Math.round(seconds / this.dt)
    for (let i = 0; i < n; i++) {
      if (pilot) pilot(this)
      this.step()
      if (probe && probe(this) === false) return
    }
  }
}
