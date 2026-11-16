/**
 * One definition of the light and air, shared by every material so the sky, its reflection
 * in the water, the haze on the gorge walls and the lit rider all agree.
 *
 * Shader materials should spread `atmos.uniforms` into their own uniforms (the uniform
 * objects are shared by reference, so changing a value here updates every material) and
 * include SKY_GLSL. Built-in three.js materials get the same look from the lights and
 * scene.fog that the sky module sets up from these numbers.
 *
 * The fields of the Atmosphere object are the tuning surface: change them (a colour's
 * components, fogDensity, cloudCover ...) and the sky module pushes them into the uniforms,
 * the lights and scene.fog on the next frame through `syncAtmosphere`.
 *
 * What the GLSL gives a shader
 *   skyColor(dir)        sky radiance for a world direction with the *mean* cloud cover mixed
 *                        in (no cloud shapes): what rough water reflects. The sky module draws
 *                        skyClear() plus cloud shapes whose local average is close to this.
 *   skyClear(dir)        the cloudless gradient and the sun's glow
 *   skyCloudCover(dir)   mean cloud cover 0..1 (the marine bank in the western notch, the
 *                        broken deck streaming out of it, fair-weather cumulus elsewhere)
 *   applyHaze(col, dist) aerial perspective. Blue scatters in first, so a dark ridge goes
 *                        navy, then blue, then pale: the layered look of the gorge to the west
 *   skyLight(normal)     sun + hemisphere light on a matte surface, already divided by pi:
 *                        colour = albedo * skyLight(n) matches the built-in Lambert materials
 */
import * as THREE from 'three'

export interface Atmosphere {
  /** unit vector from the scene toward the sun (world space) */
  sunDir: THREE.Vector3
  sunColor: THREE.Color
  /** sky colours: straight up, at the horizon, and the haze that distant land fades into */
  zenith: THREE.Color
  horizon: THREE.Color
  haze: THREE.Color
  /** exponential fog density (1/m) for land and water (the green channel's; see fogTint) */
  fogDensity: number

  // ---- added by the sky module (everything above is the original contract) ----
  /** low sky toward the sun and the marine cloud bank in the western notch */
  horizonSun: THREE.Color
  /** the blue the sky deepens to on the sun's side, paler than `zenith` (the two meet overhead) */
  zenithSun: THREE.Color
  /** horizontal unit vector toward the western notch, where the cloud bank sits */
  bankDir: THREE.Vector3
  /** sunlit and shaded cloud */
  cloudLit: THREE.Color
  cloudShade: THREE.Color
  /** overall cloudiness: 0 = clear, 1 = the July afternoon of the place report, 1.6 = 60 % broken cloud */
  cloudCover: number
  /** per-channel multipliers on fogDensity (red, green, blue) */
  fogTint: THREE.Vector3
  /** hemisphere fill light: from the sky above and bounced off the water below */
  ambientSky: THREE.Color
  ambientGround: THREE.Color
  /** intensities of the directional and hemisphere lights (three.js units) */
  sunIntensity: number
  ambientIntensity: number
  /**
   * How fast the sky deepens from the horizon colour to the zenith colour with the sine of
   * the elevation: away from the sun (10.5: sky blue by ten degrees up) and toward it (4.5:
   * the air under the sun is milky three times as high).
   */
  skyFalloff: number
  skyFalloffSun: number

  uniforms: {
    uSunDir: { value: THREE.Vector3 }
    uSunColor: { value: THREE.Color }
    uSkyZenith: { value: THREE.Color }
    uSkyHorizon: { value: THREE.Color }
    uHaze: { value: THREE.Color }
    uFogDensity: { value: number }
    uSkyHorizonSun: { value: THREE.Color }
    uBankDir: { value: THREE.Vector3 }
    uCloudLit: { value: THREE.Color }
    uCloudShade: { value: THREE.Color }
    uCloudCover: { value: number }
    uFogTint: { value: THREE.Vector3 }
    /** sunColor * sunIntensity / pi */
    uSunLight: { value: THREE.Color }
    /** ambientSky and ambientGround * ambientIntensity / pi */
    uAmbientSky: { value: THREE.Color }
    uAmbientGround: { value: THREE.Color }
    /** x: skyFalloff, y: skyFalloffSun */
    uSkyFalloff: { value: THREE.Vector2 }
    uSkyZenithSun: { value: THREE.Color }
  }
}

