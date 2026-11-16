/**
 * Shared contracts between the simulation (pure TypeScript, no three.js, runs headless in
 * Node) and everything that draws or drives it.
 *
 * Axes (water frame): +x downwind (east, the way the swell travels), +y up, +z to the right
 * when facing downwind (south, the Oregon bank). Units: metres, seconds, radians, kg.
 * The river current is represented by the land sliding toward +x through this frame at
 * `env.current` m/s: groundX = x - current * t.
 */

export type RiderMode = 'paddle' | 'foil' | 'swim'

/** What the player (or a bot) is asking for on one physics step. */
export interface Controls {
  /** -1 = lean/steer left ... +1 = right */
  steer: number
  /** -1 = nose down, ride lower ... +1 = nose up, ride higher */
  pitch: number
  /** space held: paddle steadily when floating; pump steadily when foiling */
  action: boolean
  /** space went down since the last step: one hard paddle stroke / one pump */
  actionPressed: boolean
}

export function makeControls(): Controls {
  return { steer: 0, pitch: 0, action: false, actionPressed: false }
}

/** Event bits raised by the sim during a step; consumers clear `events` after reading. */
export const EV = {
  TAKEOFF: 1,
  TOUCHDOWN: 2,
  BREACH: 4,
  CRASH: 8,
  STROKE: 16,
  PUMP: 32,
  OFF_FOIL: 64,
  REMOUNT: 128,
  TIP: 256,
} as const

export interface RiderState {
  /** simulation time (s) */
  t: number
  mode: RiderMode
  /** seconds since the mode last changed */
  modeTime: number

  /** position of the front wing (water frame). The board is one mast length above it. */
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number

  /** direction the board points, 0 = +x (downwind), positive toward +z (to the right) */
  heading: number
  /** roll, positive = right rail down (carving right) */
  bank: number
  bankRate: number
  /** board pitch attitude, positive = nose up (includes the rocking of a pump) */
  pitch: number
  /**
   * Extra wing depth from the legs working a pump (m, + = deeper): the board and wing go
   * down on the drive and rise on the recovery while the rider's mass barely moves.
   * Draw the wing at y - heave (riderMatrix does).
   */
  heave: number
  /** wing angle of attack measured from zero lift */
  alpha: number
  /**
   * How far the nose is yawed ahead of the direction of travel (rad, + = to the right).
   * Riders swing the nose into a carve before the track follows; `heading` includes it.
   */
  slip: number

  // ---- derived every step (read-only for consumers) ----
  /** speed through the water (what the foil feels) */
  speed: number
  /** speed over the water-frame ground plane (horizontal) */
  speedH: number
  /** wing depth below the local surface; negative once it has breached */
  depth: number
  /** lowest point of the board above the local surface; <= 0 when the hull is wet */
  rideHeight: number
  /** lift / weight */
  gLoad: number
  cl: number
  /** rate of turn (rad/s), positive to the right */
  turnRate: number
  /** surface under the rider, for drawing a floating board and for effects */
  eta: number
  slopeX: number
  slopeZ: number
  /** linear elevation / (Hs/2): about +1 on a crest, -1 in a trough */
  crest: number
  /** water velocity at the wing */
  waterVx: number
  waterVy: number
  waterVz: number

  // ---- rider ----
  /** 0..1 */
  stamina: number
  /** 0..1 through the current pump stroke, -1 when idle */
  pumpPhase: number
  pumpCount: number
  /** 0..1 through the current paddle stroke, -1 when idle */
  strokePhase: number
  /** side of the stroke in the water or last taken: +1 = right, -1 = left */
  strokeSide: number
  /**
   * Side the paddle is on, which the next stroke takes: +1 = right (the toe side, left hand
   * on the top grip), -1 = left. It stays right while paddling up; see stepPaddle.
   */
  paddleSide: number
  strokeCount: number
  /** effort of the current stroke or pump, 0..1 */
  effort: number
  /** smoothed steer input, -1..1 (for posing the rider) */
  steerSmooth: number
  /** smoothed pitch input, -1..1 */
  pitchSmooth: number

  // ---- energy bookkeeping (W). Positive = energy flowing into the rider. ----
  powerWave: number
  powerDrag: number
  powerPump: number
  powerAero: number

  // ---- condition flags ----
  /** hull is touching the water while in foil mode */
  touching: boolean
  /** wing has ventilated after breaching the surface */
  breached: boolean
  /** fraction of the span out of the water (wingtip breach in a banked turn), 0..1 */
  tipOut: number
  /** lift is saturated at CLmax and the rider is sinking */
  stalled: boolean
  /** floating in water too shallow for the wing: wading pace only, no take-off */
  aground: boolean
  /**
   * Why the last flight ended: 'stall' (ran out of speed), 'hard' (slammed down), 'rail'
   * (caught a rail in a bank), 'bottom' (wing hit the riverbed), '' while flying or before any.
   */
  cause: '' | 'stall' | 'hard' | 'rail' | 'bottom'

  // ---- session ----
  /** total seconds on foil */
  foilTime: number
  /** metres travelled downwind over the ground while on foil */
  foilDistance: number
  /** number of take-offs */
  takeoffs: number
  /** seconds on foil since the last pump, and the longest such glide of the session */
  glideTime: number
  longestGlide: number
  /** 1 = the last pump was on the beat, less if rushed or late, up to 1.15 on a streak */
  pumpQuality: number
  /** bitmask of EV.* raised since the consumer last cleared it */
  events: number

  // ---- internals (do not rely on these outside the sim) ----
  _ventTimer: number
  _touchTimer: number
  _strokeQueued: boolean
  _lastStrokeT: number
  _lastPumpT: number
  _holdTime: number
  /** energy stores above critical power (J) */
  _fast: number
  _slow: number
  /** thrust power the rider is putting out right now (W) */
  _powerOut: number
  /** 0..1: how hard the rider is working the floating board up onto the wing */
  _pop: number
  _slipPrev: number
  _pitchBase: number
  /** fatigue watts averaged over about a stroke: what the stamina stores are charged */
  _effortAvg: number
  /** load factor averaged over about half a second */
  _gAvg: number
  /** how far the wing still is from its floating height after a flight ends */
  _yOff: number
  /** water depth under the rider at the last step (m) */
  _bottom: number
  /** time of the last pump press that counted, quality of the queued pump, on-beat streak */
  _lastPressT: number
  _queuedQ: number
  _streak: number
  /** presses that came too early in the current pump (mashing) */
  _rushed: number
  /** duration of the pump in progress (s): the rider pumps at the cadence it is tapped */
  _cycle: number
  /** duration the queued pump will have (s) */
  _nextCycle: number
  /** fatigue per watt of thrust for the paddle stroke in progress */
  _strokeCost: number
  /** how long the wing has been at the surface (s) */
  _shallowT: number
}
