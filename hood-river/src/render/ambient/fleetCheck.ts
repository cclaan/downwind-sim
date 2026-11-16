/**
 * DEBUG ONLY, not loaded in normal play: the fleet's own checks. Runs the game (or a
 * scripted rider) for some minutes without drawing anything extra and reports how well the
 * sailors kept out of the rider's way and off the shoals.
 *
 *   node tools/shot.mjs --query "scenario=auto" --times 0.1 \
 *        --eval "window.__hr.app.modules.ambient.check(600)"
 *   node tools/shot.mjs --query "start=foil" --times 0.1 \
 *        --eval "window.__hr.app.modules.ambient.check(600, 'across')"
 *
 * Riders
 *   app       the app's own rider: the scripted pilot of ?scenario= (auto is the one that
 *             reaches across the river), or the idle player
 *   straight  6.5 m/s down the middle of the channel, all the way to the bridge
 *   fast      the same at 9.5 m/s
 *   paddle    the same at 1.5 m/s
 *   sturn     S-turns, 40 degrees either side every 5 s, 7.5 m/s
 *   across    reaches 62 degrees either side of downwind, from one edge of the channel to
 *             the other, turning back at each (the hardest ordinary case: every turn is a
 *             turn straight back at whoever was following)
 *   shelf     6.5 m/s along the edge of the Oregon shelf
 *   shore     6.5 m/s close along the Washington shore
 * The scripted riders move app.view, app.time and app.groundShift themselves and step only
 * this module, so the app is left somewhere odd afterwards: use a fresh page per check.
 *
 * What comes back (distances in metres, over the ground)
 *   nearest            the closest any sailor came to the rider, and who and when
 *   pctWithin60/45/32  share of frames with a sailor that close (60 is where they may be;
 *                      45 is where only one that has stopped may be; 32 is too close)
 *   pctAheadOnHeldCourse  share of frames with a sailor within 25 m of the line of the
 *                      rider's course and less than 120 m ahead, the course having been held
 *                      (within 15 degrees) for 3 s: somebody in the way
 *   bowCrossings       times a moving sailor crossed that line less than 100 m ahead
 *   aground            sailors that were in water 0.25 m too shallow for them, and for how long
 *   busiest            most gybes any one sailor made in 30 s
 *   longestStop        longest any sailor sat waiting (s)
 *   farthestOffLane    furthest any sailor was carried along the river from its lane
 *   towClearance       the closest any sailor came to the tow's hull
 */
import type { App } from '../../app/types'
import { LEVEL } from '../../sim/level'
import type { Fleet } from './fleet'
import type { Tow } from './traffic'

export type CheckRider = 'app' | 'straight' | 'fast' | 'paddle' | 'sturn' | 'across' | 'shelf' | 'shore'

/** the middle of the channel down the river: ground x against z */
const LINE: [number, number][] = [[-5000, -300], [1500, -300], [3500, 310], [3830, 408], [4500, 1200], [9000, 6000]]

function lineAt(x: number): { z: number; heading: number } {
  for (let i = 1; i < LINE.length; i++) {
    if (x <= LINE[i][0]) {
      const t = (x - LINE[i - 1][0]) / (LINE[i][0] - LINE[i - 1][0])
      return { z: LINE[i - 1][1] + t * (LINE[i][1] - LINE[i - 1][1]), heading: Math.atan2(LINE[i][1] - LINE[i - 1][1], LINE[i][0] - LINE[i - 1][0]) }
    }
  }
  return { z: 0, heading: 0 }
}

