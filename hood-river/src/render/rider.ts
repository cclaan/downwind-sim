/**
 * The rider, board, foil and paddle.
 *
 * Two draw calls: the board hull (one small vertex-coloured mesh) and one instanced set of
 * capsules for the figure, the paddle and the foil. Everything is generated at load. The
 * pose is solved every frame from app.view by RiderAnimator (src/render/rider/animator.ts);
 * the numbers worth tuning are in src/render/rider/tune.ts and exposed as `module.tune`.
 *
 * The figure is a character model (man or woman, src/render/rider/skinned.ts) posed from the
 * same solved skeleton, once its GLB has loaded; until then, or with ?rider=capsules, it is
 * drawn as capsules. ?rider=man|woman|capsules picks one, as do the intro card's toggle and the
 * panel's View folder through the 'hr:rider' event; the choice is remembered in this browser.
 *
 * Debug: ?rpose=bank:30,gLoad:1.3,steerSmooth:0.8 pins fields of the state the rider is
 * drawn from (angles in degrees; mode:foil|paddle|swim), for checking a posture in isolation.
 */
import * as THREE from 'three'
import type { App, FeatureModule, Quality } from '../app/types'
import { riderMatrix } from '../app/frames'
import type { RiderState } from '../sim/types'
import { makeRider } from '../sim/physics'
import { RiderAnimator } from './rider/animator'
import { buildBoard } from './rider/board'
import { CapsuleSet } from './rider/capsules'
import { CAP, paintFigure, writeFoil } from './rider/rig'
import { LIT_FRAG, MESH_VERT } from './rider/shaders'
import { DEG } from './rider/springs'
import { BODY_DEFAULT, CHARACTERS, loadCharacter, type CharacterName, type SkinnedRider } from './rider/skinned'
import { BODY, RIDER_TUNE } from './rider/tune'

const RIDER_KEY = 'hr-rider'
const isCharacter = (v: unknown): v is CharacterName => v === 'man' || v === 'woman' || v === 'capsules'

/** ?rider= first, then this browser's last choice (not in captures, which must repeat) */
function firstCharacter(app: App): CharacterName {
  const q = app.options.query.get('rider')
  if (isCharacter(q)) return q
  if (!app.options.capture) {
    try {
      const saved = localStorage.getItem(RIDER_KEY)
      if (isCharacter(saved)) return saved
    } catch { /* storage blocked: the default */ }
  }
  return 'man'
}

/** fastest the drawn board pitches (degrees per second) */
const PITCH_SLEW = 170

const ANGLES = new Set(['bank', 'pitch', 'heading', 'slip', 'bankRate', 'turnRate', 'alpha'])

/** ?rpose=key:value,... -> a function that pins those fields on a state */
function parsePin(spec: string | null): ((s: RiderState) => void) | null {
  if (!spec) return null
  const pins: [string, number | string][] = []
  for (const item of spec.split(',')) {
    const [key, raw] = item.split(':')
    if (!key || raw === undefined) continue
    if (key === 'mode') pins.push([key, raw])
    else if (raw === 'true' || raw === 'false') pins.push([key, raw === 'true' ? 1 : 0])
    else if (Number.isFinite(Number(raw))) pins.push([key, Number(raw) * (ANGLES.has(key) ? DEG : 1)])
  }
  if (!pins.length) return null
  return (s) => {
    const o = s as unknown as Record<string, unknown>
    for (const [key, value] of pins) {
      if (!(key in o)) continue
      o[key] = typeof o[key] === 'boolean' ? value === 1 : value
    }
  }
}

function detailFor(q: Quality): { radial: number; rings: number; board: number } {
  if (q.tier === 'low') return { radial: 6, rings: 3, board: 0.3 }
  if (q.tier === 'mid') return { radial: 8, rings: 4, board: 0.65 }
  return { radial: 12, rings: 5, board: 1 }
}

