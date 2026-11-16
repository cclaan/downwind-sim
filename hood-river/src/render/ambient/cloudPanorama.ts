/**
 * The cloudscape of a windy July afternoon at the Hatchery, painted once at load into a
 * panorama texture that the sky shader thresholds (see sky.ts):
 *
 *   - a grey-white marine cloud bank filling the western notch: a level layer, solid to four
 *     or five degrees up and gone by ten, with a few heads of cloud standing out of it over
 *     the ridges either side of the notch (never in the notch itself);
 *   - broken stratocumulus streaming east out of the bank;
 *   - fair-weather cumulus coming up from behind the ridge lines all round (most over the
 *     Cascades to the south-west, few and small over the dry east), their bases at or below
 *     the skyline so the rim cuts them off, and a few thin streaks higher up;
 *   - clear blue overhead and downwind.
 *
 * Layout. u is the "diamond" bearing (no trigonometry in the shader), v the sine of the
 * elevation squeezed toward the horizon, where the clouds are and where the camera looks:
 *     t = d.z / (|d.x| + |d.z|),  u = (d.x >= 0 ? t : 2 - t) / 4 + 1/4
 *     v = h (1 + K) / (h + K),    h = max(d.y, 0),  K = PANO_K
 * Channels: R = density, a cloud is where it exceeds 0.5 (stored smooth across the edge,
 * and falling smoothly to nothing outside every cloud, so the threshold stays crisp however
 * far the texture is magnified and wherever the cloud-cover knob puts it); G = brightness,
 * from the cloud's relief lit by the 5 pm sun (front-lit white with shaded bases downwind,
 * bright thin edges and grey cores toward the sun); B = softness (distant cloud has a
 * wider, hazier edge); A = 255.
 *
 * The bank and the deck are noise thresholded at the rank that gives each about the mean
 * cover of atmosphere.ts's cloudCoverParts() in every direction, which is also what the
 * water's reflection uses; the cumulus are placed by hand to about the cover that function
 * gives them.
 */
import type { Atmosphere } from '../atmosphere'
import { cloudCoverParts } from '../atmosphere'
import { mulberry32 } from '../../sim/rng'
import { makeEqualiser, ValueNoise3 } from './noise'

export const PANO_K = 0.35

const DEG = Math.PI / 180

/**
 * Bare-ground skyline seen from the river off the Hatchery, degrees above the horizon, every
 * 10 degrees of bearing from -180 (bearing 0 = +x downwind, positive toward +z, Oregon).
 * From the place research's horizon profile (USGS 10 m elevation data).
 */
const SKYLINE = [
  2.3, 1.6, 3.6, 7.1, 9.9, 11.4, 12.7, 12.8, 12.2, 11.5, 10.4, 8.4, 7.4, 6.6, 4.9, 4.8, 3.5, 3.4,
  4.1, 3.5, 2.4, 1.0, 2.9, 3.4, 3.8, 4.5, 5.0, 4.9, 5.0, 5.2, 5.3, 4.7, 4.4, 4.7, 4.9, 4.4,
]

/** skyline elevation (radians) at a bearing (radians) */
function skyline(phi: number): number {
  let f = (phi / DEG + 180) / 10
  f = ((f % 36) + 36) % 36
  const i = Math.floor(f)
  const t = f - i
  return (SKYLINE[i] * (1 - t) + SKYLINE[(i + 1) % 36] * t) * DEG
}

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface CloudPanorama {
  data: Uint8Array
  width: number
  height: number
  /** generation time (ms) */
  ms: number
}

/**
 * @param bakeDetail  also paint the fine lumps the sky shader otherwise adds from its detail
 *                    tile (the low tier has no detail fetch): 0 = no, 1 = the shader's amount
 */
