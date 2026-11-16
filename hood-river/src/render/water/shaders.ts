/**
 * GLSL for the river surface.
 *
 * Vertex: places the (i, j, level) lattice of geometry.ts in the world (snap + morph), then
 * displaces it with the shared wave function, so the drawn surface is the physics surface.
 * Fragment: shading whose first job is letting the player read the bumps.
 *
 * Everything is computed in a local frame (the mesh origin O, snapped to ORIGIN_SNAP
 * metres, near the rider): positions, wave phases and texture offsets stay small numbers
 * on phones, and the CPU wraps every offset in double precision.
 */
import { WAVE_GLSL } from '../../sim/waves'
import { SKY_GLSL } from '../atmosphere'
import { BED_DEPTH, BED_REACH, SHORE_DEEP_MAX, SHORE_DEPTH_MAX, SWELL_SLOPE_MAX } from './textures'

/** number of nested levels (ring sizes double from level to level) */
export const LEVELS = 4

/**
 * Texture layers: tile length in metres, rotation of the tile (radians) and the velocity
 * (m/s, water frame) the pattern drifts at. The CPU turns these into wrapped UV offsets.
 */
export const LAYERS = {
  /** chop, 0.7 - 6 m waves, running downwind at their own phase speed: the lumps on the bumps */
  chopA: { tile: 21.3, rot: 0, vx: 1.9, vz: 0.15 },
  /** chop, 0.2 - 1.4 m */
  chopB: { tile: 4.3, rot: 0.5, vx: 0.85, vz: -0.2 },
  /** ripples, 5 - 40 cm: what the water next to the board is made of */
  chopC: { tile: 1.27, rot: -0.9, vx: 0.45, vz: 0.1 },
  /** the streak texture, 8 times longer along the wind than across it: foam lines (R) and lanes of rougher water (G) */
  streak: { tileX: 96, tileZ: 12, rot: 0.055, vx: 0.3, vz: 0 },
  /** gust patches: darker, rougher water travelling downwind faster than the bumps */
  gust: { tile: 310, rot: 0.25, vx: 8.5, vz: 0.6 },
} as const

const fl = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x))
/**
 * log2 of the pixel footprint (m) at which the texture filter starts to average a chop
 * layer away: the 256-texel tile holds waves of 12 to 85 texels, and a mip level keeps
 * those longer than about 4 of its texels. The layer is gone 2.87 octaves later.
 */
const filterStart = (tile: number) => fl(+(4.41 - Math.log2(256 / tile)).toFixed(3))
const rotB = [Math.cos(LAYERS.chopB.rot), Math.sin(LAYERS.chopB.rot)]
const rotC = [Math.cos(LAYERS.chopC.rot), Math.sin(LAYERS.chopC.rot)]
const rotG = [Math.cos(LAYERS.gust.rot), Math.sin(LAYERS.gust.rot)]
const rotS = [Math.cos(LAYERS.streak.rot), Math.sin(LAYERS.streak.rot)]

/**
 * SKY_VERTEX (an option, off by default: see TierSetup.skyVertex in water.ts): the sky is
 * evaluated per vertex, at these sines of elevation along the line of sight, and the
 * fragment shader mixes the four by the reflected ray's elevation. The mixing coordinate is
 * the shape of the sky's own gradient, exp(-10.5 h), as a rational fit that needs no exp
 * per pixel.
 */
const SKY_H = [0.02, 0.07, 0.2, 0.6]
const skyT = (h: number) => {
  const x = 10.5 * h
  return 1 / (1 + x * (1 + x * (0.5 + x * 0.1667)))
}
const SKY_T = SKY_H.map(skyT)
const skyK = (i: number) => fl(+(1 / (SKY_T[i] - SKY_T[i + 1])).toFixed(5))

/**
 * Compile-time switch: SKY_VERTEX (0 or 1), see WATER_FRAGMENT.
 */
