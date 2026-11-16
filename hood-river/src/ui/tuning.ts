/**
 * Tuning panel (lil-gui) for play-testing: every number of the simulation that changes
 * how the level rides, the presets, the camera, a few knobs of the touch controls and the
 * HUD, and a live read-out of the rider state.
 *
 * The folders follow the parameter groups of src/sim/params.ts: Conditions is waves + env,
 * Foil is foil + rider, Handling is handling + crash, and so on. Each opens on the sliders
 * that matter most, described by hand; every other number of its groups is in a "more ..."
 * folder inside it, so a number the core adds later turns up in the right place by itself.
 *
 * Hidden until P or ` is pressed (the input module sends 'hr:tuning'). ?tune=1 opens it at
 * start; on a phone that is the only way to get it, and it starts folded to its title bar.
 * lil-gui itself is loaded only when the panel is first shown.
 *
 * Whatever is changed here is mirrored into the address bar (?p=..., debounced), so a
 * reload keeps the tune and the address is always the shareable link.
 *
 * Other modules' knobs: the Camera folder binds CAMERA_MODES and cameraTuning from
 * ../render/camera. In the same way, any feature module that exports a plain object of
 * numbers whose name ends in Tuning, Tune or Look (or exposes one as app.modules.x.tune)
 * gets a folder with a slider for each number. All of that is looked up when the panel is
 * built and is allowed to be missing.
 */
import type GUI from 'lil-gui'
import type { Controller } from 'lil-gui'
import type { App, FeatureModule } from '../app/types'
import { STARTS } from '../sim/level'
import { applyPreset, detectPresets, PRESET_TABLES, resetParams, tuneUrl, type PresetKind } from './tune'
import {
  el, emit, KNOTS, markUiReady, prepareUiRoot, saveUiTuning, store, toast, ui, UI_TUNING_DEFAULTS, uiRoot, uiTuning,
} from './shared'

type Bag = Record<string, unknown>
/** [path in SimParams, label, min, max, step] */
type Num = [string, string, number, number, number]

const DEG = 180 / Math.PI
const OPEN_KEY = 'hr.tune.open'
const CUSTOM = 'Custom (your numbers)'

const CONDITIONS: Num[] = [
  ['waves.hs', 'wave height Hs (m)', 0.2, 2.4, 0.05],
  ['waves.tp', 'period Tp (s)', 2, 5, 0.05],
  ['waves.gamma', 'regularity (gamma)', 1, 15, 0.1],
  ['waves.spreadDeg', 'spread (deg)', 0, 45, 1],
  ['waves.skew', 'forward lean (skew)', 0, 2.5, 0.05],
  ['waves.sharpen', 'crest sharpening', 0, 2.5, 0.05],
  ['waves.seed', 'seed', 1, 999, 1],
  ['env.wind', 'wind (m/s)', 0, 22, 0.1],
  ['env.current', 'current (m/s)', 0, 2.5, 0.05],
  ['env.windAtRider', 'wind at the rider (share)', 0.3, 1, 0.01],
]

const FOIL: Num[] = [
  ['foil.area', 'wing area (m2)', 0.05, 0.2, 0.001],
  ['foil.span', 'span (m)', 0.6, 1.3, 0.005],
  ['foil.clMax', 'CL max', 0.8, 1.5, 0.01],
  ['foil.cd0', 'CD0', 0.006, 0.03, 0.0005],
  ['foil.mastLength', 'mast (m)', 0.6, 1, 0.01],
]

const HANDLING: Num[] = [
  ['handling.bankMaxDeg', 'max bank (deg)', 20, 60, 1],
  ['handling.bankRateDeg', 'roll rate (deg/s)', 30, 180, 1],
  ['handling.bankOmega', 'bank response (rad/s)', 2, 14, 0.1],
  ['handling.bankRamp', 'key ramp (s)', 0, 1.2, 0.01],
  ['handling.bankTap', 'key tap (share of full)', 0, 1, 0.01],
  ['handling.yawLeadDeg', 'nose lead (deg)', 0, 30, 0.5],
  ['handling.stallGuard', 'stall guard', 0, 1, 0.01],
  ['handling.depthTarget', 'cruise depth (m)', 0.15, 0.7, 0.01],
  ['handling.depthRange', 'up/down range (m)', 0, 0.4, 0.01],
  ['handling.heightKp', 'height Kp', 5, 80, 1],
  ['handling.heightKd', 'height Kd', 0, 30, 0.5],
  ['handling.alphaTau', 'pitch reflex lag (s)', 0.02, 0.5, 0.01],
  ['handling.bankZeta', 'bank damping', 0.3, 2, 0.05],
  ['handling.stallOvershoot', 'pull past the stall', 0, 0.2, 0.01],
  ['handling.tipLoss', 'tip-out lift loss', 0, 1, 0.01],
  ['handling.ventDelay', 'breach delay (s)', 0, 0.5, 0.005],
  ['handling.heightSpeedGain', 'height per m/s (m)', 0, 0.12, 0.001],
]

