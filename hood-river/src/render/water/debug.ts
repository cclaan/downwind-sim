/**
 * Proof that the drawn surface is the physics surface (loaded only with ?waterdebug=N).
 *
 * 1. Markers (?waterdebug=1 only): two-tone balls centred on app.sim.waves.height() around
 *    the rider. A ball that sits on the drawn surface shows exactly its white upper half;
 *    red showing means the drawn water is low, a shrunken white cap means it is high. Small
 *    balls (5 cm across, every metre out to 6 m) show the 2 cm tolerance by eye; large ones
 *    (20 cm, every 5 m out to 40 m) show the far ring.
 * 2. window.__waterCheck(radius = 40, size = 1024): renders the water mesh from straight
 *    above into a target with the surface height written to the colour, reads it back and
 *    compares every pixel with waves.height() on the CPU. Returns the error by distance
 *    from the rider.
 */
import * as THREE from 'three'
import type { App } from '../../app/types'
import type { WaterGrid } from './geometry'
import { WATER_VERTEX } from './shaders'

interface Ctx {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  uniforms: Record<string, THREE.IUniform>
  getGrid(): WaterGrid
  /** draw the marker balls (off for the false-colour views) */
  markers: boolean
}

export interface WaterCheckBand {
  from: number
  to: number
  samples: number
  maxCm: number
  rmsCm: number
  p99Cm: number
  meanCm: number
}

declare global {
  interface Window {
    __waterCheck?: (radius?: number, size?: number) => {
      tier: string; n: number; time: number; vertices: number; triangles: number
      /** pixels inside the radius that no triangle covered (cracks) */
      holes: number
      bands: WaterCheckBand[]
      worst: { x: number; z: number; errCm: number; dist: number }
    }
  }
}

function twoToneBall(radius: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, 14, 10)
  const pos = g.getAttribute('position')
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const up = pos.getY(i) >= -1e-6
    col[i * 3] = up ? 1 : 0.95
    col[i * 3 + 1] = up ? 1 : 0.05
    col[i * 3 + 2] = up ? 1 : 0.05
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

