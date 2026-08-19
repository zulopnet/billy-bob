// main.js — boot.
//
// Deliberately tiny and deliberately defensive. Everything interesting is in
// Game; this file exists to get from a blank page to a running game and, if
// that fails, to say so on screen rather than leaving a boot splash spinning
// forever over a silent exception.

import { Game } from './game/Game.js'

const bootEl = document.getElementById('boot')
const barEl = document.getElementById('boot-bar')
const msgEl = document.getElementById('boot-msg')
const fatalEl = document.getElementById('fatal')
const fatalMsg = document.getElementById('fatal-msg')

/** Breadcrumbs, so a fatal error can report how far it got. */
const steps = []

function progress(frac, msg) {
  if (barEl) barEl.style.width = `${Math.round(frac * 100)}%`
  if (msgEl && msg) msgEl.textContent = msg
  if (msg) steps.push(`${(performance.now() | 0)}ms ${msg}`)
}

function fatal(err) {
  const text = err && err.stack ? err.stack : String(err)
  if (fatalMsg) fatalMsg.textContent = `${text}\n\n--- got as far as ---\n${steps.join('\n')}`
  if (fatalEl) fatalEl.style.display = 'flex'
  if (bootEl) bootEl.classList.add('hidden')
  console.error('[billy-bob] fatal', err)
}

// A module that throws during evaluation never reaches the code below, so the
// handlers go on first.
window.addEventListener('error', (e) => {
  if (!window.__bbStarted) fatal(e.error || e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  if (!window.__bbStarted) fatal(e.reason)
})

async function main() {
  const canvas = document.getElementById('game')
  if (!canvas) throw new Error('no #game canvas')

  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  if (!gl) {
    throw new Error(
      'This game needs WebGL, and this browser has it switched off or unavailable.',
    )
  }

  const game = new Game(canvas)
  // Exposed for the smoke tests in tools/ — they drive the game through this.
  window.__bb = game

  await game.boot(progress)
  game.start()
  window.__bbStarted = true

  // Only now, with a real frame on the screen, does the splash come down.
  if (bootEl) {
    bootEl.classList.add('hidden')
    window.setTimeout(() => bootEl.remove(), 700)
  }
}

main().catch(fatal)
