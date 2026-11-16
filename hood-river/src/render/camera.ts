/**
 * Cameras.
 *
 * The rider carves 40-80 degrees either side of downwind every few seconds, and the player
 * has to read the bumps ahead while he does it. So none of these cameras is attached to the
 * board. Each one is a rig hung from an *anchor*: a point that trails the rider through
 * frame-rate independent lags. The rig looks along its own axis, which is tied to the way
 * the swell runs (downwind, +x give or take the wave field's own direction) and follows
 * only a fraction of the board's heading, late. A carve therefore reads as the rider
 * leaning and sliding across a steady picture, not as the world swinging round him.
 *
 *   chase   behind and above, low and close enough to read the rider's body on a phone,
 *           aimed past him so the next three or four bumps fill the band under the horizon
 *   high    the same rig farther back and higher, for reading the whole field
 *   drone   the owner's reference drone: 30 m down-swell, 10 m up, looking back up-swell,
 *           fixed heading and pitch, trailing the rider by about 0.7 s
 *   side    a low tracking shot from abeam (the Oregon side, so the rider faces the lens;
 *           the other side where that spot is on the bank)
 *
 * What is held still, because moving it is what makes a following camera tiring: the pitch
 * (the camera rises and sinks with a share of the rider's height, and is lifted over the
 * water and over a crest that hides him, but it does not nod, so the horizon stays where
 * it is); the axis turns slowly and by a fraction; nothing follows the pump, and the hull
 * skimming the water in a pump does not jolt the picture: only a board that comes down
 * hard does, as hard as it came down, and a crash.
 *
 * A board pointing upwind: a cutback does that for a moment and the axis ignores it (the
 * fraction it follows goes back to nothing as the nose comes round to upwind, so there is
 * no side to flip to). A floating board may point anywhere: the axis stays with the swell,
 * which is also what the paddle-up needs. Only a rider who stays on foil and pointed upwind
 * for two seconds gets the axis brought round, the way he turned; it goes back when he
 * bears away again or comes off the foil. A rider heading at the lens pushes the rig back:
 * he is never nearer than the rig's distance.
 *
 * While the board is floating (paddling, or swimming after a crash) the chase rig comes in
 * closer and lower, so the board's pitch and the paddle strokes read: nose up on the back
 * of the bump that just passed is the cue to sprint.
 *
 * Other modules: dispatch 'hr:camera-next' to cycle, 'hr:camera-set' (detail: mode name)
 * to pick one. This module announces a change with 'hr:camera-changed' (detail: mode name).
 * Every number below is read every frame, so a tuning panel can bind `cameraTuning` as is.
 *
 * The state that changes every frame lives in typed arrays (V8 boxes a number each time
 * it is written to a closure variable), so the only allocation left per frame is the boxed
 * arguments and results of the three wave heights it asks the simulation for.
 */
import { Vector3 } from 'three'
import type { App, FeatureModule } from '../app/types'
import { LEVEL } from '../sim/level'
import { EV } from '../sim/types'

export const CAMERA_MODES: string[] = ['chase', 'high', 'drone', 'side']

