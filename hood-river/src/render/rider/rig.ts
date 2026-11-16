/**
 * The figure's skeleton: joint positions in the rider (board) frame, solved from a handful
 * of targets with two-bone IK, and written out as capsules.
 *
 * "L" is the rider's left side. He is regular-footed, so the left leg is the front leg and
 * the left arm the lead arm; his chest faces the toe-side (starboard) rail.
 */
import * as THREE from 'three'
import type { CapsuleSet } from './capsules'
import { BODY, COLORS, PADDLE, RIDER_TUNE } from './tune'

const V = () => new THREE.Vector3()
const _v = V(), _n = V(), _p = V(), _a = V(), _b = V(), _c = V()

/**
 * Two-bone IK: place the middle joint so the chain root -> mid -> end has lengths l1, l2,
 * bending toward `pole`. If the target is out of reach the chain straightens and `end`
 * stops short of it. With `soft` (metres) the last of the reach is eased in, so the chain
 * never locks dead straight and the middle joint does not snap as it bends again.
 */
export function ik2(
  root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3,
  mid: THREE.Vector3, end: THREE.Vector3, soft = 0,
): void {
  _v.subVectors(target, root)
  let d = _v.length()
  if (d < 1e-5) { _v.set(0, -1, 0); d = 1e-5 }
  _n.copy(_v).multiplyScalar(1 / d)
  const reach = l1 + l2
  let dc = Math.max(d, Math.abs(l1 - l2) + 1e-3)
  if (soft > 0 && dc > reach - soft) dc = reach - soft * Math.exp(-(dc - (reach - soft)) / soft)
  dc = Math.min(dc, reach * 0.9995)
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  _p.copy(pole).addScaledVector(_n, -pole.dot(_n))
  if (_p.lengthSq() < 1e-8) {
    _p.set(0, 1, 0).addScaledVector(_n, -_n.y)
    if (_p.lengthSq() < 1e-8) _p.set(1, 0, 0)
  }
  _p.normalize()
  mid.copy(root).addScaledVector(_n, a).addScaledVector(_p, h)
  end.copy(root).addScaledVector(_n, dc)
}

/**
 * Move a hand target from `a` to `b` round a joint (its shoulder): blended as a direction
 * and a reach, bulging toward `front`, not along the straight line between the two places
 * (which can run through the joint). `out` may be `a` or `b`.
 */
export function blendAround(
  out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, w: number, pivot: THREE.Vector3, front: THREE.Vector3,
): void {
  if (w <= 0) { out.copy(a); return }
  if (w >= 1) { out.copy(b); return }
  _a.subVectors(a, pivot)
  _b.subVectors(b, pivot)
  const la = Math.max(1e-3, _a.length()), lb = Math.max(1e-3, _b.length())
  _a.multiplyScalar((1 - w) / la).addScaledVector(_b, w / lb).addScaledVector(front, 1.2 * w * (1 - w))
  if (_a.lengthSq() < 1e-6) _a.copy(front)
  out.copy(pivot).addScaledVector(_a.normalize(), la + (lb - la) * w)
}

/** capsule slots */
export const CAP = {
  pelvis: 0, belly: 1, chest: 2, shoulders: 3, neck: 4, head: 5, cap: 6, brim: 7,
  upperArmL: 8, foreArmL: 9, handL: 10, upperArmR: 11, foreArmR: 12, handR: 13,
  thighL: 14, shinL: 15, footL: 16, thighR: 17, shinR: 18, footR: 19,
  shaft: 20, blade: 21, handle: 22,
  mast: 23, fuse: 24, wingL: 25, wingR: 26, stabL: 27, stabR: 28,
  count: 29,
}

