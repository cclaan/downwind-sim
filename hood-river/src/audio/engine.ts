/**
 * The sound engine: one fixed graph of looped noise, band filters and a few oscillators,
 * built once on an AudioContext (or an OfflineAudioContext, see ./offline.ts) and then
 * steered every frame from the rider state. Nothing is created per event or per frame:
 * continuous sounds follow the state through setTargetAtTime, one-shots are envelopes
 * scheduled on gains that already exist.
 *
 * Signal chain (-> audio, ~> control signal into an AudioParam)
 *
 *   noise (white, looped)        flutS, flutW, flutF (one slow random loop read at three rates:
 *                                wind buffeting, the foil's waver, and 0-60 Hz flutter)
 *
 *   wind    noise(L,R) -> lowpass (body) -------> [wind gain] -> pan -> MUFFLE
 *                      -> bandpass -> air gain ->     ^ flutS ~> buffet depth
 *   water   noise -> bandpass(detune <~ flutF) -> [wash gain <~ flutF] -> MUFFLE
 *   stroke  noise -> lowpass  -> [whoosh gain] --+
 *   splash  noise -> bandpass -> [splash gain] --+-> pan -> MUFFLE
 *   thump   sine  -> [thump gain] -> MUFFLE
 *   foil    triangle(detune <~ flutF) -> [hum gain <~ flutW] -> MUFFLE
 *           noise -> bandpass at 3x the hum (Q 14: the whistle over it; opens and drops
 *                    into a gurgle as the wing nears the stall) -> [air gain <~ flutW, flutF] -> MUFFLE
 *   push    noise -> bandpass 0.8-1.2 kHz (detune <~ flutF) -> [rush gain <~ flutW] -> MUFFLE
 *   hiss    noise -> bandpass 2.4 kHz -> [whitecap bed gain] -> MUFFLE
 *                                     -> [crest-behind gain] -> MUFFLE
 *                                     -> [breaker gain] x2 -> pan -> MUFFLE
 *                                     -> [tear gain <~ flutF] -> MUFFLE   (air on the wing)
 *   breath  noise -> bandpass -> [breath gain] -> MUFFLE
 *   vario   periodic wave -> [gate <~ shaped LFO] -> [climb gain] --+-> MASTER   (built on demand)
 *                         -> [sink gain] ---------------------------+
 *
 *   MUFFLE (lowpass, closes while the rider is under water) -> MASTER gain -> soft clip -> out
 *
 * How the state drives each of these is written next to the code in update(); the levels
 * are in MIX.
 *
 * On the low quality tier the graph is lean: mono, no panners, one breaker voice, and
 * without what a phone speaker cannot reproduce anyway (the wind's rumble, the thump, the
 * hum under the whistle) or what is decoration (the breath). 31 nodes instead of 48.
 */
import type { App } from '../app/types'
import { EV } from '../sim/types'
import { mulberry32 } from '../sim/rng'
import { makeWaveSample } from '../sim/waves'
import { audioTuning as T } from './tuning'

const TWO_PI = Math.PI * 2
/** share of a paddle stroke in which the blade pulls, and of a pump in which the legs drive (physics.ts) */
const PULL = 0.65
const DRIVE = 0.55
/** one-shots are scheduled this far ahead, so the audio thread renders their attack whole */
const LEAD = 0.012
/** the master gain runs at 1/HEADROOM into a soft clipper whose curve gives the factor back */
const HEADROOM = 3
/** RMS of the flutter signal (see makeFlutter) */
const FLUTTER_RMS = 0.3

/** Designed level of each layer: linear gain on its filtered noise or oscillator. */
const MIX = {
  /** wind at the reference apparent wind (tuning.windRef) */
  wind: 1.0,
  /** share of the brighter band in the wind */
  windAir: 0.25,
  /** hull wash at paddling sprint speed */
  wash: 0.65,
  /** water lapping on a board that is not moving, in a 1 m sea */
  lap: 0.05,
  /** a hull skimming at foiling speed */
  skim: 0.8,
  /** mast spray in clean flight at 7 m/s */
  sizzle: 0.016,
  /** foam around a rider who just fell */
  foam: 0.35,
  /** pull of a full-effort paddle stroke, and the splash of its catch */
  stroke: 0.9,
  catch: 0.5,
  /** drive of a full-effort pump */
  pump: 0.4,
  /** the foil in a 1 g glide at 7 m/s: its hum and the whistle over it */
  hum: 0.03,
  air: 0.5,
  /** the gurgle of a wing about to let go */
  growl: 0.45,
  tear: 0.3,
  /** the rush of a face giving the foil 1.5 m/s of climb (about 1350 W) */
  push: 0.35,
  /** touchdown: slap and thump at the crash sink rate */
  slap: 0.6,
  thump: 0.5,
  /** crash */
  splash: 1.0,
  plunge: 0.5,
  /** whitecaps in a 1 m sea: steady bed, and one breaker right beside the rider */
  capBed: 0.018,
  capBreak: 0.08,
  /** a breaking crest right behind the rider */
  capNear: 0.11,
  /** a rider out of breath */
  breath: 0.12,
  /** variometer at tuning.varioLevel = 1 */
  vario: 0.4,
}

/** where the crest-behind hiss listens: metres up-swell of the rider, and how much each counts */
const NEAR_AT = [0, 3, 6, 10, 15]
const NEAR_WEIGHT = [1, 0.95, 0.8, 0.6, 0.4]

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (e0: number, e1: number, x: number) => {
  const u = clamp((x - e0) / (e1 - e0), 0, 1)
  return u * u * (3 - 2 * u)
}

/**
 * An AudioParam that is only ever moved by setTargetAtTime (so it cannot click), and only
 * when its target really changes (so an idle game schedules nothing).
 */
class Glide {
  private last = NaN
  constructor(readonly param: AudioParam, private readonly tau: number) {}

  to(v: number, now: number, tau = this.tau): void {
    if (Math.abs(v - this.last) <= 1e-5 + 0.002 * Math.abs(v)) return
    this.force(v, now, tau)
  }

