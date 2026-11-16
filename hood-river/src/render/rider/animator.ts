/**
 * Turns the rider state into a pose, every frame.
 *
 * Everything is solved in the board's frame (origin at the front wing, +X nose, +Y deck
 * normal, +Z starboard = the rider's toe side). The ideas that make it look like foiling:
 *
 *  - On foil the load on the rider acts along the deck normal (a banked wing carries him
 *    like a banked aeroplane), so the line from feet to hips follows the deck, not gravity.
 *    He rolls the board by moving ahead of it: the body commits to the commanded bank a
 *    moment before the board gets there, and comes back up first on the way out.
 *  - Toe side he tips over as one straight line and reaches for the water. Heel side
 *    nobody leans back blind: he sits, hips out over the heel rail, chest turned toward
 *    the nose, torso upright in the world, paddle held out over the toe rail as a
 *    counterweight.
 *  - A pump leaves the body's mass almost where it was: the legs fold as the board comes up
 *    and drive it down, the torso folding at the top and the arms thrown up on the way.
 *    Slow, each pump is a paddle stroke timed with the legs.
 *  - Floating, the board lies on the water and he stands plumb over it and paddles: reach,
 *    catch, pull to the feet, a wide low recovery, the legs pressing through the pull.
 *
 *  - Fore and aft he stands square to the deck, as he does sideways: the wing carries him
 *    along the mast whatever the board's attitude (less the drag angle). Only the quick
 *    rocking of a pump goes on under a body that stays where it was. Down a drop and after
 *    lift-off the hips go toward the front foot.
 *  - The paddle changes side in front of him, blade swung over the nose, and only once the
 *    blade is out of the water. It is never allowed through his head, his trunk or the board.
 *
 * Phase-driven motion (strokes, pumps) is written as smooth periodic functions and blended
 * with eased envelopes, so nothing pops when modes or strokes change.
 *
 * Everything is read from the state it is given (app.view): the lean he is asking for is
 * the state's steerSmooth, never the live controls.
 *
 * Each frame: readSignals (what is going on, eased) -> readStrokes (the one stroke phase and
 * the paddle's side) -> posture (feet, hips, torso) -> head -> armsAndPaddle -> the fall, if
 * he has come off -> IK -> seatPaddle -> keepPaddleClear.
 */
import * as THREE from 'three'
import type { App } from '../../app/types'
import { EV, type RiderState } from '../../sim/types'
import { Fall } from './fall'
import { boardHalfWidth } from './board'
import { blendAround, Rig } from './rig'
import { clamp, DEG, lerp, sat, smooth, Spring, Spring3, wobble } from './springs'
import { BODY, PADDLE, RIDER_TUNE as K } from './tune'

const V = () => new THREE.Vector3()
const X = V().set(1, 0, 0)
const Z = V().set(0, 0, 1)
/** shoulder to palm at full stretch (read each time: a character model brings its own sizes) */
const armLength = () => BODY.upperArm + BODY.foreArm
/** share of a paddle stroke with the blade in the water (matches the sim) */
const PULL = 0.65
/** share of a pump that is leg drive (matches the sim) */
const DRIVE = 0.55
/**
 * Changing sides, the lower hand slides up the shaft and the upper one comes down past it:
 * each hand's grip (from the handle) goes with the square of how far it is toward being the
 * lower hand, so they pass each other near the top of the shaft, at GRIP_MID.
 */
const gripAt = (lower: number) => PADDLE.gripTop + (PADDLE.gripLow - PADDLE.gripTop) * lower * lower
const GRIP_MID = gripAt(0.5)
/** how long a dab lasts: down to the water, a touch, and up again (s) */
const DAB_TIME = 0.8
/** a stroke's handle is held at least this far from the spine (m): the top arm has room to fold in front of the chest */
const HANDLE_CLEAR = 0.34

const _a = V(), _b = V(), _c = V(), _d = V(), _e = V()
const _hand = V(), _dir = V(), _top = V(), _free = V()
const _n = V(), _want = V(), _prev = V(), _side = V(), _w = V()
const _piv = V(), _q = V(), _r = V(), _u = V(), _topC = V(), _dirC = V()

/** what is going on this frame: the state's signals, eased, and what was decided from them */
function makeFrame() {
  return {
    dt: 0,
    foil: false, paddling: false,
    /** 1 = the floating, paddling posture; 0 = the riding one */
    wP: 1, wF: 0,
    /** lean command, and eased copies for the chest and the eyes */
    steer: 0, steerLead: 0, steerLook: 0,
    /** how far the body's commitment runs ahead of the board (rad), and the carve it makes: 0..1 each side */
    extra: 0, toe: 0, heel: 0,
    /** load above 1 g, fast-crouch amount, a steep drop, riding low, 0..1 trouble */
    gEx: 0, spd: 0, drop: 0, low: 0, inst: 0, instNow: 0,
    /** speed over stall speed */
    ratio: 1,
    /** impulses: the legs giving on a touchdown, the body thrown forward, weight forward after lift-off */
    touch: 0, lurch: 0, lunge: 0,
    /** pumping: now, or within a breath of the last one; envelopes; phase; 1 = pumps are paddle strokes */
    pumping: false, pumpOn: false, pumpEnv: 0, foldEnv: 0, ph: 0, slow: 1,
    /** 0 = tallest .. 1 = most folded, following the board's heave; and the heave the legs follow */
    fold: 0.5, heave: 0,
    /** the paddle's stroke phase 0..1 and what shapes the stroke */
    stroking: false, sp: 0, idle: 1, rest: 0, hard: 0, share: 0,
    /** which side the paddle is on, -1..1 on its way across; the side its stroke is drawn on; how much of the cross-over pose */
    side: 1, sgn: 1, swap: 0,
    /** floating: weight forward (sprinting on a board the face behind has tipped nose-down) */
    fwd: 0,
    /** body through a stroke: forward hinge, twist toward the paddle side, leg press, weight forward (-1..1 or 0..1) */
    hinge: 0, twist: 0, dig: 0, shift: 0,
    /** arms up after a take-off; the slow top-turn flourish */
    up: 0, topW: 0,
    /** this frame's paddle grips (distance from the handle) and whether the lead hand is on the shaft */
    gripR: PADDLE.gripLow, gripL: 0.12, leftOn: 0, wStroke: 0,
  }
}

export class RiderAnimator {
  readonly rig = new Rig()
  /** paddle: handle end, unit direction from handle to blade tip, the blade's wide axis */
  readonly padTop = V()
  readonly padDir = V().set(-1, 0, 0)
  readonly padWide = V().set(0, 0, 1)
  /**
   * Extra board motion that is the rider's doing and not in the state: he works the floating
   * board with every hard stroke (nose down through the pull, up as the blade comes out),
   * more as the wing starts to carry. Radians, and metres deeper.
   */
  bobPitch = 0
  bobHeave = 0
  /** this frame's blend weights and posture numbers, for a debug readout */
  readonly dbg = {
    wPaddle: 0, toe: 0, heel: 0, lead: 0, unstable: 0, pump: 0, slow: 0, fold: 0,
    stroke: 0, hold: 0, trail: 0, brace: 0, pole: 0, top: 0, up: 0, leftOn: 0, free: 0,
    knee: 0, hipY: 0, flex: 0, chestYaw: 0, side: 0, bladeClear: 0,
    /** cross-over pose, drop crouch, weight forward when floating, the dab, and how far (rad) the paddle was swung clear of the body or the deck */
    swap: 0, drop: 0, fwd: 0, dab: 0, keepOut: 0,
    /** what the paddle was kept clear of this frame: 1 head, 2 trunk, 4 deck, 8 water under a carried blade (added up) */
    keepWhy: 0,
  }

  private f = makeFrame()
  private fall: Fall
  private snap = true
  private time = 0

  // ---- eased signals ----
  private wPaddle = new Spring()
  private extra = new Spring()
  private toe = new Spring()
  private heel = new Spring()
  private steerLead = new Spring()
  private steerLook = new Spring()
  private gEx = new Spring()
  private spd = new Spring()
  private drop = new Spring()
  private low = new Spring()
  private inst = new Spring()
  private touch = new Spring()
  private lurch = new Spring()
  private lunge = new Spring()
  private pumpEnv = new Spring()
  private foldEnv = new Spring()
  private slow = new Spring()
  private strokeIdle = new Spring()
  private rest = new Spring()
  private effort = new Spring()
  private share = new Spring()
  private up = new Spring()
  private topTurn = new Spring()
  private dab = new Spring()
  private brace = new Spring()
  private twoHands = new Spring()
  /** how firmly the lead hand is held to the shaft where the shaft has ended up (0 while it comes on or lets go) */
  private leftLock = new Spring()
  private pumpStroke = new Spring()
  private gripRS = new Spring()
  private gripLS = new Spring()
  private foldS = 0.5
  private heaveS = 0
  private spVis = 0
  /**
   * The board's pitch with the pump's rocking taken out, three ways: slow (the stance he
   * settles into), quick (the crouch a drop asks for) and very quick (what his body goes
   * with at once: he tips the board himself, it does not tip under him).
   */
  private pitchS = 0
  private pitchQ = 0
  private pitchF = 0

  // ---- what has been happening ----
  private pumpIdle = 10
  private pumpSeen = false
  private slowPump = true
  /** the side the paddle is on, or on its way to; the cross-over under way (from, to, 0..1 through it) */
  private sideT = 1
  private sideFrom = 1
  private sideTo = 1
  private cross = 1
  private idleTime = 0
  private tookOff = false
  private celebrate = 0
  private celebrateT = 0
  private inToe = false
  private topLatched = false
  private topTime = 0
  private topSince = 10
  private dabTimer = 0
  private dabArmed = true
  private bladeWet = false

  // ---- smoothed outputs ----
  private palmL = new Spring3()
  private palmR = new Spring3()
  private topS = new Spring3()
  private dirS = new Spring3()
  private gazeS = new Spring3()
  /** each elbow's bend direction last frame, in the chest's frame; each knee's, in the board's */
  private poleL = V()
  private poleR = V()
  private kneeLastL = V()
  private kneeLastR = V()
  /** how far the shaft's direction is being swung to keep the paddle clear (see keepPaddleClear) */
  private corr = V()

  // ---- this frame, in the board frame ----
  private m = new THREE.Matrix4()
  /** world up; the board's fore-aft and sideways directions levelled; "up" for a hanging arm */
  private upL = V().set(0, 1, 0)
  private Xh = V().set(1, 0, 0)
  private Zh = V().set(0, 0, 1)
  private Ug = V().set(0, 1, 0)
  /** the balance line: from the feet to the hips (unit) */
  private balance = V().set(0, 1, 0)
  private depth = 0.85
  private slopeX = 0
  private slopeZ = 0
  private deckY = 0.91
  private legOffset = 0.13

  constructor(private app: App) {
    this.fall = new Fall(app)
  }