export function createWaterDebug(app: App, ctx: Ctx): { update(): void; dispose(): void } {
  const waves = app.sim.waves
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })

  // ---- markers
  const FINE_STEP = 1, FINE_HALF = 6
  const COARSE_STEP = 5, COARSE_HALF = 8
  const fineCount = (2 * FINE_HALF + 1) ** 2
  const coarseCount = (2 * COARSE_HALF + 1) ** 2
  const fine = new THREE.InstancedMesh(twoToneBall(0.025), mat, fineCount)
  const coarse = new THREE.InstancedMesh(twoToneBall(0.1), mat, coarseCount)
  for (const m of [fine, coarse]) {
    m.frustumCulled = false
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (ctx.markers) app.scene.add(m)
  }
  const mtx = new THREE.Matrix4()

  function place(mesh: THREE.InstancedMesh, step: number, half: number, offset: number) {
    const t = app.time
    // anchored to a world lattice (deliberately off the mesh's own lattice)
    const bx = Math.round(app.view.x / step) * step + offset
    const bz = Math.round(app.view.z / step) * step + offset
    let k = 0
    for (let j = -half; j <= half; j++) {
      for (let i = -half; i <= half; i++) {
        const x = bx + i * step
        const z = bz + j * step
        mtx.makeTranslation(x, waves.height(x, z, t), z)
        mesh.setMatrixAt(k++, mtx)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  // ---- numeric check
  const heightMaterial = new THREE.ShaderMaterial({
    uniforms: ctx.uniforms,
    defines: { SKY_VERTEX: 0 },
    vertexShader: WATER_VERTEX,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vLocal;
      varying vec4 vWave;
      void main() {
        float h = clamp((vLocal.y + 4.0) / 8.0, 0.0, 1.0) * 65535.0;
        float hi = floor(h / 256.0);
        gl_FragColor = vec4(hi / 255.0, (h - hi * 256.0) / 255.0, vWave.w, 1.0);
      }
    `,
  })
  const checkScene = new THREE.Scene()
  const checkMesh = new THREE.Mesh(ctx.mesh.geometry, heightMaterial)
  checkMesh.frustumCulled = false
  checkScene.add(checkMesh)

  window.__waterCheck = (radius = 40, size = 1024) => {
    const grid = ctx.getGrid()
    checkMesh.geometry = grid.geometry
    checkMesh.position.copy(ctx.mesh.position)
    checkMesh.updateMatrixWorld(true)
    const cx = app.view.x
    const cz = app.view.z
    const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 1, 400)
    cam.up.set(0, 0, -1)
    cam.position.set(cx, 200, cz)
    cam.lookAt(cx, 0, cz)
    cam.updateMatrixWorld(true)
    const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat })
    rt.texture.colorSpace = THREE.NoColorSpace
    // this view is not the game camera's: switch the vertex shader's frustum culling off for it
    const cull = ctx.uniforms.uCull.value as THREE.Vector4[]
    const saved = cull.map((v) => v.clone())
    for (const v of cull) v.set(0, 0, 0, 1e9)
    const r = app.renderer
    const prevTarget = r.getRenderTarget()
    r.setRenderTarget(rt)
    r.setClearColor(0x000000, 0)
    r.clear()
    r.render(checkScene, cam)
    const px = new Uint8Array(size * size * 4)
    r.readRenderTargetPixels(rt, 0, 0, size, size, px)
    r.setRenderTarget(prevTarget)
    rt.dispose()
    cull.forEach((v, i) => v.copy(saved[i]))

    const edges = [0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 80, 100, 150, 200].filter((e) => e <= radius * 1.0001)
    if (edges[edges.length - 1] < radius) edges.push(radius)
    const errs: number[][] = edges.slice(1).map(() => [])
    const worst = { x: 0, z: 0, errCm: 0, dist: 0 }
    let holes = 0
    const t = app.time
    for (let j = 0; j < size; j++) {
      const z = cz + radius - (2 * radius * (j + 0.5)) / size
      for (let i = 0; i < size; i++) {
        const k = (j * size + i) * 4
        const x = cx - radius + (2 * radius * (i + 0.5)) / size
        const d = Math.hypot(x - cx, z - cz)
        if (d >= radius) continue
        if (px[k + 3] === 0) { holes++; continue }
        const drawn = ((px[k] * 256 + px[k + 1]) / 65535) * 8 - 4
        const err = Math.abs(drawn - waves.height(x, z, t))
        let b = 0
        while (b < errs.length - 1 && d >= edges[b + 1]) b++
        errs[b].push(err)
        if (d <= 40 && err * 100 > worst.errCm) { worst.errCm = err * 100; worst.x = x - cx; worst.z = z - cz; worst.dist = d }
      }
    }
    const bands: WaterCheckBand[] = errs.map((e, b) => {
      e.sort((p, q) => p - q)
      let sum = 0, sq = 0
      for (const v of e) { sum += v; sq += v * v }
      const n = Math.max(1, e.length)
      const r2 = (v: number) => Math.round(v * 10000) / 100
      return {
        from: edges[b], to: edges[b + 1], samples: e.length,
        maxCm: r2(e[e.length - 1] ?? 0), rmsCm: r2(Math.sqrt(sq / n)), p99Cm: r2(e[Math.floor(e.length * 0.99)] ?? 0), meanCm: r2(sum / n),
      }
    })
    return { tier: app.quality.tier, n: grid.n, time: t, vertices: grid.vertices, triangles: grid.triangles, holes, bands, worst }
  }

  return {
    update() {
      if (!ctx.markers) return
      place(fine, FINE_STEP, FINE_HALF, 0.37)
      place(coarse, COARSE_STEP, COARSE_HALF, 0.37)
    },
    dispose() {
      app.scene.remove(fine, coarse)
      fine.geometry.dispose()
      coarse.geometry.dispose()
      mat.dispose()
      heightMaterial.dispose()
      delete window.__waterCheck
    },
  }
}
