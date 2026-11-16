/**
 * The place: the Columbia River from above Swell City, past the Hatchery, to the Hood River
 * bridge, from real elevation and chart data baked into levelData.ts.
 *
 * Land frame ("ground" coordinates): origin on the river centreline abeam the Hatchery
 * launch; +x downwind along 074 degrees true; +z to the right, toward Oregon (so the
 * Washington shore and the Hatchery are at negative z); heights in metres above the river.
 * The simulation's water frame slides against this one with the current:
 *     groundX = x - current * t,   groundZ = z
 */
import { LEVEL_DATA } from './levelData'

interface Grid {
  x0: number
  z0: number
  step: number
  nx: number
  nz: number
}

function decode(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  // Node (headless tests)
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, 'base64'))
}

function decode16(b64: string): Uint16Array {
  const bytes = decode(b64)
  const out = new Uint16Array(bytes.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8)
  return out
}

function bilinear(a: ArrayLike<number>, g: Grid, x: number, z: number): number {
  let fx = (x - g.x0) / g.step
  let fz = (z - g.z0) / g.step
  fx = fx < 0 ? 0 : fx > g.nx - 1 ? g.nx - 1 : fx
  fz = fz < 0 ? 0 : fz > g.nz - 1 ? g.nz - 1 : fz
  const ix = Math.min(g.nx - 2, Math.floor(fx))
  const iz = Math.min(g.nz - 2, Math.floor(fz))
  const tx = fx - ix
  const tz = fz - iz
  const i = iz * g.nx + ix
  const a00 = a[i], a10 = a[i + 1], a01 = a[i + g.nx], a11 = a[i + g.nx + 1]
  return (a00 + (a10 - a00) * tx) * (1 - tz) + (a01 + (a11 - a01) * tx) * tz
}

export class Level {
  readonly coarse: Grid = LEVEL_DATA.coarse
  readonly fine: Grid = LEVEL_DATA.fine
  readonly coarseHeight = decode16(LEVEL_DATA.coarse.height)
  readonly coarseDepth = decode(LEVEL_DATA.coarse.depth)
  /** wave envelope, 0..255, on the coarse grid: upload as an R8 texture with LINEAR filtering */
  readonly env = decode(LEVEL_DATA.coarse.env)
  readonly fineHeight = decode16(LEVEL_DATA.fine.height)
  readonly fineDepth = decode(LEVEL_DATA.fine.depth)

  /** 0..1 weight of the fine grid at a point (1 well inside it, 0 outside) */
  private fineWeight(x: number, z: number): number {
    const f = this.fine
    const m = 240
    const dx = Math.min(x - f.x0, f.x0 + (f.nx - 1) * f.step - x)
    const dz = Math.min(z - f.z0, f.z0 + (f.nz - 1) * f.step - z)
    const d = Math.min(dx, dz)
    return d <= 0 ? 0 : d >= m ? 1 : d / m
  }

  /** Land height above the river surface (m); 0 over water. */
  landHeight(x: number, z: number): number {
    const w = this.fineWeight(x, z)
    const c = w < 1 ? bilinear(this.coarseHeight, this.coarse, x, z) : 0
    const f = w > 0 ? bilinear(this.fineHeight, this.fine, x, z) : 0
    return (c * (1 - w) + f * w) * LEVEL_DATA.heightUnit
  }

  /** Water depth (m); 0 on land. */
  waterDepth(x: number, z: number): number {
    const w = this.fineWeight(x, z)
    const c = w < 1 ? bilinear(this.coarseDepth, this.coarse, x, z) : 0
    const f = w > 0 ? bilinear(this.fineDepth, this.fine, x, z) : 0
    return (c * (1 - w) + f * w) * LEVEL_DATA.depthUnit
  }

  /** How big the bumps are here, 0..1 (1 in the best water off the Hatchery). */
  waveScale(x: number, z: number): number {
    return bilinear(this.env, this.coarse, x, z) / 255
  }
}

export const LEVEL = new Level()

/** Places a run can start, in ground coordinates. */
export const STARTS: Record<string, { label: string; x: number; z: number }> = {
  hatchery: { label: 'Off the Hatchery', x: -220, z: -300 },
  tunnel: { label: 'Tunnel 5 pullout (2 km upwind)', x: -1900, z: -470 },
  swell: { label: 'Swell City', x: -1350, z: -450 },
}

/** Named places in ground coordinates, for scenery and signage. */
export const LANDMARKS = {
  hatcheryLaunch: { x: -50, z: -530 },
  hatcheryBuildings: { x0: 430, x1: 1000, z0: -990, z1: -850 },
  channelBuoy34: { x: 1006, z: -236 },
  wellsIslandWest: { x: 1230, z: 514 },
  wellsIslandEast: { x: 1910, z: 593 },
  whiteSalmonMouth: { x: 2885, z: -340 },
  theHook: { x: 2270, z: 960 },
  waterfrontPark: { x: 2750, z: 1135 },
  eventSite: { x: 3155, z: 1230 },
  sandbarTip: { x: 3540, z: 610 },
  bridgeSouthEnd: { x: 4025, z: 1730 },
  bridgeNorthEnd: { x: 5070, z: 900 },
  bridgeLiftSpan: { x: 4585, z: 1300 },
  burdoinMountain: { x: 8680, z: 2200 },
  underwoodSummit: { x: -1050, z: -3480 },
} as const