  force(v: number, now: number, tau = this.tau): void {
    if (!Number.isFinite(v)) return
    this.param.setTargetAtTime(v, now, tau)
    this.last = v
  }
}

/** White noise with the same spectral density at any sample rate (RMS 0.58 at 48 kHz). */
function makeNoise(ctx: BaseAudioContext, seconds: number, rand: () => number): AudioBuffer {
  const n = Math.floor(seconds * ctx.sampleRate)
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buffer.getChannelData(0)
  const a = Math.sqrt(ctx.sampleRate / 48000)
  for (let i = 0; i < n; i++) d[i] = (rand() * 2 - 1) * a
  return buffer
}

/**
 * Slow random signal for modulation: noise below about 12 Hz, zero mean, RMS 0.3, 6.5 s
 * long and seamless as a loop. Stored at 8 kHz (it is resampled on playback); played at
 * rate 1 it is the buffeting of the wind, at rate 5 the flutter of water and of a stalling
 * wing.
 */
function makeFlutter(ctx: BaseAudioContext, rand: () => number): AudioBuffer {
  let sr = 8000
  let buffer: AudioBuffer
  try {
    buffer = ctx.createBuffer(1, Math.floor(6.5 * sr), sr)
  } catch {
    // an engine that refuses buffers below its own rate gets a bigger one
    sr = ctx.sampleRate
    buffer = ctx.createBuffer(1, Math.floor(6.5 * sr), sr)
  }
  const n = buffer.length
  const d = buffer.getChannelData(0)
  // white noise held for 1/8000 s, so the result does not depend on the buffer's rate
  const hold = Math.max(1, Math.round(sr / 8000))
  let held = 0
  for (let i = 0; i < n; i++) {
    if (i % hold === 0) held = rand() * 2 - 1
    d[i] = held
  }
  // two one-pole low-passes, run round the loop once to warm up so that the ends meet
  const k = 1 - Math.exp((-TWO_PI * 12) / sr)
  let y1 = 0, y2 = 0
  for (let i = 0; i < n; i++) { y1 += (d[i] - y1) * k; y2 += (y1 - y2) * k }
  let sum = 0, sq = 0
  for (let i = 0; i < n; i++) {
    y1 += (d[i] - y1) * k
    y2 += (y1 - y2) * k
    d[i] = y2
    sum += y2
    sq += y2 * y2
  }
  const mean = sum / n
  const gain = FLUTTER_RMS / Math.sqrt(Math.max(1e-12, sq / n - mean * mean))
  for (let i = 0; i < n; i++) d[i] = (d[i] - mean) * gain
  return buffer
}

/** tanh limiter for an input of up to +-HEADROOM, unity gain for small signals */
function softClip(): Float32Array<ArrayBuffer> {
  const n = 2049
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(HEADROOM * ((2 * i) / (n - 1) - 1))
  return curve
}

/** turns a sine LFO into the variometer's gate: 0 or 1, half the time each, soft edges */
function gateCurve(): Float32Array<ArrayBuffer> {
  const n = 257
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = smooth(-0.3, 0.3, (2 * i) / (n - 1) - 1)
  return curve
}

/**
 * One value per render quantum (2.7 ms) instead of one per sample. A parameter that is being
 * automated, and one moved by setTargetAtTime always is, otherwise puts its node on the
 * sample-accurate path: a panner then costs six times as much, a filter recomputes its
 * coefficients for every sample. Everything here moves slowly (smoothed over 30 ms or
 * more), so filter settings, oscillator pitches and pans are k-rate; only the gains, which
 * carry the envelopes, stay sample-accurate. Measured in Chrome on an M1: the whole graph
 * went from 1.7 % to 1.1 % of one core.
 */
function kRate(...params: AudioParam[]): void {
  for (const p of params) {
    try { p.automationRate = 'k-rate' } catch { /* older engines keep it a-rate */ }
  }
}

interface Vario {
  osc: OscillatorNode
  lfo: OscillatorNode
  out: GainNode
  pitch: Glide
  rate: Glide
  climb: Glide
  sink: Glide
  connected: boolean
}

export interface EngineOptions {
  /** false on the low tier: the lean, mono graph (see the note at the top of this file) */
  stereo: boolean
  seed?: number
}

export class AudioEngine {
  readonly ctx: BaseAudioContext
  readonly stereo: boolean

  private readonly rand: () => number
  private readonly ws = makeWaveSample()
  private readonly all: AudioNode[] = []
  private readonly sources: AudioScheduledSourceNode[] = []
  /** highest frequency a filter is asked for */
  private readonly top: number
  /** a centred equal-power panner costs 3 dB: voices that go through one are raised by it */
  private readonly panGain: number

  private readonly master: GainNode

  private readonly gMaster: Glide
  private readonly gMuffle: Glide
  private readonly gWind: Glide
  private readonly gWindBuffet: Glide
  private readonly gWindLP: Glide | null
  private readonly gWindBP: Glide
  private readonly gWindPan: Glide | null
  private readonly gWash: Glide
  private readonly gWashAM: Glide
  private readonly gWashF: Glide
  private readonly gWhoosh: Glide
  private readonly gWhooshF: Glide
  private readonly gEventPan: Glide | null
  private readonly gHum: Glide | null
  private readonly gHumAM: Glide | null
  private readonly gHumF: Glide | null
  private readonly gRough: Glide | null
  private readonly gAir: Glide
  private readonly gAirAM: Glide
  private readonly gAirF: Glide
  private readonly gAirQ: Glide
  private readonly gGurgle: Glide
  private readonly gTear: Glide
  private readonly gTearAM: Glide
  private readonly gRush: Glide
  private readonly gRushAM: Glide
  private readonly gRushF: Glide
  private readonly gCapBed: Glide
  private readonly gCapNear: Glide
  private readonly gBreath: Glide | null
  private readonly gBreathF: Glide | null

  private readonly splashBP: BiquadFilterNode
  private readonly splash: GainNode
  private readonly thumpOsc: OscillatorNode | null
  private readonly thump: GainNode | null
  private readonly capGains: GainNode[] = []
  private readonly capPans: (StereoPannerNode | null)[] = []

