/**
 * Seeded value noise for textures generated at load (clouds). Deterministic: same seed,
 * same sky. Not for per-frame use.
 */
import { mulberry32 } from '../../sim/rng'

/**
 * Smooth 3-D value noise on a periodic lattice (period `n` cells on every axis, n a power
 * of two), 0..1.
 */
export class ValueNoise3 {
  readonly n: number
  private readonly t: Float32Array

  constructor(seed: number, n = 32) {
    if ((n & (n - 1)) !== 0) throw new Error('ValueNoise3: n must be a power of two')
    this.n = n
    this.t = new Float32Array(n * n * n)
    const rand = mulberry32(seed)
    for (let i = 0; i < this.t.length; i++) this.t[i] = rand()
  }

  sample(x: number, y: number, z: number): number {
    const n = this.n
    const m = n - 1
    const t = this.t
    const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z)
    let fx = x - xf, fy = y - yf, fz = z - zf
    // quintic fade: continuous second derivative, so shading normals taken from it are smooth
    fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    fz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
    // masks, not %: a remainder of -0 on negative coordinates knocks V8 off its integer path
    const x0 = xf & m, y0 = yf & m, z0 = zf & m
    const x1 = (x0 + 1) & m, y1 = (y0 + 1) & m, z1 = (z0 + 1) & m
    const a = (z0 * n + y0) * n, b = (z0 * n + y1) * n, c = (z1 * n + y0) * n, d = (z1 * n + y1) * n
    const p00 = t[a + x0] + (t[a + x1] - t[a + x0]) * fx
    const p10 = t[b + x0] + (t[b + x1] - t[b + x0]) * fx
    const p01 = t[c + x0] + (t[c + x1] - t[c + x0]) * fx
    const p11 = t[d + x0] + (t[d + x1] - t[d + x0]) * fx
    const q0 = p00 + (p10 - p00) * fy
    const q1 = p01 + (p11 - p01) * fy
    return q0 + (q1 - q0) * fz
  }

  /** Fractal sum, 0..1 (mean 0.5). With lacunarity 2 and a start frequency that divides n it tiles. */
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1, sum = 0, norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x, y, z)
      norm += amp
      amp *= gain
      x *= lacunarity; y *= lacunarity; z *= lacunarity
    }
    return sum / norm
  }
}

/**
 * Maps raw noise values to their rank, 0..1, so that `rank > 1 - cover` is true over exactly
 * the fraction `cover` of the field: a cloud layer generated this way has the mean cover it
 * was asked for.
 */
export function makeEqualiser(samples: Float32Array, count: number): (v: number) => number {
  const sorted = samples.slice(0, count).sort()
  const N = 256
  const q = new Float32Array(N + 1)
  for (let i = 0; i <= N; i++) q[i] = sorted[Math.min(count - 1, Math.floor((i / N) * (count - 1)))]
  return (v: number) => {
    if (v <= q[0]) return 0
    if (v >= q[N]) return 1
    let lo = 0, hi = N
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (q[mid] <= v) lo = mid
      else hi = mid
    }
    const span = q[hi] - q[lo]
    return (lo + (span > 1e-9 ? (v - q[lo]) / span : 0)) / N
  }
}

/**
 * A tileable RGBA8 fractal-noise tile, the same field in R, G and B (A: 255). Every octave
 * is value noise on its own lattice that wraps at the tile's edge (4, 8, 16, 32 and 64
 * cells across), so the tile repeats without a seam.
 */
export function makeNoiseTile(size: number, seed: number): Uint8Array {
  const rand = mulberry32(seed)
  const out = new Uint8Array(size * size * 4)
  const tmp = new Float32Array(size * size)
  let amp = 1
  for (let o = 0; o < 5; o++) {
    const P = 4 << o
    const lattice = new Float32Array(P * P)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand()
    for (let j = 0; j < size; j++) {
      const y = (j / size) * P
      const y0 = Math.floor(y)
      let fy = y - y0
      fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
      const ya = (y0 % P) * P, yb = ((y0 + 1) % P) * P
      for (let i = 0; i < size; i++) {
        const x = (i / size) * P
        const x0 = Math.floor(x)
        let fx = x - x0
        fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
        const xa = x0 % P, xb = (x0 + 1) % P
        const top = lattice[ya + xa] + (lattice[ya + xb] - lattice[ya + xa]) * fx
        const bot = lattice[yb + xa] + (lattice[yb + xb] - lattice[yb + xa]) * fx
        tmp[j * size + i] += amp * (top + (bot - top) * fy)
      }
    }
    amp *= 0.5
  }
  let lo = Infinity, hi = -Infinity
  for (let p = 0; p < size * size; p++) {
    if (tmp[p] < lo) lo = tmp[p]
    if (tmp[p] > hi) hi = tmp[p]
  }
  const k = 255 / (hi - lo)
  for (let p = 0; p < size * size; p++) {
    const v = Math.round((tmp[p] - lo) * k)
    out[p * 4] = v
    out[p * 4 + 1] = v
    out[p * 4 + 2] = v
    out[p * 4 + 3] = 255
  }
  return out
}