export const cameraTuning = {
  // ---- chase, on foil ----
  /** metres behind the rider, measured along the camera's own axis (the lag adds about 1.5 m at speed) */
  distance: 6.8,
  /** metres above the mean water level */
  height: 3.9,
  /** the camera aims at the water this far beyond the rider (m): larger = flatter, more sky */
  lookAhead: 11,
  /** 0 = axis locked downwind, 1 = locked to the board's heading */
  headingFollow: 0.28,
  /** time constant of that follow (s) */
  lag: 0.9,
  /** the axis never swings faster than this (degrees/s), whatever the board does */
  yawRate: 25,
  /** how far the anchor trails the rider along the view axis (s): pulls back with speed */
  trailLag: 0.22,
  /** ...and across it (s): how far the rider swings off centre in a carve */
  sideLag: 0.5,
  /** the rider is hauled back before he gets this far toward the edge (fraction of the half width) */
  sideLimit: 0.55,
  /** vertical field of view at 16:9 (degrees); narrow screens get more, see fovFor() */
  fov: 55,
  /** extra degrees at full speed */
  fovSpeed: 6,
  /** camera roll per unit of board bank (0 = the horizon stays level) */
  bankFollow: 0.06,
  /** share of the rider's rise and fall over the bumps that the camera copies, and how late (s) */
  heightFollow: 0.5,
  heightLag: 0.8,
  /** never closer than this to the water under the camera (m), nor to the ground where it stands over land */
  clearance: 1.1,
  /** an upright phone has height to spare: the camera backs off and rises by this share and tips down, so the extra goes to water, not sky */
  portraitLift: 0.3,

  // ---- chase, board floating (paddling, swimming): closer and lower, so the board's pitch and the strokes read ----
  paddleDistance: 6.2,
  paddleHeight: 2.6,
  paddleLookAhead: 4.5,

  // ---- high ----
  highDistance: 16,
  highHeight: 9,
  highLookAhead: 26,

  // ---- drone (the reference clip: 57 degrees across, pitched 9 degrees down) ----
  /** set so that the lag leaves it about 30 m ahead of a rider running at 6 m/s */
  droneDistance: 34,
  droneHeight: 10,
  dronePitch: 9,
  droneLag: 0.7,
  droneFov: 34,

  // ---- side ----
  sideDistance: 7.5,
  sideHeight: 1.5,
  sideFov: 40,
  /** +1 = camera on the Oregon side looking north at the rider's chest, -1 = the other side */
  sideSign: 1,

  // ---- shared ----
  /** seconds to ease between rigs (take-off, touchdown, chase <-> high) */
  blend: 0.8,
  /** strength of the jolt on a crash or a hard touchdown (0 = none); chase and high only */
  shake: 1,
}

export interface CameraModule extends FeatureModule {
  /** current mode, one of CAMERA_MODES */
  readonly mode: string
  /** switch mode; false if the name is unknown */
  setMode(name: string): boolean
}

/** everything that defines a shot; the live rig eases toward the wanted one */
interface Rig {
  /** direction the camera faces, as an angle from +x toward +z */
  azimuth: number
  /** share of the board's heading added to that */
  follow: number
  distance: number
  height: number
  lookAhead: number
  /** height of the aim point above mean water, and how much of the rider's height it copies */
  aim: number
  aimFollow: number
  heightFollow: number
  fov: number
  fovSpeed: number
  trailLag: number
  sideLag: number
  roll: number
}

function makeRig(): Rig {
  return {
    azimuth: 0, follow: 0, distance: 8, height: 3.5, lookAhead: 14, aim: 0.5, aimFollow: 0.35,
    heightFollow: 0.35, fov: 52, fovSpeed: 0, trailLag: 0.2, sideLag: 0.5, roll: 0,
  }
}

const RAD = Math.PI / 180
const TWO_PI = Math.PI * 2
/** where along the line from the lens to the deck the water is checked (0 = lens, 1 = deck) */
const SIGHT = [0.35, 0.6]
/**
 * A rider on foil who has pointed more than UPWIND_ON from the swell's direction for
 * UPWIND_HOLD seconds, and is still flying with speed in hand, gets the axis brought round
 * to look upwind; it goes back once he is within UPWIND_OFF of the swell's direction again,
 * or comes off the foil.
 */
const UPWIND_ON = 150 * RAD
const UPWIND_OFF = 110 * RAD
const UPWIND_HOLD = 2