  private vario: Vario | null = null
  private varioOn = false
  private varioCut = 0
  private varioPower = 0

  private out = 1
  private whooshF = 500
  private prevStroke = -1
  private capClock = 0
  private capNext = 0
  private nearClock = 0
  private nearCrest = 0
  /** how hard the rider has been working lately, 0..1, and where he is in a breath, 0..1 */
  private work = 0
  private breathPhase = 0
  private slapIn = 1
  /** simulation time until which the splash voice is busy with something louder than a slap */
  private splashBusy = -1

  constructor(ctx: BaseAudioContext, options: EngineOptions) {
    this.ctx = ctx
    this.stereo = options.stereo && typeof ctx.createStereoPanner === 'function'
    this.rand = mulberry32(options.seed ?? 1934)
    this.top = Math.min(18000, 0.45 * ctx.sampleRate)
    this.panGain = this.stereo ? Math.SQRT2 : 1

    // ---- sources ----
    const white = makeNoise(ctx, 3.3, this.rand)
    const flutter = makeFlutter(ctx, this.rand)
    const noise = this.loop(white, 1, 0)
    const full = this.stereo
    const flutS = this.loop(flutter, 1, 0)
    const flutW = full ? this.loop(flutter, 0.6, 4.2) : flutS
    const flutF = this.loop(flutter, 5, 2.1)

    // ---- output: underwater muffle -> master -> soft clip ----
    const muffle = this.filter('lowpass', this.top, 0.7)
    const master = (this.master = this.gain(0))
    const clip = ctx.createWaveShaper()
    clip.curve = softClip()
    this.all.push(clip)
    muffle.connect(master)
    master.connect(clip)
    clip.connect(ctx.destination)
    this.gMaster = new Glide(master.gain, 0.05)
    this.gMuffle = new Glide(muffle.frequency, 0.1)

    // ---- wind in the ears ----
    // each ear gets its own turbulence: two readings of the noise loop, 1.4 s apart
    let windIn: AudioNode = noise
    if (this.stereo) {
      const merge = ctx.createChannelMerger(2)
      this.all.push(merge)
      noise.connect(merge, 0, 0)
      this.loop(white, 1, 1.37).connect(merge, 0, 1)
      windIn = merge
    }
    // a low rumble for the body of it (what headphones give) and a brighter band for the air
    // (what a phone speaker keeps); the second is inverted so they add where they cross
    const windLP = full ? this.filter('lowpass', 340, 0.5) : null
    const windBP = this.filter('bandpass', 1200, 0.7)
    const windAir = this.gain(-MIX.windAir)
    const wind = this.gain(0)
    const windBuffet = this.gain(0)
    if (windLP) {
      windIn.connect(windLP)
      windLP.connect(wind)
    }
    windIn.connect(windBP)
    windBP.connect(windAir)
    windAir.connect(wind)
    flutS.connect(windBuffet)
    windBuffet.connect(wind.gain)
    const windPan = this.panner()
    if (windPan) { wind.connect(windPan); windPan.connect(muffle) } else wind.connect(muffle)
    this.gWind = new Glide(wind.gain, 0.12)
    this.gWindBuffet = new Glide(windBuffet.gain, 0.12)
    this.gWindLP = windLP ? new Glide(windLP.frequency, 0.15) : null
    this.gWindBP = new Glide(windBP.frequency, 0.15)
    this.gWindPan = windPan ? new Glide(windPan.pan, 0.2) : null

    // ---- water on the hull, spray off the mast ----
    const washBP = this.filter('bandpass', 900, 0.7)
    const wash = this.gain(0)
    const washAM = this.gain(0)
    // the band wanders by about a third of an octave at flutter rates: wet, not static hiss
    const wobble = this.gain(450)
    noise.connect(washBP)
    washBP.connect(wash)
    wash.connect(muffle)
    flutF.connect(wobble)
    wobble.connect(washBP.detune)
    flutF.connect(washAM)
    washAM.connect(wash.gain)
    this.gWash = new Glide(wash.gain, 0.06)
    this.gWashAM = new Glide(washAM.gain, 0.06)
    this.gWashF = new Glide(washBP.frequency, 0.08)

    // ---- strokes and pumps (whoosh), splashes ----
    const eventPan = this.panner()
    const eventOut: AudioNode = eventPan ?? muffle
    if (eventPan) eventPan.connect(muffle)
    // a low-pass with a hump at its corner: a dark gulp of water, not a hiss
    const whooshBP = this.filter('lowpass', this.whooshF, 5)
    const whoosh = this.gain(0)
    noise.connect(whooshBP)
    wobble.connect(whooshBP.detune)
    whooshBP.connect(whoosh)
    whoosh.connect(eventOut)
    this.gWhoosh = new Glide(whoosh.gain, 0.03)
    this.gWhooshF = new Glide(whooshBP.frequency, 0.03)
    this.gEventPan = eventPan ? new Glide(eventPan.pan, 0.03) : null

    const splashBP = (this.splashBP = this.filter('bandpass', 2000, 0.7))
    const splash = (this.splash = this.gain(0))
    noise.connect(splashBP)
    wobble.connect(splashBP.detune)
    splashBP.connect(splash)
    splash.connect(eventOut)

    // ---- thump ----
    if (full) {
      const thumpOsc = (this.thumpOsc = this.oscillator('sine', 90))
      const thump = (this.thump = this.gain(0))
      thumpOsc.connect(thump)
      thump.connect(muffle)
    } else {
      this.thumpOsc = null
      this.thump = null
    }

    // ---- the foil ----
    if (full) {
      const humOsc = this.oscillator('triangle', 350)
      const hum = this.gain(0)
      const humAM = this.gain(0)
      const rough = this.gain(25)
      flutF.connect(rough)
      rough.connect(humOsc.detune)
      humOsc.connect(hum)
      hum.connect(muffle)
      flutW.connect(humAM)
      humAM.connect(hum.gain)
      this.gHum = new Glide(hum.gain, 0.05)
      this.gHumAM = new Glide(humAM.gain, 0.05)
      this.gHumF = new Glide(humOsc.frequency, 0.05)
      this.gRough = new Glide(rough.gain, 0.08)
    } else {
      this.gHum = this.gHumAM = this.gHumF = this.gRough = null
    }
    const airBP = this.filter('bandpass', 1000, 14)
    const air = this.gain(0)
    const airAM = this.gain(0)
    const gurgle = this.gain(0)
    noise.connect(airBP)
    airBP.connect(air)
    air.connect(muffle)
    flutW.connect(airAM)
    airAM.connect(air.gain)
    flutF.connect(gurgle)
    gurgle.connect(air.gain)
    this.gAir = new Glide(air.gain, 0.05)
    this.gAirAM = new Glide(airAM.gain, 0.05)
    this.gAirF = new Glide(airBP.frequency, 0.05)
    this.gAirQ = new Glide(airBP.Q, 0.08)
    this.gGurgle = new Glide(gurgle.gain, 0.06)

    // ---- the push of a face: a rush that comes and goes with the power from the water ----
    const rushBP = this.filter('bandpass', 950, 1.4)
    const rush = this.gain(0)
    const rushAM = this.gain(0)
    noise.connect(rushBP)
    wobble.connect(rushBP.detune)
    rushBP.connect(rush)
    rush.connect(muffle)
    flutW.connect(rushAM)
    rushAM.connect(rush.gain)
    this.gRush = new Glide(rush.gain, 0.12)
    this.gRushAM = new Glide(rushAM.gain, 0.12)
    this.gRushF = new Glide(rushBP.frequency, 0.12)

    // ---- hiss: whitecaps, and air on the wing (one wide band around 2.4 kHz serves both) ----
    const capBP = this.filter('bandpass', 2400, 0.5)
    const capBed = this.gain(0)
    const capNear = this.gain(0)
    noise.connect(capBP)
    capBP.connect(capBed)
    capBed.connect(muffle)
    capBP.connect(capNear)
    capNear.connect(muffle)
    this.gCapBed = new Glide(capBed.gain, 0.5)
    this.gCapNear = new Glide(capNear.gain, 0.25)
    // the tear of a ventilating wing is that hiss torn up by fast flutter
    const tear = this.gain(0)
    const tearAM = this.gain(0)
    capBP.connect(tear)
    tear.connect(muffle)
    flutF.connect(tearAM)
    tearAM.connect(tear.gain)
    this.gTear = new Glide(tear.gain, 0.03)
    this.gTearAM = new Glide(tearAM.gain, 0.03)

    // ---- the rider's breath ----
    if (full) {
      const breathBP = this.filter('bandpass', 1500, 1.6)
      const breath = this.gain(0)
      noise.connect(breathBP)
      breathBP.connect(breath)
      breath.connect(muffle)
      this.gBreath = new Glide(breath.gain, 0.05)
      this.gBreathF = new Glide(breathBP.frequency, 0.08)
    } else {
      this.gBreath = this.gBreathF = null
    }
    for (let i = 0; i < (this.stereo ? 2 : 1); i++) {
      const g = this.gain(0)
      const pan = this.panner()
      capBP.connect(g)
      if (pan) { g.connect(pan); pan.connect(muffle) } else g.connect(muffle)
      this.capGains.push(g)
      this.capPans.push(pan)
    }
  }

