/**
 * Preset and link logic shared by the keyboard (keys 1-4) and the tuning panel.
 *
 * Presets of one kind replace each other: before a preset is applied, every number that
 * any preset of that kind sets is put back to its default, so switching from "nuking" to
 * "marginal" leaves nothing of the first behind, while numbers no preset of that kind
 * touches (the player's own tweaks elsewhere) stay as they are.
 *
 * Presets of different kinds stack in the order the shell lays them down from the URL:
 * foil, then conditions, then handling. Where two kinds set the same number the later kind
 * wins (the "Glide" handling gives any wing a higher CLmax), and that is kept whichever of
 * the two is picked last: choosing a foil under Glide keeps Glide's CLmax, leaving Glide
 * gives the foil its own back. The selects follow the same rule: a number taken over by a
 * later kind's preset does not turn the earlier kind's select to "custom".
 */
import type { App } from '../app/types'
import { DEFAULT_PARAMS, cloneParams, type SimParams } from '../sim/params'
import {
  applyPatch, CONDITION_PRESETS, diffOverrides, FOIL_PRESETS, HANDLING_PRESETS, type ParamPatch, type Preset,
} from '../sim/presets'
import { emit } from './shared'

export type PresetKind = 'foil' | 'conditions' | 'handling'

export const PRESET_TABLES: Record<PresetKind, Record<string, Preset>> = {
  foil: FOIL_PRESETS,
  conditions: CONDITION_PRESETS,
  handling: HANDLING_PRESETS,
}

/** the order presets are laid down in (src/main.ts): a later kind overrides an earlier one */
export const PRESET_ORDER: PresetKind[] = ['foil', 'conditions', 'handling']

type Bag = Record<string, unknown>
type Leaf = { id: string; path: string[]; value: unknown }

function leaves(o: Bag, prefix: string[], out: Leaf[]): Leaf[] {
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v as Bag, [...prefix, k], out)
    else if (v !== undefined) out.push({ id: [...prefix, k].join('.'), path: [...prefix, k], value: v })
  }
  return out
}

function getAt(o: Bag, path: string[]): unknown {
  let cur: unknown = o
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Bag)[k]
  }
  return cur
}

function setAt(o: Bag, path: string[], value: unknown): void {
  let cur = o
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]]
    if (!next || typeof next !== 'object') return
    cur = next as Bag
  }
  cur[path[path.length - 1]] = value
}

/** every leaf any preset of this kind sets (the tables never change: worked out once) */
const unions: Partial<Record<PresetKind, Leaf[]>> = {}
const unionIds: Partial<Record<PresetKind, Set<string>>> = {}
function unionLeaves(kind: PresetKind): Leaf[] {
  let out = unions[kind]
  if (out) return out
  const seen = new Set<string>()
  out = []
  for (const preset of Object.values(PRESET_TABLES[kind])) {
    for (const leaf of leaves(preset.patch as Bag, [], [])) {
      if (!seen.has(leaf.id)) { seen.add(leaf.id); out.push(leaf) }
    }
  }
  unions[kind] = out
  unionIds[kind] = seen
  return out
}
function owns(kind: PresetKind, id: string): boolean {
  unionLeaves(kind)
  return (unionIds[kind] as Set<string>).has(id)
}

function touchesWaves(kind: PresetKind): boolean {
  return unionLeaves(kind).some((l) => l.path[0] === 'waves')
}

/**
 * Does `key` describe the live numbers? Judged on the numbers this kind sets, leaving out
 * those a later kind's preset in force (`inForce`) has taken over, and those that belong
 * to an earlier kind and that this preset leaves alone.
 */
