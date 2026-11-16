/**
 * Low-poly shapes for the river's traffic, built once at load: a wing-foiler, a
 * windsurfer, a kiter with the kite on its lines, and a box (barges, tug, rail cars).
 *
 * Local frame of a craft: origin on the water under the rider, +X toward the bow, +Y up,
 * +Z to leeward (the side the rig is on; the instance mirrors Z for the other tack).
 * Everything is flat-shaded and a few dozen triangles: these are seen from 30 m to 4 km.
 *
 * Vertex attributes
 *   position, normal
 *   aColor   fixed albedo (linear RGB) for parts that are not painted per instance
 *   aPaint   x: 0 = use aColor, 1..2 = mix of the instance's two colours (1 = A, 2 = B)
 *            y: 0 = matte, 1 = sail cloth (lit from both sides, glows against the sun), 2 = foam
 *            z: how much the vertex moves with the rig (0 = hull and feet, 1 = top of the sail)
 *            w: boxes only: 1 = this vertex sits on the box's colour split
 */
import * as THREE from 'three'

export interface Shape {
  position: Float32Array
  normal: Float32Array
  color: Float32Array
  paint: Float32Array
  triangles: number
  /** height used to keep the shape a few pixels tall when far away (m) */
  height: number
  /** the most the shape may be enlarged to stay visible */
  growMax: number
}

type V3 = [number, number, number]

const MATTE = 0, CLOTH = 1, FOAM = 2

function lin(hex: number): V3 {
  const c = new THREE.Color(hex)
  return [c.r, c.g, c.b]
}

const SUIT = lin(0x3b434d)
const SKIN_HOOD = lin(0x4a4f56)
const BOARD = lin(0xe9e7df)
const CARBON = lin(0x1a1c1f)
const FOAM_WHITE = lin(0xe6eeee)
const WINDOW = lin(0xcfd8de)

class Builder {
  pos: number[] = []
  nor: number[] = []
  col: number[] = []
  paint: number[] = []

  tri(a: V3, b: V3, c: V3, color: V3, mix: number, kind: number, fa = 0, fb = fa, fc = fa, mid: [number, number, number] = [0, 0, 0]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    const flex = [fa, fb, fc]
    const pts = [a, b, c]
    for (let i = 0; i < 3; i++) {
      this.pos.push(pts[i][0], pts[i][1], pts[i][2])
      this.nor.push(nx, ny, nz)
      this.col.push(color[0], color[1], color[2])
      this.paint.push(mix, kind, flex[i], mid[i])
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, color: V3, mix: number, kind: number, fa = 0, fb = fa, fc = fa, fd = fa) {
    this.tri(a, b, c, color, mix, kind, fa, fb, fc)
    this.tri(a, c, d, color, mix, kind, fa, fc, fd)
  }

  /** axis-aligned box from its centre and size (no bottom face when `open`) */
  box(c: V3, s: V3, color: V3, flex = 0, open = true) {
    const [x0, x1] = [c[0] - s[0] / 2, c[0] + s[0] / 2]
    const [y0, y1] = [c[1] - s[1] / 2, c[1] + s[1] / 2]
    const [z0, z1] = [c[2] - s[2] / 2, c[2] + s[2] / 2]
    const q = (a: V3, b: V3, cc: V3, d: V3) => this.quad(a, b, cc, d, color, 0, MATTE, flex)
    q([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]) // top
    q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]) // +z
    q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]) // -z
    q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]) // +x
    q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]) // -x
    if (!open) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  }

  /** a tapered tube of `sides` faces from p0 (half-width w0) to p1 (half-width w1) */
  limb(p0: V3, p1: V3, w0: number, w1: number, color: V3, sides: number, f0 = 0, f1 = f0) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2]
    const l = Math.hypot(dx, dy, dz) || 1
    const ax = dx / l, ay = dy / l, az = dz / l
    // two directions across the limb
    let ux = ay * 0 - az * 1, uy = az * 0 - ax * 0, uz = ax * 1 - ay * 0 // axis x (0,1,0)
    if (Math.hypot(ux, uy, uz) < 0.3) { ux = 0; uy = -az; uz = ay } // axis x (1,0,0)
    const ul = Math.hypot(ux, uy, uz)
    ux /= ul; uy /= ul; uz /= ul
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux
    const ring = (p: V3, w: number, k: number): V3 => {
      const a = (k / sides) * Math.PI * 2 + Math.PI / sides
      const c = Math.cos(a) * w, s = Math.sin(a) * w
      return [p[0] + ux * c + vx * s, p[1] + uy * c + vy * s, p[2] + uz * c + vz * s]
    }
    for (let k = 0; k < sides; k++) {
      this.quad(ring(p0, w0, k), ring(p0, w0, k + 1), ring(p1, w1, k + 1), ring(p1, w1, k), color, 0, MATTE, f0, f0, f1, f1)
    }
  }

  /** a rider: two legs, a torso, a head and two arms */
  figure(footF: V3, footB: V3, hip: V3, shoulder: V3, head: V3, handF: V3, handB: V3, flex: number) {
    this.limb(footF, hip, 0.075, 0.11, SUIT, 3, 0, flex * 0.4)
    this.limb(footB, hip, 0.075, 0.11, SUIT, 3, 0, flex * 0.4)
    this.limb(hip, shoulder, 0.17, 0.2, SUIT, 4, flex * 0.4, flex * 0.7)
    this.box(head, [0.21, 0.24, 0.21], SKIN_HOOD, flex * 0.75, false)
    this.limb(shoulder, handF, 0.06, 0.045, SUIT, 3, flex * 0.7, flex)
    this.limb(shoulder, handB, 0.06, 0.045, SUIT, 3, flex * 0.7, flex)
  }

  build(height: number, growMax = 3): Shape {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nor),
      color: new Float32Array(this.col),
      paint: new Float32Array(this.paint),
      triangles: this.pos.length / 9,
      height,
      growMax,
    }
  }
}

