/**
 * The river surface.
 *
 * One mesh, one draw call, one program: nested rings of doubling cell size centred on the
 * rider (snapped and morphed so no vertex swims) and a flat skirt to the horizon, displaced
 * in the vertex shader by the shared wave function, so what is drawn is what the physics
 * rides. Shading, foam, shallows and the bank are in src/render/water/shaders.ts; the mesh
 * in geometry.ts; the generated textures in textures.ts.
 *
 * URL flags
 *   ?wl=name:value,...   override entries of WATER_LOOK (colours as r/g/b), e.g. wl=foamThreshold:0.7
 *   ?wt=name:value,...   override entries of the tier setup, e.g. wt=farWaves:0,anisotropy:1,cull:0
 *   ?waterexact=40       0.5 m cells out to this many metres on every tier (see EXACT_RADIUS)
 *   ?waterdebug=1        markers on the CPU-sampled surface and window.__waterCheck() (debug.ts);
 *                        2..7 are false-colour views (normals, foam, far field, level, bumps, distance)
 */
import * as THREE from 'three'
import type { App, FeatureModule, Quality } from '../app/types'
import { makeWaveUniforms } from './waveUniforms'
import { buildWaterGrid, type WaterGrid } from './water/geometry'
import { LAYERS, LEVELS, WATER_FRAGMENT, WATER_VERTEX } from './water/shaders'
import { SWELL_TILE_WAVES, makeDetailTexture, makeShoreTexture, makeStreakTexture, makeSwellTexture } from './water/textures'

/** cell size of the innermost level (m): 17 vertices across the shortest wave the physics uses */
const CELL0 = 0.5
/** the mesh origin is snapped to this lattice (a multiple of every level's snap) */
const ORIGIN_SNAP = 64
/**
 * Vertices farther than this (plus three of their own cells) outside the view frustum are
 * left flat: taller than any wave. `?wt=cull:0` switches the culling off.
 */
const CULL_MARGIN = 3
/**
 * How far from the rider the drawn surface has to be the physics surface, per tier (m).
 *   exact  out to here the mesh has 0.5 m cells: the drawn height is within 2 cm of
 *          waves.height() (measured with window.__waterCheck: 1.9 cm at the sharpest crests)
 *   full   out to here it has at most 1 m cells: every wave component is at full height
 *          and the error is under 1 cm rms, up to 7 cm on the tips of the sharpest crests
 * 0 keeps a level at the ring size from quality.waterSegments. Level 0 has to be 204 cells
 * across (41,600 vertices) to hold 2 cm out to 40 m, which is more than the whole low-tier
 * mesh, so the low tier keeps its ring size: 2 cm out to 17.5 m and `full` beyond.
 */
const EXACT_RADIUS: Record<string, { exact: number; full: number }> = {
  low: { exact: 0, full: 40 },
  mid: { exact: 40, full: 0 },
  high: { exact: 40, full: 0 },
}

/** the wind the look is tuned at (m/s): 25 knots */
const WIND_REF = 12.9

/**
 * The look, in one place: a tuning panel can bind this object as it is (every entry is read
 * every frame). Colours are linear RGB.
 */
