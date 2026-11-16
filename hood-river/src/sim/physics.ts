/**
 * Rider + board + foil dynamics.
 *
 * Foiling is a point-mass glider flying through moving water. Lift and drag are computed
 * from the wing's velocity relative to the water (v - u), where u is the wave field's
 * orbital velocity at the wing. Nothing "pushes" the rider along a wave: the wing gains
 * energy at the rate F_hydro . u, which is thrust when the water under it is rising (the
 * face ahead of a crest), drag when it is sinking (the back), and extra when a loaded,
 * banked wing has the water moving along its lift vector (a bottom turn in the trough, a
 * top turn on the crest). Riding straight at the wave's own speed this reduces to the
 * familiar m*g*slope. Everything else (outrunning a bump, stalling in a turn, falling off
 * the back, carving for speed) falls out of that.
 *
 * Pitch is not a free rigid-body axis. A rider "reflex" commands angle of attack, through
 * a short lag and limited by the stall, to hold a ride height; Up/Down trim it. Left/Right
 * command bank; the turn comes from the banked lift.
 *
 * Off foil, the board floats: hull drag, the surface-slope push every floating body gets,
 * paddle strokes, and a wing that takes the weight only when the rider drives it up with
 * hard strokes at speed.
 *
 * Stamina is a critical-power model: a quick store that pays for a sprint and is back in
 * seconds, and a slow one that pays for long pumping and takes minutes.
 */
import { derive, type Derived, type SimParams } from './params'
import { EV, makeControls, type Controls, type RiderState } from './types'
import { G, makeWaveSample, type WaveField } from './waves'

const ws = makeWaveSample()
const ws2 = makeWaveSample()
/** the controls actually used for a step: finite and within [-1, 1] whatever was passed in */
const ctl = makeControls()

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (e0: number, e1: number, x: number) => {
  const u = clamp((x - e0) / (e1 - e0), 0, 1)
  return u * u * (3 - 2 * u)
}
const RAD = Math.PI / 180
const TWO_PI = Math.PI * 2
const wrap = (a: number) => a - TWO_PI * Math.round(a / TWO_PI)
/** a control value made safe: within [-1, 1], and 0 for NaN or undefined */
const unit = (v: number) => (v >= -1 ? (v <= 1 ? v : 1) : v < -1 ? -1 : 0)

export function makeRider(): RiderState {
  return {
    t: 0, mode: 'paddle', modeTime: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    heading: 0, bank: 0, bankRate: 0, pitch: 0, heave: 0, alpha: 0, slip: 0,
    speed: 0, speedH: 0, depth: 0, rideHeight: 0, gLoad: 0, cl: 0, turnRate: 0,
    eta: 0, slopeX: 0, slopeZ: 0, crest: 0, waterVx: 0, waterVy: 0, waterVz: 0,
    stamina: 1, pumpPhase: -1, pumpCount: 0, strokePhase: -1, strokeSide: 1, paddleSide: 1, strokeCount: 0,
    effort: 0, steerSmooth: 0, pitchSmooth: 0,
    powerWave: 0, powerDrag: 0, powerPump: 0, powerAero: 0,
    touching: false, breached: false, tipOut: 0, stalled: false, aground: false, cause: '',
    foilTime: 0, foilDistance: 0, takeoffs: 0, glideTime: 0, longestGlide: 0, pumpQuality: 1, events: 0,
    _ventTimer: 0, _touchTimer: 0, _strokeQueued: false, _lastStrokeT: -10, _lastPumpT: -10,
    _holdTime: 0, _fast: -1, _slow: -1, _powerOut: 0, _pop: 0, _slipPrev: 0, _pitchBase: 0,
    _effortAvg: 0, _gAvg: 1, _yOff: 0, _bottom: 99, _lastPressT: -10, _queuedQ: 1, _streak: 0, _rushed: 0, _cycle: 0.65, _nextCycle: 0.65, _strokeCost: 1.8, _shallowT: 0,
  }
}

export interface StartOptions {
  x?: number
  z?: number
  heading?: number
  /** start already flying at this speed through the water (m/s); omit to start floating */
  foilSpeed?: number
  /**
   * With foilSpeed: slide the start up to a wavelength along the heading onto the nearest
   * front face, where the water is rising fastest, so a flying start is not dropped onto
   * the back of a bump.
   */
  onFace?: boolean
  stamina?: number
  t?: number
}

