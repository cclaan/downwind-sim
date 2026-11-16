/**
 * The one material for the gorge: land, trees, buildings, the bridge and the far ridges.
 *
 * Lighting is worked out per vertex from baked factors (how much sun reaches the vertex,
 * how much sky and how much bounce it sees) times the live light colours of the shared
 * atmosphere, so the land follows the same sun and sky numbers as the rider and the water
 * without re-baking. Per fragment: optional detail from one small noise texture, then the
 * shared haze.
 */
import * as THREE from 'three'
import type { App } from '../../app/types'
import { SKY_GLSL } from '../atmosphere'
import { FAR_HAZE_MAX } from './geometry'
import { hash2 } from './noise'

/** how far the strata are pushed up and down along a face (m, peak to peak); baked per vertex in aDetail.w */
export const STRATA_WOBBLE = 46
/** size of the detail tile over far country (m) and the strength of its pattern there */
const FAR_TILE = 1700
const FAR_PATTERN = 1.15

const VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aLight;
attribute vec4 aDetail;
uniform vec3 uSunLight;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
varying vec3 vColor;
varying vec3 vView;
varying float vHaze;
#ifdef DETAIL
varying vec3 vGround;
varying vec4 vDetail;
#endif
void main() {
  // albedo is stored as its square root. The lit colour is handed on as a square root too and
  // squared per fragment, so that across a large triangle a dark wood and bright grass meet
  // half-way; blended as linear light the grass, thirty times brighter, swallows the wood.
  vec3 light = uSunLight * aColor.a + uAmbientSky * aLight.x + uAmbientGround * aLight.y;
  vColor = aColor.rgb * sqrt(light);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vHaze = ${FAR_HAZE_MAX.toFixed(6)} * aLight.z;
#ifdef DETAIL
  // the height the strata are read at: the flows rise, dip and pinch along a wall
  vGround = vec3(position.x, position.y + (aDetail.w - 0.5) * ${STRATA_WOBBLE.toFixed(1)}, position.z);
  vDetail = vec4(aDetail.xyz, aLight.w);
#endif
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
${SKY_GLSL}
varying vec3 vColor;
varying vec3 vView;
varying float vHaze;
#ifdef DETAIL
uniform sampler2D uDetailTex;
uniform float uDetail;
varying vec3 vGround;
varying vec4 vDetail;
#endif
void main() {
  vec3 col = vColor * vColor;
  float dist = length(vView);
#ifdef DETAIL
  // r: grain, g: tree crowns, b: level strata, a: vertical streaks
  float along = dot(vGround.xz, vec2(0.83, 0.56)) * (1.0 / 58.0);
  // crowns only under closed canopy: on open slopes with a few trees they read as cobbles
  float crown = smoothstep(0.55, 0.8, vDetail.y);
  // far country (hills kilometres off): the same texture read ${FAR_TILE.toFixed(0)} m to the tile, where its
  // crown cells are woods and burn patches a couple of hundred metres across
  float far = step(0.5, vDetail.w);
  vec2 ground = vGround.xz * mix(1.0 / 46.0, ${(1 / FAR_TILE).toFixed(7)}, far);
#if DETAIL > 1
  vec4 flat_ = texture2D(uDetailTex, ground);
  float d = mix(mix(flat_.r, flat_.g, crown), flat_.g, far);
  // the grain nudges the strata so the flows are not ruled lines
  vec4 wall = texture2D(uDetailTex, vec2(along, (vGround.y + 7.0 * (flat_.r - 0.5)) * (1.0 / 72.0)));
  d = mix(d, wall.b * (0.6 + 0.8 * wall.a), vDetail.x);
#else
  // one fetch: mapped down the face where the vertex is rock, over the ground elsewhere
  float rocky = step(0.45, vDetail.x);
  vec2 uv = mix(ground, vec2(along, vGround.y * (1.0 / 72.0)), rocky);
  vec4 t = texture2D(uDetailTex, uv);
  float d = mix(mix(mix(t.r, t.g, crown), t.g, far), t.b * (0.6 + 0.8 * t.a), rocky);
#endif
  float amount = max(max(vDetail.z, max(vDetail.x, crown)), ${FAR_PATTERN.toFixed(2)} * vDetail.w);
  col *= 1.0 + amount * uDetail * (d - 0.5);
#endif
  col = applyHaze(col, dist * vHaze);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** tileable value noise on a period-P lattice, bilinear */
function tileNoise(size: number, period: number, seed: number, out: Float32Array, amp: number, stretchX = 1, stretchY = 1): void {
  const px = Math.max(1, Math.round(period * stretchX)), py = Math.max(1, Math.round(period * stretchY))
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * py
    const iy = Math.floor(fy), ty = fy - iy
    const sy = ty * ty * (3 - 2 * ty)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * px
      const ix = Math.floor(fx), tx = fx - ix
      const sx = tx * tx * (3 - 2 * tx)
      const a = hash2(ix % px, iy % py, seed), b = hash2((ix + 1) % px, iy % py, seed)
      const c = hash2(ix % px, (iy + 1) % py, seed), d = hash2((ix + 1) % px, (iy + 1) % py, seed)
      out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy)
    }
  }
}