  reset(): void {
    this.snap = true
    this.pumpIdle = 10
    this.pumpSeen = false
    this.slowPump = true
    this.idleTime = 0
    this.tookOff = false
    this.celebrate = 0
    this.celebrateT = 0
    this.inToe = false
    this.topLatched = false
    this.topSince = 10
    this.dabTimer = 0
    this.dabArmed = true
    this.bladeWet = false
    this.corr.set(0, 0, 0)
    this.touch.snap(0)
    this.lurch.snap(0)
    this.fall.reset()
    this.bobPitch = 0
    this.bobHeave = 0
  }

  update(dtIn: number, m: THREE.Matrix4, s: RiderState, events: number): void {
    const rig = this.rig
    const f = this.f
    f.dt = Math.min(Math.max(dtIn, 0), 0.1)
    this.time = this.app.time
    this.m.copy(m)
    const e = m.elements
    this.upL.set(e[1], e[5], e[9])
    this.Xh.copy(X).addScaledVector(this.upL, -this.upL.x).normalize()
    this.Zh.crossVectors(this.Xh, this.upL)
    this.depth = s.depth
    this.slopeX = s.slopeX
    this.slopeZ = s.slopeZ

    this.readSignals(s, events)
    this.readStrokes(s, events)
    this.posture(s)
    this.head(s)
    this.armsAndPaddle(s, events)
    this.fall.apply(f.dt, s, events, m, rig, this.upL, this.deckY, this.padTop, this.padDir)
    this.dbg.free = this.fall.amount
    this.limitKnee(-1)
    this.limitKnee(1)
    rig.solveLegs()
    this.keepPalmsClear()
    this.limitElbow(-1)
    this.limitElbow(1)
    rig.solveArms()
    this.seatPaddle()
    this.keepPaddleClear()
    this.finishPaddle(s)

    this.fall.remember(rig, s, m)
    this.snap = false
  }

  // =====================================================================================
  // helpers
  // =====================================================================================

  private to(sp: Spring, target: number, omega: number): number {
    return this.snap ? sp.snap(target) : sp.step(target, omega, this.f.dt)
  }

  /** local height (y) of the water surface under a point of the board frame (plane through the rider) */
  private waterY(x: number, z: number): number {
    const e = this.m.elements
    const y0 = this.depth
    const dxw = e[0] * x + e[4] * y0 + e[8] * z
    const dzw = e[2] * x + e[6] * y0 + e[10] * z
    const rise = this.slopeX * dxw + this.slopeZ * dzw
    const u = this.upL
    return (this.depth + rise - x * u.x - z * u.z) / Math.max(0.3, u.y)
  }

  /** height of a board-frame point above the real water surface (leaves its world position in _w) */
  private clearance(p: THREE.Vector3): number {
    _w.copy(p).applyMatrix4(this.m)
    return _w.y - this.app.sim.waves.height(_w.x, _w.z, this.app.time)
  }

  /** pelvis height above the deck that gives this much knee bend */
  private hipFor(kneeDeg: number): number {
    const reach = 2 * BODY.thigh * Math.cos(0.5 * clamp(kneeDeg, 3, 125) * DEG)
    return Math.sqrt(Math.max(0.01, reach * reach - this.legOffset * this.legOffset)) + BODY.ankle
  }

  /** a point at arm's reach: elevation from hanging (deg), azimuth from straight out to the side toward the chest's front (deg) */
  private armPoint(out: THREE.Vector3, sign: number, elevDeg: number, azDeg: number, reach: number): THREE.Vector3 {
    const rig = this.rig
    const el = elevDeg * DEG, az = azDeg * DEG
    const se = Math.sin(el), ce = Math.cos(el)
    const sh = sign < 0 ? rig.shoulderL : rig.shoulderR
    out.copy(this.Ug).multiplyScalar(-ce)
      .addScaledVector(rig.chestRight, sign * Math.cos(az) * se)
      .addScaledVector(rig.chestFwd, Math.sin(az) * se)
    return out.multiplyScalar(reach * armLength()).add(sh)
  }

  /** which way an elbow would like to bend: out to the side, and with the hand below the shoulder also back and down */
  private elbowWant(out: THREE.Vector3, sign: number): void {
    const rig = this.rig
    const sh = sign < 0 ? rig.shoulderL : rig.shoulderR
    const aim = sign < 0 ? rig.palmAimL : rig.palmAimR
    const n = _n.subVectors(aim, sh)
    const len = n.length()
    // (elevation measured against at least a forearm's length, so a hand close in does not swing it about)
    const hi = smooth(-0.35, 0.45, n.dot(this.Ug) / Math.max(0.35, len))
    out.copy(rig.chestRight).multiplyScalar(sign * lerp(0.45, 1, hi))
      .addScaledVector(this.Ug, lerp(-0.55, 0.12, hi))
      .addScaledVector(rig.chestFwd, lerp(-0.55, -0.2, hi))
  }

  /**
   * No rule for an elbow or a knee works for every limb direction (somewhere the preferred
   * direction lines up with the limb and the joint would flip), so its swivel about the
   * line from root to hand or foot is rate-limited: it swings round, never jumps. Takes the
   * direction wanted in `pole` and last frame's in `prev`, and leaves in `pole` the one to use.
   */
  private swivel(pole: THREE.Vector3, root: THREE.Vector3, aim: THREE.Vector3, prev: THREE.Vector3): void {
    const n = _n.subVectors(aim, root)
    const len = n.length()
    if (len < 1e-3) return
    n.multiplyScalar(1 / len)
    const want = _want.copy(pole)
    want.addScaledVector(n, -want.dot(n))
    prev.addScaledVector(n, -prev.dot(n))
    if (want.lengthSq() < 1e-6) want.copy(prev)
    if (this.snap || prev.lengthSq() < 1e-6) prev.copy(want)
    if (prev.lengthSq() < 1e-6) return
    want.normalize()
    prev.normalize()
    const side = _side.crossVectors(n, prev)
    const step = clamp(Math.atan2(side.dot(want), prev.dot(want)), -9 * this.f.dt, 9 * this.f.dt)
    pole.copy(prev).multiplyScalar(Math.cos(step)).addScaledVector(side, Math.sin(step))
  }

  /** (an elbow's last direction is carried in the chest's frame, so it turns with the body) */
  private limitElbow(sign: number): void {
    const rig = this.rig
    const pole = sign < 0 ? rig.elbowPoleL : rig.elbowPoleR
    const last = sign < 0 ? this.poleL : this.poleR
    _prev.copy(rig.chestRight).multiplyScalar(last.x).addScaledVector(rig.torso, last.y).addScaledVector(rig.chestFwd, last.z)
    this.swivel(pole, sign < 0 ? rig.shoulderL : rig.shoulderR, sign < 0 ? rig.palmAimL : rig.palmAimR, _prev)
    last.set(pole.dot(rig.chestRight), pole.dot(rig.torso), pole.dot(rig.chestFwd))
  }

  private limitKnee(sign: number): void {
    const rig = this.rig
    const pole = sign < 0 ? rig.kneePoleL : rig.kneePoleR
    const last = sign < 0 ? this.kneeLastL : this.kneeLastR
    this.swivel(pole, sign < 0 ? rig.hipL : rig.hipR, sign < 0 ? rig.ankleL : rig.ankleR, _prev.copy(last))
    last.copy(pole)
  }

  /** whatever the hands are doing, a palm is never inside its own shoulder */
  private keepPalmsClear(): void {
    const rig = this.rig
    for (let k = 0; k < 2; k++) {
      const sh = k === 0 ? rig.shoulderL : rig.shoulderR
      const aim = k === 0 ? rig.palmAimL : rig.palmAimR
      const d = _b.subVectors(aim, sh).length()
      if (d < 0.2) {
        _b.addScaledVector(rig.chestFwd, 0.2 - d)
        if (_b.lengthSq() < 1e-6) _b.copy(rig.chestRight)
        aim.copy(sh).addScaledVector(_b.normalize(), 0.2)
      }
    }
  }