/** Put the rider on the water (or in the air, with foilSpeed) at a chosen spot. */
export function startRider(s: RiderState, waves: WaveField, P: SimParams, o: StartOptions = {}): RiderState {
  const t = o.t ?? s.t
  Object.assign(s, makeRider())
  s.t = Number.isFinite(t) ? t : 0
  s.x = Number.isFinite(o.x) ? (o.x as number) : 0
  s.z = Number.isFinite(o.z) ? (o.z as number) : 0
  s.heading = Number.isFinite(o.heading) ? (o.heading as number) : 0
  s.stamina = clamp(o.stamina ?? 1, 0, 1)
  const capF = P.stamina.reserve * P.stamina.fastShare
  s._fast = capF * s.stamina
  s._slow = (P.stamina.reserve - capF) * s.stamina
  const fx = Math.cos(s.heading), fz = Math.sin(s.heading)
  if (o.foilSpeed && o.foilSpeed > 0 && o.onFace) {
    const lam = TWO_PI / Math.max(0.05, waves.kp)
    let best = -Infinity, bestD = 0
    for (let d = -lam; d <= lam; d += 0.25) {
      waves.sample(s.x + fx * d, s.z + fz * d, s.t, Infinity, ws)
      if (ws.dEdx * fx + ws.dEdz * fz < 0 && ws.uy > best) { best = ws.uy; bestD = d }
    }
    s.x += fx * bestD
    s.z += fz * bestD
  }
  waves.sample(s.x, s.z, s.t, Infinity, ws)
  s.eta = ws.eta
  if (o.foilSpeed && o.foilSpeed > 0) {
    const D = derive(P)
    s.mode = 'foil'
    s.y = ws.eta - P.handling.depthTarget
    s.vx = ws.ux + fx * o.foilSpeed
    s.vz = ws.uz + fz * o.foilSpeed
    s.vy = ws.etaDot + ws.dEdx * s.vx + ws.dEdz * s.vz
    const q = 0.5 * P.env.rhoWater * o.foilSpeed * o.foilSpeed
    s.alpha = clamp(D.weight / (q * P.foil.area * D.cla), 0, D.alphaStall)
    s.cl = D.cla * s.alpha
    s.speed = o.foilSpeed
    s.depth = P.handling.depthTarget
    s.rideHeight = P.foil.mastLength - s.depth
    s.takeoffs = 1
  } else {
    s.mode = 'paddle'
    s.y = ws.eta - P.foil.mastLength - 0.05
    s.vx = ws.ux
    s.vz = ws.uz
    s.depth = P.foil.mastLength + 0.05
    s.rideHeight = -0.05
  }
  return s
}

/** Advance the rider one fixed step. `D` must be derive(P) (recompute when P changes). */
export function stepRider(
  s: RiderState, c: Controls, waves: WaveField, P: SimParams, D: Derived, dt: number,
): void {
  // whatever arrives (a stuck key, NaN from a gamepad), the step sees clean controls
  ctl.steer = unit(c.steer)
  ctl.pitch = unit(c.pitch)
  ctl.action = !!c.action
  ctl.actionPressed = !!c.actionPressed

  const xPrev = s.x, zPrev = s.z
  s.t += dt
  s.modeTime += dt
  if (s._fast < 0) {
    const capF = P.stamina.reserve * P.stamina.fastShare
    s._fast = capF * s.stamina
    s._slow = (P.stamina.reserve - capF) * s.stamina
  }
  s._powerOut = 0
  const k = 1 - Math.exp(-dt / 0.08)
  s.steerSmooth += (ctl.steer - s.steerSmooth) * k
  s.pitchSmooth += (ctl.pitch - s.pitchSmooth) * k
  if (s.mode === 'foil') stepFoil(s, ctl, waves, P, D, dt)
  else if (s.mode === 'paddle') stepPaddle(s, ctl, waves, P, D, dt)
  else stepSwim(s, waves, P, dt)
  staminaStep(s, P, dt)

  // ---- the riverbed: sand shoals and the banks ----
  const lvl = waves.level
  if (lvl && lvl.waterDepth) {
    const shift = waves.groundShiftAt(s.t)
    const bottom = lvl.waterDepth(s.x - shift, s.z)
    s._bottom = bottom
    if (s.mode === 'foil') {
      s.aground = false
      // the wing finds the sand before the board does
      if (bottom < s.depth + 0.02) crash(s, 'bottom')
    } else {
      // too shallow for the wing: the rider wades the board along, and cannot take off
      s.aground = bottom < P.foil.mastLength + 0.07
      if (s.aground) {
        const gvx = s.vx - waves.current, gvz = s.vz
        const gsp = Math.hypot(gvx, gvz)
        if (gsp > 0.5) {
          s.vx = waves.current + (gvx * 0.5) / gsp
          s.vz = (gvz * 0.5) / gsp
        }
        if (bottom < 0.35) {
          // never up the beach: a step that ended in shallower water is taken back, and the
          // board stays with the land (which slides through this frame with the current)
          const shiftPrev = waves.groundShiftAt(s.t - dt)
          if (bottom <= lvl.waterDepth(xPrev - shiftPrev, zPrev)) {
            s.x = xPrev + (shift - shiftPrev)
            s.z = zPrev
            s.vx = waves.current
            s.vz = 0
          }
        }
      }
    }
  } else {
    s.aground = false
  }
}

/** Position along the river bank (the land's frame), given the current. */
export function groundX(s: RiderState, waves: WaveField): number {
  return s.x - waves.groundShiftAt(s.t)
}

// ---------------------------------------------------------------------------------------
// stamina
// ---------------------------------------------------------------------------------------

/**
 * Critical-power model. The rider can hold `criticalPower` for ever; anything above it
 * drains a reserve, quick store first. Below it both stores refill, the quick one in tens
 * of seconds and the slow one over minutes, so one sprint is soon forgotten but a long
 * pumping section stays in the legs. Effort is charged averaged over about a stroke, so a
 * steady cruise whose strokes average below critical power costs nothing.
 */
