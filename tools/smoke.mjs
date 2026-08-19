// tools/smoke.mjs — drive the built game in a real browser and prove it works.
//
//   npx vite build && node tools/smoke.mjs [--url http://…] [--head]
//
// This runs on SwiftShader in CI-like conditions, so treat ms/frame as relative
// only and give every wait SECONDS, not hundreds of milliseconds. A stall here
// is almost always the software rasteriser, not the game.
//
// What it proves, in order:
//   1. the module graph parses and the game boots (window.__bbStarted)
//   2. no console errors and no failed requests along the way
//   3. the title screen hands over to play on a key press
//   4. the player can actually walk, and collides with the building
//   5. a duel can be started, and CLEARED by reading the phrase back out of
//      the live Duel object and pressing the right keys — which is the only
//      test here that would catch the call/response state machine breaking
//   6. the melt meter rises next to the rotisserie and falls in the freezer
//   7. co-op, on a second page in split-screen: two players who answer only to
//      their own half of the keyboard, Big Earl driven and his forks used as a
//      moving platform, the flying banjo reaching a chip no jump could, and a
//      whole player-versus-player duel played to a winner

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const args = process.argv.slice(2)
const headed = args.includes('--head')
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
}

/** Serve dist/ so the build is tested, not the dev server. */
async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url.split('?')[0]
      const file = join(ROOT, path === '/' ? 'index.html' : decodeURIComponent(path))
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise((r) => server.listen(0, r))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const hosted = urlArg ? { url: urlArg, server: null } : await serve()
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

  const errors = []
  const failedReqs = []

  /**
   * Noise from things that are not this game.
   *
   * zulop.net sits behind Cloudflare, which injects its own inline analytics
   * script and a beacon.min.js — and the site's CSP (`script-src 'self'
   * 'wasm-unsafe-eval'`) blocks both. Every game on the site logs these two
   * errors on every page load; they predate this game and have nothing to do
   * with it. Counting them made a live run look like three failures when the
   * game was working perfectly, which is worse than not checking at all.
   */
  const isThirdPartyNoise = (text) =>
    /cloudflareinsights|beacon\.min\.js/.test(text) ||
    (/Content Security Policy/.test(text) && /inline script/.test(text))

  page.on('console', (m) => {
    if (m.type() === 'error' && !isThirdPartyNoise(m.text())) errors.push(m.text())
  })
  page.on('pageerror', (e) => {
    if (!isThirdPartyNoise(String(e))) errors.push(String(e))
  })
  page.on('requestfailed', (r) => {
    const line = `${r.url()} ${r.failure()?.errorText}`
    if (!isThirdPartyNoise(line)) failedReqs.push(line)
  })

  console.log(`\n→ ${hosted.url}\n`)
  await page.goto(hosted.url, { waitUntil: 'domcontentloaded' })

  // 1. boot. Never pass a STRING predicate to waitForFunction — on a CSP'd
  //    host it gets eval'd in the page, gets blocked, and reports "not booted"
  //    for a page that is completely fine. Always pass a function.
  let booted = true
  try {
    await page.waitForFunction(() => window.__bbStarted === true, null, { timeout: 90000 })
  } catch {
    booted = false
  }
  const fatal = await page.$eval('#fatal', (n) => (n.style.display === 'flex'
    ? n.querySelector('pre')?.textContent : null)).catch(() => null)
  check('boots', booted && !fatal, fatal ? fatal.slice(0, 400) : '')
  if (!booted) {
    await finish(browser, hosted)
    return
  }

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  check('no failed requests', failedReqs.length === 0, failedReqs.slice(0, 3).join(' | '))

  // 2. the world got built
  const world = await page.evaluate(() => ({
    colliders: window.__bb.store.colliders.boxes.length,
    critters: window.__bb.critters.length,
    pickups: window.__bb.pickups.length,
    platforms: window.__bb.store.platforms.length,
    mode: window.__bb.mode,
  }))
  check('store has collision', world.colliders > 80, `${world.colliders} boxes`)
  check('six critters exist', world.critters === 6, `${world.critters}`)
  check('pickups scattered', world.pickups > 30, `${world.pickups}`)
  check('platforms to climb', world.platforms > 20, `${world.platforms}`)
  check('starts on the title screen', world.mode === 'title')

  // 3. title -> join -> play. PLAY now opens the "who's playing?" screen, and
  //    the solo button is what actually starts the store.
  await page.click('canvas', { position: { x: 10, y: 10 } }).catch(() => {})
  await page.evaluate(() => document.querySelector('.bb-play')?.click())
  await page.waitForFunction(() => window.__bb.mode === 'join', null, { timeout: 15000 })
  check('join screen opens', true)
  await page.evaluate(() => document.querySelector('.bb-m-solo')?.click())
  await page.waitForFunction(() => window.__bb.mode === 'play', null, { timeout: 15000 })
  check('play begins', true)
  check('solo has one local player', await page.evaluate(() => window.__bb.localPlayers.length) === 1)
  check('solo draws one viewport', await page.evaluate(() => window.__bb.viewportCount) === 1)

  // 4. movement + collision. Walk into the front wall and confirm we stop
  //    short of it rather than passing through.
  const start = await page.evaluate(() => ({ ...window.__bb.player.pos }))
  await hold(page, 'KeyW', 1200)
  const moved = await page.evaluate(() => ({ ...window.__bb.player.pos }))
  const dist = Math.hypot(moved.x - start.x, moved.z - start.z)
  check('player walks', dist > 1.5, `moved ${dist.toFixed(1)}m`)

  // Drop the player INSIDE a solid and confirm resolve() throws them back out.
  //
  // The target is taken from the live collider list rather than hardcoded: the
  // first version of this test named a coordinate that was inside the racking,
  // then the aisles were widened and the coordinate became open floor — so the
  // test failed for a change that was entirely correct. Ask the world where its
  // solids are.
  //
  // Measure total displacement, not just X: resolution takes the smallest
  // penetration axis, so which way you come out is not ours to predict and
  // asserting on one axis is how you write a flaky test.
  const inside = await page.evaluate(() => {
    const g = window.__bb
    const rack = g.store.colliders.boxes.find((b) => b.kind === 'rack')
    const x0 = (rack.minX + rack.maxX) / 2
    const z0 = (rack.minZ + rack.maxZ) / 2
    g.player.pos.set(x0, 0, z0)
    g.store.resolve(g.player.pos, 0.42, 1.75)
    return { dx: g.player.pos.x - x0, dz: g.player.pos.z - z0 }
  })
  const pushed = Math.hypot(inside.dx, inside.dz)
  check('collision ejects from solids', pushed > 0.3,
    `pushed ${pushed.toFixed(2)}m (dx=${inside.dx.toFixed(2)}, dz=${inside.dz.toFixed(2)})`)

  // 5. jump
  await page.evaluate(() => window.__bb.player.teleport(-2, 22))
  await page.keyboard.press('Space')
  await page.waitForTimeout(220)
  const airborne = await page.evaluate(() => window.__bb.player.pos.y > 0.35)
  check('jump leaves the ground', airborne)

  // 6. melt: stand at the rotisserie, then in the freezer
  const meltRose = await page.evaluate(async () => {
    const g = window.__bb
    g.player.teleport(50, 36)
    g.player.melt = 0
    await new Promise((r) => setTimeout(r, 1500))
    return g.player.melt
  })
  check('banjo melts near the rotisserie', meltRose > 0.01, `melt=${meltRose.toFixed(3)}`)

  const meltFell = await page.evaluate(async () => {
    const g = window.__bb
    g.player.teleport(-40, 0)
    await new Promise((r) => setTimeout(r, 1200))
    return g.player.melt
  })
  check('banjo re-freezes in the freezer aisle', meltFell < meltRose, `melt=${meltFell.toFixed(3)}`)

  // 7. THE DUEL. Start one, then read the phrase out of the live object each
  //    round and play it back correctly. This is the real test in this file.
  await page.evaluate(() => {
    const g = window.__bb
    const c = g.critters[0]
    g.player.teleport(c.rig.group.position.x, c.rig.group.position.z + 2)
    g._beginDuel(c)
  })
  await page.waitForFunction(() => window.__bb.mode === 'duel', null, { timeout: 5000 })
  check('duel starts', true)

  const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4']
  let guard = 0
  let clearedRounds = 0
  while (guard++ < 260) {
    const s = await page.evaluate(() => {
      const d = window.__bb.duel
      if (!d) return null
      return { state: d.state, phrase: d.phrase.slice(), progress: d.progress, round: d.roundIndex }
    })
    if (!s) break
    if (s.state === 'response') {
      // Play the whole phrase from where we are.
      for (let i = s.progress; i < s.phrase.length; i++) {
        await page.keyboard.press(KEYS[s.phrase[i]])
        await page.waitForTimeout(70)
      }
      clearedRounds = Math.max(clearedRounds, s.round + 1)
    }
    await page.waitForTimeout(120)
    const mode = await page.evaluate(() => window.__bb.mode)
    if (mode !== 'duel') break
  }

  const after = await page.evaluate(() => ({
    mode: window.__bb.mode,
    won: window.__bb.critters[0].won,
    star: window.__bb.critters[0].star,
    band: Object.keys(window.__bb.band).length,
  }))
  check('duel can be cleared', after.won, `rounds played: ${clearedRounds}`)
  check('winning returns to play', after.mode === 'play', after.mode)
  check('a perfect duel earns a star', after.star === true, `star=${after.star}`)
  check('band roster updated', after.band === 1)

  // 8. the wrong note is survivable, not fatal
  const mercy = await page.evaluate(async () => {
    const g = window.__bb
    const c = g.critters[1]
    g._beginDuel(c)
    await new Promise((r) => setTimeout(r, 2600))
    const d = g.duel
    // Deliberately press a wrong string, repeatedly.
    const wrong = (d.phrase[0] + 1) % 4
    for (let i = 0; i < 3; i++) {
      d._miss(wrong)
      await new Promise((r) => setTimeout(r, 60))
    }
    return { state: d.state, mistakes: d.mistakes, mode: g.mode }
  })
  check('wrong notes never end the duel', mercy.mode === 'duel' && mercy.mistakes === 3,
    `state=${mercy.state}`)

  // Mashing a string outside your turn must make a NOISE and change nothing.
  // The failure mode this guards is the buttons going dead for the four
  // seconds the critter plays, which to a small player reads as a broken game.
  const idle = await page.evaluate(async () => {
    const g = window.__bb
    const d = g.duel
    d.state = 'call'
    d.events.length = 0
    const before = { progress: d.progress, mistakes: d.mistakes, state: d.state }
    const fake = {}
    for (let i = 1; i <= 4; i++) fake[`string${i}`] = { pressed: i === 2, down: i === 2 }
    d._idleStrum(fake)
    return {
      emitted: d.events.map((e) => e.type),
      unchanged: d.progress === before.progress && d.mistakes === before.mistakes,
    }
  })
  check('strings still play outside your turn',
    idle.emitted.includes('idleNote'), idle.emitted.join(','))
  check('…but do not affect the duel', idle.unchanged)

  // 9. THE ENDING. Win everything, walk onto the stage, press X, and confirm
  //    the show actually starts and the band walks on. This is the one path a
  //    player only ever reaches after twenty minutes of play, so it is the one
  //    most likely to be broken and never noticed.
  const finale = await page.evaluate(async () => {
    const g = window.__bb
    if (g.duel) { g.duel.dispose(); g.duel = null; g.hud.hideDuel() }
    g._setMode('play')
    for (const c of g.critters) {
      c.won = true
      c.star = false
      g.band[c.def.id] = { won: true, star: false }
    }
    g.player.teleport(0, 34)
    await new Promise((r) => setTimeout(r, 400))
    const promptBefore = document.querySelector('.bb-prompt')?.textContent || ''
    g._beginFinale()
    await new Promise((r) => setTimeout(r, 300))
    return {
      prompt: promptBefore,
      mode: g.mode,
      walking: g.critters.filter((c) => c.stageTarget).length,
      spots: g.store.bandSpots.length,
    }
  })
  check('stage prompt appears once the band is complete',
    /show/i.test(finale.prompt), JSON.stringify(finale.prompt))
  check('the show starts', finale.mode === 'finale', finale.mode)
  check('all six walk to a mic stand',
    finale.walking === 6 && finale.spots === 6, `${finale.walking}/6`)

  // Let them arrive, then confirm they actually got there and the end screen
  // eventually appears.
  const arrived = await page.evaluate(async () => {
    const g = window.__bb
    // The walk is damped per frame and SwiftShader runs at ~1fps, so nudge it
    // along with fixed steps rather than waiting on wall-clock time.
    for (let i = 0; i < 200; i++) g._updateCritters(0.1)
    g._finaleTime = 15
    g._updateFinale(0.1)
    return {
      onStage: g.critters.filter((c) => c.onStage).length,
      screen: document.querySelector('.bb-screen.show') !== null,
    }
  })
  check('the band reaches the stage', arrived.onStage === 6, `${arrived.onStage}/6`)
  check('the end screen appears', arrived.screen)

  // 10. no errors accumulated across all of that
  check('still no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))

  // 10. frame cost, for information only — SwiftShader, so relative at best.
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0
    const t0 = performance.now()
    const tick = () => {
      if (++n < 60) requestAnimationFrame(tick)
      else res(Math.round((n * 1000) / (performance.now() - t0)))
    }
    requestAnimationFrame(tick)
  }))
  console.log(`\n  (swiftshader fps: ${fps} — relative only, not a real device)`)

  // Scene cost. These ARE meaningful on any device: draw calls and triangle
  // count do not depend on the rasteriser.
  //
  // Measured from a FIXED worst-case viewpoint — the garden centre corner,
  // looking back up the long diagonal of the building with almost nothing
  // frustum-culled. Measuring "wherever the previous test happened to leave
  // the player" gives a number that moves every time the tests are reordered.
  // For reference, the spawn point renders at roughly a third of this.
  const stats = await page.evaluate(async () => {
    const g = window.__bb
    g.player.teleport(52, -40)
    g.camera.position.set(56, 12, -44)
    g.camera.lookAt(-40, 0, 40)
    g.renderer.render(g.scene, g.camera)
    const r = g.renderer
    return {
      calls: r.info.render.calls,
      tris: r.info.render.triangles,
      textures: r.info.memory.textures,
      geometries: r.info.memory.geometries,
      programs: r.info.programs?.length ?? 0,
    }
  })
  console.log(`  draw calls ${stats.calls} · ${(stats.tris / 1000).toFixed(0)}k tris · ` +
    `${stats.textures} textures · ${stats.geometries} geometries · ${stats.programs} programs`)
  check('draw calls stay reasonable', stats.calls < 600, `${stats.calls}`)

  // 11. co-op, on its own page: split-screen, the forklift, the flying banjo
  //     and a player-versus-player duel.
  console.log('')
  await coopChecks(browser, hosted)

  await finish(browser, hosted)
}

