#!/usr/bin/env node
/**
 * Headless screenshots and clips of the game, deterministic (fixed time step, scripted
 * pilot), for checking physics and looks without a person at the keyboard.
 *
 *   node tools/shot.mjs --query "scenario=carve" --times 2,4,6 --out captures/carve
 *   node tools/shot.mjs --query "scenario=carve&cam=chase" --video 10 --fps 30 --out captures/carve.mp4
 *   node tools/shot.mjs --query "start=foil" --times 1 --size 390x844 --dpr 2 --out captures/phone
 *
 * Options
 *   --query   "a=b&c=d"   URL query passed to the app (capture=1 is always added)
 *   --times   "1,2.5,4"   simulation times (s) to screenshot; files are <out>/t<time>.png
 *   --video   seconds     record a clip instead: frames at --fps, written to --out (.mp4)
 *   --start   seconds     simulation time at which the clip starts (default 0)
 *   --fps     n           clip frame rate (default 30)
 *   --size    WxH         viewport in CSS pixels (default 1280x720)
 *   --dpr     n           device pixel ratio (default 1)
 *   --out     path        output directory (stills) or .mp4 file (clip)
 *   --eval    "js"        expression evaluated in the page after the last frame; its JSON
 *                         result is printed (e.g. "window.__hr.state().speed")
 *   --url     http://...  use an already running dev server instead of starting one
 *   --gpu     metal|swiftshader   renderer backend (default metal; swiftshader is slow but
 *                         needs no GPU)
 *   --mobile              emulate a touch phone (coarse pointer, mobile user agent)
 *   --keep-frames         keep the clip's individual frames next to the .mp4
 *
 * Starts its own Vite dev server on a free port, so several runs can go at once.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const [W, H] = String(args.size ?? '1280x720').split('x').map(Number)
const dpr = Number(args.dpr ?? 1)
const fps = Number(args.fps ?? 30)
const startT = Number(args.start ?? 0)
const outArg = String(args.out ?? 'captures/shot')
const out = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg)
const gpu = String(args.gpu ?? 'metal')

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('Chrome not found; set CHROME_PATH')
  // On Apple silicon with an x64 Node, Chrome would inherit Rosetta; force the native slice.
  if (process.platform === 'darwin' && process.arch === 'x64' && existsSync('/usr/bin/arch')) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hr-chrome-'))
    const wrapper = path.join(dir, 'chrome-arm64.sh')
    writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/arch -arm64 "${found}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    return wrapper
  }
  return found
}

async function startVite() {
  if (args.url) return { url: String(args.url), close: async () => {} }
  const { createServer } = await import('vite')
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    clearScreen: false,
    server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, open: false },
  })
  await server.listen()
  const address = server.httpServer.address()
  return { url: `http://127.0.0.1:${address.port}/`, close: () => server.close() }
}

const vite = await startVite()
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: [
    `--window-size=${W},${H}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(gpu === 'swiftshader'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=metal', '--enable-gpu']),
  ],
})

let failed = false
try {
  const page = await browser.newPage()
  if (args.mobile) {
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    )
  }
  await page.setViewport({ width: W, height: H, deviceScaleFactor: dpr, isMobile: !!args.mobile, hasTouch: !!args.mobile })
  // never let an automated run reach analytics
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (/googletagmanager\.com|google-analytics\.com|doubleclick\.net/.test(u)) req.abort()
    else req.continue()
  })
  const problems = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}`))

  const query = new URLSearchParams(String(args.query ?? ''))
  query.set('capture', '1')
  await page.goto(`${vite.url}?${query.toString()}`, { waitUntil: 'load' })
  await page.waitForFunction('window.__hr && window.__hr.ready === true', { timeout: 60000 })
  const info = await page.evaluate(() => {
    const gl = window.__hr.app.renderer.getContext()
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  })
  console.log(`renderer: ${info}`)

  if (args.video) {
    const seconds = Number(args.video)
    const framesDir = out.replace(/\.mp4$/, '') + '-frames'
    rmSync(framesDir, { recursive: true, force: true })
    mkdirSync(framesDir, { recursive: true })
    if (startT > 0) await page.evaluate((t) => window.__hr.advanceTo(t), startT)
    const n = Math.round(seconds * fps)
    for (let i = 0; i < n; i++) {
      await page.evaluate((dt) => window.__hr.frame(dt), 1 / fps)
      await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 88 })
    }
    const mp4 = out.endsWith('.mp4') ? out : out + '.mp4'
    mkdirSync(path.dirname(mp4), { recursive: true })
    const ff = spawnSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-framerate', String(fps), '-i', path.join(framesDir, 'f%05d.jpg'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', mp4],
      { stdio: 'inherit' },
    )
    if (ff.status !== 0) throw new Error('ffmpeg failed')
    if (!args['keep-frames']) rmSync(framesDir, { recursive: true, force: true })
    console.log(`clip: ${mp4} (${n} frames at ${fps} fps)`)
  } else {
    const times = String(args.times ?? '1').split(',').map(Number)
    mkdirSync(out, { recursive: true })
    for (const t of times) {
      await page.evaluate((tt) => window.__hr.advanceTo(tt), t)
      const file = path.join(out, `t${t.toFixed(2).replace(/\.?0+$/, '')}.png`)
      await page.screenshot({ path: file, type: 'png' })
      console.log(`still: ${file}`)
    }
  }
  if (args.eval) {
    const result = await page.evaluate(String(args.eval))
    console.log(`eval: ${JSON.stringify(result)}`)
  }
  if (problems.length) {
    console.log(`page reported ${problems.length} problem(s):`)
    for (const p of problems.slice(0, 20)) console.log('  ' + p)
  }
} catch (err) {
  failed = true
  console.error(err)
} finally {
  await browser.close()
  await vite.close()
}
void spawn
process.exit(failed ? 1 : 0)
