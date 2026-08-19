// tools/shots.mjs — take screenshots of the built game, so somebody can LOOK
// at it. A passing smoke test proves the machine runs; it proves nothing at
// all about whether the store reads as a store or the raccoon reads as a
// raccoon.
//
//   npx vite build && node tools/shots.mjs [OUT=shots] [scene…]
//
// SwiftShader renders these on the CPU, so they are slow but pixel-accurate —
// what you see here is what a real GPU draws.

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const OUT = process.env.OUT || 'shots'
const only = process.argv.slice(2)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

/**
 * Each shot parks the camera by hand rather than flying the player there:
 * deterministic framing means two runs are diffable.
 */
const SHOTS = {
  title: {
    desc: 'The title screen, orbiting the stage',
    setup: async (page) => { await page.waitForTimeout(2500) },
  },
  spawn: {
    desc: 'Where you start — the middle of the sales floor',
    play: true,
    cam: [[-5, 4.5, 34], [-5, 1.5, 6]],
  },
  aisle: {
    desc: 'Down aisle 1, looking at the racking and the climbable pallets',
    play: true,
    cam: [[-38, 3.2, 20], [-38, 1.5, -20]],
  },
  // teleport() faces him at -Z, so the camera goes at a LOWER z to see his
  // front. Framing him from behind shows the back of a pair of dungarees and
  // hides the banjo entirely, which is the whole subject of the shot.
  billybob: {
    desc: 'Billy Bob Joe Bob and the chocolate banjo, close up',
    play: true,
    at: [-5, 20],
    cam: [[-3.9, 1.85, 16.6], [-5, 1.3, 20]],
  },
  raccoon: {
    desc: 'Ricky Raccoon on his pallet stack in the cereal aisle',
    play: true,
    critter: 0,
  },
  goat: { desc: 'Doris the Goat in the garden centre', play: true, critter: 1 },
  penguin: { desc: 'Chilly Pete in the freezer aisle', play: true, critter: 2 },
  pug: { desc: 'Meatball in the food court', play: true, critter: 3 },
  pigeon: { desc: 'Sir Reginald at the television wall', play: true, critter: 4 },
  owl: { desc: 'Wanda the owl at the loading dock', play: true, critter: 5 },
  forklift: { desc: 'Big Earl, parked and drivable', play: true, forklift: true },
  flying: { desc: 'The flying banjo, up among the racking', play: true, flying: true },
  split: { desc: 'Two-player split screen', play: true, split: true },
  rotisserie: {
    desc: 'The rotisserie — the hottest thing in the store',
    play: true,
    cam: [[42, 4.5, 30], [50, 2.5, 40]],
  },
  freezer: {
    desc: 'Frosty Foods, where the banjo re-freezes',
    play: true,
    cam: [[-43.5, 3.5, -10], [-52, 1.5, 6]],
  },
  stage: {
    desc: 'The Free Sample Stage at the front of the store',
    play: true,
    cam: [[0, 5.5, 31], [0, 2, 42]],
  },
  wide: {
    desc: 'The whole building from up in the rafters',
    play: true,
    cam: [[46, 10.5, -40], [-20, 0, 30]],
  },
  duel: {
    desc: 'A duel in progress, with the HUD',
    play: true,
    duel: 0,
  },
  melting: {
    desc: 'The banjo half melted — note the drooping neck',
    play: true,
    at: [-5, 20],
    melt: 0.85,
    cam: [[-3.9, 1.85, 16.6], [-5, 1.3, 20]],
  },
  spawnview: {
    desc: 'The default follow camera at the spawn point',
    play: true,
  },
  finale: {
    desc: 'The whole band on the Free Sample Stage',
    play: true,
    finale: true,
    cam: [[0, 6.5, 26], [0, 2.4, 39]],
  },
}