  /**
   * Paddle pose through a stroke: handle position and shaft direction (handle to tip).
   * p runs 0..1 from the catch; the blade is in the water for the first PULL of it. The
   * top hand stays in front of the forehead and the shaft swings from reaching forward to
   * just past vertical, burying the blade; then the blade slices out sideways and comes
   * forward in a wide low arc (with a long paddle it cannot do anything else).
   * `sgn` is the side (+1 right, -1 left), `hard` 0 for a cruise stroke and 1 for a sprint,
   * `hover` raises the blade (waiting between strokes).
   */
  private strokePose(p: number, sgn: number, hard: number, hover: number, top: THREE.Vector3, dir: THREE.Vector3): void {
    const gc = K.catchShaft * DEG * (0.85 + 0.15 * hard)
    const ge = (-2 - 5 * hard) * DEG
    const depth = lerp(K.bladeDepthCruise, K.bladeDepthSprint, hard)
    let gam: number, lam: number, tipH: number, hx: number
    if (p < PULL) {
      const q = p / PULL
      const bury = smooth(0, 0.28, q)
      gam = lerp(gc, ge, 0.6 * smooth(0, 1, q) + 0.4 * q)
      lam = (5 + 19 * smooth(0.6, 1, q)) * DEG
      tipH = 0.03 * (1 - bury) - depth * bury * (1 - 0.72 * smooth(0.68, 1, q))
      hx = lerp(0.5, 0.4, q)
    } else {
      const r = (p - PULL) / (1 - PULL)
      gam = lerp(ge, gc, smooth(0, 1, r))
      lam = (lerp(24, 5, smooth(0, 1, r)) + 17 * Math.sin(Math.PI * r)) * DEG
      tipH = lerp(-0.28 * depth, 0.03, smooth(0, 0.3, r)) + 0.17 * Math.sin(Math.PI * r)
      hx = lerp(0.4, 0.5, r)
    }
    // (never behind the forehead, however far he is hinged over)
    hx = Math.max(hx + 0.05 * hard, this.rig.head.x + 0.1)
    let hz = sgn * 0.2
    const wF = this.f.wF
    if (wF > 1e-3) {
      // Flying, the stroke goes with a body that folds and stands: the top hand is held in
      // front of the forehead wherever the head is (a fixed place over the board would have
      // the torso folding into the shaft), a little toward the paddle's side.
      const rig = this.rig
      _n.copy(rig.gaze).addScaledVector(this.upL, -rig.gaze.dot(this.upL)).addScaledVector(this.Xh, 0.6)
      if (_n.lengthSq() < 1e-4) _n.copy(this.Xh)
      _n.normalize()
      hx = lerp(hx, rig.head.x + 0.3 * _n.x, wF)
      // (stacked over the blade, out to the paddle's side of his face, and never over the
      // middle of the board: the shaft goes down outside the rail)
      hz = lerp(hz, sgn * Math.max(0.3, sgn * (rig.head.z + 0.3 * _n.z) + 0.24), wF)
    }
    // Paddling down a steep face he leans down it with the board (posture: `fwd`), and the
    // stroke goes with him: a shaft kept plumb to the horizon there would reach far down
    // the face from a top hand at his waist. Its frame pitches with the body, by the same share.
    const lean = 0.72 * this.f.fwd * Math.atan2(this.Xh.y, this.upL.y)
    const cs = Math.cos(lean), sn = Math.sin(lean)
    const cl = Math.cos(lam)
    const sg = Math.sin(gam) * cl, cg = Math.cos(gam) * cl
    dir.copy(this.Xh).multiplyScalar(sg * cs - cg * sn)
      .addScaledVector(this.upL, -sg * sn - cg * cs)
      .addScaledVector(this.Zh, sgn * Math.sin(lam))
    const tipX = hx + PADDLE.length * dir.x
    const tipZ = hz + PADDLE.length * dir.z
    const tipY = this.waterY(tipX, tipZ) + tipH + hover
    top.set(hx, tipY - PADDLE.length * dir.y, hz)
    // Nor is the top hand held against his chest. A body still plumb on a board that has
    // pitched down under it has its forehead over its breastbone, not ahead of it, and the
    // handle would come in to the chest with the top arm folded into the ribs: it keeps
    // its distance from the spine, pushed out level with the deck (ahead, mostly).
    {
      const rig = this.rig
      const sx = rig.chest.x - rig.pelvis.x, sy = rig.chest.y - rig.pelvis.y, sz = rig.chest.z - rig.pelvis.z
      const px = top.x - rig.pelvis.x, py = top.y - rig.pelvis.y, pz = top.z - rig.pelvis.z
      const u = sat((px * sx + py * sy + pz * sz) / Math.max(1e-6, sx * sx + sy * sy + sz * sz))
      const dx = px - u * sx, dy = py - u * sy, dz = pz - u * sz
      const want = HANDLE_CLEAR * HANDLE_CLEAR - dy * dy
      const flatSq = dx * dx + dz * dz
      if (flatSq < want) {
        const al = Math.hypot(dx + 0.1, dz)
        const ax = al > 0.02 ? (dx + 0.1) / al : 1, az = al > 0.02 ? dz / al : 0
        const b = dx * ax + dz * az
        const m = -b + Math.sqrt(Math.max(0, b * b - flatSq + want))
        top.x += ax * m
        top.z += az * m
        top.y = this.waterY(top.x + PADDLE.length * dir.x, top.z + PADDLE.length * dir.z) + tipH + hover - PADDLE.length * dir.y
      }
    }
    // The shaft goes down outside the rail. Plumb in the world it leans in over a board that
    // is banked away from the stroke (paddling on the high side of a turn) and would cut
    // through its edge: there it leans out instead, enough to pass the deck a hand's width
    // off the board.
    if (dir.y < -0.3) {
      const t = (top.y - this.deckY) / -dir.y
      if (t > 0.05 && t < PADDLE.length) {
        const F = this.app.sim.P.foil
        const noseX = K.mastFrac * F.boardLength, tailX = noseX - F.boardLength
        const x = top.x + dir.x * t
        const over = smooth(noseX + 0.12, noseX - 0.05, x) * smooth(tailX - 0.12, tailX + 0.05, x)
        const need = over * (boardHalfWidth(F.boardLength, F.boardWidth, x) + 0.07 - sgn * (top.z + dir.z * t))
        if (need > 0) {
          dir.z += (sgn * need) / t
          dir.normalize()
          top.y = this.waterY(top.x + PADDLE.length * dir.x, top.z + PADDLE.length * dir.z) + tipH + hover - PADDLE.length * dir.y
        }
      }
    }
  }

  /**
   * The paddle as it changes side: swung forward and over the nose, the shaft well tilted,
   * both hands low in front of the chest where they pass each other on the shaft. The blade
   * crosses ahead of the nose, clear of the deck and of the water.
   */
  private swapPose(top: THREE.Vector3, dir: THREE.Vector3): void {
    const rig = this.rig
    const tilt = clamp(K.swapShaft, 25, 80) * DEG
    dir.copy(this.Xh).multiplyScalar(Math.sin(tilt)).addScaledVector(this.upL, -Math.cos(tilt))
    // where the hands meet: out in front of the chest (level with the water, however far he is hinged over)
    const ahead = _r.copy(rig.chestFwd).addScaledVector(this.upL, -rig.chestFwd.dot(this.upL))
    if (ahead.lengthSq() < 1e-4) ahead.copy(this.Xh)
    ahead.normalize()
    const hands = _q.copy(rig.chest).addScaledVector(ahead, 0.46).addScaledVector(this.upL, -0.22)
    const out = PADDLE.length - GRIP_MID
    const tip = _r.copy(hands).addScaledVector(dir, out)
    const F = this.app.sim.P.foil
    let lift = this.waterY(tip.x, tip.z) + 0.12 - tip.y
    if (Math.abs(tip.z) < boardHalfWidth(F.boardLength, F.boardWidth, tip.x) + 0.12) lift = Math.max(lift, this.deckY + K.deckClear - tip.y)
    if (lift > 0) {
      tip.y += Math.min(lift, 1.2)
      dir.subVectors(tip, hands).normalize()
    }
    top.copy(hands).addScaledVector(dir, -GRIP_MID)
  }

  /**
   * The steepest bank the rider will lay the board over to at this speed: the sim's own
   * stall guard (physics.ts, "bank"). Near the stall that is next to nothing, and a body
   * that commits to a turn the board cannot make would hang inside it.
   */
  private bankLimit(s: RiderState): number {
    const P = this.app.sim.P
    const D = this.app.sim.D
    let bankMax = P.handling.bankMaxDeg * DEG
    const share = clamp(P.handling.stallGuard, 0, 1)
    if (share > 0) {
      const hc = s.depth / Math.max(0.01, D.chord)
      const surface = s.depth <= 0 ? 0 : (1 + 16 * hc * hc) / (2 + 16 * hc * hc)
      const nAvail = (0.5 * P.env.rhoWater * s.speed * s.speed * P.foil.area * P.foil.clMax * surface * 0.92) / Math.max(1, D.weight)
      const guard = nAvail > 1 ? Math.acos(1 / nAvail) : 0
      bankMax += (Math.min(bankMax, guard) - bankMax) * share
    }
    return bankMax
  }

  // =====================================================================================
  // signals: what is going on, eased
  // =====================================================================================

  private readSignals(s: RiderState, events: number): void {
    const f = this.f
    const dt = f.dt
    const P = this.app.sim.P
    const foil = f.foil = s.mode === 'foil'
    f.paddling = s.mode === 'paddle'
    f.wP = this.to(this.wPaddle, foil ? 0 : 1, 9)
    f.wF = 1 - f.wP

    // What he is asking for: the state's smoothed lean command. The body is the first thing
    // to move: head, then chest, then hips, then the board rolls, then the track bends.
    // (That copy trails the key by 0.08 s, so the springs that follow it are stiff.)
    const steer = f.steer = clamp(s.steerSmooth, -1, 1)
    const leadMax = K.leadMaxDeg * DEG
    // The body's commitment runs ahead of the board by a share of the bank still to come:
    // the bank the board is really going to be given, which near the stall is next to none.
    const bankAsked = steer * this.bankLimit(s)
    f.extra = this.to(this.extra, foil ? clamp(K.lead * (0.82 * bankAsked - s.bank), -leadMax, leadMax) : 0, 54)
    const phi = s.bank + f.extra
    const full = Math.max(10, K.carveFullDeg) * DEG
    f.toe = this.to(this.toe, foil ? smooth(3 * DEG, full, phi) : 0, 18)
    f.heel = this.to(this.heel, foil ? smooth(3 * DEG, full, -phi) : 0, 18)
    f.steerLead = this.to(this.steerLead, foil ? steer : 0, 17)
    f.steerLook = this.to(this.steerLook, foil ? steer : 0, 64)
    f.gEx = this.to(this.gEx, foil ? clamp(s.gLoad - 1, -0.35, 0.8) : 0, 10)
    f.spd = this.to(this.spd, foil ? smooth(7.2, 10, s.speed) : 0, 6)
    f.low = this.to(this.low, foil ? smooth(0.17, 0.03, s.rideHeight) : 0, 12)
    f.ratio = s.speed / Math.max(0.1, this.app.sim.D.vStall)
    // The board's attitude with the pump's rocking taken out (the sim adds that rock to the
    // pitch it reports: physics.ts, "a pump rocks the board"): slowly, for how he stands on
    // it, and quickly, for the crouch a drop asks for. Nose well down = a drop.
    let rock = 0
    if (foil && s.pumpPhase >= 0) {
      rock = -0.7 * ((2 * Math.PI * P.pump.heave) / (Math.max(0.2, P.pump.cycle) * Math.max(s.speed, 4))) *
        Math.cos(2 * Math.PI * Math.min(1, s.pumpPhase))
    }
    const steady = s.pitch - rock
    if (this.snap) this.pitchS = this.pitchQ = this.pitchF = steady
    else {
      this.pitchS += (steady - this.pitchS) * (1 - Math.exp(-dt / 0.25))
      this.pitchQ += (steady - this.pitchQ) * (1 - Math.exp(-dt / 0.12))
      this.pitchF += (steady - this.pitchF) * (1 - Math.exp(-dt / 0.08))
    }
    // (a drop is nose-down with speed in hand: nose-down and slow is only the face he has just lifted off)
    f.drop = this.to(this.drop, foil ? smooth(5 * DEG, 13 * DEG, -this.pitchQ) * smooth(1.15, 1.5, f.ratio) : 0, 16)

    // how close to losing it: arms come out, the stance drops a little, everything wobbles
    let instNow = 0
    if (foil) {
      instNow = Math.max(
        s.stalled ? 1 : 0, s.touching ? 0.85 : 0, s.breached ? 1 : 0, Math.min(1, s.tipOut * 2.5),
        0.6 * smooth(1.22, 1.02, f.ratio),
        0.5 * smooth(0.85, 1, s.cl / Math.max(0.1, P.foil.clMax)),
        0.5 * smooth(70 * DEG, 125 * DEG, Math.abs(s.bankRate)),
      )
    } else if (f.paddling) {
      instNow = 0.3 * smooth(0.1, 0.3, Math.hypot(s.slopeX, s.slopeZ))
    }
    f.instNow = instNow
    f.inst = this.to(this.inst, instNow, instNow > this.inst.x ? 14 : 4)

    // touchdown: the legs give and the body pitches forward as the hull grabs
    if (events & EV.TOUCHDOWN) { this.touch.v += 8; this.lurch.v += 0.8 }
    if (events & EV.OFF_FOIL) this.touch.v += 3.5
    f.touch = this.snap ? this.touch.snap(0) : clamp(this.touch.step(0, 11, dt), 0, 0.6)
    f.lurch = this.snap ? this.lurch.snap(0) : this.lurch.step(0, 9, dt)

    // lift-off: weight forward over the front foot for a moment, still stroking
    if (events & EV.TAKEOFF) this.tookOff = true
    if (!foil) this.tookOff = false
    const lungeTime = Math.max(0.1, K.lungeTime)
    f.lunge = this.to(this.lunge, this.tookOff ? 1 - smooth(0.45 * lungeTime, lungeTime, s.modeTime) : 0, 10)

    // pumping: an envelope that bridges the short gaps between held pumps
    const pumping = f.pumping = foil && s.pumpPhase >= 0
    if (pumping) { this.pumpIdle = 0; this.pumpSeen = true } else this.pumpIdle += dt
    if (!foil) this.pumpSeen = false
    const pumpOn = f.pumpOn = pumping || (this.pumpSeen && this.pumpIdle < 0.14)
    f.pumpEnv = this.to(this.pumpEnv, pumpOn ? 1 : 0, pumpOn ? 22 : 7)
    f.foldEnv = this.to(this.foldEnv, pumpOn ? 1 : 0, pumpOn ? 9 : 6)
    f.ph = pumping ? s.pumpPhase : 0
    // Slow pumps are paddle strokes, fast ones carry the paddle. Chosen once per pump (as it
    // starts, or late in the one before so the change happens on the recovery), with a little
    // hysteresis, so a pump is never half a stroke. Floating counts as slow, so the first
    // pumps after a take-off are still strokes.
    if (!foil) this.slowPump = true
    else if (!pumpOn) this.slowPump = f.ratio < K.paddlePumpBelow
    else if (!pumping || f.ph > 0.72 || (events & EV.PUMP)) {
      if (f.ratio < K.paddlePumpBelow - 0.05) this.slowPump = true
      else if (f.ratio > K.paddlePumpBelow + 0.05) this.slowPump = false
    }
    f.slow = this.to(this.slow, this.slowPump ? 1 : 0, 15)
    // The fold follows the board's own heave, a beat behind: most folded as the board tops
    // out, tallest just after it bottoms. (Taken from the heave rather than the phase, so it
    // stays right whatever the pump's timing is tuned to.)
    // (The heave the legs follow is the state's, except that it never jumps: a pump cut
    // short by a touchdown lets the board go from under him in one step.)
    const heaveAmp = Math.max(0.02, P.pump.heave)
    const heaveStep = Math.max(2.5, 30 * heaveAmp) * dt
    if (this.snap) this.heaveS = s.heave; else this.heaveS += clamp(s.heave - this.heaveS, -heaveStep, heaveStep)
    f.heave = this.heaveS
    const foldRaw = sat(0.5 - (0.5 * f.heave) / heaveAmp)
    if (this.snap) this.foldS = foldRaw; else this.foldS += (foldRaw - this.foldS) * (1 - Math.exp(-dt / Math.max(0.005, K.pumpLag)))
    f.fold = this.foldS

    // both arms up for a moment once a take-off has settled
    if (events & EV.TAKEOFF) { this.celebrate = 1; this.celebrateT = 0 }
    if (!foil) this.celebrate = 0
    if (this.celebrate === 1 && s.modeTime > lungeTime && this.pumpEnv.x < 0.12 && f.ratio > 1.18 &&
        Math.abs(s.bank) < 14 * DEG && Math.abs(steer) < 0.3 && instNow < 0.3) {
      this.celebrate = 2
      this.celebrateT = 0
    }
    if (this.celebrate === 2) {
      this.celebrateT += dt
      if (this.celebrateT > 0.62 || pumping || Math.abs(steer) > 0.45 || instNow > 0.6) this.celebrate = 0
    }
    f.up = this.to(this.up, this.celebrate === 2 ? 1 : 0, this.celebrate === 2 ? 13 : 8)

    // A slow toe-side turn high on a bump is ridden differently from a fast one: pitched over
    // the toe rail with the paddle arm thrown straight up. Decided as the turn sets (at any
    // moment of its first 0.4 s). It is a flourish at the top of the turn, not a held pose,
    // and not for a rider who is busy pumping to stay up.
    if (f.toe > 0.5 && !this.inToe) {
      this.inToe = true
      this.topLatched = false
      this.topTime = 0
    }
    if (f.toe < 0.3) this.inToe = false
    this.topTime += dt
    this.topSince += dt
    if (this.inToe && !this.topLatched && this.topTime < 0.4 && s.crest > K.topTurnCrest &&
        f.ratio > K.topTurnMin && f.ratio < K.topTurnMax && this.pumpIdle > 1.2) {
      this.topLatched = true
      this.topSince = 0
    }
    if (pumpOn || !this.inToe) this.topLatched = false
    f.topW = this.to(this.topTurn, this.topLatched && this.topSince < 0.7 ? 1 : 0, 8) * f.toe
  }