function staminaStep(s: RiderState, P: SimParams, dt: number): void {
  const St = P.stamina
  const reserve = Math.max(1, St.reserve)
  const capF = reserve * clamp(St.fastShare, 0.02, 0.98)
  const capS = reserve - capF
  const cp = Math.max(1, St.criticalPower)
  s._effortAvg += (s._powerOut - s._effortAvg) * (1 - Math.exp(-dt / 0.8))
  const net = s._effortAvg - cp
  if (net > 0) {
    let e = net * dt
    const f = Math.min(s._fast, e)
    s._fast -= f
    e -= f
    s._slow = Math.max(0, s._slow - e)
  } else {
    const rest = -net / cp
    s._fast += (capF - s._fast) * (1 - Math.exp((-dt * rest) / Math.max(0.5, St.tauFast)))
    s._slow += (capS - s._slow) * (1 - Math.exp((-dt * rest) / Math.max(0.5, St.tauSlow)))
  }
  s._fast = clamp(s._fast, 0, capF)
  s._slow = clamp(s._slow, 0, capS)
  s.stamina = (s._fast + s._slow) / reserve
}

/**
 * What the rider can actually deliver when asking for `requested` watts (fatigue watts).
 * Fresh, the quick store allows a real sprint; once it is spent only a steady grind is
 * left, and with both stores empty nothing above critical power.
 */
function deliverable(s: RiderState, P: SimParams, requested: number): number {
  const St = P.stamina
  if (!(requested > St.criticalPower)) return Math.max(0, requested)
  const reserve = Math.max(1, St.reserve)
  const capF = reserve * clamp(St.fastShare, 0.02, 0.98)
  const capS = reserve - capF
  const avail =
    St.criticalPower +
    St.grindPower * smooth(0, 0.08, s._slow / capS) +
    St.burstPower * smooth(0, 0.35, s._fast / capF)
  return Math.min(requested, avail)
}

// ---------------------------------------------------------------------------------------
// lift curve
// ---------------------------------------------------------------------------------------

function liftCoeff(alpha: number, D: Derived, clMax: number): number {
  const as = D.alphaStall
  if (alpha <= as) return Math.max(-0.35 * clMax, D.cla * alpha)
  const u = Math.min(1, (alpha - as) / (0.5 * as))
  return clMax * (1 - 0.5 * u * u * (3 - 2 * u))
}

function stallDrag(alpha: number, D: Derived): number {
  if (alpha <= D.alphaStall) return 0
  const u = Math.min(1, (alpha - D.alphaStall) / (0.5 * D.alphaStall))
  return 0.14 * u
}

// ---------------------------------------------------------------------------------------
// foiling
// ---------------------------------------------------------------------------------------

