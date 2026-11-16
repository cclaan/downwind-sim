/**
 * Input: keyboard, touch and gamepad, written into app.controls before every frame.
 *
 * Keyboard   Left/Right or A/D lean, Up/Down or W/S ride height, Space (or J, for
 *            keyboards that drop a third key) = paddle stroke when floating and pump when
 *            flying (tap = hard, hold = steady).
 *            R restart on the water, F restart flying, C camera, M sound, H help,
 *            P or ` tuning panel, 1-4 handling presets (when more than one exists).
 * Touch      steering thumb: a floating stick anywhere on its side of the screen
 *            (x = lean, analog; y = ride height). Any other finger is the paddle/pump:
 *            tap = hard, hold = steady. Four buttons in the top right corner: camera,
 *            sound, help and, farthest from the camera, restart (which asks twice while
 *            the rider is flying, so a stray thumb cannot end a run).
 * Gamepad    left stick, A (or the right trigger) = paddle/pump, B restart, X restart
 *            flying, Y camera, Start help.
 *
 * Ride height: Up is the front foot (nose down, ride lower) and Down the back foot (ride
 * higher), as on a board; uiTuning.upIsFrontFoot turns it round. The simulation's
 * controls.pitch is +1 = ride higher either way.
 *
 * A key is all or nothing, so digital lean is shaped here: the instant a key goes down it
 * commands handling.bankTap of full lean and grows to full over handling.bankRamp seconds;
 * it drops to zero on release. The physics does the smoothing. With both directions held
 * the key pressed last wins, so rail-to-rail does not need a clean release. A press shorter
 * than uiTuning.keyMinPress is stretched to that length: a quick tap that begins and ends
 * between two frames would otherwise never be seen, and tap trains hold a gentle arc.
 *
 * Nothing is written to app.controls while a scripted pilot (?scenario=) is flying.
 * The buttons and the touch graphics are left out of headless captures unless ?hud=1.
 */
import type { App, FeatureModule } from '../app/types'
import { applyPreset, PRESET_TABLES } from './tune'
import {
  clamp, el, emit, isEditable, loadUiTuning, markUiReady, onUiControl, prepareUiRoot, toast, ui, uiRoot, uiTuning,
  uiVisible, type Device,
} from './shared'

const STEER_KEYS: Record<string, number> = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 }
const PITCH_KEYS: Record<string, number> = { ArrowUp: 1, KeyW: 1, ArrowDown: -1, KeyS: -1 }
const ACTION_KEYS: Record<string, true> = { Space: true, KeyJ: true }

const ICON = {
  restart: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.6 3.6v4.6H15"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M3.5 8.2h3.6l1.7-2.4h6.4l1.7 2.4h3.6v10.3h-17z"/><circle cx="12" cy="13.1" r="3.3"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9.6v4.8h3.4l4.4 3.5V6.1L7.4 9.6z"/><path class="hr-wave" d="M15.3 9.2a4 4 0 0 1 0 5.6"/><path class="hr-wave" d="M17.9 6.6a7.6 7.6 0 0 1 0 10.8"/><path class="hr-cross" d="M15.6 9.6l4.8 4.8m0-4.8l-4.8 4.8"/></svg>',
  help: '<svg viewBox="0 0 24 24"><path d="M9 9.2a3.1 3.1 0 1 1 4.7 2.7c-1 .6-1.7 1.2-1.7 2.6"/><circle class="hr-dot" cx="12" cy="17.9" r="1"/></svg>',
}

