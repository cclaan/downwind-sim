/**
 * Named bundles of parameter changes. A preset is a partial SimParams that is merged over
 * the current parameters, so "foil", "handling" and "conditions" presets stack.
 */
import { DEFAULT_PARAMS, cloneParams, type SimParams } from './params'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type ParamPatch = DeepPartial<SimParams>

export interface Preset {
  label: string
  note: string
  patch: ParamPatch
}

export function applyPatch(P: SimParams, patch: ParamPatch): SimParams {
  const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') {
        merge(dst[k] as Record<string, unknown>, v as Record<string, unknown>)
      } else if (v !== undefined) {
        dst[k] = v
      }
    }
  }
  merge(P as unknown as Record<string, unknown>, patch as Record<string, unknown>)
  return P
}

/** Set one number by path, e.g. setPath(P, 'handling.bankMaxDeg', 55). Returns false if unknown. */
export function setPath(P: SimParams, path: string, value: number): boolean {
  const parts = path.split('.')
  let o: Record<string, unknown> = P as unknown as Record<string, unknown>
  for (let i = 0; i < parts.length - 1; i++) {
    const next = o[parts[i]]
    if (!next || typeof next !== 'object') return false
    o = next as Record<string, unknown>
  }
  const key = parts[parts.length - 1]
  if (!(key in o) || typeof o[key] !== 'number' || !Number.isFinite(value)) return false
  o[key] = value
  return true
}

/** "a.b:1,c.d:2" (the ?p= URL parameter) applied to P. Returns the paths that were set. */
export function applyOverrides(P: SimParams, spec: string): string[] {
  const done: string[] = []
  for (const item of spec.split(',')) {
    const [path, raw] = item.split(':')
    if (path && raw !== undefined && setPath(P, path.trim(), Number(raw))) done.push(path.trim())
  }
  return done
}

/** What differs from the defaults, as an override string for sharing a tune by URL. */
export function diffOverrides(P: SimParams, base: SimParams = DEFAULT_PARAMS): string {
  const out: string[] = []
  const walk = (a: Record<string, unknown>, b: Record<string, unknown>, prefix: string) => {
    for (const k of Object.keys(a)) {
      const va = a[k], vb = b[k]
      if (va && typeof va === 'object') walk(va as Record<string, unknown>, (vb ?? {}) as Record<string, unknown>, prefix + k + '.')
      else if (typeof va === 'number' && va !== vb) out.push(`${prefix}${k}:${+va.toPrecision(5)}`)
    }
  }
  walk(P as unknown as Record<string, unknown>, base as unknown as Record<string, unknown>, '')
  return out.join(',')
}

export const FOIL_PRESETS: Record<string, Preset> = {
  s980: {
    label: '980 cm2, AR 9.5 (default)',
    note: 'A current downwind/surf wing: stalls near 8 kn, glides about 14:1, still carves.',
    patch: { foil: { area: 0.098, span: 0.965, clMax: 1.15, cd0: 0.014 } },
  },
  s1300: {
    label: '1300 cm2, AR 9.5 (easy)',
    note: 'Flies a knot and a half slower and pumps longer; wider span rolls slower and tops out earlier.',
    patch: { foil: { area: 0.13, span: 1.115, clMax: 1.15, cd0: 0.014 } },
  },
  s720: {
    label: '720 cm2, AR 9.5 (fast)',
    note: 'Needs 9 kn to fly and a steep bump to get there; quick rail to rail and fast.',
    patch: { foil: { area: 0.072, span: 0.83, clMax: 1.15, cd0: 0.014 } },
  },
  surf: {
    label: '1150 cm2, AR 7.4 (surf)',
    note: 'Older mid-aspect surf wing: forgiving and tight-turning, draggier, modest glide.',
    patch: { foil: { area: 0.115, span: 0.92, clMax: 1.1, cd0: 0.018 } },
  },
}