  /** Nodes in the graph (for the report and the debug read-out). */
  get nodeCount(): number {
    return this.all.length + this.sources.length
  }

  // -------------------------------------------------------------------------------------
  // building blocks
  // -------------------------------------------------------------------------------------

  private gain(value: number): GainNode {
    const g = this.ctx.createGain()
    g.gain.value = value
    this.all.push(g)
    return g
  }

  private filter(type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = frequency
    f.Q.value = q
    kRate(f.frequency, f.Q, f.detune)
    this.all.push(f)
    return f
  }

  private panner(): StereoPannerNode | null {
    if (!this.stereo) return null
    const p = this.ctx.createStereoPanner()
    kRate(p.pan)
    this.all.push(p)
    return p
  }

  private oscillator(type: OscillatorType, frequency: number): OscillatorNode {
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.value = frequency
    kRate(o.frequency, o.detune)
    o.start()
    this.sources.push(o)
    return o
  }

  private loop(buffer: AudioBuffer, rate: number, offset: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    src.playbackRate.value = rate
    src.start(0, offset)
    this.sources.push(src)
    return src
  }

  /** an envelope on a gain that already exists: up to `peak`, hold, die away */
  private strike(g: AudioParam, at: number, peak: number, attack: number, hold: number, decay: number): void {
    if (!Number.isFinite(peak)) return
    g.cancelScheduledValues(at)
    g.setTargetAtTime(peak, at, attack)
    g.setTargetAtTime(0, at + hold, decay)
  }

  /** a burst of band noise on the splash voice */
  private burst(
    at: number, simTime: number, frequency: number, q: number, peak: number,
    attack: number, hold: number, decay: number,
  ): void {
    if (!(peak > 0)) return
    const f = this.splashBP.frequency
    f.cancelScheduledValues(at)
    f.setTargetAtTime(Math.min(frequency, this.top), at, 0.004)
    this.splashBP.Q.setTargetAtTime(q, at, 0.004)
    this.strike(this.splash.gain, at, peak * this.panGain, attack, hold, decay)
    this.splashBusy = simTime + hold + 2.5 * decay
  }

  /** a short falling sine: the knock of the board, the body of an impact */
  private thud(at: number, from: number, to: number, peak: number, sweep: number, decay: number): void {
    if (!(peak > 0) || !this.thumpOsc || !this.thump) return
    // no two alike
    const vary = 0.9 + 0.2 * this.rand()
    const f = this.thumpOsc.frequency
    f.cancelScheduledValues(at)
    f.setValueAtTime(from * vary, at)
    f.setTargetAtTime(to * vary, at, sweep)
    this.strike(this.thump.gain, at, peak, 0.003, 0.012, decay)
  }

  // -------------------------------------------------------------------------------------
  // per frame
  // -------------------------------------------------------------------------------------

