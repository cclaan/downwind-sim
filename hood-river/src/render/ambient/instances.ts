/**
 * Instanced drawing for the river's traffic: one shader program for every shape, one draw
 * call per shape. Each instance is 16 floats in one interleaved buffer:
 *
 *   iA  x, y, z (ground coordinates: the mesh's group slides with app.groundShift), heading
 *   iB  side (+1 rig to starboard, -1 to port; passes smoothly through 0 in a gybe),
 *       phase (0..1, desynchronises the rig's working), lean of the rig (radians, + to
 *       leeward) or, for boxes, the height of the colour split (0..1),
 *       height used to keep the shape visible far away (m; 0 = never enlarge)
 *   iC  scale x, y, z, colour A (packed 0xRRGGBB)
 *   iD  colour B (packed), the most the shape may be enlarged, unused x 2
 *
 * Lighting is per vertex (the shapes are flat-shaded and small on screen) with the same sun
 * and hemisphere as the built-in materials; the fragment shader only adds the haze.
 */
import * as THREE from 'three'
import type { App } from '../../app/types'
import { SKY_GLSL } from '../atmosphere'
import type { Shape } from './shapes'

export const INSTANCE_FLOATS = 16

const VERT = /* glsl */ `
${SKY_GLSL}
attribute vec3 aColor;
attribute vec4 aPaint;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
// x: time (s, wrapped at 200 pi), y: radians per device pixel, z: least height on screen (pixels)
uniform vec4 uAmbient;
varying vec3 vColor;
varying float vDist;

vec3 unpackColor(float c) {
  float r = floor(c / 65536.0);
  float g = floor((c - r * 65536.0) / 256.0);
  float b = c - r * 65536.0 - g * 256.0;
  vec3 s = vec3(r, g, b) / 255.0;
  // sRGB to linear
  return s * (s * (s * 0.305306011 + 0.682171111) + 0.012522878);
}

void main() {
  vec3 p = position * iC.xyz;
  // boxes: vertices on the colour split move to the instance's split height
  p.y = mix(p.y, iB.z * iC.y, aPaint.w);
  vec3 n = normal;
  // the rig heels and works about the board's long axis (rates in hundredths of a radian per
  // second, so the motion is unbroken where the time uniform wraps at 200 pi)
  float rate = 1.1 + 0.01 * floor(60.0 * fract(iB.y * 3.7));
  float ang = aPaint.z * (iB.z + 0.07 * sin(uAmbient.x * rate + iB.y * 6.2832));
  float ca = cos(ang), sa = sin(ang);
  p.yz = vec2(p.y * ca - p.z * sa, p.y * sa + p.z * ca);
  n.yz = vec2(n.y * ca - n.z * sa, n.y * sa + n.z * ca);
  // Other tack: mirror across the board. The hull only changes sides; the sailor and the rig
  // (anything that moves with the rig at all) swing across through the centre line as the
  // bow passes through downwind, so nothing jumps in a gybe.
  float mirror = iB.x < 0.0 ? -1.0 : 1.0;
  p.z *= mix(mirror, iB.x, clamp(aPaint.z * 12.0, 0.0, 1.0));
  n.z *= mirror;
  float c = cos(iA.w), s = sin(iA.w);
  vec3 pw = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  vec3 nw = normalize(vec3(n.x * c - n.z * s, n.y, n.x * s + n.z * c));

  vec4 base = modelMatrix * vec4(iA.xyz, 1.0);
  float dist = distance(base.xyz, cameraPosition);
  // far craft stay a few pixels tall, so the river still looks busy on a phone
  float grow = iB.w > 0.0 ? clamp(dist * uAmbient.y * uAmbient.z / iB.w, 1.0, max(1.0, iD.y)) : 1.0;
  vec3 world = base.xyz + pw * grow;

  vec3 albedo = aPaint.x < 0.5 ? aColor : mix(unpackColor(iC.w), unpackColor(iD.x), clamp(aPaint.x - 1.0, 0.0, 1.0));
  vec3 light;
  if (aPaint.y < 0.5) {
    light = skyLight(nw);
  } else if (aPaint.y < 1.5) {
    // sail cloth: lit on whichever side faces the sun, and glowing when the sun is behind it
    float nl = dot(nw, uSunDir);
    float seen = dot(nw, cameraPosition - world) * nl;
    light = uSunLight * (abs(nl) * (seen < 0.0 ? 0.8 : 1.0) + 0.12) + mix(uAmbientGround, uAmbientSky, 0.75);
  } else {
    light = uSunLight * 0.8 + uAmbientSky;
  }
  vColor = albedo * light;
  vDist = distance(world, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`