const RIPPLE: Keyframe[] = [{ opacity: 0.7, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.9)' }]
const RIPPLE_TIMING: KeyframeAnimationOptions = { duration: 380, easing: 'ease-out' }

function padDown(buttons: readonly GamepadButton[], i: number): boolean {
  return i < buttons.length && buttons[i].pressed
}

/** dead zone, then rescale so the output still reaches 1 */
function shape(v: number, dead: number): number {
  const a = Math.abs(v)
  if (a <= dead) return 0
  return Math.sign(v) * Math.min(1, (a - dead) / (1 - dead))
}

export function create(app: App): FeatureModule {
  loadUiTuning()
  prepareUiRoot(app)
  const c = app.controls
  const scripted = () => app.options.scenario !== ''
  const show = uiVisible(app)

  // -------------------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------------------
  const held = new Set<string>()
  /** Space that only closed the help card: ignored until it is released */
  let swallowSpace = false
  let leanDir = 0
  let leanHold = 0
  /** a tap released early: its direction and how much of the minimum press is left */
  let tapDir = 0
  let tapLeft = 0
  let pitchDir = 0

  /** pointer id of the steering thumb, -1 when none */
  let stickId = -1
  let baseX = 0, baseY = 0, knobX = 0, knobY = 0
  let stickDirty = false
  let stickShown = false
  let touchSteer = 0, touchPitch = 0
  /** pointer ids of the fingers holding the paddle/pump side */
  const actionIds: number[] = []
  let pumpDirty = false
  let pumpShown = false
  let pumpX = 0, pumpY = 0
  let stickUsed = false, pumpUsed = false

  let padSeen = false
  let padSteer = 0, padPitch = 0, padAction = false
  /** A or the trigger as the pad reports it, for the press edge */
  let padRaw = false
  /** the press that only closed the help card: ignored until it is released */
  let padSwallow = false
  const padPrev = new Uint8Array(16)

  /** what kind of pointer went down last ('' before any): decides who keeps the context menu */
  let lastPointer = ''
  /** seconds left in which a second tap on the restart button restarts a rider who is flying */
  let restartArm = 0

  // -------------------------------------------------------------------------------------
  // on-screen parts (not in headless capture unless ?hud=1)
  // -------------------------------------------------------------------------------------
  const layer = el('div', 'hr-touch')
  const ring = el('div', 'hr-stick')
  const knob = el('div', 'hr-knob')
  const pumpRing = el('div', 'hr-pump')
  const ripple = el('i')
  pumpRing.appendChild(ripple)
  const hintStick = el('div', 'hr-hint hr-hint-stick')
  hintStick.append(el('i'), el('span', undefined, 'steer'))
  const hintPump = el('div', 'hr-hint hr-hint-pump')
  hintPump.append(el('i'), el('span', undefined, 'paddle · pump'))
  layer.append(hintStick, hintPump, ring, knob, pumpRing)

  const buttons = el('div', 'hr-buttons')
  buttons.dataset.hrUi = ''
  let soundButton: HTMLButtonElement | null = null
  function addButton(icon: string, label: string, act: () => void): HTMLButtonElement {
    const b = el('button', 'hr-btn')
    b.type = 'button'
    b.tabIndex = -1
    b.title = label
    b.setAttribute('aria-label', label)
    b.innerHTML = icon
    b.addEventListener('click', (e) => {
      e.preventDefault()
      act()
      b.blur()
    })
    buttons.appendChild(b)
    return b
  }
  // restart sits farthest from the camera button, the one that is used in mid-run
  addButton(ICON.camera, 'Camera (C)', () => emit('hr:camera-next'))
  soundButton = addButton(ICON.sound, 'Sound (M)', () => emit('hr:mute'))
  addButton(ICON.help, 'Help (H)', () => emit('hr:help'))
  const restartButton = addButton(ICON.restart, 'Restart on the water (R)', () => {
    // flying: ask twice, so a stray thumb cannot end a run (R on the keyboard is deliberate)
    if (app.view.mode === 'foil' && !scripted() && restartArm <= 0) {
      restartArm = 2.5
      restartButton.classList.add('is-armed')
      toast(ui.device === 'touch' ? 'Tap again to restart' : 'Click again to restart')
      return
    }
    disarmRestart()
    app.restart('paddle')
  })
  function disarmRestart() {
    if (restartArm <= 0) return
    restartArm = 0
    restartButton.classList.remove('is-armed')
  }

  let shownSwap = false
  let ringRadius = 58
  function syncLayer() {
    shownSwap = uiTuning.swapSides
    // the thumb hints only make sense when the thumbs fly the board (not in a scripted demo)
    layer.classList.toggle('is-touch', ui.device === 'touch' && !scripted())
    layer.classList.toggle('is-swapped', shownSwap)
    hintStick.classList.toggle('is-done', stickUsed)
    hintPump.classList.toggle('is-done', pumpUsed)
  }
  /** the drawn ring is as big as the thumb's travel to full lean */
  function sizeRing() {
    const r = Math.max(20, Math.round(uiTuning.stickRadius))
    if (r === ringRadius) return
    ringRadius = r
    ring.style.width = ring.style.height = `${2 * r}px`
    ring.style.margin = `${-r}px 0 0 ${-r}px`
  }
  function setDevice(d: Device) {
    if (ui.device === d) return
    ui.device = d
    syncLayer()
  }
  if (show) {
    const root = uiRoot()
    root.append(layer, buttons)
    syncLayer()
  }

  // -------------------------------------------------------------------------------------
  // keyboard
  // -------------------------------------------------------------------------------------
  function dirHeld(table: Record<string, number>, dir: number): boolean {
    for (const code of held) if (table[code] === dir) return true
    return false
  }

  /** letter keys by what they print (so M is M on any layout), by position as a fallback */
  function letterOf(e: KeyboardEvent): string {
    const k = e.key.length === 1 ? e.key.toLowerCase() : ''
    if ((k >= 'a' && k <= 'z') || (k >= '0' && k <= '9') || k === '`') return k
    if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase()
    if (e.code.startsWith('Digit')) return e.code.slice(5)
    return e.code === 'Backquote' ? '`' : ''
  }

  function onKeyDown(e: KeyboardEvent) {
    // macOS never sends the keyup of a key let go while Cmd is down (a screenshot shortcut
    // in mid-carve would leave the lean or SPACE stuck): Cmd lets go of everything. A key
    // that is in fact still held comes back with its next auto-repeat (see below).
    if (e.metaKey || e.key === 'Meta') { releaseAll(); return }
    if (e.ctrlKey || e.altKey) return
    if (isEditable(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur()
      return
    }
    const code = e.code
    if (ui.helpOpen && (code === 'Space' || code === 'Enter' || code === 'Escape')) {
      e.preventDefault()
      if (!e.repeat) {
        emit('hr:help')
        if (code === 'Space') swallowSpace = true
      }
      return
    }
    // (an auto-repeat of a key that was let go of for the player, on Cmd or when the window
    // lost the focus, means it is still down: it counts as a fresh press)
    if (code in STEER_KEYS) {
      e.preventDefault()
      if (e.repeat && held.has(code)) return
      held.add(code)
      leanDir = STEER_KEYS[code]
      leanHold = 0
      tapDir = 0
      setDevice('keys')
      return
    }
    if (code in PITCH_KEYS) {
      e.preventDefault()
      if (e.repeat && held.has(code)) return
      held.add(code)
      pitchDir = PITCH_KEYS[code]
      setDevice('keys')
      return
    }
    if (code in ACTION_KEYS) {
      e.preventDefault()
      if ((e.repeat && held.has(code)) || (code === 'Space' && swallowSpace)) return
      held.add(code)
      if (!scripted()) c.actionPressed = true
      setDevice('keys')
      return
    }
    if (e.repeat) return
    switch (letterOf(e)) {
      case 'r': app.restart('paddle'); break
      case 'f': app.restart('foil'); break
      case 'c': emit('hr:camera-next'); break
      case 'm': emit('hr:mute'); break
      case 'h': emit('hr:help'); break
      case 'p': case '`': emit('hr:tuning'); break
      case '1': case '2': case '3': case '4': {
        const keys = Object.keys(PRESET_TABLES.handling)
        const key = keys[Number(letterOf(e)) - 1]
        if (keys.length > 1 && key && applyPreset(app, 'handling', key)) {
          toast(`Handling: ${PRESET_TABLES.handling[key].label}`)
        }
        break
      }
      default: return
    }
    e.preventDefault()
  }

  function onKeyUp(e: KeyboardEvent) {
    const code = e.code
    if (e.key === 'Meta') { releaseAll(); return }
    held.delete(code)
    if (code === 'Space') {
      swallowSpace = false
      // a focused button would otherwise take the release of SPACE as a click
      if (!isEditable(e.target)) e.preventDefault()
    }
    if (code in STEER_KEYS && STEER_KEYS[code] === leanDir && !dirHeld(STEER_KEYS, leanDir)) {
      if (dirHeld(STEER_KEYS, -leanDir)) {
        // the other direction is still down: a fresh press of it, starting at the tap value
        leanDir = -leanDir
      } else {
        if (leanHold < uiTuning.keyMinPress) {
          tapDir = leanDir
          tapLeft = uiTuning.keyMinPress - leanHold
        }
        leanDir = 0
      }
      leanHold = 0
    }
    if (code in PITCH_KEYS && PITCH_KEYS[code] === pitchDir && !dirHeld(PITCH_KEYS, pitchDir)) {
      pitchDir = dirHeld(PITCH_KEYS, -pitchDir) ? -pitchDir : 0
    }
  }

  // -------------------------------------------------------------------------------------
  // touch (pointer events from fingers and pens; the mouse is left to other modules)
  // -------------------------------------------------------------------------------------
  function inStickZone(x: number): boolean {
    const split = clamp(uiTuning.stickSplit, 0.2, 0.8)
    return uiTuning.swapSides ? x > app.width * (1 - split) : x < app.width * split
  }

  function moveStick(x: number, y: number) {
    const r = Math.max(20, uiTuning.stickRadius)
    let dx = x - baseX
    let dy = y - baseY
    // the base follows a thumb that slides past the rim, so reversing never needs a long way back
    if (dx > r) { baseX += dx - r; dx = r } else if (dx < -r) { baseX += dx + r; dx = -r }
    if (dy > r) { baseY += dy - r; dy = r } else if (dy < -r) { baseY += dy + r; dy = -r }
    const lean = shape(dx / r, uiTuning.stickDeadzone)
    touchSteer = Math.sign(lean) * Math.pow(Math.abs(lean), clamp(uiTuning.stickCurve, 0.5, 3))
    touchPitch = shape(-dy / r, uiTuning.heightDeadzone)
    // the two axes are independent (full lean and full height together are possible);
    // only the drawn knob is kept inside the ring
    const m = Math.hypot(dx, dy)
    const k = m > r ? r / m : 1
    knobX = baseX + dx * k
    knobY = baseY + dy * k
    stickDirty = true
  }

  function releaseStick() {
    stickId = -1
    touchSteer = 0
    touchPitch = 0
    stickDirty = true
  }

  function onPointerDown(e: PointerEvent) {
    lastPointer = e.pointerType
    if (e.pointerType === 'mouse' || onUiControl(e.target)) return
    setDevice('touch')
    // a tap on the water takes the focus back from the tuning panel's number boxes
    const focus = document.activeElement
    if (focus instanceof HTMLElement && focus !== document.body) focus.blur()
    if (stickId === -1 && inStickZone(e.clientX)) {
      stickId = e.pointerId
      baseX = e.clientX
      baseY = e.clientY
      sizeRing()
      moveStick(e.clientX, e.clientY)
      if (!stickUsed) { stickUsed = true; syncLayer() }
      return
    }
    if (actionIds.indexOf(e.pointerId) === -1) actionIds.push(e.pointerId)
    if (!scripted()) c.actionPressed = true
    pumpX = e.clientX
    pumpY = e.clientY
    pumpDirty = true
    if (!pumpUsed) { pumpUsed = true; syncLayer() }
    // the ripple confirms the tap; transform and opacity only, so it never repaints
    if (show && !app.options.capture && typeof ripple.animate === 'function') ripple.animate(RIPPLE, RIPPLE_TIMING)
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerId === stickId) moveStick(e.clientX, e.clientY)
    else if (actionIds.length && actionIds[actionIds.length - 1] === e.pointerId) {
      pumpX = e.clientX
      pumpY = e.clientY
      pumpDirty = true
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId === stickId) { releaseStick(); return }
    const i = actionIds.indexOf(e.pointerId)
    if (i !== -1) {
      actionIds.splice(i, 1)
      pumpDirty = true
    }
  }

  function releaseAll() {
    held.clear()
    swallowSpace = false
    leanDir = 0
    leanHold = 0
    tapDir = 0
    pitchDir = 0
    if (stickId !== -1) releaseStick()
    if (actionIds.length) { actionIds.length = 0; pumpDirty = true }
  }

  function onVisibility() {
    if (document.hidden) releaseAll()
  }

  /** stop the browser's own gestures on the game surface: scroll, zoom, callout, menu */
  function block(e: Event) {
    if (!onUiControl(e.target)) e.preventDefault()
  }
  /** the long-press menu of a touch screen; a mouse keeps its right-click menu (Inspect) */
  function blockMenu(e: Event) {
    if (isEditable(e.target)) return
    const type = (e as PointerEvent).pointerType
    const touch = type ? type !== 'mouse' : lastPointer !== '' && lastPointer !== 'mouse'
    if (touch) e.preventDefault()
  }

  // -------------------------------------------------------------------------------------
  // gamepad (polled only once one has announced itself)
  // -------------------------------------------------------------------------------------
  function onPadConnected() { padSeen = true }

  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null
    let gp: Gamepad | null = null
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (p && p.connected) { gp = p; break }
      }
    }
    if (!gp) {
      padSteer = 0
      padPitch = 0
      padAction = false
      padRaw = false
      padSwallow = false
      return
    }
    padSteer = shape(gp.axes[0] ?? 0, 0.15)
    padPitch = shape(-(gp.axes[1] ?? 0), 0.3)
    const b = gp.buttons
    const down = padDown(b, 0) || padDown(b, 7)
    if (down && !padRaw) {
      setDevice('pad')
      // the press that closes the help card is not also a stroke (as with SPACE)
      if (ui.helpOpen) {
        emit('hr:help')
        padSwallow = true
      } else if (!scripted()) {
        c.actionPressed = true
      }
    }
    if (!down) padSwallow = false
    padRaw = down
    padAction = down && !padSwallow && !ui.helpOpen
    if (padSteer !== 0 || padPitch !== 0) setDevice('pad')
    if (padEdge(b, 1)) app.restart('paddle')
    if (padEdge(b, 2)) app.restart('foil')
    if (padEdge(b, 3)) emit('hr:camera-next')
    if (padEdge(b, 9)) emit('hr:help')
  }

  /** true on the frame a button goes down */
  function padEdge(buttons: readonly GamepadButton[], i: number): boolean {
    const now = padDown(buttons, i) ? 1 : 0
    const hit = now === 1 && padPrev[i] === 0
    padPrev[i] = now
    return hit
  }

  // -------------------------------------------------------------------------------------
  // sound button state
  // -------------------------------------------------------------------------------------
  function showMuted() {
    if (soundButton) soundButton.classList.toggle('is-muted', ui.muted)
  }
  function setMuted(muted: boolean) {
    ui.muted = muted
    showMuted()
    toast(muted ? 'Sound off' : 'Sound on')
  }
  // The audio module owns the real state and reports it with 'hr:mute-state', from inside
  // the same 'hr:mute' dispatch (before or after this listener, depending on load order).
  // Only when nobody has reported by the end of the dispatch does the UI count for itself.
  let muteReported = false
  function onMute(e: Event) {
    const want = (e as CustomEvent).detail
    queueMicrotask(() => {
      if (!muteReported) setMuted(typeof want === 'boolean' ? want : !ui.muted)
      muteReported = false
    })
  }
  function onMuteState(e: Event) {
    muteReported = true
    setMuted(!!(e as CustomEvent).detail)
  }

  // -------------------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------------------
  const passiveOff: AddEventListenerOptions = { passive: false }
  // capture phase: lil-gui stops key events inside its controllers from bubbling, and the
  // game still has to hear Escape (leave a number box) and the keys held while clicking there
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', releaseAll)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('gamepadconnected', onPadConnected)
  window.addEventListener('hr:mute', onMute)
  window.addEventListener('hr:mute-state', onMuteState)
  window.addEventListener('contextmenu', blockMenu)
  // Safari's pinch and double-tap zoom, and anything a browser still does despite touch-action
  window.addEventListener('gesturestart', block, passiveOff)
  window.addEventListener('gesturechange', block, passiveOff)
  window.addEventListener('dblclick', block, passiveOff)
  app.canvas.addEventListener('touchstart', block, passiveOff)
  app.canvas.addEventListener('touchmove', block, passiveOff)
  app.canvas.addEventListener('touchend', block, passiveOff)

  return {
    update(dt) {
      markUiReady()
      if (padSeen) pollPad()
      if (restartArm > 0) {
        // the question lapses after a moment, or as soon as the flight is over anyway
        restartArm = app.view.mode === 'foil' ? restartArm - dt : 0
        if (restartArm <= 0) restartButton.classList.remove('is-armed')
      }

      let keySteer = 0
      const H = app.sim.P.handling
      const tap = clamp(H.bankTap, 0, 1)
      if (leanDir !== 0) {
        const grown = H.bankRamp > 1e-3 ? Math.min(1, leanHold / H.bankRamp) : 1
        keySteer = leanDir * (tap + (1 - tap) * grown)
        leanHold += dt
      } else if (tapDir !== 0) {
        // the rest of a tap that was let go before the minimum press was up
        keySteer = tapDir * tap
        tapLeft -= dt
        if (tapLeft <= 0) tapDir = 0
      }

      if (!scripted()) {
        // controls.pitch is +1 = ride higher; Up is the front foot (lower) unless turned round
        const foot = uiTuning.upIsFrontFoot ? -1 : 1
        c.steer = clamp(keySteer + touchSteer + padSteer, -1, 1)
        c.pitch = clamp(pitchDir + touchPitch + padPitch, -1, 1) * foot
        c.action = held.has('Space') || held.has('KeyJ') || actionIds.length > 0 || padAction
      }

      if (!show) return
      if (shownSwap !== uiTuning.swapSides) syncLayer()
      if (stickDirty) {
        stickDirty = false
        const on = stickId !== -1
        if (on !== stickShown) {
          stickShown = on
          ring.classList.toggle('is-on', on)
          knob.classList.toggle('is-on', on)
        }
        if (on) {
          ring.style.transform = `translate(${Math.round(baseX)}px,${Math.round(baseY)}px)`
          knob.style.transform = `translate(${Math.round(knobX)}px,${Math.round(knobY)}px)`
        }
      }
      if (pumpDirty) {
        pumpDirty = false
        const on = actionIds.length > 0
        if (on !== pumpShown) {
          pumpShown = on
          pumpRing.classList.toggle('is-on', on)
        }
        pumpRing.style.transform = `translate(${Math.round(pumpX)}px,${Math.round(pumpY)}px)`
      }
    },

    resize() {
      // the stick's side is read from app.width when a finger lands; nothing to lay out
      if (show) syncLayer()
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', releaseAll)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('gamepadconnected', onPadConnected)
      window.removeEventListener('hr:mute', onMute)
      window.removeEventListener('hr:mute-state', onMuteState)
      window.removeEventListener('contextmenu', blockMenu)
      window.removeEventListener('gesturestart', block)
      window.removeEventListener('gesturechange', block)
      window.removeEventListener('dblclick', block)
      app.canvas.removeEventListener('touchstart', block)
      app.canvas.removeEventListener('touchmove', block)
      app.canvas.removeEventListener('touchend', block)
      layer.remove()
      buttons.remove()
    },
  }
}
