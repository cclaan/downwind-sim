/**
 * Development aid, not part of the game (nothing imports it): renders the sound of a
 * deterministic run with an OfflineAudioContext, so the mix can be inspected as a
 * spectrogram and measured on a machine where nobody can listen, and so a capture clip can
 * be given its soundtrack.
 *
 * The page must be in capture mode, where window.__hr.frame(dt) is the only thing that
 * advances the simulation. The engine is the one the game uses; here it is built on the
 * offline context and stepped once per frame at the matching point of the audio timeline.
 *
 *   const m = await import('/src/audio/offline.ts')
 *   const r = await m.renderOffline(window.__hr.app, { seconds: 20, frame: (dt) => window.__hr.frame(dt) })
 *   m.wavBase64(r.channels, r.sampleRate)   // a 16-bit WAV
 */
import type { App } from '../app/types'
import { AudioEngine } from './engine'

export interface OfflineOptions {
  seconds: number
  /** frames per second the game is stepped at (default 60) */
  fps?: number
  sampleRate?: number
  /** false = the low-tier (mono) graph */
  stereo?: boolean
  /** advance the game by dt: window.__hr.frame */
  frame(dt: number): void
}

export interface OfflineResult {
  sampleRate: number
  channels: Float32Array[]
  nodes: number
  /** one row per frame: rider state next to the value of every driven parameter */
  log: Record<string, number | string>[]
}

export async function renderOffline(app: App, o: OfflineOptions): Promise<OfflineResult> {
  const fps = o.fps ?? 60
  const sampleRate = o.sampleRate ?? 48000
  const dt = 1 / fps
  const frames = Math.round(o.seconds * fps)
  const ctx = new OfflineAudioContext(2, Math.ceil(o.seconds * sampleRate), sampleRate)
  const engine = new AudioEngine(ctx, { stereo: o.stereo ?? true })
  const log: Record<string, number | string>[] = []
  let error: unknown = null

  const step = () => {
    // the parameters as the audio thread left them, next to the state that will now move them
    const before = engine.snapshot()
    o.frame(dt)
    engine.update(app, dt)
    const s = app.view
    const P = app.sim.P
    log.push({
      ...before,
      t: s.t,
      mode: s.mode,
      events: app.events,
      speed: s.speed,
      vx: s.vx,
      vz: s.vz,
      apparentWind: Math.hypot(P.env.wind + P.env.current - s.vx, s.vz),
      heading: s.heading,
      bank: s.bank,
      gLoad: s.gLoad,
      cl: s.cl,
      rideHeight: s.rideHeight,
      touching: s.touching ? 1 : 0,
      breached: s.breached ? 1 : 0,
      stalled: s.stalled ? 1 : 0,
      tipOut: s.tipOut,
      strokePhase: s.strokePhase,
      strokeSide: s.strokeSide,
      pumpPhase: s.pumpPhase,
      effort: s.effort,
      power: s.powerWave + s.powerDrag + s.powerAero,
    })
  }

  step()
  for (let k = 1; k < frames; k++) {
    ctx.suspend(k * dt).then(() => {
      try {
        if (!error) step()
      } catch (err) {
        error = err
      }
      void ctx.resume()
    }, (err) => { error = err })
  }
  const rendered = await ctx.startRendering()
  if (error) throw error
  const channels: Float32Array[] = []
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(rendered.getChannelData(c))
  const nodes = engine.nodeCount
  engine.dispose()
  return { sampleRate, channels, nodes, log }
}

/** RMS and peak per window (seconds), over the channels together. */
export function levels(channels: Float32Array[], sampleRate: number, window = 0.05): { rms: number[]; peak: number[] } {
  const n = channels[0].length
  const w = Math.max(1, Math.round(window * sampleRate))
  const rms: number[] = []
  const peak: number[] = []
  for (let i = 0; i < n; i += w) {
    let sq = 0, pk = 0, count = 0
    for (const ch of channels) {
      for (let j = i; j < Math.min(n, i + w); j++) {
        const v = ch[j]
        sq += v * v
        if (v > pk) pk = v
        else if (-v > pk) pk = -v
        count++
      }
    }
    rms.push(Math.sqrt(sq / Math.max(1, count)))
    peak.push(pk)
  }
  return { rms, peak }
}

/** 16-bit PCM WAV, base64 (to hand out of the page). */
export function wavBase64(channels: Float32Array[], sampleRate: number): string {
  const nc = channels.length
  const n = channels[0].length
  const bytes = new Uint8Array(44 + n * nc * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i) }
  text(0, 'RIFF')
  view.setUint32(4, 36 + n * nc * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, nc, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * nc * 2, true)
  view.setUint16(32, nc * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, n * nc * 2, true)
  let at = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]))
      view.setInt16(at, Math.round(v * 32767), true)
      at += 2
    }
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