export function generateCloudPanorama(width: number, height: number, atmos: Atmosphere, bakeDetail = 0, seed = 20230720): CloudPanorama {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  const W = width, H = height
  const K = PANO_K
  const rand = mulberry32(seed)
  const n1 = new ValueNoise3(seed + 1, 32)
  const n2 = new ValueNoise3(seed + 2, 32)
  const n3 = new ValueNoise3(seed + 3, 32)

  // per-column bearing, per-row elevation
  const cx = new Float32Array(W), cz = new Float32Array(W), phi = new Float32Array(W)
  for (let i = 0; i < W; i++) {
    const ur = ((i + 0.5) / W) * 4 - 1
    let x: number, z: number
    if (ur <= 1) { z = ur; x = 1 - Math.abs(ur) } else { z = 2 - ur; x = -(1 - Math.abs(z)) }
    const l = Math.hypot(x, z)
    cx[i] = x / l; cz[i] = z / l
    phi[i] = Math.atan2(cz[i], cx[i])
  }
  const hh = new Float32Array(H), ce = new Float32Array(H), el = new Float32Array(H)
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H
    const h = Math.min(0.9999, (K * v) / (1 + K - v))
    hh[j] = h
    ce[j] = Math.sqrt(1 - h * h)
    el[j] = Math.asin(h)
  }
  const colOf = (p: number): number => {
    const x = Math.cos(p), z = Math.sin(p)
    const t = z / (Math.abs(x) + Math.abs(z))
    return ((x >= 0 ? t : 2 - t) * 0.25 + 0.25) * W - 0.5
  }
  const rowOf = (e: number): number => {
    const h = Math.sin(Math.max(e, 0))
    return ((h * (1 + K)) / (h + K)) * H - 0.5
  }

  const D = new Float32Array(W * H) // density, cloud where > 0.5
  const R = new Float32Array(W * H) // relief (radians of bulge toward the viewer) for shading
  const T = new Float32Array(W * H) // thickness 0 (edge) .. 1 (core)
  const S = new Float32Array(W * H) // softness 0..1
  const deckAt = new Uint8Array(W * H) // 1 where the cloud is the deck (its edges get more lumps than the rest)

  // -------------------------------------------------------------------------------------
  // A. the marine bank and the deck streaming out of it: thresholded noise with about the
  //    mean cover of cloudCoverParts()
  // -------------------------------------------------------------------------------------
  const parts = { bank: 0, deck: 0, cumulus: 0 }
  const bx = atmos.bankDir.x, bz = atmos.bankDir.z
  const coverB = new Float32Array(W * H)
  const coverD = new Float32Array(W * H)
  const rawB = new Float32Array(W * H)
  const rawD = new Float32Array(W * H)
  const sampB = new Float32Array(W * H >> 1)
  const sampD = new Float32Array(W * H >> 1)
  let nb = 0, nd = 0
  for (let j = 0; j < H; j++) {
    const h = hh[j], c = ce[j]
    if (h > 0.75) break
    for (let i = 0; i < W; i++) {
      const dx = cx[i] * c, dz = cz[i] * c
      if (0.5 + 0.5 * (dx * bx + dz * bz) < 0.4) continue
      cloudCoverParts(dx, h, dz, atmos.bankDir, 1, parts)
      const p = j * W + i
      if (parts.bank > 0.02) {
        // a layer seen edge on: bands about 5 degrees long and a degree deep (the noise is
        // five times finer in elevation than along the bearing), so its top is level
        const v = n1.fbm(dx * 12 + 3.1, h * 60 + 1.7, dz * 12 + 5.3, 4)
        coverB[p] = parts.bank
        rawB[p] = v
        if ((i & 1) === 0 && nb < sampB.length) sampB[nb++] = v
      }
      if (parts.deck > 0.02) {
        // a layer seen in perspective, drawn out along the wind
        const q = 1 / (h + 0.12)
        // (billowed: the fine octaves are folded so the layer breaks into rounded cells)
        const X = dx * q * 1.3 + 11.3, Z = dz * q * 2.4 + 7.9
        const v = 0.75 * n2.fbm(X, 0.37, Z, 3, 2, 0.55) + 0.42 * Math.abs(n3.fbm(X * 3.3, 0.71, Z * 3.3, 2, 2, 0.5) - 0.5)
        coverD[p] = parts.deck
        rawD[p] = v
        if ((i & 1) === 0 && nd < sampD.length) sampD[nd++] = v
      }
    }
  }
  const eqB = makeEqualiser(sampB, Math.max(nb, 2))
  const eqD = makeEqualiser(sampD, Math.max(nd, 2))
  for (let j = 0; j < H; j++) {
    const h = hh[j]
    if (h > 0.75) break
    for (let i = 0; i < W; i++) {
      const p = j * W + i
      let d = 0, r = 0, s = 0, th = 0
      if (coverB[p] > 0) {
        // where the bank is meant to be whole it is whole (no rank is left below the
        // threshold); it thins to nothing through its top few degrees
        const m = eqB(rawB[p]) - (1 - coverB[p]) + 0.3 * Math.max(0, coverB[p] - 0.7) / 0.3
        d = 0.5 + m * 2.4
        th = Math.max(0, m) * 1.6
        r = Math.sqrt(Math.max(0, Math.min(m, 0.5))) * 0.05
        // the bank is tens of kilometres off: soft and hazy low down, firmer on top
        s = Math.max(0.4, 0.9 - 3.0 * h)
      }
      if (coverD[p] > 0) {
        const m = eqD(rawD[p]) - (1 - coverD[p])
        // (not soft: this cloud is overhead and near, and the cumulus beside it is crisp)
        const dd = 0.5 + m * 2.2
        if (dd > d) {
          d = dd
          th = Math.max(0, m) * 2.0
          r = Math.sqrt(Math.max(0, m)) * 0.045
          s = Math.max(0.16, 0.38 - 0.45 * h)
          deckAt[p] = 1
        }
      }
      if (d <= 0) continue
      D[p] = Math.min(1, d)
      R[p] = r
      T[p] = Math.min(1, th)
      S[p] = Math.min(1, Math.max(0.12, s))
    }
  }

  // -------------------------------------------------------------------------------------
  // B. cumulus: heaps of puffs that melt into each other, on a flat base, billowed by noise
  // -------------------------------------------------------------------------------------
  const MAXP = 40
  const px = new Float32Array(MAXP), py = new Float32Array(MAXP), pr = new Float32Array(MAXP)
  /** a cumulus `wide` across and `tall` high on a flat base at elevation `base`, centred on bearing p0 */
  const cumulus = (p0: number, base: number, wide: number, tall: number, soft: number) => {
    let n = Math.min(MAXP - 3, Math.round(5 + (wide / tall) * 3.2))
    for (let k = 0; k < n; k++) {
      const x = (rand() + rand() - 1) * 0.5 * wide
      const bell = Math.max(0, 1 - (2 * x / wide) ** 2)
      const r = tall * (0.36 + 0.42 * bell) * (0.75 + 0.5 * rand())
      px[k] = x
      py[k] = r * (0.35 + 0.5 * rand() * bell)
      pr[k] = r
    }
    // one to three heads on top
    const heads = 1 + Math.floor(rand() * 3)
    for (let k = 0; k < heads; k++) {
      px[n] = (rand() - 0.5) * 0.45 * wide
      pr[n] = tall * (0.3 + 0.2 * rand())
      py[n] = tall * (0.55 + 0.3 * rand())
      n++
    }
    const ox = rand() * 31, oz = rand() * 31
    const fWarp = 2.2 / wide, fBil = 3.4 / tall
    const warp = 0.16 * tall
    const j0 = Math.max(0, Math.floor(rowOf(base - 0.5 * DEG))), j1 = Math.min(H - 1, Math.ceil(rowOf(base + tall * 1.7)))
    for (let j = j0; j <= j1; j++) {
      const c = ce[j], h = hh[j]
      const y = el[j] - base
      const baseT = y / (0.16 * DEG + tall * 0.035)
      if (baseT <= -1) continue
      const baseD = 0.5 + 0.5 * baseT
      const baseR = sstep(0, tall * 0.45, y)
      const half = (wide * 0.82) / Math.max(0.2, c)
      const i0 = Math.floor(colOf(p0 - half))
      let i1 = Math.ceil(colOf(p0 + half))
      if (i1 < i0) i1 += W
      for (let ii = i0; ii <= i1; ii++) {
        const i = ((ii % W) + W) % W
        let dp = phi[i] - p0
        if (dp > Math.PI) dp -= 2 * Math.PI
        else if (dp < -Math.PI) dp += 2 * Math.PI
        const dx = cx[i] * c, dz = cz[i] * c
        // bend the outline so it is not a row of circles
        const X = dp * c + (n3.sample(dx * fWarp + ox, h * fWarp + 3.3, dz * fWarp + oz) - 0.5) * 2 * warp
        const Y = y + (n3.sample(dx * fWarp + ox + 17.7, h * fWarp + 9.1, dz * fWarp + oz) - 0.5) * 1.2 * warp
        let f = 0
        for (let k = 0; k < n; k++) {
          const ex = X - px[k], ey = Y - py[k]
          const q = 1 - (ex * ex + ey * ey) / (pr[k] * pr[k])
          if (q > 0) f += q * q
        }
        if (f <= 0) continue
        // billows: noise carves the surface, most at the edge
        const bil = n2.fbm(dx * fBil + ox, h * fBil + 5.5, dz * fBil + oz, 4, 2, 0.56) - 0.5
        const fq = Math.min(f, 1.15) * 0.8 - 0.22 + bil * 1.25 * (0.45 + 0.55 * Math.min(1, 2.5 * f))
        let d = 0.5 + Math.max(-0.5, Math.min(0.5, fq * 1.5))
        if (baseD < d) d = baseD
        // down to nothing at the rim of the heap, so a low threshold never lands on a cliff
        d *= sstep(0, 0.2, f)
        const p = j * W + i
        if (d > D[p]) {
          D[p] = d
          S[p] = soft
          if (fq > 0) {
            R[p] = Math.sqrt(Math.min(fq, 1)) * tall * 0.8 * (0.3 + 0.7 * baseR)
            T[p] = Math.min(1, fq * 1.6)
          }
        }
      }
    }
  }
  /**
   * A thin streak of high cloud: `long` by `thick` (radians), centred at bearing p0 and
   * elevation e0, lying at `tilt` to the horizon; frayed along its length, thin and bright.
   */
  const streak = (p0: number, e0: number, long: number, thick: number, tilt: number) => {
    const ct = Math.cos(tilt), st = Math.sin(tilt)
    const ox = rand() * 29, oz = rand() * 29
    const reach = long * 0.62 + thick * 3
    const j0 = Math.max(0, Math.floor(rowOf(e0 - reach))), j1 = Math.min(H - 1, Math.ceil(rowOf(e0 + reach)))
    for (let j = j0; j <= j1; j++) {
      const c = ce[j], h = hh[j]
      const y = el[j] - e0
      const half = reach / Math.max(0.2, c)
      const i0 = Math.floor(colOf(p0 - half))
      let i1 = Math.ceil(colOf(p0 + half))
      if (i1 < i0) i1 += W
      for (let ii = i0; ii <= i1; ii++) {
        const i = ((ii % W) + W) % W
        let dp = phi[i] - p0
        if (dp > Math.PI) dp -= 2 * Math.PI
        else if (dp < -Math.PI) dp += 2 * Math.PI
        const dx = cx[i] * c, dz = cz[i] * c
        const a = dp * c * ct + y * st, b = -dp * c * st + y * ct
        // the streak wanders and breaks up along its length
        const wander = (n3.sample(dx * 9 + ox, h * 9 + 2.1, dz * 9 + oz) - 0.5) * thick * 2.2
        const u = (2 * a) / long, v = (b - wander) / thick
        const env = 1 - u * u - v * v
        if (env <= -0.6) continue
        const fray = n2.fbm(dx * 26 + ox, h * 80 + 4.4, dz * 26 + oz, 3, 2, 0.55) - 0.5
        const m = env * 0.6 - 0.1 + fray * 0.75
        const d = (0.5 + Math.max(-0.5, Math.min(0.5, m * 1.6))) * sstep(-0.6, -0.1, env)
        const p = j * W + i
        if (d > D[p]) {
          D[p] = d
          S[p] = 0.42
          R[p] = 0
          T[p] = Math.min(0.35, Math.max(0, m))
        }
      }
    }
  }

  // walk round the horizon; how close together and how big depends on what is under them.
  // Bases sit at or below the skyline, so the rim hides the foot of most of them and cuts
  // some down to a top showing over the trees.
  const bankPhi = Math.atan2(bz, bx)
  let p = -Math.PI + rand() * 6 * DEG
  while (p < Math.PI) {
    const deg = p / DEG
    const toBank = Math.acos(Math.max(-1, Math.min(1, Math.cos(p) * bx + Math.sin(p) * bz))) / DEG
    let step: number, wide: number, lift: number, soft: number, aspect: number
    // one in three is small, the odd one big: nothing like a row of the same cloud
    const size = rand()
    const scale = size < 0.34 ? 0.45 + 0.35 * rand() : size > 0.86 ? 1.5 + 0.5 * rand() : 0.85 + 0.45 * rand()
    if (toBank < 36) {
      // the bank owns the notch
      p += (10 + 8 * rand()) * DEG
      continue
    } else if (Math.abs(deg) < 42) {
      // dry east: few, small, flat, far
      step = 16 + 22 * rand(); wide = (1.6 + 2.6 * rand()) * scale; lift = -0.6 + 1.6 * rand(); soft = 0.5; aspect = 0.26 + 0.1 * rand()
    } else if (deg > 0) {
      // Oregon side and the Cascades to the south-west: the most cloud
      step = 11 + 15 * rand(); wide = (4.5 + 5.5 * rand()) * scale; lift = -1.5 + 3.0 * rand(); soft = 0.3; aspect = 0.32 + 0.2 * rand()
    } else {
      // over the Washington rim
      step = 14 + 17 * rand(); wide = (4.5 + 5.5 * rand()) * scale; lift = -1.5 + 3.0 * rand(); soft = 0.26; aspect = 0.32 + 0.2 * rand()
    }
    const base = Math.max(0.2 * DEG, skyline(p) + lift * DEG)
    cumulus(p, base, wide * DEG, wide * DEG * aspect, soft)
    // sometimes a scrap of cloud beside it
    if (rand() < 0.4) {
      const w2 = wide * (0.25 + 0.2 * rand())
      cumulus(p + (wide * 0.5 + w2 * 0.6 + 0.6 * rand()) * DEG, base + (0.2 + 1.4 * rand()) * DEG, w2 * DEG, w2 * DEG * 0.4, soft + 0.1)
    }
    p += Math.max(step, wide * 1.3) * DEG
  }
  // a second, higher and nearer row to the south-west and north-west, so there is cloud in
  // frame when the camera looks up
  const high: [number, number, number][] = [[128, 17, 13], [72, 22, 10], [-118, 24, 14], [-62, 19, 9], [162, 14, 11], [18, 15, 6]]
  for (const [deg, elev, wide] of high) {
    cumulus((deg + 8 * (rand() - 0.5)) * DEG, (elev + 2 * rand()) * DEG, wide * DEG, wide * DEG * 0.4, 0.2)
  }
  // thin streaks of high cloud, most toward the south (the owner's still has one over the Oregon rim)
  const streaks: [number, number, number, number][] = [[58, 15, 15, 1.1], [96, 19, 20, 1.3], [137, 12, 12, 0.9], [-36, 21, 17, 1.2], [-98, 30, 22, 1.5], [24, 27, 13, 1.0], [-150, 21, 11, 0.9]]
  for (const [deg, elev, long, thick] of streaks) {
    streak((deg + 10 * (rand() - 0.5)) * DEG, (elev + 3 * (rand() - 0.5)) * DEG, long * DEG, thick * DEG, (rand() - 0.5) * 0.24)
  }
  // heads of cloud standing up out of the bank over the ridges either side of the notch;
  // none in the notch itself, where the bank is a level layer
  for (let k = 0; k < 8; k++) {
    const side = k & 1 ? 1 : -1
    const off = side * (17 + 40 * rand())
    const top = 4.5 + 3.5 * rand() + 2.0 * Math.exp(-(((Math.abs(off) - 30) / 14) ** 2))
    const wide = 6 + 8 * rand()
    const tall = wide * (0.28 + 0.1 * rand())
    cumulus(bankPhi + off * DEG, Math.max(0.1, top - tall * 0.8) * DEG, wide * DEG, tall * DEG, 0.45)
  }

  // -------------------------------------------------------------------------------------
  // C. ragged edges, and (low tier) the fine lumps the shader would add from its detail tile
  // -------------------------------------------------------------------------------------
  for (let j = 0; j < H; j++) {
    const h = hh[j], c = ce[j]
    for (let i = 0; i < W; i++) {
      const q = j * W + i
      let d = D[q]
      if (d < 0.06) continue
      if (bakeDetail > 0) {
        const g = n1.fbm(cx[i] * c * 21 + 6.1, h * 21 + 2.3, cz[i] * c * 21 + 8.7, 2) - 0.5
        d += g * 0.62 * bakeDetail * sstep(0.06, 0.3, d)
      }
      if (deckAt[q]) {
        // the deck is smooth noise: its edges need lumps a degree across to read as cloud,
        // and its top a little relief for the light to catch
        const v = n3.fbm(cx[i] * c * 40 + 2.2, h * 64 + 9.1, cz[i] * c * 40 + 4.4, 3) - 0.5
        if (d <= 0.9) d += v * 0.85
        R[q] += v * 0.03
      } else if (d >= 0.2 && d <= 0.85) {
        const v = n3.fbm(cx[i] * c * 52 + 2.2, h * 52 + 9.1, cz[i] * c * 52 + 4.4, 2) - 0.5
        d += v * 0.3 * (1 - S[q] * 0.5)
      }
      D[q] = d
    }
  }

  // -------------------------------------------------------------------------------------
  // D. light the relief with the 5 pm sun, write the texture
  // -------------------------------------------------------------------------------------
  const sun = atmos.sunDir
  const data = new Uint8Array(W * H * 4)
  for (let j = 0; j < H; j++) {
    const jm = Math.max(0, j - 1), jp = Math.min(H - 1, j + 1)
    const de = el[jp] - el[jm]
    const h = hh[j], c = ce[j]
    for (let i = 0; i < W; i++) {
      const q = j * W + i
      const o = q * 4
      const d = D[q]
      data[o] = Math.max(0, Math.min(255, Math.round(d * 255)))
      data[o + 2] = Math.round(S[q] * 255)
      data[o + 3] = 255
      if (d < 0.04) { data[o + 1] = 160; continue }
      const im = (i + W - 1) % W, ip = (i + 1) % W
      let dp = phi[ip] - phi[im]
      if (dp > Math.PI) dp -= 2 * Math.PI
      else if (dp < -Math.PI) dp += 2 * Math.PI
      const da = dp * c
      // relief gradient along the bearing (toward +phi) and up
      const ga = (R[j * W + ip] - R[j * W + im]) / da
      const ge = (R[jp * W + i] - R[jm * W + i]) / de
      const inv = 1 / Math.sqrt(ga * ga + ge * ge + 1)
      const nx = -ga * inv, ny = -ge * inv, nz = inv
      // the sun in the local frame: along the bearing, up, and toward the viewer
      const ta = -sun.x * cz[i] + sun.z * cx[i]
      const te = -h * (sun.x * cx[i] + sun.z * cz[i]) + c * sun.y
      const tv = -(sun.x * cx[i] * c + sun.y * h + sun.z * cz[i] * c)
      const lam = nx * ta + ny * te + nz * tv
      // front- and side-lit: white where the relief faces the sun, grey-blue where it turns away
      const front = Math.max(0, Math.min(1, 0.64 + 0.5 * lam))
      // toward the sun the light comes through: thin edges glow, the thick middle is grey
      const thin = (1 - T[q]) * (1 - T[q])
      const back = thin * 0.92 + (1 - thin) * (0.4 + 0.3 * Math.max(0, lam + 0.4))
      const wb = sstep(0.6, 0.93, 0.5 - 0.5 * tv)
      data[o + 1] = Math.max(0, Math.min(255, Math.round((front + (back - front) * wb) * 255)))
    }
  }
  const ms = typeof performance !== 'undefined' ? performance.now() - t0 : 0
  return { data, width: W, height: H, ms }
}
