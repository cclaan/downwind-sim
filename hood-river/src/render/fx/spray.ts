/**
 * Spray: drops, sheets and mist thrown into the air, in one draw call of instanced billboards.
 *
 * A particle is written once, when it is born: where, how fast, when, how long. The vertex
 * shader flies it from there in closed form (gravity, air drag toward the wind), so nothing
 * is simulated or re-uploaded per frame; only newly born particles are sent to the GPU.
 *
 *   drops   small and bright, stretched along their motion on screen (the sparkle);
 *   sheets  thrown water with body: soft-edged, stretched along the flight and torn into
 *           streaks by a noise that eats further into them as they thin;
 *   mist    a faint puff the wind carries off (big splashes only).
 *
 * Nothing is ever cut by the water. The vertex shader evaluates the shared wave function
 * (WAVE_GLSL) under each particle: a drop that has gone back in is dropped; a sheet or a
 * puff is kept above the surface, fades to nothing along the line where it meets the water
 * (taken as the plane the surface is there), and is gone a moment after it has come down.
 * The depth test stays on, so the rider and the crests still hide what is behind them.
 *
 * Positions are relative to an origin and times to a clock that the owner rebases (shift);
 * both, and the rest of what update() needs, are read from the shared frame array (frame.ts).
 */
import * as THREE from 'three'
import { WAVE_GLSL } from '../../sim/waves'
import type { WaveUniforms } from '../waveUniforms'
import { F_DT, F_NOW, F_OX, F_OZ, F_PX, F_WIND_X, F_WIND_Z } from './frame'

/** floats per particle: x y z birth | vx vy vz life | radius growth drag alpha | kind streak wind gravity */
export const SPRAY_STRIDE = 16
const DEAD = -1e6

export const SPRAY_DROPLET = 0
export const SPRAY_SHEET = 1
export const SPRAY_MIST = 2

const VERT = /* glsl */ `
${WAVE_GLSL}
attribute vec4 aP0;  // birth position, birth time
attribute vec4 aV0;  // birth velocity, life
attribute vec4 aS;   // radius, radius growth per second, air drag (1/s), alpha
attribute vec4 aK;   // kind, streak time (s), share of the wind it is carried by, share of gravity
uniform vec2 uClock;  // x: the time now
uniform vec2 uWind;
uniform vec3 uCamVel;
uniform vec2 uPx;    // pixels per metre at 1 m, smallest radius drawn (pixels)
varying vec2 vQ;
varying vec4 vInfo;  // alpha, kind, height of this corner above the water (radii), age 0..1
varying vec2 vSeed;

void main() {
  vQ = position.xy;
  vInfo = vec4(0.0);
  vSeed = vec2(0.0);
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  float age = uClock.x - aP0.w;
  float life = aV0.w;
  if (age < 0.0 || age >= life) return;

  // dv/dt = -k (v - wind) - g: velocity decays toward a terminal one
  float k = max(aS.z, 0.05);
  vec3 vT = vec3(uWind.x * aK.z, -9.81 * aK.w / k, uWind.y * aK.z);
  float e = exp(-k * age);
  vec3 dv = aV0.xyz - vT;
  vec3 p = aP0.xyz + vT * age + dv * ((1.0 - e) / k);
  vec3 vel = vT + dv * e;
  float radius = aS.x + aS.y * age;

  // the water under it: the surface the physics rides and the water mesh draws
  vec4 ws = waveSurface(p.xz, 0.0);
  float h = p.y - ws.x;
  float soft = step(0.5, aK.x);
  float landed = 1.0;
  if (soft < 0.5) {
    // a drop that is back in the water is gone
    if (h < -0.03) return;
  } else {
    // a sheet or a puff never dips under: it settles on the surface and is gone a moment later
    landed = smoothstep(-0.05 - 1.6 * radius, 0.4 * radius, h);
    if (landed <= 0.0) return;
    float keep = 0.9 * radius;
    if (h < keep) {
      p.y += keep - h;
      h = keep;
      vel.y = max(vel.y, 0.0);
    }
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // streak along the motion as the camera sees it: the camera is travelling too
  vec2 vs = (modelViewMatrix * vec4(vel - uCamVel, 0.0)).xy;
  float sp = length(vs);
  vec2 ax = sp > 1e-3 ? vs / sp : vec2(1.0, 0.0);

  // never thinner than a pixel or so: fade instead of flickering
  float px = radius * uPx.x / max(-mv.z, 0.1);
  float boost = max(1.0, uPx.y / max(px, 1e-3));
  radius *= boost;
  float halfLen = radius + aK.y * sp;
  vec2 off = ax * (position.x * halfLen) + vec2(-ax.y, ax.x) * (position.y * radius);
  mv.xy += off;
  gl_Position = projectionMatrix * mv;

  // how high this corner stands above the water, the surface taken as the plane it is under
  // the particle (the billboard faces the camera, so its lower edge is also nearer the lens)
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 w = right * off.x + up * off.y;
  float above = (h + w.y - dot(ws.yz, w.xz)) / max(radius, 1e-3);

  float a01 = age / life;
  float fade = aK.x < 0.5
    ? smoothstep(0.0, 0.05, a01) * (1.0 - smoothstep(0.55, 1.0, a01))
    : aK.x < 1.5
      ? smoothstep(0.0, 0.08, a01) * (1.0 - smoothstep(0.5, 1.0, a01))
      : smoothstep(0.0, 0.1, a01) * (1.0 - a01) * sqrt(1.0 - a01);
  vInfo = vec4(aS.w * fade * landed / boost, aK.x, soft > 0.5 ? above : 10.0, a01);
  // a pattern of its own for every particle
  vSeed = fract(vec2(aP0.w * 7.31 + aP0.x * 1.93, aP0.w * 3.17 + aP0.z * 2.71));
}
`

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform sampler2D uNoise;
varying vec2 vQ;
varying vec4 vInfo;
varying vec2 vSeed;