// ---- the numbers that change every frame, as slots of one Float64Array ----
/** the anchor: where the rig hangs, trailing the rider */
const AX = 0
const AZ = 1
/** how far the axis has swung from the swell's direction (rad, not wrapped), and where it is heading */
const YAW = 2
const GOAL = 3
const BANK = 4
const SPEED = 5
/** extra height that keeps the deck in sight over a crest, and the camera off the ground (m) */
const SIGHT_LIFT = 6
const LAND_LIFT = 7
/** time since the last jolt and its size */
const JOLT_AGE = 8
const JOLT_SIZE = 9
/** how long the board has been pointing upwind on foil (s) */
const UP_TIME = 10
/** the board's heading from the swell's direction: not wrapped since it last pointed downwind, and wrapped at the last frame */
const TURN = 11
const OFF_PREV = 12
/** the board's height over the water at the last frame, and how fast it was coming down (m/s) */
const RIDE_PREV = 13
const SINK = 14
/** height of the land under the camera when the level was last asked, and how long until it is asked again (s) */
const LAND = 15
const LAND_WAIT = 16
/** where the rider was at the last frame */
const RIDER_X = 17
const RIDER_Z = 18
const N_STATE = 19

/** an angle brought into -pi..pi (a floating board's heading is never wrapped by the sim) */
function wrapAngle(a: number): number {
  return a - TWO_PI * Math.round(a / TWO_PI)
}

/** fraction of the way to a target after dt, for a first-order lag with time constant tau */
function ease(dt: number, tau: number): number {
  return tau > 1e-4 ? 1 - Math.exp(-dt / tau) : 1
}

function smoothstep(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return u * u * (3 - 2 * u)
}

/** max(a, b) with the corner rounded over about w, never below either */
function smoothMax(a: number, b: number, w: number): number {
  const d = a - b
  return 0.5 * (a + b + Math.sqrt(d * d + w * w))
}

/**
 * Vertical field of view for a screen shape. `fov` is what a 16:9 (or wider) screen gets.
 * Narrower screens keep most of the horizontal view instead, so a phone held upright still
 * sees the rider swing across and the bumps either side of him.
 */
function fovFor(fov: number, aspect: number): number {
  const REF = 1.3
  if (aspect >= REF) return fov
  const t = Math.tan(0.5 * fov * RAD) * Math.pow(REF / aspect, 0.6)
  return Math.min(100, (2 * Math.atan(t)) / RAD)
}

