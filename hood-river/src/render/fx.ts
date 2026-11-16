/**
 * Water effects around the rider: two draw calls, a few hundred instanced quads.
 *
 *   on the water (fx/decals.ts)
 *     - the wake: a thin foam line laid behind the mast where it cuts the surface, fixed in
 *       the water and fading over a few seconds; wide and white while the hull is wet;
 *     - the wash a wingtip leaves when it runs at the surface in a hard turn;
 *     - foam patches: splash rings, the bow wave's two arms, the paddle's puddles;
 *     - a soft dark blob under the board, so ride height reads at a glance.
 *   in the air (fx/spray.ts)
 *     - spray off the mast, growing with speed; a low fan off the high wingtip in hard turns
 *       and whenever the tip is out; sheets off the rails while the hull skims;
 *     - bursts on touchdown (as hard as the board came down), breach, crash and dropping off
 *       the foil; water shed at take-off;
 *     - the splash of the paddle blade's catch and the flick of its exit, and the small
 *       splash a carried blade leaves when it dabs the water in a carve.
 *
 * Spray is small bright drops for sparkle plus a few sheets for body: streaks of thrown
 * water, low and short-lived (the footage shows a streaky wash about a board length long,
 * not a cloud). That reads as thrown water with far fewer quads than drops alone.
 *
 * All of it is placed in the water frame (the frame a wake really stays in), so the picture
 * is right from any camera. Randomness is seeded. Counts scale with app.quality.particles.
 * `fxTuning` is read every frame.
 *
 * This module allocates nothing per frame, boxed numbers included (V8 boxes a number each
 * time it is written to a closure variable or handed to a function it has not inlined):
 * the state that changes every frame lives in one Float64Array, random numbers come from a
 * table, a new particle is written straight into the spray buffer, and the buffers read the
 * frame from that array instead of taking arguments (fx/frame.ts). What is left per frame
 * is inside two shared helpers it calls, riderMatrix and the wave uniforms' update.
 *
 * Other modules can ask for a splash: dispatch 'hr:rider-splash' on window with detail
 * { x, y, z, strength, kind } (world position on the water, strength 0..1). kind 'blade' is
 * a paddle blade touching the water (a small splash left behind); anything else is a body
 * going in (a burst). The rider module sends both.
 */
import * as THREE from 'three'
import type { App, FeatureModule, Quality } from '../app/types'
import { riderMatrix } from '../app/frames'
import { mulberry32 } from '../sim/rng'
import { EV } from '../sim/types'
import { SurfaceDecals } from './fx/decals'
import { F_DT, F_NOW, F_OX, F_OZ, F_PX, F_SLOTS, F_WIND_X, F_WIND_Z } from './fx/frame'
import { makeFoamNoise } from './fx/noise'
import { Spray, SPRAY_DROPLET, SPRAY_MIST, SPRAY_SHEET } from './fx/spray'
import { makeWaveUniforms } from './waveUniforms'

export const fxTuning = {
  /** how much spray is thrown (emission multiplier) */
  spray: 1,
  /** droplet and sheet size multiplier */
  spraySize: 1,
  /** how far a sheet of spray is drawn out along its flight (s of travel) */
  sheetStreak: 0.12,
  /** opacity of the wake line */
  wake: 1,
  /** seconds the mast's wake lasts, and the hull's when it is wet */
  wakeLife: 2.8,
  wakeLifeWet: 4.2,
  /** darkness of the blob under a board that is on the water (it fades with height) */
  shadow: 0.55,
  /** 0 = blob straight under the board, 1 = where the sun would really put the shadow */
  shadowShift: 0.3,
  /** bank (degrees) at which the high wingtip starts to throw spray */
  tipBank: 28,
  /** share of the wind that carries mist along */
  mistWind: 0.5,
  /**
   * The splash where the paddle blade goes in and comes out, placed from the board (0 = off:
   * for when the rider module announces the blade's own splashes with 'hr:rider-splash').
   */
  strokeSplash: 1,
}

/** where the mast sits, as a share of the board's length from the nose (the rider module's own number is used when it is loaded) */
const MAST_FRAC = 0.655
/** where the paddle blade goes in, ahead of the mast and out from the centreline (m) */
const CATCH_X = 1.25
const CATCH_Z = 0.42
/** seconds the wingtip's wash stays on the water: white for about a board length behind the tip, then streaks */
const TIP_LIFE = 0.9
/** ribbons */
const WAKE = 0
const TIP = 1
const RAD = Math.PI / 180
const TWO_PI = Math.PI * 2

// ---- the state that changes every frame, as slots of one Float64Array ----
// (the first F_SLOTS of them are the frame the buffers read: time now, origin, wind; see fx/frame.ts)
/** origin of the stored times */
const TBASE = F_SLOTS
/** emitters' fractional particles carried to the next frame */
const A_MAST = F_SLOTS + 1
const A_MAST_SHEET = F_SLOTS + 2
const A_TIP = F_SLOTS + 3
const A_TIP_SHEET = F_SLOTS + 4
const A_HULL = F_SLOTS + 5
const A_BOW = F_SLOTS + 6
const A_DRIP = F_SLOTS + 7
const A_SWIM = F_SLOTS + 8
/** 0..1: how wet the hull is (smoothed) */
const WET = F_SLOTS + 9
/** 0..1: how hard the high wingtip is working the surface (smoothed) */
const TIP_WASH = F_SLOTS + 10
const DRIP_TIME = F_SLOTS + 11
const BOW_DIST = F_SLOTS + 12
const LAST_STROKE = F_SLOTS + 13
/** the board's height over the water at the last frame, and how fast it was coming down (m/s) */
const RIDE_PREV = F_SLOTS + 14
const SINK = F_SLOTS + 15
const N_STATE = F_SLOTS + 16

