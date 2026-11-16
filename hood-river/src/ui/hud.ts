/**
 * HUD: a few DOM elements over the canvas.
 *
 *   speed            through the water, knots, large; amber close to the stall (which rises
 *                    with the load in a turn), red once stalled
 *   stamina          one bar: the dark part is the slow store (minutes to refill), the
 *                    bright tip the quick store (the sprint: about half a minute to refill,
 *                    and only while resting); a notch marks where the one ends and the other
 *                    begins when both are full
 *   mast gauge       the foil seen from behind against a fixed water line: the board, the
 *                    mast and the wing rise, sink and bank with the rider. Amber when the
 *                    wing is near the surface or the board near the water, red on a breach
 *                    or a touchdown
 *   variometer       net power from the water (wave + drag + air, W), centre-zero: green
 *                    when the bump is feeding the rider, red when it is costing. A tap on
 *                    it switches the sound module's audible variometer
 *   prompt           one line for the situation, retired once the player has done it; and
 *                    one coach line after dropping off the foil, saying why (from the last
 *                    three seconds of the flight)
 *   session          time on foil, distance downwind, take-offs, longest glide with no pump
 *   help card        first run and H: controls and the three ideas of the level
 *
 * There is deliberately no bump-phase meter: the eyes have to learn the water.
 *
 * The prompt line is run by a small scheduler (see refresh): a line that is up stays long
 * enough to be read (1.5 s for something to do now, 3 s for two sentences), only the sprint
 * cue, "Pump!" and a toast answering a key may cut another line short, a line goes up only
 * once its situation has lasted a moment, and conditions that flicker (breach, touch) are
 * latched for a second. The opening line has its three seconds before the first sprint cue.
 *
 * Paddle-up coaching says what is actually keeping the board on the water, in this order:
 * too shallow for the wing; pointing too far off downwind; out of breath. The sprint cue
 * is the scripted pilot's own face test (paddleFace), given only when a sprint can work:
 * with a quarter of the quick stamina store or more (the bright tip of the bar), and on a
 * bump big enough for what is left of it. Between cues the line says to let go while the
 * tip is under half, because cruising holds the refill back. A player who does exactly
 * what the line says gets up; build/ui/finish/f1-players.mjs is the test of that.
 *
 * In flight "too high" and "too low" say why: over a crest or on the back foot; too slow,
 * leaned over too far for the height, or on the front foot.
 *
 * Query flags: ?hud=1 shows the HUD in headless captures (it is hidden there otherwise),
 * ?help=1 / ?help=0 forces the help card open / keeps it closed, ?fps=1 adds a line with
 * the frame rate, draw calls, triangles and resolution, ?prompts=off|learn|always overrides
 * the coaching level for this visit.
 *
 * Smoothing runs every frame on the dt it is given (so captures are deterministic); the
 * DOM is written at 10 Hz (numbers as text at 4 Hz: they are read, not watched) and only
 * where a value changed. Nothing here blurs the canvas.
 */
import type { App, FeatureModule } from '../app/types'
import { paddleFace } from '../app/scenarios'
import { LEVEL } from '../sim/level'
import { EV } from '../sim/types'
import { G } from '../sim/waves'
import {
  clamp, el, emit, KNOTS, markUiReady, prepareUiRoot, store, ui, uiRoot, uiTuning, uiVisible, type Device,
} from './shared'

const HUD_DT = 0.1
/** numbers as text change four times a second at most */
const TEXT_DT = 0.25
/** gauge scale: em per metre (the gauge is 5 em tall, the water line across its middle) */
const EM_PER_M = 2.5
const DEG = 180 / Math.PI
/** tanh(K) = 0.75: the variometer bar is three-quarters full at uiTuning.varioScale watts */
const VARIO_K = 0.973
const HELP_SEEN = 'hr.help.seen'
/** samples of flight history kept for the coach line (10 Hz) */
const HIST = 40

const PR = {
  NONE: 0, TOAST: 1, COACH: 2, FLOAT: 3, REST: 4, SHALLOW: 5, GO: 6, AIRBORNE: 7, STALL: 8, CARVE: 9, HIGH: 10, LOW: 11, TURN: 12,
} as const
/** data-pr on the prompt element: which line is up (for tests and for anyone styling it) */
const PR_NAME = ['', 'toast', 'coach', 'float', 'rest', 'shallow', 'go', 'airborne', 'stall', 'carve', 'high', 'low', 'turn']
/** where a line belongs: 0 anywhere, 1 on the water (floating or swimming), 2 flying */
const PR_CTX = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1]
/** 0 plain, 1 urgent (amber, larger), 2 go (green), 3 caution (amber) */
const PR_STYLE = [0, 0, 0, 0, 3, 3, 2, 0, 1, 0, 1, 1, 3]
/**
 * Refreshes (0.1 s each) a line's situation must have lasted before the line goes up: none
 * for a toast, the sprint cue and "Pump!"; longer for the standing advice on the water,
 * which would otherwise flash up between two sprint cues.
 */
const PR_WAIT = [0, 0, 3, 6, 6, 6, 0, 3, 0, 3, 3, 3, 6]
/**
 * Paddling up works within about 45 degrees of downwind and not at all beyond 70 (measured
 * with the cue-following bot): past TURN_ON the line says to point the board downwind and
 * the sprint cue stays off, until the board is within TURN_OFF again.
 */
const TURN_ON = 50 / (180 / Math.PI)
const TURN_OFF = 30 / (180 / Math.PI)
/** seconds floating after which the paddle-up coaching comes back for a player who had outgrown it */
const STUCK = 10

const PROMPT_LEVELS: Record<string, number> = { off: 0, '0': 0, learn: 1, '1': 1, always: 2, '2': 2 }

/** the lines whose phrasing depends on what the player is holding */
interface Wording {
  float: string
  go: string
  airborne: string
  carve: string
}

const WORDS: Record<Device, Wording> = {
  keys: {
    float: 'Hold SPACE to paddle. Sprint (tap) as the next bump lifts your tail',
    go: 'Sprint now: tap SPACE fast!',
    airborne: 'Pump (tap SPACE) to get clear',
    carve: 'Carve across the face: lean with ← →. Running straight outruns the bump',
  },
  touch: {
    float: 'Hold the right side to paddle. Tap fast to sprint as the next bump lifts your tail',
    go: 'Sprint now: tap fast!',
    airborne: 'Pump (tap the right side) to get clear',
    carve: 'Carve across the face: slide the left thumb. Running straight outruns the bump',
  },
  pad: {
    float: 'Hold A to paddle. Sprint (tap) as the next bump lifts your tail',
    go: 'Sprint now: tap A fast!',
    airborne: 'Pump (tap A) to get clear',
    carve: 'Carve across the face: lean with the stick. Running straight outruns the bump',
  },
}

