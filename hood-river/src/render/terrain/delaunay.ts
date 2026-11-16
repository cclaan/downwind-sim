/**
 * Delaunay triangulation of a 2-D point set by the sweep-hull method: points are added in
 * order of distance from a seed triangle, each new point is joined to the edges of the
 * convex hull it can see, and edges are flipped until every triangle's circumcircle is
 * empty. O(n log n); about a million points a second.
 *
 * This is a TypeScript version of the algorithm in Delaunator
 * (https://github.com/mapbox/delaunator), used under its ISC licence:
 *
 *   Copyright (c) 2017, Mapbox
 *   Permission to use, copy, modify, and/or distribute this software for any purpose with
 *   or without fee is hereby granted, provided that the above copyright notice and this
 *   permission notice appear in all copies.
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO
 *   THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO
 *   EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
 *   DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER
 *   IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 *   CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Input: coords = [x0, y0, x1, y1, ...]. Output: vertex indices, three per triangle.
 * Exact duplicates are skipped. The caller jitters its points, so plain double arithmetic
 * is enough for the orientation and in-circle tests.
 */

const EDGE_STACK = new Uint32Array(512)

function orient(px: number, py: number, qx: number, qy: number, rx: number, ry: number): number {
  return (qy - py) * (rx - qx) - (qx - px) * (ry - qy)
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by
  return dx * dx + dy * dy
}

function inCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const dx = ax - px, dy = ay - py
  const ex = bx - px, ey = by - py
  const fx = cx - px, fy = cy - py
  const ap = dx * dx + dy * dy
  const bp = ex * ex + ey * ey
  const cp = fx * fx + fy * fy
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0
}

function circumradius2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const dx = bx - ax, dy = by - ay
  const ex = cx - ax, ey = cy - ay
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const d = 0.5 / (dx * ey - dy * ex)
  const x = (ey * bl - dy * cl) * d
  const y = (dx * cl - ex * bl) * d
  return x * x + y * y
}

/** monotonic with the angle of (dx, dy), in [0, 1) */
function pseudoAngle(dx: number, dy: number): number {
  const m = Math.abs(dx) + Math.abs(dy)
  if (m === 0) return 0
  const p = dx / m
  return (dy > 0 ? 3 - p : 1 + p) / 4
}

function sortByDist(ids: Uint32Array, dists: Float64Array, left: number, right: number): void {
  if (right - left <= 20) {
    for (let i = left + 1; i <= right; i++) {
      const temp = ids[i]
      const tempDist = dists[temp]
      let j = i - 1
      while (j >= left && dists[ids[j]] > tempDist) ids[j + 1] = ids[j--]
      ids[j + 1] = temp
    }
    return
  }
  const median = (left + right) >> 1
  let i = left + 1
  let j = right
  swap(ids, median, i)
  if (dists[ids[left]] > dists[ids[right]]) swap(ids, left, right)
  if (dists[ids[i]] > dists[ids[right]]) swap(ids, i, right)
  if (dists[ids[left]] > dists[ids[i]]) swap(ids, left, i)
  const temp = ids[i]
  const tempDist = dists[temp]
  for (;;) {
    do i++; while (dists[ids[i]] < tempDist)
    do j--; while (dists[ids[j]] > tempDist)
    if (j < i) break
    swap(ids, i, j)
  }
  ids[left + 1] = ids[j]
  ids[j] = temp
  if (right - i + 1 >= j - left) {
    sortByDist(ids, dists, i, right)
    sortByDist(ids, dists, left, j - 1)
  } else {
    sortByDist(ids, dists, left, j - 1)
    sortByDist(ids, dists, i, right)
  }
}

function swap(a: Uint32Array, i: number, j: number): void {
  const t = a[i]
  a[i] = a[j]
  a[j] = t
}