  // =====================================================================================
  // strokes: one phase for the paddle, and how the body goes through it
  // =====================================================================================

  private readStrokes(s: RiderState, events: number): void {
    const f = this.f
    const dt = f.dt
    const P = this.app.sim.P
    const { foil, paddling } = f
    const stroking = f.stroking = paddling && s.strokePhase >= 0

    // ---- which side the paddle is on ----
    // On foil every stroke and carry is on the toe side, the lower hand the rear hand that
    // carries the paddle, so no carry ever needs the hands swapped. Floating, it is the side
    // of the stroke in the water, and once its pull is over the side the sim says the paddle
    // is on (s.paddleSide: the right while paddling up), so that it is across in time for the
    // next stroke. It only ever changes side with the blade out of the water (a stroke that
    // lift-off interrupts on the heel side is finished there first), and it goes across in
    // front of him, swung over the nose: see swapPose.
    let sideWanted = 1
    if (!foil) sideWanted = stroking && s.strokePhase <= PULL ? s.strokeSide : s.paddleSide
    const bladeIn = this.spVis > 0.06 && this.spVis <= PULL
    // (just off the foil, the carried paddle comes forward on its own side first)
    const settling = paddling && f.wP < 0.85
    if (this.snap || s.mode === 'swim' || !(bladeIn || settling)) this.sideT = sideWanted
    // The cross-over is timed, not sprung: the blade goes across at an even pace, half the
    // time to the nose and half from it. (Asked back half way, it goes back the way it came.)
    if (this.snap || s.mode === 'swim') {
      this.sideFrom = this.sideTo = this.sideT
      this.cross = 1
    } else if (this.sideT !== this.sideTo) {
      this.sideFrom = this.sideTo
      this.sideTo = this.sideT
      this.cross = 1 - this.cross
    }
    const cross = this.cross = Math.min(1, this.cross + dt / clamp(K.swapTime, 0.2, 3))
    f.side = lerp(this.sideFrom, this.sideTo, cross * cross * (3 - 2 * cross))
    f.sgn = cross < 0.5 ? this.sideFrom : this.sideTo
    f.swap = Math.sin(Math.PI * cross) ** 2
    // still on its way across: the stroke to come waits for it at the catch
    const waiting = cross < 0.82

    // One stroke phase for the paddle, whoever is asking for strokes, so it never jumps:
    // floating it follows the sim's; in a slow pump it follows the leg drive; and a stroke
    // that is cut short (lift-off or a touchdown comes mid-pull) is carried through to its end.
    const strokeRate = dt / Math.max(0.2, P.paddle.strokeTime)
    if (this.snap || s.mode === 'swim') this.spVis = stroking ? Math.min(1, s.strokePhase) % 1 : 0
    let ask = -1
    if (stroking) ask = Math.min(1, s.strokePhase)
    else if (foil && f.pumpOn && this.slowPump) {
      const ph = f.ph
      ask = !f.pumping ? 0 : ph < DRIVE ? (ph / DRIVE) * PULL : PULL + ((ph - DRIVE) / (1 - DRIVE)) * (1 - PULL)
    }
    if (ask >= 0) {
      let ahead = ask - this.spVis
      ahead -= Math.floor(ahead)
      // locked on when in step; catch up if the stroke asked for is ahead, idle along if it is
      // behind; and a stroke already half over when the paddle gets there is let go by
      let step = ahead < 0.5 ? Math.min(ahead, 1.6 * strokeRate) : this.spVis > 0 ? 0.4 * strokeRate : 0
      if (waiting) {
        if (this.spVis > PULL) step = Math.min(step, 0.999 - this.spVis)
        else { step = 0; this.spVis = 0 }
      }
      this.spVis += Math.max(0, step)
      this.spVis -= Math.floor(this.spVis)
    } else if (this.spVis > 0) {
      this.spVis += strokeRate
      if (this.spVis >= 1) this.spVis = 0
    }
    const sp = f.sp = this.spVis
    const strokeOn = stroking || sp > 0
    f.idle = this.to(this.strokeIdle, strokeOn ? 0 : 1, strokeOn ? 15 : 6)
    // left alone for a moment he stops hovering the blade and rests it on the water as a brace
    // (and that is how he stands up after climbing back on)
    if (s.mode === 'swim') this.idleTime = 1
    else if (paddling && !stroking) this.idleTime += dt
    else this.idleTime = 0
    const resting = !foil && this.idleTime > 0.7
    f.rest = this.to(this.rest, resting ? 1 : 0, resting ? 5 : 13)
    // (a paddle-pump is a middling stroke)
    const eff = this.to(this.effort, stroking ? s.effort : paddling ? this.effort.x : 0.75, 14)
    f.hard = sat((eff - 0.45) / 0.55)
    // how much of the weight the wing has taken (all of it once flying)
    f.share = this.to(this.share, paddling ? sat(s.gLoad) : foil ? 1 : 0, 12)

    // the body through a stroke: hinge to the catch, unwind through the pull, legs pressing
    if (sp < PULL) {
      const q = sp / PULL
      f.hinge = lerp(1, 0, smooth(0.08, 1, q))
      f.twist = lerp(1, -0.7, smooth(0.05, 0.95, q))
      f.dig = lerp(0.55, 1, smooth(0, 0.35, q)) * (1 - 0.85 * smooth(0.6, 1, q))
      f.shift = lerp(1, -0.4, q)
    } else {
      const r = (sp - PULL) / (1 - PULL)
      f.hinge = smooth(0, 1, r)
      f.twist = lerp(-0.7, 1, smooth(0, 1, r))
      f.dig = lerp(0.15, 0.55, smooth(0.3, 1, r))
      f.shift = lerp(-0.4, 1, r)
    }

    // working the board onto the wing: it rocks and bobs under him with each hard stroke
    const bob = f.wP * (1 - f.idle) * f.hard * (0.35 + 0.65 * f.share)
    this.bobPitch = -2.6 * DEG * bob * Math.cos(2 * Math.PI * (sp - 0.15))
    this.bobHeave = 0.018 * bob * Math.cos(2 * Math.PI * (sp - 0.2))
  }

  // =====================================================================================
  // posture: feet, hips, torso
  // =====================================================================================