const FRAG = /* glsl */ `
${SKY_GLSL}
varying vec3 vColor;
varying float vDist;
void main() {
  gl_FragColor = vec4(applyHaze(vColor, vDist), 1.0);
  #include <colorspace_fragment>
}
`

export interface AmbientMaterial {
  material: THREE.ShaderMaterial
  /** call once per frame */
  update(): void
}

export function makeAmbientMaterial(app: App): AmbientMaterial {
  const uAmbient = { value: new THREE.Vector4(0, 0.001, 5, 0) }
  const material = new THREE.ShaderMaterial({
    uniforms: { ...app.atmos.uniforms, uAmbient },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
  })
  return {
    material,
    update() {
      const u = uAmbient.value
      u.x = app.time % (200 * Math.PI)
      const fov = (app.camera.fov * Math.PI) / 180
      u.y = (2 * Math.tan(fov / 2)) / Math.max(1, app.height * app.pixelRatio)
      // about 5 CSS pixels tall at the least
      u.z = 5 * app.pixelRatio
    },
  }
}

export class InstanceSet {
  readonly data: Float32Array
  readonly mesh: THREE.Mesh
  readonly capacity: number
  readonly triangles: number
  private readonly buffer: THREE.InstancedInterleavedBuffer
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly growHeight: number
  private readonly growMax: number

  constructor(shape: Shape, capacity: number, material: THREE.ShaderMaterial) {
    this.capacity = capacity
    this.triangles = shape.triangles
    this.growHeight = shape.height
    this.growMax = shape.growMax
    this.data = new Float32Array(capacity * INSTANCE_FLOATS)
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(shape.position, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(shape.normal, 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(shape.color, 3))
    g.setAttribute('aPaint', new THREE.BufferAttribute(shape.paint, 4))
    const buf = new THREE.InstancedInterleavedBuffer(this.data, INSTANCE_FLOATS)
    buf.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0))
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 4))
    g.setAttribute('iC', new THREE.InterleavedBufferAttribute(buf, 4, 8))
    g.setAttribute('iD', new THREE.InterleavedBufferAttribute(buf, 4, 12))
    g.instanceCount = 0
    this.buffer = buf
    this.geometry = g
    this.mesh = new THREE.Mesh(g, material)
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
  }

  /** craft: position, heading, tack, rig lean and the two sail colours */
  setCraft(i: number, x: number, y: number, z: number, heading: number, side: number, phase: number, lean: number, colA: number, colB: number) {
    const d = this.data
    const o = i * INSTANCE_FLOATS
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = heading
    d[o + 4] = side; d[o + 5] = phase; d[o + 6] = lean; d[o + 7] = this.growHeight
    d[o + 8] = 1; d[o + 9] = 1; d[o + 10] = 1; d[o + 11] = colA
    d[o + 12] = colB; d[o + 13] = this.growMax
  }

  /** box: base centre, heading, size, colours below and above the split (0..1 of the height) */
  setBox(i: number, x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number, split: number, colA: number, colB: number) {
    const d = this.data
    const o = i * INSTANCE_FLOATS
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = heading
    d[o + 4] = 1; d[o + 5] = 0; d[o + 6] = split; d[o + 7] = 0
    d[o + 8] = sx; d[o + 9] = sy; d[o + 10] = sz; d[o + 11] = colA
    d[o + 12] = colB
  }

  /** upload the first `count` instances and draw them */
  commit(count: number) {
    this.geometry.instanceCount = Math.min(count, this.capacity)
    this.buffer.needsUpdate = true
  }

  dispose() {
    this.geometry.dispose()
  }
}
