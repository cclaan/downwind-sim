/**
 * A small tileable noise texture, generated at load, that breaks foam up into patches and
 * streaks. One channel, 64 x 64, mipmapped; values spread evenly over 0..1.
 */
import * as THREE from 'three'
import { mulberry32 } from '../../sim/rng'

export function makeFoamNoise(size = 64, seed = 20260715): THREE.DataTexture {
  const rand = mulberry32(seed)
  const acc = new Float32Array(size * size)
  // four octaves of value noise on wrapping lattices
  const octaves: [number, number][] = [[4, 0.42], [8, 0.28], [16, 0.19], [32, 0.11]]
  for (const [cells, amp] of octaves) {
    const lattice = new Float32Array(cells * cells)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand()
    const scale = cells / size
    for (let y = 0; y < size; y++) {
      const fy = y * scale
      const y0 = Math.floor(fy)
      const ty = fy - y0
      const sy = ty * ty * (3 - 2 * ty)
      const ya = (y0 % cells) * cells
      const yb = ((y0 + 1) % cells) * cells
      for (let x = 0; x < size; x++) {
        const fx = x * scale
        const x0 = Math.floor(fx)
        const tx = fx - x0
        const sx = tx * tx * (3 - 2 * tx)
        const xa = x0 % cells
        const xb = (x0 + 1) % cells
        const top = lattice[ya + xa] + (lattice[ya + xb] - lattice[ya + xa]) * sx
        const bot = lattice[yb + xa] + (lattice[yb + xb] - lattice[yb + xa]) * sx
        acc[y * size + x] += amp * (top + (bot - top) * sy)
      }
    }
  }
  // Equalise: every level 0..255 covers the same area, so a threshold t in the shader leaves
  // exactly the fraction t of the surface covered, whatever the seed.
  const order = new Uint16Array(size * size)
  for (let i = 0; i < order.length; i++) order[i] = i
  order.sort((a, b) => acc[a] - acc[b])
  const data = new Uint8Array(size * size)
  for (let rank = 0; rank < order.length; rank++) data[order[rank]] = Math.floor((rank * 256) / order.length)
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}