export class Rig {
  // ---- targets, set by the animator before solve() ----
  readonly pelvis = V()
  /** direction the pelvis faces (unit, roughly in the deck plane) */
  readonly pelvisFwd = V().set(0, 0, 1)
  /** spine direction before the torso flexes forward, and after (unit) */
  readonly torso0 = V().set(0, 1, 0)
  readonly torso = V().set(0, 1, 0)
  /** direction the chest should face (need not be perpendicular to the torso) */
  readonly chestAim = V().set(0, 0, 1)
  readonly headUp = V().set(0, 1, 0)
  readonly gaze = V().set(1, 0, 0)
  readonly ankleL = V()
  readonly ankleR = V()
  readonly toeDirL = V().set(0, 0, 1)
  readonly toeDirR = V().set(0, 0, 1)
  /** up direction of each sole (the deck normal when planted) */
  readonly soleUpL = V().set(0, 1, 0)
  readonly soleUpR = V().set(0, 1, 0)
  readonly kneePoleL = V().set(0, 0, 1)
  readonly kneePoleR = V().set(0, 0, 1)
  /** where each palm should be */
  readonly palmAimL = V()
  readonly palmAimR = V()
  readonly elbowPoleL = V().set(0, -1, 0)
  readonly elbowPoleR = V().set(0, -1, 0)

  // ---- solved ----
  readonly waist = V()
  readonly chest = V()
  readonly chestFwd = V()
  readonly chestRight = V()
  readonly pelvisRight = V()
  readonly neckTop = V()
  readonly head = V()
  readonly shoulderL = V()
  readonly shoulderR = V()
  readonly elbowL = V()
  readonly elbowR = V()
  readonly palmL = V()
  readonly palmR = V()
  readonly hipL = V()
  readonly hipR = V()
  readonly kneeL = V()
  readonly kneeR = V()
  readonly footL = V()
  readonly footR = V()

  /** spine, shoulders and head from the pelvis and the torso directions */
  solveTrunk(): void {
    _a.addVectors(this.torso0, this.torso).normalize()
    this.waist.copy(this.pelvis).addScaledVector(_a, BODY.spineLow)
    this.chest.copy(this.waist).addScaledVector(this.torso, BODY.spineUp)
    this.chestFwd.copy(this.chestAim).addScaledVector(this.torso, -this.chestAim.dot(this.torso))
    if (this.chestFwd.lengthSq() < 1e-6) this.chestFwd.set(0, 0, 1)
    this.chestFwd.normalize()
    this.chestRight.crossVectors(this.chestFwd, this.torso).normalize()
    this.pelvisRight.crossVectors(this.pelvisFwd, _a)
    if (this.pelvisRight.lengthSq() < 1e-6) this.pelvisRight.copy(this.chestRight)
    this.pelvisRight.normalize()
    this.hipL.copy(this.pelvis).addScaledVector(this.pelvisRight, -BODY.hipHalf)
    this.hipR.copy(this.pelvis).addScaledVector(this.pelvisRight, BODY.hipHalf)
    this.shoulderL.copy(this.chest).addScaledVector(this.chestRight, -BODY.shoulderHalf).addScaledVector(this.torso, -BODY.shoulderDrop)
    this.shoulderR.copy(this.chest).addScaledVector(this.chestRight, BODY.shoulderHalf).addScaledVector(this.torso, -BODY.shoulderDrop)
    this.neckTop.copy(this.chest).addScaledVector(this.torso, BODY.neck)
    this.head.copy(this.neckTop).addScaledVector(this.headUp, BODY.head)
  }

  solveLegs(): void {
    ik2(this.hipL, this.ankleL, BODY.thigh, BODY.shin, this.kneePoleL, this.kneeL, this.footL)
    ik2(this.hipR, this.ankleR, BODY.thigh, BODY.shin, this.kneePoleR, this.kneeR, this.footR)
  }

  solveArms(): void {
    ik2(this.shoulderL, this.palmAimL, BODY.upperArm, BODY.foreArm, this.elbowPoleL, this.elbowL, this.palmL, 0.045)
    ik2(this.shoulderR, this.palmAimR, BODY.upperArm, BODY.foreArm, this.elbowPoleR, this.elbowR, this.palmR, 0.045)
  }