export function create(app: App): CameraModule {
  const cam = app.camera
  const waves = app.sim.waves
  // a fixed debug view (?view= / ?viewrel=) is placed by the shell after this module runs;
  // leave the lens alone for it so other modules' reference shots do not depend on this file
  const debugView = app.options.query.has('view') || app.options.query.has('viewrel')

  let mode = CAMERA_MODES.includes(app.options.cam) ? app.options.cam : CAMERA_MODES[0]
  let snap = true
  /** the axis has been brought round to look upwind (see UPWIND_ON) */
  let round = false
  /** -1 while the side camera stands on the other side because its own spot is on the bank */
  let sideFlip = 1

  const want = makeRig()
  const rig = makeRig()
  // the eased numbers of the live rig, their rates of change and their targets:
  // distance, height, 1 / aim range, aim height, fov, aimFollow, heightFollow, deck height
  const D = 0, H = 1, K = 2, AIM = 3, FOV = 4, AF = 5, HF = 6, DECK = 7
  const val = new Float64Array(8)
  const vel = new Float64Array(8)
  const tgt = new Float64Array(8)
  const st = new Float64Array(N_STATE)
  st[JOLT_AGE] = 10
  const aim = new Vector3()

  function fillRig(out: Rig): void {
    const T = cameraTuning
    const floating = app.view.mode !== 'foil'
    const swell = waves.params.dirDeg * RAD
    out.roll = 0
    out.fovSpeed = 0
    out.follow = 0
    // the aim rises and falls with the camera, so the pitch (and the horizon) stays put
    out.aimFollow = T.heightFollow
    out.heightFollow = T.heightFollow
    out.trailLag = T.trailLag
    out.sideLag = T.sideLag
    if (mode === 'drone') {
      // looking back against the swell, so the crests lie square across the picture as in the clip
      out.azimuth = swell + Math.PI
      out.distance = T.droneDistance
      out.height = T.droneHeight
      // fixed pitch: aim at the water where a ray pitched down by dronePitch lands
      out.lookAhead = T.droneHeight / Math.tan(Math.max(1, T.dronePitch) * RAD) - T.droneDistance
      out.aim = 0
      out.aimFollow = 0
      out.heightFollow = 0
      out.fov = T.droneFov
      out.trailLag = T.droneLag
      out.sideLag = T.droneLag
    } else if (mode === 'side') {
      out.azimuth = -0.5 * Math.PI * (T.sideSign < 0 ? -1 : 1) * sideFlip
      out.distance = T.sideDistance
      out.height = T.sideHeight
      out.lookAhead = 0
      // aim at the hips
      out.aim = 0.95
      out.aimFollow = 1
      out.heightFollow = 0.6
      out.fov = T.sideFov
      // hold the range (so his size is steady) and track him closely along the shot
      out.trailLag = 0.18
      out.sideLag = 0.16
    } else {
      // the axis is the way the swell runs, so crests lie square across the picture
      out.azimuth = swell
      // a floating board turns on the spot and may point anywhere: it gets half the follow
      out.follow = floating ? 0.5 * T.headingFollow : T.headingFollow
      out.roll = T.bankFollow
      out.fov = T.fov
      out.fovSpeed = T.fovSpeed
      out.aim = 0.3
      if (mode === 'high') {
        out.distance = T.highDistance
        out.height = T.highHeight
        out.lookAhead = T.highLookAhead
      } else if (floating) {
        out.distance = T.paddleDistance
        out.height = T.paddleHeight
        out.lookAhead = T.paddleLookAhead
      } else {
        out.distance = T.distance
        out.height = T.height
        out.lookAhead = T.lookAhead
      }
      // 0 on a screen wider than 1.3:1, 1 on a phone held upright
      const upright = Math.min(1, Math.max(0, (1.3 - cam.aspect) / 0.84))
      if (upright > 0) {
        out.distance *= 1 + 0.8 * T.portraitLift * upright
        out.height *= 1 + T.portraitLift * upright
        out.lookAhead -= 0.72 * upright * Math.max(0, out.lookAhead)
      }
    }
  }

  function setMode(name: string): boolean {
    if (!CAMERA_MODES.includes(name)) return false
    if (name === mode) return true
    const before = rig.azimuth
    mode = name
    sideFlip = 1
    fillRig(want)
    // a different side of the rider is a cut; the same side is a move
    if (Math.abs(wrapAngle(want.azimuth - before)) > 0.5) snap = true
    window.dispatchEvent(new CustomEvent('hr:camera-changed', { detail: mode }))
    return true
  }

  const onNext = () => { setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(mode) + 1) % CAMERA_MODES.length]) }
  const onSet = (e: Event) => { setMode(String((e as CustomEvent).detail)) }
  window.addEventListener('hr:camera-next', onNext)
  window.addEventListener('hr:camera-set', onSet)

  function update(dt: number): void {
    const s = app.view
    const T = cameraTuning
    const deck = s.y + app.sim.P.foil.mastLength
    const onFoil = s.mode === 'foil'

    // The land is looked up a few times a second, and every frame only once the camera is
    // over it (it nearly always stands over water).
    st[LAND_WAIT] -= dt
    const look = snap || st[LAND_WAIT] <= 0
    if (look) st[LAND_WAIT] = 0.2

    // The side camera keeps off the bank: where its spot is on land it stands on the other
    // side of the rider, and comes back once its own side is clear water again.
    if (mode === 'side' && look) {
      const sign = (T.sideSign < 0 ? -1 : 1) * sideFlip
      const gx = s.x - app.groundShift
      if (LEVEL.landHeight(gx, s.z + sign * T.sideDistance) > 0.3) {
        if (LEVEL.landHeight(gx, s.z - sign * T.sideDistance) < 0.3) { sideFlip = -sideFlip; snap = true }
      } else if (sideFlip < 0 && LEVEL.landHeight(gx, s.z - sign * (T.sideDistance + 12)) < 0.05) {
        sideFlip = 1
        snap = true
      }
    }

    fillRig(want)

    // ---- which way the board points, from the way the swell runs
    const off = wrapAngle(s.heading - waves.params.dirDeg * RAD)
    const absOff = Math.abs(off)
    // ...not wrapped, counted from when it last pointed downwind: which way round it has come
    if (snap || absOff < 0.5 * Math.PI) st[TURN] = off
    else st[TURN] += wrapAngle(off - st[OFF_PREV])
    st[OFF_PREV] = off
    // (flying, not mushing toward a stall: in a headwind that is how every upwind excursion ends)
    st[UP_TIME] = onFoil && absOff > UPWIND_ON && s.speed > 1.1 * app.sim.D.vStall ? st[UP_TIME] + dt : 0
    let turned = 0
    if (!round && st[UP_TIME] >= UPWIND_HOLD) { round = true; turned = 1 }
    else if (round && (!onFoil || absOff < UPWIND_OFF)) { round = false; turned = -1 }
    // the axis hangs on the swell's direction, or on its opposite once it has been brought
    // round, and follows a fraction of what the board does about that
    const base = round ? Math.PI : 0
    // (the swing for a board pointing `rel` off the axis is a blend of the two unit vectors,
    // so it has no wrap and is back to nothing when the board points the opposite way)
    const rel = wrapAngle(off - base)
    const share = Math.min(1, Math.max(0, want.follow))
    const target = share > 0 ? base + Math.atan2(share * Math.sin(rel), 1 - share + share * Math.cos(rel)) : 0

    // ---- how fast the board was coming down on the water before this frame
    const sinkBefore = st[SINK]
    if (onFoil && dt > 1e-5) st[SINK] += ((st[RIDE_PREV] - s.rideHeight) / dt - st[SINK]) * Math.min(1, dt / 0.04)
    else if (!onFoil) st[SINK] = 0
    st[RIDE_PREV] = s.rideHeight

    // A crash jolts the picture, and so does a board that comes down hard, as hard as it
    // came down. The hull skimming the water (in a pump above all) does not.
    if (app.events & EV.CRASH) {
      st[JOLT_AGE] = 0
      st[JOLT_SIZE] = 1
    } else if (app.events & EV.TOUCHDOWN && st[JOLT_AGE] > 0.5 && s.pumpPhase < 0) {
      const size = 0.35 * smoothstep(0.6, 2.2, sinkBefore)
      if (size > 0.02) { st[JOLT_AGE] = 0; st[JOLT_SIZE] = size }
    }
    st[JOLT_AGE] += dt

    // the aim is eased as 1 / range, which is close to easing the pitch itself
    tgt[D] = want.distance
    tgt[H] = want.height
    tgt[K] = 1 / Math.max(2, want.distance + want.lookAhead)
    tgt[AIM] = want.aim
    tgt[FOV] = want.fov
    tgt[AF] = want.aimFollow
    tgt[HF] = want.heightFollow
    // the deck's height, without the pump's heave and without the step when a crash drops it
    tgt[DECK] = deck
    const fresh = snap
    if (snap) {
      snap = false
      val.set(tgt)
      vel.fill(0)
      st[YAW] = target
      st[GOAL] = target
      st[BANK] = s.bank
      st[SPEED] = s.speed
      st[JOLT_AGE] = 10
    } else {
      // Critically damped springs toward the targets (exact for a constant target over dt):
      // position and speed both stay continuous when a target jumps, so a change of rig
      // never kicks. After `time` seconds a move is about 60 % done.
      for (let i = 0; i < 8; i++) {
        const time = i === DECK ? T.heightLag : T.blend
        if (time < 1e-4) { val[i] = tgt[i]; vel[i] = 0; continue }
        const omega = 2 / time
        const c1 = val[i] - tgt[i]
        const c2 = vel[i] + omega * c1
        const e = Math.exp(-omega * dt)
        val[i] = tgt[i] + (c1 + c2 * dt) * e
        vel[i] = (vel[i] - omega * c2 * dt) * e
      }
      // where the axis is heading: the short way, except when it is brought round to look
      // upwind, which goes the way the board turned
      if (turned > 0) {
        let d = wrapAngle(target - st[YAW])
        const dir = st[TURN] >= 0 ? 1 : -1
        if (d * dir < 0 && Math.abs(d) > 120 * RAD) d += dir * TWO_PI
        st[GOAL] = st[YAW] + d
      } else if (turned < 0) {
        st[GOAL] = st[YAW] + wrapAngle(target - st[YAW])
      } else {
        st[GOAL] += wrapAngle(target - st[GOAL])
      }
      const swing = (st[GOAL] - st[YAW]) * ease(dt, T.lag)
      const most = T.yawRate * RAD * dt
      st[YAW] += Math.min(most, Math.max(-most, swing))
      if (Math.abs(st[GOAL]) > 3 * Math.PI) {
        const turns = TWO_PI * Math.round(st[GOAL] / TWO_PI)
        st[GOAL] -= turns
        st[YAW] -= turns
      }
      st[BANK] += (s.bank - st[BANK]) * ease(dt, 0.3)
      st[SPEED] += (s.speed - st[SPEED]) * ease(dt, 0.7)
    }
    rig.azimuth = want.azimuth
    rig.follow = want.follow
    rig.fovSpeed = want.fovSpeed
    rig.trailLag = want.trailLag
    rig.sideLag = want.sideLag
    rig.roll = want.roll
    rig.distance = val[D]
    rig.height = val[H]
    rig.lookAhead = 1 / val[K] - val[D]
    rig.aim = val[AIM]
    rig.fov = val[FOV]
    rig.aimFollow = val[AF]
    rig.heightFollow = val[HF]
    const ay = val[DECK]

    // lens
    const fov = fovFor(rig.fov + rig.fovSpeed * smoothstep(4.5, 9.5, st[SPEED]), cam.aspect)
    const tanHalfH = Math.tan(0.5 * fov * RAD) * cam.aspect
    if (!debugView && Math.abs(cam.fov - fov) > 0.005) {
      cam.fov = fov
      cam.updateProjectionMatrix()
    }

    // the axis the camera looks along, and how far the anchor trails the rider along and across it
    const psi = rig.azimuth + st[YAW]
    const fx = Math.cos(psi), fz = Math.sin(psi)
    const ex = s.x - st[AX], ez = s.z - st[AZ]
    let along = ex * fx + ez * fz
    let across = -ex * fz + ez * fx
    if (fresh) {
      // start where both lags would have settled, so the first second is not a catch-up
      along = (s.vx * fx + s.vz * fz) * rig.trailLag
      const lim = Math.max(0.5, T.sideLimit * tanHalfH * Math.max(2, rig.distance + along))
      const settled = (-s.vx * fz + s.vz * fx) * rig.sideLag
      // (the haul-back below shortens the lag toward the edge: a (1 + 3 a^2 / lim^2) = settled)
      across = settled
      for (let i = 0; i < 6; i++) {
        across -= (across + (3 * across * across * across) / (lim * lim) - settled) / (1 + (9 * across * across) / (lim * lim))
      }
    } else if (dt > 1e-6) {
      // The anchor follows the rider through a lag each way. Solved exactly for a rider who
      // moved steadily over the frame, so how far he leads it does not depend on the frame
      // rate, and an uneven frame does not show as a twitch in where he stands.
      const mx = s.x - st[RIDER_X], mz = s.z - st[RIDER_Z]
      const moveAlong = mx * fx + mz * fz
      const moveAcross = -mx * fz + mz * fx
      // across: the farther toward the edge of the frame, the harder the anchor is pulled along
      const limit = Math.max(0.5, T.sideLimit * tanHalfH * Math.max(2, rig.distance + along))
      const q = across / limit
      const tauAlong = Math.max(1e-3, rig.trailLag)
      const tauAcross = Math.max(1e-3, rig.sideLag / (1 + 3 * q * q))
      const ea = Math.exp(-dt / tauAlong)
      const es = Math.exp(-dt / tauAcross)
      along = (along - moveAlong) * ea + moveAlong * (tauAlong / dt) * (1 - ea)
      across = (across - moveAcross) * es + moveAcross * (tauAcross / dt) * (1 - es)
    }
    st[RIDER_X] = s.x
    st[RIDER_Z] = s.z
    st[AX] = s.x - fx * along + fz * across
    st[AZ] = s.z - fz * along - fx * across
    // A rider who comes back at the lens (the nose upwind for a moment) would run in under
    // it on the lag. The chase rigs back off instead, by as much as they trail a rider going
    // away at that speed: he is never nearer than `distance`, and framed the same both ways.
    const back = rig.follow > 0 ? Math.sqrt(along * along + 0.01) - along : 0
    const bx = st[AX] - fx * back
    const bz = st[AZ] - fz * back

    // position: back along the axis, up, and clear of the water under the camera
    const cx = bx - fx * rig.distance
    const cz = bz - fz * rig.distance
    const cyRig = rig.height + rig.heightFollow * ay
    let cy = cyRig
    // ...and high enough to see the deck over any crest in between. A crest close to the
    // board would lever the camera about, so only the middle of the line is checked and the
    // lift is eased: up quickly, down slowly.
    let need = 0
    for (let i = 0; i < SIGHT.length; i++) {
      const f = SIGHT[i]
      const crest = waves.height(cx + (s.x - cx) * f, cz + (s.z - cz) * f, app.time) + 0.2
      need = Math.max(need, (crest - deck * f) / (1 - f) - cy)
    }
    st[SIGHT_LIFT] = fresh ? need : st[SIGHT_LIFT] + (need - st[SIGHT_LIFT]) * ease(dt, need > st[SIGHT_LIFT] ? 0.3 : 0.9)
    cy = smoothMax(cy + st[SIGHT_LIFT], waves.height(cx, cz, app.time) + T.clearance, 0.5)
    // whatever lifted the camera lifts its aim as much: it rises without nodding, so the horizon holds still
    const lifted = cy - cyRig
    // Over land (a rider close in under a bank) the camera also clears the ground. That can
    // be metres, so here the aim stays on the rider and the camera tips down at him.
    if (look || st[LAND] > 0) st[LAND] = LEVEL.landHeight(cx - app.groundShift, cz)
    const land = st[LAND]
    const over = land > 0 ? Math.max(0, land + T.clearance * smoothstep(0, 0.4, land) - cy) : 0
    st[LAND_LIFT] = fresh ? over : st[LAND_LIFT] + (over - st[LAND_LIFT]) * ease(dt, over > st[LAND_LIFT] ? 0.25 : 0.8)
    cy += st[LAND_LIFT]

    // a crash or a hard landing jolts the camera: a short, damped nod (not the drone or the
    // side camera: those are for looking at the rider)
    let nod = 0
    let tilt = 0
    if (st[JOLT_AGE] < 1.2 && T.shake > 0 && rig.follow > 0) {
      const age = st[JOLT_AGE]
      const a = T.shake * st[JOLT_SIZE] * Math.exp(-age / 0.22)
      nod = 0.014 * a * Math.sin(age * 38)
      tilt = 0.009 * a * Math.sin(age * 29 + 1.3)
      cy -= 0.1 * a * Math.sin(Math.min(Math.PI, age * 9))
    }

    cam.position.x = cx
    cam.position.y = cy
    cam.position.z = cz
    aim.x = bx + fx * rig.lookAhead
    aim.y = rig.aim + rig.aimFollow * ay + lifted
    aim.z = bz + fz * rig.lookAhead
    cam.lookAt(aim)
    // lean with the board: right rail down rolls the camera to the right
    const roll = rig.roll * st[BANK]
    if (roll !== 0 || tilt !== 0) cam.rotateZ(-roll + tilt)
    if (nod !== 0) cam.rotateX(nod)
  }

  return {
    get mode() { return mode },
    setMode,
    update,
    reset() {
      snap = true
      round = false
      sideFlip = 1
    },
    dispose() {
      window.removeEventListener('hr:camera-next', onNext)
      window.removeEventListener('hr:camera-set', onSet)
    },
  }
}
