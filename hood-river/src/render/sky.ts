/**
 * Sky, light and air.
 *
 *   - The sky: one full-screen triangle at the far plane, drawn after everything opaque. It
 *     draws atmosphere.ts's skyClear() (gradient and sun) and, over it, clouds from a
 *     panorama painted at load (ambient/cloudPanorama.ts): the marine bank in the western
 *     notch, the deck streaming out of it, cumulus over the ridges. The water reflects
 *     skyColor(), which is the same sky with the clouds' *mean* cover mixed in, so the two
 *     agree wherever the water is too rough to mirror a shape (everywhere, here).
 *   - Light for the built-in materials: a directional sun and a hemisphere fill from the
 *     atmosphere's numbers. Custom shaders get the same light from skyLight() in SKY_GLSL.
 *   - Air for the built-in materials: scene.fog, with three's fog chunk swapped for the
 *     per-channel exponential of applyHaze() so both kinds of material fade alike.
 *
 * Costs: 1 draw call, 1 program, 1 texture fetch per sky pixel on the low tier and 2 on
 * the others. Textures: the panorama (RGBA8, 1024x192 low, 2048x256 otherwise) and, off
 * the low tier, a 256x256 RGBA8 mipmapped noise tile that roughens the cloud edges (the
 * low tier has the same lumps painted into its panorama at load instead).
 *
 * The panorama's light is baked for the sun's position, so it is repainted (100 ms or so)
 * when the tuning panel has moved the sun or the bank and let go; not while they are moving.
 *
 * Query flags: clouds=0..1.6 (cloud cover: 0 none, 1 the July afternoon, 1.6 broken cloud),
 * skyfog=std (leave three's fog chunk alone).
 */
import * as THREE from 'three'
import type { App, FeatureModule, Quality } from '../app/types'
import { SKY_GLSL, syncAtmosphere, type Atmosphere } from './atmosphere'
import { generateCloudPanorama, PANO_K } from './ambient/cloudPanorama'
import { makeNoiseTile } from './ambient/noise'

const VERT = /* glsl */ `
varying vec3 vRay;
void main() {
  // view ray of this corner, rotated into the world (the view matrix's rotation, transposed)
  vec3 viewRay = vec3(position.x / projectionMatrix[0][0], position.y / projectionMatrix[1][1], -1.0);
  vRay = viewRay * mat3(viewMatrix);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const FRAG = /* glsl */ `
${SKY_GLSL}
uniform sampler2D uCloudMap;
uniform sampler2D uCloudNoise;
// x: edge detail amount (0 = off), y: detail mip level, z, w: detail drift
uniform vec4 uCloudParams;
varying vec3 vRay;