const PUMP: Num[] = [
  ['pump.energy', 'pump, tapped (J)', 100, 500, 5],
  ['pump.holdEnergy', 'pump, held (J)', 50, 400, 5],
  ['pump.cycle', 'pump cycle (s)', 0.35, 1, 0.01],
  ['pump.holdCadence', 'held pumps per s', 0.8, 2.5, 0.05],
  ['pump.window', 'pump timing window (s)', 0.02, 0.25, 0.005],
  ['paddle.sprintPower', 'paddle sprint (W)', 150, 500, 5],
  ['paddle.cruisePower', 'paddle cruise (W)', 40, 200, 5],
  ['paddle.cruiseCost', 'cruise cost (x sprint)', 0.2, 1.5, 0.01],
  ['paddle.takeoffSpeed', 'lift-off (x stall)', 0.95, 1.4, 0.01],
  ['paddle.keepSideDeg', 'paddle stays right within (deg)', 0, 180, 1],
  ['paddle.hullArea', 'hull drag area (m2)', 0.005, 0.03, 0.0005],
  ['paddle.hullHump', 'hull hump (m2)', 0, 0.03, 0.0005],
]

const STAMINA: Num[] = [
  ['stamina.criticalPower', 'critical power (W)', 80, 250, 5],
  ['stamina.reserve', 'reserve (J)', 3000, 20000, 250],
  ['stamina.fastShare', 'quick share', 0.05, 0.5, 0.01],
  ['stamina.tauFast', 'quick refill (s)', 5, 60, 1],
  ['stamina.tauSlow', 'slow refill (s)', 60, 600, 10],
  ['stamina.burstPower', 'burst power (W)', 100, 700, 10],
  ['stamina.grindPower', 'grind power (W)', 50, 400, 10],
]

/** the panel's folders: [title, parameter groups, the sliders it opens on] */
const FOLDERS: [string, string[], Num[]][] = [
  ['Conditions', ['waves', 'env'], CONDITIONS],
  ['Foil', ['foil', 'rider'], FOIL],
  ['Handling', ['handling', 'crash'], HANDLING],
  ['Pump and paddle', ['pump', 'paddle'], PUMP],
  ['Stamina', ['stamina'], STAMINA],
]

/** feature modules that may carry knobs of their own: [module name, folder title, loader] */
const KNOB_SOURCES: [string, string, () => Promise<unknown>][] = [
  ['camera', 'Camera', () => import('../render/camera')],
  ['rider', 'Rider', () => import('../render/rider')],
  ['water', 'Water look', () => import('../render/water')],
  ['fx', 'Effects', () => import('../render/fx')],
  ['sky', 'Sky', () => import('../render/sky')],
  ['terrain', 'Terrain', () => import('../render/terrain')],
  ['ambient', 'Ambient', () => import('../render/ambient')],
  ['audio', 'Sound', () => import('../audio/audio')],
]
const KNOB_NAME = /(tuning|tune|look)$/i

interface Knobs {
  title: string
  bag: Bag
  defaults: Bag
}

const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v)