  /** Steer every sound from the rider state. Call once per rendered frame. */
  update(app: App, dt: number): void {
    const now = this.ctx.currentTime
    const s = app.view
    const P = app.sim.P
    const D = app.sim.D
    const waves = app.sim.waves
    const t = app.time
    const foil = s.mode === 'foil'
    const paddle = s.mode === 'paddle'
    const swim = s.mode === 'swim'
    const v = s.speed
    const pg = this.panGain
    /** significant wave height where the rider is (m) */
    const sea = clamp(P.waves.hs * waves.envelope(s.x, s.z, t), 0, 2)

    this.gMaster.to((this.out * clamp(T.master, 0, 1.5)) / HEADROOM, now)

    // ---- wind in the ears: the air moving past the rider's head ----
    // true wind in the water frame is wind + current toward +x; it gusts a little. The level
    // goes with apparent wind ^ windExp, so running downwind at 7 m/s is some 15 dB quieter
    // than sitting still, and every carve across the wind brings it back up.
    const g = T.gust
    const gust = 1 + g * (0.07 * Math.sin(0.83 * t + 1.3) + 0.05 * Math.sin(2.17 * t + 4.1) + 0.03 * Math.sin(4.9 * t))
    const awx = (P.env.wind + P.env.current) * gust - s.vx
    const awz = -s.vz
    const aw = Math.hypot(awx, awz)
    const ch = Math.cos(s.heading), sh = Math.sin(s.heading)
    const inv = 1 / Math.max(aw, 0.5)
    // where the air comes from: +1 = in the rider's face, -1 = on his back
    const fromAhead = -(awx * ch + awz * sh) * inv
    // left and right are the player's: the camera's right axis in the world (one frame old)
    const cam = app.camera.matrixWorld.elements
    const rx = cam[0], rz = cam[2]
    // (eased off above the reference, so a nuking day roars without swamping everything else)
    let wind = T.wind * MIX.wind * 1.6 * Math.tanh(Math.pow(aw / Math.max(1, T.windRef), T.windExp) / 1.6)
    // ears are sheltered from behind, and a swimmer's head is down among the waves
    wind *= 0.9 + 0.1 * fromAhead
    if (swim) wind *= 0.6
    this.gWind.to(wind, now)
    this.gWindBuffet.to(wind * 0.7, now)
    // stronger wind is also brighter
    this.gWindLP?.to(110 + 17 * aw, now)
    this.gWindBP.to(480 + 75 * aw, now)
    // it comes from the side it blows from
    this.gWindPan?.to(clamp(-0.6 * (awx * rx + awz * rz) * inv, -0.6, 0.6), now)

    // ---- water: hull wash while floating or skimming, a faint sizzle of spray in flight ----
    let wash: number
    let washF: number
    if (paddle) {
      // louder and higher with speed; thins out as the wing takes the weight (gLoad = share)
      const share = clamp(s.gLoad, 0, 1)
      wash = (MIX.lap * Math.min(1, sea) + MIX.wash * Math.pow(clamp(v / 4.5, 0, 1.4), 1.6)) * (1 - 0.55 * share)
      washF = 520 + 250 * v + 500 * share
    } else if (foil) {
      if (s.touching) {
        // the hull is on the water at flying speed: a loud hiss that brakes
        wash = MIX.skim * clamp(-s.rideHeight / 0.05, 0.3, 1) * Math.pow(clamp(v / 6, 0.3, 1.4), 1.5)
        washF = 1300 + 120 * v
      } else {
        // only the mast cuts the surface: near silence, more in a banked carve and on each pump
        const carve = smooth(0.2, 0.65, Math.abs(s.bank))
        const pumping = s.pumpPhase >= 0 ? Math.abs(Math.sin(TWO_PI * Math.min(1, s.pumpPhase))) : 0
        wash = MIX.sizzle * (v / 7) * (v / 7) * (1 + 4 * carve + 1.5 * pumping)
        // the fan of spray a banked mast throws is fuller than the hiss of an upright one
        washF = 3400 + 140 * v - 1100 * carve
      }
    } else {
      // foam fizzing out around the swimmer, then water lapping
      wash = MIX.foam * Math.exp(-s.modeTime / 0.7) + MIX.lap * Math.min(1, sea)
      washF = 900 + 700 * Math.exp(-s.modeTime / 0.5)
    }
    wash *= T.water
    this.gWash.to(wash, now)
    this.gWashAM.to(wash, now)
    this.gWashF.to(washF, now)

    // ---- the pull of a paddle stroke, the drive of a pump: a whoosh that follows the phase ----
    let whoosh = 0
    if (paddle && s.strokePhase >= 0 && s.strokePhase < PULL) {
      const k = Math.sin((Math.PI * s.strokePhase) / PULL)
      whoosh = T.strokes * MIX.stroke * (0.35 + 0.65 * s.effort) * Math.pow(k, 1.3)
      this.whooshF = (350 + 450 * k) * (0.85 + 0.3 * s.effort)
    } else if (foil && s.pumpPhase >= 0 && s.pumpPhase < DRIVE) {
      const k = Math.sin((Math.PI * s.pumpPhase) / DRIVE)
      whoosh = T.pumps * MIX.pump * (0.4 + 0.6 * s.effort) * k
      this.whooshF = 320 + 330 * k
    }
    this.gWhoosh.to(whoosh * pg, now)
    this.gWhooshF.to(this.whooshF, now)
    // the blade is on one side of the board (the rider's right is (-sin, cos) of his heading)
    this.gEventPan?.to(paddle ? clamp(0.45 * s.strokeSide * (ch * rz - sh * rx), -0.45, 0.45) : 0, now)
    // the blade leaves the water: drips
    if (paddle && this.prevStroke >= 0 && this.prevStroke < PULL && s.strokePhase >= PULL) {
      this.burst(now + LEAD, t, 3300, 1.2, T.strokes * 0.22 * MIX.catch * (0.5 + 0.5 * s.effort), 0.006, 0.02, 0.09)
    }
    this.prevStroke = paddle ? s.strokePhase : -1

    // ---- chop slapping the hull of a floating board ----
    if (paddle) {
      this.slapIn -= dt * (0.35 + 0.3 * v) * Math.min(1.2, 0.3 + sea)
      if (this.slapIn <= 0) {
        this.slapIn = 0.35 + 1.3 * this.rand()
        const hit = (0.25 + 0.75 * this.rand() * this.rand()) * (0.4 + 0.6 * clamp(v / 4, 0, 1)) * T.water
        this.thud(now + LEAD, 210 + 60 * this.rand(), 130, 0.16 * hit, 0.03, 0.035)
        if (t > this.splashBusy) this.burst(now + LEAD, t, 700 + 500 * this.rand(), 1.1, 0.2 * hit, 0.004, 0.012, 0.045)
      }
    }

    // ---- events ----
    if (app.events) this.fire(app, app.events, now + LEAD)

    // ---- the foil: a hum with a whistle over it, a gurgle near the stall, a tear when it breathes air ----
    let hum = 0
    let air = 0
    let gurgle = 0
    let tear = 0
    let rush = 0
    let rough = 25
    if (foil) {
      const load = clamp(s.gLoad, 0.2, 1.8)
      // pitch goes with the speed of the water over the wing (not over the ground: the foil
      // sounds soft on a crest and firm in a trough) and sags a little under load
      const hz = clamp((T.foilHz0 + T.foilHz * v) * (1 - T.foilBend * (load - 1)), 40, 1300)
      // how near the wing is to letting go: lift coefficient against its maximum
      const edge = Math.max(s.stalled ? 1 : 0, smooth(0.8, 1, s.cl / P.foil.clMax))
      const alive = s.breached ? 0 : s.touching ? 0.5 : 1
      // the hum goes with load; the whistle over it also with speed squared: quiet in a slow
      // glide, alive in a fast carve
      hum = T.foil * MIX.hum * load * (0.5 + 0.5 * Math.min(2, (v / 7) * (v / 7))) * (1 - edge) * alive
      const sing = clamp((v / 7) * (v / 7), 0, 2.2) * (0.4 + 0.6 * load * load)
      // near the stall the whistle's band opens, drops to the hum and flutters: a gurgle
      air = T.foil * (MIX.air * sing * (1 - edge) + MIX.growl * edge) * alive
      gurgle = 1.6 * air * edge
      // cents of random detune (times the flutter's RMS): a steady note, a warble at the stall
      rough = 25 + 300 * edge
      this.gHumF?.to(hz, now)
      this.gAirF.to(hz * (3 - 1.8 * edge), now)
      this.gAirQ.to(14 - 11 * edge, now)
      // air on the wing: a tip out of the water in a banked turn, or the whole wing ventilated
      const open = Math.max(s.breached ? 1 : 0, smooth(0, 0.3, s.tipOut))
      tear = T.tear * MIX.tear * open * clamp(v / 6, 0.4, 1.5)
      // the push: power the wave field is putting into the foil, as metres of climb per second
      const push = clamp(s.powerWave / (P.rider.mass * 9.81 * 1.5), 0, 1)
      rush = T.push * MIX.push * Math.pow(push, 0.7) * alive
      // (it brightens with speed, like everything the water does)
      this.gRushF.to(550 + 60 * v, now)
    }
    this.gHum?.to(hum, now)
    this.gHumAM?.to(hum, now)
    this.gRough?.to(rough, now)
    this.gAir.to(air, now)
    this.gAirAM.to(air, now)
    this.gGurgle.to(gurgle, now)
    this.gTear.to(tear, now)
    this.gTearAM.to(tear * 2.2, now)
    this.gRush.to(rush, now)
    this.gRushAM.to(rush, now)

    // ---- whitecaps: a steady distant bed, and the crests that break near the rider ----
    const windy = clamp(P.env.wind / 12.9, 0.4, 1.6)
    this.gCapBed.to(T.caps * MIX.capBed * Math.min(sea, 1.6) ** 2 * windy, now)
    this.capClock += dt
    if (this.capClock >= 0.25) {
      this.capClock = Math.min(this.capClock - 0.25, 0.25)
      for (let i = 0; i < 2; i++) {
        // a random spot within 50 m: if a peaky crest is there, it breaks
        const r = 6 + 42 * Math.pow(this.rand(), 1.4)
        const th = TWO_PI * this.rand()
        const dx = r * Math.cos(th), dz = r * Math.sin(th)
        waves.sample(s.x + dx, s.z + dz, t, Infinity, this.ws)
        const breaking = smooth(0.6, 1.2, this.ws.crest)
        if (breaking > 0 && this.rand() < breaking) {
          this.breaker(now + LEAD, (dx * rx + dz * rz) / r, r, sea)
          break
        }
      }
    }

    // ---- the crest behind: a breaking bump hisses before it arrives, and while it is ridden ----
    this.nearClock += dt
    if (this.nearClock >= 0.1) {
      this.nearClock = Math.min(this.nearClock - 0.1, 0.1)
      const dir = (P.waves.dirDeg * Math.PI) / 180
      const ux = Math.cos(dir), uz = Math.sin(dir)
      let crest = 0
      for (let i = 0; i < NEAR_AT.length; i++) {
        waves.sample(s.x - NEAR_AT[i] * ux, s.z - NEAR_AT[i] * uz, t, Infinity, this.ws)
        const c = NEAR_WEIGHT[i] * smooth(0.45, 1.0, this.ws.crest)
        if (c > crest) crest = c
      }
      this.nearCrest = crest
    }
    this.gCapNear.to(T.caps * MIX.capNear * Math.pow(Math.min(sea, 1.6), 1.5) * this.nearCrest, now)

    // ---- under water for a moment after a fall ----
    const under = swim && s.modeTime > 0.09 && s.modeTime < 0.8
    this.gMuffle.to(under ? 420 : this.top, now, under ? 0.03 : 0.14)

    // ---- breath: heard once the reserve is drawn down, and after hard work or a swim ----
    const working = (paddle && s.strokePhase >= 0) || (foil && s.pumpPhase >= 0) ? s.effort : swim ? 0.7 : 0
    this.work += (working - this.work) * (1 - Math.exp(-dt / (working > this.work ? 2.5 : 6)))
    const spent = clamp(0.85 * smooth(0.9, 0.35, s.stamina) + 0.6 * this.work, 0, 1)
    // 18 breaths a minute at rest, 48 flat out: in (shorter, softer, brighter), a beat, out
    this.breathPhase = (this.breathPhase + dt * (0.3 + 0.5 * spent)) % 1
    const ph = this.breathPhase
    const inhale = ph < 0.42
    const half = inhale ? Math.sin((Math.PI * Math.min(ph, 0.36)) / 0.36) : ph > 0.46 && ph < 0.94 ? Math.sin((Math.PI * (ph - 0.46)) / 0.48) : 0
    const flow = (inhale ? 0.7 : 1) * half * half
    this.gBreath?.to(under ? 0 : T.breath * MIX.breath * Math.pow(smooth(0.15, 1, spent), 1.5) * flow, now)
    this.gBreathF?.to(inhale ? 2100 : 1300, now)

    // ---- variometer ----
    // net power from the water: what the wave field and the tailwind give minus what drag
    // takes. The same number, smoothed the same way, as the HUD's bump bar, so the beeps
    // sound exactly while that bar is green and past the threshold. Floating, the powers
    // are small: slow low beeps on a face that pushes the board, silence on its back.
    const net = swim ? 0 : s.powerWave + s.powerDrag + s.powerAero
    this.varioPower += (net - this.varioPower) * (1 - Math.exp(-dt / Math.max(0.02, T.varioTau)))
    const on = T.vario > 0.5
    if (on !== this.varioOn) this.switchVario(on, now)
    const vario = this.vario
    if (vario) {
      if (on) {
        const level = swim ? 0 : T.varioLevel * MIX.vario
        const p = this.varioPower
        if (p > T.varioClimbW) {
          // gaining: beeps, higher and faster with the power
          const u = clamp((p - T.varioClimbW) / Math.max(1, T.varioFullW - T.varioClimbW), 0, 1)
          vario.pitch.to(520 * Math.pow(2, 1.45 * u), now)
          vario.rate.to(2.4 + 6.5 * u, now)
          vario.climb.to(level, now)
          vario.sink.to(0, now)
        } else if (p < -T.varioSinkW) {
          // losing fast: a low steady tone that falls
          const u = clamp((-p - T.varioSinkW) / Math.max(1, T.varioSinkW), 0, 1)
          vario.pitch.to(300 * Math.pow(2, -0.6 * u), now)
          vario.climb.to(0, now)
          vario.sink.to(level * T.varioSink, now)
        } else {
          vario.climb.to(0, now)
          vario.sink.to(0, now)
        }
      } else if (vario.connected && now > this.varioCut) {
        // switched off and faded out: take it out of the graph so it costs nothing
        vario.out.disconnect()
        vario.connected = false
      }
    }
  }

