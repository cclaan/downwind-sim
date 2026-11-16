/**
 * Sound. Everything is synthesised with the Web Audio API from noise, filters and a few
 * oscillators (see ./engine.ts for the signal chain and the state-to-sound mapping); there
 * are no audio files.
 *
 * This file is the shell around the engine: when the AudioContext may exist and run.
 *   - never in capture mode (no context, no listeners, no sound);
 *   - created on the first real key press, click or touch, as browsers require;
 *   - 'hr:mute' toggles (detail true/false sets); the real state goes out as 'hr:mute-state';
 *   - suspended while the page is hidden or muted, so a silent game costs no audio CPU;
 *   - V, or 'hr:vario' (detail true/false sets), switches the variometer.
 *
 * Query flags: ?asolo=wind,foil (hear only those layers; names in ./tuning.ts), ?vario=1,
 * and ?audio=full|lean to choose the graph whatever the quality tier (the low tier gets the
 * lean one: mono, and without the lows a phone speaker cannot reproduce).
 */
import type { App, FeatureModule, Quality } from '../app/types'
import { AudioEngine } from './engine'
import { AUDIO_LAYERS, audioTuning } from './tuning'

export { audioTuning } from './tuning'

export interface AudioModule extends FeatureModule {
  /** live read-out for checks: context state and the current value of every driven parameter */
  debug(): Record<string, number | string | boolean> | null
}

type ContextClass = typeof AudioContext

function contextClass(): ContextClass | undefined {
  const w = window as unknown as { AudioContext?: ContextClass; webkitAudioContext?: ContextClass }
  return w.AudioContext ?? w.webkitAudioContext
}

/**
 * Input events on which to try starting audio. Which of them the browser accepts as a user
 * gesture differs (a mouse press does, a finger going down does not, its lifting does), so
 * listen to all of them and let wake() ask the browser.
 */
const GESTURES = ['pointerdown', 'mousedown', 'pointerup', 'touchend', 'click'] as const

/** true while the player types into a form field (the tuning panel's number boxes) */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  return type !== 'checkbox' && type !== 'button' && type !== 'range' && type !== 'radio'
}

const noop = () => {}

/** resume(), suspend() and close() return promises, except in engines old enough not to */
function settle(p: Promise<void> | undefined): void {
  if (p && typeof p.catch === 'function') p.catch(noop)
}

/** V by what the key prints, so it is V on any layout; by position where it prints no Latin letter */
function isV(e: KeyboardEvent): boolean {
  const k = e.key.length === 1 ? e.key.toLowerCase() : ''
  return k >= 'a' && k <= 'z' ? k === 'v' : e.code === 'KeyV'
}

