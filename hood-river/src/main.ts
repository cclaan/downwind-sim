/**
 * App shell: renderer, fixed-step simulation loop, quality tiers, and the feature modules.
 *
 * Feature modules are loaded with dynamic imports so that, during development, a module
 * that fails to load only takes itself out (the rest of the scene still renders).
 */
import * as THREE from 'three'
import './style.css'
import type { App, AppOptions, FeatureFactory, FeatureModule, Quality, QualityTier } from './app/types'
import { makeScenario, type Scenario } from './app/scenarios'
import { makeAtmosphere } from './render/atmosphere'
import { Sim, SIM_DT } from './sim/harness'
import { makeRider } from './sim/physics'
import { applyOverrides, applyPatch, CONDITION_PRESETS, FOIL_PRESETS, HANDLING_PRESETS } from './sim/presets'
import type { RiderState } from './sim/types'
import { STARTS } from './sim/level'

// ---------------------------------------------------------------------------------------
// options and quality
// ---------------------------------------------------------------------------------------

function readOptions(): AppOptions {
  const query = new URLSearchParams(location.search)
  return {
    capture: query.has('capture'),
    scenario: query.get('scenario') ?? '',
    cam: query.get('cam') ?? '',
    off: new Set((query.get('off') ?? '').split(',').filter(Boolean)),
    query,
  }
}

const QUALITY: Record<QualityTier, Quality> = {
  low: {
    tier: 'low', maxPixelRatio: 1.5, resolutionScale: 1, waterSegments: 96, waterComponents: 10,
    treeCount: 3000, terrainDetail: 0.5, particles: 80, shaderDetail: 0,
  },
  mid: {
    tier: 'mid', maxPixelRatio: 2, resolutionScale: 1, waterSegments: 144, waterComponents: 14,
    treeCount: 8000, terrainDetail: 0.75, particles: 200, shaderDetail: 1,
  },
  high: {
    tier: 'high', maxPixelRatio: 2, resolutionScale: 1, waterSegments: 200, waterComponents: 14,
    treeCount: 20000, terrainDetail: 1, particles: 400, shaderDetail: 2,
  },
}

function pickTier(query: URLSearchParams): QualityTier {
  const q = query.get('q')
  if (q === 'low' || q === 'mid' || q === 'high') return q
  const coarse = matchMedia('(pointer: coarse)').matches
  const small = Math.min(screen.width, screen.height) < 820
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8
  const cores = navigator.hardwareConcurrency ?? 8
  if (coarse || small) return mem <= 4 || cores <= 4 ? 'low' : 'mid'
  return 'high'
}

// ---------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------

const options = readOptions()
const canvas = document.getElementById('scene') as HTMLCanvasElement
const quality: Quality = { ...QUALITY[pickTier(options.query)] }

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: quality.tier !== 'low',
  powerPreference: 'high-performance',
  preserveDrawingBuffer: options.capture,
  alpha: false,
  stencil: false,
})
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.NoToneMapping

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(58, 1, 0.25, 40000)
camera.position.set(-10, 5, 0)
camera.lookAt(10, 0, 0)

const sim = new Sim()
// presets and overrides from the URL: ?foil=downwind&conditions=nuking&handling=surfy&p=handling.bankMaxDeg:55,waves.hs:1.2
{
  const q = options.query
  const foil = FOIL_PRESETS[q.get('foil') ?? '']
  const cond = CONDITION_PRESETS[q.get('conditions') ?? '']
  const hand = HANDLING_PRESETS[q.get('handling') ?? '']
  if (foil) applyPatch(sim.P, foil.patch)
  if (cond) applyPatch(sim.P, cond.patch)
  if (hand) applyPatch(sim.P, hand.patch)
  const p = q.get('p')
  if (p) applyOverrides(sim.P, p)
  sim.refresh(true)
}
const view: RiderState = makeRider()
const prev: RiderState = makeRider()

const app: App = {
  canvas, renderer, scene, camera, sim,
  controls: sim.c,
  view,
  events: 0,
  time: 0,
  groundShift: 0,
  quality,
  atmos: makeAtmosphere(),
  options,
  width: 1, height: 1, pixelRatio: 1,
  restart,
  modules: {},
}

let scenario: Scenario | null = null