  /** One-shots for the event bits of this frame. Later lines win the shared voices. */
  private fire(app: App, ev: number, at: number): void {
    const s = app.view
    const P = app.sim.P
    const t = app.time
    const v = s.speed
    const fast = clamp(v / 6, 0.3, 1.4)
    if (ev & EV.STROKE) {
      // the catch: the blade goes in
      this.burst(at, t, 1700, 0.9, T.strokes * MIX.catch * (0.45 + 0.55 * s.effort), 0.004, 0.02, 0.075)
    }
    if (ev & EV.TAKEOFF) {
      // the hull lets go of the water
      this.burst(at, t, 3800, 1, T.water * 0.16, 0.006, 0.02, 0.07)
    }
    if (ev & EV.TIP) {
      this.burst(at, t, 3400, 1, T.tear * 0.2 * fast, 0.005, 0.02, 0.1)
    }
    if (ev & EV.BREACH) {
      // the wing pops out and sucks air
      this.burst(at, t, 2800, 1.5, T.tear * 0.45 * fast, 0.003, 0.015, 0.09)
    }
    if (ev & EV.REMOUNT) {
      this.burst(at, t, 1300, 0.7, T.impacts * 0.25, 0.02, 0.06, 0.2)
      this.thud(at, 190, 130, T.impacts * 0.12, 0.02, 0.04)
    }
    if (ev & EV.OFF_FOIL) {
      // the board settles back into the water
      this.burst(at, t, 900, 0.6, T.impacts * 0.5 * fast, 0.01, 0.05, 0.3)
      this.thud(at, 150, 90, T.impacts * 0.25, 0.03, 0.06)
    }
    if (ev & EV.TOUCHDOWN) {
      // how hard: the rate at which the hull met the water, against the rate that crashes
      app.sim.waves.sample(s.x, s.z, t, Infinity, this.ws)
      const closing = this.ws.etaDot + this.ws.dEdx * s.vx + this.ws.dEdz * s.vz - s.vy
      let hard = clamp(closing / Math.max(0.5, P.crash.sinkRate), 0.15, 1.3) * (0.5 + 0.5 * fast)
      // in the first moments on foil the hull is still leaving the water: a skip, not a landing
      if (s.mode === 'foil' && s.modeTime < 0.35) hard *= 0.3
      this.burst(at, t, 1100, 0.7, T.impacts * MIX.slap * hard, 0.003, 0.02, 0.12)
      this.thud(at, 185, 105, T.impacts * MIX.thump * hard, 0.02, 0.045)
    }
    if (ev & EV.CRASH) {
      // a big splash that settles into foam, over a deep plunge
      this.burst(at, t, 1500, 0.5, T.impacts * MIX.splash, 0.008, 0.06, 0.45)
      this.splashBP.frequency.setTargetAtTime(650, at + 0.06, 0.4)
      this.thud(at, 125, 55, T.impacts * MIX.plunge, 0.06, 0.12)
    }
  }

