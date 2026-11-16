/**
 * Knobs of the sound module. Plain numbers, read every frame, so a tuning panel can bind to
 * the object directly (it is re-exported from ./audio as `audioTuning`). Useful ranges are
 * given in brackets.
 *
 * The layer levels (wind ... caps) are multipliers on a mix that was balanced by measuring
 * offline renders (the designed levels are MIX in ./engine.ts): 1 is the designed level,
 * 0 switches the layer off, 2 is +6 dB.
 */
export const audioTuning = {
  /** overall level [0..1] */
  master: 0.8,
  /** variometer: 0 = off, 1 = on (the V key, a tap on the HUD's bump bar, or 'hr:vario') */
  vario: 0,

  // ---- layer levels [0..2] ----
  /** wind in the ears */
  wind: 1,
  /** hull wash and slap, the hiss of a hull skimming, spray off the mast */
  water: 1,
  /** the foil's hum, the whistle over it and its gurgle near the stall */
  foil: 1,
  /** tearing hiss of a wingtip out of the water or a ventilated wing */
  tear: 1,
  /** paddle strokes: the gulp of the pull, the splash of the catch, the drips of the exit */
  strokes: 1,
  /** pumps: the soft whoosh of each drive */
  pumps: 1,
  /** touchdown slap and thump, crash splash, the board settling, remount */
  impacts: 1,
  /** whitecaps: the distant bed, single breakers around the rider, the crest behind him */
  caps: 1,
  /** the rush of a face pushing the foil (follows powerWave); 0 leaves that to the variometer */
  push: 1,
  /** the rider's breathing when the reserve is low or he has been working */
  breath: 1,

  // ---- wind ----
  /** apparent wind (m/s) at which the wind layer is at its designed level [8..20] */
  windRef: 14,
  /** how fast the wind's loudness grows with apparent wind [1..3]: 2.4 is about 14 dB per
   *  doubling, as wind noise at the ear does; 1 is linear and much flatter */
  windExp: 2.4,
  /** depth of the gusts [0..3]: at 1 the true wind wanders by up to +-15 %, about +-3 dB */
  gust: 1,

  // ---- foil ----
  /** pitch of the hum: Hz at rest [40..200] plus Hz per m/s of speed through the water
   *  [15..80]. 90 + 38 v is 356 Hz at 7 m/s; the whistle sits at three times that */
  foilHz0: 90,
  foilHz: 38,
  /** how far the pitch falls per g of load above 1 [0..0.3]: 0.07 is 3 % flat in a 1.4 g carve */
  foilBend: 0.07,

  // ---- variometer ----
  /** level of the variometer [0..1] */
  varioLevel: 0.5,
  /** level of the low tone when losing energy fast, relative to the beeps [0..1]; 0 = stay silent */
  varioSink: 0.4,
  /** net power from the water (W) at which the beeps start [0..200] */
  varioClimbW: 40,
  /** net power (W) at which the beeps are at their highest and fastest [400..2000] */
  varioFullW: 900,
  /** net loss (W) beyond which the low tone sounds [300..2000] */
  varioSinkW: 800,
  /** smoothing of the power signal (s) [0.05..1]; the HUD's bump bar uses 0.35 */
  varioTau: 0.35,
}

export type AudioTuning = typeof audioTuning

/** the layer multipliers, for ?asolo= and for a tuning panel that wants to list them */
export const AUDIO_LAYERS = ['wind', 'water', 'foil', 'tear', 'strokes', 'pumps', 'impacts', 'caps', 'push', 'breath'] as const
export type AudioLayer = (typeof AUDIO_LAYERS)[number]
