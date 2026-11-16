/**
 * Textures for the water, all generated at load from seeded noise (no downloads), RGBA8
 * with mipmaps.
 *
 *   detail  tileable    RG = slope of wind chop, B = foam lace (filaments and rafts),
 *                       A = smooth noise with a flat histogram (thresholds = coverage)
 *   streak  tileable    drawn stretched 8:1 along the wind: R = thin lines of foam (windrows:
 *                       what a whitecap leaves behind, pulled out along the wind), G = lanes
 *                       of rougher and smoother water. B and A are free.
 *   swell   tileable    a frozen sample of the same sea the physics uses (same spectrum,
 *                       spread and crest sharpening): RG = slope, B = crest height. The low
 *                       and mid tiers shade the far field with it, where the mesh no longer
 *                       carries the bumps.
 *   shore   the level   R = water depth as the eye sees it (fine scale, shallows), G = the
 *                       bank (the terrain module's shore indicator: its zero line is the
 *                       drawn waterline), B = water depth (long scale), A = how big the
 *                       bumps are; from LEVEL, on the terrain's 15 m shore grid, which
 *                       contains the level's own grid nodes.
 *
 * The generators return plain typed arrays (testable in Node); the make* wrappers below
 * turn them into THREE.DataTexture.
 */
import * as THREE from 'three'
import { LEVEL } from '../../sim/level'
import { gaussian, mulberry32 } from '../../sim/rng'
import { G, type WaveParams } from '../../sim/waves'
import { BED_DEPTH, BED_REACH, SHORE_BLUR_PASSES, SHORE_DEPTH, SHORE_GRID_STEP } from '../terrain/field'
import { ifft2d } from './fft'

// ---------------------------------------------------------------------------------------
// detail: chop slopes, foam lace, smooth noise
// ---------------------------------------------------------------------------------------

/** rms of (texel.rg - 0.5) * 2 in the detail texture: multiply by slope / this to get a slope */
export const DETAIL_SLOPE_RMS = 1 / 3.5

function normalise(a: Float64Array): void {
  let s = 0
  let m = 0
  for (let i = 0; i < a.length; i++) m += a[i]
  m /= a.length
  for (let i = 0; i < a.length; i++) { a[i] -= m; s += a[i] * a[i] }
  s = Math.sqrt(s / a.length) || 1
  for (let i = 0; i < a.length; i++) a[i] /= s
}

/** Real random field with a given amplitude spectrum, tileable. amp(m, n) is in cycles per tile. */
function spectralField(size: number, rand: () => number, amp: (m: number, n: number) => number, kMax: number): Float64Array {
  const re = new Float64Array(size * size)
  const im = new Float64Array(size * size)
  for (let n = -kMax; n <= kMax; n++) {
    for (let m = -kMax; m <= kMax; m++) {
      if (m === 0 && n === 0) continue
      const a = amp(m, n)
      if (!(a > 0)) continue
      const i = ((n + size) % size) * size + ((m + size) % size)
      re[i] = a * gaussian(rand)
      im[i] = a * gaussian(rand)
    }
  }
  ifft2d(re, im, size)
  normalise(re)
  return re
}

/** Map values to their rank so the histogram is flat: a threshold t leaves a fraction 1 - t. */
function equalise(a: Float64Array): Float64Array {
  const order = new Uint32Array(a.length)
  for (let i = 0; i < a.length; i++) order[i] = i
  order.sort((p, q) => a[p] - a[q])
  const out = new Float64Array(a.length)
  for (let r = 0; r < a.length; r++) out[order[r]] = r / (a.length - 1)
  return out
}

function smooth01(e0: number, e1: number, v: number): number {
  const u = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
  return u * u * (3 - 2 * u)
}

/** band-limited noise, unit variance: amplitude 1 / k^power between kLo and kHi cycles per tile */
function bandNoise(size: number, rand: () => number, kLo: number, kHi: number, power: number): Float64Array {
  return spectralField(size, rand, (m, n) => {
    const k = Math.hypot(m, n)
    return k < kLo || k > kHi ? 0 : Math.pow(k, -power)
  }, Math.ceil(kHi))
}

