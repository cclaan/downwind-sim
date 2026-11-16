/**
 * The river's wave field, in the frame of the moving water.
 *
 * One analytic function is used for everything: the physics samples it on the CPU and the
 * water shader evaluates the same sum on the GPU (see WAVE_GLSL), so the board always sits
 * on the surface the player sees.
 *
 * Model
 *   eta1  = sum a_i cos(th_i)            linear sea: directional components, deep water
 *   etaH  = sum a_i sin(th_i)            its quadrature (Hilbert) partner
 *   eta   = E*eta1 + K*E^2*(eta1^2 - etaH^2) + S*E^2*(2*eta1*etaH)
 *           K: narrow-band second-order (Tayfun) correction: peaks the crests and flattens
 *              the troughs of the *combined* sea, which per-component Stokes terms cannot do
 *           S: the same harmonic in quadrature: leans the bumps forward, so front faces are
 *              short and steep and backs long and flat, as wind against current makes them
 *   th_i  = k_i (d_i . x) - w_i t + ph_i,   w_i = sqrt(g k_i)
 *   E     = wave-size envelope, 0..1. With a level attached it is the level's map of where
 *           the bumps are big (the deep channel off the Hatchery where the current is
 *           strongest), which is fixed to the land and so slides through this frame with
 *           the current. Without one it is a simple band across the river.
 *
 * Water motion (what the foil actually feels) comes from the linear part, attenuated with
 * depth below the instantaneous surface (Wheeler stretching):
 *   u_h = sum E a_i w_i exp(-k_i depth) cos(th_i) d_i      forward on crests, back in troughs
 *   u_y = sum E a_i w_i exp(-k_i depth) sin(th_i)          rising on the face ahead of a crest
 * plus a correction to u_y that makes the drawn surface a material surface (at the surface
 * u_y = d(eta)/dt + u_h . grad(eta) exactly), so the water rises as fast as the sharpened,
 * forward-leaning faces the player sees: a rider at bump speed gets m*g times the slope on
 * screen. The correction belongs to the bound second harmonic and decays as exp(-2 kp depth).
 *
 * Axes: +x downwind (the way the swell travels, east), +y up, +z to the rider's right when
 * facing downwind (south, the Oregon bank). Units: metres, seconds, radians.
 */
import { gaussian, mulberry32 } from './rng'

export const G = 9.81

export interface WaveParams {
  seed: number
  /** significant wave height in the channel (m) */
  hs: number
  /** peak period (s) */
  tp: number
  /** JONSWAP peak enhancement: higher = more regular, corduroy-like lines */
  gamma: number
  /** number of components the physics and the vertex shader both use */
  count: number
  /** frequency band relative to the peak frequency */
  fMinRel: number
  fMaxRel: number
  /** directional spread (degrees, standard deviation at the peak) */
  spreadDeg: number
  /** mean travel direction (degrees from +x toward +z) */
  dirDeg: number
  /** crest sharpening multiplier (1 = physical second order) */
  sharpen: number
  /** forward lean of the bumps: 0 = symmetric, 1.5 = front faces about twice as steep as backs */
  skew: number
  /** centre of the big-wave band across the river (m) */
  channelZ: number
  /** half width of the band at full size (m) */
  channelHalfWidth: number
  /** distance over which waves fade to shoreScale (m) */
  channelFalloff: number
  /** wave size near the banks relative to the channel */
  shoreScale: number
  /** 1 = take the envelope from the level's map; 0 = use the simple band above */
  useLevel: number
}

/**
 * The Hatchery on a 25-knot afternoon. Where the current speeds up over the deep channel the
 * wind sea is squeezed shorter, steeper and slower: about 16 m between bumps, waist to
 * chest high, travelling near 5 m/s through the water, short-crested and peaky. Chop under
 * about 2.2 s is blocked by the current and breaks: whitecaps everywhere.
 * (With these numbers a look-ahead pilot rides for minutes on 15-30 pumps a minute; at
 * Hs 1.0 it has to pump almost continuously, at 1.5 it barely pumps at all.)
 */