/**
 * Everything co-op, on a second page in split-screen.
 *
 * A session shape is chosen once and never changes, so this cannot ride the
 * solo page above — it needs its own boot. Split-screen is the right one to
 * test against because both players are real local Players with real input
 * slots, which means the forklift, the flying banjo and the player-versus-player
 * duel are all exercised end to end without a second browser or a live relay.
 */
async function coopChecks(browser, hosted) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(hosted.url)
  await page.waitForFunction(() => window.__bbStarted === true, null, { timeout: 90000 })
  await page.evaluate(() => document.querySelector('.bb-play')?.click())
  await page.waitForFunction(() => window.__bb.mode === 'join', null, { timeout: 15000 })
  await page.evaluate(() => document.querySelector('.bb-m-split')?.click())
  await page.waitForFunction(() => window.__bb.mode === 'play', null, { timeout: 15000 })

  const split = await page.evaluate(() => ({
    locals: window.__bb.localPlayers.length,
    viewports: window.__bb.viewportCount,
    cameras: window.__bb.cameras.length,
    skins: window.__bb.localPlayers.map((p) => p.skin.id),
    kb2: window.__bb.input._kb2,
    bar: getComputedStyle(document.querySelector('.bb-splitbar')).display,
  }))
  check('split-screen makes two players', split.locals === 2, `${split.locals}`)
  check('split-screen draws two viewports', split.viewports === 2, `${split.viewports}`)
  check('two cameras exist', split.cameras === 2)
  check('the two players look different', split.skins[0] !== split.skins[1], split.skins.join(' vs '))
  check('player 2 keyboard is armed', split.kb2 === true)
  check('the split bar is drawn', split.bar !== 'none', split.bar)

  // Each player answers only to their own keys: P1 on WASD, P2 on IJKL. This is
  // the check that catches the two halves of the keyboard bleeding into each
  // other, which is the failure mode that makes split-screen unplayable.
  //
  // Asserted on SPEED, not on distance travelled — the same reason gamepad.mjs
  // does. Split-screen renders twice a frame, SwiftShader gives us about one
  // frame a second, and Game clamps dt to 0.05s: a second of wall clock is a
  // tenth of a second of game time, so distance here measures the rasteriser.
  // Speed does not.
  await page.keyboard.down('KeyI')
  await page.waitForTimeout(1400)
  const speeds = await page.evaluate(() => window.__bb.localPlayers.map((p) => p.speed))
  await page.keyboard.up('KeyI')
  check('player 2 walks on IJKL', speeds[1] > 5, `${speeds[1].toFixed(1)} m/s`)
  check('player 1 ignores player 2’s keys', speeds[0] < 0.5, `${speeds[0].toFixed(1)} m/s`)

  // …and the other way round, so a passing pair cannot just mean "slot 1 reads
  // the whole keyboard and slot 0 reads nothing".
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(1400)
  const speeds2 = await page.evaluate(() => window.__bb.localPlayers.map((p) => p.speed))
  await page.keyboard.up('KeyW')
  check('player 1 walks on WASD', speeds2[0] > 5, `${speeds2[0].toFixed(1)} m/s`)
  check('player 2 ignores player 1’s keys', speeds2[1] < 0.5, `${speeds2[1].toFixed(1)} m/s`)

  // --- Big Earl ------------------------------------------------------------
  const drive = await page.evaluate(async () => {
    const g = window.__bb
    const f = g.forklift
    const p1 = g.localPlayers[0]
    const stick = (o) => ({
      moveY: 0, moveX: 0, jump: { down: false }, dance: { down: false },
      strum: { pressed: false }, ...o,
    })

    p1.teleport(f.pos.x + 2.5, f.pos.z)
    const near = f.pos.distanceTo(p1.pos)
    const got = f.enter(p1)

    // FIND a lane with room in it rather than trusting a hand-typed spot.
    //
    // The loading dock has pallets and bay doors in it, and two hardcoded start
    // points in a row silently turned this from a test of the drivetrain into a
    // test of whatever prop happened to be parked there. Same lesson, and the
    // same fix, as the critter standoff search in tools/shots.mjs: ask the world
    // instead of guessing at it.
    let lane = null
    let rolled = 0
    for (const x of [-30, -18, -14, -12, 6, -24, -6, 12]) {
      for (const h of [Math.PI / 2, -Math.PI / 2]) {
        f.pos.set(x, 0, -37)
        f.heading = h
        f.speed = 0
        f.lift = 0
        f._stuck = 0
        for (let i = 0; i < 90; i++) f.update(1 / 60, stick({ moveY: 1 }))
        const d = Math.hypot(f.pos.x - x, f.pos.z + 37)
        if (d > rolled) { rolled = d; lane = { x, h } }
        if (d > 3) break
      }
      if (rolled > 3) break
    }

    // Back to the start of that lane for everything below.
    const reset = () => {
      f.pos.set(lane ? lane.x : -30, 0, -37)
      f.heading = lane ? lane.h : Math.PI / 2
      f.speed = 0
      f._stuck = 0
    }
    reset()

    // The forks.
    for (let i = 0; i < 90; i++) f.update(1 / 60, stick({ jump: { down: true } }))
    const lifted = f.lift
    const plat = f.platform()

    // He must NOT be able to drive through the building. Aimed at a RACK RUN —
    // halfway between the aisle 4 and aisle 5 centrelines — not up an aisle,
    // because driving up an aisle is something a forklift is supposed to do.
    f.pos.set(-10.5, 0, -34)
    f.heading = 0
    f.speed = 0
    f._stuck = 0
    for (let i = 0; i < 180; i++) f.update(1 / 60, stick({ moveY: 1 }))
    const throughWall = Math.hypot(f.pos.x + 10.5, f.pos.z + 34)

    reset()
    return {
      near, got, rolled, lifted, throughWall, lane: lane ? lane.x : null,
      external: p1.externalControl, platTop: plat.top, hidden: !p1.group.visible,
    }
  })
  check('can climb into Big Earl', drive.got === true, `${drive.near.toFixed(1)}m away`)
  check('driving takes over the body', drive.external === true && drive.hidden === true)
  check('Big Earl actually moves', drive.rolled > 3,
    `${drive.rolled.toFixed(1)}m down the lane at x=${drive.lane}`)
  check('the forks go up', drive.lifted > 2, `${drive.lifted.toFixed(1)}m`)
  check('the forks are solid ground up there', drive.platTop > 2, `top at ${drive.platTop.toFixed(1)}m`)
  check('Big Earl cannot drive through the racking',
    drive.throughWall < 3, `${drive.throughWall.toFixed(1)}m into a solid rack run`)

  // A rider on the forks is carried, and can stand on them at height — the
  // whole point of two players and a forklift.
  const ride = await page.evaluate(() => {
    const g = window.__bb
    const f = g.forklift
    const p2 = g.localPlayers[1]
    const plat = f.platform()
    // Stand player 2 on the deck.
    p2.pos.set((plat.minX + plat.maxX) / 2, plat.top, (plat.minZ + plat.maxZ) / 2)
    const groundUnderP2 = p2.groundAt(p2.pos.x, p2.pos.z, p2.pos.y + 0.4)
    const before = { x: p2.pos.x, z: p2.pos.z }
    const startX = f.pos.x
    const startZ = f.pos.z
    // Drive a little, down the lane the search above found, and see whether the
    // rider comes with him.
    for (let i = 0; i < 60; i++) {
      f.update(1 / 60, {
        moveY: 1, moveX: 0, jump: { down: false }, dance: { down: false },
        strum: { pressed: false },
      })
      f.carry(g.localPlayers)
    }
    return {
      groundUnderP2, platTop: plat.top,
      forkMoved: Math.hypot(f.pos.x - startX, f.pos.z - startZ),
      carried: Math.hypot(p2.pos.x - before.x, p2.pos.z - before.z),
    }
  })
  check('a rider finds ground on the raised forks',
    Math.abs(ride.groundUnderP2 - ride.platTop) < 0.2,
    `ground ${ride.groundUnderP2.toFixed(2)} vs deck ${ride.platTop.toFixed(2)}`)
  check('a rider is carried when Big Earl drives',
    ride.carried > 0.5 && ride.carried > ride.forkMoved * 0.8,
    `rider ${ride.carried.toFixed(1)}m vs forklift ${ride.forkMoved.toFixed(1)}m`)

  const out = await page.evaluate(() => {
    const g = window.__bb
    g.forklift.exit()
    const p1 = g.localPlayers[0]
    return {
      driver: g.forklift.driver,
      external: p1.externalControl,
      visible: p1.group.visible,
      inSolid: (() => {
        const probe = { x: p1.pos.x, y: p1.pos.y, z: p1.pos.z }
        const before = { x: probe.x, z: probe.z }
        g.store.resolve(probe, 0.42, 1.75)
        return Math.hypot(probe.x - before.x, probe.z - before.z)
      })(),
    }
  })
  check('hopping out gives the body back',
    out.driver === null && out.external === false && out.visible === true)
  check('hopping out lands on clear floor', out.inSolid < 0.05, `pushed ${out.inSolid.toFixed(2)}m`)

  // X IN, X OUT — driven through the real loop with real key presses, because
  // this is the one part of the ride the direct-call tests above cannot see.
  //
  // The bug this catches: X is read twice per frame, once by _updateForklift
  // (does the driver want out?) and once by _updateInteraction (does anybody
  // want in?). Both see the same one-frame edge, and exit() drops you well
  // inside boarding range — so the press that got you out put you straight back
  // in, and X looked completely dead. Calling enter()/exit() directly, as every
  // check above does, cannot reproduce it: it only happens through the loop.
  await page.evaluate(() => {
    const g = window.__bb
    const f = g.forklift
    f.pos.set(-30, 0, -37)
    f.heading = Math.PI / 2
    f.speed = 0
    f.lift = 0
    // Clear the boarding cooldown the direct exit() above just armed.
    //
    // EXIT_COOLDOWN is 0.6 seconds of GAME time, and Game clamps dt to 0.05, so
    // on SwiftShader at roughly one frame a second it takes twelve real seconds
    // to expire. Waiting that out here would make the test slow and flaky, and
    // it is not what this check is about: a player walking up to a parked Earl
    // has no cooldown. The cooldown is exercised by the X-out half below, which
    // arms it for real and then proves you stay out.
    f._exitFor = 0
    g._exitedThisFrame = null
    g.localPlayers[0].teleport(f.pos.x + 2.2, f.pos.z)
  })
  await page.waitForTimeout(900)
  await hold(page, 'KeyE', 400)
  await page.waitForTimeout(1400)
  const gotIn = await page.evaluate(() => ({
    driving: window.__bb.forklift.driver === window.__bb.localPlayers[0],
    external: window.__bb.localPlayers[0].externalControl,
  }))
  check('X gets you into Big Earl (through the loop)', gotIn.driving && gotIn.external)

  // Wait for ENTER_GRACE to actually expire, rather than guessing at wall clock.
  //
  // It is 0.35 seconds of GAME time and Game clamps dt to 0.05, so on
  // SwiftShader at about a frame a second it takes seven REAL seconds to run
  // out. On a real device at 60fps it is 0.35s, as intended — the clamp only
  // bites below 20fps, which no actual phone does. Polling the condition is
  // both correct everywhere and fast where it can be.
  await page.waitForFunction(() => window.__bb.forklift._grace <= 0, null, { timeout: 40000 })
  await hold(page, 'KeyE', 400)
  await page.waitForTimeout(1400)
  const gotOut = await page.evaluate(() => ({
    driver: window.__bb.forklift.driver,
    external: window.__bb.localPlayers[0].externalControl,
    visible: window.__bb.localPlayers[0].group.visible,
  }))
  check('X gets you back OUT again, and you stay out',
    // Guarded on gotIn: "driver is null" is trivially true if boarding never
    // happened, and a check that passes when the feature never ran is worse
    // than no check.
    gotIn.driving && gotOut.driver === null && gotOut.external === false && gotOut.visible === true,
    `driver=${gotOut.driver === null ? 'none' : 'still aboard'}`)

  // --- the flying banjo ----------------------------------------------------
  const fly = await page.evaluate(async () => {
    const g = window.__bb
    const p = g.localPlayers[0]
    p.teleport(-16, 6)
    const bodyBefore = { ...p.pos }
    const what = p.toggleFlight()
    const startY = p.flight.pos.y
    // Hold "climb" for a couple of seconds of simulated time.
    for (let i = 0; i < 150; i++) {
      p.flight.update(1 / 60, {
        moveX: 0, moveY: 0, jump: { down: true }, dance: { down: false }, triggerL: 0, triggerR: 0,
      }, p.pos, 0)
    }
    const climbed = p.flight.pos.y - startY
    const fuelUsed = 1 - p.flight.fuel
    const bodyStayed = Math.hypot(p.pos.x - bodyBefore.x, p.pos.z - bodyBefore.z)

    // Now drain it dry and confirm it comes home on its own rather than
    // stranding the camera at the top of a rack.
    p.flight.fuel = 0.001
    for (let i = 0; i < 900 && p.flight.active; i++) {
      p.flight.update(1 / 60, {
        moveX: 0, moveY: 0, jump: { down: false }, dance: { down: false }, triggerL: 0, triggerR: 0,
      }, p.pos, 0)
    }
    return { what, climbed, fuelUsed, bodyStayed, stowed: !p.flight.active, anim: p.animState }
  })
  check('B launches the flying banjo', fly.what === 'launched')
  check('the banjo climbs', fly.climbed > 3, `${fly.climbed.toFixed(1)}m up`)
  check('flying burns the flight meter', fly.fuelUsed > 0.05, `used ${(fly.fuelUsed * 100) | 0}%`)
  check('the body stays put while it flies', fly.bodyStayed < 0.2, `${fly.bodyStayed.toFixed(2)}m`)
  check('an empty meter flies it home by itself', fly.stowed === true)

  // A chip well above head height is reachable ONLY by the banjo, which is the
  // entire reason the mode exists.
  const grab = await page.evaluate(async () => {
    const g = window.__bb
    const p = g.localPlayers[0]
    p.flight.stow()
    p.flight.fuel = 1
    p.teleport(-16, 6)
    // Plant a fresh chip 6m up, out of jump range.
    const idx = g.pickups.findIndex((x) => x.taken && x.kind === 'chip')
    const item = g.pickups[idx >= 0 ? idx : 0]
    item.taken = false
    item.x = p.pos.x
    item.z = p.pos.z
    item.baseY = p.pos.y + 6
    const chipsBefore = g.chips
    p.toggleFlight()
    p.flight.pos.set(item.x, item.baseY, item.z)
    g._updatePickups(1 / 60)
    return { taken: item.taken, gained: g.chips - chipsBefore, kind: item.kind }
  })
  check('the flying banjo collects what you cannot jump to',
    grab.taken === true, `kind=${grab.kind}, chips +${grab.gained}`)

  // --- player versus player ------------------------------------------------
  const pvp = await page.evaluate(async () => {
    const g = window.__bb
    const [p1, p2] = g.localPlayers
    p1.flight.stow()
    p2.flight.stow()
    p1.teleport(-16, 6)
    p2.teleport(-16, 7.4)
    const rival = g._nearestRival(p1)
    g._beginPvp(p1, p2)
    const started = g.mode
    const viewports = g.viewportCount
    const d = g.pvp
    // Walk the whole machine deterministically rather than through the loop,
    // which on SwiftShader would take most of a minute.
    d.update(3.0)                       // out of the intro, into the first call
    const afterIntro = d.state
    const caller = d.caller
    // The caller improvises this round's notes…
    const phraseLen = d.roundLength
    for (let i = 0; i < phraseLen; i++) d.pressNote(caller, i % 4)
    d.update(2.0)                       // handover -> echo
    const echoing = d.state
    // …and the other one plays them straight back, correctly.
    const phrase = d.phrase.slice()
    for (const n of phrase) d.pressNote(1 - caller, n)
    const goodState = d.state
    d.update(2.0)                       // roles swap, phrase grows
    const grew = d.roundLength > phraseLen
    const swapped = d.caller !== caller

    // Now make the echoing player lose every string and confirm somebody wins.
    let guard = 0
    while (d.state !== 'won' && d.state !== 'done' && guard++ < 200) {
      if (d.state === 'call') {
        for (let i = 0; i < d.roundLength; i++) d.pressNote(d.caller, 0)
      } else if (d.state === 'echo') {
        // Deliberately wrong: the phrase is all string 0, so play string 1.
        d.pressNote(1 - d.caller, 1)
      }
      d.update(2.0)
    }
    const won = d.state === 'won' || d.state === 'done'
    const winner = d.winner
    const loserStrings = d.loser >= 0 ? d.strings[d.loser] : -1
    d.update(4.0)
    const done = d.state
    g._endPvp('finished')
    return {
      rivalFound: rival === p2, started, viewports, afterIntro, echoing, goodState,
      grew, swapped, won, winner, loserStrings, done,
      backToPlay: g.mode, cleared: g.pvp === null,
      viewportsAfter: g.viewportCount,
    }
  })
  check('another player is a duel target', pvp.rivalFound === true)
  check('pressing X on a player starts a duel', pvp.started === 'pvp', pvp.started)
  check('a duel un-splits the screen', pvp.viewports === 1, `${pvp.viewports}`)
  check('the duel opens with a call', pvp.afterIntro === 'call', pvp.afterIntro)
  check('the caller improvises, then hands over', pvp.echoing === 'echo', pvp.echoing)
  check('a correct echo wins the exchange', pvp.goodState === 'good', pvp.goodState)
  check('the phrase grows and the roles swap', pvp.grew && pvp.swapped)
  check('wrong notes cost strings, and somebody wins', pvp.won === true)
  check('the loser is the one who ran out',
    pvp.loserStrings === 0 && pvp.winner >= 0, `winner=${pvp.winner}`)
  check('the duel ends and hands the store back',
    pvp.done === 'done' && pvp.backToPlay === 'play' && pvp.cleared === true)
  check('the screen splits again afterwards', pvp.viewportsAfter === 2, `${pvp.viewportsAfter}`)

  check('no console errors in co-op', errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
}

async function hold(page, key, ms) {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
}

async function finish(browser, hosted) {
  await browser.close()
  if (hosted.server) hosted.server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
