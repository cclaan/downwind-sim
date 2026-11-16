/** Small numeric helpers for the rider: clamps, eases and critically damped springs. */
import * as THREE from 'three'

export const DEG = Math.PI / 180
// (written so that NaN comes out as the lower bound: a bad number never spreads into the pose)
export const clamp = (v: number, lo: number, hi: number) => (v >= lo ? (v <= hi ? v : hi) : lo)
export const sat = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** smoothstep; with e0 == e1 it is a plain step at that edge */
export const smooth = (e0: number, e1: number, x: number) => {
  const d = e1 - e0
  if (d === 0) return x < e0 ? 0 : 1
  const u = sat((x - e0) / d)
  return u * u * (3 - 2 * u)
}

/** Critically damped spring, integrated implicitly: stable for any time step. */
export class Spring {
  x = 0
  v = 0
  step(target: number, omega: number, dt: number): number {
    // a target that is not a number is ignored: the spring stays where it is
    if (!Number.isFinite(target)) return this.x
    if (!Number.isFinite(this.x + this.v)) return this.snap(target)
    const f = 1 + 2 * dt * omega
    const hoo = dt * omega * omega
    const hhoo = dt * hoo
    const inv = 1 / (f + hhoo)
    const x = (f * this.x + dt * this.v + hhoo * target) * inv
    this.v = (this.v + hoo * (target - this.x)) * inv
    this.x = x
    return x
  }
  snap(target: number): number {
    this.x = Number.isFinite(target) ? target : 0
    this.v = 0
    return this.x
  }
}

export class Spring3 {
  readonly x = new THREE.Vector3()
  readonly v = new THREE.Vector3()
  step(target: THREE.Vector3, omega: number, dt: number): THREE.Vector3 {
    const x = this.x, v = this.v
    if (!Number.isFinite(target.x + target.y + target.z)) return x
    if (!Number.isFinite(x.x + x.y + x.z + v.x + v.y + v.z)) return this.snap(target)
    const f = 1 + 2 * dt * omega
    const hoo = dt * omega * omega
    const hhoo = dt * hoo
    const inv = 1 / (f + hhoo)
    const nx = (f * x.x + dt * v.x + hhoo * target.x) * inv
    const ny = (f * x.y + dt * v.y + hhoo * target.y) * inv
    const nz = (f * x.z + dt * v.z + hhoo * target.z) * inv
    v.x = (v.x + hoo * (target.x - x.x)) * inv
    v.y = (v.y + hoo * (target.y - x.y)) * inv
    v.z = (v.z + hoo * (target.z - x.z)) * inv
    x.set(nx, ny, nz)
    return x
  }
  snap(target: THREE.Vector3): THREE.Vector3 {
    if (Number.isFinite(target.x + target.y + target.z)) this.x.copy(target)
    this.v.set(0, 0, 0)
    return this.x
  }
}

/** smooth pseudo-random wobble in -1..1 (deterministic in t) */
export function wobble(t: number, seed: number): number {
  return (
    0.55 * Math.sin(t * 2.3 + seed * 1.7) +
    0.3 * Math.sin(t * 4.1 + seed * 3.1 + 1.3) +
    0.15 * Math.sin(t * 7.7 + seed * 5.3 + 0.4)
  )
}
