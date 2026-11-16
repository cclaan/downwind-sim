/**
 * Shared by the three UI modules (input, HUD, tuning panel) and nobody else. Other
 * modules talk to the UI only through window events:
 *
 *   hr:camera-next, hr:camera-set, hr:mute, hr:quality, hr:help     (the shell's list)
 *   hr:tuning        toggle the tuning panel
 *   hr:toast         detail: string, shown for two seconds on the HUD's prompt line
 *   hr:params        simulation parameters were changed (a preset key, the panel)
 *   hr:mute-state    detail: boolean. Optional: the audio module may send its real state
 *                    so the sound button shows it; without it the UI counts hr:mute toggles
 *
 * Events between other modules, listed here so there is one place to look:
 *   hr:camera-changed  detail: mode name. Sent by the camera; the HUD and the panel listen
 *   hr:rider-splash    detail: { x, y, z, strength, kind: 'blade' | 'body' }. Sent by the
 *                      rider (a paddle dab, a thrown rider landing); the fx module draws it
 *   hr:vario           toggles the variometer sound (detail true/false sets). Sent by the
 *                      HUD's bump bar; the audio module listens
 *   hr:rider           detail: 'man' | 'woman' | 'capsules'. Sent by the intro card's toggle
 *                      and the panel; the rider module switches figure
 *   hr:rider-changed   detail: the figure now wanted. Sent by the rider module (also on its
 *                      first frame); the intro card and the panel show it
 */
import type { App } from '../app/types'

export type Device = 'keys' | 'touch' | 'pad'

function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

/** Live state the UI modules share. */
export const ui = {
  /** what the player is using right now; decides the wording of prompts and of the help card */
  device: (coarsePointer() ? 'touch' : 'keys') as Device,
  helpOpen: false,
  muted: false,
  /** show the frame-rate line (?fps=1 or the tuning panel) */
  showFps: false,
}

/** Knobs of the UI itself (not simulation parameters). The tuning panel edits them live. */
export const UI_TUNING_DEFAULTS = {
  /** px of thumb travel from the centre of the stick to full lean */
  stickRadius: 58,
  /** fraction of the radius ignored around the centre, for lean */
  stickDeadzone: 0.08,
  /** the same for ride height: a carving thumb must not change the height by accident */
  heightDeadzone: 0.32,
  /** share of the screen width that belongs to the steering thumb */
  stickSplit: 0.55,
  /** response curve of the stick: lean = travel ^ curve (1 = linear; 1.4 puts half travel at 38 % lean) */
  stickCurve: 1.4,
  /** steering thumb on the right, paddle and pump on the left */
  swapSides: false,
  /**
   * Up (key, thumb, stick) = weight on the front foot = nose down = ride lower, as on a real
   * board; Down = back foot = ride higher. Off: Up = ride higher.
   */
  upIsFrontFoot: true,
  /** a lean key counts as held for at least this long (s), so a tap between two frames still steers */
  keyMinPress: 0.09,
  /** draw the variometer bar at all (the audible one is the sound module's business) */
  showVario: true,
  /** variometer: watts at which the bar is three-quarters full */
  varioScale: 550,
  /** variometer smoothing (s) */
  varioTau: 0.35,
  /** coaching lines: 0 = none, 1 = until the player has shown the skill, 2 = always */
  prompts: 1,
  /**
   * The sprint cue and the quick stamina store (the bright tip of the bar), as fractions of
   * a full tip. The cue comes on only with cueStart or more (enough for a real attempt:
   * from a quarter of a tip about every second attempt gets up) and goes off below cueKeep
   * (the tip is gone: the board cannot be driven up onto the wing any more; an attempt cut
   * off at 0.1 instead succeeds half as often). Below restBelow the line between cues says
   * to let go, because cruising holds the refill back.
   */
  cueStart: 0.25,
  cueKeep: 0.04,
  restBelow: 0.5,
  /**
   * The sprint cue and the size of the bump: it comes on only when the crest behind stands
   * cueBump x h0 x (1 - quick store) above the board, h0 being the drop that takes a board
   * from sprinting speed to flying speed (0.53 m for the default wing). 0 = any face.
   */
  cueBump: 1.9,
}
export type UiTuning = typeof UI_TUNING_DEFAULTS
export const uiTuning: UiTuning = { ...UI_TUNING_DEFAULTS }

const UI_TUNING_KEY = 'hr.ui'

/** Storage that never throws (private mode, blocked cookies, headless). */
export const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch { /* not available: fine */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key) } catch { /* not available: fine */ }
  },
}

/** Read the saved UI knobs once at start-up. Knobs that no longer exist are left behind. */
export function loadUiTuning(): void {
  const raw = store.get(UI_TUNING_KEY)
  if (!raw) return
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>
    const target = uiTuning as unknown as Record<string, unknown>
    for (const k of Object.keys(UI_TUNING_DEFAULTS)) {
      const v = saved[k]
      if (typeof v !== typeof target[k]) continue
      if (typeof v === 'number' && !Number.isFinite(v)) continue
      target[k] = v
    }
  } catch { /* ignore a corrupt entry */ }
}

export function saveUiTuning(): void {
  store.set(UI_TUNING_KEY, JSON.stringify(uiTuning))
}

export function emit(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function toast(text: string): void {
  emit('hr:toast', text)
}

export function uiRoot(): HTMLElement {
  let root = document.getElementById('ui')
  if (!root) {
    root = document.createElement('div')
    root.id = 'ui'
    document.body.appendChild(root)
  }
  return root
}

/** On-screen UI is drawn, except in headless capture, where it needs ?hud=1. */
export function uiVisible(app: App): boolean {
  return !app.options.capture || app.options.query.get('hud') === '1'
}

let rootPrepared = false
let rootReady = false

/**
 * Once, from whichever UI module is created first. Stills must not depend on wall-clock
 * time, so a capture switches off every CSS transition under #ui.
 */
export function prepareUiRoot(app: App): void {
  if (rootPrepared) return
  rootPrepared = true
  if (app.options.capture) uiRoot().classList.add('is-static')
}

/**
 * The first rendered frame: until then the HUD, the buttons and the thumb hints stay hidden
 * (only the help card may be up while the river is being built), so nothing sits over an
 * empty canvas. Called from every UI module's update(); one branch once it has happened.
 */
export function markUiReady(): void {
  if (rootReady) return
  rootReady = true
  uiRoot().classList.add('is-ready')
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** True for form fields the player may be typing into (the tuning panel's number boxes). */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  return type !== 'checkbox' && type !== 'button' && type !== 'range' && type !== 'radio'
}

/** True when a pointer or touch landed on a button, the help card or the tuning panel. */
export function onUiControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-hr-ui]') !== null
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const KNOTS = 1.943844