export const WATER_VERTEX = /* glsl */ `
precision highp float;
${WAVE_GLSL}
#if SKY_VERTEX
${SKY_GLSL}
uniform vec3 uCamLocal;
uniform vec4 uRefl2;
// the sky a rough surface mirrors here, at four elevations along the line of sight
varying vec3 vSky0;
varying vec3 vSky1;
varying vec3 vSky2;
varying vec3 vSky3;

vec3 skyAt(vec2 away, float h) {
  vec3 c = skyColor(vec3(away.x, h, away.y) * vec3(sqrt(1.0 - h * h), 1.0, sqrt(1.0 - h * h)));
  return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uRefl2.y);
}
#endif

#define LEVELS ${LEVELS}
// per level: xy = snapped level origin relative to the mesh origin (m), zw = the origin's lattice index mod 4
uniform vec4 uLevel[LEVELS];
// per level: x = half extent (m), y = morph start (fraction of the half extent), z = 1 / morph width
uniform vec4 uMorph[LEVELS];
// rider (the unsnapped centre of the rings) relative to the mesh origin
uniform vec2 uCenter;
// x = cell size of level 0, y = culling margin (m), zw = Chebyshev distances between which every component is
// faded out (the flat rim)
uniform vec4 uGrid;
// x = peak wavenumber
uniform vec4 uWaveInfo;
// view frustum (left, right, bottom, top, near) in the mesh's frame: xyz = inward normal, w = offset
uniform vec4 uCull[5];

varying vec3 vLocal;
// xy = gradient of the resolved waves, z = crest (linear elevation / (Hs/2)), w = how much of
// the peak wave the mesh still carries here (1 near the rider, 0 in the far field)
varying vec4 vWave;

void main() {
  vec2 p;
  float eta = -0.02;
  vec4 wv = vec4(0.0);
  float inView = 1.0;
  float lvl = position.z;
  if (lvl < -0.5) {
    // skirt: metres from the outermost level's origin, flat, just under the rim it overlaps
    p = position.xy + uLevel[LEVELS - 1].xy;
  } else {
    int li = int(lvl + 0.5);
    float s = uGrid.x * exp2(lvl);
    vec4 lv = uLevel[li];
    vec4 mo = uMorph[li];
    p = position.xy * s + lv.xy;
    // morph odd lattice lines onto the parent lattice toward the outer edge of the level
    vec2 q = abs(p - uCenter);
    float a = clamp((max(q.x, q.y) / mo.x - mo.y) * mo.z, 0.0, 1.0);
    vec2 m = mod(position.xy + lv.zw, 4.0);
    vec2 off = step(2.5, m) - step(0.5, m) * (1.0 - step(1.5, m));
    p += off * (a * s);

    // Local cell size as a continuous function of world position only (both levels of an
    // overlap get the same number): the staircase the morphs produce, each level's band
    // doubling the cell. The straight-line distance is never less than the one the mesh
    // uses, so this never under-states the cell.
    q = p - uCenter;
    float d = length(q);
    float cell = 1.0;
    float w = 1.0;
    for (int l = 0; l < LEVELS; l++) {
      vec4 ml = uMorph[l];
      cell += w * clamp((d / ml.x - ml.y) * ml.z, 0.0, 1.0);
      w *= 2.0;
    }
    cell *= uGrid.x;
    // every component is gone before the rim, so the skirt can be flat
    cell += 1000.0 * smoothstep(uGrid.z, uGrid.w, max(abs(q.x), abs(q.y)));

    // Vertices well outside the view skip the wave sum and stay flat on their lattice
    // points (the margin covers the tallest wave and the largest triangle of this level),
    // which roughly halves the vertex work: half of every ring is behind the camera.
    vec3 flat0 = vec3(p.x, 0.0, p.y);
    float inside = min(
      min(dot(uCull[0].xyz, flat0) + uCull[0].w, dot(uCull[1].xyz, flat0) + uCull[1].w),
      min(min(dot(uCull[2].xyz, flat0) + uCull[2].w, dot(uCull[3].xyz, flat0) + uCull[3].w), dot(uCull[4].xyz, flat0) + uCull[4].w));
    eta = 0.0;
    inView = step(-(uGrid.y + 3.0 * s), inside);
    if (inView > 0.5) {
      vec4 ws = waveSurface(p, cell);
      eta = ws.x;
      wv = vec4(ws.yz, ws.w, 1.0 - smoothstep(0.9, 2.1, uWaveInfo.x * cell));
    }
  }
#if SKY_VERTEX
  vSky0 = vec3(0.0);
  vSky1 = vec3(0.0);
  vSky2 = vec3(0.0);
  vSky3 = vec3(0.0);
  if (inView > 0.5) {
    // (a flat surface mirrors the ray that continues the line of sight)
    vec2 away = p - uCamLocal.xz;
    away *= inversesqrt(max(dot(away, away), 1e-6));
    vSky0 = skyAt(away, ${fl(SKY_H[0])});
    vSky1 = skyAt(away, ${fl(SKY_H[1])});
    vSky2 = skyAt(away, ${fl(SKY_H[2])});
    vSky3 = skyAt(away, ${fl(SKY_H[3])});
  }
#endif
  vLocal = vec3(p.x, eta, p.y);
  vWave = wv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p.x, eta, p.y, 1.0);
}
`