export function checkFleet(app: App, fleet: Fleet, tow: Tow, step: (dt: number) => void, reset: () => void, seconds = 600, rider: CheckRider = 'app') {
  const waves = app.sim.waves
  const cur = waves.current
  const dt = 1 / 30
  const n = fleet.n
  let gx = -220, gz = rider === 'shelf' ? -140 : rider === 'shore' ? -480 : -300, hd = 0
  let side = 1, since = 0
  if (rider !== 'app') {
    app.view.x = gx + app.groundShift
    app.view.z = gz
    app.view.vx = cur
    app.view.vz = 0
    reset()
  }
  const hull = new Float32Array(6)
  const grounded = new Float32Array(n), stopped = new Float32Array(n), stoppedMost = new Float32Array(n), shallowest = new Float32Array(n).fill(99)
  const gybesWindow = new Uint32Array(n)
  const latWas = new Float32Array(n), alongWas = new Float32Array(n)
  const headings = new Float32Array(90).fill(99)
  let frames = 0, nearest = 1e9, within60 = 0, within45 = 0, within32 = 0, ahead = 0, crossings = 0, busiest = 0, offLane = 0, towClearance = 1e9
  let nearestAt: Record<string, unknown> = {}
  const frameCount = Math.round(seconds / dt)
  for (let k = 0; k < frameCount; k++) {
    if (rider === 'app') window.__hr.frame(dt)
    else {
      const line = lineAt(gx)
      let want = line.heading, speed = 6.5
      if (rider === 'fast') speed = 9.5
      else if (rider === 'paddle') speed = 1.5
      else if (rider === 'sturn') { speed = 7.5; want += (40 * Math.PI) / 180 * Math.sign(Math.sin((2 * Math.PI * k * dt) / 10)) }
      else if (rider === 'across') {
        speed = 7.5
        since += dt
        const off = gz - line.z
        if ((side > 0 && (off > 150 || since > 30)) || (side < 0 && (off < -170 || since > 30))) { side = -side; since = 0 }
        want += (side * 62 * Math.PI) / 180
      } else if (rider === 'shelf' || rider === 'shore') want = 0
      const turn = Math.max(-0.87 * dt, Math.min(0.87 * dt, want - hd))
      hd += turn
      const vx = Math.cos(hd) * speed, vz = Math.sin(hd) * speed
      gx += vx * dt
      gz += vz * dt
      app.time += dt
      app.groundShift = waves.groundShiftAt(app.time)
      app.view.x = gx + app.groundShift
      app.view.z = gz
      app.view.vx = vx + cur
      app.view.vz = vz
      app.view.heading = hd
      app.view.mode = 'foil'
      step(dt)
    }
    frames++
    const rgx = app.view.x - app.groundShift, rz = app.view.z
    const vx = app.view.vx - cur, vz = app.view.vz
    const speed = Math.hypot(vx, vz)
    const cx = speed > 1 ? vx / speed : 1, cz = speed > 1 ? vz / speed : 0
    // has the rider held its course for the last 3 s?
    const heading = speed > 3 ? Math.atan2(vz, vx) : 99
    let held = speed > 3
    for (let j = 0; held && j < 90; j++) if (Math.abs(headings[j] - heading) > 0.26) held = false
    headings[k % 90] = heading
    const hasTow = tow.keepOut(hull, 232, 0)
    const ex = hull[2] - hull[0], ez = hull[3] - hull[1], inv = 1 / Math.max(1, ex * ex + ez * ez)
    let in60 = false, in45 = false, in32 = false, inWay = false
    for (let i = 0; i < fleet.active; i++) {
      const s = fleet.describe(i)
      const ox = s.x - rgx, oz = s.z - rz
      const dist = Math.hypot(ox, oz)
      if (dist < nearest) {
        nearest = dist
        nearestAt = { time: Math.round(app.time), sailor: i, kind: ['wing', 'windsurfer', 'kite'][s.kind], doing: ['reaching', 'getting clear', 'stopped'][s.man], speed: +s.vel.toFixed(1), fromRider: [Math.round(ox), Math.round(oz)] }
      }
      if (dist < 60) in60 = true
      if (dist < 45) in45 = true
      if (dist < 32) in32 = true
      const along = ox * cx + oz * cz, lat = oz * cx - ox * cz
      if (held && along > 0 && along < 120 && Math.abs(lat) < 25) inWay = true
      if (k > 0 && held && s.vel > 2 && latWas[i] * lat < 0 && along > 0 && along < 100 && alongWas[i] > 0 && Math.abs(lat - latWas[i]) < 30) crossings++
      latWas[i] = lat
      alongWas[i] = along
      const depth = LEVEL.waterDepth(s.x, s.z)
      if (depth < shallowest[i]) shallowest[i] = depth
      if (depth < s.minDepth - 0.25) grounded[i] += dt
      if (s.man === 2) { stopped[i] += dt; if (stopped[i] > stoppedMost[i]) stoppedMost[i] = stopped[i] } else stopped[i] = 0
      offLane = Math.max(offLane, Math.abs(s.x - s.homeX))
      if (hasTow) {
        let t = ((s.x - hull[0]) * ex + (s.z - hull[1]) * ez) * inv
        t = t < 0 ? 0 : t > 1 ? 1 : t
        towClearance = Math.min(towClearance, Math.hypot(s.x - hull[0] - ex * t, s.z - hull[1] - ez * t))
      }
      if ((k + 1) % 900 === 0) {
        busiest = Math.max(busiest, s.gybes - gybesWindow[i])
        gybesWindow[i] = s.gybes
      }
    }
    if (in60) within60++
    if (in45) within45++
    if (in32) within32++
    if (inWay) ahead++
  }
  const aground: { sailor: number; seconds: number; depth: number }[] = []
  let longestStop = 0
  for (let i = 0; i < n; i++) {
    if (grounded[i] > 0) aground.push({ sailor: i, seconds: +grounded[i].toFixed(1), depth: +shallowest[i].toFixed(2) })
    longestStop = Math.max(longestStop, stoppedMost[i])
  }
  const pct = (v: number) => +((100 * v) / frames).toFixed(2)
  return {
    rider, scenario: app.options.scenario, tier: app.quality.tier, sailors: fleet.active, seconds,
    nearest: +nearest.toFixed(1), nearestAt,
    pctWithin60: pct(within60), pctWithin45: pct(within45), pctWithin32: pct(within32),
    pctAheadOnHeldCourse: pct(ahead), bowCrossings: crossings,
    aground, busiest, longestStop: Math.round(longestStop), farthestOffLane: Math.round(offLane), towClearance: Math.round(towClearance),
  }
}