export const CONDITION_PRESETS: Record<string, Preset> = {
  classic: {
    label: 'Classic Hatchery afternoon',
    note: '25 knots against a July river: steep, peaky, waist to chest high, 16 m apart, whitecaps everywhere.',
    patch: { env: { wind: 12.9, current: 0.85 }, waves: { count: 16, hs: 1.3, tp: 3.2, gamma: 3, spreadDeg: 17, fMinRel: 0.78, fMaxRel: 1.45, skew: 1.3 } },
  },
  nuking: {
    label: 'Nuking, big river',
    note: '33 knots on a spring flow: chest to head-high faces, longer and faster, more power than you can use.',
    patch: { env: { wind: 17, current: 1.3 }, waves: { count: 16, hs: 1.65, tp: 3.6, gamma: 3.3, spreadDeg: 15, fMinRel: 0.8, fMaxRel: 1.35, skew: 1.5 } },
  },
  light: {
    label: 'Marginal',
    note: '18 knots, low river: knee-high, short and fussy. Timing and pumping required.',
    patch: { env: { wind: 9.3, current: 0.6 }, waves: { count: 16, hs: 0.95, tp: 2.9, gamma: 2.5, spreadDeg: 20, fMinRel: 0.8, fMaxRel: 1.5, skew: 1.0 } },
  },
  clean: {
    label: 'Clean lines (practice)',
    note: 'One tidy swell train, 1.2 m every 18 m, that never fades: learn the paddle-up and the carve here.',
    // a single component: for one sine, hs 1.7 means 1.2 m from trough to crest
    patch: { env: { wind: 11, current: 0.85 }, waves: { count: 1, hs: 1.7, tp: 3.4, spreadDeg: 0, skew: 0.9, sharpen: 1 } },
  },
}

/**
 * Three ways the same water can feel, to compare on one seed. "Carve" is the default.
 * They differ in how much the rider's reflexes do for the player, not in the forces.
 */
export const HANDLING_PRESETS: Record<string, Preset> = {
  carve: {
    label: 'Carve (default)',
    note: 'The rider will not lay it over further than the wing can carry, a wingtip in the air costs a little, pumps forgive a tenth of a second.',
    patch: {
      handling: { bankMaxDeg: 45, bankOmega: 7, bankZeta: 1, bankRateDeg: 90, bankTap: 0.45, bankRamp: 0.45, stallGuard: 0.85, alphaTau: 0.12, tipLoss: 0.6, ventDelay: 0.08, stallOvershoot: 0.1 },
      pump: { window: 0.1, holdEnergy: 215 },
      paddle: { takeoffSpeed: 1.1 },
      crash: { level: 1 },
    },
  },
  rail: {
    label: 'Rail (strict)',
    note: 'No safety net: full lean at low speed stalls the wing, a breach or a caught rail puts you in the water, pumps must be on the beat.',
    patch: {
      handling: { bankMaxDeg: 48, bankOmega: 6, bankZeta: 0.85, bankRateDeg: 85, bankTap: 0.3, bankRamp: 0.6, stallGuard: 0, alphaTau: 0.15, tipLoss: 1, ventDelay: 0.04, stallOvershoot: 0.2 },
      pump: { window: 0.07, holdEnergy: 170 },
      paddle: { takeoffSpeed: 1.1 },
      crash: { level: 2 },
    },
  },
  glide: {
    label: 'Glide (forgiving)',
    note: 'Quicker rail to rail, a stickier wing that flies slower, wingtips only throw spray, no crashes, generous pumps and take-offs.',
    patch: {
      handling: { bankMaxDeg: 40, bankOmega: 10, bankZeta: 1, bankRateDeg: 120, bankTap: 0.5, bankRamp: 0.35, stallGuard: 1, alphaTau: 0.1, tipLoss: 0, ventDelay: 0.3, stallOvershoot: 0 },
      foil: { clMax: 1.3 },
      pump: { window: 0.14, holdEnergy: 265 },
      paddle: { takeoffSpeed: 1.04 },
      crash: { level: 0 },
    },
  },
}

export function freshParams(): SimParams {
  return cloneParams(DEFAULT_PARAMS)
}
