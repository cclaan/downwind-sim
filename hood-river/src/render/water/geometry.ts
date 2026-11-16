/**
 * The river surface as one static indexed geometry (one draw call): nested square rings of
 * doubling cell size around the rider plus a flat skirt to the horizon.
 *
 * Vertex attribute `position` is not a position: it is (i, j, level).
 *   level >= 0   (i, j) are lattice indices of that level, relative to the level's origin.
 *                The origin is snapped on the CPU to the level's 2-cell world lattice and the
 *                vertex shader morphs odd lattice lines onto the parent lattice toward the
 *                outer edge (see WATER_VERTEX), so vertices only ever sit on fixed world
 *                points and never swim.
 *   level  < 0   skirt: (i, j) are metres from the outermost level's origin; flat.
 *
 * Level 0 is a full grid. Every other level is a grid with a hole one cell smaller, each
 * way, than the level inside it, so it overlaps that level by 0..2 of its own cells for any
 * snap offset (no stitching strips). Diagonals alternate on lattice parity, which makes a
 * fully morphed level coincide triangle for triangle with its parent.
 *
 * Levels need not be the same size: level 0 can be made larger than the rings, which is
 * what buys a wider zone of 0.5 m cells around the rider (see `exactRadius`).
 */
import * as THREE from 'three'

export interface WaterLevel {
  /** cells across (multiple of 4) */
  n: number
  /** cell size (m) */
  cell: number
  /** half extent (m) */
  half: number
  /** half width of the hole in cells (0 for level 0) */
  hole: number
  /** morph band, as fractions of the half extent */
  morph0: number
  morph1: number
}

export interface WaterGrid {
  geometry: THREE.BufferGeometry
  /** ring size the grid was built for */
  n: number
  levels: WaterLevel[]
  /** cell size of level 0 (m) */
  cell0: number
  vertices: number
  triangles: number
  /** half extent of the outermost level (m) */
  outerHalf: number
  /** distance from the rider out to which the mesh has level-0 cells and is not morphing */
  exactRadius: number
  /** distance out to which cells are at most twice that (no wave component is faded) */
  fullRadius: number
}

/** half extent of the skirt (m): under half a pixel short of a flat horizon from 9 m up */
export const SKIRT_HALF = 30000

/** width of the morph band as a fraction of a level's half extent */
const MORPH_BAND = 0.14

/**
 * Where a level morphs onto its parent's lattice, as fractions of its half extent.
 * Measured from the unsnapped centre, the next level's hole can reach in as far as
 * 1 - 12/n (its own snap and this level's), so the morph has to be complete by there; and
 * this level overlaps the one inside it out to hole + 4 cells, where it must not have
 * started. In between, later is better: the level keeps its own cell size for longer.
 */
function morphBand(n: number, hole: number): [number, number] {
  const m1 = 1 - 12.5 / n
  const m0 = Math.max(m1 - MORPH_BAND, (hole + 4.5) / (n / 2))
  return [Math.min(m0, m1 - 0.03), m1]
}

/** smallest level size (multiple of 4, at least nMin) whose unmorphed zone reaches `radius` */
function sizeFor(radius: number, cell: number, hole: number, nMin: number): number {
  let n = Math.max(64, Math.ceil(nMin / 4) * 4, Math.ceil((2 * (hole + 18)) / 4) * 4)
  for (; n < 1024; n += 4) {
    const [m0] = morphBand(n, hole)
    if (m0 * (n / 2) * cell >= radius) break
  }
  return n
}

/**
 * @param nRing        ring size in cells (quality.waterSegments)
 * @param levelCount   number of levels
 * @param cell0        cell size of level 0 (m)
 * @param exactRadius  level 0 is enlarged until its unmorphed zone reaches this far (0 = keep nRing)
 * @param fullRadius   level 1 is enlarged until its unmorphed zone reaches this far (0 = keep nRing)
 */