function matches(live: Bag, kind: PresetKind, key: string, inForce: Record<PresetKind, string>): boolean {
  const rank = PRESET_ORDER.indexOf(kind)
  const patch = PRESET_TABLES[kind][key].patch as Bag
  const base = DEFAULT_PARAMS as unknown as Bag
  for (const leaf of unionLeaves(kind)) {
    let taken = false
    for (let r = rank + 1; r < PRESET_ORDER.length && !taken; r++) {
      const other = PRESET_ORDER[r]
      const name = inForce[other]
      taken = !!name && getAt(PRESET_TABLES[other][name].patch as Bag, leaf.path) !== undefined
    }
    if (taken) continue
    let want = getAt(patch, leaf.path)
    if (want === undefined) {
      let borrowed = false
      for (let r = 0; r < rank && !borrowed; r++) borrowed = owns(PRESET_ORDER[r], leaf.id)
      if (borrowed) continue
      want = getAt(base, leaf.path)
    }
    if (getAt(live, leaf.path) !== want) return false
  }
  return true
}

/** The preset of each kind the live parameters correspond to ('' where none does). */
export function detectPresets(P: SimParams): Record<PresetKind, string> {
  const out: Record<PresetKind, string> = { foil: '', conditions: '', handling: '' }
  const live = P as unknown as Bag
  // the last kind first: an earlier kind has to know which of its numbers were taken over
  for (let r = PRESET_ORDER.length - 1; r >= 0; r--) {
    const kind = PRESET_ORDER[r]
    for (const key of Object.keys(PRESET_TABLES[kind])) {
      if (matches(live, kind, key, out)) { out[kind] = key; break }
    }
  }
  return out
}

/** The preset of this kind the live parameters correspond to, or '' if none does. */
export function detectPreset(P: SimParams, kind: PresetKind): string {
  return detectPresets(P)[kind]
}

/** Apply a named preset to the live parameters. Returns false for an unknown name. */
export function applyPreset(app: App, kind: PresetKind, key: string): boolean {
  if (!PRESET_TABLES[kind][key]) return false
  const P = app.sim.P as unknown as Bag
  const base = DEFAULT_PARAMS as unknown as Bag
  const inForce = detectPresets(app.sim.P)
  inForce[kind] = key
  // this kind's numbers go back to their defaults; then every preset in force is laid down
  // again in the shell's order, on those numbers only: the new preset in full, and from the
  // other kinds whatever they share with it
  for (const leaf of unionLeaves(kind)) setAt(P, leaf.path, getAt(base, leaf.path))
  for (const k of PRESET_ORDER) {
    const name = inForce[k]
    if (!name) continue
    for (const leaf of leaves(PRESET_TABLES[k][name].patch as Bag, [], [])) {
      if (owns(kind, leaf.id)) setAt(P, leaf.path, leaf.value)
    }
  }
  app.sim.refresh(touchesWaves(kind))
  emit('hr:params', { kind, key })
  return true
}

/** Put every simulation number back to its default (in place: modules hold references). */
export function resetParams(app: App): void {
  applyPatch(app.sim.P, cloneParams(DEFAULT_PARAMS) as ParamPatch)
  app.sim.refresh(true)
  emit('hr:params', { kind: 'reset', key: '' })
}

/**
 * The page URL with the current tune in it: ?foil=..&conditions=..&handling=..&p=a.b:1,c.d:2
 * `p` alone carries every number that differs from the defaults; the preset names are
 * there so a person can read what the link is. Other query flags are kept.
 */
export function tuneUrl(app: App, extra: Record<string, string | null> = {}): string {
  const url = new URL(location.href)
  const q = new URLSearchParams(url.search)
  for (const k of ['p', 'foil', 'conditions', 'handling', 'capture', 'hud']) q.delete(k)
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) q.delete(k)
    else q.set(k, v)
  }
  const parts: string[] = []
  const rest = q.toString()
  if (rest) parts.push(rest)
  const now = detectPresets(app.sim.P)
  const stock = detectPresets(DEFAULT_PARAMS)
  for (const kind of PRESET_ORDER) {
    // the preset that is simply the defaults stays out of the link
    if (now[kind] && now[kind] !== stock[kind]) parts.push(`${kind}=${encodeURIComponent(now[kind])}`)
  }
  const overrides = diffOverrides(app.sim.P)
  // paths and numbers only: ':' and ',' are legal in a query and stay readable unescaped
  if (overrides) parts.push(`p=${overrides}`)
  return url.origin + url.pathname + (parts.length ? '?' + parts.join('&') : '') + url.hash
}