export const WATER_LOOK = {
  /** colour of the water column under full light (what the sun-lit backs show) */
  bodyColor: [0.05, 0.088, 0.054] as [number, number, number],
  /** light scattered out of thin crests and aerated water */
  scatterColor: [0.032, 0.125, 0.072] as [number, number, number],
  /** the riverbed where it shows through (pale sand) */
  sandColor: [0.36, 0.37, 0.27] as [number, number, number],
  foamColor: [0.92, 0.95, 0.96] as [number, number, number],
  /** how fast the bed disappears with depth, per metre, per channel */
  extinction: [1.4, 0.6, 0.5] as [number, number, number],
  /** contrast between sunlit backs and shaded faces (exponent on the sun's cosine) */
  relief: 2.2,
  /** crests brighter, troughs darker */
  crestGain: 0.8,
  /** green glow through crests */
  scatterGain: 1,
  /** sky light entering the water */
  ambientGain: 0.9,
  /** slope gain of the three chop layers, tiles of 21 m, 4.3 m and 1.3 m (rms slope = 0.143 x gain) */
  chopA: 1,
  chopB: 0.95,
  chopC: 0.55,
  /** how much gusts change the chop (mid and high tiers) */
  gustDepth: 0.4,
  /**
   * How far the chop tilts the light inside the water when the surface is seen from steep
   * above, where reflection no longer shows it (the bottom of a portrait screen): 0 = matte
   */
  steepChop: 0.8,
  /**
   * How much the look follows the wind (app.sim.P.env.wind): 1 = whitecaps, chop, gusts and
   * windrows all scale from their values at 25 knots, 0 = they ignore the wind
   */
  windResponse: 1,
  /** crest height (in Hs/2) at which a bump breaks: lower = more and bigger whitecaps */
  foamThreshold: 0.85,
  foamSoftness: 0.45,
  /** foam left on the back of a breaking bump */
  foamTrail: 0.9,
  /** how much lower the breaking height is per unit of relative wind (1 = twice 25 knots) */
  foamWind: 0.7,
  /** how white the far water is with whitecaps too small to draw (0 = none) */
  foamFar: 0.09,
  /** opacity of the windrows: thin lines of old foam drawn out along the wind (mid and high tiers) */
  foamStreaks: 0.25,
  /** sun sparkle gain; 3 is physical for the atmosphere's sun (its irradiance in white-card units) */
  glitter: 3,
  /** slope variance of the smoothest water (sharpness of sparkles) */
  glitterSharpness: 0.0006,
  /** per-pixel bumps beyond the mesh (high tier): 1 = as far as a pixel can resolve them, 0 = off */
  farWaveReach: 1,
  /** scale on the sky reflection */
  reflection: 1,
  /**
   * How far the visible water leans toward the viewer at grazing angles (chop hides its own
   * far sides): about 1.25 x the rms slope of the chop. More = more of the water's own
   * colour and less sky in the distance.
   */
  chopLean: 0.25,
  /** how far unresolved roughness lifts the reflected ray toward the zenith */
  reflectionLift: 0.6,
  /**
   * Toward the horizon the water goes over to reflecting the low sky. Below `farView` (sine
   * of the view ray's elevation; 0.1 = beyond 50 m from 5 m up) the lean and the lift fade
   * to these shares of themselves, all the way by a twelfth of it (600 m): lower = paler,
   * brighter far water.
   */
  farLean: 0.65,
  farLift: 0.4,
  farView: 0.1,
  /** the bump's slope is exaggerated by this in the Fresnel term (1 = physical): draws the bumps */
  bumpContrast: 2,
  /** share of the large chop (tile A, the lumps on the bumps) in the Fresnel term (1 = physical): less = more readable bumps */
  chopContrast: 0.5,
  /** share of the small chop (tiles B and C) in the Fresnel term: what makes the water next to the board read as wind-blown */
  rippleContrast: 1,
  /** saturation of the reflected sky: rough water gathers its reflection from a wide patch of sky, paler than any one direction */
  skySaturation: 0.7,
  /** the gorge walls in the reflection (mid and high tiers) */
  landReflection: 0.35,
  /** how far off the bank the lapping foam and the thinner scum reach (m), and their gain */
  shoreFoamReach: 7,
  shoreScumReach: 16,
  shoreFoamGain: 1,
  /** tan(elevation) of the skyline ahead/astern, and the extra toward Washington and Oregon */
  skyline: 0.05,
  skylineNorth: 0.16,
  skylineSouth: 0.05,
  /** what the walls reflect: sunlit Washington, shaded Oregon */
  landNorth: [0.2, 0.19, 0.16] as [number, number, number],
  landSouth: [0.045, 0.085, 0.09] as [number, number, number],
}
export type WaterLook = typeof WATER_LOOK