/** the same, for when the long line does not fit between the cluster and the buttons */
const WORDS_NARROW: Record<Device, Wording> = {
  keys: {
    float: 'Hold SPACE: paddle. Tap as your tail lifts',
    go: 'Sprint now: tap SPACE fast!',
    airborne: 'Pump (tap SPACE) to get clear',
    carve: 'Carve across the face: ← →',
  },
  touch: {
    float: 'Hold right: paddle. Tap as the tail lifts',
    go: 'Sprint now: tap fast!',
    airborne: 'Pump (tap right) to get clear',
    carve: 'Carve across the face: left thumb',
  },
  pad: {
    float: 'Hold A: paddle. Tap as your tail lifts',
    go: 'Sprint now: tap A fast!',
    airborne: 'Pump (tap A) to get clear',
    carve: 'Carve across the face: stick',
  },
}

// Lines that are the same on every device but for the control they name: [wide, narrow].
// {in} is "hold", "thumb" or "stick"; {lower} the direction for riding lower (the front
// foot); {turn} the direction that brings the board back downwind.

/** by why the wing breached: 0 over a crest, 1 the player is holding the back foot down */
const HIGH: [string, string][] = [
  ['Too high, the wing is breaching: front foot, {in} {lower}', 'Too high: front foot, {in} {lower}'],
  ['Too high, the wing is breaching: ease off the back foot', 'Too high: ease off the back foot'],
]
/** by why the board touched: 0 too slow to hold its height, 1 leaned over further than the height allows, 2 the player is holding the front foot down */
const LOW: [string, string][] = [
  ['Too low, the board is touching: pump for speed', 'Too low: pump for speed'],
  ['Too low for that lean, the rail is touching: ease off', 'Rail touching: ease the lean'],
  ['Too low, the board is touching: ease off the front foot', 'Too low: ease off the front foot'],
]
const TURN: [string, string] = ['Point the board downwind to paddle up: {in} {turn}', 'Point downwind: {in} {turn}']
/** (the bright tip is the quick stamina store, as the help card calls it) */
const REST: [string, string] = ['Out of breath: let go until the bright tip is back', 'Out of breath: wait for the bright tip']
const SHALLOW: [string, string] = ['Too shallow for the wing: paddle out to deeper water', 'Too shallow: paddle to deeper water']

/** why the flight ended: [wide, narrow] */
const COACH: Record<string, [string, string]> = {
  early: ['Dropped back in: a few more pumps right after lift-off', 'A few more pumps after lift-off'],
  tired: ['Out of breath: let the bumps carry you, pump only to link them', 'Out of breath: pump only to link bumps'],
  breach: ['Breached and lost the lift: ride lower as you come over a crest', 'Breached: ride lower over the crests'],
  turn: ['Stalled in the turn: turn sooner and shorter, while you still have speed', 'Stalled in the turn: turn sooner'],
  straight: ['Ran straight and outran the bump: carve across the face', 'Outran the bump: carve across the face'],
  back: ['Fell off the back of the bump: turn down the face sooner', 'Off the back: turn down the face sooner'],
  lost: ['Lost the bump: aim for the next face and pump across to it', 'Lost the bump: pump to the next face'],
  rail: ['Caught a rail: ease the lean when the board is riding low', 'Caught a rail: less lean when low'],
  hard: ['Came down hard: pump or turn down the face before it sinks', 'Came down hard: pump before it sinks'],
  aground: ['Ran aground: the wing found the sand. Stay out in the channel', 'Ran aground: stay in the channel'],
}

/**
 * Every line the prompt can show on a device, as [long wording, short wording], with the
 * directions filled in. Not used by the game: the layout checks measure these against the
 * room each screen size leaves (see writeLine for how the wording is chosen at run time).
 */
export function promptLines(device: Device): [string, string][] {
  const keys = device === 'keys'
  const fill = (t: string) => t
    .replace('{in}', keys ? 'hold' : device === 'touch' ? 'thumb' : 'stick')
    .replace('{lower}', keys ? '↑' : 'down')
    .replace('{turn}', keys ? '←' : 'right')
  const out: [string, string][] = []
  for (const k of ['float', 'go', 'airborne', 'carve'] as const) out.push([WORDS[device][k], WORDS_NARROW[device][k]])
  for (const pair of [...HIGH, ...LOW, TURN, REST, SHALLOW, ...Object.values(COACH)]) out.push([fill(pair[0]), fill(pair[1])])
  out.push(['Pump!', 'Pump!'])
  return out
}

function swapThumbs(text: string): string {
  return text.replace(/\b(left|right)\b/g, (m) => (m === 'left' ? 'right' : 'left'))
}

/**
 * Seconds a line is owed once it is up. Something to do now is taken in at a glance (and
 * must not outlive its reason by much): 1.5 s. Two sentences are two thoughts: 3 s. The
 * reason the last flight ended is read: by its length, 2 to 3 s.
 */
function owedTime(id: number, text: string): number {
  if (text.indexOf('. ') > 0) return 3
  if (id !== PR.COACH) return 1.5
  let words = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 32) words++
  return clamp(0.5 + 0.25 * words, 2, 3)
}

function heightWords(): string {
  return uiTuning.upIsFrontFoot
    ? 'up is the front foot (nose down, ride lower), down the back foot (ride higher)'
    : 'up to ride higher, down to ride lower'
}