/**
 * The Hatchery, mid-July, 5 pm: the sun is 38 degrees up and almost dead astern of a rider
 * heading downwind, a touch on the Washington side. Downwind is front-lit: the camera sees
 * the bright backs of the bumps ahead and the face being ridden as a darker band, which is
 * the clearest light of the afternoon for reading them. The Washington wall is in full
 * sun; the Oregon cliff is in sky-lit shade.
 *
 * Colours are fitted to the ones sampled from the owner's references (place report,
 * section C): sky #70A4D3 a few degrees over the Oregon rim and #88B5DB just above it,
 * #C0CDDF low under the marine cloud in the west, cumulus #EFF1EF. `horizon` is the sky at
 * zero elevation, paler than either sample (the rims hide the first 3 to 5 degrees), and
 * `zenith` the deep blue overhead that the gradient reaches by 20 degrees up. Toward the
 * sun the sky is milky instead: it pales three times as high (`skyFalloffSun`) and deepens
 * only to `zenithSun`, which is what the Hatchery drone clip shows between the clouds to
 * the west (#A7CCE4 to #B9CDE5 at 10 to 25 degrees up; drawn #9DBFE2).
 *
 * The air is clear (a marine push): the Washington wall 2 km off keeps its colour, a dark
 * ridge at 5 km is navy, at 12 km blue (#3F638D drawn, #1E498C in the drone clip before
 * its grade is taken down) and at 35 km pale blue (#567FB4) against the white bank. Haze by
 * distance, red / green / blue: 2 / 3 / 6 % at 1 km, 9 / 14 / 25 % at 5 km, 31 / 45 / 68 %
 * at 20 km.
 */
export function makeAtmosphere(): Atmosphere {
  // world axes: +x downwind (074 deg true), +y up, +z toward Oregon
  const sunDir = new THREE.Vector3(-0.78, 0.62, -0.11).normalize()
  const sunColor = new THREE.Color(1.0, 0.96, 0.88)
  const zenith = new THREE.Color(0x4a84ca)
  const horizon = new THREE.Color(0xbce8f2)
  const haze = new THREE.Color(0x8fb1d8)
  const fogDensity = 0.00003
  const horizonSun = new THREE.Color(0xc8d6e6)
  const zenithSun = new THREE.Color(0x74a9d8)
  // the notch is at 255-270 deg true: 6 degrees to the Washington side of straight upwind
  const bankDir = new THREE.Vector3(-0.9945, 0, -0.1045).normalize()
  const cloudLit = new THREE.Color(0xf3f4f2)
  const cloudShade = new THREE.Color(0xa9b9cf)
  const fogTint = new THREE.Vector3(0.62, 1.0, 1.9)
  const ambientSky = new THREE.Color(0xa9c8ee)
  const ambientGround = new THREE.Color(0x56706a)
  const atmos: Atmosphere = {
    sunDir, sunColor, zenith, horizon, haze, fogDensity,
    horizonSun, zenithSun, bankDir, cloudLit, cloudShade, cloudCover: 1, fogTint,
    ambientSky, ambientGround, sunIntensity: 3.0, ambientIntensity: 1.25,
    skyFalloff: 10.5, skyFalloffSun: 4.5,
    uniforms: {
      uSunDir: { value: sunDir },
      uSunColor: { value: sunColor },
      uSkyZenith: { value: zenith },
      uSkyHorizon: { value: horizon },
      uHaze: { value: haze },
      uFogDensity: { value: fogDensity },
      uSkyHorizonSun: { value: horizonSun },
      uBankDir: { value: bankDir },
      uCloudLit: { value: cloudLit },
      uCloudShade: { value: cloudShade },
      uCloudCover: { value: 1 },
      uFogTint: { value: fogTint },
      uSunLight: { value: new THREE.Color() },
      uAmbientSky: { value: new THREE.Color() },
      uAmbientGround: { value: new THREE.Color() },
      uSkyFalloff: { value: new THREE.Vector2(10.5, 4.5) },
      uSkyZenithSun: { value: zenithSun },
    },
  }
  syncAtmosphere(atmos)
  return atmos
}