/** 'paddleLookAhead' -> 'paddle look ahead' */
function words(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

/**
 * A sensible slider for a number nobody described: zero to three times its value, in steps
 * of a twentieth of its order of magnitude; both ways for offsets and angles; field of view
 * in degrees. A fraction from 0.2 up is usually a share of something and may reach 1; a
 * smaller number (a time constant, a gain per unit) is not, and a 0..1 slider would be far
 * too coarse for it.
 */
function guessRange(key: string, v: number): [number, number, number] {
  if (/fov$/i.test(key)) return [15, 110, 1]
  const a = Math.abs(v)
  if (a < 1e-9) return [-1, 1, 0.01]
  const mag = Math.pow(10, Math.floor(Math.log10(a)))
  const step = mag / 20
  let hi = Math.ceil((a * 3) / mag - 1e-9) * mag
  if (a >= 0.2 && a < 1) hi = Math.max(hi, 1)
  const bothWays = v < 0 || /offset|yaw|pitch|tilt|roll|bias|shift|angle|sign|^dir/i.test(key)
  return [bothWays ? -hi : 0, hi, step]
}

/** the numbers of the "more ..." folders that are known: a range, or a choice */
const SPECIAL: Record<string, [number, number, number] | Record<string, number>> = {
  'waves.count': [1, 20, 1],
  'waves.useLevel': { 'the level\'s map': 1, 'a plain band': 0 },
  'waves.fMinRel': [0.5, 1, 0.01],
  'waves.fMaxRel': [1, 2.5, 0.01],
  'waves.dirDeg': [-30, 30, 0.5],
  'waves.channelZ': [-600, 600, 10],
  'waves.channelHalfWidth': [50, 1000, 10],
  'waves.channelFalloff': [50, 1000, 10],
  'waves.shoreScale': [0, 1, 0.01],
  'env.rhoWater': [990, 1030, 1],
  'env.rhoAir': [1, 1.4, 0.01],
  'foil.oswald': [0.5, 1, 0.01],
  'foil.mastChord': [0.08, 0.16, 0.005],
  'foil.mastCd': [0, 0.03, 0.0005],
  'foil.boardLength': [1.2, 3, 0.05],
  'foil.boardWidth': [0.35, 0.75, 0.01],
  'rider.mass': [50, 130, 1],
  'rider.cdaAir': [0.2, 1.2, 0.01],
  'handling.breachLift': [0, 1, 0.01],
  'crash.sinkRate': [0.5, 5, 0.05],
  'crash.railBankDeg': [15, 60, 1],
  'crash.swimTime': [0.5, 8, 0.1],
  'pump.heave': [0, 0.2, 0.005],
  'pump.loadBoost': [0, 1, 0.01],
  'pump.fullAbove': [1, 1.6, 0.01],
  'paddle.maxForce': [50, 250, 5],
  'paddle.costFactor': [0.5, 4, 0.05],
  'paddle.strokeTime': [0.3, 1.2, 0.01],
  'paddle.holdCadence': [0.4, 2, 0.05],
  'paddle.turnRate': [0.2, 2, 0.05],
  'paddle.latDamp': [0.5, 8, 0.1],
}

function deepAssign(dst: Bag, src: Bag): void {
  for (const k of Object.keys(src)) {
    const v = src[k]
    const d = dst[k]
    if (isBag(v) && isBag(d)) deepAssign(d, v)
    else if (Array.isArray(v) && Array.isArray(d)) for (let i = 0; i < v.length; i++) d[i] = v[i]
    else if (typeof v === typeof d) dst[k] = v
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  // plain http on a LAN (a phone testing against the dev server) has no Clipboard API
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()
  return ok
}

export function create(app: App): FeatureModule | Promise<FeatureModule> {
  prepareUiRoot(app)
  const query = app.options.query
  const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const P = app.sim.P

  let gui: GUI | null = null
  let holder: HTMLElement | null = null
  let building = false
  let shown = false
  /** app.modules has been looked through since it was filled */
  let instancesChecked = false

  // ---- other modules' knobs, found when the panel is built ----
  const knobs: Knobs[] = []
  let camModes: string[] = []
  const camState = { mode: app.options.cam }
  let camCtrl: Controller | null = null

  /** knob objects the modules export (cameraTuning, fxTuning, WATER_LOOK ...) */
  async function findKnobs(): Promise<void> {
    await Promise.all(KNOB_SOURCES.map(async ([name, title, load]) => {
      if (app.options.off.has(name)) return
      let mod: Bag | null = null
      try { mod = (await load()) as Bag } catch { mod = null }
      if (!mod) return
      const found: [string, Bag][] = []
      for (const key of Object.keys(mod)) {
        const v = mod[key]
        if (KNOB_NAME.test(key) && isBag(v)) found.push([key, v])
      }
      if (name === 'camera' && Array.isArray(mod.CAMERA_MODES)) {
        camModes = mod.CAMERA_MODES.filter((m): m is string => typeof m === 'string')
      }
      for (const [key, bag] of found) addKnobBag(found.length > 1 ? `${title}: ${words(key)}` : title, bag)
    }))
    // keep the folders in the order of KNOB_SOURCES whatever order the imports resolved in
    const order = KNOB_SOURCES.map(([, title]) => title)
    knobs.sort((x, y) => order.findIndex((t) => x.title.startsWith(t)) - order.findIndex((t) => y.title.startsWith(t)))
    if (camModes.length && !camModes.includes(camState.mode)) camState.mode = camModes[0]
  }

  function addKnobBag(title: string, bag: Bag): Knobs | null {
    if (knobs.some((k) => k.bag === bag)) return null
    const entry: Knobs = { title, bag, defaults: JSON.parse(JSON.stringify(bag)) as Bag }
    knobs.push(entry)
    return entry
  }

  /**
   * Knobs hung on a module instance (app.modules.rider.tune) and the camera's live mode.
   * app.modules is only filled once every module has loaded, which is after a panel that
   * was asked for with ?tune=1 has been built; so this runs again on the first frame.
   */
  function findInstanceKnobs(): void {
    for (const [name, title] of KNOB_SOURCES) {
      const inst = app.modules[name] as unknown as Bag | undefined
      if (!inst) continue
      for (const key of ['tune', 'tuning', 'look']) {
        const v = inst[key]
        if (!isBag(v)) continue
        const entry = addKnobBag(title, v)
        if (entry && gui && readoutFolder) {
          const folder = gui.addFolder(entry.title)
          lazy(folder, () => addKnobs(folder, entry.bag, 0))
          // before the read-out, which stays last
          gui.$children.insertBefore(folder.domElement, readoutFolder.domElement)
        }
      }
    }
    const live = (app.modules.camera as unknown as { mode?: unknown } | undefined)?.mode
    if (typeof live === 'string' && camModes.includes(live) && live !== camState.mode) {
      camState.mode = live
      camCtrl?.updateDisplay()
    }
  }

  const riderView = { character: 'man' }
  let riderCtrl: Controller | null = null
  function onRiderChanged(e: Event) {
    const name = String((e as CustomEvent).detail ?? '')
    if (!name || name === riderView.character) return
    riderView.character = name
    riderCtrl?.updateDisplay()
  }

  function onCameraChanged(e: Event) {
    const name = String((e as CustomEvent).detail ?? '')
    if (!name) return
    camState.mode = name
    camCtrl?.updateDisplay()
  }

  // ---- state behind the selects and buttons ----
  const sel: Record<PresetKind, string> = { foil: '', conditions: '', handling: '' }
  const notes: Partial<Record<PresetKind, HTMLElement>> = {}
  const presetCtrls: Partial<Record<PresetKind, Controller>> = {}
  const view = {
    quality: app.quality.tier as string,
    fps: ui.showFps,
    start: STARTS[query.get('at') ?? ''] ? (query.get('at') as string) : 'hatchery',
  }
  let foilLine: HTMLElement | null = null
  let seaLine: HTMLElement | null = null
  let windCtrl: Controller | null = null
  let readout: HTMLElement | null = null
  let readoutFolder: GUI | null = null
  let copyCtrl: Controller | null = null
  let copyFlash = 0
  let readoutAcc = 0
  let urlTimer = -1
  let startChanged = false

  function touchUrl() {
    if (!app.options.capture) urlTimer = 0.5
  }

  /** query flags that go into a link besides the simulation numbers */
  function linkExtras(withPanel: boolean): Record<string, string | null> {
    const extra: Record<string, string | null> = { tune: withPanel ? '1' : null }
    if (camModes.length) extra.cam = camState.mode === camModes[0] ? null : camState.mode
    if (startChanged) {
      extra.at = view.start === 'hatchery' ? null : view.start
      extra.gx = null
      extra.z = null
    }
    return extra
  }

  function presetNote(kind: PresetKind): string {
    return sel[kind] ? PRESET_TABLES[kind][sel[kind]].note : 'Your own numbers.'
  }

  /** numbers derived from the parameters, shown as a line of text in their folder */
  function describe() {
    const D = app.sim.D
    const W = app.sim.waves
    if (foilLine) {
      foilLine.textContent =
        `Stalls at ${(D.vStall * KNOTS).toFixed(1)} kn, flies at ${(D.vStall * P.paddle.takeoffSpeed * KNOTS).toFixed(1)} kn. ` +
        `Aspect ratio ${D.aspect.toFixed(1)}, best glide ${D.glideMax.toFixed(1)}:1 at ${(D.vBestGlide * KNOTS).toFixed(1)} kn.`
    }
    if (seaLine) {
      const gap = (2 * Math.PI) / Math.max(1e-6, W.kp)
      seaLine.textContent =
        `Bumps about ${gap.toFixed(0)} m apart, moving ${(W.cp * KNOTS).toFixed(1)} kn through the water ` +
        `and ${((W.cp - P.env.current) * KNOTS).toFixed(1)} kn past the bank.`
    }
    windCtrl?.name(`wind (m/s) = ${(P.env.wind * KNOTS).toFixed(0)} kn`)
  }

  /** after a hand edit: a preset select falls back to "custom" when its numbers no longer match */
  function syncPresets() {
    const now = detectPresets(P)
    for (const kind of Object.keys(sel) as PresetKind[]) {
      if (now[kind] === sel[kind]) continue
      sel[kind] = now[kind]
      const note = notes[kind]
      if (note) note.textContent = presetNote(kind)
      presetCtrls[kind]?.updateDisplay()
    }
  }

  /** refresh every widget from the live values (after a preset, a reset or a key press) */
  function syncAll() {
    const now = detectPresets(P)
    for (const kind of Object.keys(sel) as PresetKind[]) {
      sel[kind] = now[kind]
      const note = notes[kind]
      if (note) note.textContent = presetNote(kind)
    }
    view.quality = app.quality.tier
    view.fps = ui.showFps
    if (gui) for (const ctrl of gui.controllersRecursive()) ctrl.updateDisplay()
    describe()
  }

  function onParams() {
    syncAll()
    touchUrl()
  }

  function resolve(path: string): { obj: Bag; key: string } {
    const parts = path.split('.')
    let obj = P as unknown as Bag
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]] as Bag
    return { obj, key: parts[parts.length - 1] }
  }

  function addNums(folder: GUI, list: Num[]): void {
    for (const [path, label, min, max, step] of list) {
      const { obj, key } = resolve(path)
      const value = obj[key]
      if (typeof value !== 'number') continue
      // a default outside the planned range (the core is still being tuned) widens the slider
      const ctrl = folder.add(obj, key, Math.min(min, value), Math.max(max, value), step).name(label).onChange(() => {
        app.sim.refresh(path.startsWith('waves.'))
        syncPresets()
        describe()
        touchUrl()
      })
      if (path === 'env.wind') windCtrl = ctrl
    }
  }

  function addPreset(folder: GUI, kind: PresetKind): void {
    const options: Record<string, string> = {}
    for (const [key, preset] of Object.entries(PRESET_TABLES[kind])) options[preset.label] = key
    options[CUSTOM] = ''
    sel[kind] = detectPresets(P)[kind]
    presetCtrls[kind] = folder.add(sel, kind, options).name('preset').onChange((key: string) => {
      if (key) applyPreset(app, kind, key)
      else syncPresets()
    })
    const note = el('div', 'hr-note', presetNote(kind))
    folder.$children.appendChild(note)
    notes[kind] = note
  }

  /**
   * Fill a folder the first time it is opened. The long lists (other modules' knobs, the
   * rest of the simulation numbers) are several hundred elements nobody may ever look at.
   */
  function lazy(folder: GUI, fill: () => void): void {
    let done = false
    folder.onOpenClose((changed: GUI) => {
      if (done || changed !== folder || folder._closed) return
      done = true
      fill()
    })
  }

  /**
   * Every number of these parameter groups that has no slider of its own yet, in a folder
   * that is filled when it is first opened. Nothing is added when there is no such number.
   */
  function addRest(parent: GUI, title: string, groups: string[], listed: Set<string>): void {
    const todo: [string, string][] = []
    for (const group of groups) {
      const bag = (P as unknown as Bag)[group]
      if (!isBag(bag)) continue
      for (const key of Object.keys(bag)) {
        if (typeof bag[key] === 'number' && !listed.has(`${group}.${key}`)) todo.push([group, key])
      }
    }
    if (!todo.length) return
    const sub = parent.addFolder(title)
    lazy(sub, () => {
      for (const [group, key] of todo) {
        const bag = (P as unknown as Bag)[group] as Bag
        const path = `${group}.${key}`
        const v = bag[key] as number
        const special = SPECIAL[path]
        const range = Array.isArray(special) ? special : guessRange(key, v)
        const ctrl = special && !Array.isArray(special)
          ? sub.add(bag, key, special)
          : sub.add(bag, key, Math.min(range[0], v), Math.max(range[1], v), range[2])
        // two groups in one folder: say which the number belongs to when it is not the first
        ctrl.name(groups.length > 1 && group !== groups[0] ? `${group}: ${words(key)}` : words(key)).onChange(() => {
          app.sim.refresh(group === 'waves')
          syncPresets()
          describe()
          touchUrl()
        })
      }
    })
  }

  function addLine(folder: GUI): HTMLElement {
    const line = el('div', 'hr-note')
    folder.$children.appendChild(line)
    return line
  }

  /** a slider for every number in an object nobody described to us */
  function addKnobs(folder: GUI, bag: Bag, depth: number): void {
    for (const key of Object.keys(bag)) {
      const v = bag[key]
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (/sign$/i.test(key) && Math.abs(v) === 1) {
          folder.add(bag, key, { '+1': 1, '-1': -1 }).name(words(key))
        } else if (key === 'vario' && (v === 0 || v === 1)) {
          // the sound module's variometer switch is a number: 0 or 1
          folder.add(bag, key, { off: 0, on: 1 }).name('variometer beeps (V)')
        } else {
          const [min, max, step] = guessRange(key, v)
          folder.add(bag, key, Math.min(min, v), Math.max(max, v), step).name(words(key))
        }
      } else if (typeof v === 'boolean') {
        folder.add(bag, key).name(words(key))
      } else if (Array.isArray(v) && v.length > 0 && v.length <= 4 && v.every((n) => typeof n === 'number')) {
        // colours and other short vectors: one slider per component
        const names = v.length === 3 ? ['r', 'g', 'b'] : ['0', '1', '2', '3']
        const list = v as unknown as Bag
        for (let i = 0; i < v.length; i++) {
          const [min, max, step] = guessRange(key, v[i] as number)
          folder.add(list, String(i), Math.min(min, v[i] as number), Math.max(max, v[i] as number), step).name(`${words(key)} ${names[i]}`)
        }
      } else if (isBag(v) && depth < 3) {
        addKnobs(folder.addFolder(words(key)), v, depth + 1)
      }
    }
  }

  function readoutText(): string {
    const s = app.view
    const D = app.sim.D
    const f = (v: number, w: number, d = 0) => v.toFixed(d).padStart(w)
    const net = s.powerWave + s.powerDrag + s.powerAero
    const flags = [s.stalled && 'STALL', s.touching && 'TOUCH', s.breached && 'BREACH', s.tipOut > 0.02 && 'TIP', s.aground && 'AGROUND']
      .filter(Boolean).join(' ') || '-'
    return (
      `mode  ${s.mode.padEnd(7)} ${f(s.modeTime, 6, 1)} s\n` +
      `speed ${f(s.speed * KNOTS, 5, 1)} kn  ${f(s.speed, 5, 2)} m/s\n` +
      `stall ${f(D.vStall * KNOTS, 5, 1)} kn  x ${f(s.speed / D.vStall, 4, 2)}\n` +
      `g     ${f(s.gLoad, 5, 2)}     CL ${f(s.cl, 5, 2)}\n` +
      `bank  ${f(s.bank * DEG, 5)} deg turn ${f(s.turnRate * DEG, 4)} deg/s\n` +
      `alpha ${f(s.alpha * DEG, 5, 1)} deg slip ${f(s.slip * DEG, 4)} deg\n` +
      `depth ${f(s.depth, 5, 2)} m   ride ${f(s.rideHeight, 5, 2)} m\n` +
      `wave  ${f(s.powerWave, 5)} W   drag ${f(s.powerDrag, 5)} W\n` +
      `air   ${f(s.powerAero, 5)} W   pump ${f(s.powerPump, 5)} W\n` +
      `net   ${f(net, 5)} W   crest ${f(s.crest, 5, 2)}\n` +
      `stam  ${f(s.stamina * 100, 5)} %   ${f(s._fast / 1000, 4, 1)} + ${f(s._slow / 1000, 4, 1)} kJ\n` +
      `pump  ${f(s.pumpQuality, 5, 2)} q   glide ${f(s.glideTime, 5, 1)} s\n` +
      `flags ${flags}`
    )
  }

  const actions = {
    async copy() {
      // a link to the tune, not to the panel: whoever opens it just rides
      const url = tuneUrl(app, linkExtras(false))
      const ok = await copyText(url)
      if (!ok) window.prompt('Copy this link', url)
      copyCtrl?.name(ok ? 'Link copied' : 'Copy link to this tune')
      copyFlash = 1.6
      if (ok) toast('Link to this tune copied')
    },
    reset() {
      for (const k of knobs) deepAssign(k.bag, k.defaults)
      Object.assign(uiTuning, UI_TUNING_DEFAULTS)
      saveUiTuning()
      resetParams(app)
      toast('Back to the defaults')
    },
    restartWater() { app.restart('paddle') },
    restartFlying() { app.restart('foil') },
  }

  async function build(): Promise<void> {
    const [{ GUI: Gui }] = await Promise.all([import('lil-gui'), findKnobs()])
    holder = el('div', 'hr-tune')
    holder.dataset.hrUi = ''
    uiRoot().appendChild(holder)
    const g = new Gui({ container: holder, title: 'Tuning (P)', width: 300, closeFolders: true })
    gui = g

    copyCtrl = g.add(actions, 'copy').name('Copy link to this tune')
    g.add(actions, 'reset').name('Reset to defaults')

    // the simulation's numbers, folder by folder (see FOLDERS)
    const listed = new Set<string>(['crash.level'])
    for (const [, , nums] of FOLDERS) for (const n of nums) listed.add(n[0])
    const placed = new Set<string>()
    for (const [title, groups, nums] of FOLDERS) {
      const folder = g.addFolder(title)
      if (title === 'Conditions') addPreset(folder, 'conditions')
      else if (title === 'Foil') addPreset(folder, 'foil')
      else if (title === 'Handling') addPreset(folder, 'handling')
      addNums(folder, nums)
      if (title === 'Handling') {
        folder.add(P.crash, 'level', { 'never crash': 0, forgiving: 1, strict: 2 }).name('crashes').onChange(() => {
          syncPresets()
          touchUrl()
        })
      }
      // what the numbers add up to, in words
      if (title === 'Conditions') seaLine = addLine(folder)
      else if (title === 'Foil') foilLine = addLine(folder)
      for (const group of groups) placed.add(group)
      addRest(folder, `more ${title.toLowerCase()}`, groups, listed)
    }
    // a parameter group the core adds later and no folder claims
    addRest(g, 'More numbers', Object.keys(P).filter((group) => !placed.has(group)), listed)

    // Camera: the mode select, then the camera module's numbers
    const camKnobs = knobs.find((k) => k.title === 'Camera')
    if (camModes.length || camKnobs) {
      const camera = g.addFolder('Camera')
      if (camModes.length) {
        camCtrl = camera.add(camState, 'mode', camModes).name('mode (C)').onChange((name: string) => {
          emit('hr:camera-set', name)
          touchUrl()
        })
      }
      if (camKnobs) lazy(camera, () => addKnobs(camera, camKnobs.bag, 0))
    }

    const viewFolder = g.addFolder('View')
    viewFolder.add(view, 'quality', ['low', 'mid', 'high']).name('quality').onChange((tier: string) => emit('hr:quality', tier))
    // the rider module switches figure on hr:rider and says which it shows with hr:rider-changed
    riderCtrl = viewFolder.add(riderView, 'character', { Man: 'man', Woman: 'woman', 'Capsule figure': 'capsules' })
      .name('rider')
      .onChange((name: string) => emit('hr:rider', name))
    viewFolder.add(view, 'fps').name('show frame rate').onChange((on: boolean) => { ui.showFps = on })
    const spots: Record<string, string> = {}
    for (const [key, spot] of Object.entries(STARTS)) spots[spot.label] = key
    viewFolder.add(view, 'start', spots).name('start spot').onChange((key: string) => {
      // the shell reads ?at= from the options each time it places the rider
      query.set('at', key)
      query.delete('gx')
      query.delete('z')
      startChanged = true
      app.restart(app.view.mode === 'foil' ? 'foil' : 'paddle')
      touchUrl()
    })
    viewFolder.add(actions, 'restartWater').name('Restart on the water (R)')
    viewFolder.add(actions, 'restartFlying').name('Restart flying (F)')

    const controls = g.addFolder('Input and HUD')
    controls.add(uiTuning, 'upIsFrontFoot').name('up = front foot (ride lower)')
    controls.add(uiTuning, 'keyMinPress', 0, 0.3, 0.01).name('shortest key tap (s)')
    controls.add(uiTuning, 'stickRadius', 30, 110, 1).name('stick radius (px)')
    controls.add(uiTuning, 'stickCurve', 1, 2.5, 0.05).name('stick curve (1 = linear)')
    controls.add(uiTuning, 'stickDeadzone', 0, 0.4, 0.01).name('lean dead zone')
    controls.add(uiTuning, 'heightDeadzone', 0, 0.8, 0.01).name('height dead zone')
    controls.add(uiTuning, 'stickSplit', 0.3, 0.7, 0.01).name('stick share of width')
    controls.add(uiTuning, 'swapSides').name('stick on the right')
    controls.add(uiTuning, 'showVario').name('show the bump bar')
    controls.add(uiTuning, 'varioScale', 200, 1500, 10).name('bump bar scale (W)')
    controls.add(uiTuning, 'varioTau', 0.05, 1.5, 0.01).name('bump bar smoothing (s)')
    controls.add(uiTuning, 'prompts', { off: 0, 'until learned': 1, always: 2 }).name('coaching lines')
    controls.add(uiTuning, 'cueStart', 0, 1, 0.01).name('cue: tip needed')
    controls.add(uiTuning, 'cueKeep', 0, 1, 0.01).name('cue: off below')
    controls.add(uiTuning, 'cueBump', 0, 4, 0.05).name('cue: bump needed (x)')
    controls.add(uiTuning, 'restBelow', 0, 1, 0.01).name('rest line below')
    controls.onChange(saveUiTuning)

    // whatever else the other modules offer: look, effects, sound
    for (const k of knobs) {
      if (k === camKnobs) continue
      const folder = g.addFolder(k.title)
      lazy(folder, () => addKnobs(folder, k.bag, 0))
    }

    readoutFolder = g.addFolder('Read-out')
    readout = el('pre', 'hr-readout', readoutText())
    readoutFolder.$children.appendChild(readout)
    findInstanceKnobs()

    // remember which folders were open
    let open: string[] = []
    try { open = JSON.parse(store.get(OPEN_KEY) ?? '[]') as string[] } catch { open = [] }
    // twice: opening a lazy folder creates its sub-folders, which may have been open too
    for (let pass = 0; pass < 2; pass++) {
      for (const folder of g.foldersRecursive()) if (folder._closed && open.includes(folder._title)) folder.open()
    }
    g.onOpenClose(() => {
      const titles = g.foldersRecursive().filter((f) => !f._closed).map((f) => f._title)
      store.set(OPEN_KEY, JSON.stringify(titles))
    })

    // give the keyboard back to the game after a click on a button or a checkbox, and after a
    // choice from a select (not on the click that opens its list: that would close it again)
    const giveBack = (e: Event) => {
      const a = document.activeElement
      if (!(a instanceof HTMLElement) || !g.domElement.contains(a)) return
      if (e.type === 'click' && a instanceof HTMLSelectElement) return
      const typing = a instanceof HTMLInputElement && a.type !== 'checkbox'
      if (!typing) a.blur()
    }
    g.domElement.addEventListener('click', giveBack)
    g.domElement.addEventListener('change', giveBack)

    describe()
  }

  async function show(open: boolean) {
    if (building) return
    if (!gui) {
      building = true
      try {
        await build()
      } catch (err) {
        console.error('[hood-river] tuning panel failed to build', err)
        building = false
        return
      }
      building = false
    }
    shown = true
    if (holder) holder.style.display = ''
    syncAll()
    if (open) gui?.open()
    else gui?.close()
  }

  function onToggle() {
    if (building) return
    if (!gui || !shown) {
      void show(true)
    } else {
      shown = false
      if (holder) holder.style.display = 'none'
    }
  }

  window.addEventListener('hr:tuning', onToggle)
  window.addEventListener('hr:params', onParams)
  window.addEventListener('hr:camera-changed', onCameraChanged)
  window.addEventListener('hr:rider-changed', onRiderChanged)

  const module: FeatureModule = {
    update(dt) {
      markUiReady()
      if (urlTimer >= 0) {
        urlTimer -= dt
        if (urlTimer < 0) {
          try { history.replaceState(null, '', tuneUrl(app, linkExtras(shown))) } catch { /* sandboxed: fine */ }
        }
      }
      if (copyFlash > 0) {
        copyFlash -= dt
        if (copyFlash <= 0) copyCtrl?.name('Copy link to this tune')
      }
      if (gui && !instancesChecked) {
        // the first frame after the panel exists: every module has loaded by now
        instancesChecked = true
        findInstanceKnobs()
      }
      if (!shown || !gui || !readout || !readoutFolder) return
      readoutAcc += dt
      if (readoutAcc < 0.2) return
      readoutAcc = 0
      if (gui._closed || readoutFolder._closed) return
      readout.textContent = readoutText()
    },

    setQuality() {
      if (view.quality === app.quality.tier) return
      view.quality = app.quality.tier
      if (gui) for (const ctrl of gui.controllersRecursive()) if (ctrl.property === 'quality') ctrl.updateDisplay()
    },

    dispose() {
      window.removeEventListener('hr:tuning', onToggle)
      window.removeEventListener('hr:params', onParams)
      window.removeEventListener('hr:camera-changed', onCameraChanged)
      window.removeEventListener('hr:rider-changed', onRiderChanged)
      gui?.destroy()
      holder?.remove()
    },
  }

  // ?tune=1: the panel is part of the page from the first frame (the shell waits for it, so
  // captures are repeatable). Phones keep it folded to its title bar; a desktop gets it open.
  if (query.get('tune') === '1') return show(!phone).then(() => module, () => module)
  return module
}
