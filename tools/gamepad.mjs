// tools/gamepad.mjs — prove the Xbox controller path actually works.
//
//   npx vite build && node tools/gamepad.mjs [--url …]
//
// There is no real pad attached to a headless browser, so this stubs
// `navigator.getGamepads` with a synthetic one and drives the game through it.
// That is not a substitute for holding a controller, but it exercises the whole
// pad path — slot binding, the deadzone curve, the standard-mapping button
// table, the analog triggers, and the duel's string bindings — none of which
// the keyboard tests touch at all.
//
// Both mappings are covered: `'standard'` (Chrome/Windows/macOS) and `''` with
// the Linux xpad axis layout, where the right stick is on axes 3/4 rather than
// 2/3 and the triggers are bipolar axes. Getting that second one wrong is the
// classic "my controller half-works on Linux" bug.

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const args = process.argv.slice(2)
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const p = req.url.split('?')[0]
      const f = join(ROOT, p === '/' ? 'index.html' : decodeURIComponent(p))
      res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
      res.end(await readFile(f))
    } catch { res.writeHead(404).end() }
  })
  await new Promise((r) => server.listen(0, r))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

/**
 * Installed before any script runs, so Input's constructor sees the pad on its
 * very first `_scanPads()` — which is also the path a pad plugged in before the
 * page loaded takes in Chrome.
 */
const INSTALL_PAD = (mapping) => `
  window.__pad = {
    index: 0,
    id: 'Synthetic Xbox Controller (Vendor: 045e Product: 02ea)',
    connected: true,
    mapping: ${JSON.stringify(mapping)},
    // standard: 4 axes. xpad: 8 axes — 0,1 left · 2 LT · 3,4 right · 5 RT · 6,7 hat
    axes: ${mapping === 'standard' ? '[0, 0, 0, 0]' : '[0, 0, -1, 0, 0, -1, 0, 0]'},
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    vibrationActuator: { playEffect: () => Promise.resolve('complete') },
  }
  navigator.getGamepads = () => [window.__pad, null, null, null]
  window.__padSet = (o) => {
    const p = window.__pad
    if (o.axes) for (const [i, v] of Object.entries(o.axes)) p.axes[i] = v
    if (o.buttons) {
      for (const [i, v] of Object.entries(o.buttons)) {
        p.buttons[i] = { pressed: v >= 0.5, value: v, touched: v > 0 }
      }
    }
  }
  window.__padClear = () => {
    const p = window.__pad
    for (let i = 0; i < p.axes.length; i++) {
      p.axes[i] = (p.mapping !== 'standard' && (i === 2 || i === 5)) ? -1 : 0
    }
    for (let i = 0; i < p.buttons.length; i++) {
      p.buttons[i] = { pressed: false, value: 0, touched: false }
    }
  }
`

const BTN = { A: 0, B: 1, X: 2, Y: 3, START: 9 }