  private posture(s: RiderState): void {
    const f = this.f
    const rig = this.rig
    const P = this.app.sim.P
    const { upL } = this
    const { toe, heel, wP, wF, touch, inst, idle, rest, hard } = f

    // ---- feet: planted where the footage puts them, toes toward the starboard rail ----
    const F = P.foil
    const deckY = this.deckY = F.mastLength + K.boardThick
    // (the nose is mastFrac of the board's length ahead of the mast: see boardEnds)
    const nose = K.mastFrac * F.boardLength
    const yawF = K.frontFootYaw * DEG, yawR = K.rearFootYaw * DEG
    rig.toeDirL.set(Math.sin(yawF), 0, Math.cos(yawF))
    rig.toeDirR.set(Math.sin(yawR), 0, Math.cos(yawR))
    const back = BODY.footLen / 2 - BODY.footBack
    // (the stance is a share of the board's length, but never narrower or wider than a man can stand)
    const stanceMid = nose - 0.5 * (K.frontFoot + K.rearFoot) * F.boardLength
    const stanceHalf = 0.5 * clamp((K.rearFoot - K.frontFoot) * F.boardLength, 0.34, 0.85)
    rig.ankleL.set(stanceMid + stanceHalf, deckY + BODY.ankle, -K.stagger / 2).addScaledVector(rig.toeDirL, -back)
    rig.ankleR.set(stanceMid - stanceHalf, deckY + BODY.ankle, K.stagger / 2).addScaledVector(rig.toeDirR, -back)
    rig.soleUpL.set(0, 1, 0)
    rig.soleUpR.set(0, 1, 0)
    // the hips' rest point on the deck: between the feet, over the balls of the feet
    const x0 = (rig.ankleL.x + rig.ankleR.x) / 2 + 0.02
    const z0 = (rig.ankleL.z + rig.ankleR.z) / 2 + 0.05
    {
      // how far each hip joint stands off its ankle in plan, for turning knee bend into hip height
      const yaw = K.pelvisGlide * DEG
      const hx = -Math.cos(yaw) * BODY.hipHalf, hz = Math.sin(yaw) * BODY.hipHalf
      this.legOffset = 0.5 * (
        Math.hypot(rig.ankleL.x - (x0 - hx), rig.ankleL.z - (z0 - hz)) +
        Math.hypot(rig.ankleR.x - (x0 + hx), rig.ankleR.z - (z0 + hz)))
    }

    // ---- on foil: knees ----
    // A carve, a fast crouch and a drop do not stack: he is as low as the deepest of them
    // asks and a little more for the next, and never lower than a crouch (or, heel side, a sit).
    const kneeCarve = (K.kneeToe - K.kneeGlide) * toe + (K.kneeHeel - K.kneeGlide) * heel
    const kneeFast = K.kneeSpeed * f.spd
    const kneeDrop = K.kneeDrop * f.drop
    const kneeMost = Math.max(kneeCarve, kneeFast, kneeDrop)
    const kneeNext = kneeCarve + kneeFast + kneeDrop - kneeMost - Math.min(kneeCarve, kneeFast, kneeDrop)
    // (The legs also give a little whenever the hips are carried off centre: leaning into a
    // turn ahead of the board, and while the board is tipping faster than he follows it. A
    // leg is never left locked straight beside a bent one.)
    const pitchNow = Math.asin(clamp(upL.x, -1, 1))
    const kneeGive = Math.min(20, K.kneeGive * (Math.abs(f.extra) + Math.abs(pitchNow - this.pitchF)) / DEG)
    const kneeF = Math.min(lerp(K.kneeCrouchMax, K.kneeSitMax, heel),
      K.kneeGlide + kneeMost + 0.3 * kneeNext + K.kneeLoad * f.gEx + 12 * f.low + 8 * inst + K.kneeLunge * f.lunge + kneeGive) + 90 * touch
    let hipF = this.hipFor(kneeF)
    {
      // pumping: the legs work between the tall and folded knee angles as the board heaves
      const tall = this.hipFor(K.pumpKneeTall), folded = this.hipFor(K.pumpKneeFold)
      const sit = this.hipFor(K.kneeGlide) - this.hipFor(K.kneeGlide + 0.5 * (K.kneeHeel - K.kneeGlide) * heel)
      hipF = lerp(hipF, 0.5 * (tall + folded) - sit - 0.2 * touch, f.pumpEnv) + (f.heave * (tall - folded)) / (2 * Math.max(0.02, P.pump.heave))
    }
    // ---- floating and paddling: knees ----
    // (floating, the knees take up the tilt of the board on the water)
    const kneeP = K.kneePaddle + K.kneeDig * (0.3 + 0.7 * hard) * lerp(f.dig, 0.3, idle) * (1 - rest) + 8 * inst + 70 * touch +
      Math.min(16, (K.kneeGive * Math.abs(pitchNow)) / DEG)
    const hipY = lerp(hipF, this.hipFor(kneeP), wP) + this.bobHeave

    // ---- the way he faces ----
    const pelvisYawF = K.pelvisGlide + (K.pelvisHeel - K.pelvisGlide) * heel - 3 * toe
    let chestYawF = K.chestGlide + (K.chestHeel - K.chestGlide) * heel + (K.chestToe - K.chestGlide) * toe + 6 * f.pumpEnv - 8 * f.steerLead
    chestYawF = lerp(chestYawF, 12, f.topW)
    // (finishing a stroke on the heel side after lift-off he is still square to the nose, as he paddled)
    if (f.foil) chestYawF = lerp(chestYawF, 80, 1 - smooth(0.2, 0.9, f.side))
    const pelvisYawP = lerp(58, 50, rest)
    const chestYawP = lerp(86, 74, rest) + f.side * lerp(lerp(f.twist, 0.45, idle), 0.5, rest) * 22
    const pelvisYaw = lerp(pelvisYawF, pelvisYawP, wP) * DEG
    const chestYaw = lerp(chestYawF, chestYawP, wP) * DEG

    // ---- the balance line ----
    // Sideways, on foil the feet-to-hips line follows the deck normal (plus the lead into the
    // turn); floating, it is plumb. (Toe side he stands a little more upright than the deck:
    // the board is rolled further than the body, the weight on the toe rail.)
    const leadLean = Math.tan(f.extra > 0 ? f.extra * 0.9 : f.extra * 0.5)
    const toeGive = upL.z < 0 ? upL.z * K.toeLegsUpright : 0
    // Fore and aft it is the same story: on foil the wing carries him along the mast, so he
    // stands square to the deck whatever its attitude, giving back only a share of the slow
    // pitch toward plumb (the drag angle: a few degrees aft on a nose-down board). The quick
    // part of the pitch, a pump's rocking, goes on under a body that stays plumb.
    // (pitchNeutral is the attitude of an easy glide, where he stands square to the deck;
    // on a board flying nose-high and slow the wing's force is along the mast again, so
    // there he gives nothing back the other way)
    const giveBack = clamp(K.plumbShare * (this.pitchS - K.pitchNeutral * DEG), -K.leanBackMax * DEG, 1.5 * DEG)
    const foreF = Math.tan(clamp(pitchNow - this.pitchF + giveBack, -0.6, 0.6))
    // Floating he stands plumb, the board tipping under him; but sprinting down the face
    // that has lifted the tail he goes with it, weight on the front foot, and on a really
    // steep face he does so whatever he is doing (nobody stands plumb on a board tipped
    // twenty degrees nose-down: he would be sitting on his back foot).
    const fwd = f.fwd = wP * Math.max(hard * (1 - idle) * (1 - rest) * smooth(2 * DEG, 9 * DEG, -this.pitchS), smooth(7 * DEG, 19 * DEG, -this.pitchS))
    const foreP = Math.tan(clamp(pitchNow, -0.6, 0.6)) * 0.85 * (1 - 0.72 * fwd)
    const B = this.balance.set(lerp(foreF, foreP, wP), 1, (leadLean + toeGive) * wF + upL.z * 0.85 * wP).normalize()
    // torso: gives back part of the bank toward plumb (most of it heel side), then hinges forward
    const upright = (upL.z > 0 ? upL.z * K.heelUpright : upL.z * K.toeUpright) * wF
    const headFirst = f.extra > 0 ? 0.35 * Math.sin(f.extra) * wF : 0
    rig.torso0.copy(B).addScaledVector(Z, upright + headFirst).normalize()
    rig.pelvisFwd.set(Math.sin(pelvisYaw), 0, Math.cos(pelvisYaw))
    rig.chestAim.set(Math.sin(chestYaw), 0, Math.cos(chestYaw))
    const F0 = _b.copy(rig.chestAim).addScaledVector(rig.torso0, -rig.chestAim.dot(rig.torso0)).normalize()

    // ---- the hip hinge ----
    // Crouching for load, for speed and for a drop are one crouch: the largest counts. And
    // however the board is tipped, a crouch never folds the chest further from plumb than
    // torsoCrouchMax (lean0 is how far the unhinged spine already leans the way he faces).
    const fore = 1 - 0.4 * heel
    const crouch = Math.max(K.torsoLoad * Math.max(0, f.gEx), K.torsoSpeed * f.spd * fore, K.torsoDrop * f.drop * fore)
    const lean0 = Math.atan2(-upL.dot(F0), upL.dot(rig.torso0)) / DEG
    const flexCrouch = Math.min(
      K.torsoGlide + (K.torsoToe - K.torsoGlide) * toe + (K.torsoHeel - K.torsoGlide) * heel + crouch + 7 * inst,
      Math.max(K.torsoGlide, K.torsoCrouchMax - Math.max(0, lean0)))
    let flexF = flexCrouch + 40 * touch + 30 * f.topW
    // Toe side the hinge is toward the water, on top of the lean: he stays a straight line
    // tilted with the board, the chest never further from plumb than toeLeanMax however
    // fast and loaded the turn.
    flexF -= toe * Math.max(0, flexF + (s.bank / DEG) * (1 - K.toeUpright) - K.toeLeanMax)
    flexF = Math.max(flexF, lerp(flexF, K.lungeTorso, f.lunge))
    flexF = lerp(flexF, lerp(K.pumpTorsoTall, K.pumpTorsoFold, f.fold), f.foldEnv)
    const hingeCatch = lerp(22, K.catchHinge, hard)
    const flexP = lerp(lerp(lerp(K.exitHinge, hingeCatch, f.hinge), 0.62 * hingeCatch, idle), 13, rest) + 32 * touch
    const flex = lerp(flexF, flexP, wP) * DEG
    rig.torso.copy(rig.torso0).multiplyScalar(Math.cos(flex)).addScaledVector(F0, Math.sin(flex))

    // hips: up the balance line, then set back against the torso's lean so the weight stays over the feet
    rig.pelvis.set(x0, deckY, z0).addScaledVector(B, hipY / B.y)
    rig.pelvis.x -= 0.17 * (rig.torso.x - B.x)
    rig.pelvis.z -= 0.17 * (rig.torso.z - B.z)
    // front foot to dive, back foot to climb; and the weight goes forward down a drop, for
    // the moment after lift-off, and sprinting down a face
    rig.pelvis.x += wF * (-0.06 * s.pitchSmooth + Math.min(0.2, K.hipsFwdLunge * f.lunge + K.hipsFwdDrop * f.drop)) + f.lurch +
      0.045 * (0.4 + 0.6 * hard) * lerp(f.shift, 0.3, idle) * (1 - rest) * wP + K.hipsFwdSprint * fwd
    rig.pelvis.z += -0.015 * f.side * wP
    // small restless sway, larger when things are going wrong
    const sway = 0.006 + 0.03 * inst
    rig.pelvis.x += sway * wobble(this.time, 1)
    rig.pelvis.z += sway * wobble(this.time, 2)

    const g = this.dbg
    g.wPaddle = wP; g.toe = toe; g.heel = heel; g.lead = f.extra / DEG; g.unstable = inst; g.pump = f.pumpEnv; g.slow = f.slow; g.fold = f.fold
    g.knee = lerp(kneeF, kneeP, wP); g.hipY = hipY; g.flex = flex / DEG; g.chestYaw = chestYaw / DEG; g.side = f.side
    g.swap = f.swap; g.drop = f.drop; g.fwd = fwd
  }