  /**
   * Keep the feet on the deck. If a hip has drifted further from its ankle than the leg is
   * long, the hips come down along the balance line `line` (unit, feet to hips) until both
   * legs reach: a rider whose leg runs out of length bends the other one, he does not slide
   * over to the straight leg's foot. Only when no point of that line is within reach is
   * the pelvis pulled toward the ankle.
   */
  keepFeetPlanted(line?: THREE.Vector3): void {
    const maxLen = (BODY.thigh + BODY.shin) * 0.992
    if (line) {
      let drop = 0
      for (let side = 0; side < 2; side++) {
        _v.subVectors(side === 0 ? this.hipL : this.hipR, side === 0 ? this.ankleL : this.ankleR)
        const over = _v.lengthSq() - maxLen * maxLen
        if (over <= 0) continue
        // |d - t line| = maxLen, the smallest t > 0
        const b = _v.dot(line)
        const disc = b * b - over
        if (b > 0 && disc >= 0) drop = Math.max(drop, b - Math.sqrt(disc))
      }
      if (drop > 0) {
        this.pelvis.addScaledVector(line, -drop)
        this.solveTrunk()
      }
      // Nor is a leg left locked straight beside a bent one: where the hips have been carried
      // toward one foot, they come down a little further and the long leg keeps some bend.
      const lenL = _v.subVectors(this.hipL, this.ankleL).length()
      const lenR = _v.subVectors(this.hipR, this.ankleR).length()
      const uneven = Math.abs(lenL - lenR) - 0.02
      const longest = Math.max(lenL, lenR)
      if (uneven > 0 && longest > maxLen * 0.975) {
        const near = Math.min(1, (longest / maxLen - 0.975) / 0.02)
        this.pelvis.addScaledVector(line, -RIDER_TUNE.legEven * uneven * near * near * (3 - 2 * near))
        this.solveTrunk()
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let side = 0; side < 2; side++) {
        const hip = side === 0 ? this.hipL : this.hipR
        const ankle = side === 0 ? this.ankleL : this.ankleR
        _v.subVectors(ankle, hip)
        const d = _v.length()
        if (d > maxLen) {
          _v.multiplyScalar((d - maxLen) / d)
          this.pelvis.add(_v)
          this.solveTrunk()
        }
      }
    }
  }

  /** write the body's capsules (slots CAP.pelvis .. CAP.footR) */
  write(caps: CapsuleSet): void {
    const k = RIDER_TUNE.limbScale
    const T = this.torso, R = this.chestRight, PR = this.pelvisRight
    // pelvis: a bar across the hip joints
    caps.setV(CAP.pelvis, this.hipL, 0.108 * k, this.hipR, 0.108 * k)
    caps.shape(CAP.pelvis, T.x, T.y, T.z, 0.9)
    // belly and chest: wider than deep
    _a.copy(this.pelvis).addScaledVector(T, 0.03)
    caps.setV(CAP.belly, _a, 0.118 * k, this.waist, 0.122 * k)
    caps.shape(CAP.belly, PR.x + R.x, PR.y + R.y, PR.z + R.z, 0.74)
    _b.copy(this.chest).addScaledVector(T, -0.09)
    caps.setV(CAP.chest, this.waist, 0.124 * k, _b, 0.15 * k)
    caps.shape(CAP.chest, R.x, R.y, R.z, 0.66)
    caps.setV(CAP.shoulders, this.shoulderL, 0.064 * k, this.shoulderR, 0.064 * k)
    caps.shape(CAP.shoulders, T.x, T.y, T.z, 0.9)
    _a.copy(this.chest).addScaledVector(T, 0.02)
    caps.setV(CAP.neck, _a, 0.052 * k, this.head, 0.05 * k)
    caps.shape(CAP.neck, R.x, R.y, R.z, 1)
    // head, a cap and its brim (the brim shows where he is looking)
    const hu = this.headUp, g = this.gaze
    _a.copy(this.head).addScaledVector(hu, -0.025)
    _b.copy(this.head).addScaledVector(hu, 0.03)
    caps.setV(CAP.head, _a, BODY.headRadius, _b, BODY.headRadius)
    caps.shape(CAP.head, g.x, g.y, g.z, 0.9)
    _a.copy(this.head).addScaledVector(hu, 0.04).addScaledVector(g, -0.008)
    _b.copy(this.head).addScaledVector(hu, 0.062).addScaledVector(g, -0.008)
    caps.setV(CAP.cap, _a, 0.106, _b, 0.092)
    caps.shape(CAP.cap, g.x, g.y, g.z, 0.94)
    _c.crossVectors(g, hu)
    _a.copy(this.head).addScaledVector(hu, 0.052).addScaledVector(g, 0.07)
    _b.copy(this.head).addScaledVector(hu, 0.04).addScaledVector(g, 0.175)
    caps.setV(CAP.brim, _a, 0.075, _b, 0.06)
    caps.shape(CAP.brim, _c.x, _c.y, _c.z, 0.16)

    this.writeArm(caps, CAP.upperArmL, this.shoulderL, this.elbowL, this.palmL, k)
    this.writeArm(caps, CAP.upperArmR, this.shoulderR, this.elbowR, this.palmR, k)
    this.writeLeg(caps, CAP.thighL, this.hipL, this.kneeL, this.footL, this.toeDirL, this.soleUpL, k)
    this.writeLeg(caps, CAP.thighR, this.hipR, this.kneeR, this.footR, this.toeDirR, this.soleUpR, k)
  }