/** random numbers are read from a table (a power of two long) */
const RN = 4096
const RM = RN - 1

/** splashes announced by other modules: x, y, z, strength, kind */
const SPLASH_MAX = 4
const SPLASH_STRIDE = 5

function smoothstep(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return u * u * (3 - 2 * u)
}

export interface FxModule extends FeatureModule {
  /** instanced quads and triangles drawn per frame, for the performance read-out */
  readonly instances: number
  readonly triangles: number
}

export function create(app: App): FxModule {
  const waves = app.sim.waves
  const noise = makeFoamNoise()
  // one set of wave uniforms for both materials: decals and spray ride the same surface
  const wave = makeWaveUniforms(app)
  const M = new THREE.Matrix4()
  const st = new Float64Array(N_STATE)

  let decals!: SurfaceDecals
  let spray!: Spray
  let builtFor = -1
  /**
   * Scales for the quality tier, set when the buffers are built: emission; drop size and
   * sheet size (fewer particles are drawn a little larger); sheet opacity.
   */
  let qs = 1
  let dropSize = 1
  let sheetSize = 1
  let sheetQ = 1
  let spacing0 = 0.3
  let bowSpacing = 0.4

  function build(q: Quality): void {
    if (q.particles === builtFor) return
    if (builtFor >= 0) {
      app.scene.remove(decals.mesh, spray.mesh)
      decals.dispose()
      spray.dispose()
    }
    builtFor = q.particles
    const n = Math.max(20, q.particles)
    qs = n / 200
    dropSize = Math.pow(qs, -0.3)
    sheetSize = Math.min(1.15, dropSize)
    sheetQ = Math.min(1.1, Math.pow(qs, -0.4))
    spacing0 = n <= 100 ? 0.55 : n <= 250 ? 0.34 : 0.24
    bowSpacing = n <= 100 ? 0.5 : 0.3
    // each ribbon's ring holds what it lays in its foam's life at 10 m/s (faster, or with
    // longer lives dialled in, the joints are spaced out instead: see update)
    const wakeCap = Math.ceil((10 * Math.max(2.8, fxTuning.wakeLife)) / spacing0) + 6
    const tipCap = Math.ceil((10 * TIP_LIFE) / spacing0) + 6
    decals = new SurfaceDecals(wave, st, [wakeCap, tipCap], 16 + 0.2 * n, noise)
    decals.spacing = spacing0
    spray = new Spray(1.5 * n, wave, st, noise)
    app.scene.add(decals.mesh, spray.mesh)
  }
  build(app.quality)

  const R = new Float32Array(RN)
  {
    const rand = mulberry32(0x5eaf0a11)
    for (let i = 0; i < RN; i++) R[i] = rand()
  }
  let ri = 0
  /** the next random number, 0..1 (small enough to be inlined; the index is an integer, so nothing is boxed) */
  const rnd = (): number => R[(ri = (ri + 1) & RM)]

  // Splashes announced by the rider module ('hr:rider-splash'): where a thrown rider lands,
  // where a blade dabs. Queued here, drawn on the next update.
  const splashQueue = new Float32Array(SPLASH_MAX * SPLASH_STRIDE)
  let splashCount = 0
  const onRiderSplash = (ev: Event) => {
    const d = (ev as CustomEvent).detail as { x?: number; y?: number; z?: number; strength?: number; kind?: string } | undefined
    if (!d || splashCount >= SPLASH_MAX) return
    const x = Number(d.x), y = Number(d.y), z = Number(d.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const i = splashCount++ * SPLASH_STRIDE
    splashQueue[i] = x - st[F_OX]
    splashQueue[i + 1] = y
    splashQueue[i + 2] = z - st[F_OZ]
    splashQueue[i + 3] = Math.min(1, Math.max(0, Number(d.strength) || 0))
    splashQueue[i + 4] = d.kind === 'blade' ? 1 : 0
  }
  window.addEventListener('hr:rider-splash', onRiderSplash)

  function restart(): void {
    decals.clear()
    spray.clear()
    st.fill(0)
    st[LAST_STROKE] = -1
    st[RIDE_PREV] = app.view.rideHeight
    st[F_OX] = Math.round(app.view.x / 64) * 64
    st[F_OZ] = Math.round(app.view.z / 64) * 64
    st[TBASE] = app.time
    ri = 0
    splashCount = 0
  }

  // A new particle is written by its emitter straight into the slot spray.alloc() returns:
  //   d[i..i+3]   where it is born (minus the origin) and when (on the stored clock)
  //   d[i+4..i+6] its velocity;  d[i+7] its life (a drop: 0 = until it is back down)
  //   d[i+8]      radius;  d[i+9] radius growth per second (sheets, mist);  d[i+11] opacity
  // and one of these three then fills in what its kind has in common.

  /** a drop: small, bright, heavy */
  function asDrop(i: number): void {
    const d = spray.data
    // as long as its flight back down to the level it left
    if (!(d[i + 7] > 0)) d[i + 7] = Math.min(1.4, 0.14 + 0.19 * Math.max(0, d[i + 5]))
    d[i + 8] *= dropSize * fxTuning.spraySize
    d[i + 9] = 0
    d[i + 10] = 1
    d[i + 12] = SPRAY_DROPLET
    d[i + 13] = 0.018
    d[i + 14] = 0.12
    d[i + 15] = 1
  }

  /** a sheet of thrown water: soft-edged, drawn out along its flight, tearing as it thins */
  function asSheet(i: number): void {
    const d = spray.data
    d[i + 8] *= sheetSize * fxTuning.spraySize
    d[i + 10] = 1.6
    d[i + 11] = Math.min(1, d[i + 11] * sheetQ)
    d[i + 12] = SPRAY_SHEET
    d[i + 13] = fxTuning.sheetStreak
    d[i + 14] = 0.2
    d[i + 15] = 0.9
  }

  /** a puff of mist: slow, growing, carried off by the wind */
  function asMist(i: number): void {
    const d = spray.data
    d[i + 8] *= sheetSize
    d[i + 10] = 2.6
    d[i + 12] = SPRAY_MIST
    d[i + 13] = 0
    d[i + 14] = fxTuning.mistWind
    d[i + 15] = 0.22
  }

  /**
   * Water thrown up all round a point: breaches, crashes, a body going in. `speed` is how
   * fast the fastest of it leaves (m/s); most goes up steeply, so it stands as a plume
   * before it falls.
   */
  function burst(x: number, y: number, z: number, vx: number, vz: number, count: number, speed: number, size: number): void {
    const d = spray.data
    const ox = st[F_OX], oz = st[F_OZ], now = st[F_NOW]
    const amount = qs * fxTuning.spray
    const body = Math.sqrt(qs) * fxTuning.spray
    const n = Math.max(4, Math.round(count * amount))
    for (let k = 0; k < n; k++) {
      const a = TWO_PI * rnd()
      const v = speed * (0.3 + 0.7 * Math.sqrt(rnd()))
      const el = (35 + 50 * rnd()) * RAD
      const out = v * Math.cos(el)
      const r = 0.3 * rnd()
      const i = spray.alloc()
      d[i] = x + Math.cos(a) * r - ox; d[i + 1] = y + 0.03; d[i + 2] = z + Math.sin(a) * r - oz; d[i + 3] = now - 0.04 * rnd()
      d[i + 4] = vx + Math.cos(a) * out; d[i + 5] = v * Math.sin(el); d[i + 6] = vz + Math.sin(a) * out; d[i + 7] = 0
      d[i + 8] = size * (0.6 + 0.9 * rnd()); d[i + 11] = 0.9
      asDrop(i)
    }
    const m = Math.max(3, Math.round(0.45 * count * body))
    for (let k = 0; k < m; k++) {
      const a = TWO_PI * rnd()
      const v = 0.75 * speed * (0.3 + 0.7 * rnd())
      const el = (40 + 45 * rnd()) * RAD
      const out = v * Math.cos(el)
      const i = spray.alloc()
      d[i] = x + Math.cos(a) * 0.2 - ox; d[i + 1] = y + 0.05; d[i + 2] = z + Math.sin(a) * 0.2 - oz; d[i + 3] = now - 0.04 * rnd()
      d[i + 4] = vx + Math.cos(a) * out; d[i + 5] = v * Math.sin(el); d[i + 6] = vz + Math.sin(a) * out; d[i + 7] = 0.5 + 0.45 * rnd()
      d[i + 8] = size * 5.5; d[i + 9] = 0.3; d[i + 11] = 0.85
      asSheet(i)
    }
    const k2 = Math.round(0.1 * count * body)
    for (let k = 0; k < k2; k++) {
      const a = TWO_PI * rnd()
      const i = spray.alloc()
      d[i] = x - ox; d[i + 1] = y + 0.3; d[i + 2] = z - oz; d[i + 3] = now
      d[i + 4] = vx * 0.6 + Math.cos(a) * (0.4 + rnd()); d[i + 5] = 1.0 + 1.6 * rnd(); d[i + 6] = vz * 0.6 + Math.sin(a) * (0.4 + rnd()); d[i + 7] = 0.9 + 0.6 * rnd()
      d[i + 8] = size * 11; d[i + 9] = 0.3; d[i + 11] = 0.13
      asMist(i)
    }
  }

  /**
   * A paddle blade touching the water at speed (the dab in a carve): a few drops and a
   * small streak of foam, left behind as the rider goes on.
   */
  function bladeSplash(x: number, y: number, z: number, strength: number): void {
    const s = app.view
    const d = spray.data
    const ox = st[F_OX], oz = st[F_OZ], now = st[F_NOW]
    const amount = qs * fxTuning.spray
    const sp = Math.hypot(s.vx, s.vz)
    const dx = sp > 0.3 ? s.vx / sp : Math.cos(s.heading)
    const dz = sp > 0.3 ? s.vz / sp : Math.sin(s.heading)
    const n = Math.max(3, Math.round(amount * (5 + 14 * strength)))
    for (let k = 0; k < n; k++) {
      const carry = 0.2 + 0.3 * rnd()
      const lat = (2 * rnd() - 1) * 0.8
      const i = spray.alloc()
      d[i] = x - ox; d[i + 1] = y + 0.02; d[i + 2] = z - oz; d[i + 3] = now
      d[i + 4] = s.vx * carry - dz * lat; d[i + 5] = 0.5 + 1.5 * rnd() * (0.5 + strength); d[i + 6] = s.vz * carry + dx * lat; d[i + 7] = 0
      d[i + 8] = 0.009 + 0.011 * rnd(); d[i + 11] = 0.85
      asDrop(i)
    }
    const i = spray.alloc()
    d[i] = x - ox; d[i + 1] = y + 0.03; d[i + 2] = z - oz; d[i + 3] = now
    d[i + 4] = s.vx * 0.35; d[i + 5] = 0.6 + 0.8 * strength; d[i + 6] = s.vz * 0.35; d[i + 7] = 0.3
    d[i + 8] = 0.04; d[i + 9] = 0.12; d[i + 11] = 0.45 + 0.5 * strength
    asSheet(i)
    // the foam it leaves, drawn out the way the blade was travelling
    const len = 0.2 + 0.5 * strength
    decals.patch(x - ox, z - oz, dx * len, dz * len, 0.09 + 0.06 * strength, 1.3, 0.7, 0.45 + 0.5 * strength, rnd(), s.vx * 0.12, s.vz * 0.12)
  }

  function update(dt: number): void {
    const s = app.view
    const P = app.sim.P
    const F = P.foil
    const T = fxTuning
    const t = app.time
    const d = spray.data
    const da = decals.arg

    // keep stored positions and times small
    if (Math.abs(s.x - st[F_OX]) > 384 || Math.abs(s.z - st[F_OZ]) > 384 || t - st[TBASE] > 300) {
      const nx = Math.round(s.x / 64) * 64
      const nz = Math.round(s.z / 64) * 64
      const nt = t - 30
      const mx = nx - st[F_OX], mz = nz - st[F_OZ]
      decals.shift(mx, mz, nt - st[TBASE])
      spray.shift(mx, mz, nt - st[TBASE])
      for (let k = 0; k < splashCount; k++) { splashQueue[k * SPLASH_STRIDE] -= mx; splashQueue[k * SPLASH_STRIDE + 2] -= mz }
      st[F_OX] = nx
      st[F_OZ] = nz
      st[TBASE] = nt
    }
    const ox = st[F_OX], oz = st[F_OZ]
    const now = t - st[TBASE]
    st[F_NOW] = now

    // board frame in the world: columns are nose, deck normal, starboard; then the wing
    riderMatrix(s, M)
    const e = M.elements
    const wx = e[12], wy = e[13], wz = e[14]
    // level nose and starboard directions
    const hx = Math.cos(s.heading), hz = Math.sin(s.heading)
    const sx = -hz, sz = hx
    const vx = s.vx, vz = s.vz
    const speed = s.speed
    // the board's ends and middle, measured forward from the mast (the rider module says where it put the mast)
    const riderTune = (app.modules.rider as { tune?: { mastFrac?: number } } | undefined)?.tune
    const noseX = (riderTune?.mastFrac ?? MAST_FRAC) * F.boardLength
    const tailX = noseX - F.boardLength
    const midX = noseX - 0.5 * F.boardLength
    const ev = app.events
    // drops scale with the particle budget; the sheets that give spray its body scale less,
    // so a phone's spray is coarser, not missing
    const amount = qs * T.spray
    const body = Math.sqrt(qs) * T.spray
    // The surface near the board, as the plane through the point under the rider: within
    // half a metre of the wing that is the surface to a centimetre, and it costs no call
    // into the wave field (the decals themselves are put on the exact surface by the GPU).
    const eta = s.eta, slopeX = s.slopeX, slopeZ = s.slopeZ, rx0 = s.x, rz0 = s.z
    const flying = s.mode === 'foil'
    let i = 0

    st[WET] += ((flying && s.touching ? 1 : 0) - st[WET]) * (1 - Math.exp(-dt / 0.1))
    const wet = st[WET]

    // how fast the board was coming down on the water before this frame (for the slap of a touchdown)
    const sinkBefore = st[SINK]
    if (flying && dt > 1e-5) {
      st[SINK] += ((st[RIDE_PREV] - s.rideHeight) / dt - st[SINK]) * Math.min(1, dt / 0.04)
    } else if (!flying) {
      st[SINK] = 0
    }
    st[RIDE_PREV] = s.rideHeight

    // ------------------------------------------------------------------ the blob
    // the middle of the board's underside
    const bx = wx + e[0] * midX + e[4] * F.mastLength
    const by = wy + e[1] * midX + e[5] * F.mastLength
    const bz = wz + e[2] * midX + e[6] * F.mastLength
    {
      const hb = Math.max(0, by - (eta + slopeX * (bx - rx0) + slopeZ * (bz - rz0)))
      const sun = app.atmos.sunDir
      const k = (T.shadowShift * hb) / Math.max(0.25, sun.y)
      // centre, direction, half length, half width, darkness, softness (see SurfaceDecals.blob)
      da[0] = bx - sun.x * k - ox; da[1] = bz - sun.z * k - oz; da[2] = s.heading
      da[3] = 0.5 * F.boardLength * (1 + 0.2 * hb) + 0.1; da[4] = 0.7 * F.boardWidth + 0.3 * hb + 0.08
      da[5] = T.shadow / (1 + 1.4 * hb); da[6] = 0.35 + 0.65 * smoothstep(0, 0.7, hb)
      decals.blob()
    }

    if (flying) {
      // ---------------------------------------------------------------- on foil
      // where the mast cuts the surface: up the mast from the wing by the wing's depth
      const ny = Math.max(0.35, e[5])
      let along = Math.min(F.mastLength, Math.max(0, s.depth / ny))
      let mx = wx + e[4] * along
      let mz = wz + e[6] * along
      const my = eta + slopeX * (mx - rx0) + slopeZ * (mz - rz0)
      along = Math.min(F.mastLength, Math.max(0, (my - wy) / ny))
      mx = wx + e[4] * along
      mz = wz + e[6] * along
      const wingWet = s.depth > 0.02

      // wake: a thin line off the mast; the hull's width, white, when it skims
      {
        let halfW = 0.03 + 0.004 * speed
        let alpha = 0.9 * smoothstep(2.5, 5, speed)
        if (!wingWet) { halfW = 0.2; alpha = 0.8 }
        halfW += (0.52 * F.boardWidth - halfW) * wet
        alpha += (1 - alpha) * wet
        const life = T.wakeLife + (T.wakeLifeWet - T.wakeLife) * wet
        // never more joints alive than the ring holds: going very fast they are spaced out
        decals.spacing = Math.max(spacing0, (s.speedH * life) / (decals.ribbonCap(WAKE) - 4))
        // point, half width, alpha, life, widening (see SurfaceDecals.trail)
        da[0] = mx - ox; da[1] = mz - oz; da[2] = halfW; da[3] = T.wake * alpha; da[4] = life; da[5] = 0.1 * wet
        decals.trail(WAKE)
      }

      // mast spray: a low rooster tail, more with speed, a pulse as a pump drives the mast down
      if (wingWet) {
        const plunge = s.pumpPhase >= 0 && s.pumpPhase < 0.5 ? Math.sin(TWO_PI * s.pumpPhase) : 0
        // riding low, the sheet climbing the mast hits the hull and is thrown back: a rooster tail
        const low = 1 - smoothstep(0.08, 0.3, s.rideHeight)
        const push = Math.max(0, speed - 2.5) * (1 + 0.8 * plunge) * (1 + 1.2 * low)
        st[A_MAST] += amount * 7 * push * dt
        while (st[A_MAST] >= 1) {
          st[A_MAST] -= 1
          const back = rnd() * dt
          const carry = 0.3 + 0.35 * rnd()
          const lat = (2 * rnd() - 1) * (0.25 + 0.1 * speed)
          const u = rnd()
          i = spray.alloc()
          d[i] = mx - vx * back - ox; d[i + 1] = my + 0.02; d[i + 2] = mz - vz * back - oz; d[i + 3] = now - back
          d[i + 4] = vx * carry + sx * lat; d[i + 5] = 0.6 + 0.26 * speed * u * Math.sqrt(u); d[i + 6] = vz * carry + sz * lat; d[i + 7] = 0
          d[i + 8] = 0.009 + 0.012 * rnd(); d[i + 11] = 0.85
          asDrop(i)
        }
        st[A_MAST_SHEET] += body * 4.5 * push * dt
        while (st[A_MAST_SHEET] >= 1) {
          st[A_MAST_SHEET] -= 1
          const back = rnd() * dt
          const lat = (2 * rnd() - 1) * 0.45
          i = spray.alloc()
          d[i] = mx - vx * back - ox; d[i + 1] = my + 0.03; d[i + 2] = mz - vz * back - oz; d[i + 3] = now - back
          d[i + 4] = vx * 0.45 + sx * lat; d[i + 5] = 0.5 + 0.12 * speed * rnd(); d[i + 6] = vz * 0.45 + sz * lat; d[i + 7] = 0.22 + 0.2 * rnd()
          d[i + 8] = 0.032; d[i + 9] = 0.1; d[i + 11] = 0.8
          asSheet(i)
        }
      }

      // the high wingtip: near the surface in any hard turn, through it when tipOut > 0
      {
        const sgn = s.bank >= 0 ? 1 : -1
        const hs = 0.5 * F.span
        const tx = wx - sgn * e[8] * hs
        const ty = wy - sgn * e[9] * hs
        const tz = wz - sgn * e[10] * hs
        const surf = eta + slopeX * (tx - rx0) + slopeZ * (tz - rz0)
        const tipDepth = surf - ty
        const bankDeg = Math.abs(s.bank) / RAD
        let I = smoothstep(T.tipBank, T.tipBank + 12, bankDeg) * (0.3 + 0.7 * (1 - smoothstep(0.03, 0.22, tipDepth)))
        if (s.tipOut > 0) I = Math.max(I, 0.65 + 0.35 * Math.min(1, s.tipOut * 6))
        I *= smoothstep(3.2, 5.5, speed)
        if (!wingWet) I = 0
        // where the wing meets the surface along its span
        const frac = tipDepth < 0 ? Math.min(1, Math.max(0, s.depth / Math.max(1e-3, s.depth - tipDepth))) : 1
        const fx = wx + (tx - wx) * frac
        const fz = wz + (tz - wz) * frac
        if (I > 0.01) {
          // outward: from the wing toward the high tip, level
          let outX = tx - wx
          let outZ = tz - wz
          const ol = Math.hypot(outX, outZ) || 1
          outX /= ol
          outZ /= ol
          const power = 0.6 + 0.4 * I
          // a low fan: thrown outward and left behind, about a metre, knee high at most
          st[A_TIP] += amount * 95 * I * dt
          while (st[A_TIP] >= 1) {
            st[A_TIP] -= 1
            const back = rnd() * dt
            const carry = 0.35 + 0.4 * rnd()
            const u = 0.3 + 0.7 * rnd()
            const fore = (2 * rnd() - 1) * 0.5
            i = spray.alloc()
            d[i] = fx - vx * back - ox; d[i + 1] = surf + 0.02; d[i + 2] = fz - vz * back - oz; d[i + 3] = now - back
            d[i + 4] = vx * carry + outX * 3.4 * u * power + hx * fore; d[i + 5] = (0.5 + 2.4 * u * rnd()) * power; d[i + 6] = vz * carry + outZ * 3.4 * u * power + hz * fore; d[i + 7] = 0
            d[i + 8] = 0.01 + 0.014 * rnd(); d[i + 11] = 0.9
            asDrop(i)
          }
          st[A_TIP_SHEET] += body * 40 * I * dt
          while (st[A_TIP_SHEET] >= 1) {
            st[A_TIP_SHEET] -= 1
            const back = rnd() * dt
            const u = 0.35 + 0.65 * rnd()
            const carry = 0.4 + 0.25 * rnd()
            i = spray.alloc()
            d[i] = fx - vx * back - ox; d[i + 1] = surf + 0.04; d[i + 2] = fz - vz * back - oz; d[i + 3] = now - back
            d[i + 4] = vx * carry + outX * 2.6 * u * power; d[i + 5] = (0.6 + 1.5 * u) * power; d[i + 6] = vz * carry + outZ * 2.6 * u * power; d[i + 7] = 0.32 + 0.3 * rnd()
            d[i + 8] = 0.04; d[i + 9] = 0.13; d[i + 11] = 0.9
            asSheet(i)
          }
        }
        // the white water the tip leaves on the surface
        st[TIP_WASH] += (I - st[TIP_WASH]) * (1 - Math.exp(-dt / 0.12))
        const tipWash = st[TIP_WASH]
        if (tipWash > 0.06) {
          decals.spacing = Math.max(spacing0, (s.speedH * TIP_LIFE) / (decals.ribbonCap(TIP) - 4))
          da[0] = fx - ox; da[1] = fz - oz; da[2] = 0.07 + 0.2 * tipWash; da[3] = T.wake * 0.95 * tipWash; da[4] = TIP_LIFE; da[5] = 0.25
          decals.trail(TIP)
        } else {
          decals.trailBreak(TIP)
        }
      }

      // the hull skimming: sheets of spray off both rails. A rail that only kisses the water
      // in a banked turn already throws a little, from that side.
      const lowRail = s.bank > 0.14 ? 1 : s.bank < -0.14 ? -1 : 0
      const kiss = Math.max(wet, lowRail !== 0 ? 0.45 * (1 - smoothstep(0.01, 0.07, s.rideHeight)) : 0)
      if (kiss > 0.05) {
        const power = kiss * smoothstep(2.5, 5, speed)
        const sheets = body * 18
        const total = amount * 54 + sheets
        st[A_HULL] += total * power * dt
        while (st[A_HULL] >= 1) {
          st[A_HULL] -= 1
          const back = rnd() * dt
          const side = lowRail !== 0 && rnd() < 0.85 ? lowRail : rnd() < 0.5 ? -1 : 1
          const f = 0.1 + 0.9 * rnd()
          // a point on that rail of the (banked) board, dropped to the water
          const reach = side * (0.5 * F.boardWidth + 0.1)
          const px = wx + e[0] * f + e[4] * F.mastLength + e[8] * reach
          const pz = wz + e[2] * f + e[6] * F.mastLength + e[10] * reach
          const py = eta + slopeX * (px - rx0) + slopeZ * (pz - rz0)
          const carry = 0.35 + 0.3 * rnd()
          const u = 0.3 + 0.7 * rnd()
          i = spray.alloc()
          d[i] = px - vx * back - ox; d[i + 2] = pz - vz * back - oz; d[i + 3] = now - back
          if (rnd() * total < sheets) {
            d[i + 1] = py + 0.04
            d[i + 4] = vx * carry + sx * side * 2.4 * u; d[i + 5] = 0.5 + 1.2 * u; d[i + 6] = vz * carry + sz * side * 2.4 * u; d[i + 7] = 0.3 + 0.25 * rnd()
            d[i + 8] = 0.038; d[i + 9] = 0.12; d[i + 11] = 0.8
            asSheet(i)
          } else {
            d[i + 1] = py + 0.03
            d[i + 4] = vx * carry + sx * side * 3.4 * u; d[i + 5] = 0.5 + 2.1 * u * rnd(); d[i + 6] = vz * carry + sz * side * 3.4 * u; d[i + 7] = 0
            d[i + 8] = 0.01 + 0.015 * rnd(); d[i + 11] = 0.9
            asDrop(i)
          }
        }
      }

      // water running off the hull for a moment after it lifts clear
      if (st[DRIP_TIME] > 0) {
        st[A_DRIP] += amount * 45 * (st[DRIP_TIME] / 0.7) * dt
        st[DRIP_TIME] -= dt
        while (st[A_DRIP] >= 1) {
          st[A_DRIP] -= 1
          const f = tailX + F.boardLength * rnd()
          const w = (2 * rnd() - 1) * 0.4 * F.boardWidth
          const carry = 0.8 + 0.15 * rnd()
          i = spray.alloc()
          d[i] = wx + e[0] * f + e[4] * F.mastLength + e[8] * w - ox
          d[i + 1] = wy + e[1] * f + e[5] * F.mastLength - 0.02
          d[i + 2] = wz + e[2] * f + e[6] * F.mastLength + e[10] * w - oz
          d[i + 3] = now - rnd() * dt
          d[i + 4] = vx * carry; d[i + 5] = 0.3 * (2 * rnd() - 1); d[i + 6] = vz * carry; d[i + 7] = 0.3 + 0.25 * rnd()
          d[i + 8] = 0.008 + 0.009 * rnd(); d[i + 11] = 0.8
          asDrop(i)
        }
      }
    } else {
      decals.trailBreak(TIP)
      st[TIP_WASH] = 0
    }

    if (s.mode === 'paddle') {
      // ---------------------------------------------------------------- floating
      // how hard the hull is working the water: nothing drifting, less as the wing takes the weight
      const share = Math.min(1, s.gLoad)
      const hull = smoothstep(0.7, 2.6, speed) * (1 - 0.6 * share)

      // stern wash
      decals.spacing = Math.max(spacing0, (s.speedH * T.wakeLifeWet * 0.85) / (decals.ribbonCap(WAKE) - 4))
      da[0] = wx + hx * tailX - ox; da[1] = wz + hz * tailX - oz; da[2] = 0.42 * F.boardWidth
      da[3] = T.wake * 0.65 * hull; da[4] = T.wakeLifeWet * 0.85; da[5] = 0.1
      decals.trail(WAKE)

      // bow wave: two arms of foam peeling off the nose
      st[BOW_DIST] += speed * dt
      if (st[BOW_DIST] >= bowSpacing) {
        st[BOW_DIST] = 0
        if (hull > 0.05) {
          const nx = wx + hx * (noseX - 0.2)
          const nz = wz + hz * (noseX - 0.2)
          for (let side = -1; side <= 1; side += 2) {
            decals.patch(
              nx + sx * side * 0.1 - ox, nz + sz * side * 0.1 - oz, hx * 0.3, hz * 0.3, 0.07,
              0.9 + 0.4 * rnd(), 0.6, 0.45 * hull, rnd(),
              vx * 0.2 + sx * side * 0.34 * speed, vz * 0.2 + sz * side * 0.34 * speed,
            )
          }
        }
      }
      // ...and drops thrown from it in a sprint
      st[A_BOW] += amount * 18 * smoothstep(1.8, 3.6, speed) * (1 - 0.5 * share) * dt
      while (st[A_BOW] >= 1) {
        st[A_BOW] -= 1
        const back = rnd() * dt
        const side = rnd() < 0.5 ? -1 : 1
        const f = noseX - 0.3 * rnd()
        const px = wx + hx * f
        const pz = wz + hz * f
        const out = side * (0.5 + 1.2 * rnd())
        i = spray.alloc()
        d[i] = px - vx * back - ox; d[i + 1] = eta + slopeX * (px - rx0) + slopeZ * (pz - rz0) + 0.02; d[i + 2] = pz - vz * back - oz; d[i + 3] = now - back
        d[i + 4] = vx * 0.6 + sx * out; d[i + 5] = 0.5 + 1.1 * rnd(); d[i + 6] = vz * 0.6 + sz * out; d[i + 7] = 0
        d[i + 8] = 0.009 + 0.01 * rnd(); d[i + 11] = 0.8
        asDrop(i)
      }

      // the paddle: a splash where the blade goes in, a flick where it comes out
      const side = s.strokeSide < 0 ? -1 : 1
      if (ev & EV.STROKE && T.strokeSplash > 0) {
        const px = wx + hx * CATCH_X + sx * side * CATCH_Z
        const pz = wz + hz * CATCH_X + sz * side * CATCH_Z
        const py = waves.height(px, pz, t)
        const n = Math.max(3, Math.round(amount * T.strokeSplash * (4 + 8 * s.effort)))
        for (let k = 0; k < n; k++) {
          const back = 0.3 + 1.2 * rnd()
          const out = side * (0.2 + 0.9 * rnd())
          i = spray.alloc()
          d[i] = px - ox; d[i + 1] = py + 0.02; d[i + 2] = pz - oz; d[i + 3] = now
          d[i + 4] = vx * 0.6 - hx * back + sx * out; d[i + 5] = 0.7 + 1.5 * rnd() * (0.5 + s.effort); d[i + 6] = vz * 0.6 - hz * back + sz * out; d[i + 7] = 0
          d[i + 8] = 0.009 + 0.011 * rnd(); d[i + 11] = 0.85
          asDrop(i)
        }
        i = spray.alloc()
        d[i] = px - ox; d[i + 1] = py + 0.03; d[i + 2] = pz - oz; d[i + 3] = now
        d[i + 4] = vx * 0.5 - hx * 0.6; d[i + 5] = 0.8 + 0.7 * s.effort; d[i + 6] = vz * 0.5 - hz * 0.6; d[i + 7] = 0.32
        d[i + 8] = 0.04; d[i + 9] = 0.12; d[i + 11] = 0.5 + 0.3 * s.effort
        asSheet(i)
        decals.patch(px - ox, pz - oz, hx * 0.2, hz * 0.2, 0.2, 1.5, 1.1, 0.5 + 0.4 * s.effort, rnd(), vx * 0.1, vz * 0.1)
      }
      const last = st[LAST_STROKE]
      if (T.strokeSplash > 0 && s.strokePhase >= 0.62 && last >= 0 && last < 0.62) {
        const px = wx + hx * 0.15 + sx * side * CATCH_Z
        const pz = wz + hz * 0.15 + sz * side * CATCH_Z
        const py = waves.height(px, pz, t)
        const n = Math.max(2, Math.round(amount * T.strokeSplash * (2 + 4 * s.effort)))
        for (let k = 0; k < n; k++) {
          const back = 0.8 + 1.4 * rnd()
          i = spray.alloc()
          d[i] = px - ox; d[i + 1] = py + 0.02; d[i + 2] = pz - oz; d[i + 3] = now
          d[i + 4] = vx * 0.8 - hx * back + sx * side * 0.3; d[i + 5] = 0.8 + 1.2 * rnd(); d[i + 6] = vz * 0.8 - hz * back + sz * side * 0.3; d[i + 7] = 0
          d[i + 8] = 0.008 + 0.01 * rnd(); d[i + 11] = 0.8
          asDrop(i)
        }
        decals.patch(px - ox, pz - oz, hx * 0.16, hz * 0.16, 0.16, 1.2, 1.0, 0.4 + 0.2 * s.effort, rnd(), 0, 0)
      }
    } else if (s.mode === 'swim') {
      // ---------------------------------------------------------------- swimming
      decals.trailBreak(WAKE)
      st[A_SWIM] += dt
      if (st[A_SWIM] >= 0.45) {
        st[A_SWIM] = 0
        const a = TWO_PI * rnd()
        const px = wx + hx * 0.3 + Math.cos(a) * 0.5
        const pz = wz + hz * 0.3 + Math.sin(a) * 0.5
        decals.patch(px - ox, pz - oz, 0.3, 0, 0.3, 1.3, 0.9, 0.5, rnd(), 0, 0)
        const n = Math.max(2, Math.round(amount * 4))
        for (let k = 0; k < n; k++) {
          const b = TWO_PI * rnd()
          i = spray.alloc()
          d[i] = px - ox; d[i + 1] = eta + 0.03; d[i + 2] = pz - oz; d[i + 3] = now
          d[i + 4] = Math.cos(b) * (0.4 + rnd()); d[i + 5] = 0.8 + 1.3 * rnd(); d[i + 6] = Math.sin(b) * (0.4 + rnd()); d[i + 7] = 0
          d[i + 8] = 0.009 + 0.01 * rnd(); d[i + 11] = 0.8
          asDrop(i)
        }
      }
    }
    st[LAST_STROKE] = s.mode === 'paddle' ? s.strokePhase : -1

    // ------------------------------------------------- splashes the rider module announced
    for (let k = 0; k < splashCount; k++) {
      const q = k * SPLASH_STRIDE
      const px = splashQueue[q] + ox
      const py = splashQueue[q + 1]
      const pz = splashQueue[q + 2] + oz
      const strength = splashQueue[q + 3]
      if (splashQueue[q + 4] > 0.5) {
        bladeSplash(px, py, pz, strength)
      } else {
        burst(px, py, pz, vx * 0.3, vz * 0.3, 20 + 50 * strength, 2.6 + 3.6 * strength, 0.016 + 0.006 * strength)
        const size = 0.35 + 0.5 * strength
        decals.patch(px - ox, pz - oz, size, 0, size, 1.6 + 1.4 * strength, 0.6, 0.6 + 0.35 * strength, rnd(), 0, 0)
      }
    }
    splashCount = 0

    // -------------------------------------------------------------------- events
    if (ev) {
      const cx = bx
      const cz = bz
      const cy = eta + slopeX * (cx - rx0) + slopeZ * (cz - rz0)
      if (ev & EV.CRASH) {
        // the sim has already braked the rider; the water keeps going
        burst(cx, cy, cz, vx * 1.2, vz * 1.2, 55, 5.4, 0.02)
        for (let k = 0; k < 4; k++) {
          const a = TWO_PI * rnd()
          const r = 0.6 * rnd()
          const size = 0.7 + 0.5 * rnd()
          decals.patch(cx + Math.cos(a) * r - ox, cz + Math.sin(a) * r - oz, size, 0, size, 2.6 + rnd(), 0.55, 0.95, rnd(), vx * 0.3, vz * 0.3)
        }
        decals.trailBreak(WAKE)
      } else {
        if (ev & EV.BREACH) {
          burst(wx, eta, wz, vx * 0.65, vz * 0.65, 30, 4.4, 0.017)
          decals.patch(wx - ox, wz - oz, 0.45, 0, 0.45, 1.4, 0.9, 0.8, rnd(), vx * 0.25, vz * 0.25)
        }
        if (ev & (EV.TOUCHDOWN | EV.OFF_FOIL)) {
          // The hull meets the water: spray thrown out from under both rails, as much as it
          // came down hard. The skim of a pump is a kiss; a dropped board is a slap.
          const hard = ev & EV.OFF_FOIL ? 1 : 0.22 + 0.78 * smoothstep(0.35, 1.8, sinkBefore)
          const sheets = body * 10
          const total = amount * 20 + sheets
          const n = Math.max(3, Math.round(total * hard))
          for (let k = 0; k < n; k++) {
            const side = rnd() < 0.5 ? -1 : 1
            const f = tailX + F.boardLength * (0.25 + 0.75 * rnd())
            const carry = 0.4 + 0.35 * rnd()
            const u = (0.3 + 0.7 * rnd()) * (0.55 + 0.45 * hard)
            const px = wx + e[0] * f + e[4] * F.mastLength + e[8] * side * 0.5 * F.boardWidth
            const pz = wz + e[2] * f + e[6] * F.mastLength + e[10] * side * 0.5 * F.boardWidth
            const py = eta + slopeX * (px - rx0) + slopeZ * (pz - rz0)
            i = spray.alloc()
            d[i] = px - ox; d[i + 2] = pz - oz; d[i + 3] = now - 0.03 * rnd()
            if (rnd() * total < sheets) {
              d[i + 1] = py + 0.04
              d[i + 4] = vx * carry + sx * side * 2.6 * u; d[i + 5] = 0.6 + 1.4 * u; d[i + 6] = vz * carry + sz * side * 2.6 * u; d[i + 7] = 0.35 + 0.25 * rnd()
              d[i + 8] = 0.045; d[i + 9] = 0.16; d[i + 11] = 0.8
              asSheet(i)
            } else {
              d[i + 1] = py + 0.03
              d[i + 4] = vx * carry + sx * side * 4.0 * u; d[i + 5] = 0.6 + 2.4 * u * rnd(); d[i + 6] = vz * carry + sz * side * 4.0 * u; d[i + 7] = 0
              d[i + 8] = 0.011 + 0.017 * rnd(); d[i + 11] = 0.9
              asDrop(i)
            }
          }
          const size = 0.5 + 0.5 * hard
          decals.patch(cx - ox, cz - oz, hx * 0.8 * size, hz * 0.8 * size, 0.38 * size, 1.1 + 0.6 * hard, 0.6, 0.25 + 0.35 * hard, rnd(), vx * 0.3, vz * 0.3)
        }
      }
      if (ev & EV.TAKEOFF) st[DRIP_TIME] = 0.7
    }

    // ---------------------------------------------------------------- light and upload
    const U = app.atmos.uniforms
    const sunUp = Math.max(0, U.uSunDir.value.y)
    const sunL = U.uSunLight.value
    const sky = U.uAmbientSky.value
    const foam = decals.foam
    foam.r = Math.min(1, 0.95 * (sunL.r * sunUp + sky.r))
    foam.g = Math.min(1, 0.95 * (sunL.g * sunUp + sky.g))
    foam.b = Math.min(1, 0.95 * (sunL.b * sunUp + sky.b))
    spray.color.copy(foam)

    // the rest of the frame the buffers read (the time and the origin are already in it)
    st[F_DT] = dt
    st[F_WIND_X] = P.env.wind + P.env.current
    st[F_WIND_Z] = 0
    st[F_PX] = 0.5 * app.height * app.pixelRatio * app.camera.projectionMatrix.elements[5]
    wave.update(ox, oz)
    decals.update()
    spray.update()
  }

  restart()

  return {
    get instances() { return decals.instances + spray.capacity },
    get triangles() { return decals.triangles + spray.triangles },
    update,
    setQuality(q) {
      if (q.particles !== builtFor) { build(q); restart() }
    },
    reset: restart,
    dispose() {
      window.removeEventListener('hr:rider-splash', onRiderSplash)
      app.scene.remove(decals.mesh, spray.mesh)
      decals.dispose()
      spray.dispose()
      noise.dispose()
    },
  }
}
