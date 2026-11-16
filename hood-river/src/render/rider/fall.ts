/**
 * Coming off: after a crash the body leaves the board. It carries on with the speed it had
 * while the board stops dead, hits the water, swims back and climbs on, standing again by
 * the end of the sim's swim time. Solved in world space and laid over the riding pose,
 * which it hands back to as he gets to his feet.
 */
import * as THREE from 'three'
import type { App } from '../../app/types'
import { EV, type RiderState } from '../../sim/types'
import { blendAround, type Rig } from './rig'
import { clamp, DEG, lerp, sat, smooth } from './springs'
import { BODY, PADDLE } from './tune'

const V = () => new THREE.Vector3()
const _a = V(), _b = V(), _c = V(), _d = V(), _e = V()
const _T = V(), _pel = V(), _belly = V(), _right = V()
const _inv = new THREE.Matrix4()

export class Fall {
  /** 1 = off the board, 0 = standing on it */
  amount = 0

  private active = false
  private pos = V()
  private vel = V()
  /** which way the body points, hips to head (world, unit) */
  private axis = V().set(0, 1, 0)
  private wet = false
  private wetTime = 0
  private side = -1
  // where the hips were, and how fast the rider was going, a frame ago
  private lastPelvis = V()
  private lastVel = V()
  private haveLast = false
  /** the paddle's direction a frame ago, while he is off the board (it is swung, never flicked) */
  private lastPad = V()
  private havePad = false

  constructor(private app: App) {}

  reset(): void {
    this.active = false
    this.amount = 0
    this.wet = false
    this.haveLast = false
    this.havePad = false
  }

  /** call at the end of every frame with the solved pose */
  remember(rig: Rig, s: RiderState, m: THREE.Matrix4): void {
    this.lastPelvis.copy(rig.pelvis).applyMatrix4(m)
    if (s.mode === 'foil') this.lastVel.set(s.vx, s.vy, s.vz)
    this.haveLast = true
  }