/**
 * Push the plain fields into the uniforms that are derived from them. Vector and colour
 * uniforms share their objects with the fields, so only the scalars and the pre-multiplied
 * light colours need copying. Cheap; the sky module calls it every frame.
 */
export function syncAtmosphere(a: Atmosphere): void {
  const u = a.uniforms
  // (written only when changed: every { value } uniform shares one hidden class in V8, so a
  // number stored into one is boxed anew each time, and this runs every frame)
  if (u.uFogDensity.value !== a.fogDensity) u.uFogDensity.value = a.fogDensity
  if (u.uCloudCover.value !== a.cloudCover) u.uCloudCover.value = a.cloudCover
  u.uSunLight.value.copy(a.sunColor).multiplyScalar(a.sunIntensity / Math.PI)
  u.uAmbientSky.value.copy(a.ambientSky).multiplyScalar(a.ambientIntensity / Math.PI)
  u.uAmbientGround.value.copy(a.ambientGround).multiplyScalar(a.ambientIntensity / Math.PI)
  u.uSkyFalloff.value.set(a.skyFalloff, a.skyFalloffSun)
}

// ---------------------------------------------------------------------------------------
// cloud climatology: one set of numbers for the GLSL mean and the generated cloud panorama
// ---------------------------------------------------------------------------------------

/**
 * Where the clouds are, as mean cover against direction. `w` is how far round toward the
 * western notch a direction points (1 = at the notch, 0.5 = across the river, 0 = downwind)
 * and `h` its sine of elevation.
 *   bank     solid marine cloud filling the notch: whole to four and a half degrees up (the
 *            ridges in the notch hide the first two or three), thinning to nothing by ten
 *   deck     broken stratocumulus streaming east out of the bank, clearing overhead
 *   cumulus  fair-weather puffs over the ridges all round the horizon
 */
export const CLOUD_FIELD = {
  bankW0: 0.52, bankW1: 0.9, bankH0: 0.078, bankH1: 0.172, bankFill: 1.35,
  deckW0: 0.42, deckW1: 0.96, deckH0: 0.03, deckH1: 0.12, deckH2: 0.22, deckH3: 0.6, deckMax: 0.44,
  cumH0: 0.02, cumH1: 0.08, cumH2: 0.18, cumH3: 0.4, cumMax: 0.13,
} as const

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The three parts of the mean cloud cover for a unit direction; mirrors skyCloudCover() in GLSL. */
export function cloudCoverParts(
  dx: number, dy: number, dz: number, bankDir: THREE.Vector3, cover: number,
  out: { bank: number; deck: number; cumulus: number },
): void {
  const C = CLOUD_FIELD
  const h = Math.max(dy, 0)
  const w = Math.min(1, Math.max(0, 0.5 + 0.5 * (dx * bankDir.x + dz * bankDir.z)))
  out.bank = Math.min(1, C.bankFill * sstep(C.bankW0, C.bankW1, w) * (1 - sstep(C.bankH0, C.bankH1, h)) * Math.min(cover, 1.25))
  out.deck = Math.min(1, C.deckMax * sstep(C.deckW0, C.deckW1, w) * sstep(C.deckH0, C.deckH1, h) * (1 - sstep(C.deckH2, C.deckH3, h)) * cover)
  out.cumulus = Math.min(1, C.cumMax * sstep(C.cumH0, C.cumH1, h) * (1 - sstep(C.cumH2, C.cumH3, h)) * cover)
}

const f = (x: number) => x.toFixed(4)

/**
 * skyColor(dir), skyClear(dir), skyCloudCover(dir), applyHaze(color, dist), skyLight(normal):
 * see the header of this file.
 */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHaze;
uniform float uFogDensity;
uniform vec3 uSkyHorizonSun;
uniform vec3 uBankDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCloudCover;
uniform vec3 uFogTint;
uniform vec3 uSunLight;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec2 uSkyFalloff;
uniform vec3 uSkyZenithSun;

// 1 looking at the western notch under the sun, 0.5 across the river, 0 looking downwind
float skySunward(vec3 d) {
  return clamp(0.5 + 0.5 * dot(d.xz, uBankDir.xz), 0.0, 1.0);
}