export function makeDetailData(size: number, seed: number): Uint8Array {
  const rand = mulberry32(seed)
  // wind chop: equal slope variance per octave, short-crested, crests mostly square to the wind (+x)
  const height = spectralField(size, rand, (m, n) => {
    const k = Math.hypot(m, n)
    if (k < 3.5 || k > 38) return 0
    const c = Math.abs(m) / k
    const dir = 0.2 + 0.8 * c * c
    const taper = smooth01(3.5, 6, k) * (1 - smooth01(28, 38, k))
    return Math.sqrt(dir) * taper / (k * k)
  }, 38)
  // peak the crests and flatten the troughs, as steep chop is
  for (let i = 0; i < height.length; i++) height[i] += 0.38 * (height[i] * height[i] - 1)
  const sx = new Float64Array(size * size)
  const sz = new Float64Array(size * size)
  let var2 = 0
  for (let y = 0; y < size; y++) {
    const yu = ((y + 1) % size) * size
    const yd = ((y + size - 1) % size) * size
    for (let x = 0; x < size; x++) {
      const xr = (x + 1) % size
      const xl = (x + size - 1) % size
      const i = y * size + x
      sx[i] = height[y * size + xr] - height[y * size + xl]
      sz[i] = height[yu + x] - height[yd + x]
      var2 += sx[i] * sx[i] + sz[i] * sz[i]
    }
  }
  const rms = Math.sqrt(var2 / (2 * size * size)) || 1

  // foam lace: the zero lines of smooth noise are closed, wandering filaments, which is
  // how thin foam lies on water; a billowy field under them fills in to rafts as the foam
  // thickens. Thresholding `amount - k * (1 - lace)` goes filaments -> net -> rafts -> solid.
  const n1 = bandNoise(size, rand, 3, 12, 1.0)
  const n2 = bandNoise(size, rand, 9, 34, 0.8)
  const n3 = bandNoise(size, rand, 24, 80, 0.5)

  // smooth noise, flat histogram
  const smooth = equalise(bandNoise(size, rand, 1, 9, 2))

  const out = new Uint8Array(size * size * 4)
  const slopeScale = rms / DETAIL_SLOPE_RMS
  for (let i = 0; i < size * size; i++) {
    const j = i * 4
    out[j] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.5 * sx[i] / slopeScale)))
    out[j + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.5 * sz[i] / slopeScale)))
    const f1 = Math.exp(-((n1[i] / 0.16) ** 2))
    const f2 = Math.exp(-((n2[i] / 0.2) ** 2))
    const f3 = Math.exp(-((n3[i] / 0.35) ** 2))
    const billow = smooth01(-1.3, 1.5, 0.6 * n1[i] + 0.5 * n2[i] + 0.25 * n3[i])
    const lace = Math.min(1, Math.max(0, 0.5 * billow + 0.6 * Math.max(f1, 0.85 * f2) + 0.15 * f3))
    out[j + 2] = Math.round(255 * lace)
    out[j + 3] = Math.round(255 * smooth[i])
  }
  return out
}

// ---------------------------------------------------------------------------------------
// streak: foam lines and lanes along the wind
// ---------------------------------------------------------------------------------------

/** texels along the wind (u) and across it (v); the tile is drawn 8 times longer than wide */
export const STREAK_W = 128
export const STREAK_H = 256

/**
 * R: foam lines. Each is a ridge of constant width that wanders a little across the wind and
 * comes and goes along it, so thresholding gives clean lines whatever the level: above about
 * 0.5 only the two or three strong ones in a tile show (windrows on open water), above 0.15
 * all of them (the foam behind a whitecap, combed out by the wind).
 * G: smooth noise with a flat histogram, which the 8:1 stretch turns into lanes.
 */