  // =====================================================================================
  // head, then the trunk and the legs' reach
  // =====================================================================================

  private head(s: RiderState): void {
    const f = this.f
    const rig = this.rig
    const { upL, Xh, Zh } = this
    // eyes on where he is going: along the track, round the turn and into the one he is asking for
    const psi = f.foil
      ? clamp(-s.slip + clamp(s.turnRate * K.lookAhead, -60 * DEG, 60 * DEG) + f.steerLook * K.lookIntoTurn * DEG, -85 * DEG, 85 * DEG)
      : clamp(s.turnRate * 0.5, -0.5, 0.5) + 0.12 * f.side * lerp(f.twist, 0, f.idle)
    const down = (7 + 9 * f.toe + 6 * f.spd + 10 * f.foldEnv * f.fold) * DEG * f.wF + (9 + 8 * f.hinge * (1 - f.idle)) * DEG * f.wP
    const gz = _c.copy(Xh).multiplyScalar(Math.cos(psi)).addScaledVector(Zh, Math.sin(psi))
    gz.multiplyScalar(Math.cos(down)).addScaledVector(upL, -Math.sin(down))
    if (this.snap) this.gazeS.snap(gz); else this.gazeS.step(gz, 16, f.dt)
    rig.gaze.copy(this.gazeS.x).normalize()
    // the head stays level whatever the torso does
    rig.headUp.copy(rig.torso).multiplyScalar(0.3).addScaledVector(upL, 0.7)
    rig.headUp.addScaledVector(rig.gaze, -rig.headUp.dot(rig.gaze)).normalize()

    rig.solveTrunk()
    // the neck only turns so far: keep the gaze within reach of the chest
    const along = rig.gaze.dot(rig.chestFwd)
    if (along < 0.1) {
      rig.gaze.addScaledVector(rig.chestFwd, (0.1 - along) * 1.1).normalize()
      rig.headUp.addScaledVector(rig.gaze, -rig.headUp.dot(rig.gaze)).normalize()
      rig.head.copy(rig.neckTop).addScaledVector(rig.headUp, BODY.head)
    }
    rig.keepFeetPlanted(this.balance)
    rig.kneePoleL.copy(rig.toeDirL).multiplyScalar(0.6).addScaledVector(rig.pelvisFwd, 0.5).addScaledVector(rig.pelvisRight, -0.12)
    rig.kneePoleR.copy(rig.toeDirR).multiplyScalar(0.6).addScaledVector(rig.pelvisFwd, 0.5).addScaledVector(rig.pelvisRight, 0.12)
  }

  // =====================================================================================
  // arms and paddle
  // =====================================================================================