export const DEFAULT_WAVES: WaveParams = {
  seed: 7,
  hs: 1.3,
  tp: 3.2,
  gamma: 3,
  count: 16,
  fMinRel: 0.78,
  fMaxRel: 1.45,
  spreadDeg: 17,
  dirDeg: 4,
  sharpen: 1.25,
  skew: 1.3,
  channelZ: 0,
  channelHalfWidth: 260,
  channelFalloff: 380,
  shoreScale: 0.22,
  useLevel: 1,
}

export interface WaveSample {
  /** surface height at (x, z) */
  eta: number
  /** surface gradient */
  dEdx: number
  dEdz: number
  /** rate of change of the surface height at a fixed (x, z) */
  etaDot: number
  /** depth of the query point below the surface (>= 0; 0 for surface queries) */
  depth: number
  /** water velocity at the query depth */
  ux: number
  uy: number
  uz: number
  /** linear elevation normalised by Hs/2: about +1 on a typical crest, -1 in a trough */
  crest: number
}

export function makeWaveSample(): WaveSample {
  return { eta: 0, dEdx: 0, dEdz: 0, etaDot: 0, depth: 0, ux: 0, uy: 0, uz: 0, crest: 0 }
}

/** maximum number of components the shader chunk is compiled for */
export const MAX_WAVE_COMPONENTS = 20

export class WaveField {
  params: WaveParams
  n = 0
  a = new Float64Array(MAX_WAVE_COMPONENTS)
  k = new Float64Array(MAX_WAVE_COMPONENTS)
  w = new Float64Array(MAX_WAVE_COMPONENTS)
  dx = new Float64Array(MAX_WAVE_COMPONENTS)
  dz = new Float64Array(MAX_WAVE_COMPONENTS)
  ph = new Float64Array(MAX_WAVE_COMPONENTS)
  /** peak wavenumber and phase speed */
  kp = 0
  cp = 0
  /** sharpening coefficient K = sharpen * kp / 2 */
  K = 0
  /** forward-lean coefficient S = skew * kp / 2 */
  S = 0
  /** bumped whenever the components change, so renderers know to re-upload */
  version = 0
  /** optional map of wave size fixed to the land (see level.ts) and the current it rides on */
  level: { waveScale(groundX: number, z: number): number; waterDepth?(groundX: number, z: number): number } | null = null
  current = 0
  /** keeps the land where it is when the current is changed mid-run (see setCurrent) */
  shift0 = 0

  constructor(params: WaveParams = DEFAULT_WAVES) {
    this.params = { ...params }
    this.rebuild()
  }

  /**
   * Change the wave parameters. With an anchor (where and when the rider is) every
   * component that survives keeps its phase there, so moving a slider reshapes the sea
   * around the rider instead of swapping it for a different one under the board.
   */
  set(params: Partial<WaveParams>, anchor?: { x: number; z: number; t: number }) {
    const old: number[] = []
    if (anchor) {
      for (let i = 0; i < this.n; i++) {
        old.push(this.k[i] * (this.dx[i] * anchor.x + this.dz[i] * anchor.z) - this.w[i] * anchor.t + this.ph[i])
      }
    }
    Object.assign(this.params, params)
    this.rebuild()
    if (anchor) {
      for (let i = 0; i < Math.min(this.n, old.length); i++) {
        this.ph[i] = old[i] - (this.k[i] * (this.dx[i] * anchor.x + this.dz[i] * anchor.z) - this.w[i] * anchor.t)
      }
    }
  }

  /** How far the land has slid through the water frame at time t: worldX = groundX + this. */
  groundShiftAt(t: number): number {
    return this.current * t + this.shift0
  }

  /** Change the river current at time t without moving the land under the rider. */
  setCurrent(current: number, t: number) {
    if (!Number.isFinite(current) || current === this.current) return
    this.shift0 += (this.current - current) * t
    this.current = current
  }