export function makeStreakData(seed: number): Uint8Array {
  const W = STREAK_W, H = STREAK_H
  const rand = mulberry32(seed)
  // (smooth, so a field of W x W texels is enough: each row serves two rows of the texture)
  const lanes = equalise(bandNoise(W, rand, 1, 9, 2))
  const out = new Uint8Array(W * H * 4)
  const value = new Float32Array(W * H)
  const TWO_PI = Math.PI * 2
  const N = 9
  // two strong lines, two middling, the rest faint, never two strong ones side by side
  const strengths = [1, 0.42, 0.66, 0.36, 0.5, 0.92, 0.38, 0.7, 0.46]
  for (let j = 0; j < N; j++) {
    const v0 = (j + 0.2 + 0.6 * rand()) / N
    const strength = strengths[j] * (0.92 + 0.08 * rand())
    const sigma0 = 1.0 + 0.8 * rand() // texels across the wind
    // meanders across the wind: harmonics of the tile, each a fraction of its width
    const wa = [0.03, 0.016, 0.011, 0.008, 0.006, 0.005].map((a) => a * (0.4 + 1.2 * rand()))
    const wp = wa.map(() => rand() * TWO_PI)
    // presence along the wind: stretches of 15 to 50 m with soft ends
    const ea = [1, 0.8, 0.6, 0.45, 0.3, 0.25].map((a) => a * (0.4 + rand()))
    const ep = ea.map(() => rand() * TWO_PI)
    const en = Math.sqrt(ea.reduce((q, a) => q + 0.5 * a * a, 0))
    // its width swells and thins along the way
    const sp = [rand() * TWO_PI, rand() * TWO_PI]
    for (let iu = 0; iu < W; iu++) {
      const u = (iu + 0.5) / W
      let v = v0
      for (let m = 0; m < wa.length; m++) v += wa[m] * Math.sin(TWO_PI * (m + 1) * u + wp[m])
      let e = 0
      for (let m = 0; m < ea.length; m++) e += ea[m] * Math.sin(TWO_PI * (m + 1) * u + ep[m])
      const amp = strength * smooth01(-0.5, 0.35, e / en)
      if (amp <= 0.01) continue
      const sigma = sigma0 * (1 + 0.3 * Math.sin(TWO_PI * 3 * u + sp[0]) + 0.25 * Math.sin(TWO_PI * 7 * u + sp[1]))
      const centre = v * H
      const reach = Math.ceil(4 * sigma)
      const c0 = Math.floor(centre)
      for (let d = -reach; d <= reach; d++) {
        const iv = c0 + d
        const dv = (iv + 0.5 - centre) / sigma
        const k = (((iv % H) + H) % H) * W + iu
        const a = amp * Math.exp(-0.5 * dv * dv)
        if (a > value[k]) value[k] = a
      }
    }
  }
  for (let iv = 0; iv < H; iv++) {
    for (let iu = 0; iu < W; iu++) {
      const k = iv * W + iu
      const j = k * 4
      out[j] = Math.round(255 * Math.min(1, value[k]))
      // the lane noise is W x W: odd rows of the texture lie between two of its rows
      const r0 = (iv >> 1) * W + iu
      const r1 = (((iv + 1) >> 1) % W) * W + iu
      out[j + 1] = Math.round(255 * 0.5 * (lanes[r0] + lanes[r1]))
      out[j + 2] = 0
      out[j + 3] = 255
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// swell: a frozen patch of the physics sea
// ---------------------------------------------------------------------------------------

/** slopes are stored as 0.5 + 0.5 * slope / SWELL_SLOPE_MAX; crest as (crest + 1.5) / 4 */
export const SWELL_SLOPE_MAX = 0.8
/** the swell tile is this many peak wavelengths long */
export const SWELL_TILE_WAVES = 8

/** K and S are the field's crest-sharpening and forward-lean coefficients (WaveField.K, WaveField.S). */
export function makeSwellData(size: number, p: WaveParams, K: number, S: number, seed: number): Uint8Array {
  const rand = mulberry32(seed)
  const fp = 1 / p.tp
  const kp = ((2 * Math.PI * fp) ** 2) / G
  const tile = (SWELL_TILE_WAVES * 2 * Math.PI) / kp
  const dk = (2 * Math.PI) / tile
  const dir0 = (p.dirDeg * Math.PI) / 180
  const spread = Math.max(0.03, (p.spreadDeg * Math.PI) / 180)
  const zr = new Float64Array(size * size), zi = new Float64Array(size * size)
  const xr = new Float64Array(size * size), xi = new Float64Array(size * size)
  const yr = new Float64Array(size * size), yi = new Float64Array(size * size)
  const mMax = Math.min(size / 4, Math.ceil(SWELL_TILE_WAVES * p.fMaxRel * p.fMaxRel * 1.2))
  const nMax = Math.min(size / 4, Math.ceil(mMax * 0.8))
  let m0 = 0
  const amp = new Float64Array((mMax + 1) * (2 * nMax + 1))
  for (let m = 1; m <= mMax; m++) {
    for (let n = -nMax; n <= nMax; n++) {
      const kx = m * dk, kz = n * dk
      const k = Math.hypot(kx, kz)
      const f = Math.sqrt(G * k) / (2 * Math.PI)
      const rel = f / fp
      if (rel < p.fMinRel * 0.97 || rel > p.fMaxRel * 1.03) continue
      const sigma = f <= fp ? 0.07 : 0.09
      const peak = Math.pow(p.gamma, Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp)))
      const S = Math.pow(f, -5) * Math.exp(-1.25 * Math.pow(fp / f, 4)) * peak
      const th = Math.atan2(kz, kx) - dir0
      const sg = spread * Math.sqrt(rel)
      const D = Math.exp(-(th * th) / (2 * sg * sg)) / sg
      // S(f) D(th) df dth -> per (kx, kz) cell: df/dk / k
      const a2 = S * D * (0.5 * Math.sqrt(G / k) / (2 * Math.PI)) / k
      amp[m * (2 * nMax + 1) + n + nMax] = Math.sqrt(a2)
      m0 += 0.5 * a2
    }
  }
  const scale = p.hs / (4 * Math.sqrt(m0 || 1))
  for (let m = 1; m <= mMax; m++) {
    for (let n = -nMax; n <= nMax; n++) {
      const a = amp[m * (2 * nMax + 1) + n + nMax] * scale
      if (!(a > 0)) continue
      // Rayleigh amplitudes, uniform phases: a Gaussian sea with natural groups
      const gr = a * gaussian(rand) * Math.SQRT1_2
      const gi = a * gaussian(rand) * Math.SQRT1_2
      const i = ((n + size) % size) * size + m
      const kx = m * dk, kz = n * dk
      zr[i] = gr; zi[i] = gi
      // d/dx: multiply by i kx
      xr[i] = -gi * kx; xi[i] = gr * kx
      yr[i] = -gi * kz; yi[i] = gr * kz
    }
  }
  ifft2d(zr, zi, size)
  ifft2d(xr, xi, size)
  ifft2d(yr, yi, size)
  const norm = Math.max(0.05, 0.5 * p.hs)
  const out = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    // analytic signal: real part = linear sea, imaginary part = its quadrature partner.
    // A one-sided spectrum gives amplitude a per component, as in the physics.
    const s1 = zr[i], sh = zi[i]
    const gx = xr[i] + 2 * K * (s1 * xr[i] - sh * xi[i]) + 2 * S * (xr[i] * sh + s1 * xi[i])
    const gz = yr[i] + 2 * K * (s1 * yr[i] - sh * yi[i]) + 2 * S * (yr[i] * sh + s1 * yi[i])
    const j = i * 4
    out[j] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.5 * gx / SWELL_SLOPE_MAX)))
    out[j + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.5 * gz / SWELL_SLOPE_MAX)))
    out[j + 2] = Math.round(255 * Math.min(1, Math.max(0, (s1 / norm + 1.5) / 4)))
    out[j + 3] = 255
  }
  return out
}

