/**
 * Every tunable number of the simulation, in one JSON-friendly object so the tuning panel,
 * the URL, presets and the headless bots all drive the same thing.
 */
import { DEFAULT_WAVES, G, type WaveParams } from './waves'

export interface SimParams {
  rider: {
    /** rider + board + foil (kg) */
    mass: number
    /** aerodynamic drag area of a standing rider (m^2) */
    cdaAir: number
  }
  foil: {
    /** front wing projected area (m^2) */
    area: number
    /** front wing span (m) */
    span: number
    clMax: number
    /** parasitic drag of wing + stabiliser + fuselage, referenced to wing area */
    cd0: number
    /** Oswald span efficiency */
    oswald: number
    /** board underside to wing (m) */
    mastLength: number
    mastChord: number
    /** mast section drag coefficient (includes spray at the surface) */
    mastCd: number
    boardLength: number
    boardWidth: number
  }
  env: {
    /** true wind speed over the ground, blowing toward +x (m/s) */
    wind: number
    /** river current over the ground, flowing toward -x (m/s) */
    current: number
    /** share of the measured wind that reaches a rider standing on the water (boundary layer) */
    windAtRider: number
    rhoWater: number
    rhoAir: number
  }
  handling: {
    /** largest bank the rider will hold (degrees) */
    bankMaxDeg: number
    /** natural frequency (rad/s) and damping of the bank response */
    bankOmega: number
    bankZeta: number
    /** fastest roll (degrees/s) for the reference wing at 6 m/s; scales down with span and speed */
    bankRateDeg: number
    /** seconds of holding a key for the bank command to grow from bankTap to full */
    bankRamp: number
    /** fraction of full bank commanded the instant a key goes down */
    bankTap: number
    /** how far the nose swings ahead of the track when rolling into a carve (degrees at full roll-in) */
    yawLeadDeg: number
    /** 0..1: how much the rider refuses bank that would stall the wing */
    stallGuard: number
    /** cruising wing depth below the surface (m) */
    depthTarget: number
    /** how far Up/Down move the target depth (m) */
    depthRange: number
    /** ride-height reflex gains (1/s^2, 1/s) */
    heightKp: number
    heightKd: number
    /** lag of the rider's pitch reflex (s) */
    alphaTau: number
    /** how far past the stall angle the rider can pull (fraction of the stall angle) */
    stallOvershoot: number
    /** share of lift lost per fraction of span out of the water */
    tipLoss: number
    /** lift remaining once the wing has ventilated */
    breachLift: number
    /** how long the wing must sit at the surface before it ventilates (s) */
    ventDelay: number
    /** riders fly higher when fast: metres of ride height per m/s above 6.5 */
    heightSpeedGain: number
  }
  pump: {
    /** thrust energy of a tapped (hard) pump and of a held (steady) pump (J) */
    energy: number
    holdEnergy: number
    /** duration of one pump (s); also the fastest cadence */
    cycle: number
    /** heave amplitude of the board through a pump (m) */
    heave: number
    /** extra thrust when the wing is loaded (per g above 1) */
    loadBoost: number
    /** pumps per second when the key is held */
    holdCadence: number
    /** pumping needs lift to spare: full effect above this multiple of stall speed */
    fullAbove: number
    /** a tap within this many seconds of the beat is a full pump (s) */
    window: number
  }
  paddle: {
    /** thrust power of a tapped (sprint) stroke and of a held (cruise) stroke (W) */
    sprintPower: number
    cruisePower: number
    /** the blade cannot push harder than this however slow the board (N, cycle average) */
    maxForce: number
    /** paddling is a less efficient way to make thrust than pumping: fatigue per watt of thrust */
    costFactor: number
    /** a relaxed cruise stroke costs this share of that */
    cruiseCost: number
    /** duration of one sprint stroke incl. recovery (s) */
    strokeTime: number
    /** strokes per second when the key is held */
    holdCadence: number
    /** hull drag area (m^2): base, plus a hump as the board climbs its own bow wave */
    hullArea: number
    hullHump: number
    /** heading rate while paddling (rad/s) */
    turnRate: number
    /** speed needed to leave the water, as a multiple of stall speed */
    takeoffSpeed: number
    /** sideways damping of the floating board (1/s) */
    latDamp: number
    /**
     * Within this many degrees of downwind the paddle stays on the right whatever the
     * steering (paddling up). Further off, a hard turn takes it to the outside of the turn.
     * 180 = never changes side; 0 = changes for every hard turn.
     */
    keepSideDeg: number
  }
  stamina: {
    /** thrust power the rider can hold indefinitely (W) */
    criticalPower: number
    /** energy available above that (J), split into a quick and a slow store */
    reserve: number
    fastShare: number
    /** refill time constants of the two stores (s) */
    tauFast: number
    tauSlow: number
    /** extra power the quick store allows while it lasts (W): the sprint */
    burstPower: number
    /** extra power still available from the slow store once the quick one is spent (W) */
    grindPower: number
  }
  crash: {
    /** 0 = never crash, 1 = forgiving, 2 = strict */
    level: number
    /** sink rate onto the water that pitches the rider off (m/s) */
    sinkRate: number
    /** bank beyond which a touching rail trips the rider (degrees) */
    railBankDeg: number
    /** seconds in the water before the rider is back on the board */
    swimTime: number
  }
  waves: WaveParams
}