export function buildWaterGrid(nRing: number, levelCount: number, cell0: number, exactRadius = 0, fullRadius = 0): WaterGrid {
  const nBase = Math.max(64, Math.round(nRing / 4) * 4)
  const levels: WaterLevel[] = []
  for (let l = 0; l < levelCount; l++) {
    const cell = cell0 * 2 ** l
    const hole = l === 0 ? 0 : levels[l - 1].n / 4 - 1
    const want = l === 0 ? exactRadius : l === 1 ? fullRadius : 0
    const n = sizeFor(want, cell, hole, nBase)
    const [morph0, morph1] = morphBand(n, hole)
    levels.push({ n, cell, half: (n / 2) * cell, hole, morph0, morph1 })
  }

  // count
  const SK_SEG = 8 // skirt segments per side
  const SK_RINGS = 9
  const loop = SK_SEG * 4
  let nVerts = (SK_RINGS + 1) * loop
  let nTris = 2 * SK_RINGS * loop
  for (const lv of levels) {
    const side = lv.n + 1
    const inner = lv.hole > 0 ? 2 * lv.hole - 1 : 0 // lattice points strictly inside the hole, per axis
    nVerts += side * side - inner * inner
    nTris += 2 * (lv.n * lv.n - 4 * lv.hole * lv.hole)
  }
  const pos = new Float32Array(nVerts * 3)
  const idx = nVerts > 65535 ? new Uint32Array(nTris * 3) : new Uint16Array(nTris * 3)

  let v = 0
  let t = 0
  for (let l = 0; l < levels.length; l++) {
    const { n, hole } = levels[l]
    const half = n / 2
    const side = n + 1
    const lut = new Int32Array(side * side).fill(-1)
    for (let j = -half; j <= half; j++) {
      for (let i = -half; i <= half; i++) {
        if (hole > 0 && i > -hole && i < hole && j > -hole && j < hole) continue
        lut[(j + half) * side + (i + half)] = v
        pos[v * 3] = i
        pos[v * 3 + 1] = j
        pos[v * 3 + 2] = l
        v++
      }
    }
    for (let j = -half; j < half; j++) {
      for (let i = -half; i < half; i++) {
        if (hole > 0 && i >= -hole && i < hole && j >= -hole && j < hole) continue
        const a = lut[(j + half) * side + (i + half)]
        const b = lut[(j + half) * side + (i + 1 + half)]
        const c = lut[(j + 1 + half) * side + (i + 1 + half)]
        const d = lut[(j + 1 + half) * side + (i + half)]
        // counter-clockwise seen from above (+y); diagonal alternates on lattice parity
        if (((i + j) & 1) === 0) {
          idx[t++] = a; idx[t++] = c; idx[t++] = b
          idx[t++] = a; idx[t++] = d; idx[t++] = c
        } else {
          idx[t++] = a; idx[t++] = d; idx[t++] = b
          idx[t++] = b; idx[t++] = d; idx[t++] = c
        }
      }
    }
  }

  // skirt: square loops growing geometrically from two cells inside the outer edge
  const outer = levels[levels.length - 1]
  const r0 = (outer.n / 2 - 2) * outer.cell
  const growth = Math.pow(SKIRT_HALF / r0, 1 / SK_RINGS)
  const loopStart: number[] = []
  for (let k = 0; k <= SK_RINGS; k++) {
    const r = k === SK_RINGS ? SKIRT_HALF : r0 * Math.pow(growth, k)
    loopStart.push(v)
    for (let sideIdx = 0; sideIdx < 4; sideIdx++) {
      for (let s = 0; s < SK_SEG; s++) {
        const u = (s / SK_SEG) * 2 - 1
        // walk the square counter-clockwise seen from above
        let x = 0
        let z = 0
        if (sideIdx === 0) { x = r; z = -u * r }
        else if (sideIdx === 1) { x = -u * r; z = -r }
        else if (sideIdx === 2) { x = -r; z = u * r }
        else { x = u * r; z = r }
        pos[v * 3] = x
        pos[v * 3 + 1] = z
        pos[v * 3 + 2] = -1
        v++
      }
    }
  }
  for (let k = 0; k < SK_RINGS; k++) {
    const i0 = loopStart[k]
    const o0 = loopStart[k + 1]
    for (let s = 0; s < loop; s++) {
      const s1 = (s + 1) % loop
      const a = i0 + s, b = i0 + s1, c = o0 + s1, d = o0 + s
      idx[t++] = a; idx[t++] = c; idx[t++] = b
      idx[t++] = a; idx[t++] = d; idx[t++] = c
    }
  }
  if (v !== nVerts || t !== nTris * 3) throw new Error(`water grid: counted ${nVerts}/${nTris * 3}, built ${v}/${t}`)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setIndex(new THREE.BufferAttribute(idx, 1))
  // never culled or ray-cast: give three bounds so it does not compute them from (i, j, level)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKIRT_HALF * 1.5)
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-SKIRT_HALF, -5, -SKIRT_HALF),
    new THREE.Vector3(SKIRT_HALF, 5, SKIRT_HALF),
  )

  return {
    geometry,
    n: nBase,
    levels,
    cell0,
    vertices: nVerts,
    triangles: nTris,
    outerHalf: outer.half,
    exactRadius: levels[0].morph0 * levels[0].half,
    fullRadius: levels.length > 1 ? levels[1].morph0 * levels[1].half : levels[0].half,
  }
}