  rebuild() {
    const p = this.params
    const n = Math.max(1, Math.min(MAX_WAVE_COMPONENTS, Math.round(p.count) || 1))
    const rand = mulberry32(p.seed)
    const tp = Math.max(1, p.tp || 1)
    const fp = 1 / tp
    const gamma = Math.max(1, p.gamma || 1)
    // water cannot hold a sea steeper than about a tenth of its wavelength: a slider that
    // asks for more gets the steepest sea there is at that period
    const hs = Math.max(0, Math.min(p.hs || 0, 0.16 * tp * tp))
    const dir0 = (p.dirDeg * Math.PI) / 180
    const spread = (p.spreadDeg * Math.PI) / 180
    let m0 = 0
    for (let i = 0; i < n; i++) {
      // stratified, jittered frequencies; denser near the peak
      const u = (i + 0.15 + 0.7 * rand()) / n
      const rel = n === 1 ? 1 : p.fMinRel + (p.fMaxRel - p.fMinRel) * Math.pow(u, 1.35)
      const f = fp * rel
      const sigma = f <= fp ? 0.07 : 0.09
      const peak = Math.pow(gamma, Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp)))
      const S = Math.pow(f, -5) * Math.exp(-1.25 * Math.pow(fp / f, 4)) * peak
      // band width represented by this component
      const uLo = i / n
      const uHi = (i + 1) / n
      const df =
        n === 1
          ? 1
          : fp * (p.fMaxRel - p.fMinRel) * (Math.pow(uHi, 1.35) - Math.pow(uLo, 1.35))
      const amp = Math.sqrt(2 * S * df)
      const w = 2 * Math.PI * f
      const k = (w * w) / G
      // shorter waves spread wider
      const th = n === 1 ? dir0 : dir0 + spread * Math.sqrt(rel) * gaussian(rand)
      this.a[i] = amp
      this.k[i] = k
      this.w[i] = w
      this.dx[i] = Math.cos(th)
      this.dz[i] = Math.sin(th)
      this.ph[i] = rand() * Math.PI * 2
      m0 += 0.5 * amp * amp
    }
    // normalise to the requested significant height: Hs = 4 sqrt(m0)
    const scale = m0 > 0 ? hs / (4 * Math.sqrt(m0)) : 0
    for (let i = 0; i < n; i++) this.a[i] *= scale
    for (let i = n; i < MAX_WAVE_COMPONENTS; i++) this.a[i] = 0
    this.n = n
    const wp = 2 * Math.PI * fp
    this.kp = (wp * wp) / G
    this.cp = G / wp
    this.K = 0.5 * p.sharpen * this.kp
    this.S = 0.5 * p.skew * this.kp
    this.version++
  }

  /** Wave size at a point of the water frame at time t, 0..1. */
  envelope(x: number, z: number, t: number): number {
    const p = this.params
    if (this.level && p.useLevel > 0.5) return this.level.waveScale(x - this.groundShiftAt(t), z)
    const d = Math.abs(z - p.channelZ) - p.channelHalfWidth
    if (d <= 0) return 1
    const u = Math.min(1, d / Math.max(1, p.channelFalloff))
    const s = u * u * (3 - 2 * u)
    return 1 + (p.shoreScale - 1) * s
  }

  /**
   * Full sample. `y` is the height of the query point; water velocity is returned at that
   * depth below the local surface. Pass y = Infinity (or omit) for a surface query.
   */
  sample(x: number, z: number, t: number, y: number, out: WaveSample): WaveSample {
    const n = this.n
    const a = this.a, k = this.k, w = this.w, dx = this.dx, dz = this.dz, ph = this.ph
    const E = this.envelope(x, z, t)
    let s1 = 0, sh = 0
    let gx1 = 0, gz1 = 0, gxh = 0, gzh = 0
    let t1 = 0, tH = 0
    let ux0 = 0, uz0 = 0
    // first pass: surface
    for (let i = 0; i < n; i++) {
      const th = k[i] * (dx[i] * x + dz[i] * z) - w[i] * t + ph[i]
      const c = Math.cos(th)
      const s = Math.sin(th)
      const ai = a[i]
      const ak = ai * k[i]
      const aw = ai * w[i]
      s1 += ai * c
      sh += ai * s
      gx1 -= ak * dx[i] * s
      gz1 -= ak * dz[i] * s
      gxh += ak * dx[i] * c
      gzh += ak * dz[i] * c
      t1 += aw * s
      tH -= aw * c
      ux0 += aw * c * dx[i]
      uz0 += aw * c * dz[i]
      _c[i] = c
      _s[i] = s
    }
    const KE2 = this.K * E * E
    const SE2 = 2 * this.S * E * E
    const eta = E * s1 + KE2 * (s1 * s1 - sh * sh) + SE2 * s1 * sh
    out.eta = eta
    out.dEdx = E * gx1 + 2 * KE2 * (s1 * gx1 - sh * gxh) + SE2 * (gx1 * sh + s1 * gxh)
    out.dEdz = E * gz1 + 2 * KE2 * (s1 * gz1 - sh * gzh) + SE2 * (gz1 * sh + s1 * gzh)
    out.etaDot = E * t1 + 2 * KE2 * (s1 * t1 - sh * tH) + SE2 * (t1 * sh + s1 * tH)
    out.crest = (E * s1) / Math.max(0.05, 0.5 * this.params.hs)
    const depth = y === undefined || !(y < eta) ? 0 : eta - y
    out.depth = depth
    // second pass: water velocity at depth
    let ux = 0, uy = 0, uz = 0
    for (let i = 0; i < n; i++) {
      const amp = E * a[i] * w[i] * (depth > 0 ? Math.exp(-k[i] * depth) : 1)
      ux += amp * _c[i] * dx[i]
      uz += amp * _c[i] * dz[i]
      uy += amp * _s[i]
    }
    // the drawn surface is a material surface: what the linear sum leaves out (sharpening,
    // lean, and the horizontal flow carrying the slope along) is added to the vertical motion
    const uySurface = out.etaDot + E * (ux0 * out.dEdx + uz0 * out.dEdz)
    uy += (uySurface - E * t1) * (depth > 0 ? Math.exp(-2 * this.kp * depth) : 1)
    out.ux = ux
    out.uy = uy
    out.uz = uz
    return out
  }

  /** Surface height only (cheap path for effects and cameras). */
  height(x: number, z: number, t: number): number {
    const n = this.n
    const a = this.a, k = this.k, w = this.w, dx = this.dx, dz = this.dz, ph = this.ph
    const E = this.envelope(x, z, t)
    let s1 = 0, sh = 0
    for (let i = 0; i < n; i++) {
      const th = k[i] * (dx[i] * x + dz[i] * z) - w[i] * t + ph[i]
      s1 += a[i] * Math.cos(th)
      sh += a[i] * Math.sin(th)
    }
    return E * s1 + E * E * (this.K * (s1 * s1 - sh * sh) + 2 * this.S * s1 * sh)
  }

  /**
   * Per-component data for the shader: for each component (a, k*dx, k*dz, phase0) where
   * phase0 = k (d . origin) - w t + ph, wrapped to (-pi, pi] in double precision so the
   * shader only ever multiplies small local coordinates (no precision loss on phones).
   * `out` must hold 4 * MAX_WAVE_COMPONENTS floats.
   */
  fillUniforms(originX: number, originZ: number, t: number, out: Float32Array): Float32Array {
    const TWO_PI = Math.PI * 2
    for (let i = 0; i < MAX_WAVE_COMPONENTS; i++) {
      const j = i * 4
      if (i >= this.n) {
        out[j] = 0; out[j + 1] = 0; out[j + 2] = 0; out[j + 3] = 0
        continue
      }
      let p0 = this.k[i] * (this.dx[i] * originX + this.dz[i] * originZ) - this.w[i] * t + this.ph[i]
      p0 -= TWO_PI * Math.round(p0 / TWO_PI)
      out[j] = this.a[i]
      out[j + 1] = this.k[i] * this.dx[i]
      out[j + 2] = this.k[i] * this.dz[i]
      out[j + 3] = p0
    }
    return out
  }
}

