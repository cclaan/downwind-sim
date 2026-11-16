/**
 * The gorge: land, trees and landmarks of the Hatchery reach, from the baked level data.
 *
 * Everything is generated at load (src/render/terrain/*), baked into a few static meshes
 * that share one shader, and parked in a group that slides with the land: the simulation's
 * world is the frame of the moving water, so the ground moves through it at the river
 * current.
 *
 * Budgets come from app.quality:
 *   terrainDetail  triangles in the terrain network: about 24k at 0.5, 77k at 0.75, 170k at 1
 *   treeCount      see treeBudget(): 3,000 / 8,000 / 20,000 by tier
 *   shaderDetail   fragment detail from one small texture: one fetch (grain, tree crowns or
 *                  rock strata) on low and mid, two blended on high. Low gets one fetch even
 *                  though its shaderDetail is 0: without it the land is flat-shaded dunes.
 * For trying other settings without touching the tiers: ?trees=2500&terrain=0.6&landdetail=0&sunswing=0.
 *
 * At most 7 draw calls, 1 program, 1 texture (256 x 256 RGBA8 with mipmaps, 0.35 MB).
 *
 * For other modules:
 *   app.modules.terrain.rail   the Washington railway's centreline (the train rides it)
 *   SHORE_DEPTH ...            how the land's waterline is derived from the level's depths
 *                              (the water's foam line must use the same numbers)
 */
import * as THREE from 'three'
import type { App, FeatureModule, Quality, QualityTier } from '../app/types'
import { LAND_SUN_SWING, buildGorgeAsync, type BuildOptions, type BuildStats, type Built } from './terrain/build'
import type { TrackLine } from './terrain/landmarks'
import { DETAIL_STRENGTH, makeTerrainMaterial, type TerrainMaterial } from './terrain/material'

export { BED_DEPTH, BED_REACH, SHORE_BLUR_PASSES, SHORE_DEPTH, SHORE_GRID_STEP } from './terrain/field'
export type { TrackLine } from './terrain/landmarks'

/**
 * Trees drawn per tier. The research budget for this scene is 3,000 / 8,000 / 30,000; the
 * app shell's Quality still carries 1,200 / 3,500 / 8,000, which leaves the wooded bluff
 * behind the launch bare, so while a tier holds the shell's default the module uses its own
 * number. Any other value of quality.treeCount (a tuning panel, a changed shell) is used as
 * it stands.
 */
export const TREE_BUDGET: Record<QualityTier, number> = { low: 3000, mid: 8000, high: 20000 }
const SHELL_TREES: Record<QualityTier, number> = { low: 1200, mid: 3500, high: 8000 }

export function treeBudget(tier: QualityTier, shellCount: number): number {
  return shellCount === SHELL_TREES[tier] ? TREE_BUDGET[tier] : shellCount
}

/**
 * Knobs for the tuning panel. `trees` and `sunSwing` rebuild the land (about a second, in
 * stages, once the slider has rested); `detail` is live.
 */
export const terrainTuning = {
  /** multiplier on the tier's tree budget */
  trees: 1,
  /** degrees the land's baked light is swung south of the shared sun (see LAND_SUN_SWING in terrain/build.ts) */
  sunSwing: LAND_SUN_SWING,
  /** strength of the grain, tree-crown and rock-strata detail */
  detail: DETAIL_STRENGTH,
}

export interface TerrainModule extends FeatureModule {
  /** numbers for the tuning panel and the performance report */
  stats: BuildStats | null
  /**
   * Centreline of the railway on the Washington waterline: stations 10 m apart in ground
   * coordinates with the height of the ballast above the river.
   */
  rail: TrackLine | null
  /** rebuild with the current app.quality, sun direction and tuning, a stage per browser task */
  rebuild(): Promise<void>
}