// (the ...At functions take skySunward(d) as w, so a caller needing several computes it once)

// low-sky colour for a direction: clear blue downwind, bright and milky toward the sun
vec3 skyHorizonAt(float w) {
  return mix(uSkyHorizon, uSkyHorizonSun, smoothstep(0.45, 1.0, w));
}
vec3 skyHorizonColor(vec3 d) {
  return skyHorizonAt(skySunward(d));
}

vec3 skyClearAt(vec3 d, float w) {
  float h = max(d.y, 0.0);
  vec3 hor = skyHorizonAt(w);
  // pale in the first few degrees, sky blue by ten, deep overhead. Fitted to the owner's
  // telephoto still of the Oregon rim (#8AB6D9 at 5 degrees up, #6A9DCF at 9) to within 8 levels.
  // Toward the sun the air is milky much higher up (the drone clip's sky between the clouds).
  float sunSide = smoothstep(0.5, 1.0, w);
  vec3 col = mix(mix(uSkyZenith, uSkyZenithSun, sunSide), hor, exp(-mix(uSkyFalloff.x, uSkyFalloff.y, sunSide) * h));
  // below the horizon (reflections of grazing rays off tilted water): the low sky, a shade darker
  col = mix(col, hor * 0.9, 1.0 - smoothstep(-0.12, 0.0, d.y));
  float sd = max(dot(d, uSunDir), 0.0);
  float s2 = sd * sd;
  float s8 = s2 * s2; s8 *= s8;
  float s64 = s8 * s8; s64 *= s64; s64 *= s64;
  // broad forward-scatter glow around the sun
  col += uSunColor * (0.16 * s8 + 0.32 * s64);
  return col;
}
vec3 skyClear(vec3 d) {
  return skyClearAt(d, skySunward(d));
}

float skyCloudCoverAt(vec3 d, float w) {
  float h = max(d.y, 0.0);
  float c1 = min(uCloudCover, 1.25);
  float bank = min(1.0, ${f(CLOUD_FIELD.bankFill)} * smoothstep(${f(CLOUD_FIELD.bankW0)}, ${f(CLOUD_FIELD.bankW1)}, w) * (1.0 - smoothstep(${f(CLOUD_FIELD.bankH0)}, ${f(CLOUD_FIELD.bankH1)}, h)) * c1);
  float deck = ${f(CLOUD_FIELD.deckMax)} * smoothstep(${f(CLOUD_FIELD.deckW0)}, ${f(CLOUD_FIELD.deckW1)}, w)
    * smoothstep(${f(CLOUD_FIELD.deckH0)}, ${f(CLOUD_FIELD.deckH1)}, h) * (1.0 - smoothstep(${f(CLOUD_FIELD.deckH2)}, ${f(CLOUD_FIELD.deckH3)}, h)) * uCloudCover;
  float cum = ${f(CLOUD_FIELD.cumMax)} * smoothstep(${f(CLOUD_FIELD.cumH0)}, ${f(CLOUD_FIELD.cumH1)}, h) * (1.0 - smoothstep(${f(CLOUD_FIELD.cumH2)}, ${f(CLOUD_FIELD.cumH3)}, h)) * uCloudCover;
  return clamp(max(bank, deck) + cum, 0.0, 1.0) * step(0.0, d.y);
}
float skyCloudCover(vec3 d) {
  return skyCloudCoverAt(d, skySunward(d));
}

// mean colour of the cloud in a direction: grey-white under the sun, white where it is front-lit
vec3 skyCloudColor(vec3 d) {
  return mix(uCloudLit, uCloudShade, 0.25 + 0.4 * skySunward(d));
}

vec3 skyColor(vec3 d) {
  float w = skySunward(d);
  return mix(skyClearAt(d, w), mix(uCloudLit, uCloudShade, 0.25 + 0.4 * w), skyCloudCoverAt(d, w));
}

vec3 applyHaze(vec3 color, float dist) {
  vec3 fog = 1.0 - exp(-uFogDensity * dist * uFogTint);
  return mix(color, uHaze, fog);
}

vec3 skyLight(vec3 n) {
  return uSunLight * max(dot(n, uSunDir), 0.0) + mix(uAmbientGround, uAmbientSky, 0.5 + 0.5 * n.y);
}
`