const _c = new Float64Array(MAX_WAVE_COMPONENTS)
const _s = new Float64Array(MAX_WAVE_COMPONENTS)

/**
 * GLSL mirror of WaveField.sample (surface part). Include in a vertex or fragment shader.
 * Hosts should not set these uniforms by hand: use makeWaveUniforms / updateWaveUniforms
 * from src/render/waveUniforms.ts, which keep the CPU and GPU surfaces identical.
 *
 *   uWave[MAX_WAVE_COMPONENTS]  vec4(a, k*dx, k*dz, phase0)   from WaveField.fillUniforms
 *   uWaveCount                  int, components actually used
 *   uWaveK                      float, WaveField.K
 *   uWaveS                      float, WaveField.S
 *   uWaveCrestNorm              float, Hs / 2
 *   uWaveEnvMode                float, 1 = envelope from uWaveEnvTex, 0 = analytic band
 *   uWaveEnvTex                 the level's wave-size map (R8, linear, clamped)
 *   uWaveEnvRect                vec4(local x of the map's edge, local z of its edge, 1/width, 1/depth)
 *   uWaveEnv                    vec4(channelZ - originZ, channelHalfWidth, channelFalloff, shoreScale)
 *
 * waveSurface(p, lodCell): p is the position relative to the origin passed to
 * fillUniforms; returns vec4(eta, dEta/dx, dEta/dz, crest) where crest is the linear
 * elevation divided by Hs/2 (about +1 on a typical crest). lodCell is the local mesh cell
 * size in metres: components shorter than about 3 cells fade out so a coarse far mesh does
 * not alias (pass 0.0 for the exact physics surface).
 */