export function create(app: App): AudioModule {
  const silent: AudioModule = { update() {}, debug: () => null }
  // headless captures are silent by contract: no AudioContext at all
  if (app.options.capture) return silent
  const found = contextClass()
  if (!found) return silent
  const Ctx: ContextClass = found

  const query = app.options.query
  const solo = query.get('asolo')
  if (solo) {
    const keep = new Set(solo.split(','))
    for (const name of AUDIO_LAYERS) if (!keep.has(name)) audioTuning[name] = 0
  }
  if (query.get('vario') === '1') audioTuning.vario = 1

  let ctx: AudioContext | null = null
  let engine: AudioEngine | null = null
  let broken = false
  let muted = false
  const forced = query.get('audio')
  const pick = (tier: string) => (forced === 'full' ? true : forced === 'lean' ? false : tier !== 'low')
  /** the full graph (stereo, with the lows) or the lean one */
  let stereo = pick(app.quality.tier)
  let sleepTimer = 0

  const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }))

  function fail(err: unknown): void {
    // sound must never take the game down with it
    broken = true
    console.warn('[hood-river] audio switched off', err)
    try { engine?.dispose() } catch { /* already gone */ }
    engine = null
    try { settle(ctx?.close()) } catch { /* already closed */ }
    ctx = null
  }

  /** should be heard right now */
  const live = () => !muted && !document.hidden

  /** Bring the context in line with mute and page visibility. */
  function sync(): void {
    if (!ctx || !engine) return
    window.clearTimeout(sleepTimer)
    if (live()) {
      if (ctx.state !== 'running') settle(ctx.resume())
      engine.setOutput(true)
    } else {
      // fade, then stop the audio thread's work altogether
      engine.setOutput(false)
      sleepTimer = window.setTimeout(() => {
        if (ctx && !live() && ctx.state === 'running') settle(ctx.suspend())
      }, 150)
    }
  }

  /**
   * Create the context if there is none, wake it if it sleeps. Called from real input events
   * (and from un-muting, which comes from one). Some trusted events are not gestures in the
   * browser's eyes (a modifier key, a touch that is still down): where the browser tells,
   * wait for one that is.
   */
  function wake(): void {
    if (broken) return
    if (!ctx) {
      // nothing to hear yet: leave it until the sound is switched on
      if (muted) return
      const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
      if (activation && !activation.hasBeenActive) return
      try {
        ctx = new Ctx({ latencyHint: 'interactive' })
        engine = new AudioEngine(ctx, { stereo })
      } catch (err) {
        fail(err)
        return
      }
    }
    sync()
  }

  function setVario(on: boolean): void {
    audioTuning.vario = on ? 1 : 0
    emit('hr:toast', on ? (muted ? 'Variometer on (sound is muted)' : 'Variometer on') : 'Variometer off')
  }

  const onGesture = (e: Event) => { if (e.isTrusted) wake() }
  const onKey = (e: KeyboardEvent) => {
    if (e.isTrusted) wake()
    if (isV(e) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
      setVario(!(audioTuning.vario > 0.5))
    }
  }
  const onMute = (e: Event) => {
    const want = (e as CustomEvent).detail
    muted = typeof want === 'boolean' ? want : !muted
    // switching the sound on comes from a click or a key: that may be the first gesture
    if (!muted && !ctx) wake()
    else sync()
    emit('hr:mute-state', muted)
  }
  const onVario = (e: Event) => {
    const want = (e as CustomEvent).detail
    setVario(typeof want === 'boolean' ? want : !(audioTuning.vario > 0.5))
  }
  const onVisibility = () => sync()

  window.addEventListener('keydown', onKey, true)
  for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true })
  window.addEventListener('hr:mute', onMute)
  window.addEventListener('hr:vario', onVario)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    update(dt) {
      if (!engine || !ctx || ctx.state !== 'running') return
      try {
        engine.update(app, dt)
      } catch (err) {
        fail(err)
      }
    },

    setQuality(q: Quality) {
      const want = pick(q.tier)
      if (want === stereo) return
      stereo = want
      if (!ctx || !engine) return
      // the tier decides what the graph contains: rebuild it (a short gap, on a manual switch only)
      const old = engine
      old.setOutput(false)
      window.setTimeout(() => old.dispose(), 200)
      try {
        engine = new AudioEngine(ctx, { stereo })
        engine.setOutput(live())
      } catch (err) {
        fail(err)
      }
    },

    reset() {
      engine?.reset()
    },

    dispose() {
      window.removeEventListener('keydown', onKey, true)
      for (const type of GESTURES) window.removeEventListener(type, onGesture, true)
      window.removeEventListener('hr:mute', onMute)
      window.removeEventListener('hr:vario', onVario)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearTimeout(sleepTimer)
      engine?.dispose()
      engine = null
      try { settle(ctx?.close()) } catch { /* already closed */ }
      ctx = null
    },

    debug() {
      if (!ctx || !engine) return { state: broken ? 'broken' : 'waiting for a gesture', muted }
      return {
        state: ctx.state,
        muted,
        stereo: engine.stereo,
        sampleRate: ctx.sampleRate,
        latency: ctx.baseLatency ?? 0,
        ...engine.snapshot(),
      }
    },
  }
}