/**
 * What each tier pays for (0 or 1 unless noted). Per pixel, low reads 4 textures (chop A and
 * B, swell, shore) with plain trilinear filtering; mid 6 (+ streaks, gusts) at 4x anisotropy;
 * high 6 (chop C instead of the swell) at 8x, and sums the sea itself beyond the mesh.
 */
interface TierSetup {
  /** 0 = evaluate the waves at every vertex, even those behind the camera */
  cull: number
  /** the physics sea summed per pixel where the mesh has faded it out */
  farWaves: number
  /** instead, a baked patch of the same sea */
  swellTex: number
  /** third chop layer (ripples) */
  detailC: number
  /** foam lines along the wind and lanes of rougher water */
  streaks: number
  gusts: number
  landRefl: number
  /** skip the glitter, the foam and the riverbed on the pixels that have none (no visible change; 0 for A/B timing) */
  gates: number
  /**
   * The reflected sky from four samples of skyColor() per vertex instead of one per pixel
   * (tiers without the wall reflection only). Off everywhere: the picture is the same to
   * within 2 levels, but on the M1 Max it saved 10 to 15 % at 4.7 megapixels and nothing at
   * 0.74. skyColor() is a third of the low tier's pixel cost, so `?wt=skyVertex:1` is the
   * first thing to try on a low-end phone that is short of frame time.
   */
  skyVertex: number
  /** anisotropic filtering of the generated textures */
  anisotropy: number
}

/** `?wt=farWaves:0,anisotropy:2` overrides entries of the tier setup (for A/B timing on a device) */
let setupOverride: Partial<TierSetup> = {}

function tierSetup(q: Quality): TierSetup {
  const base: TierSetup =
    q.shaderDetail >= 2 ? { cull: 1, farWaves: 1, swellTex: 0, detailC: 1, streaks: 1, gusts: 1, landRefl: 1, gates: 1, skyVertex: 0, anisotropy: 8 }
    : q.shaderDetail >= 1 ? { cull: 1, farWaves: 0, swellTex: 1, detailC: 0, streaks: 1, gusts: 1, landRefl: 1, gates: 1, skyVertex: 0, anisotropy: 4 }
    : { cull: 1, farWaves: 0, swellTex: 1, detailC: 0, streaks: 0, gusts: 0, landRefl: 0, gates: 1, skyVertex: 0, anisotropy: 1 }
  return { ...base, ...setupOverride }
}

function parseSetupOverride(spec: string | null) {
  if (!spec) return
  const o = setupOverride as Record<string, number>
  for (const item of spec.split(',')) {
    const [name, raw] = item.split(':')
    const v = Number(raw)
    if (name && Number.isFinite(v)) o[name] = v
  }
}

function applyLookOverrides(spec: string | null) {
  if (!spec) return
  const look = WATER_LOOK as unknown as Record<string, number | number[]>
  for (const item of spec.split(',')) {
    const [name, raw] = item.split(':')
    if (!name || raw === undefined || !(name in look)) continue
    const cur = look[name]
    if (typeof cur === 'number') {
      const v = Number(raw)
      if (Number.isFinite(v)) look[name] = v
    } else {
      // colours as r/g/b
      const v = raw.split('/').map(Number)
      if (v.length === cur.length && v.every(Number.isFinite)) look[name] = v
    }
  }
}

const fract = (x: number) => x - Math.floor(x)