// ---------------------------------------------------------------------------------------
// shore: depth, the bank and the size of the bumps, from the level
// ---------------------------------------------------------------------------------------

/**
 * The grid and the bank indicator are the terrain module's own (src/render/terrain/field.ts):
 * clamp((SHORE_DEPTH - depth) / SHORE_DEPTH, -1, 1) on its 15 m shore grid, blurred with a
 * 1-4-6-4-1 kernel. Its zero line is where the land mesh comes out of the water, so the foam
 * line drawn from it sits on the visible waterline; the land's bed then shelves to BED_DEPTH
 * metres where the indicator reaches -BED_REACH.
 */
export const SHORE_STEP = SHORE_GRID_STEP
export { BED_DEPTH, BED_REACH }
/** R = sqrt(depth / SHORE_DEPTH_MAX), G = 0.5 + 0.5 * bank, B = depth / SHORE_DEEP_MAX, A = wave size */
export const SHORE_DEPTH_MAX = 8
export const SHORE_DEEP_MAX = 24
/**
 * The level's depths are chart depth areas: flat shelves with straight 30 to 60 m edges.
 * What is drawn is a smoothed bed, with the smoothing done on exp(-depth * SEEN_RATE) (how
 * much of the sand shows) rather than on the depth: a shelf keeps its own depth, its outline
 * is rounded and it shelves off softly on the deep side, and the result is never deeper than
 * the plain average, so foil-strike water never looks deeper than it is.
 */