/** 256 x 256 RGBA8 detail texture: grain, tree crowns, strata, streaks. Mean 0.5 per channel. */
export function makeDetailTexture(): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * N * 4)
  const ch = new Float32Array(N * N)
  const put = (c: number, gain: number) => {
    let mean = 0
    for (let i = 0; i < ch.length; i++) mean += ch[i]
    mean /= ch.length
    for (let i = 0; i < ch.length; i++) {
      const v = 0.5 + (ch[i] - mean) * gain
      data[i * 4 + c] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
    }
    ch.fill(0)
  }
  // grain: fine, even
  tileNoise(N, 16, 11, ch, 0.3); tileNoise(N, 40, 12, ch, 0.4); tileNoise(N, 96, 13, ch, 0.3)
  put(0, 1.5)
  // crowns: blobs about a crown wide (46 m tile / 14 = 3.3 m... use cells of a few metres)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // cellular: distance to the nearest of one jittered point per cell, wrapped
      const C = 9
      const fx = (x / N) * C, fy = (y / N) * C
      const ix = Math.floor(fx), iy = Math.floor(fy)
      let best = 9
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy
          const wx = ((cx % C) + C) % C, wy = ((cy % C) + C) % C
          const px = cx + 0.15 + 0.7 * hash2(wx, wy, 31), py = cy + 0.15 + 0.7 * hash2(wx, wy, 32)
          const d = Math.hypot(fx - px, fy - py)
          if (d < best) best = d
        }
      }
      ch[y * N + x] = 1 - Math.min(1, best * 1.35)
    }
  }
  tileNoise(N, 48, 33, ch, 0.25)
  put(1, 1.25)
  // strata: level flows of basalt of uneven thickness (9 to 21 m in a 72 m tile), each a face
  // under a thin lighter ledge with a shadow line at its foot. The joints between flows step
  // up and down along the tile, and the faces differ in tone, so nothing reads as a ruled line.
  const BANDS = [0, 0.13, 0.42, 0.55, 0.84, 1]
  const FACE = [0.44, 0.36, 0.5, 0.4, 0.47]
  const step = new Float32Array(N)
  tileNoise(N, 6, 43, step, 1)
  for (let x = 0; x < N; x++) step[x] = (step[x] - 0.5) * 0.05
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = y / N + step[x]
      v -= Math.floor(v)
      let b = 0
      while (b < BANDS.length - 2 && v >= BANDS[b + 1]) b++
      const f = (v - BANDS[b]) / (BANDS[b + 1] - BANDS[b])
      const thick = (BANDS[b + 1] - BANDS[b]) * 72
      // from the foot of a flow upward: shadowed undercut, face, ledge (each about a metre and a half)
      const foot = 1.4 / thick, ledge = 1 - 2.2 / thick
      ch[y * N + x] = f < foot ? 0.24 : f < ledge ? FACE[b] + 0.08 * f : 0.7
    }
  }
  tileNoise(N, 10, 42, ch, 0.16, 1, 0.4)
  put(2, 1.0)
  // streaks: columnar joints, a couple of metres across and long down the face
  tileNoise(N, 28, 51, ch, 0.55, 1, 0.12); tileNoise(N, 64, 52, ch, 0.45, 1, 0.1)
  put(3, 1.7)

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

export interface TerrainMaterial {
  material: THREE.ShaderMaterial
  texture: THREE.DataTexture | null
  dispose(): void
}

/** strength of the fragment detail (grain, crowns, strata): the colour swings by half of this either way */
export const DETAIL_STRENGTH = 0.8

/** detail: 0 = vertex colour only, 1 = one texture fetch (grain, crowns or strata by vertex), 2 = two, blended */
export function makeTerrainMaterial(app: App, detail: number): TerrainMaterial {
  const texture = detail > 0 ? makeDetailTexture() : null
  if (texture) texture.anisotropy = detail > 1 ? Math.min(4, app.renderer.capabilities.getMaxAnisotropy()) : 1
  const material = new THREE.ShaderMaterial({
    uniforms: { ...app.atmos.uniforms, uDetailTex: { value: texture }, uDetail: { value: DETAIL_STRENGTH } },
    defines: detail > 0 ? { DETAIL: detail > 1 ? 2 : 1 } : {},
    vertexShader: VERT,
    fragmentShader: FRAG,
  })
  return {
    material,
    texture,
    dispose() {
      material.dispose()
      texture?.dispose()
    },
  }
}