void main() {
  vec3 d = normalize(vRay);
  float w = skySunward(d);
  vec3 col = skyClearAt(d, w);
  float sd = max(dot(d, uSunDir), 0.0);

  // panorama lookup: diamond bearing, horizon-weighted elevation (see cloudPanorama.ts)
  float h = max(d.y, 0.0);
  float t = d.z / (abs(d.x) + abs(d.z) + 1e-6);
  float u = (d.x >= 0.0 ? t : 2.0 - t) * 0.25 + 0.25;
  float v = h * ${(1 + PANO_K).toFixed(3)} / (h + ${PANO_K.toFixed(3)});
  vec4 c = texture2D(uCloudMap, vec2(u, v));
  float dn = c.r;
  float grain = 0.0;
  if (uCloudParams.x > 0.0) {
    // finer lumps than the panorama holds: ragged edges and a little texture inside
    vec2 uv2 = vec2(u * 32.0 + uCloudParams.z, h * 5.1 + uCloudParams.w);
    grain = textureLod(uCloudNoise, uv2, uCloudParams.y).r - 0.5;
    dn += grain * uCloudParams.x * smoothstep(0.06, 0.3, c.r);
  }
  // The cover knob moves the threshold: 0.5 at 1 (the clouds as painted), down to 0.08 at
  // 1.6 (every cloud out to its rim, the deck nearly closed), up past anything painted by
  // 0.25, and no cloud at all at 0.
  float thr = uCloudCover >= 1.0 ? 0.5 - (uCloudCover - 1.0) * 0.7 : 0.5 + (1.0 - uCloudCover) * 1.1;
  float soft = mix(0.045, 0.27, c.b);
  float a = smoothstep(thr - soft, thr + soft, dn) * smoothstep(-0.004, 0.0, d.y) * step(0.004, uCloudCover);

  // shaded to sunlit by the brightness baked into the panorama; warmer close to the sun
  float glow = sd * sd; glow *= glow;
  vec3 cc = mix(uCloudShade, uCloudLit, clamp(c.g + grain * 0.3, 0.0, 1.0)) + uSunColor * (glow * 0.1 * c.g);
  // distant cloud sits in the same air as the low sky behind it
  cc = mix(cc, skyHorizonAt(w), c.b * 0.5);
  col = mix(col, cc, a);

  // the sun's disc, where no cloud is in front of it
  col += uSunColor * (smoothstep(0.99978, 0.99993, sd) * 2.5 * (1.0 - a));

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  // a little ordered noise so the smooth gradient does not band in 8 bits
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  gl_FragColor.rgb += (n - 0.5) / 255.0;
}
`

/**
 * Make three's built-in exponential fog the same function as applyHaze(): plain exponential
 * in distance with per-channel density. Returns false if the chunk is not the one expected
 * (a different three.js), in which case the standard squared-exponential fog is left alone.
 */
function patchFogChunk(a: Atmosphere): boolean {
  const std = 'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );'
  const chunk = THREE.ShaderChunk.fog_fragment
  if (!chunk.includes(std)) return chunk.includes('hood-river fog')
  const t = a.fogTint
  THREE.ShaderChunk.fog_fragment = chunk.replace(
    std,
    `// hood-river fog: same as applyHaze() in atmosphere.ts
		vec3 fogFactor = 1.0 - exp( - fogDensity * vFogDepth * vec3( ${t.x.toFixed(4)}, ${t.y.toFixed(4)}, ${t.z.toFixed(4)} ) );`,
  )
  return true
}

/** The module also reports what it built, for checks from the console and the capture tool. */
export interface SkyModule extends FeatureModule {
  stats: { panoramaWidth: number; panoramaHeight: number; panoramaMs: number; noiseMs: number; textureBytes: number; repaints: number }
}

export function create(app: App): SkyModule {
  const a = app.atmos
  const q = app.options.query
  if (q.has('clouds')) {
    const c = Number(q.get('clouds'))
    if (Number.isFinite(c)) a.cloudCover = Math.max(0, Math.min(1.6, c))
  }
  syncAtmosphere(a)

  // ---- light and air for built-in materials ----
  const hemi = new THREE.HemisphereLight(a.ambientSky, a.ambientGround, a.ambientIntensity)
  const sun = new THREE.DirectionalLight(a.sunColor, a.sunIntensity)
  sun.position.copy(a.sunDir).multiplyScalar(100)
  app.scene.add(hemi, sun)

  const linearFog = q.get('skyfog') !== 'std' && patchFogChunk(a)
  // three's own FogExp2 is exp(-(density * d)^2): match applyHaze() at 2 km if the chunk was not swapped
  const fog = new THREE.FogExp2(a.haze.getHex(), linearFog ? a.fogDensity : Math.sqrt(a.fogDensity / 2000))
  app.scene.fog = fog
  // what shows if the sky is ever not drawn (it always is): the colour land fades into
  const background = a.haze.clone()
  app.scene.background = background

  // ---- clouds ----
  const NOISE = 256
  const stats = { panoramaWidth: 0, panoramaHeight: 0, panoramaMs: 0, noiseMs: 0, textureBytes: 0, repaints: 0 }
  const uCloudMap = { value: null as THREE.DataTexture | null }
  const uCloudNoise = { value: null as THREE.DataTexture | null }
  let tier = app.quality.tier
  let detail = 0
  // what the panorama was painted for, and what the atmosphere said on the previous frame
  const sunBuilt = new THREE.Vector3(), bankBuilt = new THREE.Vector3()
  const sunPrev = new THREE.Vector3().copy(a.sunDir), bankPrev = new THREE.Vector3().copy(a.bankDir)
  // seconds since either last moved (in a typed array: V8 boxes a number anew each time it is written to a closure variable)
  const still = new Float32Array(1)
  const detailFor = () => (tier === 'low' ? 0 : tier === 'high' ? 0.36 : 0.3)
  /** paint the panorama for the current tier, sun and bank (50 to 170 ms on a desktop) */
  const buildClouds = () => {
    tier = app.quality.tier
    const low = tier === 'low'
    uCloudMap.value?.dispose()
    // the low tier has no detail fetch: its panorama carries the lumps instead
    const pano = generateCloudPanorama(low ? 1024 : 2048, low ? 192 : 256, a, low ? 1 : 0)
    const cloudMap = new THREE.DataTexture(pano.data, pano.width, pano.height, THREE.RGBAFormat, THREE.UnsignedByteType)
    cloudMap.wrapS = THREE.RepeatWrapping
    cloudMap.wrapT = THREE.ClampToEdgeWrapping
    // always magnified on screen and looked up across the bearing seam: no mipmaps
    cloudMap.magFilter = THREE.LinearFilter
    cloudMap.minFilter = THREE.LinearFilter
    cloudMap.generateMipmaps = false
    cloudMap.needsUpdate = true
    uCloudMap.value = cloudMap
    // the detail tile (the low tier never samples it: a 1x1 stand-in); kept across repaints
    const t0 = performance.now()
    const size = low ? 1 : NOISE
    if (uCloudNoise.value?.image.width !== size) {
      uCloudNoise.value?.dispose()
      const cloudNoise = new THREE.DataTexture(low ? new Uint8Array([128, 128, 128, 255]) : makeNoiseTile(NOISE, 4242), size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
      cloudNoise.wrapS = cloudNoise.wrapT = THREE.RepeatWrapping
      cloudNoise.magFilter = THREE.LinearFilter
      cloudNoise.minFilter = low ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter
      cloudNoise.generateMipmaps = !low
      cloudNoise.needsUpdate = true
      uCloudNoise.value = cloudNoise
    }
    detail = detailFor()
    sunBuilt.copy(a.sunDir)
    bankBuilt.copy(a.bankDir)
    stats.panoramaWidth = pano.width
    stats.panoramaHeight = pano.height
    stats.panoramaMs = pano.ms
    stats.noiseMs = performance.now() - t0
    stats.repaints++
    // RGBA8; the noise tile has a full mip chain
    stats.textureBytes = pano.width * pano.height * 4 + (low ? 4 : Math.round((NOISE * NOISE * 4 * 4) / 3))
  }
  buildClouds()

  const uCloudParams = { value: new THREE.Vector4(0, 0, 0, 0) }
  const material = new THREE.ShaderMaterial({
    uniforms: { ...a.uniforms, uCloudMap, uCloudNoise, uCloudParams },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthWrite: false,
    depthTest: true,
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  // after every opaque object, so only the pixels nothing else covered are shaded
  mesh.renderOrder = 1000
  // the detail tile's mip level follows the screen's pixels per degree
  const size = new THREE.Vector2()
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getDrawingBufferSize(size)
    const fov = (camera as THREE.PerspectiveCamera).fov || 58
    const pxPerDeg = size.y / fov
    // 32 tiles of 256 texels round the horizon
    uCloudParams.value.y = Math.max(0, Math.log2((32 * NOISE) / 360 / pxPerDeg))
  }
  app.scene.add(mesh)

  return {
    stats,
    update(dt: number) {
      syncAtmosphere(a)
      hemi.color.copy(a.ambientSky)
      hemi.groundColor.copy(a.ambientGround)
      hemi.intensity = a.ambientIntensity
      sun.color.copy(a.sunColor)
      sun.intensity = a.sunIntensity
      sun.position.copy(a.sunDir).multiplyScalar(100)
      fog.color.copy(a.haze)
      fog.density = linearFog ? a.fogDensity : Math.sqrt(a.fogDensity / 2000)
      background.copy(a.haze)
      // The sun or the bank was moved (tuning): the clouds' baked light and places are stale.
      // Repaint once, half a second after they have come to rest; never while they are moving.
      if (sunPrev.distanceToSquared(a.sunDir) > 1e-10 || bankPrev.distanceToSquared(a.bankDir) > 1e-10) {
        still[0] = 0
        sunPrev.copy(a.sunDir)
        bankPrev.copy(a.bankDir)
      } else if (still[0] < 1) still[0] += dt
      if (still[0] > 0.5 && (sunBuilt.distanceToSquared(a.sunDir) > 1e-6 || bankBuilt.distanceToSquared(a.bankDir) > 1e-6)) buildClouds()
      // the cloud edges work slowly: drift of the detail tile, wrapped on the CPU
      const p = uCloudParams.value
      p.x = detail
      p.z = (app.time * 0.0021) % 1
      p.w = (app.time * 0.0006) % 1
    },
    setQuality(q: Quality) {
      // A change of resolution needs nothing (the mip level is recomputed every frame). A
      // change of tier needs a repaint only between the low tier and the others, whose
      // panoramas differ; mid and high share one and differ in how rough the edges are.
      if (q.tier === tier) return
      if ((q.tier === 'low') !== (tier === 'low')) buildClouds()
      else { tier = q.tier; detail = detailFor() }
    },
    dispose() {
      app.scene.remove(mesh, hemi, sun)
      geometry.dispose()
      material.dispose()
      uCloudMap.value?.dispose()
      uCloudNoise.value?.dispose()
    },
  }
}