  private writeArm(caps: CapsuleSet, slot: number, sh: THREE.Vector3, el: THREE.Vector3, palm: THREE.Vector3, k: number): void {
    caps.setV(slot, sh, 0.054 * k, el, 0.044 * k)
    caps.shape(slot, 1, 0, 0, 1)
    // wrist on the way to the palm; the hand carries on a little past it
    _v.subVectors(palm, el)
    const len = Math.max(1e-4, _v.length())
    _v.multiplyScalar(1 / len)
    _a.copy(el).addScaledVector(_v, BODY.wrist)
    caps.setV(slot + 1, el, 0.043 * k, _a, 0.033 * k)
    caps.shape(slot + 1, 1, 0, 0, 1)
    _b.copy(palm).addScaledVector(_v, 0.045)
    caps.setV(slot + 2, _a, 0.038 * k, _b, 0.034 * k)
    caps.shape(slot + 2, 1, 0, 0, 1)
  }

  private writeLeg(
    caps: CapsuleSet, slot: number, hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3,
    toeDir: THREE.Vector3, soleUp: THREE.Vector3, k: number,
  ): void {
    caps.setV(slot, hip, 0.09 * k, knee, 0.064 * k)
    caps.shape(slot, 1, 0, 0, 1)
    caps.setV(slot + 1, knee, 0.062 * k, ankle, 0.044 * k)
    caps.shape(slot + 1, 1, 0, 0, 1)
    // sole on the deck: the ankle is BODY.ankle above it
    const r = 0.05 * k, squash = 0.72
    const drop = BODY.ankle - r * squash
    _a.copy(ankle).addScaledVector(toeDir, -BODY.footBack).addScaledVector(soleUp, -drop)
    _b.copy(ankle).addScaledVector(toeDir, BODY.footLen - BODY.footBack - r).addScaledVector(soleUp, -drop - 0.006)
    _c.crossVectors(toeDir, soleUp)
    caps.setV(slot + 2, _a, r, _b, r * 0.9)
    caps.shape(slot + 2, _c.x, _c.y, _c.z, squash)
  }

