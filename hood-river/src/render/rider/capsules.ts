/**
 * A set of capsules drawn in one instanced call. Each capsule is two end points with a
 * radius each, a wide direction and a squash factor; see CAPSULE_VERT.
 */
import * as THREE from 'three'
import { CAPSULE_VERT, LIT_FRAG } from './shaders'

/** unit sphere split at the equator: lower half belongs to end A, upper half to end B */
function buildTemplate(radial: number, rings: number): { position: Float32Array; end: Float32Array; index: Uint16Array } {
  const ringCount = 2 * rings
  const vertCount = 2 + ringCount * radial
  const position = new Float32Array(vertCount * 3)
  const end = new Float32Array(vertCount)
  let v = 0
  const put = (x: number, y: number, z: number, e: number) => {
    position[v * 3] = x; position[v * 3 + 1] = y; position[v * 3 + 2] = z
    end[v] = e
    v++
  }
  put(0, -1, 0, 0)
  // lower rings j = 1..rings (the last one is the equator), then upper rings j = 0..rings-1
  for (let half = 0; half < 2; half++) {
    for (let j = 0; j < rings; j++) {
      const phi = half === 0 ? (-Math.PI / 2) * (1 - (j + 1) / rings) : (Math.PI / 2) * (j / rings)
      const c = Math.cos(phi), s = Math.sin(phi)
      for (let i = 0; i < radial; i++) {
        const th = (2 * Math.PI * i) / radial
        put(c * Math.cos(th), s, c * Math.sin(th), half)
      }
    }
  }
  put(0, 1, 0, 1)
  const triCount = 2 * radial + (ringCount - 1) * radial * 2
  const index = new Uint16Array(triCount * 3)
  let t = 0
  const ring = (r: number, i: number) => 1 + r * radial + (i % radial)
  for (let i = 0; i < radial; i++) {
    index[t++] = 0; index[t++] = ring(0, i); index[t++] = ring(0, i + 1)
  }
  for (let r = 0; r < ringCount - 1; r++) {
    for (let i = 0; i < radial; i++) {
      const a0 = ring(r, i), a1 = ring(r, i + 1), b0 = ring(r + 1, i), b1 = ring(r + 1, i + 1)
      index[t++] = a0; index[t++] = b0; index[t++] = a1
      index[t++] = a1; index[t++] = b0; index[t++] = b1
    }
  }
  const top = vertCount - 1
  for (let i = 0; i < radial; i++) {
    index[t++] = top; index[t++] = ring(ringCount - 1, i + 1); index[t++] = ring(ringCount - 1, i)
  }
  return { position, end, index }
}

export class CapsuleSet {
  readonly mesh: THREE.Mesh
  readonly count: number
  readonly material: THREE.ShaderMaterial
  private geometry: THREE.InstancedBufferGeometry
  private a: Float32Array
  private b: Float32Array
  private s: Float32Array
  private c: Float32Array
  private attrA: THREE.InstancedBufferAttribute
  private attrB: THREE.InstancedBufferAttribute
  private attrS: THREE.InstancedBufferAttribute
  private attrC: THREE.InstancedBufferAttribute
  triangles = 0

  constructor(count: number, uniforms: Record<string, THREE.IUniform>, radial: number, rings: number) {
    this.count = count
    this.a = new Float32Array(count * 4)
    this.b = new Float32Array(count * 4)
    this.s = new Float32Array(count * 4)
    this.c = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) { this.s[i * 4] = 1; this.s[i * 4 + 3] = 1; this.c[i * 4 + 3] = 0 }
    this.attrA = new THREE.InstancedBufferAttribute(this.a, 4).setUsage(THREE.DynamicDrawUsage)
    this.attrB = new THREE.InstancedBufferAttribute(this.b, 4).setUsage(THREE.DynamicDrawUsage)
    this.attrS = new THREE.InstancedBufferAttribute(this.s, 4).setUsage(THREE.DynamicDrawUsage)
    this.attrC = new THREE.InstancedBufferAttribute(this.c, 4)
    this.geometry = this.makeGeometry(radial, rings)
    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: CAPSULE_VERT, fragmentShader: LIT_FRAG })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
  }

  private makeGeometry(radial: number, rings: number): THREE.InstancedBufferGeometry {
    const tpl = buildTemplate(radial, rings)
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(tpl.position, 3))
    g.setAttribute('aEnd', new THREE.BufferAttribute(tpl.end, 1))
    g.setIndex(new THREE.BufferAttribute(tpl.index, 1))
    g.setAttribute('iA', this.attrA)
    g.setAttribute('iB', this.attrB)
    g.setAttribute('iS', this.attrS)
    g.setAttribute('iC', this.attrC)
    g.instanceCount = this.count
    this.triangles = (tpl.index.length / 3) * this.count
    return g
  }

  /** change tessellation (quality tier); instance data is kept */
  setDetail(radial: number, rings: number): void {
    const old = this.geometry
    this.geometry = this.makeGeometry(radial, rings)
    this.mesh.geometry = this.geometry
    old.dispose()
  }

  /** end points and radii */
  set(i: number, ax: number, ay: number, az: number, ra: number, bx: number, by: number, bz: number, rb: number): void {
    const j = i * 4
    const a = this.a, b = this.b
    a[j] = ax; a[j + 1] = ay; a[j + 2] = az; a[j + 3] = ra
    b[j] = bx; b[j + 1] = by; b[j + 2] = bz; b[j + 3] = rb
  }

  setV(i: number, A: THREE.Vector3, ra: number, B: THREE.Vector3, rb: number): void {
    this.set(i, A.x, A.y, A.z, ra, B.x, B.y, B.z, rb)
  }

  /** wide direction and the thin axis as a fraction of the radius (1 = round) */
  shape(i: number, sx: number, sy: number, sz: number, squash: number): void {
    const j = i * 4
    const s = this.s
    s[j] = sx; s[j + 1] = sy; s[j + 2] = sz; s[j + 3] = squash
  }

  /** leave a capsule out of the picture until it is set again (its shape is rewritten every frame) */
  hide(i: number): void {
    this.s[i * 4 + 3] = -1
  }

  /** linear colour and gloss */
  color(i: number, col: THREE.Color, gloss: number): void {
    const j = i * 4
    const c = this.c
    c[j] = col.r; c[j + 1] = col.g; c[j + 2] = col.b; c[j + 3] = gloss
    this.attrC.needsUpdate = true
  }

  /** upload this frame's end points and shapes */
  commit(): void {
    this.attrA.needsUpdate = true
    this.attrB.needsUpdate = true
    this.attrS.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
