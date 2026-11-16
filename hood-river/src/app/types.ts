/**
 * Contracts between the app shell (src/main.ts) and the feature modules it loads.
 *
 * World space is the water frame of the simulation (see src/sim/types.ts): +x downwind
 * (east), +y up, +z right when facing downwind (south). The land is static in its own
 * frame and slides through the world at the river current:
 *     worldX = groundX + app.groundShift        (groundShift = current * time)
 * so anything fixed to the land goes in a group whose position.x = app.groundShift.
 */
import type * as THREE from 'three'
import type { Sim } from '../sim/harness'
import type { Controls, RiderState } from '../sim/types'
import type { Atmosphere } from '../render/atmosphere'

export type QualityTier = 'low' | 'mid' | 'high'

export interface Quality {
  tier: QualityTier
  /** cap on devicePixelRatio */
  maxPixelRatio: number
  /** 0.5..1 extra resolution scale chosen by the frame-rate governor */
  resolutionScale: number
  /** suggested budgets; modules pick what they need */
  waterSegments: number
  waterComponents: number
  treeCount: number
  terrainDetail: number
  particles: number
  /** fragment-shader extras (detail normals, foam noise, cloud noise) */
  shaderDetail: number
}

export interface AppOptions {
  /** headless capture: no requestAnimationFrame loop, time advances only via __hr.frame() */
  capture: boolean
  /** name of a scripted pilot (see src/app/scenarios.ts) or '' for the player */
  scenario: string
  /** camera mode name or '' for the default */
  cam: string
  /** feature modules to skip, e.g. ?off=trees,terrain */
  off: Set<string>
  /** raw query for module-specific flags */
  query: URLSearchParams
}

export interface App {
  canvas: HTMLCanvasElement
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  sim: Sim
  /** live controls written by the input module (or a scenario pilot) before each sim step */
  controls: Controls
  /**
   * Rider state interpolated to the render time. Draw from this, never from sim.s
   * (sim.s is the latest fixed step and would stutter). Event bits accumulated since the
   * previous rendered frame are in `events`.
   */
  view: RiderState
  events: number
  /** simulation time of the frame being rendered (s); evaluate waves at this time */
  time: number
  /** land offset: worldX = groundX + groundShift */
  groundShift: number
  quality: Quality
  atmos: Atmosphere
  options: AppOptions
  /** viewport in CSS pixels and the pixel ratio in use */
  width: number
  height: number
  pixelRatio: number
  /** put the rider back on the water (mode 'paddle') or in flight (mode 'foil') */
  restart(mode?: 'paddle' | 'foil'): void
  /** modules by name, once loaded (for the few cases where one needs another) */
  modules: Record<string, FeatureModule | undefined>
}

export interface FeatureModule {
  /** every rendered frame, after the sim advanced and app.view / app.time were set */
  update(dt: number): void
  /** quality tier or resolution scale changed */
  setQuality?(q: Quality): void
  /** viewport changed */
  resize?(width: number, height: number, pixelRatio: number): void
  /** rider was restarted or teleported: snap cameras, clear trails */
  reset?(): void
  dispose?(): void
}

/** Every feature file exports `create`. It may be async (generate textures, build meshes). */
export type FeatureFactory = (app: App) => FeatureModule | Promise<FeatureModule>
