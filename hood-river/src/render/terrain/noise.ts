/**
 * Deterministic lattice noise for the terrain builder (load time only, never per frame).
 * Everything is a pure function of position and a seed, so the same gorge is built on
 * every device and in every capture.
 */

/** integer hash to [0, 1) */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** smooth value noise in [0, 1] */
export function vnoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

/** fractal value noise, roughly [0, 1], mean 0.5 */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x, z, seed + o * 131)
    norm += amp
    // rotate a little between octaves so the lattice does not show
    const nx = 1.6 * x + 1.2 * z, nz = -1.2 * x + 1.6 * z
    x = nx + 17.3; z = nz - 9.1
    amp *= 0.5
  }
  return sum / norm
}

/** ridged fractal noise in [0, 1]: sharp crests, rounded hollows (drainage-like relief) */
export function ridged(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, w = 1
  for (let o = 0; o < octaves; o++) {
    let r = 1 - Math.abs(2 * vnoise(x, z, seed + o * 71) - 1)
    r *= r
    sum += amp * r * w
    norm += amp
    w = Math.min(1, Math.max(0.25, r * 1.6))
    const nx = 1.6 * x + 1.2 * z, nz = -1.2 * x + 1.6 * z
    x = nx + 5.7; z = nz + 13.9
    amp *= 0.5
  }
  return sum / norm
}

export function smoothstep(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