function stepFoil(
  s: RiderState, c: Controls, waves: WaveField, P: SimParams, D: Derived, dt: number,
): void {
  const m = P.rider.mass
  const F = P.foil
  const H = P.handling
  const Pm = P.pump
  const rho = P.env.rhoWater

  waves.sample(s.x, s.z, s.t, s.y, ws)
  s.eta = ws.eta; s.slopeX = ws.dEdx; s.slopeZ = ws.dEdz; s.crest = ws.crest
  s.waterVx = ws.ux; s.waterVy = ws.uy; s.waterVz = ws.uz

  // ---- pump: rhythm ----
  // One press is one stroke, and the rider pumps at the cadence it is tapped (between 0.5
  // and 0.75 s a stroke). A press that keeps the rhythm of the stroke in progress gives a
  // full pump and builds a streak; an uneven one gives less. A press early in a stroke is
  // too soon to be the next one: it is not a pump, and stamping like that spoils the one
  // that follows. Holding the key pumps steadily at holdEnergy.
  const baseCycle = Math.max(0.2, Pm.cycle)
  if (c.actionPressed) {
    if (s.pumpPhase >= 0 && s.pumpPhase < 0.6) {
      s._rushed = Math.min(3, s._rushed + 1)
    } else if (s.pumpPhase < 0 || !s._strokeQueued) {
      const interval = s.t - s._lastPressT
      const beat = s.pumpPhase >= 0 || interval < 1 ? s._cycle : baseCycle
      const err = Math.abs(interval - beat)
      let q: number
      if (interval > beat + 0.3) {
        q = 0.85 // first stroke of a burst
        s._streak = 0
      } else if (err <= Pm.window) {
        s._streak = Math.min(3, s._streak + 1)
        q = 1 + 0.05 * s._streak
      } else {
        s._streak = 0
        const off = 1 - (0.5 * (err - Pm.window)) / Math.max(0.05, 0.25 - Pm.window)
        // late is never worse than starting again; rushed can be half a pump
        q = interval > beat ? Math.max(0.85, off) : Math.max(0.5, off)
      }
      if (s._rushed > 0) {
        q = Math.max(0.5, q * (1 - 0.2 * s._rushed))
        s._streak = 0
        s._rushed = 0
      }
      s._queuedQ = q
      s._strokeQueued = true
      s._lastPressT = s.t
      // the next stroke takes the tapped cadence, within what legs and a wing can do
      s._nextCycle = interval < 1 ? clamp(interval, 0.77 * baseCycle, 1.15 * baseCycle) : baseCycle
    }
    // (a second press while one is already waiting is simply ignored)
  }
  if (s.pumpPhase < 0 && s.modeTime > 0.15) {
    const held = c.action && !s._strokeQueued && s.t - s._lastPumpT >= 1 / Math.max(0.2, Pm.holdCadence)
    if (s._strokeQueued || held) {
      const tapped = s._strokeQueued
      const q = tapped ? s._queuedQ : Pm.holdEnergy / Math.max(1, Pm.energy)
      s._cycle = tapped ? s._nextCycle : baseCycle
      s._strokeQueued = false
      s.pumpPhase = 0
      s._lastPumpT = s.t
      s.pumpCount++
      s.pumpQuality = q
      // effort = share of a full pump actually delivered, after rhythm and fatigue
      const full = Math.max(1, Pm.energy) / s._cycle
      s.effort = deliverable(s, P, q * full) / full
      s.events |= EV.PUMP
      s.glideTime = 0
    }
  }
  const cycle = s._cycle

  // ---- flow relative to the water ----
  let rx = s.vx - ws.ux, ry = s.vy - ws.uy, rz = s.vz - ws.uz
  let V = Math.hypot(rx, ry, rz)
  if (!(V >= 0.3)) {
    const h = s.heading - s.slip
    rx = Math.cos(h) * 0.3; ry = 0; rz = Math.sin(h) * 0.3
    V = 0.3
  }
  const ix = rx / V, iy = ry / V, iz = rz / V
  const hx = Math.max(1e-4, Math.hypot(ix, iz))
  // horizontal unit vector to the right of the flow, and the unbanked lift direction
  const rvx = -iz / hx, rvz = ix / hx
  const l0x = -rvz * iy, l0y = hx, l0z = rvx * iy
  const q = 0.5 * rho * V * V
  const qS = q * F.area

  // ---- pump: thrust and the board's heave ----
  let thrust = 0
  let pumpOffset = 0
  if (s.pumpPhase >= 0) {
    s.pumpPhase += dt / cycle
    const ph = s.pumpPhase
    const DRIVE = 0.55
    // the legs work for the whole cycle as far as fatigue goes
    s._powerOut = (Pm.energy * s.effort) / cycle
    if (ph < DRIVE) {
      // A pump swings the lift by nearly half the rider's weight, so it needs lift to spare:
      // on a wing already near CLmax (too slow, or loaded in a hard turn) most of it is lost.
      const room = clamp((F.clMax / Math.max(0.2, s.cl) - 1) / 0.45, 0, 1)
      const eff = 0.3 + 0.7 * room
      const energy = Pm.energy * s.effort * (1 + Pm.loadBoost * Math.max(0, s._gAvg - 1))
      const pInst = (energy * Math.sin((Math.PI * ph) / DRIVE) * Math.PI) / (2 * DRIVE * cycle)
      thrust = (pInst * eff) / Math.max(V, 2.5)
    }
    // drive pushes the wing deeper, recovery lets it rise
    pumpOffset = Pm.heave * Math.sin(TWO_PI * Math.min(1, ph))
    if (ph >= 1) s.pumpPhase = -1
  }

  // ---- free surface: lift fades as the wing nears the surface, collapses if it breaches ----
  const depthCm = ws.eta - s.y
  const depth = depthCm + pumpOffset
  // air needs a moment to get in: a wing that only kisses the surface keeps its lift
  s._shallowT = depth < 0.02 ? s._shallowT + dt : 0
  if (depth <= -0.04 || s._shallowT >= H.ventDelay) {
    if (!s.breached) s.events |= EV.BREACH
    s.breached = true
    s._ventTimer = 0.3
  } else if (s.breached && depth > 0.05) {
    s._ventTimer -= dt
    if (s._ventTimer <= 0) s.breached = false
  }
  // near the surface the wing loses lift (the surface acts as a negative mirror image):
  // 0.5 at the surface, 0.83 at half a chord, 0.94 at one chord, 0.99 at two
  const hc = depth / D.chord
  const fsDepth = depth <= 0 ? 0 : (1 + 16 * hc * hc) / (2 + 16 * hc * hc)

  // ---- bank ----
  let bankMax = H.bankMaxDeg * RAD
  if (H.stallGuard > 0) {
    // the rider will not lay it over further than the wing can carry at this speed
    const nAvail = (qS * F.clMax * fsDepth * 0.92) / D.weight
    const guard = nAvail > 1 ? Math.acos(1 / nAvail) : 0
    bankMax += (Math.min(bankMax, guard) - bankMax) * clamp(H.stallGuard, 0, 1)
  }
  const bankCmd = c.steer * bankMax
  const bankAcc = H.bankOmega * H.bankOmega * (bankCmd - s.bank) - 2 * H.bankZeta * H.bankOmega * s.bankRate
  s.bankRate += bankAcc * dt
  // roll is resisted by the wing: slower with more span, more area and more speed
  const rateMax = H.bankRateDeg * RAD * clamp((6 / V) * (0.098 / F.area) * (0.965 / F.span) ** 2, 0.45, 1.5)
  s.bankRate = clamp(s.bankRate, -rateMax, rateMax)
  s.bank = clamp(s.bank + s.bankRate * dt, -1.4, 1.4)
  const cb = Math.cos(s.bank), sb = Math.sin(s.bank)
  const sinB = Math.abs(sb), cosB = Math.abs(cb)
  const lx = l0x * cb + rvx * sb, ly = l0y * cb, lz = l0z * cb + rvz * sb

  // ---- wingtip out of the water in a bank: some lift lost and a fan of spray, no more ----
  const tipDepth = depth - 0.5 * F.span * sinB
  const tipOut = tipDepth < 0 && sinB > 1e-3 ? Math.min(1, -tipDepth / (F.span * sinB)) : 0
  if (tipOut > 0.02 && s.tipOut <= 0.02) s.events |= EV.TIP
  s.tipOut = tipOut
  const wet = fsDepth * (1 - clamp(H.tipLoss, 0, 1) * tipOut)
  // air on the wing: lift collapses, then returns as the cavity closes
  const vent = s.breached ? 1 - (1 - H.breachLift) * clamp(s._ventTimer / 0.3, 0, 1) : 1
  const liftFactor = wet * vent

  // ---- ride-height reflex: command angle of attack to hold the board's height ----
  // Riders sit in the middle of the clear window (inside rail dry, high wingtip wet), so
  // lower the harder they lean; higher when fast; and low while slow, because climbing
  // costs speed the wing does not have. Up/Down trim it.
  const hRail = 0.5 * F.boardWidth * sinB + 0.03
  const hTip = F.mastLength * cosB - 0.5 * F.span * sinB - 0.05
  const hLevelMid = 0.5 * (0.03 + F.mastLength - 0.05)
  let hT = 0.5 * (hRail + hTip) + (F.mastLength - H.depthTarget - hLevelMid)
    + H.heightSpeedGain * (V - 6.5) + c.pitch * H.depthRange
  hT *= clamp((V - P.paddle.takeoffSpeed * D.vStall) / 1.0 + 0.25, 0.25, 1)
  hT = hRail + 0.02 > hTip ? 0.5 * (hRail + hTip) : clamp(hT, hRail + 0.02, hTip)
  hT = clamp(hT, 0.05, F.mastLength - 0.06)
  const dTarget = F.mastLength * cosB - hT
  const depthErr = depthCm - dTarget
  // rate at which the wing is getting deeper as it and the surface both move
  const depthRate = ws.etaDot + ws.dEdx * s.vx + ws.dEdz * s.vz - s.vy
  // (gains kept inside the reflex's stable range whatever the sliders say)
  const kd = Math.max(H.heightKd, 1.2 * H.alphaTau * H.heightKp)
  const ayCmd = clamp(H.heightKp * depthErr + kd * depthRate, -7, 10)
  const clReq = (m * (G + ayCmd)) / (Math.max(0.3, ly) * qS * Math.max(0.3, wet))
  const aMax = D.alphaStall * (1 + clamp(H.stallOvershoot, 0, 0.2))
  const alphaCmd = clamp(clReq / D.cla, -0.3 * D.alphaStall, aMax)
  s.alpha += (alphaCmd - s.alpha) * (1 - Math.exp(-dt / Math.max(0.02, H.alphaTau)))
  const cl = liftCoeff(s.alpha, D, F.clMax)
  const L = qS * cl * liftFactor

  // ---- drag ----
  const clEff = cl * liftFactor
  // induced drag grows as the wing nears the surface (biplane effect of its mirror image)
  const kiNow = D.ki * (1 + 0.6 * Math.exp(-Math.max(0, depth) / 0.25))
  const cd = F.cd0 + kiNow * clEff * clEff + stallDrag(s.alpha, D) + 0.03 * tipOut
  const wetMast = clamp(depth, 0, F.mastLength)
  // mast: section drag on the wet length plus spray where it cuts the surface
  const drag = qS * cd + q * (F.mastCd * F.mastChord * wetMast + 0.00006)

  // ---- hull touching the water ----
  const rideCentre = F.mastLength * cosB - depth
  const low = rideCentre - 0.5 * F.boardWidth * sinB
  let hullUp = 0
  let hullDrag = 0
  if (low < 0) {
    const pen = Math.min(0.25, -low)
    const wn = 26
    hullUp = Math.max(0, m * wn * wn * pen + 2 * 0.8 * m * wn * depthRate)
    hullDrag = q * (1.1 * F.boardWidth * pen + 0.004 * F.boardLength * F.boardWidth * Math.min(1, pen / 0.04))
    if (!s.touching && s.modeTime > 0.6) {
      // (the first half second after lift-off is still the take-off, not a touchdown)
      s.events |= EV.TOUCHDOWN
      const lvl = P.crash.level
      if (lvl > 0) {
        const slack = lvl === 1 ? 1.35 : 1
        const hard = depthRate > P.crash.sinkRate * slack && V > 4.5
        const rail = Math.abs(s.bank) > P.crash.railBankDeg * RAD * slack && V > 4
        if (hard || rail) {
          crash(s, hard ? 'hard' : 'rail')
          return
        }
      }
    }
    s.touching = true
    s._touchTimer += dt
  } else {
    s.touching = false
    // slapping the water on and off does not reset the clock: it only runs down slowly
    s._touchTimer = Math.max(0, s._touchTimer - 0.5 * dt)
  }

  // ---- air: the tailwind pushes on the rider (water-frame wind = wind at body height + current) ----
  const awx = P.env.wind * P.env.windAtRider + P.env.current - s.vx
  const awz = -s.vz
  const fa = 0.5 * P.env.rhoAir * P.rider.cdaAir * Math.hypot(awx, awz)
  const fax = fa * awx, faz = fa * awz

  // ---- integrate ----
  const tx = ix / hx, tz = iz / hx
  const fxh = L * lx - (drag + hullDrag) * ix
  const fyh = L * ly - (drag + hullDrag) * iy
  const fzh = L * lz - (drag + hullDrag) * iz
  const prevHeading = s.heading
  {
    const ax = (fxh + thrust * tx + fax) / m
    const ay = (fyh + hullUp) / m - G
    const az = (fzh + thrust * tz + faz) / m
    // The part of the acceleration across the flow only turns the velocity. Added as a
    // plain kick it would also stretch it: free energy in every turn, more with a bigger
    // step. So it is applied as a rotation, and only the part along the flow as a kick.
    const aPar = ax * ix + ay * iy + az * iz
    const cx = ax - aPar * ix, cy = ay - aPar * iy, cz = az - aPar * iz
    const ang = (Math.hypot(cx, cy, cz) * dt) / V
    const k1 = ang > 1e-9 ? Math.sin(ang) / ang : 1
    const k2 = V * (Math.cos(ang) - 1)
    s.vx += k2 * ix + (cx * k1 + aPar * ix) * dt
    s.vy += k2 * iy + (cy * k1 + aPar * iy) * dt
    s.vz += k2 * iz + (cz * k1 + aPar * iz) * dt
  }
  s.x += s.vx * dt
  s.y += s.vy * dt
  s.z += s.vz * dt

  // ---- bookkeeping ----
  s.speed = V
  s.speedH = Math.hypot(s.vx, s.vz)
  s.depth = depth
  s.rideHeight = low
  s.cl = cl
  s.gLoad = L / D.weight
  s._gAvg += (s.gLoad - s._gAvg) * (1 - Math.exp(-dt / 0.6))
  // the nose leads the track while the rider is still rolling into the carve, and
  // straightens as the bank arrives (measured on drone footage: up to about 15 degrees)
  const slipTarget = clamp(((bankCmd - s.bank) / Math.max(0.2, bankMax)) * H.yawLeadDeg * RAD, -0.35, 0.35)
  s.slip += (slipTarget - s.slip) * (1 - Math.exp(-dt / 0.14))
  const track = Math.atan2(iz, ix)
  const dH = wrap(track - (prevHeading - s._slipPrev))
  s.turnRate += (dH / dt - s.turnRate) * Math.min(1, dt / 0.05)
  s.heading = wrap(track + s.slip)
  s._slipPrev = s.slip
  const alphaRef = D.weight / (0.5 * rho * (1.5 * D.vStall) ** 2 * F.area * D.cla)
  const pitchNow = Math.asin(clamp(iy, -1, 1)) + (s.alpha - alphaRef)
  s._pitchBase += (pitchNow - s._pitchBase) * Math.min(1, dt / 0.04)
  // a pump rocks the board along its own little flight path: nose down on the drive,
  // nose up on the way back (about +-6 degrees at 1.5 Hz)
  s.heave = pumpOffset
  const rock = s.pumpPhase >= 0
    ? -((TWO_PI * Pm.heave) / (cycle * Math.max(V, 4))) * Math.cos(TWO_PI * Math.min(1, s.pumpPhase)) * 0.7
    : 0
  s.pitch = s._pitchBase + rock
  s.stalled = alphaCmd >= aMax - 1e-4 && L * ly < D.weight * 0.97
  s.powerWave = fxh * ws.ux + fyh * ws.uy + fzh * ws.uz
  s.powerDrag = -(drag + hullDrag) * V
  s.powerPump = thrust * (s.vx * tx + s.vz * tz)
  s.powerAero = fax * s.vx + faz * s.vz
  s.foilTime += dt
  s.foilDistance += (s.vx - P.env.current) * dt
  s.glideTime += dt
  if (s.glideTime > s.longestGlide) s.longestGlide = s.glideTime
  s.cause = ''

  // ---- dropping off foil ----
  if ((s.touching && s._touchTimer > 0.25 && V < 0.93 * D.vStall) || V < 1.2) {
    s.mode = 'paddle'
    s.modeTime = 0
    s.events |= EV.OFF_FOIL
    s.cause = 'stall'
    endFlight(s)
    s._pop = 0
    s.heading = wrap(s.heading - s.slip)
    s.slip = 0
    s._slipPrev = 0
  }
}

