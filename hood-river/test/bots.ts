/**
 * Headless experiments: `npx tsx test/bots.ts [name ...]`. Prints numbers, asserts nothing.
 * Use these to see what the physics does before touching the feel in a browser.
 */
import { Sim } from '../src/sim/harness'
import { cloneParams, derive } from '../src/sim/params'
import { G, makeWaveSample } from '../src/sim/waves'

const KN = 1.94384
const f = (v: number, d = 2) => v.toFixed(d)
const ws = makeWaveSample()

function flatParams() {
  const P = cloneParams()
  P.waves.hs = 0
  P.env.wind = 0
  P.env.current = 0
  return P
}

/** One clean wave train: height H (trough to crest) and period T. */
function regularParams(H = 1.2, T = 3.4) {
  const P = cloneParams()
  P.waves.count = 1
  P.waves.tp = T
  P.waves.hs = (H / 2) * 2 * Math.SQRT2
  P.waves.sharpen = 0
  P.waves.channelHalfWidth = 1e6
  return P
}

const experiments: Record<string, () => void> = {
  info() {
    const P = cloneParams()
    const D = derive(P)
    console.log('derived', Object.fromEntries(Object.entries(D).map(([k, v]) => [k, +f(v as number, 3)])))
    console.log(`stall ${f(D.vStall)} m/s (${f(D.vStall * KN, 1)} kn), best glide ${f(D.glideMax, 1)}:1 at ${f(D.vBestGlide)} m/s`)
    const sim = new Sim(P)
    const w = sim.waves
    console.log(`waves: n=${w.n} kp=${f(w.kp, 3)} lambda_p=${f((2 * Math.PI) / w.kp, 1)} m cp=${f(w.cp)} m/s`)
    for (let i = 0; i < w.n; i++) {
      const T = (2 * Math.PI) / w.w[i]
      console.log(
        `  ${String(i).padStart(2)} a=${f(w.a[i], 3)} T=${f(T)} L=${f((2 * Math.PI) / w.k[i], 1)} c=${f(w.w[i] / w.k[i])} dir=${f((Math.atan2(w.dz[i], w.dx[i]) * 180) / Math.PI, 1)} ak=${f(w.a[i] * w.k[i], 3)}`,
      )
    }
    // statistics of the surface
    let n = 0, sum2 = 0, maxEta = -9, minEta = 9, maxSlope = 0, slope2 = 0, maxUy = 0
    for (let t = 0; t < 600; t += 0.37) {
      for (let x = 0; x < 400; x += 7.3) {
        w.sample(x, (x * 0.37) % 150 - 75, t, Infinity, ws)
        n++
        sum2 += ws.eta * ws.eta
        maxEta = Math.max(maxEta, ws.eta); minEta = Math.min(minEta, ws.eta)
        const sl = Math.hypot(ws.dEdx, ws.dEdz)
        slope2 += sl * sl
        maxSlope = Math.max(maxSlope, sl)
        maxUy = Math.max(maxUy, Math.abs(ws.uy))
      }
    }
    console.log(
      `surface: Hs=${f(4 * Math.sqrt(sum2 / n))} max crest=${f(maxEta)} min trough=${f(minEta)} rms slope=${f(Math.sqrt(slope2 / n), 3)} max slope=${f(maxSlope, 3)} max rise=${f(maxUy)} m/s`,
    )
  },

  /** Glide on flat water from 7 m/s with no input: how long, how far. */
  glide() {
    const sim = new Sim(flatParams())
    sim.start({ foilSpeed: 7 })
    let last = -1
    sim.run(40, undefined, (m) => {
      const t = Math.floor(m.s.t * 2) / 2
      if (t !== last && m.s.mode === 'foil') {
        last = t
        if (t % 1 === 0) console.log(`  t=${f(t, 1)} V=${f(m.s.speed)} depth=${f(m.s.depth)} ride=${f(m.s.rideHeight)} g=${f(m.s.gLoad)} alpha=${f((m.s.alpha * 180) / Math.PI, 1)} drag=${f(-m.s.powerDrag / Math.max(1, m.s.speed), 0)}N`)
      }
      if (m.s.mode !== 'foil') {
        console.log(`glide: off foil at t=${f(m.s.t)} s after ${f(m.s.x, 1)} m, V=${f(m.s.speed)}`)
        return false
      }
    })
  },

  /** Hold the pump key on flat water from 6 m/s. */
  pump() {
    for (const cadence of ['hold', 'tap1.6', 'tap1.2']) {
      const sim = new Sim(flatParams())
      sim.start({ foilSpeed: 6 })
      let nextTap = 0
      const period = cadence === 'hold' ? 0 : 1 / parseFloat(cadence.slice(3))
      let vSum = 0, vN = 0
      sim.run(120, (m) => {
        if (cadence === 'hold') m.c.action = true
        else if (m.s.t >= nextTap) { m.c.actionPressed = true; nextTap = m.s.t + period }
      }, (m) => {
        if (m.s.t > 3) { vSum += m.s.speed; vN++ }
        if (m.s.mode !== 'foil') return false
      })
      console.log(`pump ${cadence}: on foil ${f(sim.s.t, 1)} s, ${f(sim.s.x, 0)} m, mean V=${f(vSum / Math.max(1, vN))}, pumps=${sim.s.pumpCount}, stamina left=${f(sim.s.stamina)}`)
    }
  },

  /** Banked turns on flat water: radius, rate, speed lost per 90 degrees. */
  turn() {
    for (const steer of [0.4, 0.7, 1]) {
      const sim = new Sim(flatParams())
      sim.P.handling.stallGuard = 0
      sim.start({ foilSpeed: 7.5 })
      sim.run(1.0)
      const v0 = sim.s.speed, h0 = sim.s.heading, t0 = sim.s.t
      let t90 = -1, v90 = 0, maxBank = 0, maxG = 0, minDepth = 9
      sim.run(6, (m) => { m.c.steer = steer }, (m) => {
        maxBank = Math.max(maxBank, m.s.bank); maxG = Math.max(maxG, m.s.gLoad); minDepth = Math.min(minDepth, m.s.depth)
        if (t90 < 0 && Math.abs(m.s.heading - h0) >= Math.PI / 2) { t90 = m.s.t - t0; v90 = m.s.speed }
        if (m.s.mode !== 'foil') return false
      })
      const rate = t90 > 0 ? (Math.PI / 2) / t90 : 0
      console.log(`turn steer=${steer}: bank=${f((maxBank * 180) / Math.PI, 0)} deg g=${f(maxG)} 90deg in ${f(t90)} s, mean radius=${f(rate > 0 ? (0.5 * (v0 + v90)) / rate : 0, 1)} m, V ${f(v0)} -> ${f(v90)} (mode ${sim.s.mode}, min depth ${f(minDepth)})`)
    }
  },

  /** Ride straight down a clean wave train with no input. */
  straight() {
    for (const [H, T] of [[1.2, 3.4], [0.8, 3.0], [0.5, 3.0]] as const) {
      const P = regularParams(H, T)
      const sim = new Sim(P)
      const w = sim.waves
      // start on the front face: phase 60 degrees ahead of a crest
      const x0 = (Math.PI / 3 - w.ph[0]) / w.k[0]
      sim.start({ x: x0, foilSpeed: w.cp + 0.5 })
      let vMin = 99, vMax = 0, last = -1
      const log: string[] = []
      sim.run(90, undefined, (m) => {
        vMin = Math.min(vMin, m.s.speed); vMax = Math.max(vMax, m.s.speed)
        const t = Math.floor(m.s.t)
        if (t !== last && t % 6 === 0) {
          last = t
          const th = ((w.k[0] * m.s.x - w.w[0] * m.s.t + w.ph[0]) * 180) / Math.PI
          log.push(`t=${t} V=${f(m.s.speed, 1)} vx=${f(m.s.vx, 1)} ph=${f(((th % 360) + 360) % 360, 0)} Pw=${f(m.s.powerWave, 0)}`)
        }
        if (m.s.mode !== 'foil') return false
      })
      console.log(`straight H=${H} T=${T} c=${f(w.cp)}: ${sim.s.mode} at t=${f(sim.s.t, 0)}, V range ${f(vMin)}..${f(vMax)}, waves overtaken=${f((sim.s.x - x0 - w.cp * sim.s.t) * w.k[0] / (2 * Math.PI), 1)}`)
      console.log('   ' + log.slice(0, 8).join(' | '))
    }
  },

  /** Paddle-up on a clean wave train: when the sprint starts decides whether it works. */
  paddleup() {
    const P = regularParams(1.1, 3.4)
    for (const mode of ['flat', 'wave']) {
      const rows: string[] = []
      const phases = mode === 'flat' ? [0] : [0, 45, 90, 135, 180, 225, 270, 315]
      for (const startPhase of phases) {
        const PP = mode === 'flat' ? flatParams() : cloneParams(P)
        const sim = new Sim(PP)
        const w = sim.waves
        sim.start({ x: 0 })
        // settle, cruising with held strokes
        let sprint = false
        let tSprint = -1
        sim.run(60, (m) => {
          const th = mode === 'flat' ? 0 : ((((w.k[0] * m.s.x - w.w[0] * m.s.t + w.ph[0]) * 180) / Math.PI) % 360 + 360) % 360
          if (!sprint && m.s.t > 6 && (mode === 'flat' || Math.abs(th - startPhase) < 4)) { sprint = true; tSprint = m.s.t }
          if (sprint) {
            // tap as fast as strokes allow
            if (m.s.strokePhase < 0 || m.s.strokePhase > 0.55) m.c.actionPressed = true
            m.c.action = true
          } else {
            m.c.action = false
          }
        }, (m) => {
          if (m.s.mode === 'foil' && m.s.modeTime > 3) return false
          if (sprint && m.s.t - tSprint > 25) return false
          if (m.s.stamina <= 0.011 && m.s.strokePhase < 0) return false
        })
        const ok = sim.s.mode === 'foil'
        rows.push(`${mode === 'flat' ? 'flat' : 'sprint@' + startPhase}: ${ok ? 'UP' : 'no'} in ${f(sim.s.t - tSprint, 1)} s, strokes=${sim.s.strokeCount}, stamina=${f(sim.s.stamina)}, V=${f(sim.s.speed)}`)
      }
      console.log(rows.join('\n'))
    }
  },

  /** S-turns on a clean wave: does carving hold or gain speed with no pumping? */
  carve() {
    for (const [H, T] of [[1.2, 3.4], [0.8, 3.0]] as const) {
      const sim = new Sim(regularParams(H, T))
      const w = sim.waves
      const x0 = (Math.PI / 3 - w.ph[0]) / w.k[0]
      sim.start({ x: x0, foilSpeed: w.cp + 1 })
      // steer to weave +-55 degrees about the wave direction
      let dir = 1
      let vSum = 0, n = 0, vMin = 99, vMax = 0, pw = 0
      sim.run(120, (m) => {
        const lim = (55 * Math.PI) / 180
        if (m.s.heading > lim) dir = -1
        else if (m.s.heading < -lim) dir = 1
        m.c.steer = dir * 0.75
      }, (m) => {
        if (m.s.t > 5) { vSum += m.s.speed; n++; vMin = Math.min(vMin, m.s.speed); vMax = Math.max(vMax, m.s.speed); pw += m.s.powerWave }
        if (m.s.mode !== 'foil') return false
      })
      console.log(`carve H=${H} T=${T}: ${sim.s.mode} at t=${f(sim.s.t, 0)} mean V=${f(vSum / Math.max(1, n))} (${f(vMin)}..${f(vMax)}) mean wave power=${f(pw / Math.max(1, n), 0)} W, downwind speed=${f((sim.s.x - x0) / sim.s.t)} vs c=${f(w.cp)}`)
    }
  },

  /** Default mixed sea, no input: how long does a passive rider last? */
  sea() {
    for (const seed of [7, 8, 9, 10]) {
      const P = cloneParams()
      P.waves.seed = seed
      const sim = new Sim(P)
      sim.start({ foilSpeed: 6.5 })
      let ev = 0
      sim.run(120, undefined, (m) => { ev |= m.s.events; m.s.events = 0; if (m.s.mode !== 'foil') return false })
      console.log(`sea seed=${seed} passive: ${sim.s.mode} after ${f(sim.s.t, 1)} s, ${f(sim.s.x, 0)} m, events=${ev}`)
    }
  },
}

const names = process.argv.slice(2)
for (const name of names.length ? names : Object.keys(experiments)) {
  const fn = experiments[name]
  if (!fn) { console.log(`unknown experiment ${name}`); continue }
  console.log(`\n=== ${name} ===`)
  fn()
}
void G