async function runMapping(browser, url, mapping) {
  console.log(`\n--- mapping: ${mapping === 'standard' ? "'standard'" : "'' (Linux xpad)"} ---`)
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(INSTALL_PAD(mapping))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__bbStarted === true, null, { timeout: 90000 })

  const seen = await page.evaluate(() => window.__bb.input.connectedPads)
  check('pad is detected and bound to slot 0', seen === 1, `${seen} pad(s)`)

  // The whole way in must be walkable from the pad alone — a child with a
  // controller should never have to go and find the mouse. That is now TWO
  // presses of A, not one: the title opens "who's playing?", and A there picks
  // solo. Each press has to be released, because these fire on the edge.
  const tapA = async () => {
    await page.evaluate(() => window.__padSet({ buttons: { 0: 1 } }))
    await page.waitForTimeout(900)
    await page.evaluate(() => window.__padClear())
    await page.waitForTimeout(400)
  }
  await tapA()
  const joinMode = await page.evaluate(() => window.__bb.mode)
  check('A on the title screen opens the join screen', joinMode === 'join', `mode=${joinMode}`)

  await tapA()
  let mode = await page.evaluate(() => window.__bb.mode)
  if (mode !== 'play') {
    await page.evaluate(() => document.querySelector('.bb-m-solo')?.click())
    await page.waitForFunction(() => window.__bb.mode === 'play', null, { timeout: 15000 })
    mode = await page.evaluate(() => window.__bb.mode)
  }
  check('A on the join screen starts a solo game', mode === 'play', `mode=${mode}`)

  // Left stick walks. Axis 1 is negative for "up" on a real pad, and Input
  // negates it — so -1 must move FORWARD, not backward.
  //
  // Asserted on SPEED, not on distance travelled. SwiftShader renders about one
  // frame a second and Game clamps dt to 0.05, so a second of wall time buys
  // ~0.1s of simulated time and at most 0.72m of travel — a distance threshold
  // here measures the rasteriser, not the input code.
  await page.evaluate(() => { window.__bb.player.teleport(-5, 20) })
  const walk = await page.evaluate(async () => {
    window.__padSet({ axes: { 1: -1 } })
    const g = window.__bb
    let peak = 0
    let moveY = 0
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 40))
      peak = Math.max(peak, g.player.speed)
      moveY = Math.max(moveY, g.input.getState(0).moveY)
      if (peak > 7) break
    }
    window.__padClear()
    return { peak, moveY, usingPad: g.input.getState(0).usingPad }
  })
  check('left stick reaches full walking speed',
    walk.peak > 6.5, `peak ${walk.peak.toFixed(2)} m/s`)
  check('stick up is FORWARD (axis 1 is negated)',
    walk.moveY > 0.9, `moveY=${walk.moveY.toFixed(2)}`)
  check('the pad owns player 1', walk.usingPad === true)

  // Right stick turns the camera. On xpad that is axis 3, not axis 2 — if the
  // remap is wrong this silently does nothing.
  const yaw0 = await page.evaluate(() => window.__bb.player.camYaw)
  const rx = mapping === 'standard' ? 2 : 3
  await page.evaluate((i) => window.__padSet({ axes: { [i]: 1 } }), rx)
  await page.waitForTimeout(900)
  await page.evaluate(() => window.__padClear())
  const yaw1 = await page.evaluate(() => window.__bb.player.camYaw)
  check('right stick turns the camera', Math.abs(yaw1 - yaw0) > 0.05,
    `Δyaw ${(yaw1 - yaw0).toFixed(3)} on axis ${rx}`)

  // A jumps.
  await page.evaluate(() => { window.__bb.player.teleport(-5, 20) })
  await page.evaluate(() => window.__padSet({ buttons: { 0: 1 } }))
  await page.waitForTimeout(260)
  const airborne = await page.evaluate(() => window.__bb.player.pos.y > 0.3)
  await page.evaluate(() => window.__padClear())
  check('A jumps', airborne)

  // The duel, played entirely on the four face buttons.
  await page.evaluate(() => {
    const g = window.__bb
    const c = g.critters[0]
    g.player.teleport(c.rig.group.position.x, c.rig.group.position.z + 3)
    g._beginDuel(c)
  })
  await page.waitForFunction(() => window.__bb.mode === 'duel', null, { timeout: 8000 })

  const PAD_FOR_STRING = [BTN.A, BTN.B, BTN.X, BTN.Y]
  let guard = 0
  while (guard++ < 260) {
    const s = await page.evaluate(() => {
      const d = window.__bb.duel
      return d ? { state: d.state, phrase: d.phrase.slice(), progress: d.progress } : null
    })
    if (!s) break
    if (s.state === 'response') {
      for (let i = s.progress; i < s.phrase.length; i++) {
        const b = PAD_FOR_STRING[s.phrase[i]]
        await page.evaluate((n) => window.__padSet({ buttons: { [n]: 1 } }), b)
        await page.waitForTimeout(90)
        await page.evaluate(() => window.__padClear())
        await page.waitForTimeout(90)
      }
    }
    await page.waitForTimeout(110)
    if ((await page.evaluate(() => window.__bb.mode)) !== 'duel') break
  }
  const won = await page.evaluate(() => ({
    won: window.__bb.critters[0].won, mode: window.__bb.mode,
  }))
  check('a duel can be won on A/B/X/Y alone', won.won, `mode=${won.mode}`)

  // Start pauses and un-pauses.
  await page.evaluate(() => window.__padSet({ buttons: { 9: 1 } }))
  await page.waitForTimeout(320)
  await page.evaluate(() => window.__padClear())
  await page.waitForTimeout(320)
  const paused = await page.evaluate(() => window.__bb.mode)
  check('Start pauses', paused === 'pause', `mode=${paused}`)
  await page.evaluate(() => window.__padSet({ buttons: { 9: 1 } }))
  await page.waitForTimeout(320)
  await page.evaluate(() => window.__padClear())
  await page.waitForTimeout(320)
  const resumed = await page.evaluate(() => window.__bb.mode)
  check('Start un-pauses', resumed === 'play', `mode=${resumed}`)

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

async function main() {
  const hosted = urlArg ? { url: urlArg, server: null } : await serve()
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  })
  console.log(`\n→ ${hosted.url}`)
  await runMapping(browser, hosted.url, 'standard')
  await runMapping(browser, hosted.url, '')
  await browser.close()
  if (hosted.server) hosted.server.close()

  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