  /** One whitecap breaking r metres away, `side` (-1..1) to the player's right: a swell of hiss. */
  private breaker(at: number, side: number, r: number, sea: number): void {
    const k = this.capNext
    this.capNext = (k + 1) % this.capGains.length
    const peak = (T.caps * MIX.capBreak * Math.pow(Math.min(sea, 1.6), 1.5) * this.panGain) / (1 + r / 15)
    const rand = this.rand
    this.strike(this.capGains[k].gain, at, peak, 0.1 + 0.1 * rand(), 0.3 + 0.5 * rand(), 0.35 + 0.5 * rand())
    const pan = this.capPans[k]
    if (pan && Number.isFinite(side)) pan.pan.setTargetAtTime(clamp(0.9 * side, -0.9, 0.9), at, 0.02)
  }

  // -------------------------------------------------------------------------------------
  // variometer (built the first time it is switched on)
  // -------------------------------------------------------------------------------------

  private buildVario(): Vario {
    const ctx = this.ctx
    // a reedy tone that phone speakers can reproduce at both ends of its range
    const wave = ctx.createPeriodicWave(
      new Float32Array([0, 0, 0, 0, 0, 0, 0]),
      new Float32Array([0, 1, 0.45, 0.3, 0.18, 0.1, 0.06]),
    )
    const osc = ctx.createOscillator()
    osc.setPeriodicWave(wave)
    osc.frequency.value = 520
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 3
    kRate(osc.frequency, lfo.frequency)
    const shape = ctx.createWaveShaper()
    shape.curve = gateCurve()
    const gate = ctx.createGain()
    gate.gain.value = 0
    const climb = ctx.createGain()
    climb.gain.value = 0
    const sink = ctx.createGain()
    sink.gain.value = 0
    const out = ctx.createGain()
    lfo.connect(shape)
    shape.connect(gate.gain)
    osc.connect(gate)
    gate.connect(climb)
    climb.connect(out)
    osc.connect(sink)
    sink.connect(out)
    osc.start()
    lfo.start()
    this.all.push(shape, gate, climb, sink, out)
    this.sources.push(osc, lfo)
    return {
      osc, lfo, out, connected: false,
      pitch: new Glide(osc.frequency, 0.04),
      rate: new Glide(lfo.frequency, 0.1),
      climb: new Glide(climb.gain, 0.03),
      sink: new Glide(sink.gain, 0.06),
    }
  }

