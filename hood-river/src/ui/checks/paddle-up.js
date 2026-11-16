/*
 * Regression check of the paddle-up coaching: a player who does exactly what the prompt
 * line says must get up. Not part of the game: one expression, run in the page by the
 * capture tool (keys go through the real input module):
 *
 *   node tools/shot.mjs --times 0.1 --out captures/ui/checks \
 *     --query "hud=1&prompts=always&off=camera,sky,water,terrain,ambient,rider,fx,audio,tuning" \
 *     --eval "$(cat src/ui/checks/paddle-up.js)"
 *
 * Eight start phases at each of four levels of the quick stamina store, 60 s each. Passes
 * (ok: true) when the follower takes off in at least 7 of 8 at every level. The other
 * players are there for comparison. Re-run it after any change to the paddle or stamina
 * physics, or to the prompt rules in hud.ts.
 */
(() => {
  const app = window.__hr.app, P = app.sim.P
  const p = document.querySelector('.hr-prompt')
  const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true, cancelable: true }))
  const players = {
    // sprints on the cue, holds on the paddle line, lets go on "out of breath"; with no
    // instruction on the line it carries on with the last one (never sprinting unasked)
    'follows the prompt line': (k, pr) => {
      if (pr === 'go') return 'tap'
      if (pr === 'float') k.last = 'hold'
      else if (pr === 'rest' || pr === 'shallow' || pr === 'turn') k.last = 'none'
      return k.last
    },
    'taps on the cue only': (k, pr) => (pr === 'go' ? 'tap' : 'none'),
    'mashes SPACE': () => 'tap',
  }
  const TRIALS = 8
  const out = { ok: true }
  for (const [name, decide] of Object.entries(players)) {
    out[name] = {}
    for (const store of [1, 0.5, 0.2, 0]) {
      const times = []
      let cueEmpty = 0, n = 0
      for (let trial = 0; trial < TRIALS; trial++) {
        app.restart('paddle')
        for (let i = 0; i < Math.round((0.6 + trial * 0.85) * 60); i++) window.__hr.frame(1 / 60)
        const s = app.sim.s
        s._fast *= store
        const k = { last: 'hold' }
        let down = false, took = -1
        const t0 = s.t
        for (let i = 0; i < 600 && took < 0; i++) {
          const pr = p.classList.contains('is-on') ? p.dataset.pr : ''
          n++
          if (pr === 'go' && s._fast / (P.stamina.reserve * P.stamina.fastShare) < 0.02) cueEmpty++
          const act = decide(k, pr)
          if (act === 'hold') { if (!down) { key('keydown'); down = true } }
          else {
            if (down) { key('keyup'); down = false }
            if (act === 'tap') { key('keydown'); key('keyup') }
          }
          for (let f = 0; f < 6; f++) {
            window.__hr.frame(1 / 60)
            if (s.mode === 'foil') { took = s.t - t0; break }
          }
        }
        if (down) key('keyup')
        if (took >= 0) times.push(took)
      }
      times.sort((a, b) => a - b)
      out[name]['store ' + store] = `up ${times.length}/${TRIALS}` + (times.length ? `, median ${times[times.length >> 1].toFixed(1)} s, worst ${times[times.length - 1].toFixed(1)} s` : '') + `; cue lit with the tip gone ${Math.round((100 * cueEmpty) / n)} %`
      if (name === 'follows the prompt line' && times.length < 7) out.ok = false
    }
  }
  return out
})()