  private armsAndPaddle(s: RiderState, events: number): void {
    const f = this.f
    const rig = this.rig
    const dt = f.dt
    const { upL, Xh, Zh } = this
    const { toe, heel, inst, up, wP, wF } = f
    const Ug = this.Ug.copy(upL).multiplyScalar(0.65).addScaledVector(rig.torso, 0.35).normalize()
    const wob = 9 * inst

    // ---- the free lead arm: out a little for balance; low by the hip heel side ----
    let elL = K.armGlide + (44 - K.armGlide) * heel + K.armUnstable * inst + wob * wobble(this.time, 3)
    let azL = 15 - 3 * heel + wob * wobble(this.time, 4)
    let reachL = 0.86 - 0.04 * heel
    elL = lerp(elL, 158, up); azL = lerp(azL, 25, up); reachL = lerp(reachL, 0.97, up)
    const freeL = this.armPoint(_free, -1, elL, azL, reachL)
    if (toe > 1e-3) {
      // toe side it reaches for the water: toward the inside of the turn and ahead, a set
      // angle below the horizon whatever the body's lean
      const dip = (K.toeReachBelow + wob * wobble(this.time, 3)) * DEG
      _a.copy(Zh).multiplyScalar(0.8).addScaledVector(Xh, 0.6).multiplyScalar(Math.cos(dip)).addScaledVector(upL, -Math.sin(dip))
      _a.multiplyScalar(0.97 * armLength()).add(rig.shoulderL)
      freeL.lerp(_a, toe * (1 - up))
    }

    // ---- how the paddle is carried: each carry is a handle position and a shaft direction ----
    // (A slow pump is a paddle stroke, on the toe side. In a carve the pump is legs only: sat
    // down heel side the water on the toe side is out of reach, and leant over toe side it
    // is so close that the top of the paddle would be over his head. A paddle that lift-off
    // has left on the heel side stays a stroke's paddle until it has come across in front:
    // carried straight from there to a carry it would go through his legs.)
    const crossing = f.foil ? 1 - smooth(0.55, 0.95, f.side) : 0
    const pumpStroke = this.to(this.pumpStroke,
      f.foil ? f.pumpEnv * f.slow * (1 - smooth(0.2, 0.6, heel)) * (1 - smooth(0.45, 0.85, toe)) : 0, 14)
    const wStroke = f.wStroke = Math.max(wP, pumpStroke, crossing)
    const wHold = f.pumpEnv * (1 - f.slow) * wF * (1 - crossing)
    let carry = Math.max(0, 1 - wStroke - wHold)
    const wUp = up * carry
    carry *= 1 - up
    // A dab: once in a carve, as it reaches its hardest (or as a wingtip lets go), the blade
    // goes down to the water, touches and comes back up. It is armed again when the board
    // has come back near level.
    const absBank = Math.abs(s.bank)
    const rearm = Math.min(K.dabRearmDeg, K.dabBankDeg - 4) * DEG
    if (!f.foil || absBank < rearm) this.dabArmed = true
    this.dabTimer -= dt
    if (f.foil && this.dabArmed && absBank > rearm && (absBank > K.dabBankDeg * DEG || (events & EV.TIP) !== 0)) {
      this.dabArmed = false
      this.dabTimer = DAB_TIME
    }
    const dabbing = this.dabTimer > 0
    const dab = this.to(this.dab, this.dabTimer > 0.24 ? 1 : 0, dabbing ? 14 : 7)
    const flourish = sat(f.topW * 1.3)
    const brace = this.to(this.brace, dabbing && s.bank > 0 ? 1 : 0, dabbing ? 10 : 6) * toe * (1 - flourish)
    const wToe = brace * carry
    const wTop = flourish * carry
    const wHeel = heel * carry
    const wTrail = Math.max(0, 1 - brace - flourish - heel) * carry

    // Two families of pose are blended, each within itself and then with the other: the
    // carries (blade behind, out to the side or up) and the strokes (blade ahead and down).
    let top = _topC.set(0, 0, 0)
    let dir = _dirC.set(0, 0, 0)
    let wSum = 0, leftOn = 0, gripR = 0, gripL = 0
    const hand = _hand, d1 = _dir, t1 = _top
    const low1 = PADDLE.gripLow

    if (wTrail > 1e-4) {
      // trailing: hand at the hip, blade behind and a little outboard (a balance pole when
      // unstable). Leant over toe side the hand is carried further in front of him, which
      // keeps the shaft, lying across his front, off his belly.
      // (and out of the way of a knee that a touchdown has folded up to it)
      this.armPoint(hand, 1, 24 + 30 * inst + 45 * sat(2 * f.touch) + wob * wobble(this.time, 5), -8 + 16 * toe, 0.84)
      d1.copy(Xh).multiplyScalar(-0.93).addScaledVector(Zh, 0.14 + 0.5 * inst).addScaledVector(upL, -0.2 + 0.12 * inst).normalize()
      t1.copy(hand).addScaledVector(d1, -low1)
      top.addScaledVector(t1, wTrail); dir.addScaledVector(d1, wTrail)
      gripR += wTrail * low1; gripL += wTrail * 0.12; wSum += wTrail
    }
    if (wToe > 1e-4) {
      // Toe-side brace: the blade comes round and down to the water on the inside of the
      // turn. The water is in front of his chest, so the shaft points straight away from
      // him: the hand slides up toward the handle, and what is left of the shaft behind it
      // stays in front of his body instead of going through it.
      const grip = clamp(K.braceGrip, 0.15, 0.9)
      const reach = PADDLE.length - grip
      this.armPoint(hand, 1, 46, 62, 0.9)
      const tipClear = lerp(K.braceHeight, 0.01, dab)
      // horizontal aim: mostly toward the inside rail, a little ahead
      d1.copy(Zh).multiplyScalar(0.86).addScaledVector(Xh, 0.5).normalize()
      let sinB = clamp((hand.dot(upL) - this.depth - tipClear) / reach, 0.12, 0.93)
      // refine with the real water height where the blade will be
      _a.copy(hand).addScaledVector(d1, reach * Math.sqrt(1 - sinB * sinB))
      const waterTip = _a.dot(upL) - this.clearance(_a)
      sinB = clamp((hand.dot(upL) - waterTip - tipClear) / reach, 0.12, 0.93)
      d1.multiplyScalar(Math.sqrt(1 - sinB * sinB)).addScaledVector(upL, -sinB)
      t1.copy(hand).addScaledVector(d1, -grip)
      top.addScaledVector(t1, wToe); dir.addScaledVector(d1, wToe)
      gripR += wToe * grip; gripL += wToe * 0.14; wSum += wToe
    }
    if (wTop > 1e-4) {
      // slow top turn: the paddle arm goes straight up, the blade high over his head (the
      // shaft leans in over him, so its handle end hangs clear outside the raised arm)
      this.armPoint(hand, 1, 163, 20, 0.97)
      d1.copy(upL).multiplyScalar(0.95).addScaledVector(rig.chestRight, -0.24).addScaledVector(rig.chestFwd, -0.1).normalize()
      t1.copy(hand).addScaledVector(d1, -low1)
      top.addScaledVector(t1, wTop); dir.addScaledVector(d1, wTop)
      gripR += wTop * low1; gripL += wTop * 0.12; wSum += wTop
    }
    if (wHeel > 1e-4) {
      // Heel side: the paddle held out over the toe rail at arm's length, a counterweight
      // to the sit. The blade trails aft of the arm (nobody holds a shaft in line with his
      // own arm), which keeps the handle end out in front of the shoulder, clear of the head.
      // On the dab the hand comes down and the blade goes to the water, if it is within reach.
      const dabH = dab * sat(heel * 1.5)
      const grip = clamp(K.heelGrip, 0.3, 1)
      const reach = PADDLE.length - grip
      this.armPoint(hand, 1, 84 - 16 * dabH, 4, 0.97)
      _a.copy(rig.chestRight).addScaledVector(upL, -rig.chestRight.dot(upL)).normalize()
      _b.copy(rig.chestFwd).addScaledVector(upL, -rig.chestFwd.dot(upL)).normalize()
      d1.copy(_a).addScaledVector(_b, -K.heelTrail).normalize()
      let droop = 0.22
      if (dabH > 1e-3) {
        _c.copy(hand).addScaledVector(d1, reach * 0.8)
        const water = _c.dot(upL) - this.clearance(_c)
        const need = (hand.dot(upL) - water + 0.02) / reach
        if (need < 0.88) droop = lerp(droop, Math.max(droop, need), dabH)
      }
      d1.multiplyScalar(Math.sqrt(1 - droop * droop)).addScaledVector(upL, -droop)
      t1.copy(hand).addScaledVector(d1, -grip)
      top.addScaledVector(t1, wHeel); dir.addScaledVector(d1, wHeel)
      gripR += wHeel * grip; gripL += wHeel * 0.12; wSum += wHeel
    }
    if (wUp > 1e-4) {
      // both arms up: the paddle goes up with the rear one
      this.armPoint(hand, 1, 152, 18, 0.96)
      d1.copy(upL).multiplyScalar(0.93).addScaledVector(Xh, -0.36).normalize()
      t1.copy(hand).addScaledVector(d1, -low1)
      top.addScaledVector(t1, wUp); dir.addScaledVector(d1, wUp)
      gripR += wUp * low1; gripL += wUp * 0.12; wSum += wUp
    }
    // (Going into the brace the hand slides up the shaft before the shaft has swung round to
    // point away from him, and slides back down only once it has swung back: with a long
    // grip and the shaft pointing straight out from his chest the handle end would be in
    // his belly.)
    if (wToe > 1e-4) gripR = lerp(gripR / wSum, clamp(K.braceGrip, 0.15, 0.9), smooth(0, 0.5, wToe / wSum)) * wSum
    const wCarry = wSum
    top = _d.set(0, 0, 0)
    dir = _e.set(0, 0, 0)
    wSum = 0
    if (wHold > 1e-4) {
      // pumping at speed: paddle across the front in both hands, thrown up as the legs extend
      const armsUp = 1 - f.fold
      d1.copy(rig.chestRight).addScaledVector(rig.chestFwd, 0.15).addScaledVector(Ug, -0.1).normalize()
      hand.copy(rig.chest).addScaledVector(rig.chestFwd, 0.3 + 0.24 * armsUp).addScaledVector(Ug, -0.62 + 0.56 * armsUp)
      // (sat down in a heel-side turn his knees come up under his hands: the paddle stays above them)
      const low = Math.max(rig.kneeL.dot(Ug), rig.kneeR.dot(Ug)) + 0.2 - hand.dot(Ug)
      if (low > 0) hand.addScaledVector(Ug, low)
      t1.copy(hand).addScaledVector(d1, -0.4)
      top.addScaledVector(t1, wHold); dir.addScaledVector(d1, wHold)
      gripR += wHold * low1; gripL += wHold * 0.08; leftOn += wHold; wSum += wHold
    }
    if (wStroke > 1e-4) {
      // a stroke: paddling when floating, or timed with the leg drive of a slow pump.
      // Waiting between strokes the blade hovers.
      const sgn = f.sgn
      const hover = 0.1 * f.idle * wP
      this.strokePose(f.sp, sgn, f.hard, hover, t1, d1)
      if (f.rest > 1e-3) {
        // resting brace: top hand in front of the chest, blade flat on the water ahead and well outboard
        const tx = rig.chest.x + 0.42 * rig.chestFwd.x, tz = rig.chest.z + 0.42 * rig.chestFwd.z - sgn * 0.06
        const dx = 0.8, dz = sgn * 1.4
        const tipY = this.waterY(tx + dx, tz + dz) + 0.02 + hover
        _a.set(tx, tipY + Math.sqrt(Math.max(0.2, PADDLE.length * PADDLE.length - dx * dx - dz * dz)), tz)
        _b.set(tx + dx, tipY, tz + dz).sub(_a).normalize()
        t1.lerp(_a, f.rest)
        d1.lerp(_b, f.rest).normalize()
      }
      if (f.swap > 1e-3) {
        // changing sides: forward and over the nose (the stroke poses of the two sides
        // meet in this one, so the paddle never goes across through the board)
        this.swapPose(_a, _b)
        t1.lerp(_a, f.swap)
        d1.lerp(_b, f.swap).normalize()
      }
      top.addScaledVector(t1, wStroke); dir.addScaledVector(d1, wStroke)
      const u = (f.side + 1) / 2
      gripR += wStroke * gripAt(u); gripL += wStroke * gripAt(1 - u)
      leftOn += wStroke; wSum += wStroke
    }
    {
      // The two families together. A stroke's shaft points about the opposite way to a
      // carried one, and a plain blend of opposite directions flips end for end (through the
      // deck, as it happens): going from one to the other the blade is swung round outboard,
      // over the toe rail.
      const wAll = wCarry + wSum
      if (wAll < 1e-4) { top.copy(rig.chest); dir.set(-1, 0, 0) }
      else {
        const w = wSum / wAll
        if (wSum > 1e-4) dir.normalize()
        if (wCarry > 1e-4) _dirC.normalize()
        const opposed = wSum > 1e-4 && wCarry > 1e-4 ? 0.5 - 0.5 * dir.dot(_dirC) : 0
        top.add(_topC).multiplyScalar(1 / wAll)
        dir.multiplyScalar(w).addScaledVector(_dirC, 1 - w)
        if (opposed > 1e-3) dir.addScaledVector(Zh, 4 * w * (1 - w) * opposed).addScaledVector(upL, 0.6 * w * (1 - w) * opposed)
        if (dir.lengthSq() < 1e-8) dir.copy(Zh)
        dir.normalize()
        gripR /= wAll
        gripL /= wAll
        leftOn = sat(leftOn / wAll)
      }
      f.gripR = gripR
      f.gripL = gripL
      f.leftOn = leftOn
    }

    // A carried blade never drags: lift it clear of water that comes up under it (a crest
    // behind, the face on the outside of a top turn). On the dab it is put down on purpose,
    // and then it is steered onto the surface itself: no deeper, and not left hanging
    // short of it if the water is within reach.
    {
      const free = sat(carry + wUp) * wF
      let clear = 0
      if (free > 0.02) {
        _a.copy(top).addScaledVector(dir, PADDLE.length)
        clear = this.clearance(_a)
        let move = 0
        if (clear < K.bladeClear) move = (K.bladeClear - clear) * (1 - dab) - clear * dab
        else if (dab > 0.01 && clear < 0.45) move = -clear * dab
        if (move !== 0) {
          // swing the shaft about the paddle hand
          _b.copy(top).addScaledVector(dir, gripR)
          dir.addScaledVector(upL, (move * free) / (PADDLE.length - gripR)).normalize()
          top.copy(_b).addScaledVector(dir, -gripR)
        }
      }
      this.dbg.bladeClear = clear
    }

    // a stroke is followed closely; between carries, and picking the blade up off the water
    // after a rest, a two-metre paddle is swung, not flicked (a dab is a little quicker)
    // (and the timed swing across the nose is followed as it is drawn: any lag there bunches
    // the swing up into its second half)
    const quick = Math.max(wStroke * (1 - f.rest), wHold, 0.6 * dab * carry)
    const swing = f.swap * wStroke
    if (this.snap) { this.topS.snap(top); this.dirS.snap(dir) }
    else { this.topS.step(top, lerp(13, 30, quick) + 20 * swing, dt); this.dirS.step(dir, lerp(10, 24, quick) + 26 * swing, dt) }
    this.padTop.copy(this.topS.x)
    this.padDir.copy(this.dirS.x)
    if (this.padDir.lengthSq() < 1e-6) this.padDir.copy(dir)
    this.padDir.normalize()
    // (the grips are eased at the pace of the shaft's direction: a hand that slid along the
    // shaft ahead of the shaft's turning would poke the handle end where no pose puts it)
    gripR = f.gripR = this.snap ? this.gripRS.snap(gripR) : this.gripRS.step(gripR, lerp(10, 24, quick), dt)
    gripL = f.gripL = this.snap ? this.gripLS.snap(gripL) : this.gripLS.step(gripL, lerp(10, 24, quick), dt)

    // A hand on the shaft is never jammed against its own shoulder: when the body folds
    // down onto the paddle (a pump with the blade in the water) the paddle is pushed away.
    for (let k = 0; k < 2; k++) {
      const on = k === 0 ? smooth(0.15, 0.6, leftOn) : 1
      if (on < 1e-3) continue
      const sh = k === 0 ? rig.shoulderL : rig.shoulderR
      _a.copy(this.padTop).addScaledVector(this.padDir, k === 0 ? gripL : gripR).sub(sh)
      const d = _a.length()
      if (d < 0.3) {
        if (d < 0.02) _a.copy(rig.chestFwd); else _a.multiplyScalar(1 / d)
        this.padTop.addScaledVector(_a, (0.3 - d) * on)
      }
    }

    // ---- hands: on the shaft (the lead hand only when the carry wants both) ----
    rig.palmAimR.copy(this.padTop).addScaledVector(this.padDir, gripR)
    _a.copy(this.padTop).addScaledVector(this.padDir, gripL)
    // changing sides the hands pass each other: keep them apart
    _a.addScaledVector(rig.chestFwd, -0.09 * (1 - smooth(0.12, 0.4, Math.abs(gripL - gripR))))
    // the lead hand comes onto the shaft, and lets go of it, round the front of its shoulder
    blendAround(rig.palmAimL, freeL, _a, leftOn, rig.shoulderL, rig.chestFwd)
    if (this.snap) { this.palmL.snap(rig.palmAimL); this.palmR.snap(rig.palmAimR) }
    else { this.palmL.step(rig.palmAimL, 34 + 26 * swing, dt); this.palmR.step(rig.palmAimR, 34 + 26 * swing, dt) }
    rig.palmAimL.copy(this.palmL.x)
    rig.palmAimR.copy(this.palmR.x)
    this.elbowWant(rig.elbowPoleL, -1)
    this.elbowWant(rig.elbowPoleR, 1)

    const g = this.dbg
    g.stroke = wStroke; g.hold = wHold; g.trail = wTrail; g.brace = wToe; g.pole = wHeel; g.top = wTop; g.up = wUp; g.leftOn = leftOn
    g.dab = dab
  }