export async function create(app: App): Promise<FeatureModule> {
  // lit by the shared atmosphere (sun, sky and water-bounce light, haze): no scene lights needed
  const uniforms = { ...app.atmos.uniforms, uPx: { value: 0.001 } }

  let detail = detailFor(app.quality)
  const group = new THREE.Group()
  group.matrixAutoUpdate = false
  group.name = 'rider'

  const boardMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: MESH_VERT, fragmentShader: LIT_FRAG })
  const F = app.sim.P.foil
  const boardSpec = () => ({ length: F.boardLength, width: F.boardWidth, mastLength: F.mastLength })
  const board = new THREE.Mesh(buildBoard(boardSpec(), detail.board), boardMaterial)
  board.frustumCulled = false
  board.matrixAutoUpdate = false

  const caps = new CapsuleSet(CAP.count, uniforms, detail.radial, detail.rings)
  paintFigure(caps)
  writeFoil(caps, F)
  group.add(board, caps.mesh)
  app.scene.add(group)

  const anim = new RiderAnimator(app)
  const pin = parsePin(app.options.query.get('rpose'))
  const pinned: RiderState = makeRider()

  // ---- the figure: a character model, or the capsules ----
  /** which figure is wanted; 'hr:rider' (the intro card, the panel) changes it, update() switches */
  const figure = { character: firstCharacter(app) }
  /** say which figure is shown (hr:rider-changed) on the next frame */
  let announce = true
  function onRider(e: Event) {
    const name = (e as CustomEvent).detail
    if (isCharacter(name)) figure.character = name
  }
  window.addEventListener('hr:rider', onRider)
  const models = new Map<CharacterName, SkinnedRider>()
  let active: SkinnedRider | null = null
  let asked: CharacterName | '' = ''
  let disposed = false

  function show(name: CharacterName): void {
    if (active) group.remove(active.holder)
    active = name === 'capsules' ? null : models.get(name) ?? null
    // the skeleton is solved for the body that is drawn: feet on the deck, hands on the paddle
    Object.assign(BODY, active ? active.body : BODY_DEFAULT)
    if (active) group.add(active.holder)
  }

  /** load (once) and show a figure; the one on screen stays until the new one has arrived */
  async function request(name: CharacterName): Promise<void> {
    asked = name
    if (name === 'capsules' || models.has(name)) { show(name); return }
    try {
      const model = await loadCharacter(CHARACTERS[name])
      if (disposed) { model.dispose(); return }
      models.set(name, model)
      if (asked === name) show(name)
    } catch (err) {
      console.warn(`rider: could not load the ${name} character, drawing the capsule figure`, err)
      if (asked === name) { figure.character = 'capsules'; asked = 'capsules'; announce = true; show('capsules') }
    }
  }

  // what the foil and board were built from, to rebuild when the tuning panel changes them
  let built = ''
  const signature = () => `${F.span}|${F.area}|${F.mastLength}|${F.mastChord}|${F.boardLength}|${F.boardWidth}|${RIDER_TUNE.mastFrac}|${RIDER_TUNE.boardThick}`
  built = signature()
  let checkTimer = 0

  // ---- the board's drawn attitude ----
  // The state steps in pitch when a pump starts or stops and in height when the mode
  // changes. Those steps are absorbed into offsets that fade, so the board never pops.
  const drawn = { x: 0, y: 0, z: 0, heave: 0, heading: 0, pitch: 0, bank: 0 }
  let offPitch = 0, offY = 0, offBank = 0, offHeading = 0
  let prevPitch = 0, prevY = 0, prevBank = 0, prevHeading = 0
  let ratePitch = 0, rateY = 0, rateBank = 0, rateHeading = 0
  let prevMode = ''
  let prevPumping = false
  let edgeFrames = 0, modeEdge = 0
  let fresh = true

  const wrap = (v: number) => (v > Math.PI ? v - 2 * Math.PI : v < -Math.PI ? v + 2 * Math.PI : v)

  function boardAttitude(s: RiderState, dt: number): void {
    const y = s.y - s.heave
    const pumping = s.mode === 'foil' && s.pumpPhase >= 0
    const wasFresh = fresh
    if (fresh) {
      offPitch = offY = offBank = offHeading = 0
      ratePitch = rateY = rateBank = rateHeading = 0
      edgeFrames = modeEdge = 0
    } else {
      // The view interpolates attitude between sim steps but takes the pump phase from the
      // newer one, so a step in pitch can land on the frame of the edge, the next, or be
      // split across both: watch two frames.
      if (s.mode !== prevMode) { edgeFrames = 2; modeEdge = 2 } else if (pumping !== prevPumping) edgeFrames = 2
      const dPitch = s.pitch - prevPitch, dY = y - prevY, dBank = s.bank - prevBank, dHeading = wrap(s.heading - prevHeading)
      if (edgeFrames > 0) {
        edgeFrames--
        // a step: whatever the state moved beyond its previous rate goes into the offset
        offPitch -= dPitch - ratePitch * dt
        offBank -= dBank - rateBank * dt
        offHeading -= dHeading - rateHeading * dt
        if (modeEdge > 0) { modeEdge--; offY -= dY - rateY * dt }
      } else if (dt > 1e-5) {
        ratePitch = dPitch / dt; rateY = dY / dt; rateBank = dBank / dt; rateHeading = dHeading / dt
      }
      const k = Math.exp(-dt / 0.22)
      offPitch *= k; offBank *= k; offHeading *= k
      offY *= Math.exp(-dt / 0.16)
    }
    prevPitch = s.pitch; prevY = y; prevBank = s.bank; prevHeading = s.heading
    prevMode = s.mode; prevPumping = pumping
    fresh = false
    drawn.x = s.x; drawn.z = s.z
    drawn.y = y + offY - anim.bobHeave
    drawn.heave = 0
    drawn.heading = s.heading + offHeading
    // The board cannot snap its nose about: slew the drawn pitch (a pump rocks at up to
    // about 100 deg/s; the state can swing three times as fast as the hull slaps down).
    const pitch = s.pitch + offPitch + anim.bobPitch
    const slew = PITCH_SLEW * DEG * dt
    drawn.pitch = wasFresh ? pitch : drawn.pitch + Math.max(-slew, Math.min(slew, pitch - drawn.pitch))
    drawn.bank = s.bank + offBank
  }

  function rebuildGear(): void {
    board.geometry.dispose()
    board.geometry = buildBoard(boardSpec(), detail.board)
    writeFoil(caps, F)
    built = signature()
  }

  const mod = {
    /** live tuning numbers (see src/render/rider/tune.ts) */
    tune: RIDER_TUNE,
    /** which figure is drawn: 'man' | 'woman' | 'capsules' (set it with the 'hr:rider' event) */
    figure,
    /** this frame's blend weights and posture numbers (read-only) */
    debug: anim.dbg,
    /** the solved skeleton and paddle in the board frame, and that frame's matrix (read-only, for tests) */
    rig: anim.rig,
    paddle: { top: anim.padTop, dir: anim.padDir },
    frame: group.matrix,
    /** for a stats readout */
    stats: () => ({
      drawCalls: active ? 3 : 2,
      triangles: caps.triangles * (active ? (CAP.count - CAP.footR - 1) / CAP.count : 1) + (board.geometry.index ? board.geometry.index.count / 3 : 0) + (active ? active.triangles : 0),
      capsules: CAP.count,
      character: active ? figure.character : 'capsules',
    }),
    update(dt: number) {
      let s = app.view
      if (pin) {
        Object.assign(pinned, s)
        pin(pinned)
        s = pinned
      }
      if (figure.character !== asked) {
        if (!isCharacter(figure.character)) figure.character = 'man'
        void request(figure.character)
        if (!app.options.capture) {
          try { localStorage.setItem(RIDER_KEY, figure.character) } catch { /* not remembered */ }
        }
        announce = true
      }
      if (announce) {
        announce = false
        window.dispatchEvent(new CustomEvent('hr:rider-changed', { detail: figure.character }))
      }
      checkTimer -= dt
      if (checkTimer <= 0) {
        checkTimer = 0.25
        if (signature() !== built) rebuildGear()
      }
      boardAttitude(s, dt)
      riderMatrix(drawn as unknown as RiderState, group.matrix)
      group.matrixWorldNeedsUpdate = true

      anim.update(dt, group.matrix, s, app.events)
      anim.rig.write(caps)
      if (active) {
        // the model takes the figure's place; the capsules keep the paddle and the foil
        active.pose(anim.rig)
        for (let i = CAP.pelvis; i <= CAP.footR; i++) caps.hide(i)
      }
      anim.rig.writePaddle(caps, anim.padTop, anim.padDir, anim.padWide)
      caps.commit()

      // thin parts never thinner than a set number of pixels
      const bufferHeight = Math.max(1, app.height * app.pixelRatio)
      uniforms.uPx.value = (0.5 * RIDER_TUNE.minPixels * 2 * Math.tan((app.camera.fov * DEG) / 2)) / bufferHeight
    },
    setQuality(q: Quality) {
      const next = detailFor(q)
      if (next.radial === detail.radial && next.rings === detail.rings && next.board === detail.board) return
      detail = next
      caps.setDetail(detail.radial, detail.rings)
      rebuildGear()
    },
    reset() {
      fresh = true
      anim.reset()
    },
    dispose() {
      disposed = true
      window.removeEventListener('hr:rider', onRider)
      for (const model of models.values()) model.dispose()
      Object.assign(BODY, BODY_DEFAULT)
      app.scene.remove(group)
      board.geometry.dispose()
      boardMaterial.dispose()
      caps.dispose()
    },
  }
  // A capture must look the same every run, so it waits for the model; a player starts at
  // once with the capsule figure, which the model replaces when it has arrived.
  if (app.options.capture) await request(figure.character)
  else void request(figure.character)
  return mod
}