/**
 * A wing-foiler on a reach: a short board flying on its mast, the rider upright with both
 * hands up, and the hand-held wing carried over the head as the references show it: a
 * 3 m crescent tilted 40 degrees from level, the upper tip up to windward and forward over
 * the rider's head, the lower one out to leeward at chest height, the leading edge bowed
 * forward and swept back hard to the tips, the canopy arched between them. Canopy in
 * colour A, leading edge and strut in colour B.
 */
export function makeWingFoiler(): Shape {
  const b = new Builder()
  const deck = 0.78
  b.box([0.05, deck - 0.04, 0], [1.45, 0.08, 0.5], BOARD)
  // mast into the water
  b.quad([-0.22, 0, 0], [-0.1, 0, 0], [-0.1, deck - 0.08, 0], [-0.22, deck - 0.08, 0], CARBON, 0, MATTE)
  b.figure([0.33, deck, 0.02], [-0.32, deck, -0.02], [-0.02, deck + 0.88, -0.1], [0.03, deck + 1.44, -0.2], [0.05, deck + 1.68, -0.22],
    [0.36, deck + 1.9, 0.2], [-0.22, deck + 1.78, 0.28], 0.5)
  // the wing's own axes: span (toward the upper tip), chord (toward the trailing edge) and
  // the canopy's outward normal (up and to leeward)
  const centre: V3 = [0.1, deck + 1.95, 0.4]
  const tilt = (40 * Math.PI) / 180
  const span = unit([0.2, Math.sin(tilt), -Math.cos(tilt)])
  const chordDir = unit([-1, -0.14, 0.08])
  const out = unit(cross(span, chordDir))
  const HALF_SPAN = 1.5
  const stations = [-1, -0.76, -0.42, 0, 0.42, 0.76, 1]
  const at = (t: number, back: number, lift: number): V3 => [
    centre[0] + span[0] * HALF_SPAN * t + chordDir[0] * back + out[0] * lift,
    centre[1] + span[1] * HALF_SPAN * t + chordDir[1] * back + out[1] * lift,
    centre[2] + span[2] * HALF_SPAN * t + chordDir[2] * back + out[2] * lift,
  ]
  // leading edge: 0.8 m ahead of the centre in the middle, swept back 1.25 m at the tips,
  // which curl in toward the rider (the arch of the canopy)
  const sweep = (t: number) => -0.8 + 1.25 * t * t
  const arch = (t: number) => -0.42 * t * t
  const le = (t: number): V3 => at(t, sweep(t), arch(t))
  const te = (t: number): V3 => {
    const chord = 1.6 * Math.pow(Math.max(0, 1 - t * t), 0.8) + 0.22
    // the canopy bellies out between the leading edge and the trailing edge
    return at(t, sweep(t) + chord, arch(t) + 0.14 * (1 - t * t))
  }
  const flexOf = (t: number) => 0.6 + 0.4 * (t * 0.5 + 0.5)
  for (let k = 0; k < stations.length - 1; k++) {
    const t0 = stations[k], t1 = stations[k + 1]
    const a = le(t0), bb = le(t1), c = te(t1), d = te(t0)
    // leading-edge tube: the front 17 cm
    const a2 = at(t0, sweep(t0) + 0.17, arch(t0)), b2 = at(t1, sweep(t1) + 0.17, arch(t1))
    const f0 = flexOf(t0), f1 = flexOf(t1)
    b.quad(a, bb, b2, a2, BOARD, 2, CLOTH, f0, f1, f1, f0)
    b.quad(a2, b2, c, d, BOARD, 1, CLOTH, f0, f1, f1, f0)
  }
  // centre strut, standing 7 cm proud of the canopy on the rider's side
  const s0 = at(0, sweep(0), -0.04), s1 = at(0, sweep(0) + 1.75, 0.08)
  const sw: V3 = [span[0] * 0.07, span[1] * 0.07, span[2] * 0.07]
  b.quad([s0[0] - sw[0], s0[1] - sw[1], s0[2] - sw[2]], [s0[0] + sw[0], s0[1] + sw[1], s0[2] + sw[2]],
    [s1[0] + sw[0], s1[1] + sw[1], s1[2] + sw[2]], [s1[0] - sw[0], s1[1] - sw[1], s1[2] - sw[2]], BOARD, 2, CLOTH, 0.8)
  return b.build(3.9)
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * A windsurfer planing on a reach: board on the water with a white wake, the rig raked
 * aft and to windward, the sailor hanging off the boom. Lower sail panel is clear film;
 * the panels above alternate colours A and B.
 */
export function makeWindsurfer(): Shape {
  const b = new Builder()
  b.box([0.1, 0.07, 0], [2.35, 0.13, 0.6], BOARD)
  // wake: two streaks of foam off the tail, and spray off the leeward rail
  b.tri([-1.05, 0.07, -0.26], [-1.05, 0.07, -0.02], [-5.2, 0.07, -0.75], FOAM_WHITE, 0, FOAM)
  b.tri([-1.05, 0.07, 0.02], [-1.05, 0.07, 0.26], [-5.2, 0.07, 0.75], FOAM_WHITE, 0, FOAM)
  b.tri([0.2, 0.1, 0.3], [-0.9, 0.1, 0.3], [-1.1, 0.42, 0.75], FOAM_WHITE, 0, FOAM)
  const foot: V3 = [0.35, 0.14, 0]
  const headP: V3 = [-0.5, 4.35, -0.8]
  const mast = (t: number): V3 => [foot[0] + (headP[0] - foot[0]) * t, foot[1] + (headP[1] - foot[1]) * t, foot[2] + (headP[2] - foot[2]) * t]
  const clew: V3 = [-1.52, 1.62, -0.12]
  // leech from the clew up to the head, bowed aft
  const leech = (t: number): V3 => {
    const bow = 0.36 * Math.sin(Math.PI * t)
    return [clew[0] + (headP[0] - clew[0]) * t - bow, clew[1] + (headP[1] - clew[1]) * t, clew[2] + (headP[2] - clew[2]) * t]
  }
  const boomT = 0.34 // where the boom meets the mast
  // foot panel (clear film) below the boom
  b.quad(mast(0.05), [clew[0] + 0.25, 0.42, -0.02], clew, mast(boomT), WINDOW, 0, CLOTH, 0.05, 0.1, 0.36, 0.34)
  const steps = [0, 0.36, 0.7, 1]
  for (let k = 0; k < steps.length - 1; k++) {
    const m0 = mast(boomT + (1 - boomT) * steps[k]), m1 = mast(boomT + (1 - boomT) * steps[k + 1])
    const l0 = leech(steps[k]), l1 = leech(steps[k + 1])
    const f0 = boomT + (1 - boomT) * steps[k], f1 = boomT + (1 - boomT) * steps[k + 1]
    if (k === steps.length - 2) b.tri(m0, l0, m1, BOARD, 1, CLOTH, f0, f0, f1)
    else b.quad(m0, l0, l1, m1, BOARD, k === 0 ? 1 : 2, CLOTH, f0, f0, f1, f1)
  }
  // mast (seen as a dark line up the luff)
  const m0 = mast(0), m1 = mast(1)
  b.quad([m0[0] + 0.05, m0[1], m0[2]], [m0[0] - 0.05, m0[1], m0[2]], [m1[0] - 0.03, m1[1], m1[2]], [m1[0] + 0.03, m1[1], m1[2]], CARBON, 0, MATTE, 0, 0, 1, 1)
  // sailor: feet on the windward rail, body out over the water, hands on the boom
  const boom = mast(boomT)
  b.figure([-0.35, 0.14, -0.22], [-0.95, 0.14, -0.2], [-0.72, 0.95, -0.78], [-0.74, 1.5, -1.12], [-0.74, 1.74, -1.24],
    [boom[0] - 0.35, boom[1] - 0.02, boom[2] - 0.05], [boom[0] - 0.95, boom[1] - 0.02, boom[2] + 0.05], 0.3)
  return b.build(4.4)
}

/**
 * A kiter: twin-tip on the water, the rider leaning hard to windward, and the kite an
 * arch of canopy 15 m up and to leeward. No lines: they are finer than a pixel from any
 * distance the player sees them. Canopy in colour A, leading edge in colour B.
 */
export function makeKiter(): Shape {
  const b = new Builder()
  b.box([0, 0.06, -0.05], [1.36, 0.05, 0.42], BOARD)
  b.tri([-0.4, 0.08, -0.24], [-0.4, 0.08, 0.14], [-3.0, 0.07, -0.05], FOAM_WHITE, 0, FOAM)
  b.tri([0.3, 0.09, -0.26], [-0.6, 0.09, -0.26], [-0.8, 0.5, -0.75], FOAM_WHITE, 0, FOAM)
  b.figure([0.32, 0.1, -0.02], [-0.32, 0.1, -0.02], [0, 0.82, -0.52], [0.02, 1.32, -0.95], [0.03, 1.55, -1.08],
    [0.25, 1.5, -0.3], [-0.2, 1.5, -0.32], 0.2)
  // the kite, parked low in the window so its canopy faces up and down the river
  const centre: V3 = [2.5, 15, 15]
  const out: V3 = [0, 0.707, 0.707] // away from the rider, along the lines
  const R = 3.6
  const n = 6
  const pt = (k: number, back: number): V3 => {
    const th = (-78 + (156 * k) / n) * (Math.PI / 180)
    const along = Math.sin(th) * R
    const drop = (Math.cos(th) - 1) * R
    // chord runs across the lines, shorter toward the tips
    const chord = (0.6 + 1.6 * Math.cos(th)) * back
    return [centre[0] + along, centre[1] + out[1] * drop + out[2] * chord, centre[2] + out[2] * drop - out[1] * chord]
  }
  for (let k = 0; k < n; k++) {
    const a = pt(k, 0), bb = pt(k + 1, 0)
    const a1 = pt(k, 0.16), b1 = pt(k + 1, 0.16)
    const a2 = pt(k, 1), b2 = pt(k + 1, 1)
    b.quad(a, bb, b1, a1, BOARD, 2, CLOTH, 1)
    b.quad(a1, b1, b2, a2, BOARD, 1, CLOTH, 1)
  }
  // far kites are the point of them: let them stay a readable arch in the sky from 4 km
  return b.build(3, 4.5)
}

/**
 * A unit box, origin at the centre of its base: x and z in -0.5..0.5, y in 0..1, in two
 * colours split at a height the instance chooses (colour A below, B above). No bottom.
 */
export function makeBox(): Shape {
  const b = new Builder()
  const side = (a: V3, bb: V3) => {
    // a, bb: the two bottom corners of one wall, counter-clockwise seen from outside
    const am: V3 = [a[0], 0.5, a[2]], bm: V3 = [bb[0], 0.5, bb[2]]
    const at: V3 = [a[0], 1, a[2]], bt: V3 = [bb[0], 1, bb[2]]
    b.tri(a, bb, bm, BOARD, 1, MATTE, 0, 0, 0, [0, 0, 1])
    b.tri(a, bm, am, BOARD, 1, MATTE, 0, 0, 0, [0, 1, 1])
    b.tri(am, bm, bt, BOARD, 2, MATTE, 0, 0, 0, [1, 1, 0])
    b.tri(am, bt, at, BOARD, 2, MATTE, 0, 0, 0, [1, 0, 0])
  }
  side([-0.5, 0, 0.5], [0.5, 0, 0.5])
  side([0.5, 0, 0.5], [0.5, 0, -0.5])
  side([0.5, 0, -0.5], [-0.5, 0, -0.5])
  side([-0.5, 0, -0.5], [-0.5, 0, 0.5])
  b.quad([-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], BOARD, 2, MATTE)
  return b.build(0)
}
