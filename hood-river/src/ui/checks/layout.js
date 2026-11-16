/*
 * Regression check of the HUD layout at one screen size: does every prompt line fit in the
 * wording the game would choose, and does anything overlap or leave the screen.
 * Not part of the game: one expression, run in the page by the capture tool, once per size:
 *
 *   node tools/shot.mjs --times 1.5 --size 844x390 --dpr 2 --mobile --out captures/ui/checks \
 *     --query "hud=1&q=low&start=foil" --eval "$(cat src/ui/checks/layout.js)"
 *
 * (without --mobile it measures the keyboard wording). Passes (ok: true) when no line is cut
 * even in its short wording at the smaller size, and no two of the HUD's islands overlap.
 */
import('/src/ui/hud.ts').then((m) => {
  const device = matchMedia('(pointer: coarse)').matches ? 'touch' : 'keys'
  const real = document.querySelector('.hr-prompt'), top = document.querySelector('.hr-top')
  const keep = real.style.display
  real.style.display = 'none'
  // the game's own rule (writeLine in hud.ts) on a stand-in: long, else short, else short and small
  const probe = document.createElement('div')
  probe.className = 'hr-prompt is-on'
  top.appendChild(probe)
  const over = () => (probe.scrollWidth > probe.clientWidth + 1 ? probe.scrollWidth - probe.clientWidth : 0)
  const box = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect() : null }
  const hit = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0
  const tally = { long: 0, short: 0, shortAndSmall: 0, cut: [] }
  const problems = new Set()
  for (const [wide, narrow] of m.promptLines(device)) {
    probe.classList.remove('is-small')
    probe.textContent = wide
    if (!over()) tally.long++
    else {
      probe.textContent = narrow
      if (!over()) tally.short++
      else {
        probe.classList.add('is-small')
        const by = over()
        if (by) tally.cut.push(`${narrow} (by ${by} px)`)
        else tally.shortAndSmall++
      }
    }
    const r = probe.getBoundingClientRect()
    if (hit(r, box('.hr-cluster'))) problems.add('the prompt runs over the cluster')
    if (hit(r, box('.hr-buttons'))) problems.add('the prompt runs over the buttons')
  }
  probe.remove()
  real.style.display = keep
  const names = ['.hr-cluster', '.hr-vario', '.hr-buttons', '.hr-session']
  for (let i = 0; i < names.length; i++) {
    const a = box(names[i])
    if (!a || !a.width) continue
    if (a.left < 0 || a.top < 0 || a.right > innerWidth || a.bottom > innerHeight) problems.add(names[i] + ' leaves the screen')
    for (let j = i + 1; j < names.length; j++) if (hit(a, box(names[j]))) problems.add(names[i] + ' overlaps ' + names[j])
  }
  return {
    ok: tally.cut.length === 0 && problems.size === 0,
    size: innerWidth + 'x' + innerHeight,
    device,
    font: getComputedStyle(document.querySelector('.hr-hud')).fontSize,
    roomForThePrompt: top.clientWidth,
    lines: tally,
    problems: [...problems],
  }
})