export async function create(app: App): Promise<TerrainModule> {
  const group = new THREE.Group()
  group.name = 'gorge'
  app.scene.add(group)

  let mat: TerrainMaterial | null = null
  let matDetail = -1
  let meshes: THREE.Mesh[] = []
  let built = { terrainDetail: -1, treeCount: -1, shaderDetail: -1, tier: '', trees: 1, sunSwing: 0 }
  const sunBuilt = new THREE.Vector3()
  /** seconds the sun or a rebuilding knob has differed from what was built */
  let stale = 0
  let generation = 0

  /** budgets for this build: the quality tier, unless the query overrides them */
  function options(): { build: BuildOptions; shaderDetail: number } {
    const q = app.quality
    const query = app.options.query
    const num = (key: string, fallback: number) => {
      const v = Number(query.get(key))
      return query.has(key) && Number.isFinite(v) ? v : fallback
    }
    const sun = sunBuilt.copy(app.atmos.sunDir).normalize()
    built = { terrainDetail: q.terrainDetail, treeCount: q.treeCount, shaderDetail: q.shaderDetail, tier: q.tier, trees: terrainTuning.trees, sunSwing: terrainTuning.sunSwing }
    const build: BuildOptions = {
      terrainDetail: num('terrain', q.terrainDetail),
      treeCount: Math.round(num('trees', treeBudget(q.tier, q.treeCount)) * Math.max(0, terrainTuning.trees)),
      sun: { x: sun.x, y: sun.y, z: sun.z },
      sunSwing: num('sunswing', terrainTuning.sunSwing),
    }
    sunBuilt.copy(app.atmos.sunDir)
    stale = 0
    // the low tier's shaderDetail is 0, but the land needs its one fetch
    return { build, shaderDetail: num('landdetail', Math.max(1, q.shaderDetail)) }
  }

  function clear() {
    for (const m of meshes) {
      group.remove(m)
      m.geometry.dispose()
    }
    meshes = []
  }

  function install(res: Built, shaderDetail: number) {
    clear()
    const t0 = performance.now()
    if (!mat || shaderDetail !== matDetail) {
      mat?.dispose()
      mat = makeTerrainMaterial(app, shaderDetail)
      matDetail = shaderDetail
    }
    mat.material.uniforms.uDetail.value = terrainTuning.detail
    for (const c of res.chunks) {
      if (c.mesh.ni === 0) continue
      const mesh = new THREE.Mesh(c.mesh.toGeometry(), mat.material)
      mesh.name = 'gorge-' + c.name
      mesh.frustumCulled = c.cull
      mesh.matrixAutoUpdate = false
      // land first: it hides a good part of the water behind it
      mesh.renderOrder = -2
      group.add(mesh)
      meshes.push(mesh)
    }
    res.stats.ms.upload = Math.round(performance.now() - t0)
    mod.stats = res.stats
    mod.rail = res.rail
  }

  const mod: TerrainModule = {
    stats: null,
    rail: null,
    update(dt: number) {
      group.position.x = app.groundShift
      if (mat) mat.material.uniforms.uDetail.value = terrainTuning.detail
      // the sun moved, or a knob that is baked in: the meshes are stale. Wait until it has
      // stopped moving, then rebuild once.
      if (sunBuilt.distanceToSquared(app.atmos.sunDir) > 1e-6 || terrainTuning.trees !== built.trees || terrainTuning.sunSwing !== built.sunSwing) {
        stale += dt
        if (stale > 0.6) void mod.rebuild()
      } else stale = 0
    },
    setQuality(q: Quality) {
      if (q.terrainDetail !== built.terrainDetail || q.treeCount !== built.treeCount || q.shaderDetail !== built.shaderDetail || q.tier !== built.tier) void mod.rebuild()
    },
    async rebuild() {
      const mine = ++generation
      const o = options()
      const res = await buildGorgeAsync(o.build)
      // a newer rebuild was asked for while this one ran, or the module is gone
      if (mine === generation) install(res, o.shaderDetail)
    },
    dispose() {
      generation = -1
      clear()
      mat?.dispose()
      mat = null
      app.scene.remove(group)
    },
  }

  await mod.rebuild()
  return mod
}