function endFlight(s: RiderState): void {
  s.vy = 0
  s.pumpPhase = -1
  s.strokePhase = -1
  s._strokeQueued = false
  s._touchTimer = 0
  s._shallowT = 0
  s.touching = false
  s.breached = false
  s.tipOut = 0
  s.stalled = false
  s.heave = 0
  s.glideTime = 0
}

function crash(s: RiderState, cause: RiderState['cause']): void {
  s.mode = 'swim'
  s.modeTime = 0
  s.events |= EV.CRASH
  s.cause = cause
  s.vx *= 0.35
  s.vz *= 0.35
  endFlight(s)
}

// ---------------------------------------------------------------------------------------
// floating and paddling
// ---------------------------------------------------------------------------------------

function stepPaddle(
  s: RiderState, c: Controls, waves: WaveField, P: SimParams, D: Derived, dt: number,
): void {
  const m = P.rider.mass
  const F = P.foil
  const Pd = P.paddle
  const rho = P.env.rhoWater

  waves.sample(s.x, s.z, s.t, Infinity, ws)
  // the wing hangs a mast length under the hull
  waves.sample(s.x, s.z, s.t, ws.eta - F.mastLength, ws2)
  s.eta = ws.eta; s.slopeX = ws.dEdx; s.slopeZ = ws.dEdz; s.crest = ws.crest
  s.waterVx = ws2.ux; s.waterVy = ws2.uy; s.waterVz = ws2.uz

  // ---- which side the paddle is on ----
  // The right, the toe side, with the left hand on the top grip. Paddling up, a rider keeps
  // it there whatever corrections he steers; it goes across only for a real turn while
  // paddling around pointed well off downwind, and then to the outside of the turn. Back
  // within keepSideDeg of downwind, the next stroke is on the right again.
  if (Math.abs(s.heading) <= clamp(Pd.keepSideDeg, 0, 180) * RAD) s.paddleSide = 1
  else if (Math.abs(c.steer) > 0.3) s.paddleSide = c.steer > 0 ? -1 : 1

  // ---- strokes: a tap is one all-out stroke, holding the key paddles at cruise ----
  const strokeTime = Math.max(0.25, Pd.strokeTime)
  const holdCadence = Math.max(0.2, Pd.holdCadence)
  const sprintPower = Math.max(1, Pd.sprintPower)
  if (s.strokePhase < 0) {
    const held = c.action && s.t - s._lastStrokeT >= 1 / holdCadence
    const tapped = c.actionPressed || s._strokeQueued
    if (tapped || held) {
      // thrust power this stroke runs at, and what it costs: a relaxed cruise stroke is
      // cheaper per watt than a sprint stroke
      const asked = tapped ? sprintPower : Pd.cruisePower / holdCadence / strokeTime
      const cost = Math.max(0.1, Pd.costFactor * (tapped ? 1 : Pd.cruiseCost))
      const power = deliverable(s, P, asked * cost) / cost
      s.strokePhase = 0
      s._strokeQueued = false
      s._lastStrokeT = s.t
      s.effort = power / sprintPower
      s._strokeCost = cost
      s.strokeCount++
      s.strokeSide = s.paddleSide
      s.events |= EV.STROKE
    }
  } else if (c.actionPressed && s.strokePhase > 0.5) {
    s._strokeQueued = true
  }

  // ---- steering ----
  const turn = c.steer * Pd.turnRate * (s.strokePhase >= 0 ? 1 : 0.6)
  s.heading = wrap(s.heading + turn * dt)
  s.turnRate = turn
  const fx = Math.cos(s.heading), fz = Math.sin(s.heading)

  // ---- speeds through the water: hull at the surface, wing a mast length down ----
  const sf = (s.vx - ws.ux) * fx + (s.vz - ws.uz) * fz
  const sl = -(s.vx - ws.ux) * fz + (s.vz - ws.uz) * fx
  const sw = Math.max(0, (s.vx - ws2.ux) * fx + (s.vz - ws2.uz) * fz)

  // ---- paddle thrust: power-limited, and the blade can only push so hard ----
  let thrust = 0
  if (s.strokePhase >= 0) {
    s.strokePhase += dt / strokeTime
    const power = s.effort * sprintPower
    s._powerOut = power * s._strokeCost
    const PULL = 0.65
    if (s.strokePhase < PULL) {
      const mean = Math.min(Pd.maxForce * (0.5 + 0.5 * s.effort), power / Math.max(0.8, sf))
      thrust = (mean * Math.sin((Math.PI * s.strokePhase) / PULL) * Math.PI) / (2 * PULL)
    }
    if (s.strokePhase >= 1) s.strokePhase = -1
  }

  // ---- the wing takes the weight only when the rider drives the board up onto it ----
  const vTakeoff = Pd.takeoffSpeed * D.vStall
  const qw = 0.5 * rho * sw * sw
  const liftMax = qw * F.area * F.clMax
  // That takes hard strokes: cruising strokes and the weak strokes of a spent rider do not
  // do it, and a board that is merely drifting stays in the water.
  const popTarget = s.strokePhase >= 0 ? smooth(0.6, 0.9, s.effort) : 0
  s._pop += (popTarget - s._pop) * (1 - Math.exp(-dt / (popTarget > s._pop ? 0.25 : 0.9)))
  // ...and only as flying speed approaches
  const trying = smooth(0.62 * vTakeoff, 0.92 * vTakeoff, sw)
  // (a board thrown far past flying speed by a steep face lifts whatever the rider does)
  const pop = Math.max(s._pop, smooth(1.45 * vTakeoff, 1.65 * vTakeoff, sw))
  const share = clamp((liftMax / D.weight) * trying * pop, 0, 1)
  const clUsed = qw > 1 ? Math.min(F.clMax, (share * D.weight) / (qw * F.area)) : 0
  const foilDrag = qw * (F.area * (F.cd0 + D.ki * clUsed * clUsed) + F.mastCd * F.mastChord * F.mastLength + 0.00006)
  // hull: drag area with a hump as the short board climbs its own bow wave; weight forward
  // (nose down) keeps it flat and fast, weight back digs the tail in
  const fn = Math.abs(sf) / Math.sqrt(G * F.boardLength)
  const trim = 1.1 + (c.pitch > 0 ? 0.45 * c.pitch : 0.1 * c.pitch)
  const hullArea = (Pd.hullArea + Pd.hullHump * clamp((fn - 0.35) / 0.25, 0, 1)) * trim
  // even nearly airborne the hull keeps slapping the surface
  const hullDrag = 0.5 * rho * sf * Math.abs(sf) * hullArea * (1 - 0.88 * share)

  // ---- wave push: buoyancy leans with the surface; the loaded wing feels rising water ----
  // (a face steeper than about 15 degrees is breaking: it spills instead of pushing harder)
  const slopeMag = Math.hypot(ws.dEdx, ws.dEdz)
  const spill = slopeMag > 0.2 ? (0.2 + 0.07 * Math.tanh((slopeMag - 0.2) / 0.07)) / slopeMag : 1
  const slopeF = -G * spill * (ws.dEdx * fx + ws.dEdz * fz)
  const slopeL = -G * spill * (-ws.dEdx * fz + ws.dEdz * fx)
  const wingPush = share * G * clamp(ws2.uy / Math.max(1.5, sw), -0.5, 0.5)

  // ---- air ----
  const awx = P.env.wind * P.env.windAtRider + P.env.current - s.vx
  const awz = -s.vz
  const fa = 0.5 * P.env.rhoAir * P.rider.cdaAir * Math.hypot(awx, awz)
  const aeroF = (fa * (awx * fx + awz * fz)) / m

  const aF = slopeF * (1 - share) + wingPush + (thrust - hullDrag - foilDrag) / m + aeroF
  const aL = slopeL - Pd.latDamp * sl
  s.vx += (aF * fx - aL * fz) * dt
  s.vz += (aF * fz + aL * fx) * dt
  s.x += s.vx * dt
  s.z += s.vz * dt

  // the hull rides the surface and lifts out as the wing loads up; after a flight the
  // board settles onto the water over a tenth of a second rather than jumping there
  const yPrev = s.y
  const yFloat = ws.eta - F.mastLength - 0.05 * (1 - share) + 0.03 * share
  if (s.modeTime <= dt * 1.5) s._yOff = yPrev - yFloat
  s._yOff *= Math.exp(-dt / 0.1)
  s.y = yFloat + s._yOff
  s.vy = (s.y - yPrev) / dt

  // ---- bookkeeping ----
  s.slip = 0
  s._slipPrev = 0
  s.speed = Math.hypot(s.vx - ws.ux, s.vz - ws.uz)
  s.speedH = Math.hypot(s.vx, s.vz)
  s.depth = ws.eta - s.y
  s.rideHeight = F.mastLength - s.depth
  s.gLoad = share
  s._gAvg = 1
  s.cl = clUsed
  s.alpha = clUsed / D.cla
  s.bankRate = 0
  // the floating board lies on the water
  const pitchSurf = Math.atan(ws.dEdx * fx + ws.dEdz * fz) + 0.1 * share
  const bankSurf = -Math.atan(-ws.dEdx * fz + ws.dEdz * fx)
  const kk = Math.min(1, dt / 0.15)
  s.pitch += (pitchSurf - s.pitch) * kk
  s._pitchBase = s.pitch
  s.heave = 0
  s.bank += (bankSurf - s.bank) * kk
  s.touching = false; s.breached = false; s.tipOut = 0; s.stalled = false
  {
    // energy flowing into the board, in the water frame like the foil mode's numbers:
    // forces times the board's own velocity; drag on moving water counts as the wave's
    const vf = s.vx * fx + s.vz * fz, vl = -s.vx * fz + s.vz * fx
    const uf = vf - sf
    s.powerWave = m * (slopeF * (1 - share) + wingPush) * vf - (hullDrag + foilDrag) * uf + m * slopeL * vl - m * Pd.latDamp * sl * (vl - sl)
    s.powerDrag = -(hullDrag + foilDrag) * sf - m * Pd.latDamp * sl * sl
    s.powerPump = thrust * vf
    s.powerAero = m * aeroF * vf
  }

  // ---- lift-off ----
  if (sw >= vTakeoff && pop > 0.7 && s.modeTime > 0.4 && !s.aground) {
    s.mode = 'foil'
    s.modeTime = 0
    s.events |= EV.TAKEOFF
    s.takeoffs++
    s.strokePhase = -1
    s._strokeQueued = false
    s.pumpPhase = -1
    s._lastPumpT = s.t - 10
    s._lastPressT = s.t - 10
    s._streak = 0
    s._touchTimer = 0
    s.alpha = D.alphaStall * 0.8
    s.cl = D.cla * s.alpha
    s.y = ws.eta - F.mastLength + 0.03
    s.vy = ws.etaDot + ws.dEdx * s.vx + ws.dEdz * s.vz + 0.12
    s.bankRate = 0
    s.glideTime = 0
    s.cause = ''
  }
}

