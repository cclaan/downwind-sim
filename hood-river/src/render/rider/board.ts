/**
 * The board: a downwind SUP foil hull lofted from a handful of curves (outline, rocker,
 * thickness, a boxy section with soft rails). Built in the rider frame: origin at the
 * front wing, +X nose, +Y up through the deck, +Z starboard; the underside over the mast
 * is at y = mastLength.
 */
import * as THREE from 'three'
import { COLORS, RIDER_TUNE } from './tune'

export interface BoardSpec {
  length: number
  width: number
  mastLength: number
}

/** x of the nose and the tail in the rider frame */
export function boardEnds(spec: BoardSpec): { nose: number; tail: number } {
  const nose = RIDER_TUNE.mastFrac * spec.length
  return { nose, tail: nose - spec.length }
}

/** height of the deck surface in the rider frame at station s (0 = nose, 1 = tail) */
export function deckHeight(spec: BoardSpec, s: number): number {
  return spec.mastLength + rocker(s) + thickness(s)
}

function rocker(s: number): number {
  // nose kick and a little tail kick for release; flat under the feet
  const n = s < 0.4 ? 0.085 * Math.pow(1 - s / 0.4, 2.4) : 0
  const t = s > 0.82 ? 0.022 * Math.pow((s - 0.82) / 0.18, 2) : 0
  return n + t
}

function thickness(s: number): number {
  const full = RIDER_TUNE.boardThick
  if (s < 0.24) return full * (0.2 + 0.8 * (1 - Math.pow(1 - s / 0.24, 2)))
  if (s > 0.8) return full * (1 - 0.38 * Math.pow((s - 0.8) / 0.2, 2))
  return full
}

function halfWidth(s: number, width: number): number {
  const wide = 0.46
  const h = width / 2
  if (s < wide) return Math.max(0.006, h * (1 - Math.pow((wide - s) / wide, 1.9)))
  return h * (1 - 0.5 * Math.pow((s - wide) / (1 - wide), 2.4))
}

/** half the board's width at x in the rider frame (0 beyond the nose and the tail), for keeping things off the deck */
export function boardHalfWidth(length: number, width: number, x: number): number {
  const s = (RIDER_TUNE.mastFrac * length - x) / Math.max(0.1, length)
  return s < 0 || s > 1 ? 0 : halfWidth(s, width)
}

export function buildBoard(spec: BoardSpec, detail: number): THREE.BufferGeometry {
  const { nose } = boardEnds(spec)
  const padStart = 0.36, padEnd = 0.87
  // stations along the board: denser at the nose, doubled at the edges of the deck pad
  const stations: number[] = []
  const n = Math.max(12, Math.round(14 + 12 * detail))
  for (let i = 0; i <= n; i++) {
    const u = i / n
    stations.push(u * u * 0.3 + u * 0.7)
  }
  stations.push(0.006, 0.02, padStart - 0.004, padStart + 0.004, padEnd - 0.004, padEnd + 0.004)
  stations.sort((a, b) => a - b)
  const ringN = detail > 0.6 ? 16 : 12
  const hull = new THREE.Color(COLORS.board)
  const bottom = new THREE.Color(COLORS.boardBottom)
  const pad = new THREE.Color(COLORS.pad)

  const ns = stations.length
  const vertCount = ns * ringN + 2 * (ringN + 1)
  const position = new Float32Array(vertCount * 3)
  const color = new Float32Array(vertCount * 4)
  const index: number[] = []
  let v = 0
  const put = (x: number, y: number, z: number, c: THREE.Color, gloss: number) => {
    position[v * 3] = x; position[v * 3 + 1] = y; position[v * 3 + 2] = z
    color[v * 4] = c.r; color[v * 4 + 1] = c.g; color[v * 4 + 2] = c.b; color[v * 4 + 3] = gloss
    return v++
  }
  for (let i = 0; i < ns; i++) {
    const s = stations[i]
    const x = nose - s * spec.length
    const hw = halfWidth(s, spec.width)
    const th = thickness(s)
    const yb = spec.mastLength + rocker(s)
    const onPad = s > padStart && s < padEnd
    for (let k = 0; k < ringN; k++) {
      const a = (2 * Math.PI * k) / ringN
      const cz = Math.cos(a), sy = Math.sin(a)
      const z = hw * Math.sign(cz) * Math.pow(Math.abs(cz), 0.55)
      // rail apex a little below mid-height; flat bottom, gently crowned deck
      const y = sy >= 0 ? yb + th * (0.42 + 0.58 * Math.pow(sy, 0.45)) : yb + th * 0.42 * (1 - Math.pow(-sy, 0.5))
      let c = hull
      let gloss = 0.55
      if (sy < -0.3) { c = bottom; gloss = 0.5 }
      else if (onPad && sy > 0.6) { c = pad; gloss = 0.05 }
      put(x, y, z, c, gloss)
    }
  }
  for (let i = 0; i < ns - 1; i++) {
    for (let k = 0; k < ringN; k++) {
      const a0 = i * ringN + k, a1 = i * ringN + ((k + 1) % ringN)
      const b0 = a0 + ringN, b1 = a1 + ringN
      // station index grows toward the tail (-x); ring angle grows from starboard up over the deck
      index.push(a0, a1, b0, a1, b1, b0)
    }
  }
  // end caps with their own vertices so the tail is a crisp face
  for (const end of [0, ns - 1]) {
    const s = stations[end]
    const x = nose - s * spec.length
    const yb = spec.mastLength + rocker(s)
    const centre = put(x, yb + thickness(s) * 0.45, 0, hull, 0.5)
    const first = v
    for (let k = 0; k < ringN; k++) {
      const src = (end * ringN + k) * 3
      put(position[src], position[src + 1], position[src + 2], hull, 0.5)
    }
    for (let k = 0; k < ringN; k++) {
      const p0 = first + k, p1 = first + ((k + 1) % ringN)
      if (end === 0) index.push(centre, p1, p0)
      else index.push(centre, p0, p1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 4))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}