/**
 * Compile-time switches, each 0 or 1 (set per tier in water.ts)
 *   FAR_WAVES     re-evaluate the physics sea per pixel where the mesh has faded it out (high tier)
 *   SWELL_TEX     instead, shade the far field with the baked swell texture (low and mid tiers)
 *   DETAIL_C      third, finest chop layer
 *   STREAKS       the streak texture: foam lines along the wind and lanes of rougher water
 *   GUSTS         gust patches
 *   LAND_REFL     the gorge walls in the reflection
 *   GATES         skip the glitter, the foam and the riverbed on the pixels that have none (no visible change)
 *   SKY_VERTEX    take the reflected sky from four per-vertex samples of skyColor() instead of one per pixel (an option)
 *   DEBUG_VIEW    ?waterdebug=2..7 false-colour views
 */
export const WATER_FRAGMENT = /* glsl */ `
precision highp float;
${SKY_GLSL}
${WAVE_GLSL}

uniform vec3 uCamLocal;
uniform sampler2D uDetail;
uniform sampler2D uShore;
#if STREAKS
uniform sampler2D uStreak;
#endif
#if SWELL_TEX
uniform sampler2D uSwell;
// xy = offset, z = 1 / tile, w = amplitude now / amplitude baked
uniform vec4 uSwellUv;
#endif
// ground rectangle of the shore texture in local coordinates: xy = edge, zw = 1 / size
uniform vec4 uShoreRect;
uniform vec4 uUvA; // chop A (xy), chop B (zw)
uniform vec4 uUvB; // chop C (xy), streaks (zw)
uniform vec4 uUvC; // gusts (xy); zw = unit vector the bumps travel along
uniform vec3 uBodyColor;
uniform vec3 uScatterColor;
uniform vec3 uSandColor;
uniform vec3 uFoamColor;
uniform vec3 uExtinction;
uniform vec3 uLandN;
uniform vec3 uLandS;
uniform vec4 uShade;    // x relief exponent, y crest brightening, z scatter gain, w ambient gain
uniform vec4 uShade2;   // x = share of the chop in the in-water light when seen from steep above, y = share of the lean kept at the horizon,
                        // z = share of the reflection's lift kept at the horizon, w = sine of the view elevation above which neither is reduced
uniform vec4 uChop;     // x, y, z = slope gain of chop A, B, C; w = gust depth
uniform vec4 uFoamP;    // x crest height at which a bump breaks, y softness, z trail gain, w opacity of the windrows
uniform float uFoamFar;  // share of far water that is whitecap
uniform vec4 uSpec;     // x glitter gain, y smallest slope variance, z reflection gain, w land reflection
uniform vec4 uShoreP;   // x reach of the bank foam (in bank units, 0.025 per metre), y its gain, z reach of the scum, w anisotropy of the detail texture
uniform vec4 uWaveInfo; // x = peak wavenumber, y = cell size per metre of pixel footprint for the per-pixel sea, z = largest footprint at which
                        // it is evaluated, w = phase of the lapping at the bank
uniform vec4 uSkyline;  // x = tan(elevation) of the skyline ahead and astern, y = extra toward Washington, z = extra toward Oregon
uniform vec4 uRefl;     // x = lean of the visible facets toward the viewer at grazing angles (1.25 x rms chop slope), y = lift of the
                        // reflected ray per unit of unresolved slope, z = bump slope gain and w = share of the large chop in the Fresnel term
uniform vec4 uRefl2;    // x = share of the small chop in the Fresnel term, y = saturation of the reflected sky
uniform vec2 uSunAway;  // horizontal unit vector pointing away from the sun
#if DEBUG_VIEW
uniform float uDebug;
#endif

varying vec3 vLocal;
varying vec4 vWave;
#if SKY_VERTEX
varying vec3 vSky0;
varying vec3 vSky1;
varying vec3 vSky2;
varying vec3 vSky3;
#endif

const float CHOP_BIAS = 0.35;
const vec2 ROT_B = vec2(${fl(rotB[0])}, ${fl(rotB[1])});
const vec2 ROT_C = vec2(${fl(rotC[0])}, ${fl(rotC[1])});
const vec2 ROT_G = vec2(${fl(rotG[0])}, ${fl(rotG[1])});
const vec2 ROT_S = vec2(${fl(rotS[0])}, ${fl(rotS[1])});

void main() {
  vec2 p = vLocal.xz;
  vec3 toCam = uCamLocal - vLocal;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // size of this pixel on the water (m): long axis, and what the texture filter resolves
  vec2 dpx = dFdx(p);
  vec2 dpy = dFdy(p);
  float fpx = length(dpx);
  float fpy = length(dpy);
  float fp = max(fpx, fpy);
  float fpe = max(fp / uShoreP.w, min(fpx, fpy));

  // ---- the level under this pixel: depth, bank, how big the bumps are here
  vec4 sh = texture2D(uShore, (p - uShoreRect.xy) * uShoreRect.zw);
  // bank > 0 is land as the terrain draws it; its bed shelves to BED_DEPTH by bank = -BED_REACH
  float bank = sh.g * 2.0 - 1.0;
  float bed = min(sh.r * sh.r * ${fl(SHORE_DEPTH_MAX)}, ${fl(BED_DEPTH)} * smoothstep(0.0, ${fl(BED_REACH)}, -bank) + 30.0 * smoothstep(0.5, 1.0, -bank));
  float deep = sh.b * ${fl(SHORE_DEEP_MAX)};
  float E = uWaveEnvMode > 0.5 ? sh.a : waveEnvelope(p);

  // ---- the bumps: gradient and crest height from the mesh, from the sea itself beyond it
  vec2 g = vWave.xy;
  float cr = vWave.z;
  float near = vWave.w;
#if FAR_WAVES
  if (near < 0.995 && fp < uWaveInfo.z) {
    vec4 w = waveSurface(p, uWaveInfo.y * fp);
    float b = smoothstep(0.7, 0.995, near);
    g = mix(w.yz, g, b);
    cr = mix(w.w, cr, b);
  }
#endif
#if SWELL_TEX
  vec4 sw = texture2D(uSwell, p * uSwellUv.z + uSwellUv.xy);
  // (like the per-pixel sea, its bumps are gone before a pixel is as long as they are: beyond
  // that one crest per tile would show as a ruled line; their slope then counts as roughness)
  float farW = (1.0 - near) * E * uSwellUv.w * (1.0 - smoothstep(1.5, 3.5, uWaveInfo.x * fp));
  g += (sw.xy - 0.5) * (${fl(2 * SWELL_SLOPE_MAX)} * farW);
  cr += (sw.z * 4.0 - 1.5) * farW;
#endif

  // ---- chop: generated detail normals in two or three sizes, lanes and gusts
  // (a small positive mip bias keeps features about a pixel tall from flickering as they drift)
  vec4 dA = texture2D(uDetail, p * ${fl(1 / LAYERS.chopA.tile)} + uUvA.xy, CHOP_BIAS);
  vec2 pb = vec2(p.x * ROT_B.x - p.y * ROT_B.y, p.x * ROT_B.y + p.y * ROT_B.x);
  vec4 dB = texture2D(uDetail, pb * ${fl(1 / LAYERS.chopB.tile)} + uUvA.zw, CHOP_BIAS);
#if STREAKS
  // (the lines lie on lumpy water: the large chop pushes them a few centimetres about)
  vec2 pw = p + (dA.xy - 0.5) * 0.5;
  vec2 ps = vec2(pw.x * ROT_S.x - pw.y * ROT_S.y, pw.x * ROT_S.y + pw.y * ROT_S.x);
  vec4 st = texture2D(uStreak, ps * vec2(${fl(1 / LAYERS.streak.tileX)}, ${fl(1 / LAYERS.streak.tileZ)}) + uUvB.zw);
  float lane = st.g;
#else
  float lane = 0.5;
#endif
#if GUSTS
  vec2 pg = vec2(p.x * ROT_G.x - p.y * ROT_G.y, p.x * ROT_G.y + p.y * ROT_G.x);
  float gust = texture2D(uDetail, pg * ${fl(1 / LAYERS.gust.tile)} + uUvC.xy).a;
#else
  float gust = 0.5;
#endif
  // how hard the wind is working this patch: sheltered water inshore, lanes, gusts
  float open = smoothstep(0.08, 0.55, E);
  float wind = (0.5 + 0.5 * open) * (1.0 + uChop.w * (gust * 2.0 - 1.0)) * (0.8 + 0.4 * lane);
  // the large chop (the lumps on the bumps) and the small (what reads as wind) are kept apart:
  // the reflection takes less of the large, so the lumps do not hide the bumps
  vec2 sB = dB.xy - 0.5;
  vec2 gdA = (dA.xy - 0.5) * uChop.x;
  vec2 gdF = vec2(sB.x * ROT_B.x + sB.y * ROT_B.y, sB.y * ROT_B.x - sB.x * ROT_B.y) * uChop.y;
  float lfp = log2(max(fpe, 1e-4));
  // share of each layer's slope variance the texture filter has averaged away
  float lostA = 1.0 - clamp((${filterStart(LAYERS.chopA.tile)} - lfp) / 2.87, 0.0, 1.0);
  float lostB = 1.0 - clamp((${filterStart(LAYERS.chopB.tile)} - lfp) / 2.87, 0.0, 1.0);
  float varU = uChop.x * uChop.x * lostA + uChop.y * uChop.y * lostB;
#if DETAIL_C
  vec2 pc = vec2(p.x * ROT_C.x - p.y * ROT_C.y, p.x * ROT_C.y + p.y * ROT_C.x);
  vec4 dC = texture2D(uDetail, pc * ${fl(1 / LAYERS.chopC.tile)} + uUvB.xy, CHOP_BIAS);
  vec2 sC = dC.xy - 0.5;
  gdF += vec2(sC.x * ROT_C.x + sC.y * ROT_C.y, sC.y * ROT_C.x - sC.x * ROT_C.y) * uChop.z;
  // the same sample's lace is the fine froth of foam seen close up
  float froth = 0.84 + 0.16 * dC.b;
  varU += uChop.z * uChop.z * (1.0 - clamp((${filterStart(LAYERS.chopC.tile)} - lfp) / 2.87, 0.0, 1.0));
#else
  float froth = 0.94;
  // the ripples this tier does not draw are still there as roughness
  varU += uChop.z * uChop.z;
#endif
  gdA *= wind;
  gdF *= wind;
  vec2 gd = gdA + gdF;
  // 0.0204 = (rms of a stored slope)^2; bumps the pixel cannot resolve count as roughness too
  varU = uSpec.y + 0.0204 * wind * wind * varU + 0.012 * E * E * (1.0 - near) * smoothstep(0.5, 6.0, fp);

  vec3 Nw = normalize(vec3(-g.x, 1.0, -g.y));
  vec2 gt = g + gd;
  vec3 N = normalize(vec3(-gt.x, 1.0, -gt.y));

  // ---- which way the visible water faces
  // Seen at a grazing angle, chop hides its own far sides: what shows is the facets tilted
  // toward the viewer, by about 1.25 x the rms slope. That is why wind-blown water shows its
  // own colour rather than the sky, bright when the sun is behind the viewer and dark when
  // he looks up-sun. The bump under the pixel is resolved, so it is not biased this way.
  // Toward the horizon the tilt that still shows shrinks (only the crests are in view, and
  // the flattest of their facets reflect by far the most): the water goes over to the low sky.
  float nvw = max(dot(Nw, V), 0.0);
  float graze = 1.0 - nvw;
  graze *= graze;
  float low = 1.0 - smoothstep(0.08 * uShade2.w, uShade2.w, V.y);
  vec3 toward = normalize(vec3(V.x, 0.0, V.z) + 1e-5) * (uRefl.x * wind * graze);
  vec3 lean = toward * mix(1.0, uShade2.y, low);

  // ---- light inside the water: bright backs, dark faces
  // (seen from steep above, reflection no longer draws the chop: there it tilts this light
  // instead, the small chop more than the lumps)
  float steep = uShade2.x * nvw * nvw;
  vec2 gl = g + steep * (0.6 * gdA + 1.4 * gdF);
  vec3 Nl = normalize(vec3(-gl.x, 1.0, -gl.y) + lean);
  float nl = max(dot(Nl, uSunDir), 0.0);
  float lit = pow(nl / max(uSunDir.y, 0.15), uShade.x);   // 1 on flat water seen from above
  vec3 irr = uSunLight * (uSunDir.y * lit) + uAmbientSky * uShade.w;
  float h01 = clamp(0.5 + 0.5 * cr, 0.0, 1.7);
  // the deep channel is a shade darker than the shelf, rough lanes a shade darker than smooth
  vec3 body = uBodyColor * irr * (1.0 + uShade.y * (h01 - 0.5)) * (1.1 - 0.2 * smoothstep(3.0, 16.0, deep)) * (1.06 - 0.12 * lane);
  // thin water near a crest lets the light back out: emerald where the sun is on it, and a
  // glow in the lip of a steep face seen from down-sun
  float toSun = max(dot(V.xz, uSunAway), 0.0);
  float lip = smoothstep(0.95, 1.5, h01) * clamp(0.3 + 3.0 * dot(Nw.xz, V.xz), 0.0, 1.0) * toSun * toSun;
  float thin = smoothstep(0.55, 1.35, h01) * lit * 0.6 + lip * 0.3;
  body += uScatterColor * uSunLight * (uShade.z * thin * open);

  // ---- shallows: the sand shows through (and whatever lies under the land mesh is sand)
  // (its mottling is drawn only close up: from high above one tile of it would show as a lattice)
  // (nothing shows from ${fl(SHORE_DEPTH_MAX)} m down, where the shore texture's depth ends: most of the river skips this)
  vec3 seen = vec3(0.0);
#if GATES
  if (bed < ${fl(SHORE_DEPTH_MAX - 0.01)}) {
#endif
  seen = exp(-bed * uExtinction) * (1.0 - smoothstep(${fl(SHORE_DEPTH_MAX - 3)}, ${fl(SHORE_DEPTH_MAX)}, bed));
  float mottle = mix(dA.a, 0.5, smoothstep(0.12, 0.7, fp));
  body = mix(body, uSandColor * irr * (0.85 + 0.3 * mottle), seen);
#if GATES
  }
#endif

  // ---- reflection of the sky (and the gorge walls) in rough water
  // How much is reflected is decided mostly by the bump under the pixel (its slope
  // exaggerated a little), so a back tilted toward the camera shows the water's own colour
  // and a trough the sky: that contrast is what draws the bumps. What is reflected comes
  // from the full normal, chop included.
  float sig = sqrt(varU);
  vec2 gf = g * mix(uRefl.z, 1.0, low) + gdA * uRefl.w + gdF * uRefl2.x;
  float nv = clamp(dot(normalize(vec3(-gf.x, 1.0, -gf.y) + lean), V), 0.0, 1.0);
  float nv1 = 1.0 - nv;
  float nv2 = nv1 * nv1;
  float fres = 0.02 + 0.98 * nv2 * nv2 * nv1;
  vec3 R = reflect(-V, normalize(N + toward * (1.0 - low)));
  // a ray reflected downward meets the next bump, not the sky
  float dive = 1.0 - smoothstep(-0.3, 0.02, R.y);
  R.y = max(R.y, 0.0) + uRefl.y * sig * mix(1.0, uShade2.z, low) + 0.015;
  R = normalize(R);
#if SKY_VERTEX
  // the four per-vertex samples, mixed along the sky's own gradient exp(-10.5 h) (a rational fit of it)
  float xs = 10.5 * R.y;
  float ts = 1.0 / (1.0 + xs * (1.0 + xs * (0.5 + xs * 0.1667)));
  vec3 refl = mix(vSky3, vSky2, clamp((ts - ${fl(+SKY_T[3].toFixed(6))}) * ${skyK(2)}, 0.0, 1.0));
  refl = mix(refl, vSky1, clamp((ts - ${fl(+SKY_T[2].toFixed(6))}) * ${skyK(1)}, 0.0, 1.0));
  refl = mix(refl, vSky0, clamp((ts - ${fl(+SKY_T[1].toFixed(6))}) * ${skyK(0)}, 0.0, 1.25));
#else
  vec3 refl = skyColor(R);
  // (a rough surface gathers its reflection from a wide patch of sky: paler than any one direction)
  refl = mix(vec3(dot(refl, vec3(0.2126, 0.7152, 0.0722))), refl, uRefl2.y);
#endif
#if LAND_REFL
  float az = R.z / max(length(R.xz), 1e-3);
  float azN = max(-az, 0.0);
  float azS = max(az, 0.0);
  float rim = uSkyline.x + uSkyline.y * azN * azN + uSkyline.z * azS * azS;
  float soft = 0.03 + 1.5 * sig;
  float landR = (1.0 - smoothstep(rim - soft, rim + soft, R.y)) * uSpec.w;
  refl = mix(refl, mix(uLandN, uLandS, smoothstep(-0.25, 0.25, az)), landR);
#endif
  refl = mix(refl, body + 0.12 * uAmbientSky, dive * 0.85);
  vec3 col = mix(body, refl, min(fres * uSpec.z, 1.0));

  // ---- sun glitter: sparkles near, a sheen far off, only when looking up-sun
  // (Cook-Torrance with a Beckmann lobe as wide as the slopes the pixel cannot resolve)
  vec3 H = normalize(V + uSunDir);
  float nh = max(dot(N, H), 0.001);
  float nh2 = nh * nh;
#if GATES
  // Only a facet within reach of the sun's mirror direction can sparkle: everywhere else
  // (all the water down-sun, most of it up-sun) the lobe is under e^-15 and is skipped.
  if (1.0 - nh2 < 30.0 * varU * nh2) {
#endif
  float D = exp((nh2 - 1.0) / (nh2 * 2.0 * varU)) / (6.2832 * varU * nh2 * nh2);
  float vh = max(dot(V, H), 0.001);
  float vf = 1.0 - vh;
  float vf2 = vf * vf;
  float fh = 0.02 + 0.98 * vf2 * vf2 * vf;
  float nvs = max(dot(N, V), 0.02);
  float nls = max(dot(N, uSunDir), 0.0);
  // geometry term over 4 (N.V): facets hide each other at grazing angles
  float vis = min(0.25 / nvs, min(0.5 * nh / vh, 0.5 * nh * nls / (vh * nvs)));
  col += uSunColor * min(uSpec.x * fh * D * vis, 4.0);
#if GATES
  }
#endif

  // ---- foam
  float lace = dB.b;
  float hole = 1.0 - lace;
  float brk2 = dB.a - 0.5;
  // (along the way the bumps travel: positive on the steep front face)
  float front = -dot(g, uUvC.zw);
  float tall = cr + 0.42 * (dA.a - 0.5) + 0.45 * brk2;
  float foam = 0.0;
  float cap = 0.0;
  float trail = 0.0;
#if STREAKS
  // The wind combs foam out into lines. On open water only the strong lines of the streak
  // texture show, faintly, where the lanes are rough (windrows); behind a whitecap all of them.
  // (lines of bubbles, not ribbons: they show where the lace does, in patches)
  float lines = smoothstep(0.1, 0.5, st.r);
  float rows = smoothstep(0.5, 0.95, st.r) * (0.4 + 0.6 * smoothstep(0.3, 0.7, lane)) * smoothstep(0.2, 0.6, dA.a) * open;
  foam = uFoamP.w * smoothstep(0.0, 0.6, 1.25 * rows - 1.4 * hole);
#endif
#if GATES
  // The rest is for water near breaking, at the bank, or too far off to draw its whitecaps
  // one by one: everywhere else all of it is zero.
  if (tall > uFoamP.x - 0.5 || -bank < max(uShoreP.x, uShoreP.z) || fp > 2.0) {
#endif
  // Whitecaps: a bump that stands tall enough breaks. The foam starts on the crest and
  // spills down the steep front (downwind) face; the taller the bump, the wider the cap.
  float spill = tall + 0.5 * clamp(front, -0.2, 0.5);
  cap = smoothstep(uFoamP.x, uFoamP.x + uFoamP.y, spill) * smoothstep(-0.14, 0.04, front + 0.12 * brk2);
  // foam left on the back behind the crest: rafts close to it, thinning to filaments
  trail = smoothstep(uFoamP.x - 0.4, uFoamP.x + 0.15, tall) * smoothstep(0.0, 0.16, -front) * uFoamP.z;
  foam = max(foam, smoothstep(0.0, 0.35, 1.05 * cap - 0.98 * hole * (1.25 - 0.3 * cap)));
#if STREAKS
  foam = max(foam, 0.85 * max(smoothstep(0.0, 0.4, trail - 0.92 * hole), smoothstep(0.0, 0.5, 1.5 * trail * lines * (0.25 + 0.75 * dA.a) - 0.95 * hole)));
#else
  foam = max(foam, 0.85 * smoothstep(0.0, 0.4, trail - 0.92 * hole));
#endif
  // the bank: lapping foam on the waterline of the land mesh, scum for a few metres off it
  float lap = 0.55 + 0.45 * sin(uWaveInfo.w + p.x * 0.07 + dA.a * 9.0);
  float onWater = 1.0 - smoothstep(0.06, 0.2, bank);
  float wash = (1.0 - smoothstep(0.0, uShoreP.x * lap, -bank)) * uShoreP.y * onWater;
  float scum = (1.0 - smoothstep(0.0, uShoreP.z, -bank)) * 0.45 * uShoreP.y * onWater;
  foam = max(foam, smoothstep(0.0, 0.35, wash - 0.6 * hole));
  foam = max(foam, 0.7 * smoothstep(0.0, 0.4, scum - 0.85 * hole));
  // far off, where a pixel holds whole bumps, the whitecaps are a paleness, patchy with the gusts
  foam = max(foam, uFoamFar * open * (0.5 + gust) * smoothstep(2.0, 10.0, fp));
  // aerated water around a breaking crest
  float aer = smoothstep(uFoamP.x - 0.25, uFoamP.x + 0.1, spill) * (1.0 - foam);
  col += uScatterColor * uSunLight * (0.4 * aer * open);
#if GATES
  }
  if (foam > 0.0) {
#endif
  // foam is lumpy and translucent: lit on the chop's normal, the sun wrapping round it
  // (bright even with the light behind it), darker in its holes
  vec3 Nf = normalize(vec3(-(g.x + 1.6 * gd.x), 1.0, -(g.y + 1.6 * gd.y)));
  vec3 foamLight = uSunLight * (0.4 + 0.6 * max(dot(Nf, uSunDir), 0.0)) + mix(uAmbientGround, uAmbientSky, 0.5 + 0.5 * Nf.y);
  col = mix(col, uFoamColor * foamLight * (0.72 + 0.28 * lace) * froth, clamp(foam, 0.0, 1.0));
#if GATES
  }
#endif

#if DEBUG_VIEW
  if (uDebug > 1.5 && uDebug < 2.5) col = N * 0.5 + 0.5;
  else if (uDebug > 2.5 && uDebug < 3.5) col = vec3(foam, cap, trail);
  else if (uDebug > 3.5 && uDebug < 4.5) col = vec3(near, fres, sig * 3.0);
  else if (uDebug > 4.5 && uDebug < 5.5) col = vec3(seen.g, E, 0.5 + 0.5 * bank);
  else if (uDebug > 5.5 && uDebug < 6.5) col = vec3(0.5 + 0.5 * cr, 0.5 + front, wind * 0.6);
  else if (uDebug > 6.5 && uDebug < 7.5) col = vec3(dist / 50.0, dist / 500.0, dist / 5000.0);
  if (uDebug < 1.5 || uDebug > 7.5)
#endif
  col = applyHaze(col, dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`
