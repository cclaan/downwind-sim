/**
 * Growable vertex and index buffers for one draw call, and the far-terrain squeeze.
 *
 * Vertex layout (24 bytes)
 *   position  3 x float32   ground coordinates
 *   aColor    4 x uint8     albedo, square-root encoded (rgb); sunlight reaching the vertex (a)
 *   aLight    4 x uint8     sky light (x), light bounced up from the water and ground (y),
 *                           haze distance as a multiple of the drawn distance, 64 = 1 (z),
 *                           dry far hills: the detail texture is read at the scale of woods, not crowns (w)
 *   aDetail   4 x uint8     weights of the fragment detail: rock strata (x), tree canopy (y),
 *                           grain (z); how far the strata are pushed up or down here, 0.5 = not at all (w)
 */
import * as THREE from 'three'

/** terrain farther than this from the level origin is drawn closer than it really is */
export const FAR_TRUE = 12000
const FAR_SPAN = 14000
const FAR_FALL = 22000
/** aLight.z * FAR_HAZE_MAX is the haze distance as a multiple of the drawn distance (64/255 * 255/64 = 1) */
export const FAR_HAZE_MAX = 255 / 64
/** scale height of the haze (m): sight lines to high far peaks run through thinner air */
const HAZE_HEIGHT = 1100

/** drawn distance for a true distance from the level origin (m) */
export function squeeze(r: number): number {
  return r <= FAR_TRUE ? r : FAR_TRUE + FAR_SPAN * (1 - Math.exp(-(r - FAR_TRUE) / FAR_FALL))
}

export class MeshBuilder {
  pos: Float32Array
  col: Uint8Array
  light: Uint8Array
  det: Uint8Array
  idx: Uint32Array
  nv = 0
  ni = 0

  constructor(verts = 4096, indices = 12288) {
    this.pos = new Float32Array(verts * 3)
    this.col = new Uint8Array(verts * 4)
    this.light = new Uint8Array(verts * 4)
    this.det = new Uint8Array(verts * 4)
    this.idx = new Uint32Array(indices)
  }

  private growV(): void {
    const n = this.pos.length / 3
    const m = Math.ceil(n * 1.6) + 64
    const p = new Float32Array(m * 3); p.set(this.pos); this.pos = p
    const c = new Uint8Array(m * 4); c.set(this.col); this.col = c
    const l = new Uint8Array(m * 4); l.set(this.light); this.light = l
    const d = new Uint8Array(m * 4); d.set(this.det); this.det = d
  }

  /**
   * Add a vertex at true ground coordinates. Albedo is linear 0..1; sun, sky and bounce
   * are the light factors 0..1; rock, canopy and grain the detail weights 0..1; wobble 0..1
   * shifts the strata (0.5 = level).
   */
  vertex(
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    sun: number, sky: number, bounce: number,
    rock = 0, canopy = 0, grain = 0, wobble = 0.5, farCountry = 0,
  ): number {
    if (this.nv * 3 >= this.pos.length) this.growV()
    const i = this.nv++
    let haze = 1
    const d = Math.hypot(x, z)
    if (d > FAR_TRUE) {
      // the air thins with height: a far summit is seen through less haze than its foot
      const u = Math.max(y, 1) / HAZE_HEIGHT
      const thin = (1 - Math.exp(-u)) / u
      const far = Math.min(1, (d - FAR_TRUE) / 8000)
      const k = squeeze(d) / d
      x *= k; y *= k; z *= k
      haze = (1 + (thin - 1) * far) / k
    }
    const p = i * 3
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z
    const q = i * 4
    this.col[q] = enc(Math.sqrt(r)); this.col[q + 1] = enc(Math.sqrt(g)); this.col[q + 2] = enc(Math.sqrt(b))
    this.col[q + 3] = enc(sun)
    this.light[q] = enc(sky); this.light[q + 1] = enc(bounce); this.light[q + 2] = enc(haze / FAR_HAZE_MAX); this.light[q + 3] = enc(farCountry)
    this.det[q] = enc(rock); this.det[q + 1] = enc(canopy); this.det[q + 2] = enc(grain); this.det[q + 3] = enc(wobble)
    return i
  }

  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const n = new Uint32Array(Math.ceil(this.idx.length * 1.6) + 96)
      n.set(this.idx)
      this.idx = n
    }
    this.idx[this.ni++] = a
    this.idx[this.ni++] = b
    this.idx[this.ni++] = c
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }

  get triangles(): number { return this.ni / 3 }

  /** bytes this draw call holds on the GPU */
  get bytes(): number {
    return this.nv * 24 + this.ni * (this.nv > 65535 ? 4 : 2)
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col.slice(0, this.nv * 4), 4, true))
    g.setAttribute('aLight', new THREE.BufferAttribute(this.light.slice(0, this.nv * 4), 4, true))
    g.setAttribute('aDetail', new THREE.BufferAttribute(this.det.slice(0, this.nv * 4), 4, true))
    const index = this.nv > 65535 ? this.idx.slice(0, this.ni) : new Uint16Array(this.idx.subarray(0, this.ni))
    g.setIndex(new THREE.BufferAttribute(index, 1))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

function enc(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
}
