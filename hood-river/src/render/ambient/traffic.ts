/**
 * Commercial traffic: a tug pushing four barges up the charted channel.
 *
 * The channel is where the best bumps are, which is the rider's line, so the tow is kept
 * well clear by construction: its bow starts 1.5 km ahead of the rider and it runs the same
 * way (east, upriver) at 7 knots over the ground; if the rider closes to within 750 m of
 * its stern it speeds up to hold the gap. It reads as a landmark ahead: a long dark hull with
 * a white house, on the Washington-side line, that goes through the lift span of the bridge
 * late in a run.
 *
 * Ground coordinates. The track is the middle of the charted fairway (NOAA chart 18532):
 * along the Washington shore past the Hatchery, then the 091.5 degree leg, then 123.9
 * degrees through the lift span.
 */
import type { App } from '../../app/types'
import type { InstanceSet } from './instances'

/** [x, z] */
const TRACK: [number, number][] = [
  [-4300, -70], [-2500, -180], [-1490, -240], [-626, -285], [453, -346], [934, -360], [1226, -351],
  [1522, -314], [3516, 310], [3830, 408], [4253, 910], [4585, 1302], [5043, 1937], [6216, 3320],
]

/** z of the fairway's centre line abeam ground x: the fleet keeps the lanes of its downriver groups to one side of it */
export function fairwayZ(x: number): number {
  if (x <= TRACK[0][0]) return TRACK[0][1]
  for (let i = 1; i < TRACK.length; i++) {
    if (x <= TRACK[i][0]) return TRACK[i - 1][1] + ((TRACK[i][1] - TRACK[i - 1][1]) * (x - TRACK[i - 1][0])) / (TRACK[i][0] - TRACK[i - 1][0])
  }
  return TRACK[TRACK.length - 1][1]
}

const HULL = 0x7a4a3c, COVER = 0xc6c9c4, TUG_HULL = 0x22384f, WHITE = 0xe9e9e3, GLASS = 0x2a3a48, STACK = 0x23262a, FOAM = 0xdfe8e8

/** boxes the tow uses */
export const TOW_BOXES = 11

export class Tow {
  private readonly app: App
  private readonly cum: Float32Array
  private readonly length: number
  /** arc length of the bow along the track (m) */
  private s = 0
  private speed = 3.6
  // pathAt's argument and results (through fields: a floating-point argument to a call V8 has
  // not inlined is boxed, 12 bytes a time, and this is called a dozen times a frame)
  private at = 0
  private px = 0
  private pz = 0
  private ph = 0

  constructor(app: App) {
    this.app = app
    this.cum = new Float32Array(TRACK.length)
    for (let i = 1; i < TRACK.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(TRACK[i][0] - TRACK[i - 1][0], TRACK[i][1] - TRACK[i - 1][1])
    }
    this.length = this.cum[TRACK.length - 1]
    this.place()
  }

  /** arc length of the track point abeam ground x */
  private arcAtX(x: number): number {
    for (let i = 1; i < TRACK.length; i++) {
      if (x <= TRACK[i][0]) {
        const t = Math.max(0, (x - TRACK[i - 1][0]) / (TRACK[i][0] - TRACK[i - 1][0]))
        return this.cum[i - 1] + t * (this.cum[i] - this.cum[i - 1])
      }
    }
    return this.length
  }

  /** position and heading at the arc length `at`, into px, pz, ph; corners are rounded over 120 m */
  private pathAt() {
    const s = Math.max(0, Math.min(this.length, this.at))
    let i = 1
    while (i < TRACK.length - 1 && this.cum[i] < s) i++
    const a = TRACK[i - 1], b = TRACK[i]
    const seg = this.cum[i] - this.cum[i - 1]
    const t = (s - this.cum[i - 1]) / seg
    this.px = a[0] + (b[0] - a[0]) * t
    this.pz = a[1] + (b[1] - a[1]) * t
    let h = Math.atan2(b[1] - a[1], b[0] - a[0])
    // ease the heading into the next and out of the previous leg
    const R = 60
    const toEnd = this.cum[i] - s, fromStart = s - this.cum[i - 1]
    if (toEnd < R && i < TRACK.length - 1) {
      const c = TRACK[i + 1]
      const hn = Math.atan2(c[1] - b[1], c[0] - b[0])
      h += (hn - h) * 0.5 * (1 - toEnd / R)
    } else if (fromStart < R && i > 1) {
      const p = TRACK[i - 2]
      const hp = Math.atan2(a[1] - p[1], a[0] - p[0])
      h += (hp - h) * 0.5 * (1 - fromStart / R)
    }
    this.ph = h
  }