const SEEN_RATE = 0.5
const SEEN_BLUR_PASSES = 2
const DEEP_BLUR_PASSES = 3

export interface ShoreData {
  data: Uint8Array
  width: number
  height: number
  /** ground coordinates of texel (0, 0)'s centre */
  x0: number
  z0: number
  step: number
}

function blur14641(data: Float32Array, nx: number, nz: number, passes: number): void {
  const tmp = new Float32Array(data.length)
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < nz; j++) {
      const row = j * nx
      for (let i = 0; i < nx; i++) {
        const a = data[row + Math.max(0, i - 2)], b = data[row + Math.max(0, i - 1)]
        const c = data[row + i]
        const d = data[row + Math.min(nx - 1, i + 1)], e = data[row + Math.min(nx - 1, i + 2)]
        tmp[row + i] = (a + e + 4 * (b + d) + 6 * c) * 0.0625
      }
    }
    for (let j = 0; j < nz; j++) {
      const j0 = Math.max(0, j - 2) * nx, j1 = Math.max(0, j - 1) * nx
      const j2 = j * nx
      const j3 = Math.min(nz - 1, j + 1) * nx, j4 = Math.min(nz - 1, j + 2) * nx
      for (let i = 0; i < nx; i++) {
        data[j2 + i] = (tmp[j0 + i] + tmp[j4 + i] + 4 * (tmp[j1 + i] + tmp[j3 + i]) + 6 * tmp[j2 + i]) * 0.0625
      }
    }
  }
}

export function makeShoreData(): ShoreData {
  const g = LEVEL.coarse
  const step = SHORE_STEP
  const width = Math.round(((g.nx - 1) * g.step) / step) + 1
  const height = Math.round(((g.nz - 1) * g.step) / step) + 1
  const n = width * height
  const depth = new Float32Array(n)
  const seen = new Float32Array(n)
  const bank = new Float32Array(n)
  const env = new Float32Array(n)
  for (let j = 0; j < height; j++) {
    const z = g.z0 + j * step
    for (let i = 0; i < width; i++) {
      const x = g.x0 + i * step
      const k = j * width + i
      const d = LEVEL.waterDepth(x, z)
      depth[k] = d
      seen[k] = Math.exp(-d * SEEN_RATE)
      bank[k] = Math.min(1, Math.max(-1, (SHORE_DEPTH - d) / SHORE_DEPTH))
      env[k] = LEVEL.waveScale(x, z)
    }
  }
  blur14641(bank, width, height, SHORE_BLUR_PASSES)
  blur14641(seen, width, height, SEEN_BLUR_PASSES)
  blur14641(depth, width, height, DEEP_BLUR_PASSES)
  const data = new Uint8Array(n * 4)
  for (let k = 0; k < n; k++) {
    const j = k * 4
    const shown = -Math.log(Math.max(seen[k], 1e-6)) / SEEN_RATE
    data[j] = Math.round(255 * Math.sqrt(Math.min(1, shown / SHORE_DEPTH_MAX)))
    data[j + 1] = Math.round(255 * (0.5 + 0.5 * bank[k]))
    data[j + 2] = Math.round(255 * Math.min(1, depth[k] / SHORE_DEEP_MAX))
    data[j + 3] = Math.round(255 * Math.min(1, Math.max(0, env[k])))
  }
  return { data, width, height, x0: g.x0, z0: g.z0, step }
}

// ---------------------------------------------------------------------------------------
// THREE wrappers
// ---------------------------------------------------------------------------------------

function dataTexture(data: Uint8Array, w: number, h: number, repeat: boolean, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = anisotropy
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

export function makeDetailTexture(size: number, seed: number, anisotropy: number): THREE.DataTexture {
  return dataTexture(makeDetailData(size, seed), size, size, true, anisotropy)
}

export function makeStreakTexture(seed: number, anisotropy: number): THREE.DataTexture {
  return dataTexture(makeStreakData(seed), STREAK_W, STREAK_H, true, anisotropy)
}

export function makeSwellTexture(size: number, p: WaveParams, K: number, S: number, seed: number, anisotropy: number): THREE.DataTexture {
  return dataTexture(makeSwellData(size, p, K, S, seed), size, size, true, anisotropy)
}

export function makeShoreTexture(): { texture: THREE.DataTexture; info: ShoreData } {
  const info = makeShoreData()
  return { texture: dataTexture(info.data, info.width, info.height, false, 1), info }
}