function controlsHtml(device: Device): string {
  const row = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`
  const action = '<b>hold</b> to paddle or pump steadily, <b>tap</b> for a sprint stroke or a hard pump'
  if (device === 'touch') {
    const steer = uiTuning.swapSides ? 'Right thumb' : 'Left thumb'
    const pump = uiTuning.swapSides ? 'Left thumb' : 'Right thumb'
    return (
      row(steer, `slide anywhere: left and right to lean; ${heightWords()}`) +
      row(pump, action) +
      row('Top right', 'camera, sound, help, restart')
    )
  }
  if (device === 'pad') {
    return (
      row('Left stick', `left and right to lean; ${heightWords()}`) +
      row('A', action) +
      row('B · X · Y', 'restart, restart flying, camera')
    )
  }
  return (
    row('← →', 'lean (also A D)') +
    row('↑ ↓', uiTuning.upIsFrontFoot
      ? '<b>↑</b> front foot: nose down, ride lower · <b>↓</b> back foot: ride higher (also W S)'
      : '<b>↑</b> ride higher · <b>↓</b> ride lower (also W S)') +
    row('SPACE', `${action} (also J)`) +
    row('R · F', 'restart on the water, restart flying') +
    row('C · M · V', 'camera, sound, variometer beeps') +
    row('H · P', 'this card, tuning panel')
  )
}

function helpHtml(device: Device): string {
  return `
    <button type="button" class="hr-x" data-act="close" aria-label="Close" tabindex="-1">×</button>
    <div class="hr-card-body">
      <h1>The Hatchery, Hood River</h1>
      <p class="hr-lede">Wind against current stacks the river into slow, steep bumps. You are on a SUP foil. Ride them downwind.</p>
      <div class="hr-cols">
        <ol class="hr-ideas">
          <li><b>Paddle up on a bump.</b> Point downwind and cruise; sprint as the next bump lifts your tail. Out of breath? Let go and wait.</li>
          <li><b>Carve across the face.</b> Run straight and you outrun the bump. Turn along it and keep the bar green.</li>
          <li><b>Pump only to link bumps.</b> Legs run out fast: a few pumps to reach the next face, then glide.</li>
        </ol>
        <dl class="hr-keys">${controlsHtml(device)}</dl>
      </div>
      <p class="hr-legend"><b class="hr-good">Green bar</b>: the bump is feeding you. <b class="hr-bad">Red</b>: it is costing you.
        ${device === 'touch' ? 'Tap the bar' : 'Press V'} to hear it.
        <b class="hr-warn">Amber</b> mast gauge: the wing is near the surface or the board near the water.
        Stamina: the bright tip is your sprint. It takes about half a minute to come back, and only while you rest; the rest of the bar takes minutes.</p>
      <p class="hr-rotate">Turn the phone on its side for a wider view of the bumps.</p>
    </div>
    <div class="hr-actions">
      <span class="hr-wait">Building the river…</span>
      <div class="hr-rider" role="group" aria-label="Rider">
        <button type="button" data-rider="man" aria-pressed="false" tabindex="-1">Man</button>
        <button type="button" data-rider="woman" aria-pressed="false" tabindex="-1">Woman</button>
      </div>
      <button type="button" class="hr-go" data-act="paddle" tabindex="-1">Start on the water</button>
      <button type="button" data-act="foil" tabindex="-1">Start flying (practice)</button>
      ${canFullscreen() ? '<button type="button" data-act="full" tabindex="-1">Full screen</button>' : ''}
    </div>`
}

type FsDocument = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void }

function canFullscreen(): boolean {
  const d = document as FsDocument
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled)
}

/** Full screen and, where the browser allows it (Android), held on its side. */
function toggleFullscreen(): void {
  const d = document as FsDocument
  const root = document.documentElement as FsElement
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) void d.exitFullscreen()
      else d.webkitExitFullscreen?.()
      return
    }
    const entered = root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : Promise.resolve(root.webkitRequestFullscreen?.())
    const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined
    entered.then(() => orientation?.lock?.('landscape')).catch(() => { /* not allowed here: fine */ })
  } catch { /* not allowed here: fine */ }
}

export function create(app: App): FeatureModule {
  if (!uiVisible(app)) return { update() {} }
  prepareUiRoot(app)

  const query = app.options.query
  const scripted = app.options.scenario !== ''
  if (query.get('fps') === '1') ui.showFps = true
  /** ?prompts=off|learn|always: the coaching level for this visit, whatever the saved knob says */
  const forcedLevel = PROMPT_LEVELS[query.get('prompts') ?? ''] ?? -1

  // -------------------------------------------------------------------------------------
  // elements
  // -------------------------------------------------------------------------------------
  const root = el('div', 'hr-hud')

  const cluster = el('div', 'hr-cluster')
  const gauge = el('div', 'hr-gauge')
  const foil = el('div', 'hr-foil')
  const mast = el('i', 'hr-mast')
  const board = el('i', 'hr-board')
  const wing = el('i', 'hr-wing')
  foil.append(mast, wing, board)
  gauge.append(el('i', 'hr-gauge-water'), foil, el('i', 'hr-gauge-line'))

  const speedBox = el('div', 'hr-speedbox')
  const speedRow = el('div', 'hr-speed')
  const speedNum = el('span', 'hr-num', '0.0')
  const speedUnit = el('span', 'hr-unit')
  const speedCap = el('span', 'hr-cap')
  speedUnit.append(el('b', undefined, 'kn'), speedCap)
  speedRow.append(speedNum, speedUnit)
  const stam = el('div', 'hr-stam')
  const stamSlow = el('i', 'hr-stam-slow')
  const stamFast = el('i', 'hr-stam-fast')
  const stamNotch = el('i', 'hr-stam-notch')
  stam.append(stamSlow, stamFast, stamNotch)
  speedBox.append(speedRow, stam)
  cluster.append(gauge, speedBox)

  const top = el('div', 'hr-top')
  const vario = el('div', 'hr-vario')
  const varioTrack = el('div', 'hr-vario-track')
  const varioNeg = el('i', 'hr-vario-neg')
  const varioPos = el('i', 'hr-vario-pos')
  varioTrack.append(varioNeg, varioPos, el('i', 'hr-vario-zero'))
  const varioVal = el('span', 'hr-vario-val', '0 W')
  vario.append(el('span', 'hr-vario-lab', 'bump'), varioTrack, varioVal)
  const prompt = el('div', 'hr-prompt')
  top.append(vario, prompt)

  const session = el('div', 'hr-session')
  const fps = el('div', 'hr-fps')

  root.append(cluster, top, session, fps)

  const help = el('div', 'hr-help')
  help.dataset.hrUi = ''
  const card = el('div', 'hr-card is-booting')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'How to ride')
  help.appendChild(card)

  const host = uiRoot()
  host.append(root, help)

  // -------------------------------------------------------------------------------------
  // state between refreshes
  // -------------------------------------------------------------------------------------
  /** false until the first frame: the river is still being built */
  let live = false
  let acc = HUD_DT
  let textAcc = TEXT_DT
  let speedSm = app.view.speed
  let varioSm = 0
  let evAcc = 0

  // what the player has already shown they can do (prompts retire on these)
  let playerTakeoffs = 0
  let clearPumps = 0
  let pumpedThisFlight = false
  let carvedLeft = false
  let carvedRight = false
  let highSeen = 0
  let lowSeen = 0
  let wasBreached = false
  let wasTouching = false
  let stallTicks = 0
  /** seconds since the rider last started a pump or a paddle stroke (the gaps between held ones are shorter than a HUD tick) */
  let pumpAge = 10
  let strokeAge = 10

  // conditions held a little past the instant they were true, so their lines can be read
  /** sprint cue: ticks left (it outlasts the face by 0.4 s) */
  let goTicks = 0
  /** the quick store is low: the line between cues says to rest (with a little hysteresis) */
  let resting = false
  /** the floating board points too far off downwind to paddle up: -1 turn left, +1 turn right, 0 fine */
  let turnDir = 0
  /** breach / touchdown: ticks left of the second each is held after its flag clears, and why it happened (see HIGH and LOW) */
  let highLatch = 0
  let lowLatch = 0
  let highWhy = 0
  let lowWhy = 0
  /** seconds since the player last started an all-out paddle stroke */
  let sprintAge = 10
  /** "pump to get clear" is owed from lift-off until the wing has speed to spare */
  let airborne = false

  // the last seconds of the flight, for the coach line
  const hHeading = new Float32Array(HIST)
  const hBank = new Float32Array(HIST)
  /** 1 breached, 2 stalled */
  const hFlags = new Uint8Array(HIST)
  let hHead = 0
  let hCount = 0
  let flightTime = 0
  /** the flight began with a paddle-up (not with a practice start already flying) */
  let fromTakeoff = false
  let coach = ''
  let coachLeft = 0

  let toastText = ''
  let toastLeft = 0
  let toastSerial = 0

  // the prompt scheduler: the line that is up, for how long, and how long it is owed
  let shown: number = PR.NONE
  let shownAge = 0
  let shownMin = 0
  /** not even the sprint cue or "Pump!" may cut the line short */
  let shownGuard = false
  /** the scheduler's clock (s), and when each line was last up for as long as it was owed */
  let clock = 0
  const readAt = new Float32Array(PR_NAME.length).fill(-1e6)
  /** seconds since the sprint cue was last up */
  let sinceCue = 10
  /** the line the situation called for at the last refresh, and for how many refreshes running */
  let wantPrev: number = PR.NONE
  let wantRun = 0
  /** what the wording of the line that is up depends on (device, thumbs, feet, width, toast) */
  let wordKey = -1

  // The sprint cue is the scripted pilot's own face test, so the two cannot drift apart.
  function faceToSprint(): boolean {
    return paddleFace(app.view, app.sim.waves)
  }

  /** How far the crest coming up behind the board stands above it (m), looking back one wavelength. */
  function crestBehind(): number {
    const s = app.view
    const W = app.sim.waves
    const step = clamp((2 * Math.PI) / Math.max(0.05, W.kp), 8, 32) / 8
    const fx = Math.cos(s.heading) * step, fz = Math.sin(s.heading) * step
    const here = W.height(s.x, s.z, app.time)
    let top = -1
    for (let i = 1; i <= 7; i++) {
      const h = W.height(s.x - fx * i, s.z - fz * i, app.time) - here
      if (h > top) top = h
    }
    return top
  }

  // last values written to the DOM
  let cSpeed = -1, cSpeedCls = -1, cCap = -1
  let cSlow = -1, cFast = -1, cStamCls = -1, cNotch = -1
  let cDepth = 1e9, cBank = 1e9, cGaugeCls = -1
  let cMast = -1, cSpan = -1, cBoardW = -1
  let cVario = 1e9, cWatts = 1e9, cVarioSign = 0, cVarioShown = true
  let cPromptText = '', cPromptStyle = 0, cPromptOn = false, cPromptSmall = false
  let cSec = -1, cDist = -1, cTakeoffs = -1, cNarrow = -1, cGlide = -1
  let cFpsOn = false
  let fpsFrames = 0, fpsTime = 0

  const SPEED_CLS = ['', 'is-slow', 'is-stall']
  const GAUGE_CLS = ['', 'is-high', 'is-low', 'is-breach', 'is-touch']
  const STAM_CLS = ['', 'is-low', 'is-empty']
  const PROMPT_CLS = ['', 'is-urgent', 'is-go', 'is-rest']

  // -------------------------------------------------------------------------------------
  // help card
  // -------------------------------------------------------------------------------------
  let helpKey = ''
  function fillHelp() {
    const key = `${ui.device}/${uiTuning.swapSides}/${uiTuning.upIsFrontFoot}`
    if (key === helpKey) return
    helpKey = key
    card.innerHTML = helpHtml(ui.device)
    syncRider()
  }
  /** the figure the rider module shows (hr:rider-changed), lit on the card's toggle */
  let riderNow = ''
  function syncRider() {
    for (const b of card.querySelectorAll('[data-rider]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-rider') === riderNow))
  }
  function onRiderChanged(e: Event) {
    riderNow = String((e as CustomEvent).detail ?? '')
    syncRider()
  }
  function setHelp(open: boolean) {
    if (open === ui.helpOpen) return
    ui.helpOpen = open
    if (open) fillHelp()
    else store.set(HELP_SEEN, '1')
    help.classList.toggle('is-open', open)
  }
  function onHelp() { setHelp(!ui.helpOpen) }
  function onHelpClick(e: MouseEvent) {
    const t = e.target as HTMLElement
    // the rider toggle picks a figure and leaves the card open
    const rider = t.closest('[data-rider]')?.getAttribute('data-rider')
    if (rider) {
      emit('hr:rider', rider)
      if (t instanceof HTMLButtonElement) t.blur()
      return
    }
    const act = t.closest('[data-act]')?.getAttribute('data-act')
    if (act === 'full') {
      toggleFullscreen()
      if (t instanceof HTMLButtonElement) t.blur()
    } else if (act) {
      setHelp(false)
      // (the start buttons are not on the card until the river is built)
      if (act === 'paddle') app.restart('paddle')
      else if (act === 'foil') app.restart('foil')
      if (t instanceof HTMLButtonElement) t.blur()
    } else if (t === help) {
      setHelp(false)
    }
  }
  help.addEventListener('click', onHelpClick)
  window.addEventListener('hr:help', onHelp)
  // first run: show the card, except in captures and demos (?help=1 forces it, ?help=0 hides it)
  const helpFlag = query.get('help')
  if (helpFlag === '1' || (helpFlag !== '0' && !app.options.capture && !scripted && !store.get(HELP_SEEN))) setHelp(true)

  // -------------------------------------------------------------------------------------
  // messages from other modules
  // -------------------------------------------------------------------------------------
  function say(text: string, seconds: number) {
    toastText = text
    toastLeft = text ? seconds : 0
    toastSerial++
    acc = HUD_DT
  }
  function onToast(e: Event) { say(String((e as CustomEvent).detail ?? ''), 2.2) }
  // the camera module announces its mode; say it, so C and the camera button give an answer
  function onCamera(e: Event) {
    const name = String((e as CustomEvent).detail ?? '')
    if (name) say(`Camera: ${name}`, 1.6)
  }
  function onVarioTap() { emit('hr:vario') }
  window.addEventListener('hr:toast', onToast)
  window.addEventListener('hr:camera-changed', onCamera)
  window.addEventListener('hr:rider-changed', onRiderChanged)
  // a tap on the variometer switches the audible one (the sound module answers with a toast)
  vario.dataset.hrUi = ''
  vario.addEventListener('click', onVarioTap)

  // -------------------------------------------------------------------------------------
  // pieces of the refresh
  // -------------------------------------------------------------------------------------
  function swapClass(node: HTMLElement, list: string[], from: number, to: number) {
    if (from > 0) node.classList.remove(list[from])
    if (to > 0) node.classList.add(list[to])
  }

  function layoutGauge() {
    const F = app.sim.P.foil
    if (F.mastLength === cMast && F.span === cSpan && F.boardWidth === cBoardW) return
    cMast = F.mastLength
    cSpan = F.span
    cBoardW = F.boardWidth
    const L = F.mastLength * EM_PER_M
    const span = F.span * EM_PER_M
    const bw = Math.max(0.45, F.boardWidth * EM_PER_M)
    mast.style.height = `${L.toFixed(3)}em`
    wing.style.width = `${span.toFixed(3)}em`
    wing.style.left = `${(-span / 2).toFixed(3)}em`
    board.style.width = `${bw.toFixed(3)}em`
    board.style.left = `${(-bw / 2).toFixed(3)}em`
    board.style.bottom = `${L.toFixed(3)}em`
  }

  /** Why did the flight end? Looks at the last three seconds on foil. Returns a key of COACH. */
  function diagnose(crashed: boolean): string {
    const s = app.view
    const P = app.sim.P
    const n = Math.min(hCount, 30)
    let meanHeading = 0
    let maxBank = 0
    let lastBank = 0
    let breach = false
    let turnStall = false
    for (let i = 1; i <= n; i++) {
      const j = (hHead - i + HIST) % HIST
      const bank = Math.abs(hBank[j])
      meanHeading += Math.abs(hHeading[j])
      if (bank > maxBank) maxBank = bank
      if (i <= 5 && bank > lastBank) lastBank = bank
      if (i <= 25 && hFlags[j] & 1) breach = true
      if (i <= 20 && hFlags[j] & 2 && bank > 0.3) turnStall = true
    }
    if (n > 0) meanHeading /= n
    if (crashed) {
      // the simulation says what happened; the measurements stand in where it does not
      if (s.cause === 'bottom' || LEVEL.waterDepth(s.x - app.groundShift, s.z) < 1.2) return 'aground'
      if (s.cause === 'rail' || (s.cause !== 'hard' && lastBank > 0.85 * P.crash.railBankDeg / DEG)) return 'rail'
      return breach ? 'breach' : 'hard'
    }
    if (fromTakeoff && flightTime < 4) return 'early'
    if (s.stamina < 0.08) return 'tired'
    if (breach) return 'breach'
    if (turnStall) return 'turn'
    if (n >= 10 && meanHeading < 0.3 && maxBank < 0.25) return 'straight'
    // nose-up water under the board: it slid off the back of the bump
    const along = s.slopeX * Math.cos(s.heading) + s.slopeZ * Math.sin(s.heading)
    return along > 0.03 ? 'back' : 'lost'
  }

  /** the words of a line, long (0) or short (1) */
  function lineText(id: number, narrow: 0 | 1): string {
    if (id === PR.TOAST) return toastText
    if (id === PR.COACH) return COACH[coach][narrow]
    if (id === PR.REST) return REST[narrow]
    if (id === PR.SHALLOW) return SHALLOW[narrow]
    if (id === PR.STALL) return 'Pump!'
    if (id === PR.HIGH || id === PR.LOW || id === PR.TURN) {
      const keys = ui.device === 'keys'
      const up = keys ? '↑' : 'up'
      const down = keys ? '↓' : 'down'
      return (id === PR.HIGH ? HIGH[highWhy][narrow] : id === PR.LOW ? LOW[lowWhy][narrow] : TURN[narrow])
        .replace('{in}', keys ? 'hold' : ui.device === 'touch' ? 'thumb' : 'stick')
        .replace('{lower}', uiTuning.upIsFrontFoot ? up : down)
        .replace('{turn}', turnDir < 0 ? (keys ? '←' : 'left') : keys ? '→' : 'right')
    }
    const w = (narrow ? WORDS_NARROW : WORDS)[ui.device]
    const text = id === PR.FLOAT ? w.float : id === PR.GO ? w.go : id === PR.AIRBORNE ? w.airborne : id === PR.CARVE ? w.carve : ''
    // (these name a side of the screen; the directions above are not swapped with the thumbs)
    return ui.device === 'touch' && uiTuning.swapSides ? swapThumbs(text) : text
  }

  /**
   * Put a line on the screen in the longest wording that fits the room the layout leaves
   * (which depends on the viewport, the safe areas and the font, so it is measured): the
   * long wording, else the short one, else the short one a size smaller. Runs only when
   * the line or what its wording depends on changes.
   */
  function writeLine(id: number): string {
    const style = PR_STYLE[id]
    if (style !== cPromptStyle) {
      swapClass(prompt, PROMPT_CLS, cPromptStyle, style)
      cPromptStyle = style
    }
    let text = lineText(id, 0)
    let small = false
    if (cPromptSmall) prompt.classList.remove('is-small')
    if (text !== cPromptText) prompt.textContent = text
    if (prompt.scrollWidth > prompt.clientWidth + 1) {
      const short = lineText(id, 1)
      if (short !== text) {
        text = short
        prompt.textContent = text
      }
      small = prompt.scrollWidth > prompt.clientWidth + 1
    }
    if (small) prompt.classList.add('is-small')
    cPromptSmall = small
    cPromptText = text
    prompt.dataset.pr = PR_NAME[id]
    return text
  }

  function refresh() {
    const s = app.view
    const P = app.sim.P
    const D = app.sim.D
    const foiling = s.mode === 'foil'
    const upright = app.width < 620 ? 1 : 0
    textAcc += HUD_DT
    const textNow = textAcc >= TEXT_DT - 1e-6
    if (textNow) textAcc -= TEXT_DT

    // ---- speed ----
    if (textNow) {
      const sp = Math.round(speedSm * KNOTS * 10)
      if (sp !== cSpeed) {
        cSpeed = sp
        speedNum.textContent = (sp / 10).toFixed(1)
      }
    }
    // the stall speed rises with the load: a carve at 1.4 g stalls 18 % faster than a glide
    const stallNow = D.vStall * Math.sqrt(Math.max(1, s.gLoad))
    const speedCls = foiling ? (s.stalled ? 2 : s.speed < 1.07 * stallNow ? 1 : 0) : 0
    if (speedCls !== cSpeedCls) {
      swapClass(speedNum, SPEED_CLS, cSpeedCls, speedCls)
      cSpeedCls = speedCls
    }
    // the number to beat: the stall speed when flying, the lift-off speed when floating
    const capV = Math.round((foiling ? D.vStall : D.vStall * P.paddle.takeoffSpeed) * KNOTS * 10)
    const capKey = capV * 2 + (foiling ? 1 : 0)
    if (capKey !== cCap) {
      cCap = capKey
      speedCap.textContent = `${foiling ? 'stall' : 'flies'} ${(capV / 10).toFixed(1)}`
    }

    // ---- stamina: slow store from the left, the quick store stacked on its end ----
    const reserve = Math.max(1, P.stamina.reserve)
    const slow = Math.round(clamp(s._slow / reserve, 0, 1) * 400)
    const fast = Math.round(clamp(s._fast / reserve, 0, 1) * 400)
    if (slow !== cSlow || fast !== cFast) {
      if (slow !== cSlow) stamSlow.style.transform = `scaleX(${slow / 400})`
      stamFast.style.transform = `translateX(${slow / 4}%) scaleX(${fast / 400})`
      cSlow = slow
      cFast = fast
    }
    const share = clamp(P.stamina.fastShare, 0, 1)
    if (share !== cNotch) {
      cNotch = share
      stamNotch.style.left = `${((1 - share) * 100).toFixed(1)}%`
    }
    const capSlow = Math.max(1, reserve * (1 - share))
    const stamCls = s.stamina < 0.04 ? 2 : s._slow / capSlow < 0.25 ? 1 : 0
    if (stamCls !== cStamCls) {
      swapClass(stam, STAM_CLS, cStamCls, stamCls)
      cStamCls = stamCls
    }

    // ---- mast gauge ----
    layoutGauge()
    const depth = Math.round(clamp(s.depth, -0.2, P.foil.mastLength + 0.12) * 200)
    const bank = Math.round(s.bank * DEG * 2)
    if (depth !== cDepth || bank !== cBank) {
      cDepth = depth
      cBank = bank
      foil.style.transform = `translateY(${((depth / 200) * EM_PER_M).toFixed(3)}em) rotate(${bank / 2}deg)`
    }
    let gaugeCls = 0
    if (foiling) {
      if (s.breached) gaugeCls = 3
      // the hull is still in the water for a moment after lift-off: low, not a touchdown
      else if (s.touching) gaugeCls = s.modeTime > 1.5 ? 4 : 2
      // a hard carve skims both the high tip and the low rail by design (the reflex leaves
      // 4 cm and 10 cm): amber only once it is closer than that
      else if (s.depth < 0.12 || s.tipOut > 0.05) gaugeCls = 1
      else if (s.rideHeight < 0.06) gaugeCls = 2
    }
    if (gaugeCls !== cGaugeCls) {
      swapClass(gauge, GAUGE_CLS, cGaugeCls, gaugeCls)
      cGaugeCls = gaugeCls
    }

    // ---- variometer ----
    if (uiTuning.showVario !== cVarioShown) {
      cVarioShown = uiTuning.showVario
      vario.classList.toggle('is-off', !cVarioShown)
    }
    const v = Math.round(Math.tanh((VARIO_K * varioSm) / Math.max(50, uiTuning.varioScale)) * 100)
    if (v !== cVario) {
      if (v >= 0) {
        varioPos.style.transform = `scaleX(${v / 100})`
        if (cVario < 0) varioNeg.style.transform = 'scaleX(0)'
      } else {
        varioNeg.style.transform = `scaleX(${-v / 100})`
        if (cVario >= 0) varioPos.style.transform = 'scaleX(0)'
      }
      cVario = v
    }
    if (textNow) {
      const watts = Math.round(varioSm / 50) * 50
      if (watts !== cWatts) {
        cWatts = watts
        varioVal.textContent = `${watts > 0 ? '+' : watts < 0 ? '−' : ''}${Math.abs(watts)} W`
        const sign = watts > 0 ? 1 : watts < 0 ? -1 : 0
        if (sign !== cVarioSign) {
          cVarioSign = sign
          vario.classList.toggle('is-pos', sign > 0)
          vario.classList.toggle('is-neg', sign < 0)
        }
      }
    }

    // ---- what just happened, and what the player has shown they can do ----
    const level = forcedLevel >= 0 ? forcedLevel : clamp(Math.round(uiTuning.prompts), 0, 2)
    const ev = evAcc
    evAcc = 0
    pumpAge = ev & EV.PUMP ? 0 : pumpAge + HUD_DT
    strokeAge = ev & EV.STROKE ? 0 : strokeAge + HUD_DT
    // (a cruise stroke runs at about half effort, an all-out one at whatever the rider has left)
    sprintAge = ev & EV.STROKE && s.effort > 0.62 ? 0 : sprintAge + HUD_DT
    if (ev & EV.TAKEOFF) {
      hCount = 0
      fromTakeoff = true
    }
    if (!scripted) {
      if (ev & EV.TAKEOFF) {
        playerTakeoffs++
        pumpedThisFlight = false
        coachLeft = 0
        airborne = level === 2 || clearPumps < 2
      }
      if (ev & (EV.OFF_FOIL | EV.CRASH)) {
        coach = diagnose((ev & EV.CRASH) !== 0)
        coachLeft = 5
        readAt[PR.COACH] = -1e6
      }
      if (foiling) {
        if (ev & EV.PUMP && !pumpedThisFlight && s.modeTime < 6) {
          pumpedThisFlight = true
          clearPumps++
        }
        // a real lean, or a track well off downwind (a slow wing cannot bank far)
        if (s.bank > 0.3 || (s.heading > 0.5 && s.heading < 2.6)) carvedRight = true
        else if (s.bank < -0.3 || (s.heading < -0.5 && s.heading > -2.6)) carvedLeft = true
        if (s.breached && !wasBreached) highSeen++
        if (s.touching && !wasTouching && s.modeTime > 1.5) lowSeen++
      }
      wasBreached = s.breached
      wasTouching = s.touching
    }
    if (foiling) {
      hHeading[hHead] = s.heading
      hBank[hHead] = s.bank
      hFlags[hHead] = (s.breached ? 1 : 0) | (s.stalled ? 2 : 0)
      hHead = (hHead + 1) % HIST
      if (hCount < HIST) hCount++
      flightTime = s.modeTime
    }
    if (coachLeft > 0) coachLeft -= HUD_DT

    // ---- prompt: which line does the situation call for? ----
    let want: number = PR.NONE
    stallTicks = foiling && s.stalled ? stallTicks + 1 : 0
    const quiet = scripted || ui.helpOpen || level === 0
    if (!foiling) {
      highLatch = 0
      lowLatch = 0
      airborne = false
    }
    if (toastLeft > 0) {
      want = PR.TOAST
    } else if (quiet) {
      goTicks = 0
    } else if (s.mode === 'swim') {
      goTicks = 0
      if (coachLeft > 0) want = PR.COACH
    } else if (s.mode === 'paddle') {
      // q: how much of the sprint is there (the bright tip of the stamina bar)
      const q = s._fast / Math.max(1, reserve * share)
      // coach the paddle-up for the first three take-offs, and again anyone stuck on the water
      // (three bumps have gone by)
      const teach = level === 2 || playerTakeoffs < 3 || s.modeTime > STUCK
      // which way the board points against the way the bumps travel
      let off = s.heading - P.waves.dirDeg / DEG
      off -= 2 * Math.PI * Math.round(off / (2 * Math.PI))
      if (Math.abs(off) > TURN_ON) turnDir = off > 0 ? -1 : 1
      else if (Math.abs(off) < TURN_OFF) turnDir = 0
      const blocked = s.aground || turnDir !== 0
      const face = teach && !blocked && s.modeTime > 0.4 && faceToSprint()
      if (goTicks > 0) {
        // lit: it stays for as long as the face does (and 0.4 s more), while there is breath
        goTicks = blocked || q < uiTuning.cueKeep ? 0 : face ? 4 : goTicks - 1
      } else if (face && q >= uiTuning.cueStart) {
        // Is this bump worth the sprint? The board has to fall about h0 down a face to get
        // from sprinting speed (3 m/s on flat water) to flying speed. A full tip of stamina
        // makes up for a small bump; with less, only a bigger one will do. (Measured with
        // the cue-following bot: as many take-offs, a third fewer wasted sprints, and far
        // fewer on a small wing or a marginal day.)
        const vTo = D.vStall * P.paddle.takeoffSpeed
        const h0 = Math.max(0.2, (vTo * vTo - 9) / (2 * G))
        if (crestBehind() >= uiTuning.cueBump * h0 * (1 - q)) goTicks = 4
      }
      if (q < uiTuning.restBelow) resting = true
      else if (q >= uiTuning.restBelow + 0.05) resting = false
      // the opening line comes first: no sprint cue until it has been up long enough to read
      const opening = (level === 2 || playerTakeoffs < 1) && readAt[PR.FLOAT] < 0 && !blocked && !resting && coachLeft <= 0
      if (opening) {
        want = PR.FLOAT
      } else if (goTicks > 0 && (face || shown === PR.GO)) {
        // (the cue may outlast the face, but it never starts on what is left of one)
        want = PR.GO
      } else if (coachLeft > 0) {
        want = PR.COACH
      } else if (s.aground) {
        want = PR.SHALLOW
      } else if (turnDir !== 0) {
        // for a learner, and for anyone sprinting across the wind (turning costs no breath,
        // so it comes before the advice to rest)
        if (teach || sprintAge < 2) want = PR.TURN
      } else if (resting) {
        // always for a learner; for anyone else only while they are spending strokes on nothing
        if (teach || (strokeAge < 1.5 && q < uiTuning.cueStart)) want = PR.REST
      } else if ((level === 2 || playerTakeoffs < 1 || s.modeTime > STUCK) && sinceCue >= 1.5) {
        // (between two faces in quick succession the line stays empty rather than flash this)
        want = PR.FLOAT
      }
    } else {
      goTicks = 0
      // pitchSmooth is the player's height input as the simulation takes it: + = back foot
      // (the reason is settled when the trouble starts and stays while its line is up; a
      // new reason is a new line to read)
      if (s.breached) {
        if (highLatch === 0 && shown !== PR.HIGH) {
          const why = s.pitchSmooth > 0.3 ? 1 : 0
          if (why !== highWhy) readAt[PR.HIGH] = -1e6
          highWhy = why
        }
        highLatch = 10
      } else if (highLatch > 0) highLatch--
      if (s.touching && s.modeTime > 1.5) {
        if (lowLatch === 0 && shown !== PR.LOW) {
          const why = s.pitchSmooth < -0.3 ? 2 : Math.abs(s.bank) > 0.42 ? 1 : 0
          if (why !== lowWhy) readAt[PR.LOW] = -1e6
          lowWhy = why
        }
        lowLatch = 10
      } else if (lowLatch > 0) lowLatch--
      // owed until the wing has speed to spare, however hard the player is already pumping
      if (airborne && (s.speed >= 1.3 * D.vStall || s.modeTime > 6)) airborne = false
      if (airborne) want = PR.AIRBORNE
      else if (stallTicks >= 2 && pumpAge >= 0.9 && s.stamina > 0.03) want = PR.STALL
      else if (highLatch > 0 && (level === 2 || highSeen <= 3)) want = PR.HIGH
      else if (lowLatch > 0 && (level === 2 || lowSeen <= 3)) want = PR.LOW
      else if ((level === 2 || !(carvedLeft && carvedRight)) && s.modeTime > 4 && s.modeTime < 16) want = PR.CARVE
    }

    // ---- prompt: the scheduler. A line that is up stays long enough to be read ----
    clock += HUD_DT
    if (shown === PR.GO) sinceCue = 0
    else if (sinceCue < 10) sinceCue += HUD_DT
    if (shown !== PR.NONE) {
      shownAge += HUD_DT
      if (shownAge >= shownMin - 1e-6) readAt[shown] = clock
    }
    wantRun = want === wantPrev ? wantRun + 1 : 1
    wantPrev = want
    let next = shown
    if (want !== shown) {
      const ctx = PR_CTX[shown]
      // its situation is over (took off, fell in, the help card opened): nothing is owed
      const stale = (ctx !== 0 && ctx !== (foiling ? 2 : 1)) || (quiet && shown !== PR.TOAST)
      const owed = shown !== PR.NONE && !stale && shownAge < shownMin - 1e-6
      const urgent = want === PR.GO || want === PR.STALL
      // A toast answers a key press: at once, whatever is up. Only the sprint cue and
      // "Pump!" may cut another line short, and not the opening line or the reason the
      // last flight ended. Any other line waits for the one that is up to have had its
      // time, and for its own situation to have lasted a moment (PR_WAIT), so that
      // nothing flashes up only to be replaced; the line is empty meanwhile.
      if (want === PR.TOAST) next = want
      else if (owed) { if (urgent && !shownGuard) next = want }
      else next = wantRun >= (want === PR.FLOAT && readAt[PR.FLOAT] < 0 ? 0 : PR_WAIT[want]) ? want : PR.NONE
    }
    // everything the wording of that line depends on, as one number
    const key = next === PR.NONE ? -1
      : (ui.device === 'keys' ? 0 : ui.device === 'touch' ? 1 : 2) + (uiTuning.swapSides ? 4 : 0) + (uiTuning.upIsFrontFoot ? 8 : 0)
        + (next === PR.TURN && turnDir > 0 ? 16 : 0) + 32 * (next === PR.TOAST ? toastSerial % 2048 : 0) + 65536 * Math.round(app.width)
        + (next === PR.HIGH ? 16 * highWhy : next === PR.LOW ? 16 * lowWhy : 0)
    if (next !== shown || (next !== PR.NONE && key !== wordKey)) {
      const fresh = next !== shown
      shown = next
      wordKey = key
      if (next !== PR.NONE) {
        const text = writeLine(next)
        if (fresh || next === PR.TOAST) {
          // a line that was read a moment ago and comes back (after a sprint cue, say) is
          // owed only long enough not to flash, and anything urgent may replace it
          const again = next !== PR.TOAST && clock - readAt[next] < 8
          shownAge = 0
          shownMin = next === PR.TOAST ? toastLeft : next === PR.GO ? 0 : again ? 0.8 : owedTime(next, text)
          shownGuard = next === PR.TOAST || (!again && (next === PR.COACH || next === PR.FLOAT))
        }
      }
    }
    const on = shown !== PR.NONE
    if (on !== cPromptOn) {
      // the words stay while the line fades out; the next prompt rewrites them
      cPromptOn = on
      prompt.classList.toggle('is-on', on)
      if (!on) prompt.dataset.pr = ''
    }

    // ---- session ----
    const sec = Math.floor(s.foilTime)
    const metres = Math.max(0, s.foilDistance)
    const dist = metres < 1000 ? Math.round(metres / 5) * 5 : Math.round(metres / 10) * 10
    const glide = s.longestGlide >= 5 ? Math.floor(s.longestGlide) : 0
    if (sec !== cSec || dist !== cDist || s.takeoffs !== cTakeoffs || upright !== cNarrow || glide !== cGlide) {
      cSec = sec
      cDist = dist
      cTakeoffs = s.takeoffs
      cNarrow = upright
      cGlide = glide
      if (sec === 0 && dist === 0 && s.takeoffs === 0) {
        session.textContent = ''
      } else {
        const time = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
        const far = dist < 1000 ? `${dist} m` : `${(dist / 1000).toFixed(2)} km`
        const n = `${s.takeoffs} take-off${s.takeoffs === 1 ? '' : 's'}`
        session.textContent = upright
          ? `foil ${time} · ${far} · ${n}`
          : `on foil ${time} · ${far} downwind · ${n}${glide ? ` · longest glide ${glide} s` : ''}`
      }
    }

    // ---- help card wording follows the device in use ----
    if (ui.helpOpen) fillHelp()
  }

  function refreshFps() {
    const info = app.renderer.info.render
    const rate = fpsTime > 0 ? Math.round(fpsFrames / fpsTime) : 0
    const q = app.quality
    fps.textContent =
      `${rate} fps · ${info.calls} calls · ${Math.round(info.triangles / 1000)}k tris · ` +
      `${q.tier} ${app.pixelRatio.toFixed(2)}x · ${Math.round(app.width * app.pixelRatio)}×${Math.round(app.height * app.pixelRatio)}`
    fpsFrames = 0
    fpsTime = 0
  }

  return {
    update(dt) {
      if (!live) {
        // the first frame: the river is built, the HUD may show and the card may start a run
        live = true
        markUiReady()
        card.classList.remove('is-booting')
      }
      const s = app.view
      // smoothing every frame (plain arithmetic); the DOM only at 10 Hz
      speedSm += (s.speed - speedSm) * (1 - Math.exp(-dt / 0.2))
      const net = s.powerWave + s.powerDrag + s.powerAero
      varioSm += (net - varioSm) * (1 - Math.exp(-dt / Math.max(0.02, uiTuning.varioTau)))
      evAcc |= app.events
      if (toastLeft > 0) toastLeft -= dt

      if (ui.showFps !== cFpsOn) {
        cFpsOn = ui.showFps
        fps.classList.toggle('is-on', cFpsOn)
        fpsTime = 0
        fpsFrames = 0
      }
      if (cFpsOn) {
        fpsFrames++
        fpsTime += dt
        if (fpsTime >= 0.5) refreshFps()
      }

      acc += dt
      if (acc < HUD_DT) return
      acc = acc >= 2 * HUD_DT ? 0 : acc - HUD_DT
      refresh()
    },

    resize() {
      // the room for the prompt line changed: fit its wording again at the next refresh
      wordKey = -1
      acc = HUD_DT
    },

    reset() {
      speedSm = app.view.speed
      varioSm = 0
      stallTicks = 0
      goTicks = 0
      resting = false
      turnDir = 0
      highLatch = 0
      lowLatch = 0
      airborne = false
      pumpAge = 10
      strokeAge = 10
      sprintAge = 10
      pumpedThisFlight = false
      wasBreached = false
      wasTouching = false
      hCount = 0
      fromTakeoff = false
      coachLeft = 0
      evAcc = 0
      // a restart is a new situation: the line that was up goes at once, and the next
      // refresh decides afresh what belongs there
      if (shown !== PR.TOAST) {
        shown = PR.NONE
        wordKey = -1
        wantPrev = PR.NONE
        wantRun = 0
        if (cPromptOn) {
          cPromptOn = false
          prompt.classList.remove('is-on')
          prompt.dataset.pr = ''
        }
      }
      sinceCue = 10
      acc = HUD_DT
      textAcc = TEXT_DT
    },

    dispose() {
      window.removeEventListener('hr:help', onHelp)
      window.removeEventListener('hr:toast', onToast)
      window.removeEventListener('hr:camera-changed', onCamera)
      window.removeEventListener('hr:rider-changed', onRiderChanged)
      ui.helpOpen = false
      root.remove()
      help.remove()
    },
  }
}