  /** put the bow 1.5 km ahead of the rider */
  private place() {
    const rgx = this.app.view.x - this.app.groundShift
    this.s = this.arcAtX(rgx + 1500)
  }

  /** the rider was placed somewhere: keep the tow if it is still comfortably ahead */
  reset() {
    const rgx = this.app.view.x - this.app.groundShift
    this.at = this.s - 190
    this.pathAt()
    const gap = this.px - rgx
    if (gap < 900 || gap > 3200 || this.s >= this.length - 1) this.place()
  }

  update(dt: number) {
    const app = this.app
    const rgx = app.view.x - app.groundShift
    this.at = this.s - 190
    this.pathAt()
    const gap = this.px - rgx
    // 7 knots; faster only to stay ahead of a rider who is catching up
    let want = 3.6
    if (gap < 750) want = Math.min(8, Math.max(3.6, app.view.vx - app.sim.waves.current + 0.6 + (750 - gap) * 0.01))
    this.speed += (want - this.speed) * Math.min(1, dt * 0.5)
    this.s = Math.min(this.length, this.s + this.speed * dt)
  }

  /** one box of the tow: `back` metres astern of the bow along the track, `side` metres to starboard */
  private box(set: InstanceSet, i: number, back: number, side: number, y: number, sx: number, sy: number, sz: number, split: number, a: number, b: number) {
    this.at = this.s - back
    this.pathAt()
    const c = Math.cos(this.ph), s = Math.sin(this.ph)
    set.setBox(i, this.px - s * side, y, this.pz + c * side, this.ph, sx, sy, sz, split, a, b)
  }

  /** write TOW_BOXES boxes starting at index `at`; returns the next free index */
  write(set: InstanceSet, at: number): number {
    if (this.s >= this.length - 1) {
      // gone round the bend past the bridge: park the boxes under the river
      for (let k = 0; k < TOW_BOXES; k++) set.setBox(at + k, 0, -500, 0, 0, 0.001, 0.001, 0.001, 0.5, 0, 0)
      return at + TOW_BOXES
    }
    let i = at
    // four barges, two abreast, riding high (empty, going up for grain)
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) this.box(set, i++, 39 + row * 78, (col - 0.5) * 13.4, -0.6, 76, 6.2, 13, 0.76, HULL, COVER)
    }
    // the tug: hull, house, pilot house up where it can see over the tow, two stacks
    const tug = 39 + 78 + 39 + 17
    this.box(set, i++, tug, 0, -0.6, 32, 3.6, 10.5, 0.8, TUG_HULL, WHITE)
    this.box(set, i++, tug - 2, 0, 3.0, 17, 6.4, 8.4, 0.5, WHITE, WHITE)
    this.box(set, i++, tug + 2, 0, 9.4, 5.6, 3.4, 6.6, 0.42, WHITE, GLASS)
    this.box(set, i++, tug - 8.5, 2.5, 9.4, 1.8, 3.4, 1.8, 0.5, STACK, STACK)
    this.box(set, i++, tug - 8.5, -2.5, 9.4, 1.8, 3.4, 1.8, 0.5, STACK, STACK)
    // wash astern and the bow wave
    this.box(set, i++, tug + 36, 0, -0.35, 40, 0.75, 9, 0.5, FOAM, FOAM)
    this.box(set, i++, -2.5, 0, -0.35, 5, 0.9, 28, 0.5, FOAM, FOAM)
    return i
  }

  /**
   * The water the tow needs, for the fleet to keep out of: into `out`, the point on the
   * track `astern` metres behind the bow (x, z), the point `ahead` metres in front of it
   * (x, z), and the tow's velocity (x, z), all in ground coordinates. False once it has gone.
   */
  keepOut(out: Float32Array, astern: number, ahead: number): boolean {
    if (this.s >= this.length - 1) return false
    this.at = this.s - astern
    this.pathAt()
    out[0] = this.px; out[1] = this.pz
    this.at = this.s + ahead
    this.pathAt()
    out[2] = this.px; out[3] = this.pz
    this.at = this.s
    this.pathAt()
    out[4] = Math.cos(this.ph) * this.speed; out[5] = Math.sin(this.ph) * this.speed
    return true
  }

  /** ground position of the bow, for the report */
  where(): { x: number; z: number } {
    this.at = this.s
    this.pathAt()
    return { x: this.px, z: this.pz }
  }
}