export function triangulate(coords: Float64Array): Uint32Array {
  const n = coords.length >> 1
  if (n < 3) return new Uint32Array(0)
  const maxTriangles = Math.max(2 * n - 5, 0)
  const triangles = new Uint32Array(maxTriangles * 3)
  const halfedges = new Int32Array(maxTriangles * 3)
  const hashSize = Math.ceil(Math.sqrt(n))
  const hullPrev = new Uint32Array(n)
  const hullNext = new Uint32Array(n)
  const hullTri = new Uint32Array(n)
  const hullHash = new Int32Array(hashSize).fill(-1)
  const ids = new Uint32Array(n)
  const dists = new Float64Array(n)
  let trianglesLen = 0

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = coords[2 * i], y = coords[2 * i + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    ids[i] = i
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2

  // seed: the point nearest the centre, its nearest neighbour, and the third point that
  // makes the smallest circumcircle with them
  let i0 = 0, i1 = 0, i2 = 0
  let minDist = Infinity
  for (let i = 0; i < n; i++) {
    const d = dist2(cx, cy, coords[2 * i], coords[2 * i + 1])
    if (d < minDist) { i0 = i; minDist = d }
  }
  const i0x = coords[2 * i0], i0y = coords[2 * i0 + 1]
  minDist = Infinity
  for (let i = 0; i < n; i++) {
    if (i === i0) continue
    const d = dist2(i0x, i0y, coords[2 * i], coords[2 * i + 1])
    if (d < minDist && d > 0) { i1 = i; minDist = d }
  }
  let i1x = coords[2 * i1], i1y = coords[2 * i1 + 1]
  let minRadius = Infinity
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1) continue
    const r = circumradius2(i0x, i0y, i1x, i1y, coords[2 * i], coords[2 * i + 1])
    if (r < minRadius) { i2 = i; minRadius = r }
  }
  if (minRadius === Infinity) return new Uint32Array(0) // all points on one line
  let i2x = coords[2 * i2], i2y = coords[2 * i2 + 1]

  if (orient(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
    const i = i1, x = i1x, y = i1y
    i1 = i2; i1x = i2x; i1y = i2y
    i2 = i; i2x = x; i2y = y
  }

  // circumcentre of the seed triangle
  let ccx: number, ccy: number
  {
    const dx = i1x - i0x, dy = i1y - i0y
    const ex = i2x - i0x, ey = i2y - i0y
    const bl = dx * dx + dy * dy
    const cl = ex * ex + ey * ey
    const d = 0.5 / (dx * ey - dy * ex)
    ccx = i0x + (ey * bl - dy * cl) * d
    ccy = i0y + (dx * cl - ex * bl) * d
  }
  for (let i = 0; i < n; i++) dists[i] = dist2(coords[2 * i], coords[2 * i + 1], ccx, ccy)
  sortByDist(ids, dists, 0, n - 1)

  const hashKey = (x: number, y: number) => Math.floor(pseudoAngle(x - ccx, y - ccy) * hashSize) % hashSize

  const link = (a: number, b: number) => {
    halfedges[a] = b
    if (b !== -1) halfedges[b] = a
  }
  const addTriangle = (a: number, b: number, c: number, ha: number, hb: number, hc: number): number => {
    const t = trianglesLen
    triangles[t] = a
    triangles[t + 1] = b
    triangles[t + 2] = c
    link(t, ha)
    link(t + 1, hb)
    link(t + 2, hc)
    trianglesLen += 3
    return t
  }

  let hullStart = i0
  hullNext[i0] = hullPrev[i2] = i1
  hullNext[i1] = hullPrev[i0] = i2
  hullNext[i2] = hullPrev[i1] = i0
  hullTri[i0] = 0
  hullTri[i1] = 1
  hullTri[i2] = 2
  hullHash[hashKey(i0x, i0y)] = i0
  hullHash[hashKey(i1x, i1y)] = i1
  hullHash[hashKey(i2x, i2y)] = i2
  addTriangle(i0, i1, i2, -1, -1, -1)

  // flip edges around half-edge `a` until the Delaunay condition holds; returns the
  // half-edge on the far side, which stays on the hull
  const legalize = (a: number): number => {
    let i = 0
    let ar = 0
    for (;;) {
      const b = halfedges[a]
      const a0 = a - (a % 3)
      ar = a0 + ((a + 2) % 3)
      if (b === -1) {
        if (i === 0) break
        a = EDGE_STACK[--i]
        continue
      }
      const b0 = b - (b % 3)
      const al = a0 + ((a + 1) % 3)
      const bl = b0 + ((b + 2) % 3)
      const p0 = triangles[ar]
      const pr = triangles[a]
      const pl = triangles[al]
      const p1 = triangles[bl]
      const illegal = inCircle(
        coords[2 * p0], coords[2 * p0 + 1],
        coords[2 * pr], coords[2 * pr + 1],
        coords[2 * pl], coords[2 * pl + 1],
        coords[2 * p1], coords[2 * p1 + 1],
      )
      if (illegal) {
        triangles[a] = p1
        triangles[b] = p0
        const hbl = halfedges[bl]
        // the flipped edge was on the hull on the other side: repair the hull's reference
        if (hbl === -1) {
          let e = hullStart
          do {
            if (hullTri[e] === bl) { hullTri[e] = a; break }
            e = hullPrev[e]
          } while (e !== hullStart)
        }
        link(a, hbl)
        link(b, halfedges[ar])
        link(ar, bl)
        const br = b0 + ((b + 1) % 3)
        if (i < EDGE_STACK.length) EDGE_STACK[i++] = br
      } else {
        if (i === 0) break
        a = EDGE_STACK[--i]
      }
    }
    return ar
  }

  let xp = NaN, yp = NaN
  for (let k = 0; k < n; k++) {
    const i = ids[k]
    const x = coords[2 * i], y = coords[2 * i + 1]
    if (k > 0 && Math.abs(x - xp) <= 1e-9 && Math.abs(y - yp) <= 1e-9) continue
    xp = x
    yp = y
    if (i === i0 || i === i1 || i === i2) continue

    // find a hull edge the point can see, starting from the hash of its direction
    let start = 0
    for (let j = 0, key = hashKey(x, y); j < hashSize; j++) {
      start = hullHash[(key + j) % hashSize]
      if (start !== -1 && start !== hullNext[start]) break
    }
    start = hullPrev[start]
    let e = start
    let q = hullNext[e]
    let found = true
    while (orient(x, y, coords[2 * e], coords[2 * e + 1], coords[2 * q], coords[2 * q + 1]) >= 0) {
      e = q
      if (e === start) { found = false; break }
      q = hullNext[e]
    }
    if (!found) continue // a near-duplicate: leave it out

    let t = addTriangle(e, i, hullNext[e], -1, -1, hullTri[e])
    hullTri[i] = legalize(t + 2)
    hullTri[e] = t

    // walk forward along the hull, adding triangles while the next edge is visible
    let nxt = hullNext[e]
    q = hullNext[nxt]
    while (orient(x, y, coords[2 * nxt], coords[2 * nxt + 1], coords[2 * q], coords[2 * q + 1]) < 0) {
      t = addTriangle(nxt, i, q, hullTri[i], -1, hullTri[nxt])
      hullTri[i] = legalize(t + 2)
      hullNext[nxt] = nxt // removed from the hull
      nxt = q
      q = hullNext[nxt]
    }
    // and backward
    if (e === start) {
      q = hullPrev[e]
      while (orient(x, y, coords[2 * q], coords[2 * q + 1], coords[2 * e], coords[2 * e + 1]) < 0) {
        t = addTriangle(q, i, e, -1, hullTri[e], hullTri[q])
        legalize(t + 2)
        hullTri[q] = t
        hullNext[e] = e // removed from the hull
        e = q
        q = hullPrev[e]
      }
    }
    hullStart = hullPrev[i] = e
    hullNext[e] = hullPrev[nxt] = i
    hullNext[i] = nxt
    hullHash[hashKey(x, y)] = i
    hullHash[hashKey(coords[2 * e], coords[2 * e + 1])] = e
  }

  return triangles.subarray(0, trianglesLen)
}
