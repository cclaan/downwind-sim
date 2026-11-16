/**
 * Where the board is, as a transform.
 *
 * The rider group's local frame: origin at the centre of the front wing, +X toward the
 * nose, +Y up through the deck, +Z to starboard (the rider's right when facing the nose).
 * The underside of the board is at local y = mastLength. The pump's heave (the board and
 * wing dipping on each drive) is included.
 */
import * as THREE from 'three'
import type { RiderState } from '../sim/types'

const _f = new THREE.Vector3()
const _n = new THREE.Vector3()
const _r = new THREE.Vector3()

/** Compose the wing-origin transform from heading, pitch and bank. */
export function riderMatrix(s: RiderState, out: THREE.Matrix4): THREE.Matrix4 {
  const ch = Math.cos(s.heading), sh = Math.sin(s.heading)
  const cp = Math.cos(s.pitch), sp = Math.sin(s.pitch)
  const cb = Math.cos(s.bank), sb = Math.sin(s.bank)
  // forward, pitched up by `pitch`
  _f.set(ch * cp, sp, sh * cp)
  // deck normal before banking
  const npx = -ch * sp, npy = cp, npz = -sh * sp
  // horizontal right
  const r0x = -sh, r0z = ch
  // bank: positive = right rail down
  _r.set(r0x * cb - npx * sb, -npy * sb, r0z * cb - npz * sb)
  _n.set(npx * cb + r0x * sb, npy * cb, npz * cb + r0z * sb)
  out.makeBasis(_f, _n, _r)
  out.setPosition(s.x, s.y - s.heave, s.z)
  return out
}