  /** paddle capsules from the handle position, the shaft direction and the blade's wide axis */
  writePaddle(caps: CapsuleSet, top: THREE.Vector3, dir: THREE.Vector3, wide: THREE.Vector3): void {
    const shaftEnd = PADDLE.length - PADDLE.blade
    _a.copy(top)
    _b.copy(top).addScaledVector(dir, shaftEnd + 0.05)
    caps.setV(CAP.shaft, _a, PADDLE.shaftRadius, _b, PADDLE.shaftRadius)
    caps.shape(CAP.shaft, wide.x, wide.y, wide.z, 1)
    const rTip = PADDLE.bladeWidth / 2
    _a.copy(top).addScaledVector(dir, shaftEnd + 0.035)
    _b.copy(top).addScaledVector(dir, PADDLE.length - rTip)
    caps.setV(CAP.blade, _a, 0.035, _b, rTip)
    caps.shape(CAP.blade, wide.x, wide.y, wide.z, 0.07)
    _a.copy(top).addScaledVector(wide, -0.05)
    _b.copy(top).addScaledVector(wide, 0.05)
    caps.setV(CAP.handle, _a, 0.018, _b, 0.018)
    caps.shape(CAP.handle, dir.x, dir.y, dir.z, 1)
  }
}

/** colours of the body and paddle capsules */
export function paintFigure(caps: CapsuleSet): void {
  const suit = new THREE.Color(COLORS.suit)
  const vest = new THREE.Color(COLORS.vest)
  const skin = new THREE.Color(COLORS.skin)
  const cap = new THREE.Color(COLORS.cap)
  const shaft = new THREE.Color(COLORS.shaft)
  const blade = new THREE.Color(COLORS.blade)
  const wet = 0.35
  caps.color(CAP.pelvis, suit, wet)
  caps.color(CAP.belly, vest, 0.12)
  caps.color(CAP.chest, vest, 0.12)
  caps.color(CAP.shoulders, vest, 0.12)
  caps.color(CAP.neck, skin, 0.1)
  caps.color(CAP.head, skin, 0.1)
  caps.color(CAP.cap, cap, 0.1)
  caps.color(CAP.brim, cap, 0.1)
  for (const s of [CAP.upperArmL, CAP.foreArmL, CAP.upperArmR, CAP.foreArmR, CAP.thighL, CAP.shinL, CAP.thighR, CAP.shinR]) caps.color(s, suit, wet)
  for (const s of [CAP.handL, CAP.handR, CAP.footL, CAP.footR]) caps.color(s, skin, 0.1)
  caps.color(CAP.shaft, shaft, 0.5)
  caps.color(CAP.blade, blade, 0.6)
  caps.color(CAP.handle, shaft, 0.5)
}

/**
 * The foil as six fixed capsules: mast (a flattened section on the frame's Y axis, where
 * the spray and wake are made), fuselage, two front-wing halves and two stabiliser halves.
 */
export function writeFoil(caps: CapsuleSet, foil: { span: number; area: number; mastLength: number; mastChord: number }): void {
  const col = new THREE.Color(COLORS.foil)
  const wingX = 0.17
  const chord = foil.area / foil.span
  const root = chord * 1.42, tip = chord * 0.58
  // mast: chord along X, about 14% thick; ends rounded into the board and the fuselage
  caps.set(CAP.mast, 0, 0.045, 0, foil.mastChord * 0.44, 0, foil.mastLength - 0.03, 0, foil.mastChord * 0.52)
  caps.shape(CAP.mast, 1, 0, 0, 0.15)
  caps.set(CAP.fuse, wingX + 0.09, 0, 0, 0.014, -0.64, 0.004, 0, 0.011)
  caps.shape(CAP.fuse, 0, 0, 1, 1)
  const half = foil.span / 2
  for (let side = 0; side < 2; side++) {
    const sg = side === 0 ? -1 : 1
    // front wing: tapered, swept a little, tips drooping a few centimetres
    caps.set(CAP.wingL + side, wingX, 0, 0, root / 2, wingX - 0.05, -0.028, sg * (half - tip / 2), tip / 2)
    caps.shape(CAP.wingL + side, 1, 0, 0, 0.13)
    caps.set(CAP.stabL + side, -0.6, 0.014, 0, 0.036, -0.62, 0.02, sg * 0.185, 0.017)
    caps.shape(CAP.stabL + side, 1, 0, 0, 0.12)
  }
  for (const s of [CAP.mast, CAP.fuse, CAP.wingL, CAP.wingR, CAP.stabL, CAP.stabR]) caps.color(s, col, 0.45)
}