  /**
   * Seat the paddle in the hands that actually hold it (they lag their targets, and stop
   * short when out of reach). With both hands on and well apart the shaft runs through
   * both; as they come together to change places their say fades out, smoothly and without
   * a change of sign, so the swap never whips the blade round.
   */
  private seatPaddle(): void {
    const f = this.f
    const rig = this.rig
    const { gripR, gripL } = f
    const dG = gripR - gripL
    // (nor do the hands have a say while the paddle is being swung across: it goes where it is sent)
    // (nor while he is still climbing back on: his lead hand is on the deck, not the shaft)
    const two = this.to(this.twoHands, f.leftOn * smooth(0.3, 0.55, Math.abs(dG)), 14) * (1 - smooth(0, 0.1, this.fall.amount)) * (1 - f.swap)
    if (two > 0.005) {
      _b.subVectors(rig.palmR, rig.palmL)
      const span = _b.length()
      const trust = two * Math.min(1, Math.abs(dG) / 0.3) * Math.min(1, span / 0.3)
      if (span > 1e-3 && trust > 0.001) {
        _b.multiplyScalar(Math.sign(dG) / span)
        this.padDir.multiplyScalar(1 - trust).addScaledVector(_b, trust).normalize()
      }
    }
    _a.copy(rig.palmR).addScaledVector(this.padDir, -gripR)
    if (two > 0.005) _a.lerp(_c.copy(rig.palmL).addScaledVector(this.padDir, -gripL), 0.5 * two)
    this.padTop.copy(_a)
  }

  /**
   * The paddle never goes through the rider or the board. Whatever the carries, their blends
   * and the hands have made of it, the shaft is swung about the hand that carries it until
   * the part behind that hand is clear of the head and the trunk, and the part beyond it
   * clear of the board. The swing is rate-limited, so it slides and never jumps; a lead hand
   * on the shaft goes with it.
   */
  private keepPaddleClear(): void {
    const f = this.f
    const rig = this.rig
    const corr = this.corr
    const live = 1 - this.fall.amount
    const grip = f.gripR
    const pivot = _piv.copy(this.padTop).addScaledVector(this.padDir, grip)
    let why = 0
    if (live > 0.02) {
      const d = _u.copy(this.padDir)
      const F = this.app.sim.P.foil
      const noseX = K.mastFrac * F.boardLength, tailX = noseX - F.boardLength
      const out = PADDLE.length - grip
      // (the spine, pelvis to the base of the neck)
      const spine = _a.subVectors(rig.chest, rig.pelvis)
      const spineSq = Math.max(1e-6, spine.lengthSq())
      for (let pass = 0; pass < 3; pass++) {
        let moved = false
        // (Swinging the shaft about the hand moves what is behind the hand only if there is
        // some length of it there: with the hand near the handle, as in a brace or a change
        // of side, the handle is where the hand is and there is nothing to keep clear.)
        // (Nor while the paddle is being swung across the nose: that pose is made in front of him.)
        const say = 1 - f.swap
        if (grip > 0.25 && say > 0.02) {
          // ---- the handle end and the head: the nearest point of the shaft to its centre ----
          let sq = clamp(-_r.subVectors(rig.head, pivot).dot(d), 0, grip)
          const q = _q.copy(pivot).addScaledVector(d, -sq)
          _r.subVectors(q, rig.head)
          let dist = _r.length()
          let lever = smooth(0.2, 0.45, sq) * say
          if (dist < K.headClear && lever > 0) {
            // (when it is dead centre, out to his right: the side the paddle is carried on)
            _r.addScaledVector(rig.chestRight, 0.03).normalize()
            q.addScaledVector(_r, (K.headClear - dist) * lever)
            d.subVectors(pivot, q).normalize()
            moved = true
            why |= 1
          }
          // ---- and the trunk: the nearest points of the shaft and the spine ----
          // (closest points of two segments: the shaft's is pivot - sq d, the spine's pelvis + tq spine)
          _r.subVectors(pivot, rig.pelvis)
          const b = -d.dot(spine), c0 = -d.dot(_r), e0 = spine.dot(_r)
          const den = spineSq - b * b
          sq = den > 1e-8 ? clamp((b * e0 - c0 * spineSq) / den, 0, grip) : 0
          let tq = (b * sq + e0) / spineSq
          if (tq < 0) { tq = 0; sq = clamp(-c0, 0, grip) } else if (tq > 1) { tq = 1; sq = clamp(b - c0, 0, grip) }
          q.copy(pivot).addScaledVector(d, -sq)
          _w.copy(rig.pelvis).addScaledVector(spine, tq)
          _r.subVectors(q, _w)
          dist = _r.length()
          lever = smooth(0.2, 0.45, sq) * say
          if (dist < K.trunkClear && lever > 0) {
            _r.addScaledVector(rig.chestRight, 0.03).normalize()
            q.addScaledVector(_r, (K.trunkClear - dist) * lever)
            d.subVectors(pivot, q).normalize()
            moved = true
            why |= 2
          }
        }
        // ---- the blade end and the board: where the paddle is over the board it is above
        // the deck (the blade by a full deckClear, the shaft by a hand's width); a steep
        // shaft that would go down through the rail goes down outside it ----
        for (let k = 0; k < 8; k++) {
          const u = out - k * 0.2
          if (u < 0.2) break
          const q = _q.copy(pivot).addScaledVector(d, u)
          const blade = k < 2
          const margin = blade ? 0.11 : 0.03
          if (q.x > noseX + margin || q.x < tailX - margin) continue
          const half = boardHalfWidth(F.boardLength, F.boardWidth, clamp(q.x, tailX, noseX)) + margin
          if (Math.abs(q.z) > half) continue
          const floor = this.deckY + 0.015 + (blade ? K.deckClear : 0.06)
          // (a point well under the hull is beside or below the board, not in it)
          if (q.y >= floor || q.y < F.mastLength - 0.12) continue
          const up = floor - q.y
          const aside = half - Math.abs(q.z)
          if (aside < up && d.y < -0.6) {
            // (out past the rail on the side it comes down on, where it meets the deck:
            // further down it may already be past the middle of the board)
            const zIn = pivot.z + d.z * Math.max(0, (floor - pivot.y) / d.y)
            q.z = (zIn < 0 ? -1 : 1) * (half + 0.005)
            d.subVectors(q, pivot).normalize()
          } else {
            // raise it: the same point of the shaft, with the shaft tilted up
            const dy = clamp((floor - pivot.y) / u, -1, 1)
            const flat = Math.hypot(d.x, d.z)
            const keep = Math.sqrt(1 - dy * dy)
            if (flat < 1e-4) d.set(keep, dy, 0)
            else d.set((d.x * keep) / flat, dy, (d.z * keep) / flat)
          }
          moved = true
          why |= 4
        }
        // ---- and a carried blade and the water: a dab touches, it does not plunge ----
        if (f.foil && f.wStroke < 0.5 && pass === 0) {
          const q = _q.copy(pivot).addScaledVector(d, out)
          const under = -0.03 - this.clearance(q)
          if (under > 0) {
            q.addScaledVector(this.upL, under)
            d.subVectors(q, pivot).normalize()
            moved = true
            why |= 8
          }
        }
        if (!moved) break
      }
      // The swing asked for. More of the same swing is taken at once (something is moving
      // into the paddle's way); a swing the other way, or letting go, no faster than a
      // paddle can be swung, so a shaft pushed through the middle of him slides round.
      _a.subVectors(d, this.padDir).multiplyScalar(live)
      if (this.snap) corr.copy(_a)
      else {
        _a.sub(corr)
        const had = corr.length()
        if (had > 1e-6) {
          const more = Math.min(_a.dot(corr) / had, 16 * f.dt)
          if (more > 0) {
            _a.addScaledVector(corr, -more / had)
            corr.multiplyScalar(1 + more / had)
          }
        }
        const len = _a.length()
        const maxStep = 9 * f.dt
        if (len > maxStep) _a.multiplyScalar(maxStep / len)
        corr.add(_a)
      }
    } else corr.set(0, 0, 0)
    const amount = corr.length()
    this.dbg.keepOut = amount
    this.dbg.keepWhy = why
    if (amount > 1e-5) {
      this.padDir.add(corr).normalize()
      this.padTop.copy(pivot).addScaledVector(this.padDir, -grip)
    }
    // The hands hold the shaft where it has ended up (seated between two hands that lag
    // their aims and stop short, swung clear of the body), each at its own grip: the paddle
    // hand always, the lead hand once it has come onto the shaft, easing off as it lets go.
    // (A grip beyond an arm's reach is taken as near to its place as the arm gets: the hand
    // slides along the shaft rather than hang in the air beside it.)
    const lockL = this.to(this.leftLock, f.leftOn > 0.85 ? 1 : 0, 9) * live
    if (live > 1e-3) {
      const gR = this.reachGrip(rig.shoulderR, grip, f.gripL)
      rig.palmAimR.lerp(_a.copy(this.padTop).addScaledVector(this.padDir, gR), live)
      if (lockL > 1e-3) {
        const gL = this.reachGrip(rig.shoulderL, f.gripL, grip)
        _a.copy(this.padTop).addScaledVector(this.padDir, gL)
        _a.addScaledVector(rig.chestFwd, -0.09 * (1 - smooth(0.12, 0.4, Math.abs(f.gripL - grip))))
        rig.palmAimL.lerp(_a, lockL)
      }
      rig.solveArms()
    }
  }

  /**
   * The place on the shaft nearest to grip `g` (metres from the handle) that the arm from
   * shoulder `sh` can reach, without sliding closer than a hand's breadth or two to the
   * other hand at `other`.
   */
  private reachGrip(sh: THREE.Vector3, g: number, other: number): number {
    _b.subVectors(sh, this.padTop)
    const g0 = _b.dot(this.padDir)
    const offSq = _b.lengthSq() - g0 * g0
    const R = 0.985 * armLength()
    const h = offSq < R * R ? Math.sqrt(R * R - offSq) : 0
    const r = clamp(g, g0 - h, g0 + h)
    if (r < g) return Math.max(r, Math.min(g, other + 0.25))
    if (r > g) return Math.min(r, Math.max(g, other - 0.25), PADDLE.length - PADDLE.blade)
    return g
  }

  /** the blade's face, and the splash of a carried blade that touches the water */
  private finishPaddle(s: RiderState): void {
    const f = this.f
    // blade face: flat to the water when carried, square to the pull in a stroke
    const pullNow = f.wStroke * (f.sp < PULL || !f.paddling ? 1 : 0.2) * (1 - f.rest) * (1 - f.swap)
    _a.copy(this.upL).addScaledVector(this.Xh, 0.3 + 2.5 * pullNow)
    this.padWide.crossVectors(this.padDir, _a)
    if (this.padWide.lengthSq() < 1e-6) this.padWide.copy(this.Zh)
    this.padWide.normalize()

    // a carried blade that touches the water (the dab) leaves a splash for whoever draws them
    if (f.foil && f.wStroke < 0.5 && this.dabTimer > -0.3) {
      _a.copy(this.padTop).addScaledVector(this.padDir, PADDLE.length)
      const clear = this.clearance(_a)
      if (clear < 0.02 && !this.bladeWet) {
        this.bladeWet = true
        window.dispatchEvent(new CustomEvent('hr:rider-splash', {
          detail: { kind: 'blade', x: _w.x, y: _w.y - clear, z: _w.z, strength: Math.min(0.5, 0.05 * s.speed) },
        }))
      } else if (clear > 0.1) this.bladeWet = false
    } else this.bladeWet = false
  }
}
