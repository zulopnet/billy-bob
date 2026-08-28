// Do the recorded beds actually reach the speakers in the BUILT game?
// The fallback in _startBed is silent by design — a bed whose file never
// arrived sounds like the old synthesised arrangement, not like a bug — so
// "the music plays" is no evidence at all. This asserts the buffer source.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'dist')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' }

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0]
    const file = join(ROOT, path === '/' ? 'index.html' : decodeURIComponent(path))
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404).end('not found') }
})
await new Promise(r => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push('pageerror: ' + e.message))
const requested = []
page.on('request', r => { if (/\.(ogg|m4a)/.test(r.url())) requested.push(r.url().split('/').pop()) })

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__bbStarted === true, null, { timeout: 90000 })
await page.click('canvas', { position: { x: 10, y: 10 } }).catch(() => {})
await page.evaluate(() => document.querySelector('.bb-play')?.click())
await page.waitForFunction(() => window.__bb.mode === 'join', null, { timeout: 15000 })
await page.evaluate(() => document.querySelector('.bb-m-solo')?.click())
await page.waitForFunction(() => window.__bb.mode === 'play', null, { timeout: 15000 })

await page.waitForFunction(() => window.__bb.audio._bedSource !== null, null, { timeout: 20000 })
  .catch(() => {})

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// Every bed: the file loaded, it loops, it is the mono we shipped, and the
// generated arrangement it replaces is NOT also running.
for (const bed of ['store', 'duel', 'finale']) {
  await page.evaluate((b) => window.__bb.audio.setMusic(b, { intensity: 1 }), bed)
  await page.waitForFunction(
    () => window.__bb.audio._bedSource !== null, null, { timeout: 20000 }).catch(() => {})
  const r = await page.evaluate(() => {
    const a = window.__bb.audio
    return {
      playing: !!a._bedSource,
      loop: a._bedSource ? a._bedSource.loop : null,
      duration: a._bedSource ? +a._bedSource.buffer.duration.toFixed(2) : null,
      channels: a._bedSource ? a._bedSource.buffer.numberOfChannels : null,
      failed: [...a._bedFailed],
      patternRunning: a._timer !== null,
      gain: a._bedGain ? +a._bedGain.gain.value.toFixed(3) : null,
    }
  })
  check(`${bed}: recording is playing, not the fallback`, r.playing && !r.failed.includes(bed),
    r.playing ? `${r.duration}s` : `failed=[${r.failed}]`)
  check(`${bed}: it loops`, r.loop === true)
  check(`${bed}: mono, as shipped`, r.channels === 1, `${r.channels}ch`)
  check(`${bed}: the generated pattern is stopped`, r.patternRunning === false)
  check(`${bed}: level is the measured one`, r.gain > 0.3 && r.gain < 2, `${r.gain}`)
}

// Intensity must ride the bed's level, and slowly.
await page.evaluate(() => window.__bb.audio.setMusic('store', { intensity: 1 }))
await page.waitForTimeout(1600)
const loud = await page.evaluate(() => +window.__bb.audio._bedGain.gain.value.toFixed(3))
await page.evaluate(() => window.__bb.audio.setMusic('store', { intensity: 0.5 }))
await page.waitForTimeout(1600)
const quiet = await page.evaluate(() => +window.__bb.audio._bedGain.gain.value.toFixed(3))
check('intensity rides the bed level', quiet < loud, `0.5 -> ${quiet}, 1.0 -> ${loud}`)

// Ducking has to reach the bed, or the duel countdown plays over full music.
await page.evaluate(() => window.__bb.audio.duckMusic(0.3))
await page.waitForTimeout(900)
const ducked = await page.evaluate(() => +window.__bb.audio._musicGain.gain.value.toFixed(4))
await page.evaluate(() => window.__bb.audio.unduckMusic())
await page.waitForTimeout(1200)
const unducked = await page.evaluate(() => +window.__bb.audio._musicGain.gain.value.toFixed(4))
check('duckMusic still reaches the bed', ducked < unducked, `${ducked} -> ${unducked}`)

// A bed with no file must hand back to its generated pattern rather than go silent.
await page.evaluate(() => {
  const a = window.__bb.audio
  a.stopMusic()
  a._bedFailed.add('store')
})
await page.evaluate(() => window.__bb.audio.setMusic('store', { intensity: 1 }))
await page.waitForTimeout(300)
const fallback = await page.evaluate(() => {
  const a = window.__bb.audio
  return { bed: !!a._bedSource, pattern: a._timer !== null }
})
check('a missing bed falls back to its pattern', !fallback.bed && fallback.pattern)

check('no console errors', errs.length === 0, errs.join(' | '))

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
console.log('media requested:', requested.length ? requested.join(', ') : '(none)')

await browser.close()
server.close()
process.exit(passed === results.length ? 0 : 1)