void main() {
  float f = clamp(1.0 - dot(vQ, vQ), 0.0, 1.0);
  // (sampled outside the branches: a texture read under a condition has no defined mip level)
  float n = texture2D(uNoise, vec2(vQ.x * 0.09, vQ.y * 0.55) + vSeed).r;
  float a;
  if (vInfo.y < 0.5) {
    // a drop has a body and a soft rim
    a = smoothstep(0.0, 0.8, f);
  } else {
    if (vInfo.y < 1.5) {
      // a sheet: dense in the middle, ragged at the edge, torn into streaks along its flight
      // (vQ.x runs along it), and the tears eat inward as it ages
      a = smoothstep(-0.04, 0.2, f * (1.05 - 0.85 * vInfo.w) - n);
    } else {
      // mist is all rim
      a = f * f;
    }
    // nothing along the line where it meets the water
    a *= smoothstep(0.0, 0.7, vInfo.z);
  }
  a *= vInfo.x;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`

export class Spray {
  readonly mesh: THREE.Mesh
  readonly capacity: number
  /**
   * The particles, SPRAY_STRIDE floats each (layout above). Emitters write a new particle
   * straight into the slot that alloc() hands out: a call with sixteen numbers would box
   * every one of them (V8 passes doubles to a function it has not inlined as heap objects).
   */
  readonly data: Float32Array

  private readonly buffer: THREE.InstancedInterleavedBuffer
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly frame: Float64Array
  private readonly range = { start: 0, count: 0 }
  private head = 0
  private dirtyLo = 0x3fffffff
  private dirtyHi = -1
  /** the camera at the previous render, to find how fast it is travelling */
  private readonly camPrev = new THREE.Vector3()
  private camSeen = false
  private frameDt = 0

  /**
   * `wave`: the shared wave uniforms, which the owner updates with the origin in `frame`;
   * `frame`: the shared frame array (frame.ts).
   */
  constructor(capacity: number, wave: WaveUniforms, frame: Float64Array, noise: THREE.Texture) {
    this.capacity = Math.max(8, Math.round(capacity))
    this.data = new Float32Array(this.capacity * SPRAY_STRIDE)
    this.frame = frame

    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3))
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1))
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, SPRAY_STRIDE, 1)
    this.buffer.setUsage(THREE.DynamicDrawUsage)
    this.buffer.onUpload(() => { this.dirtyLo = 0x3fffffff; this.dirtyHi = -1 })
    // One update range, kept for good: three empties the list after every upload, and an
    // array that is emptied and pushed to again gets a new backing store each time.
    this.buffer.updateRanges.push(this.range)
    this.buffer.clearUpdateRanges = () => {}
    geo.setAttribute('aP0', new THREE.InterleavedBufferAttribute(this.buffer, 4, 0))
    geo.setAttribute('aV0', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4))
    geo.setAttribute('aS', new THREE.InterleavedBufferAttribute(this.buffer, 4, 8))
    geo.setAttribute('aK', new THREE.InterleavedBufferAttribute(this.buffer, 4, 12))
    geo.instanceCount = this.capacity
    this.geometry = geo

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...wave.uniforms,
        uClock: { value: new THREE.Vector2() },
        uWind: { value: new THREE.Vector2() },
        uCamVel: { value: new THREE.Vector3() },
        uPx: { value: new THREE.Vector2(600, 1.3) },
        uColor: { value: new THREE.Color(0.85, 0.89, 0.95) },
        uNoise: { value: noise },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 11
    this.mesh.matrixAutoUpdate = false
    // Drops streak along their motion relative to the camera, so the camera's own velocity
    // is measured here, from whichever camera really renders the frame.
    const camVel = this.material.uniforms.uCamVel.value as THREE.Vector3
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const m = camera.matrixWorld.elements
      const dt = this.frameDt
      this.frameDt = 0
      if (this.camSeen && dt > 1e-4) {
        const vx = (m[12] - this.camPrev.x) / dt
        const vy = (m[13] - this.camPrev.y) / dt
        const vz = (m[14] - this.camPrev.z) / dt
        // a cut is not a velocity
        if (vx * vx + vy * vy + vz * vz < 900) camVel.set(vx, vy, vz)
      }
      this.camPrev.set(m[12], m[13], m[14])
      this.camSeen = true
    }
    this.clear()
  }

  get triangles(): number { return this.capacity * 2 }
  get color(): THREE.Color { return this.material.uniforms.uColor.value as THREE.Color }

  clear(): void {
    const d = this.data
    d.fill(0)
    for (let i = 0; i < d.length; i += SPRAY_STRIDE) d[i + 3] = DEAD
    this.head = 0
    this.dirtyLo = 0
    this.dirtyHi = this.capacity - 1
    this.camSeen = false
  }

  /** the origin moved by (dx, dz) and the clock by dt */
  shift(dx: number, dz: number, dt: number): void {
    const d = this.data
    for (let i = 0; i < d.length; i += SPRAY_STRIDE) { d[i] -= dx; d[i + 2] -= dz; d[i + 3] -= dt }
    this.dirtyLo = 0
    this.dirtyHi = this.capacity - 1
  }

  /**
   * The next slot of the ring: the offset into `data` at which to write one particle (all
   * SPRAY_STRIDE floats of it; the oldest particle is overwritten).
   */
  alloc(): number {
    const slot = this.head
    this.head = slot + 1 < this.capacity ? slot + 1 : 0
    if (slot < this.dirtyLo) this.dirtyLo = slot
    if (slot > this.dirtyHi) this.dirtyHi = slot
    return slot * SPRAY_STRIDE
  }

  /** once per frame, after the frame's particles: uniforms and the upload of the new ones */
  update(): void {
    const u = this.material.uniforms
    const f = this.frame
    this.frameDt += f[F_DT]
    // (in a vector: a number stored straight into a uniform's `value` would be boxed)
    ;(u.uClock.value as THREE.Vector2).x = f[F_NOW]
    const wind = u.uWind.value as THREE.Vector2
    wind.x = f[F_WIND_X]
    wind.y = f[F_WIND_Z]
    ;(u.uPx.value as THREE.Vector2).x = f[F_PX]
    this.mesh.position.x = f[F_OX]
    this.mesh.position.z = f[F_OZ]
    this.mesh.updateMatrix()
    if (this.dirtyHi >= this.dirtyLo) {
      // (a frame in which the ring wraps touches both ends, so this sends all of it)
      this.range.start = this.dirtyLo * SPRAY_STRIDE
      this.range.count = (this.dirtyHi - this.dirtyLo + 1) * SPRAY_STRIDE
      this.buffer.needsUpdate = true
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