export function create(app: App): FeatureModule | Promise<FeatureModule> {
  const query = app.options.query
  applyLookOverrides(query.get('wl'))
  parseSetupOverride(query.get('wt'))
  const debugMode = Number(query.get('waterdebug') ?? 0) || 0

  const waves = app.sim.waves
  const wave = makeWaveUniforms(app)
  const maxAniso = app.renderer.capabilities.getMaxAnisotropy()
  let setup = tierSetup(app.quality)

  const aniso = () => Math.max(1, Math.min(maxAniso, setup.anisotropy))
  const detail = makeDetailTexture(256, 20250715, aniso())
  const shore = makeShoreTexture()
  /** made the first time a tier asks for it */
  let streak: THREE.DataTexture | null = null
  let swell: THREE.DataTexture | null = null
  let swellVersion = -1
  let swellHs = 1
  let swellTile = 100

  const levelUniforms: THREE.Vector4[] = []
  const morphUniforms: THREE.Vector4[] = []
  for (let l = 0; l < LEVELS; l++) {
    levelUniforms.push(new THREE.Vector4())
    morphUniforms.push(new THREE.Vector4())
  }

  const cullPlanes: THREE.Vector4[] = []
  for (let i = 0; i < 5; i++) cullPlanes.push(new THREE.Vector4(0, 0, 0, 1e9))

  const uniforms = {
    ...app.atmos.uniforms,
    ...wave.uniforms,
    uLevel: { value: levelUniforms },
    uMorph: { value: morphUniforms },
    uCenter: { value: new THREE.Vector2() },
    uGrid: { value: new THREE.Vector4() },
    uCull: { value: cullPlanes },
    uWaveInfo: { value: new THREE.Vector4() },
    uCamLocal: { value: new THREE.Vector3() },
    uDetail: { value: detail },
    uShore: { value: shore.texture },
    uStreak: { value: null as THREE.DataTexture | null },
    uSwell: { value: null as THREE.DataTexture | null },
    uSwellUv: { value: new THREE.Vector4() },
    uShoreRect: { value: new THREE.Vector4() },
    uUvA: { value: new THREE.Vector4() },
    uUvB: { value: new THREE.Vector4() },
    uUvC: { value: new THREE.Vector4() },
    uBodyColor: { value: new THREE.Vector3() },
    uScatterColor: { value: new THREE.Vector3() },
    uSandColor: { value: new THREE.Vector3() },
    uFoamColor: { value: new THREE.Vector3() },
    uExtinction: { value: new THREE.Vector3() },
    uLandN: { value: new THREE.Vector3() },
    uLandS: { value: new THREE.Vector3() },
    uShade: { value: new THREE.Vector4() },
    uShade2: { value: new THREE.Vector4() },
    uSunAway: { value: new THREE.Vector2(1, 0) },
    uChop: { value: new THREE.Vector4() },
    uFoamP: { value: new THREE.Vector4() },
    uFoamFar: { value: 0 },
    uSpec: { value: new THREE.Vector4() },
    uShoreP: { value: new THREE.Vector4() },
    uSkyline: { value: new THREE.Vector4() },
    uRefl: { value: new THREE.Vector4() },
    uRefl2: { value: new THREE.Vector4() },
    uDebug: { value: debugMode },
  }

  function defines(s: TierSetup): Record<string, number> {
    return {
      FAR_WAVES: s.farWaves,
      SWELL_TEX: s.swellTex,
      DETAIL_C: s.detailC,
      STREAKS: s.streaks,
      GUSTS: s.gusts,
      LAND_REFL: s.landRefl,
      GATES: s.gates,
      // (the per-vertex sky has no azimuth of its own for the walls to be found in)
      SKY_VERTEX: s.skyVertex && !s.landRefl ? 1 : 0,
      DEBUG_VIEW: debugMode > 1 ? 1 : 0,
    }
  }

  const material = new THREE.ShaderMaterial({
    name: 'water',
    uniforms,
    defines: defines(setup),
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
  })

  const exactOverride = Number(query.get('waterexact'))
  const makeGrid = (q: Quality) => {
    const r = EXACT_RADIUS[q.tier] ?? EXACT_RADIUS.low
    if (exactOverride > 0) return buildWaterGrid(q.waterSegments, LEVELS, CELL0, exactOverride, 0)
    return buildWaterGrid(q.waterSegments, LEVELS, CELL0, r.exact, r.full)
  }
  let grid: WaterGrid = makeGrid(app.quality)
  let gridTier = app.quality.tier
  const mesh = new THREE.Mesh(grid.geometry, material)
  mesh.name = 'water'
  mesh.frustumCulled = false
  // after the land and the rider, so the pixels they cover are never shaded as water
  mesh.renderOrder = 5
  app.scene.add(mesh)

  function applyGrid() {
    uniforms.uGrid.value.set(grid.cell0, CULL_MARGIN, 0.78 * grid.outerHalf, 0.9 * grid.outerHalf)
    for (let l = 0; l < LEVELS; l++) {
      const lv = grid.levels[l]
      morphUniforms[l].set(lv.half, lv.morph0, 1 / (lv.morph1 - lv.morph0), 0)
    }
  }
  applyGrid()

  // The far-field swell of the low and mid tiers is baked from the wave parameters. While a
  // tuning slider is being dragged they change every frame, so re-bake only once they have
  // been still for a few frames (the amplitude follows at once through uSwellUv.w).
  let swellSeen = -1
  let swellStill = 0
  function ensureSwell(now = false) {
    if (!setup.swellTex) return
    if (swell && swellVersion === waves.version) return
    if (swellSeen !== waves.version) { swellSeen = waves.version; swellStill = 0 }
    if (swell && !now && ++swellStill < 12) return
    swell?.dispose()
    swell = makeSwellTexture(256, waves.params, waves.K, waves.S, 977, aniso())
    swellVersion = waves.version
    swellHs = waves.params.hs
    swellTile = (SWELL_TILE_WAVES * 2 * Math.PI) / waves.kp
    uniforms.uSwell.value = swell
  }
  ensureSwell(true)

  function ensureStreak() {
    if (!setup.streaks || streak) return
    streak = makeStreakTexture(4104, aniso())
    uniforms.uStreak.value = streak
  }
  ensureStreak()

  // The camera can be moved after the modules update (debug views), so read it at draw
  // time: its position, and its frustum for the vertex shader's wave-sum culling.
  let originX = 0
  let originZ = 0
  const viewProj = new THREE.Matrix4()
  function setPlane(i: number, a: number, b: number, c: number, d: number) {
    const inv = 1 / (Math.hypot(a, b, c) || 1)
    // world plane -> the mesh's frame (its origin is at y = 0)
    cullPlanes[i].set(a * inv, b * inv, c * inv, (d + a * originX + c * originZ) * inv)
  }
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const e = camera.matrixWorld.elements
    uniforms.uCamLocal.value.set(e[12] - originX, e[13], e[14] - originZ)
    const m = viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements
    setPlane(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12])
    setPlane(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12])
    setPlane(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13])
    setPlane(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13])
    setPlane(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14])
    if (!setup.cull) for (const pl of cullPlanes) pl.set(0, 0, 0, 1e9)
  }

  function setLook() {
    const L = WATER_LOOK
    // The wind: 1 at 25 knots. Slopes of wind chop go as the square root of the wind (Cox and
    // Munk), whitecap cover as about its cube (Monahan); the breaking height is lowered or
    // raised so the cover of drawn whitecaps follows (a third at 18 knots, 2.5 times at 33).
    const w = Math.max(0, 1 + L.windResponse * (Math.abs(app.sim.P.env.wind) / WIND_REF - 1))
    const slope = Math.sqrt((0.003 + 0.00512 * WIND_REF * w) / (0.003 + 0.00512 * WIND_REF))
    const white = Math.min(4, w * w * w * Math.sqrt(w))
    uniforms.uBodyColor.value.fromArray(L.bodyColor)
    uniforms.uScatterColor.value.fromArray(L.scatterColor)
    uniforms.uSandColor.value.fromArray(L.sandColor)
    uniforms.uFoamColor.value.fromArray(L.foamColor)
    uniforms.uExtinction.value.fromArray(L.extinction)
    uniforms.uLandN.value.fromArray(L.landNorth)
    uniforms.uLandS.value.fromArray(L.landSouth)
    uniforms.uShade.value.set(L.relief, L.crestGain, L.scatterGain, L.ambientGain)
    uniforms.uShade2.value.set(L.steepChop, L.farLean, L.farLift, Math.max(1e-4, L.farView))
    uniforms.uChop.value.set(L.chopA * slope, L.chopB * slope, L.chopC * slope, L.gustDepth * Math.min(1.5, w))
    // (a slider dragged to zero must not leave a smoothstep without a width or a lobe without one)
    uniforms.uFoamP.value.set(
      Math.min(3, Math.max(0.3, L.foamThreshold + L.foamWind * (1 - w))), Math.max(0.02, L.foamSoftness), L.foamTrail,
      L.foamStreaks * Math.min(1.5, w * w),
    )
    uniforms.uFoamFar.value = L.foamFar * white
    uniforms.uSpec.value.set(L.glitter, Math.max(1e-5, L.glitterSharpness), L.reflection, L.landReflection)
    // the bank indicator falls about 0.025 per metre off the waterline
    uniforms.uShoreP.value.set(
      Math.max(0.2, L.shoreFoamReach) * 0.025, L.shoreFoamGain, Math.max(0.2, L.shoreScumReach) * 0.025, aniso(),
    )
    uniforms.uSkyline.value.set(L.skyline, L.skylineNorth, L.skylineSouth, 0)
    uniforms.uRefl.value.set(L.chopLean, L.reflectionLift, L.bumpContrast, L.chopContrast)
    uniforms.uRefl2.value.set(L.rippleContrast, L.skySaturation, 0, 0)
    const sun = app.atmos.sunDir
    const sunH = Math.hypot(sun.x, sun.z) || 1
    uniforms.uSunAway.value.set(-sun.x / sunH, -sun.z / sunH)
  }

  /** wrapped UV offset of a drifting, rotated square tile */
  function tileOffset(layer: { tile: number; rot: number; vx: number; vz: number }, t: number, out: THREE.Vector4, slot: 0 | 2) {
    const x = originX - layer.vx * t
    const z = originZ - layer.vz * t
    const c = Math.cos(layer.rot)
    const s = Math.sin(layer.rot)
    const u = fract((x * c - z * s) / layer.tile)
    const v = fract((x * s + z * c) / layer.tile)
    if (slot === 0) { out.x = u; out.y = v } else { out.z = u; out.w = v }
  }

  let debug: { update(): void; dispose(): void } | null = null
  let seaVersion = -1
  let kMin = 1

  function update() {
    const t = app.time
    const cx = app.view.x
    const cz = app.view.z
    originX = Math.round(cx / ORIGIN_SNAP) * ORIGIN_SNAP
    originZ = Math.round(cz / ORIGIN_SNAP) * ORIGIN_SNAP
    mesh.position.set(originX, 0, originZ)

    // each level's origin on its own 2-cell world lattice
    for (let l = 0; l < LEVELS; l++) {
      const s = grid.levels[l].cell
      const ix = 2 * Math.floor(cx / (2 * s))
      const iz = 2 * Math.floor(cz / (2 * s))
      levelUniforms[l].set(ix * s - originX, iz * s - originZ, ((ix % 4) + 4) % 4, ((iz % 4) + 4) % 4)
    }
    uniforms.uCenter.value.set(cx - originX, cz - originZ)
    wave.update(originX, originZ)

    // the sea's own numbers: peak wavenumber, the largest pixel that still resolves its
    // longest component, the phase of the lapping at the bank, the way the bumps travel
    if (seaVersion !== waves.version) {
      seaVersion = waves.version
      kMin = Infinity
      for (let i = 0; i < waves.n; i++) kMin = Math.min(kMin, waves.k[i])
    }
    // The per-pixel sea fades each component out as the pixel grows past a quarter of its
    // wavelength; a shorter reach makes the pixel count for more, so all of it is gone by the
    // footprint where the sum stops being evaluated. The lapping at the bank is fixed to the land.
    const reach = Math.min(1, Math.max(0, WATER_LOOK.farWaveReach))
    uniforms.uWaveInfo.value.set(
      waves.kp,
      0.6 / Math.max(reach, 0.05),
      (3.5 / kMin) * reach,
      fract(t / 3.1 + (0.07 * (originX - app.groundShift)) / (2 * Math.PI)) * Math.PI * 2,
    )
    const dir = (waves.params.dirDeg * Math.PI) / 180
    uniforms.uUvC.value.z = Math.cos(dir)
    uniforms.uUvC.value.w = Math.sin(dir)

    // drifting texture layers
    tileOffset(LAYERS.chopA, t, uniforms.uUvA.value, 0)
    tileOffset(LAYERS.chopB, t, uniforms.uUvA.value, 2)
    tileOffset(LAYERS.chopC, t, uniforms.uUvB.value, 0)
    {
      const S = LAYERS.streak
      const x = originX - S.vx * t
      const z = originZ - S.vz * t
      const c = Math.cos(S.rot)
      const s = Math.sin(S.rot)
      uniforms.uUvB.value.z = fract((x * c - z * s) / S.tileX)
      uniforms.uUvB.value.w = fract((x * s + z * c) / S.tileZ)
    }
    tileOffset(LAYERS.gust, t, uniforms.uUvC.value, 0)

    if (setup.swellTex) {
      ensureSwell()
      uniforms.uSwellUv.value.set(
        fract((originX - waves.cp * Math.cos(dir) * t) / swellTile),
        fract((originZ - waves.cp * Math.sin(dir) * t) / swellTile),
        1 / swellTile,
        waves.params.hs / swellHs,
      )
    }

    // the level slides through the water frame with the current
    const sh = shore.info
    uniforms.uShoreRect.value.set(
      sh.x0 - 0.5 * sh.step - originX + app.groundShift,
      sh.z0 - 0.5 * sh.step - originZ,
      1 / (sh.width * sh.step),
      1 / (sh.height * sh.step),
    )
    setLook()
    debug?.update()
  }

  const module: FeatureModule = {
    update,
    setQuality(q: Quality) {
      const next = tierSetup(q)
      const changed =
        next.farWaves !== setup.farWaves || next.swellTex !== setup.swellTex || next.detailC !== setup.detailC ||
        next.streaks !== setup.streaks || next.gusts !== setup.gusts || next.landRefl !== setup.landRefl ||
        next.gates !== setup.gates || next.skyVertex !== setup.skyVertex
      setup = next
      const a = aniso()
      for (const tex of [detail, streak, swell]) {
        if (tex && tex.anisotropy !== a) { tex.anisotropy = a; tex.needsUpdate = true }
      }
      if (changed) {
        material.defines = defines(setup)
        material.needsUpdate = true
        ensureSwell(true)
        ensureStreak()
      }
      const n = Math.max(64, Math.round(q.waterSegments / 4) * 4)
      if (n !== grid.n || q.tier !== gridTier) {
        const old = grid.geometry
        grid = makeGrid(q)
        gridTier = q.tier
        mesh.geometry = grid.geometry
        old.dispose()
        applyGrid()
      }
    },
    dispose() {
      debug?.dispose()
      app.scene.remove(mesh)
      grid.geometry.dispose()
      material.dispose()
      detail.dispose()
      shore.texture.dispose()
      streak?.dispose()
      swell?.dispose()
    },
  }
  if (debugMode > 0) {
    return import('./water/debug').then((m) => {
      // the markers belong to mode 1; the false-colour views keep only window.__waterCheck()
      debug = m.createWaterDebug(app, { mesh, material, uniforms, getGrid: () => grid, markers: debugMode === 1 })
      return module
    })
  }
  return module
}