export const DEFAULT_PARAMS: SimParams = {
  rider: { mass: 92, cdaAir: 0.6 },
  // a 980 cm2, aspect-ratio 9.5 downwind/surf wing on an 80 cm mast under a 7'6" board
  foil: {
    area: 0.098,
    span: 0.965,
    clMax: 1.15,
    cd0: 0.014,
    oswald: 0.85,
    mastLength: 0.8,
    mastChord: 0.12,
    mastCd: 0.011,
    boardLength: 2.3,
    boardWidth: 0.48,
  },
  // 25 knots from the west over a July river running 0.85 m/s the other way
  env: { wind: 12.9, current: 0.85, windAtRider: 0.8, rhoWater: 1000, rhoAir: 1.2 },
  handling: {
    bankMaxDeg: 45,
    bankOmega: 7,
    bankZeta: 1,
    bankRateDeg: 90,
    bankRamp: 0.45,
    bankTap: 0.45,
    yawLeadDeg: 14,
    stallGuard: 0.85,
    depthTarget: 0.4,
    depthRange: 0.3,
    heightKp: 34,
    heightKd: 10,
    alphaTau: 0.12,
    stallOvershoot: 0.1,
    tipLoss: 0.6,
    breachLift: 0.4,
    ventDelay: 0.08,
    heightSpeedGain: 0.035,
  },
  // one hard pump is 285 J (71 N over the 4 m it covers): 1.5 a second holds 6.2 m/s on flat
  // water for a few seconds, as in the footage. A held key pumps on the beat at three quarters.
  pump: { energy: 285, holdEnergy: 215, cycle: 0.65, heave: 0.09, loadBoost: 0.25, holdCadence: 1.54, fullAbove: 1.22, window: 0.1 },
  paddle: {
    sprintPower: 300,
    cruisePower: 90,
    maxForce: 125,
    costFactor: 1.8,
    cruiseCost: 0.7,
    strokeTime: 0.6,
    holdCadence: 0.9,
    hullArea: 0.012,
    hullHump: 0.01,
    turnRate: 0.75,
    takeoffSpeed: 1.1,
    latDamp: 3.5,
    keepSideDeg: 50,
  },
  stamina: { criticalPower: 150, reserve: 10000, fastShare: 0.2, tauFast: 20, tauSlow: 300, burstPower: 400, grindPower: 200 },
  crash: { level: 1, sinkRate: 2.2, railBankDeg: 38, swimTime: 2.6 },
  waves: { ...DEFAULT_WAVES },
}

export function cloneParams(p: SimParams = DEFAULT_PARAMS): SimParams {
  return JSON.parse(JSON.stringify(p)) as SimParams
}

/** Quantities derived from the parameters; recompute after changing rider or foil numbers. */
export interface Derived {
  weight: number
  aspect: number
  chord: number
  /** lift-curve slope per radian (Helmbold) */
  cla: number
  /** induced drag factor 1 / (pi AR e) */
  ki: number
  /** angle of attack at CLmax (rad from zero lift) */
  alphaStall: number
  /** speed through the water at which CLmax just carries the weight (m/s) */
  vStall: number
  /** speed for best glide and the glide ratio there (wing deep, mast at cruise depth) */
  vBestGlide: number
  glideMax: number
}

export function derive(p: SimParams): Derived {
  const { area, span, clMax, cd0, oswald } = p.foil
  const weight = p.rider.mass * G
  const aspect = (span * span) / area
  const chord = area / span
  const cla = (2 * Math.PI * aspect) / (2 + Math.sqrt(4 + aspect * aspect))
  const ki = 1 / (Math.PI * aspect * oswald)
  const alphaStall = clMax / cla
  const vStall = Math.sqrt((2 * weight) / (p.env.rhoWater * area * clMax))
  // parasitic drag area including the wetted mast at cruise depth
  const f = area * cd0 + p.foil.mastCd * p.foil.mastChord * p.handling.depthTarget
  const cd0Eff = f / area
  const clBest = Math.sqrt(cd0Eff / ki)
  const vBestGlide = Math.sqrt((2 * weight) / (p.env.rhoWater * area * clBest))
  const glideMax = clBest / (2 * cd0Eff)
  return { weight, aspect, chord, cla, ki, alphaStall, vStall, vBestGlide, glideMax }
}