  /**
   * Lay the falling, swimming or climbing pose over the rig's targets (which hold the riding
   * pose he will stand up into) and over the paddle. `upL` is world up in the board frame.
   */
  apply(
    dt: number, s: RiderState, events: number, m: THREE.Matrix4, rig: Rig, upL: THREE.Vector3, deckY: number,
    padTop: THREE.Vector3, padDir: THREE.Vector3,
  ): void {
    if (s.mode !== 'swim') {
      this.active = false
      this.amount = 0
      this.havePad = false
      return
    }
    const app = this.app
    const e = m.elements
    if ((events & EV.CRASH) || !this.active) {
      // Launch: he carries on at the speed of a moment ago while the board stops. A caught
      // rail throws him to the outside of the turn; slammed down, or the wing stopped dead by
      // the riverbed, he goes over the nose.
      this.active = true
      this.pos.copy(this.haveLast ? this.lastPelvis : _a.copy(rig.pelvis).applyMatrix4(m))
      const overNose = s.cause === 'hard' || s.cause === 'bottom'
      // (The swim is short, so however fast the crash he comes down within a couple of board
      // lengths: what he keeps is the board's speed after the crash and a throw on top.)
      let rx = this.lastVel.x - s.vx, rz = this.lastVel.z - s.vz
      const ahead = Math.hypot(rx, rz)
      const keep = Math.min(ahead, overNose ? 2.4 : 1.6) / Math.max(1e-3, ahead)
      rx *= keep
      rz *= keep
      const out = -Math.sign(s.bank || 1) * sat(Math.abs(s.bank) / (28 * DEG)) * (s.cause === 'rail' ? 1.2 : 0.7)
      this.vel.set(s.vx + rx + e[8] * out * 1.8, this.lastVel.y, s.vz + rz + e[10] * out * 1.8)
      this.vel.y = Math.max(this.vel.y, 0) + (overNose ? 2.1 : 1.5)
      this.axis.copy(rig.torso).transformDirection(m)
      this.wet = false
      this.wetTime = 0
      this.side = out > 0 ? 1 : -1
      this.havePad = false
    }
    const swimTime = Math.max(0.6, app.sim.P.crash.swimTime)
    const tau = s.modeTime
    const climbLen = Math.min(1.15, 0.5 * swimTime)
    const climbStart = swimTime - climbLen
    const u = sat((tau - climbStart) / climbLen)
    const waves = app.sim.waves
    const t = app.time

    // where he will climb on: beside the standing area, on the side he fell
    const sideZ = this.side
    const mount = _a.set(0.2, deckY - 0.3, sideZ * 0.5).applyMatrix4(m)

    if (dt > 0) {
      const p = this.pos, v = this.vel
      const water = waves.height(p.x, p.z, t)
      if (!this.wet) {
        v.y -= 9.81 * dt
        p.addScaledVector(v, dt)
        if (p.y < water + 0.12) {
          this.wet = true
          this.wetTime = 0
          // tell whoever draws splashes
          window.dispatchEvent(new CustomEvent('hr:rider-splash', {
            detail: { kind: 'body', x: p.x, y: water, z: p.z, strength: Math.min(1, v.length() / 6) },
          }))
        }
      } else {
        this.wetTime += dt
        // buoyancy to a floating depth; the water stops him, then he swims for the board,
        // as fast as it takes to be there when it is time to climb on
        v.y += ((water - 0.2 - p.y) * 60 - v.y * 11) * dt
        const left = Math.max(0.12, climbStart - tau)
        const dx = mount.x - p.x, dz = mount.z - p.z
        const dist = Math.hypot(dx, dz)
        if (this.wetTime > 0.12 && dist > 1e-3) {
          const want = Math.min(3.6, dist / left)
          const k = 1 - Math.exp(-7 * dt)
          v.x += ((dx / dist) * want - v.x) * k
          v.z += ((dz / dist) * want - v.z) * k
        } else {
          const drag = Math.exp(-8 * dt)
          v.x *= drag; v.z *= drag
        }
        p.addScaledVector(v, dt)
      }
      // body axis: head first along the fall, then flat on the water toward the board
      const aim = _b
      if (!this.wet) {
        aim.set(v.x, 0.35 * Math.hypot(v.x, v.z) + 0.2, v.z).normalize()
      } else {
        // (toward the middle of the board, not the spot beside it he is swimming for: that
        // direction turns smoothly as he arrives, to face the board he is about to climb)
        aim.set(e[12] + e[0] * 0.2 - p.x, 0, e[14] + e[2] * 0.2 - p.z)
        if (aim.lengthSq() < 0.01) aim.set(e[8] * -sideZ, 0, e[10] * -sideZ)
        aim.normalize()
        aim.y = 0.28
        aim.normalize()
      }
      // He turns to it as a body does, no faster than a swimmer can come about, and never
      // end for end through himself: if it is straight behind him he starts round sideways.
      const ax = this.axis
      let c = clamp(ax.dot(aim), -1, 1)
      if (c < -0.98) {
        aim.addScaledVector(_c.set(-ax.z, 0, ax.x), 0.3).normalize()
        c = clamp(ax.dot(aim), -1, 1)
      }
      const ang = Math.acos(c)
      if (ang > 1e-4) {
        const step = Math.min(ang * (1 - Math.exp(-(this.wet ? 7 : 9) * dt)), (this.wet ? 5.5 : 12) * dt)
        const sn = Math.sin(ang)
        if (sn > 1e-4) ax.multiplyScalar(Math.sin(ang - step) / sn).addScaledVector(aim, Math.sin(step) / sn).normalize()
        else ax.lerp(aim, step / ang).normalize()
      }
    }

    // ---- the pose, in the board frame ----
    const inv = _inv.copy(m).invert()
    const T = _T.copy(this.axis).transformDirection(inv)
    const pel = _pel.copy(this.pos).applyMatrix4(inv)
    // belly toward the water
    const belly = _belly.copy(upL).multiplyScalar(-1).addScaledVector(T, T.dot(upL))
    if (belly.lengthSq() < 1e-4) belly.set(0, 0, 1)
    belly.normalize()
    const right = _right.crossVectors(belly, T).normalize()
    const kick = Math.sin(t * 13)
    const crawl = t * 7.5
    // in the air the limbs are flung wide; in the water they swim (eased across the splash)
    const wet = this.wet ? smooth(0, 0.25, this.wetTime) : 0

    // climbing on: slide the hips up onto the deck, get the feet under him, stand
    pel.lerp(_c.set(0.16, deckY + 0.32, sideZ * 0.05), smooth(0, 0.6, u))
    // fully off the board until he is half way through climbing on, standing by the end
    const wHips = 1 - smooth(0.55, 1, u)
    this.amount = wHips
    if (wHips <= 1e-3) return
    // the hips go with the fall at once; the limbs let go of their riding pose over a moment
    const w = wHips * smooth(0, 0.16, tau)
    // (the feet find the deck before the hips come up: a squat, then up)
    const wLegs = w * (1 - smooth(0.35, 0.75, u))

    // torso flat while swimming, coming up as he gets his feet under him
    _d.copy(T).lerp(upL, smooth(0.5, 0.95, u)).normalize()
    rig.pelvis.lerp(pel, wHips)
    rig.torso0.lerp(_d, w).normalize()
    rig.torso.lerp(_d, w).normalize()
    rig.chestAim.lerp(belly, w).normalize()
    rig.pelvisFwd.lerp(belly, w).normalize()
    // look where he is going, chin up out of the water
    _e.copy(T).addScaledVector(belly, -0.5).normalize()
    rig.gaze.lerp(_e, w).normalize()
    rig.headUp.lerp(_e.copy(belly).multiplyScalar(-1).addScaledVector(T, 0.4).normalize(), w)
    rig.headUp.addScaledVector(rig.gaze, -rig.headUp.dot(rig.gaze)).normalize()
    rig.solveTrunk()
    // legs trail and kick
    const legLen = (BODY.thigh + BODY.shin) * 0.93
    const spread = lerp(0.26, 0.12, wet)
    const kickAmt = 0.1 * kick * lerp(0.3, 1, wet)
    _d.copy(rig.pelvis).addScaledVector(T, -legLen).addScaledVector(right, -spread).addScaledVector(belly, kickAmt)
    rig.ankleL.lerp(_d, wLegs)
    _d.copy(rig.pelvis).addScaledVector(T, -legLen).addScaledVector(right, spread).addScaledVector(belly, -kickAmt)
    rig.ankleR.lerp(_d, wLegs)
    _d.copy(T).multiplyScalar(-1)
    rig.toeDirL.lerp(_d, wLegs).normalize()
    rig.toeDirR.lerp(_d, wLegs).normalize()
    _d.copy(belly).multiplyScalar(-1)
    rig.soleUpL.lerp(_d, wLegs).normalize()
    rig.soleUpR.lerp(_d, wLegs).normalize()
    rig.kneePoleL.lerp(belly, wLegs)
    rig.kneePoleR.lerp(belly, wLegs)
    // arms: thrown forward in the air, crawling in the water, on the deck to climb
    const reach = lerp(0.6, 0.55, wet)
    const cl = lerp(0.8, Math.cos(crawl), wet), sl = lerp(-0.3, Math.sin(crawl), wet)
    _d.copy(rig.shoulderL).addScaledVector(T, cl * reach).addScaledVector(belly, sl * reach * 0.8).addScaledVector(right, -0.16)
    const grab = smooth(0.05, 0.35, u) * (1 - smooth(0.6, 0.95, u))
    // (climbing, each hand goes to the deck where it is nearest its shoulder: the rail as he
    // arrives, then under him to push up)
    _e.set(clamp(rig.shoulderL.x + 0.08, -0.45, 0.95), deckY + 0.02, clamp(rig.shoulderL.z, -0.26, 0.26))
    blendAround(_d, _d, _e, grab, rig.shoulderL, belly)
    blendAround(rig.palmAimL, rig.palmAimL, _d, w, rig.shoulderL, rig.chestFwd)
    // the paddle hand stays ahead, the paddle lying along the body
    _d.copy(rig.shoulderR).addScaledVector(T, 0.5).addScaledVector(right, 0.2).addScaledVector(belly, -0.05)
    _e.set(clamp(rig.shoulderR.x - 0.08, -0.45, 0.95), deckY + 0.02, clamp(rig.shoulderR.z, -0.26, 0.26))
    blendAround(_d, _d, _e, grab, rig.shoulderR, belly)
    blendAround(rig.palmAimR, rig.palmAimR, _d, w, rig.shoulderR, rig.chestFwd)
    rig.elbowPoleL.lerp(_e.copy(right).multiplyScalar(-1).addScaledVector(belly, -0.4), w)
    rig.elbowPoleR.lerp(_e.copy(right).addScaledVector(belly, -0.4), w)
    // Paddle: along the body, blade ahead, flat on the water (it comes round slower than the
    // limbs). Between that and the way he carries it standing the shaft is swung round, the
    // blade going out ahead over the water (or, if both lie fore and aft, out to the side
    // he fell): the two directions can be opposite, and a plain blend of opposite
    // directions flips end for end through the body.
    _d.copy(T).addScaledVector(right, 0.25).addScaledVector(belly, -0.08).normalize()
    const wPad = wHips * smooth(0, 0.45, tau)
    const opposed = 0.5 - 0.5 * padDir.dot(_d)
    if (opposed > 1e-3 && wPad > 1e-3 && wPad < 0.999) {
      // the way round: square to the line between the two directions
      const n = _e.subVectors(padDir, _d).normalize()
      _c.set(1, 0, 0).addScaledVector(upL, 0.25 - upL.x)
      _c.addScaledVector(n, -_c.dot(n))
      const ahead = smooth(0.05, 0.25, _c.lengthSq())
      _b.set(0, 0, sideZ).addScaledVector(upL, 0.25 - sideZ * upL.z)
      _b.addScaledVector(n, -_b.dot(n))
      _c.multiplyScalar(ahead).addScaledVector(_b, 1 - ahead)
      if (_c.lengthSq() < 1e-6) _c.copy(upL)
      _c.normalize()
      padDir.multiplyScalar(1 - wPad).addScaledVector(_d, wPad).addScaledVector(_c, 3.6 * wPad * (1 - wPad) * opposed)
    } else padDir.lerp(_d, wPad)
    if (padDir.lengthSq() < 1e-6) padDir.copy(_d)
    padDir.normalize()
    if (this.havePad && dt > 0) {
      // no faster than a paddle is swung (the limit lets go as he gets to his feet)
      const ang = Math.acos(clamp(this.lastPad.dot(padDir), -1, 1))
      const step = (9 + 40 * (1 - wPad) * (1 - wPad)) * dt
      const sn = Math.sin(ang)
      if (ang > step && sn > 1e-4) {
        padDir.multiplyScalar(Math.sin(step) / sn).addScaledVector(this.lastPad, Math.sin(ang - step) / sn).normalize()
      }
    }
    this.lastPad.copy(padDir)
    this.havePad = true
    padTop.copy(rig.palmAimR).addScaledVector(padDir, -PADDLE.gripLow)
  }
}