// ---------------------------------------------------------------------------------------
// in the water after a crash
// ---------------------------------------------------------------------------------------

function stepSwim(s: RiderState, waves: WaveField, P: SimParams, dt: number): void {
  waves.sample(s.x, s.z, s.t, Infinity, ws)
  s.eta = ws.eta; s.slopeX = ws.dEdx; s.slopeZ = ws.dEdz; s.crest = ws.crest
  const k = Math.min(1, 2.5 * dt)
  s.vx += (ws.ux - s.vx) * k
  s.vz += (ws.uz - s.vz) * k
  s.x += s.vx * dt
  s.z += s.vz * dt
  const yPrev = s.y
  const yFloat = ws.eta - P.foil.mastLength - 0.05
  if (s.modeTime <= dt * 1.5) s._yOff = yPrev - yFloat
  s._yOff *= Math.exp(-dt / 0.1)
  s.y = yFloat + s._yOff
  s.vy = (s.y - yPrev) / dt
  s.speed = Math.hypot(s.vx - ws.ux, s.vz - ws.uz)
  s.speedH = Math.hypot(s.vx, s.vz)
  s.depth = ws.eta - s.y
  s.rideHeight = P.foil.mastLength - s.depth
  s.gLoad = 0; s._gAvg = 1; s.cl = 0; s.alpha = 0; s.turnRate = 0
  const kk = Math.min(1, dt / 0.3)
  s.bank += (0 - s.bank) * kk
  s.pitch += (0 - s.pitch) * kk
  s._pitchBase = s.pitch
  s.heave = 0
  s.slip = 0
  s._slipPrev = 0
  s.bankRate = 0
  s.powerWave = 0; s.powerDrag = 0; s.powerPump = 0; s.powerAero = 0
  if (s.modeTime >= P.crash.swimTime) {
    s.mode = 'paddle'
    s.modeTime = 0
    s.events |= EV.REMOUNT
    s._lastStrokeT = s.t - 10
    s._pop = 0
  }
}