async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const p = req.url.split('?')[0]
      const f = join(ROOT, p === '/' ? 'index.html' : decodeURIComponent(p))
      res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
      res.end(await readFile(f))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => server.listen(0, r))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const hosted = await serve()
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  })

  const names = only.length ? only : Object.keys(SHOTS)
  for (const name of names) {
    const shot = SHOTS[name]
    if (!shot) { console.log(`  ?  unknown shot: ${name}`); continue }

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto(hosted.url)
    await page.waitForFunction(() => window.__bbStarted === true, null, { timeout: 90000 })

    if (shot.play) {
      await page.evaluate(() => document.querySelector('.bb-play')?.click())
      await page.waitForFunction(() => window.__bb.mode === 'join', null, { timeout: 15000 })
      await page.evaluate((split) => {
        document.querySelector(split ? '.bb-m-split' : '.bb-m-solo')?.click()
      }, !!shot.split)
      await page.waitForFunction(() => window.__bb.mode === 'play', null, { timeout: 15000 })
      await page.waitForTimeout(600)
    }

    if (shot.setup) await shot.setup(page)

    // --- phase 1: set up game state, WITH the loop still running -----------
    // Starting a duel needs frames to tick: the intro dwell and the first call
    // note only happen inside update().
    const args = {
      at: shot.at, melt: shot.melt, critter: shot.critter, duel: shot.duel, finale: shot.finale,
      forklift: shot.forklift, flying: shot.flying, split: shot.split,
    }
    await page.evaluate((s) => {
      const g = window.__bb
      if (s.at) g.player.teleport(s.at[0], s.at[1])

      // Critter and duel shots deliberately do NOT hand-place the camera.
      // Every critter stands somewhere different — up on the racking, in a
      // freezer aisle, against the TV wall — so one fixed offset frames a wall
      // of boxes for half of them. `faceDuel` + the game's own follow camera is
      // both correct everywhere AND the framing a player actually sees.
      if (s.finale) {
        // Hand-win every duel and start the show.
        for (const c of g.critters) {
          c.won = true
          c.star = true
          g.band[c.def.id] = { won: true, star: true }
        }
        g.hud.setBand(g.band)
        g.player.teleport(0, 34)
        g._beginFinale()
      }

      if (s.critter !== undefined || s.duel !== undefined) {
        const c = g.critters[s.critter !== undefined ? s.critter : s.duel]
        const p = c.rig.group.position

        // Find a standoff spot that is actually clear, rather than guessing a
        // direction. Guessing ("approach along Z if the critter is near the
        // middle") put the player inside the racking for every critter up an
        // aisle. Ask the collision grid instead: try eight directions and take
        // the first that resolve() does not have to push us out of.
        let best = null
        for (let i = 0; i < 8 && !best; i++) {
          const a = (i / 8) * Math.PI * 2
          const tx = p.x + Math.cos(a) * 4.2
          const tz = p.z + Math.sin(a) * 4.2
          const probe = { x: tx, y: g.store.groundHeight(tx, tz, 3), z: tz }
          const before = { x: probe.x, z: probe.z }
          // resolve() takes a Vector3-like and mutates it in place.
          g.store.resolve(probe, 0.42, 1.75)
          if (Math.hypot(probe.x - before.x, probe.z - before.z) < 0.05) {
            best = before
          }
        }
        const spot = best || { x: p.x, z: p.z + 4.2 }
        g.player.teleport(spot.x, spot.z)
        g.player.faceDuel(p)
        if (s.duel !== undefined) g._beginDuel(c)
      }

      // Big Earl: stand the player next to him, climb in, and raise the forks
      // so the shot shows the thing that is actually new about him.
      if (s.forklift) {
        const f = g.forklift
        g.player.teleport(f.pos.x + 4, f.pos.z + 2)
        g.forklift.enter(g.player)
        g.forklift.lift = 3.2
      }

      // The flying banjo, up level with the loaded racking.
      if (s.flying) {
        g.player.teleport(-16, 0)
        g.player.toggleFlight()
        g.player.flight.pos.set(-16, 6.4, 4)
      }

      // Split screen: put the two of them somewhere with something to look at,
      // rather than both on the spawn pad standing in each other.
      if (s.split) {
        // One in an aisle, one out in the open strip by the checkouts. Both had
        // been put in aisles, and the follow camera's 2.6m minimum boom against
        // an eight-metre aisle sign filled player 2's whole viewport with the
        // word BEANS.
        g.localPlayers[0].teleport(-16, 6)
        if (g.localPlayers[1]) g.localPlayers[1].teleport(-8, 28)
      }
    }, args)

    // Let the world settle: the duel intro, the melt meter, the follow camera.
    await page.waitForTimeout(shot.duel !== undefined ? 2600 : shot.finale ? 9000 : 700)

    // --- phase 2: park the loop, then frame the shot -----------------------
    // Player._placeCamera runs every frame and will happily overwrite anything
    // set here. Without stopping the loop first, every shot silently comes out
    // as the default follow camera — which is exactly the failure this tool
    // exists to catch, and did catch.
    await page.evaluate((s) => {
      const g = window.__bb
      if (g._raf) { cancelAnimationFrame(g._raf); g._raf = null }

      // The band's walk-on is damped per frame, and SwiftShader gives us about
      // one frame a second — so a wall-clock wait photographs them halfway
      // there, scattered across the concrete. Pump the walk with fixed steps.
      if (s.finale) for (let i = 0; i < 200; i++) g._updateCritters(0.1)
      if (s.melt !== undefined) {
        g.player.melt = s.melt
        g.player.rig.banjo.setMelt(s.melt)
        g.hud.setMelt(s.melt)
      }
      // Settle the follow camera by hand.
      //
      // It is exponentially damped, and SwiftShader renders at about ONE frame
      // per second — so "wait 700ms and screenshot" gives the camera a single
      // frame of damping and photographs it 20% of the way to where it should
      // be, which is usually inside a shelf. Pumping _placeCamera with a large
      // dt converges it in a few calls and is deterministic besides.
      if (s.cam) {
        g.camera.position.set(s.cam[0][0], s.cam[0][1], s.cam[0][2])
        g.camera.lookAt(s.cam[1][0], s.cam[1][1], s.cam[1][2])
      } else if (s.forklift) {
        for (let i = 0; i < 30; i++) g._placeDriveCamera(0.5, g.camera, g.player)
      } else if (s.flying) {
        for (let i = 0; i < 30; i++) g.player._placeFlightCamera(0.5, g.camera)
      } else if (s.split) {
        // One camera per viewport, each settled on its own player.
        for (let v = 0; v < g.localPlayers.length; v++) {
          for (let i = 0; i < 30; i++) g.localPlayers[v]._placeCamera(0.5, g.cameras[v])
        }
      } else {
        for (let i = 0; i < 30; i++) g.player._placeCamera(0.5, g.camera)
      }
      // _render, not renderer.render: it is the only thing that knows about
      // viewports, and a split-screen shot taken with a bare render() comes out
      // as one full-screen view of player 1 — which looks fine and is wrong.
      g._render()
    }, { ...args, cam: shot.cam })

    // A second render after a beat: the first may still be uploading a
    // texture, and a half-uploaded texture is grey.
    await page.waitForTimeout(400)
    await page.evaluate(() => window.__bb._render())

    const file = join(OUT, `${name}.png`)
    await page.screenshot({ path: file })
    console.log(`  ✓ ${file.padEnd(28)} ${shot.desc}`)
    await page.close()
  }

  await browser.close()
  hosted.server.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