export const WAVE_GLSL = /* glsl */ `
#define MAX_WAVE_COMPONENTS ${MAX_WAVE_COMPONENTS}
uniform vec4 uWave[MAX_WAVE_COMPONENTS];
uniform int uWaveCount;
uniform float uWaveK;
uniform float uWaveS;
uniform vec4 uWaveEnv;
uniform float uWaveCrestNorm;
uniform float uWaveEnvMode;
uniform sampler2D uWaveEnvTex;
uniform vec4 uWaveEnvRect;

float waveEnvelope(vec2 p) {
  if (uWaveEnvMode > 0.5) {
    vec2 uv = (p - uWaveEnvRect.xy) * uWaveEnvRect.zw;
    return texture2D(uWaveEnvTex, clamp(uv, 0.0, 1.0)).r;
  }
  float d = abs(p.y - uWaveEnv.x) - uWaveEnv.y;
  float u = clamp(d / max(1.0, uWaveEnv.z), 0.0, 1.0);
  float s = u * u * (3.0 - 2.0 * u);
  return 1.0 + (uWaveEnv.w - 1.0) * s;
}

vec4 waveSurface(vec2 p, float lodCell) {
  float E = waveEnvelope(p);
  float s1 = 0.0, sh = 0.0;
  vec2 g1 = vec2(0.0), gh = vec2(0.0);
  for (int i = 0; i < MAX_WAVE_COMPONENTS; i++) {
    if (i >= uWaveCount) break;
    vec4 wv = uWave[i];
    float kLen = length(wv.yz);
    // fade components the local mesh cannot resolve (wavelength < ~3 cells)
    float fade = 1.0 - smoothstep(0.9, 2.1, kLen * lodCell);
    float th = dot(wv.yz, p) + wv.w;
    float c = cos(th), s = sin(th);
    float a = wv.x * fade;
    s1 += a * c;
    sh += a * s;
    g1 -= a * s * wv.yz;
    gh += a * c * wv.yz;
  }
  float KE2 = uWaveK * E * E;
  float SE2 = 2.0 * uWaveS * E * E;
  float eta = E * s1 + KE2 * (s1 * s1 - sh * sh) + SE2 * s1 * sh;
  vec2 grad = E * g1 + 2.0 * KE2 * (s1 * g1 - sh * gh) + SE2 * (g1 * sh + s1 * gh);
  return vec4(eta, grad, E * s1 / max(0.05, uWaveCrestNorm));
}
`