function restart(mode: 'paddle' | 'foil' = 'paddle') {
  if (scenario) scenario.start(sim)
  else placeRider(mode === 'foil' ? 6.8 : undefined)
  Object.assign(prev, sim.s)
  Object.assign(view, sim.s)
  accumulator = 0
  for (const m of loaded) m.reset?.()
}

/**
 * Put the rider at the chosen launch spot (?at=hatchery|tunnel|swell, or ?gx=..&z=.. in
 * ground coordinates). Ground positions slide through the water frame with the current.
 */
function placeRider(foilSpeed?: number) {
  const q = options.query
  const spot = STARTS[q.get('at') ?? 'hatchery'] ?? STARTS.hatchery
  const num = (key: string, fallback: number) => {
    const v = q.has(key) ? Number(q.get(key)) : NaN
    return Number.isFinite(v) ? v : fallback
  }
  const gx = num('gx', spot.x)
  const z = num('z', spot.z)
  sim.start({ x: gx + sim.waves.groundShiftAt(sim.s.t), z, foilSpeed, onFace: true, t: sim.s.t })
}

// ---------------------------------------------------------------------------------------
// feature modules (order = update order)
// ---------------------------------------------------------------------------------------

const FEATURES: [string, () => Promise<{ create: FeatureFactory }>][] = [
  ['input', () => import('./ui/input')],
  ['camera', () => import('./render/camera')],
  ['sky', () => import('./render/sky')],
  ['water', () => import('./render/water')],
  ['terrain', () => import('./render/terrain')],
  ['ambient', () => import('./render/ambient')],
  ['rider', () => import('./render/rider')],
  ['fx', () => import('./render/fx')],
  ['audio', () => import('./audio/audio')],
  ['hud', () => import('./ui/hud')],
  ['tuning', () => import('./ui/tuning')],
]

const loaded: FeatureModule[] = []
let inputModule: FeatureModule | undefined

async function loadFeatures() {
  const results = await Promise.all(
    FEATURES.map(async ([name, load]) => {
      if (options.off.has(name)) return [name, undefined] as const
      try {
        const mod = await load()
        return [name, await mod.create(app)] as const
      } catch (err) {
        console.error(`[hood-river] feature "${name}" failed to load`, err)
        return [name, undefined] as const
      }
    }),
  )
  for (const [name, mod] of results) {
    app.modules[name] = mod
    if (!mod) continue
    if (name === 'input') inputModule = mod
    else loaded.push(mod)
  }
}

// ---------------------------------------------------------------------------------------
// sizing
// ---------------------------------------------------------------------------------------

function resize() {
  const w = Math.max(1, window.innerWidth)
  const h = Math.max(1, window.innerHeight)
  const pr = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio) * quality.resolutionScale
  app.width = w
  app.height = h
  app.pixelRatio = pr
  renderer.setPixelRatio(pr)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  inputModule?.resize?.(w, h, pr)
  for (const m of loaded) m.resize?.(w, h, pr)
}

// ---------------------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------------------