  private switchVario(on: boolean, now: number): void {
    this.varioOn = on
    if (on) {
      const vario = this.vario ?? (this.vario = this.buildVario())
      // an instrument, not part of the scene: it joins after the underwater muffle
      vario.out.connect(this.master)
      vario.connected = true
      this.chirp(now, 660, 990)
    } else if (this.vario) {
      this.vario.climb.force(0, now)
      this.vario.sink.force(0, now)
      this.varioCut = now + 0.4
      this.chirp(now, 990, 660)
    }
  }

  /** two short notes: rising = variometer on, falling = off */
  private chirp(now: number, first: number, second: number): void {
    const level = 0.3 * MIX.vario * clamp(T.varioLevel, 0, 1)
    if (!(level > 0)) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(first, now)
    osc.frequency.setValueAtTime(second, now + 0.09)
    g.gain.value = 0
    g.gain.setTargetAtTime(level, now, 0.004)
    g.gain.setTargetAtTime(0, now + 0.17, 0.02)
    osc.connect(g)
    g.connect(this.master)
    osc.start(now)
    osc.stop(now + 0.35)
    osc.onended = () => g.disconnect()
  }

  // -------------------------------------------------------------------------------------
  // housekeeping
  // -------------------------------------------------------------------------------------

  /** Playing or silent (muted, page hidden). Acts at once: the frame loop may not be running. */
  setOutput(on: boolean): void {
    if (this.out === (on ? 1 : 0)) return
    this.out = on ? 1 : 0
    this.gMaster.force((this.out * clamp(T.master, 0, 1.5)) / HEADROOM, this.ctx.currentTime, on ? 0.06 : 0.02)
  }

  /** The rider was restarted or moved: forget what was in progress. */
  reset(): void {
    this.prevStroke = -1
    this.varioPower = 0
    this.slapIn = 1
    this.splashBusy = -1
    this.nearCrest = 0
    this.work = 0
  }

  /** Current values of the parameters the state drives (for checks and for tuning by eye). */
  snapshot(): Record<string, number> {
    const p = (g: Glide | null) => (g ? g.param.value : 0)
    return {
      time: this.ctx.currentTime,
      nodes: this.nodeCount,
      master: p(this.gMaster) * HEADROOM,
      muffleHz: p(this.gMuffle),
      wind: p(this.gWind),
      windLowHz: p(this.gWindLP),
      windAirHz: p(this.gWindBP),
      windPan: p(this.gWindPan),
      wash: p(this.gWash),
      washHz: p(this.gWashF),
      whoosh: p(this.gWhoosh),
      whooshHz: p(this.gWhooshF),
      eventPan: p(this.gEventPan),
      splash: this.splash.gain.value,
      splashHz: this.splashBP.frequency.value,
      thump: this.thump ? this.thump.gain.value : 0,
      hum: p(this.gHum),
      humHz: p(this.gHumF),
      roughCents: p(this.gRough) * FLUTTER_RMS,
      air: p(this.gAir),
      airHz: p(this.gAirF),
      airQ: p(this.gAirQ),
      tear: p(this.gTear),
      rush: p(this.gRush),
      breath: p(this.gBreath),
      capBed: p(this.gCapBed),
      capNear: p(this.gCapNear),
      capBreak: Math.max(this.capGains[0].gain.value, this.capGains.length > 1 ? this.capGains[1].gain.value : 0),
      varioPowerW: this.varioPower,
      varioClimb: this.vario && this.varioOn ? this.vario.climb.param.value : 0,
      varioSink: this.vario && this.varioOn ? this.vario.sink.param.value : 0,
      varioHz: this.vario ? this.vario.pitch.param.value : 0,
      varioBeepHz: this.vario ? this.vario.rate.param.value : 0,
    }
  }

  /** Stop every source and take the graph apart. */
  dispose(): void {
    for (const src of this.sources) {
      try { src.stop() } catch { /* never started or already stopped */ }
      src.disconnect()
    }
    for (const node of this.all) node.disconnect()
    this.sources.length = 0
    this.all.length = 0
    this.vario = null
  }
}
