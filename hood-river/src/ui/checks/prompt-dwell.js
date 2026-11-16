/*
 * Regression check of the prompt scheduler: how long each line stays up in played runs.
 * Not part of the game: one expression, run in the page by the capture tool:
 *
 *   node tools/shot.mjs --times 0.1 --out captures/ui/checks \
 *     --query "hud=1&off=camera,sky,water,terrain,ambient,rider,fx,audio,tuning" \
 *     --eval "$(cat src/ui/checks/prompt-dwell.js)"
 *
 * Four runs of 60 s by a new player who does what the line says on the water (sprint,
 * hold, let go, point downwind) and, flying, pumps when told or slow, carves two seconds
 * each way and follows the height lines. Passes (ok: true) when the opening line is up for
 * 3 s or more before the first sprint cue and no more than one line in ten is up for half
 * a second or less (a sprint cue that ends in a take-off at once is not counted).
 */
(() => {
  const app = window.__hr.app
  const p = document.querySelector('.hr-prompt')
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true }))
  const all = []
  const runs = []
  let opening = -1
  for (let run = 0; run < 4; run++) {
    app.restart('paddle')
    const held = {}
    const set = (code, on) => { if (!!held[code] !== on) { key(on ? 'keydown' : 'keyup', code); held[code] = on } }
    const tap = () => { set('Space', false); key('keydown', 'Space'); key('keyup', 'Space') }
    const s = app.sim.s
    let last = null, since = s.t, paddle = 'hold', lean = 0, leanUntil = 0
    const seq = []
    for (let i = 0; i < 600; i++) {
      const on = p.classList.contains('is-on')
      const pr = on ? p.dataset.pr : '', text = on ? p.textContent : ''
      if (text !== last) {
        if (last) seq.push([last, +(s.t - since).toFixed(1), s.mode === 'foil'])
        last = text
        since = s.t
      }
      if (s.mode === 'paddle') {
        set('ArrowUp', false)
        const turn = pr === 'turn' ? (text.includes('←') ? -1 : 1) : 0
        set('ArrowLeft', turn < 0); set('ArrowRight', turn > 0)
        lean = 0
        if (pr === 'float') paddle = 'hold'
        else if (pr === 'rest' || pr === 'shallow') paddle = 'none'
        if (pr === 'go') tap()
        else set('Space', paddle === 'hold')
      } else if (s.mode === 'foil') {
        set('Space', false)
        if (pr === 'airborne' || pr === 'stall' || (pr === 'low' && /pump/.test(text)) || s.speed < 4.7) tap()
        set('ArrowUp', pr === 'high' && /front foot/.test(text))
        if (pr === 'low' && /lean/.test(text)) { lean = 0; leanUntil = Math.max(leanUntil, s.t + 1) }
        else if (s.modeTime > 2.5 && s.t > leanUntil) { lean = lean > 0 ? -1 : 1; leanUntil = s.t + 2.2 }
        set('ArrowLeft', lean < 0); set('ArrowRight', lean > 0)
      } else {
        for (const code of Object.keys(held)) set(code, false)
      }
      for (let f = 0; f < 6; f++) window.__hr.frame(1 / 60)
    }
    for (const code of Object.keys(held)) set(code, false)
    if (run === 0 && seq.length && /paddle/.test(seq[0][0])) opening = seq[0][1]
    // a cue that turned into a take-off at once did its job
    const counted = seq.filter((x, i) => !(/^Sprint now/.test(x[0]) && seq[i + 1] && seq[i + 1][2] && !x[2]))
    all.push(...counted)
    runs.push(`${s.takeoffs} take-offs, on foil ${s.foilTime.toFixed(0)} s | ` + seq.map((x) => `[${x[1]}s ${x[0]}]`).join(' '))
  }
  const brief = all.filter((x) => x[1] <= 0.5)
  const d = all.map((x) => x[1]).sort((a, b) => a - b)
  return {
    ok: opening >= 3 && brief.length <= all.length / 10,
    openingLineSeconds: opening,
    lines: all.length,
    upForHalfASecondOrLess: brief.map((x) => `${x[1]}s ${x[0]}`),
    medianSeconds: d[d.length >> 1],
    runs,
  }
})()
