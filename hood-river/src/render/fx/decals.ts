/**
 * Everything that lies on the water around the rider, in one draw call of instanced quads:
 *
 *   - ribbons: foam laid joint to joint behind something that cuts the surface (the mast,
 *     the tail of a floating board, a wingtip). Joints are fixed in the water frame; nothing
 *     moves after it is laid. Each joint keeps the direction of travel there, and the two
 *     segments that meet at it share it, so a carved wake is one unbroken band. Every
 *     ribbon has a ring of segments of its own, sized by its owner for how long its foam
 *     lasts, so a short-lived ribbon never costs a long-lived one its tail;
 *   - patches: splash rings, the bow wave's two arms, a paddle's puddle. They spread and
 *     drift on for a moment;
 *   - the blob: a soft dark patch under the board that shows the ride height.
 *
 * Each instance is a small grid whose vertices are put on the water by the shared wave
 * function (WAVE_GLSL), so decals ride exactly the surface the physics uses. They are drawn
 * a little nearer the lens than they lie (lifted 1.5 cm and pulled along the view ray), which
 * keeps them from fighting the water mesh. The pull never raises them by more than 2 cm,
 * whatever the camera's angle: the deck of a floating board is only 6 cm above the water
 * and has to hide the blob and the foam under it, from straight above too.
 *
 * Instance data is one interleaved Float32Array written as a ring; only the instances
 * touched in a frame are uploaded. Positions are relative to an origin that the owner moves
 * in steps of 64 m (see shift), times relative to a clock the owner rebases, so the shader
 * only ever sees small numbers. The time now and the origin are read from the shared frame
 * array (frame.ts), and the two calls made every frame, blob() and trail(), take their
 * numbers from `arg` instead of as arguments, so that nothing is boxed per frame.
 */
import * as THREE from 'three'
import { WAVE_GLSL } from '../../sim/waves'
import type { WaveUniforms } from '../waveUniforms'
import { F_NOW, F_OX, F_OZ } from './frame'

const STRIDE = 16
const DEAD = -1e6
const SEG_U = 4
const SEG_V = 2
const KIND_PATCH = 1
const KIND_BLOB = 2

const VERT = /* glsl */ `
${WAVE_GLSL}
attribute vec4 aP;   // x0, z0, x1, z1
attribute vec4 aT;   // birth of end 0, birth of end 1, life, growth
attribute vec4 aW;   // half width at end 0 and 1, alpha at end 0 and 1
attribute vec4 aD;   // kind, seed (blob: softness), then patch: drift x, z; ribbon: direction at end 0, 1
uniform vec2 uClock;  // x: the time now
uniform float uLift;
uniform vec3 uBias;   // pull toward the lens: metres, metres per metre of distance; the most it may raise a decal (m)
varying vec2 vQ;
varying vec4 vInfo;
varying vec2 vWorld;

void main() {
  float u = position.x;
  float v = position.y;
  float kind = aD.x;
  float life = aT.z;
  float youngest = uClock.x - aT.y;
  if (youngest >= life || max(aW.z, aW.w) <= 0.002) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vQ = vec2(0.0);
    vInfo = vec4(1.0, 0.0, 0.0, 0.0);
    vWorld = vec2(0.0);
    return;
  }
  float age = max(uClock.x - mix(aT.x, aT.y, u), 0.0);
  vec2 p;
  if (kind > 0.5 && kind < 1.5) {
    // a patch spreads about its centre and drifts on, slowing
    vec2 d = aP.zw - aP.xy;
    float len = max(length(d), 1e-3);
    vec2 t = d / len;
    float g = 1.0 + aT.w * age;
    vec2 c = 0.5 * (aP.xy + aP.zw) + aD.zw * ((1.0 - exp(-1.6 * age)) / 1.6);
    p = c + t * ((u - 0.5) * len * g) + vec2(-t.y, t.x) * (v * aW.x * g);
  } else {
    // a ribbon segment (or the blob) keeps its ends and only widens; its sides follow the
    // direction stored at each end, so neighbours meet without a gap
    float ang = mix(aD.z, aD.w, u);
    p = mix(aP.xy, aP.zw, u) + vec2(-sin(ang), cos(ang)) * (v * (mix(aW.x, aW.y, u) + aT.w * age));
  }
  vec4 ws = waveSurface(p, 0.0);
  vec4 mv = modelViewMatrix * vec4(p.x, ws.x + uLift, p.y, 1.0);
  float dist = max(length(mv.xyz), 1e-3);
  // sine of the angle the lens is seen at from here, above the horizontal: the share of the pull that is height
  float rise = abs(dot(mv.xyz, viewMatrix[1].xyz)) / dist;
  float pull = min(min(uBias.x + uBias.y * dist, 0.5 * dist), uBias.z / max(rise, 1e-3));
  mv.xyz *= 1.0 - pull / dist;
  gl_Position = projectionMatrix * mv;
  vQ = vec2(u * 2.0 - 1.0, v);
  vInfo = vec4(clamp(age / max(life, 1e-3), 0.0, 1.0), mix(aW.z, aW.w, u), kind, aD.y);
  vWorld = p;
}
`

const FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uFoam;
varying vec2 vQ;
varying vec4 vInfo;
varying vec2 vWorld;

void main() {
  float age = vInfo.x;
  float kind = vInfo.z;
  float a;
  vec3 col;
  if (kind > 1.5) {
    // the blob only darkens what is under it
    float f = clamp(1.0 - dot(vQ, vQ), 0.0, 1.0);
    a = vInfo.y * smoothstep(0.0, vInfo.w, f);
    col = vec3(0.0);
  } else {
    // two scales of noise, 0..1; foam shows where its density beats the noise. Strength
    // (the instance's alpha) thins the foam out before it dims it, so weak foam is sparse
    // white flecks, not a grey film.
    float fine = texture2D(uNoise, vWorld * 2.0 + vInfo.w).r;
    float n = 0.5 * texture2D(uNoise, vWorld * 0.5).r + 0.5 * fine;
    float strength = vInfo.y;
    float density;
    if (kind < 0.5) {
      // fresh foam is a solid line with a frothy edge; it then narrows and breaks into streaks
      float across = abs(vQ.y);
      density = (1.0 - across * sqrt(across)) * (1.3 - 0.85 * sqrt(age) - 0.45 * age);
    } else {
      // a splash clears from the middle and leaves a ring
      float r = length(vQ);
      density = 1.9 * clamp(1.0 - r, 0.0, 1.0) * mix(1.0, smoothstep(0.0, 0.8, r), age) * (1.2 - 1.15 * age);
    }
    density *= 0.25 + 0.75 * strength;
    // a soft, lacy edge, and thinner patches inside so wide foam is not a flat white
    a = min(1.0, 0.45 + 0.7 * strength) * (1.0 - 0.3 * age) * smoothstep(-0.1, 0.2, density - n) * (0.78 + 0.22 * fine);
    col = uFoam;
  }
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`

/** one ribbon: its own ring of segment slots, and its pen (the last committed joint and the slot of the segment being drawn) */
class Ribbon {
  /** first slot of its ring, slots in it, the next one to use */
  base = 0
  cap = 0
  head = 0
  on = false
  slot = -1
  x = 0
  z = 0
  t = 0
  w = 0
  a = 0
  /** direction of travel at the joint, and at the pen now (rad) */
  dir = 0
  penDir = 0
  /** pen position at the previous call, for the direction of travel */
  px = 0
  pz = 0
}

export class SurfaceDecals {
  readonly mesh: THREE.Mesh
  readonly trailCap: number
  readonly patchCap: number
  /** metres between ribbon joints */
  spacing = 0.3
  /** what blob() and trail() are to draw: filled in by the caller just before the call (see each) */
  readonly arg = new Float64Array(8)

  private readonly data: Float32Array
  private readonly buffer: THREE.InstancedInterleavedBuffer
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly frame: Float64Array
  private readonly range = { start: 0, count: 0 }
  private dirtyLo = 0x3fffffff
  private dirtyHi = -1

  private readonly ribbons: Ribbon[]
  private patchHead = 0

  /**
   * `wave`: the shared wave uniforms, which the owner updates with the origin in `frame`;
   * `frame`: the shared frame array (frame.ts); `ribbonCaps`: segments in each ribbon's ring.
   */
  constructor(wave: WaveUniforms, frame: Float64Array, ribbonCaps: number[], patchCap: number, noise: THREE.Texture) {
    this.frame = frame
    this.patchCap = Math.max(4, Math.round(patchCap))
    this.ribbons = []
    let slots = 0
    for (const cap of ribbonCaps) {
      const r = new Ribbon()
      r.base = 1 + slots
      r.cap = Math.max(4, Math.round(cap))
      slots += r.cap
      this.ribbons.push(r)
    }
    this.trailCap = slots
    const count = 1 + this.trailCap + this.patchCap
    this.data = new Float32Array(count * STRIDE)

    const nu = SEG_U + 1
    const nv = SEG_V + 1
    const pos = new Float32Array(nu * nv * 3)
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = (j * nu + i) * 3
        pos[k] = i / SEG_U
        pos[k + 1] = -1 + (2 * j) / SEG_V
      }
    }
    const index = new Uint16Array(SEG_U * SEG_V * 6)
    let q = 0
    for (let j = 0; j < SEG_V; j++) {
      for (let i = 0; i < SEG_U; i++) {
        const a = j * nu + i
        const b = a + 1
        const c = a + nu
        const d = c + 1
        index[q++] = a; index[q++] = c; index[q++] = b
        index[q++] = b; index[q++] = c; index[q++] = d
      }
    }
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1)
    this.buffer.setUsage(THREE.DynamicDrawUsage)
    // the dirty span is only forgotten once the renderer has really uploaded it
    this.buffer.onUpload(() => { this.dirtyLo = 0x3fffffff; this.dirtyHi = -1 })
    // One update range, kept for good: three empties the list after every upload, and an
    // array that is emptied and pushed to again gets a new backing store each time.
    this.buffer.updateRanges.push(this.range)
    this.buffer.clearUpdateRanges = () => {}
    geo.setAttribute('aP', new THREE.InterleavedBufferAttribute(this.buffer, 4, 0))
    geo.setAttribute('aT', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4))
    geo.setAttribute('aW', new THREE.InterleavedBufferAttribute(this.buffer, 4, 8))
    geo.setAttribute('aD', new THREE.InterleavedBufferAttribute(this.buffer, 4, 12))
    geo.instanceCount = count
    this.geometry = geo

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...wave.uniforms,
        uClock: { value: new THREE.Vector2() },
        uLift: { value: 0.015 },
        uBias: { value: new THREE.Vector3(0.05, 0.005, 0.02) },
        uNoise: { value: noise },
        uFoam: { value: new THREE.Color(0.8, 0.84, 0.9) },
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
    this.mesh.renderOrder = 10
    this.mesh.matrixAutoUpdate = false
    this.clear()
  }

  get instances(): number { return 1 + this.trailCap + this.patchCap }
  get triangles(): number { return this.instances * SEG_U * SEG_V * 2 }
  get foam(): THREE.Color { return this.material.uniforms.uFoam.value as THREE.Color }

  private mark(i: number): void {
    if (i < this.dirtyLo) this.dirtyLo = i
    if (i > this.dirtyHi) this.dirtyHi = i
  }

  /** forget everything */
  clear(): void {
    const d = this.data
    d.fill(0)
    for (let i = 0; i < d.length; i += STRIDE) { d[i + 4] = DEAD; d[i + 5] = DEAD }
    for (const r of this.ribbons) { r.on = false; r.slot = -1; r.head = 0 }
    this.patchHead = 0
    this.dirtyLo = 0
    this.dirtyHi = this.instances - 1
  }

  /** the origin moved by (dx, dz) and the clock by dt: keep everything where and when it was */
  shift(dx: number, dz: number, dt: number): void {
    const d = this.data
    for (let i = 0; i < d.length; i += STRIDE) {
      d[i] -= dx; d[i + 1] -= dz; d[i + 2] -= dx; d[i + 3] -= dz
      d[i + 4] -= dt; d[i + 5] -= dt
    }
    for (const r of this.ribbons) { r.x -= dx; r.z -= dz; r.px -= dx; r.pz -= dz; r.t -= dt }
    this.dirtyLo = 0
    this.dirtyHi = this.instances - 1
  }

  /**
   * The dark patch under the board: an ellipse.
   * arg: [0] x, [1] z of its centre, [2] direction of its long axis (rad), [3] half length,
   * [4] half width, [5] darkness, [6] softness of its edge
   */
  blob(): void {
    const d = this.data
    const a = this.arg
    const x = a[0], z = a[1], dir = a[2], halfLength = a[3], halfWidth = a[4], darkness = a[5], softness = a[6]
    const now = this.frame[F_NOW]
    const cx = Math.cos(dir) * halfLength
    const cz = Math.sin(dir) * halfLength
    d[0] = x - cx; d[1] = z - cz; d[2] = x + cx; d[3] = z + cz
    d[4] = now; d[5] = now; d[6] = 1e6; d[7] = 0
    d[8] = halfWidth; d[9] = halfWidth; d[10] = darkness; d[11] = darkness
    d[12] = KIND_BLOB; d[13] = softness; d[14] = dir; d[15] = dir
    this.mark(0)
  }

  /** segments in ribbon `id`'s ring */
  ribbonCap(id: number): number {
    return this.ribbons[id].cap
  }

  /**
   * Carry ribbon `id` on to a point. Its newest segment follows the pen every frame and is
   * committed as a joint each `spacing` metres, so the foam reaches the mast without popping.
   * arg: [0] x, [1] z, [2] half width, [3] alpha, [4] life (s), [5] widening (m/s)
   */
  trail(id: number): void {
    const a = this.arg
    const x = a[0], z = a[1], halfWidth = a[2], alpha = a[3], life = a[4], grow = a[5]
    const now = this.frame[F_NOW]
    const r = this.ribbons[id]
    if (!r.on) {
      r.on = true
      r.slot = -1
      r.x = x; r.z = z; r.t = now; r.w = halfWidth; r.a = alpha
      r.px = x; r.pz = z
      r.dir = NaN
      return
    }
    // direction of travel, kept continuous with the joint's so the shader can interpolate it
    const mx = x - r.px
    const mz = z - r.pz
    if (mx * mx + mz * mz > 1e-5) {
      let dir = Math.atan2(mz, mx)
      if (r.dir === r.dir) {
        while (dir - r.dir > Math.PI) dir -= 2 * Math.PI
        while (dir - r.dir < -Math.PI) dir += 2 * Math.PI
      } else {
        r.dir = dir
      }
      r.penDir = dir
    } else if (r.dir !== r.dir) {
      // not moving yet: nothing to draw
      return
    }
    r.px = x
    r.pz = z
    if (r.slot < 0) {
      // the next slot of its ring (the oldest segment of this ribbon)
      r.slot = r.base + r.head
      r.head = r.head + 1 < r.cap ? r.head + 1 : 0
    }
    const i = r.slot * STRIDE
    const d = this.data
    d[i] = r.x; d[i + 1] = r.z; d[i + 2] = x; d[i + 3] = z
    d[i + 4] = r.t; d[i + 5] = now; d[i + 6] = life; d[i + 7] = grow
    d[i + 8] = r.w; d[i + 9] = halfWidth; d[i + 10] = r.a; d[i + 11] = alpha
    d[i + 12] = 0; d[i + 13] = 0; d[i + 14] = r.dir; d[i + 15] = r.penDir
    this.mark(r.slot)
    const dx = x - r.x
    const dz = z - r.z
    if (dx * dx + dz * dz >= this.spacing * this.spacing) {
      r.slot = -1
      r.x = x; r.z = z; r.t = now; r.w = halfWidth; r.a = alpha
      r.dir = r.penDir
    }
  }

  /** lift the pen: the ribbon ends here and the next trail() starts a new one */
  trailBreak(id: number): void {
    const r = this.ribbons[id]
    r.on = false
    r.slot = -1
  }

  /**
   * A foam patch centred on (x, z) with half-axis (ax, az) and half-width `halfWidth`,
   * spreading by `grow` of its size per second and drifting with (driftX, driftZ).
   */
  patch(
    x: number, z: number, ax: number, az: number, halfWidth: number, life: number,
    grow: number, alpha: number, seed: number, driftX: number, driftZ: number,
  ): void {
    const now = this.frame[F_NOW]
    const slot = 1 + this.trailCap + this.patchHead
    this.patchHead = (this.patchHead + 1) % this.patchCap
    const i = slot * STRIDE
    const d = this.data
    d[i] = x - ax; d[i + 1] = z - az; d[i + 2] = x + ax; d[i + 3] = z + az
    d[i + 4] = now; d[i + 5] = now; d[i + 6] = life; d[i + 7] = grow
    d[i + 8] = halfWidth; d[i + 9] = halfWidth; d[i + 10] = alpha; d[i + 11] = alpha
    d[i + 12] = KIND_PATCH; d[i + 13] = seed; d[i + 14] = driftX; d[i + 15] = driftZ
    this.mark(slot)
  }

  /** once per frame, after the frame's writes: uniforms and the upload of what changed */
  update(): void {
    const f = this.frame
    // (in a vector: a number stored straight into a uniform's `value` would be boxed)
    ;(this.material.uniforms.uClock.value as THREE.Vector2).x = f[F_NOW]
    this.mesh.position.x = f[F_OX]
    this.mesh.position.z = f[F_OZ]
    this.mesh.updateMatrix()
    if (this.dirtyHi >= this.dirtyLo) {
      this.range.start = this.dirtyLo * STRIDE
      this.range.count = (this.dirtyHi - this.dirtyLo + 1) * STRIDE
      this.buffer.needsUpdate = true
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