let accumulator = 0

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  if (d > Math.PI) d -= 2 * Math.PI
  else if (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

function interpolate(a: RiderState, b: RiderState, t: number, out: RiderState) {
  Object.assign(out, b)
  if (a.mode !== b.mode) return
  const l = (p: number, q: number) => p + (q - p) * t
  out.t = l(a.t, b.t)
  out.x = l(a.x, b.x); out.y = l(a.y, b.y); out.z = l(a.z, b.z)
  out.heading = lerpAngle(a.heading, b.heading, t)
  out.bank = l(a.bank, b.bank)
  out.pitch = l(a.pitch, b.pitch)
  out.depth = l(a.depth, b.depth)
  out.rideHeight = l(a.rideHeight, b.rideHeight)
  out.heave = l(a.heave, b.heave)
  out.slip = l(a.slip, b.slip)
  out.eta = l(a.eta, b.eta)
}

function frame(dt: number) {
  dt = Math.min(dt, 0.1)
  inputModule?.update(dt)
  accumulator += dt
  let events = 0
  while (accumulator >= SIM_DT) {
    Object.assign(prev, sim.s)
    if (scenario) scenario.pilot(sim)
    sim.step()
    events |= sim.s.events
    sim.s.events = 0
    accumulator -= SIM_DT
  }
  const alpha = accumulator / SIM_DT
  interpolate(prev, sim.s, alpha, view)
  app.events = events
  app.time = view.t
  app.groundShift = sim.waves.groundShiftAt(app.time)
  for (const m of loaded) m.update(dt)
  if (debugView) {
    // ?view=x,y,z,tx,ty,tz in ground coordinates (y = metres above the river): a fixed
    // camera for checking scenery. Add ",follow" style offsets with ?viewrel=dx,dy,dz to
    // keep it relative to the rider instead.
    camera.position.set(debugView[0] + app.groundShift, debugView[1], debugView[2])
    camera.lookAt(debugView[3] + app.groundShift, debugView[4], debugView[5])
  } else if (debugViewRel) {
    camera.position.set(view.x + debugViewRel[0], view.y + sim.P.foil.mastLength + debugViewRel[1], view.z + debugViewRel[2])
    camera.lookAt(view.x + (debugViewRel[3] ?? 0), view.y + sim.P.foil.mastLength + (debugViewRel[4] ?? 0.8), view.z + (debugViewRel[5] ?? 0))
  }
  renderer.render(scene, camera)
}

function parseNumbers(v: string | null, min: number): number[] | null {
  if (!v) return null
  const n = v.split(',').map(Number)
  return n.length >= min && n.every(Number.isFinite) ? n : null
}
const debugView = parseNumbers(options.query.get('view'), 6)
const debugViewRel = parseNumbers(options.query.get('viewrel'), 3)

// frame-rate governor: trade resolution for frame time on slow devices
let slowTime = 0
let fastTime = 0
function govern(dt: number) {
  if (dt > 1 / 45) { slowTime += dt; fastTime = 0 } else if (dt < 1 / 58) { fastTime += dt; slowTime = 0 }
  if (slowTime > 1.5 && quality.resolutionScale > 0.6) {
    quality.resolutionScale = Math.max(0.6, quality.resolutionScale - 0.1)
    slowTime = 0
    resize()
    for (const m of loaded) m.setQuality?.(quality)
  } else if (fastTime > 8 && quality.resolutionScale < 1) {
    quality.resolutionScale = Math.min(1, quality.resolutionScale + 0.1)
    fastTime = 0
    resize()
    for (const m of loaded) m.setQuality?.(quality)
  }
}

let lastNow = 0
function loop(now: number) {
  const dt = lastNow ? (now - lastNow) / 1000 : 1 / 60
  lastNow = now
  frame(dt)
  govern(dt)
  requestAnimationFrame(loop)
}

// ---------------------------------------------------------------------------------------
// go
// ---------------------------------------------------------------------------------------

declare global {
  interface Window {
    __hr: {
      ready: boolean
      app: App
      /** capture mode: advance the simulation by dt seconds and render one frame */
      frame(dt: number): void
      /** capture mode: advance in small frames until sim time reaches t */
      advanceTo(t: number, step?: number): void
      setScenario(name: string): boolean
      state(): RiderState
    }
  }
}

function setScenario(name: string): boolean {
  scenario = name ? makeScenario(name) : null
  restart()
  return !!scenario || !name
}

window.__hr = {
  ready: false,
  app,
  frame,
  advanceTo(t: number, step = 1 / 30) {
    let guard = 0
    while (sim.s.t < t - 1e-6 && guard++ < 100000) frame(Math.min(step, t - sim.s.t))
  },
  setScenario,
  state: () => sim.s,
}

/** 'hr:quality' (detail: 'low' | 'mid' | 'high'): switch tier at run time */
window.addEventListener('hr:quality', (e) => {
  const tier = (e as CustomEvent).detail as QualityTier
  if (!QUALITY[tier]) return
  const keep = quality.resolutionScale
  Object.assign(quality, QUALITY[tier])
  quality.resolutionScale = keep
  resize()
  inputModule?.setQuality?.(quality)
  for (const m of loaded) m.setQuality?.(quality)
})

async function boot() {
  await loadFeatures()
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', resize)
  const start = options.query.get('start')
  if (options.scenario) setScenario(options.scenario)
  else restart(start === 'foil' ? 'foil' : 'paddle')
  frame(0)
  window.__hr.ready = true
  if (!options.capture) requestAnimationFrame(loop)
}

boot()
