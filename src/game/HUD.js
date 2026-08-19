// game/HUD.js — every pixel of interface, in the DOM.
//
// DOM rather than canvas because this game is read by somebody who is learning
// to read: crisp system text at any DPI, real CSS transitions for the feedback
// flashes, and no font atlas to build. It also means the touch layer (z-index 9)
// sits UNDER the menus (z-index 10) and they stay tappable for free.
//
// Everything the player must understand at a glance is a COLOUR and a SHAPE
// first, and a word second. The four strings are the four Xbox face-button
// colours everywhere they appear, in the same left-to-right order, always.

import { STRING_COLORS } from '../core/Audio.js'
import { CRITTERS } from '../chars/Rigs.js'
import { START_STRINGS } from './PvpDuel.js'

const CSS = `
.bb-root {
  position: fixed; inset: 0; z-index: 10; pointer-events: none;
  font-family: 'Baloo 2', 'Trebuchet MS', system-ui, -apple-system, sans-serif;
  color: #fff5e6; -webkit-user-select: none; user-select: none;
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
}
.bb-root * { box-sizing: border-box; }

/* --- top-left cluster: melt meter + chips ------------------------------- */
.bb-topleft {
  position: absolute; top: calc(14px + var(--safe-t)); left: calc(14px + var(--safe-l));
  display: flex; flex-direction: column; gap: 8px;
}
.bb-panel {
  background: rgba(28, 16, 8, 0.62); border: 2px solid rgba(255, 213, 150, 0.3);
  border-radius: 14px; padding: 8px 12px; backdrop-filter: blur(4px);
}
/* 250px, not 190: "🍫 Banjo" and "MELTING! RUN!" are the two widest labels and
   at 190 they met in the middle and read as one run-on word. */
.bb-melt { min-width: 250px; }
.bb-melt .lab {
  font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.8; margin-bottom: 5px;
  display: flex; justify-content: space-between; gap: 14px; white-space: nowrap;
}
.bb-melt .bar {
  height: 13px; border-radius: 999px; background: rgba(0,0,0,0.42); overflow: hidden;
  box-shadow: inset 0 2px 5px rgba(0,0,0,0.4);
}
.bb-melt .bar > i {
  display: block; height: 100%; width: 0%; border-radius: 999px;
  background: linear-gradient(90deg, #6fd0f0 0%, #ffd97a 55%, #ef4a4a 100%);
  transition: width 0.18s linear;
}
.bb-melt.hot { animation: bb-pulse 0.5s ease-in-out infinite; border-color: #ef4a4a; }
@keyframes bb-pulse { 50% { background: rgba(120, 30, 10, 0.75); } }

.bb-chips { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 800; }
.bb-chips span { font-size: 24px; }

/* --- band roster, top-right --------------------------------------------- */
.bb-band {
  position: absolute; top: calc(14px + var(--safe-t)); right: calc(120px + var(--safe-r));
  display: flex; gap: 6px;
}
.bb-badge {
  width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center;
  font-size: 22px; background: rgba(28,16,8,0.6); border: 2px solid rgba(255,255,255,0.16);
  filter: grayscale(1) brightness(0.5); transition: all 0.35s ease; position: relative;
}
.bb-badge.got { filter: none; border-color: #f5d130; box-shadow: 0 0 14px rgba(245,209,48,0.5); }
.bb-badge .star {
  position: absolute; bottom: -6px; right: -4px; font-size: 13px;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6));
}

/* --- objective, bottom-left --------------------------------------------- */
.bb-goal {
  position: absolute; bottom: calc(16px + var(--safe-b)); left: calc(14px + var(--safe-l));
  max-width: min(420px, 46vw); font-size: 15px; line-height: 1.4;
}
.bb-goal b { color: #ffd97a; }

/* --- interact prompt, centre-bottom ------------------------------------- */
.bb-prompt {
  position: absolute; left: 50%; bottom: calc(20% + var(--safe-b));
  transform: translate(-50%, 0) scale(0.9);
  display: flex; align-items: center; gap: 12px; padding: 10px 20px;
  background: rgba(28,16,8,0.78); border: 2px solid #ffd97a; border-radius: 999px;
  font-size: 19px; font-weight: 700; opacity: 0; transition: all 0.2s ease;
  white-space: nowrap;
}
.bb-prompt.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
.bb-key {
  display: inline-grid; place-items: center; min-width: 34px; height: 34px; padding: 0 8px;
  border-radius: 10px; background: #4aa8ef; color: #08121c; font-weight: 900; font-size: 17px;
  border: 2px solid rgba(255,255,255,0.55);
}

/* --- toast -------------------------------------------------------------- */
.bb-toasts {
  position: absolute; top: calc(84px + var(--safe-t)); left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.bb-toast {
  padding: 9px 20px; border-radius: 999px; font-size: 17px; font-weight: 700;
  background: rgba(28,16,8,0.8); border: 2px solid rgba(255,213,150,0.45);
  animation: bb-toast-in 0.3s ease backwards;
  transition: opacity 0.4s ease, transform 0.4s ease;
}
.bb-toast.out { opacity: 0; transform: translateY(-14px); }
@keyframes bb-toast-in { from { opacity: 0; transform: translateY(16px) scale(0.9); } }

/* --- the duel ----------------------------------------------------------- */
.bb-duel {
  position: absolute; inset: 0; display: none; flex-direction: column;
  align-items: center; justify-content: flex-end;
  padding-bottom: calc(18px + var(--safe-b));
  background: linear-gradient(to bottom, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 24%,
              rgba(0,0,0,0) 58%, rgba(0,0,0,0.5) 100%);
}
.bb-duel.show { display: flex; }
.bb-duel-top {
  position: absolute; top: calc(18px + var(--safe-t)); left: 50%; transform: translateX(-50%);
  text-align: center; width: min(680px, 92vw);
}
.bb-duel-name { font-size: clamp(20px, 3.6vw, 34px); font-weight: 900; text-shadow: 0 3px 0 #4a2a12; }
.bb-duel-round { font-size: 14px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.8; }
.bb-duel-state {
  margin-top: 10px; font-size: clamp(22px, 4.4vw, 42px); font-weight: 900;
  text-shadow: 0 3px 0 rgba(0,0,0,0.4); transition: color 0.2s ease;
}
.bb-duel-state.listen { color: #ffd97a; }
.bb-duel-state.your-turn { color: #57d96a; animation: bb-bounce 0.7s ease-in-out infinite; }
.bb-duel-state.oops { color: #ef4a4a; }
.bb-duel-state.yay { color: #f5d130; animation: bb-bounce 0.4s ease-in-out infinite; }
@keyframes bb-bounce { 50% { transform: translateY(-7px) scale(1.04); } }

/* The phrase, as pips. Filled = played, hollow = still to come. */
.bb-pips { display: flex; gap: 9px; justify-content: center; margin-top: 12px; }
.bb-pip {
  width: 22px; height: 22px; border-radius: 50%; background: rgba(255,255,255,0.14);
  border: 2px solid rgba(255,255,255,0.34); transition: all 0.16s ease;
}
.bb-pip.done { transform: scale(1.15); border-color: #fff; }
.bb-pip.now { box-shadow: 0 0 0 5px rgba(255,255,255,0.28); transform: scale(1.3); }

/* The four strings. This row is the single most important thing on screen. */
.bb-strings { display: flex; gap: clamp(10px, 2.4vw, 26px); }
.bb-string {
  width: clamp(62px, 11vw, 104px); height: clamp(62px, 11vw, 104px); border-radius: 50%;
  display: grid; place-items: center; position: relative;
  border: 4px solid rgba(255,255,255,0.6); background: rgba(20,12,6,0.55);
  transition: transform 0.09s ease, box-shadow 0.16s ease, background 0.16s ease;
}
.bb-string .btn {
  font-size: clamp(26px, 4.6vw, 44px); font-weight: 900; color: #fff;
  text-shadow: 0 2px 4px rgba(0,0,0,0.6);
}
.bb-string .num {
  position: absolute; bottom: 6px; font-size: 12px; opacity: 0.7; font-weight: 700;
}
.bb-string.lit { transform: scale(1.18); }
.bb-string.lit-critter { animation: none; }

/* Timer bar under the strings — only visible during the response. */
.bb-timer {
  width: min(440px, 76vw); height: 8px; border-radius: 999px; margin-top: 14px;
  background: rgba(0,0,0,0.4); overflow: hidden; opacity: 0; transition: opacity 0.25s ease;
}
.bb-timer.show { opacity: 1; }
.bb-timer > i {
  display: block; height: 100%; width: 100%; border-radius: 999px; background: #57d96a;
  transition: width 0.1s linear, background 0.4s ease;
}
.bb-timer.low > i { background: #ef4a4a; }

/* --- full-screen panels: title, pause, finale --------------------------- */
.bb-screen {
  position: absolute; inset: 0; display: none; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px; padding: 24px;
  text-align: center; pointer-events: auto;
  background: radial-gradient(circle at 50% 34%, rgba(217,160,91,0.94) 0%,
              rgba(122,58,24,0.96) 46%, rgba(26,14,6,0.98) 100%);
  overflow-y: auto;
}
.bb-screen.show { display: flex; }
.bb-screen h1 {
  margin: 0; font-size: clamp(26px, 6vw, 68px); font-weight: 900; line-height: 1.05;
  text-shadow: 0 6px 0 #3a1f0c, 0 12px 26px rgba(0,0,0,0.45);
}
.bb-screen h2 {
  margin: 0; font-size: clamp(14px, 2.8vw, 26px); font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.85;
}
.bb-screen p { margin: 0; max-width: 640px; font-size: clamp(14px, 2.1vw, 19px); line-height: 1.55; }
.bb-btn {
  pointer-events: auto; cursor: pointer; font: inherit;
  padding: 14px 40px; border-radius: 999px; border: 3px solid #fff5e6;
  background: linear-gradient(180deg, #ffb43c, #e8801e);
  color: #2a1408; font-size: clamp(18px, 3vw, 26px); font-weight: 900;
  letter-spacing: 0.04em; box-shadow: 0 6px 0 #8a4a12, 0 10px 24px rgba(0,0,0,0.35);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.bb-btn:hover, .bb-btn.sel { transform: translateY(-3px); box-shadow: 0 9px 0 #8a4a12, 0 14px 28px rgba(0,0,0,0.4); }
.bb-btn:active { transform: translateY(3px); box-shadow: 0 3px 0 #8a4a12; }

.bb-controls {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 20px; max-width: 640px; width: 100%;
  font-size: clamp(12px, 1.8vw, 15px); text-align: left;
}
.bb-controls div { display: flex; align-items: center; gap: 9px; }
.bb-pad {
  display: inline-grid; place-items: center; min-width: 27px; height: 27px; padding: 0 7px;
  border-radius: 8px; font-weight: 900; font-size: 14px; color: #12080a;
  background: #fff5e6; border: 2px solid rgba(0,0,0,0.25); flex: none;
}
.bb-pad.a { background: #57d96a; } .bb-pad.b { background: #ef4a4a; }
.bb-pad.x { background: #4aa8ef; } .bb-pad.y { background: #f5d130; }

.bb-padstate { font-size: 14px; opacity: 0.85; display: flex; align-items: center; gap: 8px; }
.bb-dot { width: 10px; height: 10px; border-radius: 50%; background: #888; }
.bb-dot.on { background: #57d96a; box-shadow: 0 0 10px #57d96a; }

.bb-roster { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; max-width: 700px; }
.bb-roster .card {
  width: 106px; padding: 10px 6px; border-radius: 14px; background: rgba(0,0,0,0.3);
  border: 2px solid rgba(255,255,255,0.2); font-size: 12px; line-height: 1.3;
}
.bb-roster .card .em { font-size: 30px; display: block; margin-bottom: 4px; }
.bb-roster .card.got { border-color: #f5d130; background: rgba(245,209,48,0.14); }

/* --- per-player stacks --------------------------------------------------
   One of these per LOCAL player. In split-screen the second one is pushed to
   the top of the lower half by --pstack-top, so each player's meters sit inside
   their own viewport rather than both piling up in one corner. */
.bb-pstack {
  position: absolute; left: calc(14px + var(--safe-l));
  top: calc(14px + var(--safe-t) + var(--pstack-top, 0px));
  display: flex; flex-direction: column; gap: 6px;
}
.bb-pstack.hide { display: none; }
.bb-pname {
  font-size: 12px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 2px 10px; border-radius: 999px; align-self: flex-start;
  background: rgba(28,16,8,0.72); border: 2px solid currentColor;
}
/* Only shown when there is more than one player: a solo player knows who they are. */
.bb-pname.solo { display: none; }

/* The flight meter. Same shape as the melt meter and deliberately a different
   colour, because they mean opposite things: melt filling up is bad, flight
   filling up is good. */
.bb-flight { min-width: 250px; display: none; }
.bb-flight.show { display: block; }
.bb-flight .lab {
  font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.8; margin-bottom: 5px;
  display: flex; justify-content: space-between; gap: 14px; white-space: nowrap;
}
.bb-flight .bar {
  height: 13px; border-radius: 999px; background: rgba(0,0,0,0.42); overflow: hidden;
  box-shadow: inset 0 2px 5px rgba(0,0,0,0.4);
}
.bb-flight .bar > i {
  display: block; height: 100%; width: 0%; border-radius: 999px;
  background: linear-gradient(90deg, #8a5a1e 0%, #ffd27a 60%, #fff0c0 100%);
  transition: width 0.14s linear;
}
.bb-flight.flying { border-color: #ffd27a; box-shadow: 0 0 16px rgba(255,210,122,0.35); }
.bb-flight.empty .bar > i { background: #6a5030; }

/* Split-screen: shrink the meters so they do not eat a half-height viewport. */
.bb-root.split .bb-melt, .bb-root.split .bb-flight { min-width: 190px; }
.bb-root.split .bb-panel { padding: 5px 9px; }
.bb-root.split .bb-goal { display: none; }
.bb-root.split .bb-band { top: calc(14px + var(--safe-t)); right: calc(14px + var(--safe-r)); }
.bb-root.split .bb-badge { width: 34px; height: 34px; font-size: 16px; border-radius: 9px; }

/* The bar between the two halves. Purely cosmetic — the renderer draws each
   half itself — but without it the two views blur into one confusing image. */
.bb-splitbar {
  position: absolute; left: 0; right: 0; top: 50%; height: 4px;
  transform: translateY(-2px); background: rgba(20,10,4,0.9);
  box-shadow: 0 0 10px rgba(0,0,0,0.6); display: none;
}
.bb-root.split .bb-splitbar { display: block; }

/* Per-viewport interact prompt. Prompt 0 sits low in the top half, prompt 1 low
   in the bottom half; in one-viewport mode only the first is used. */
.bb-prompt.p1 { bottom: calc(20% + var(--safe-b)); }
.bb-root.split .bb-prompt.p0 { bottom: 54%; }
.bb-root.split .bb-prompt.p1 { bottom: calc(4% + var(--safe-b)); }

/* --- the join screen ---------------------------------------------------- */
.bb-modes { display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; max-width: 760px; }
.bb-mode {
  pointer-events: auto; cursor: pointer; font: inherit; color: inherit;
  width: 210px; padding: 16px 14px; border-radius: 18px; text-align: center;
  background: rgba(0,0,0,0.32); border: 3px solid rgba(255,255,255,0.28);
  transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.bb-mode:hover, .bb-mode.sel {
  transform: translateY(-4px); border-color: #ffd97a; background: rgba(245,209,48,0.16);
}
.bb-mode .em { font-size: 40px; display: block; margin-bottom: 6px; }
.bb-mode .t { font-size: 19px; font-weight: 900; display: block; }
.bb-mode .d { font-size: 13px; opacity: 0.8; line-height: 1.35; display: block; margin-top: 5px; }

.bb-online { display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%; }
.bb-online.show { display: flex; }
.bb-codebox { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; }
.bb-code {
  pointer-events: auto; font: inherit; font-size: 30px; font-weight: 900; letter-spacing: 0.4em;
  text-align: center; text-transform: uppercase; width: 200px; padding: 8px 6px 8px 18px;
  border-radius: 14px; border: 3px solid #fff5e6; background: rgba(0,0,0,0.4); color: #fff5e6;
}
.bb-roomcode {
  font-size: clamp(34px, 8vw, 74px); font-weight: 900; letter-spacing: 0.24em;
  color: #ffd97a; text-shadow: 0 5px 0 #4a2a12; padding-left: 0.24em;
}
.bb-netstatus { font-size: 15px; opacity: 0.9; min-height: 22px; }
.bb-netstatus.err { color: #ff9a8a; }

/* Live connection pill, top-centre, while an online game is running. */
.bb-netpill {
  position: absolute; top: calc(14px + var(--safe-t)); left: 50%; transform: translateX(-50%);
  padding: 4px 14px; border-radius: 999px; font-size: 13px; font-weight: 700;
  background: rgba(28,16,8,0.7); border: 2px solid rgba(255,213,150,0.35);
  display: none; align-items: center; gap: 8px;
}
.bb-netpill.show { display: flex; }

/* --- player-versus-player duel ------------------------------------------ */
.bb-pvp-sides {
  display: flex; gap: clamp(16px, 6vw, 90px); align-items: flex-start;
  justify-content: center; margin-top: 8px;
}
.bb-pvp-side { min-width: 130px; }
.bb-pvp-side .who {
  font-size: clamp(15px, 2.4vw, 22px); font-weight: 900; text-shadow: 0 2px 0 #3a1f0c;
}
.bb-pvp-side .role {
  font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.75; min-height: 16px;
}
.bb-pvp-side.active .role { opacity: 1; color: #57d96a; }
.bb-pvp-side.active .who { animation: bb-bounce 0.7s ease-in-out infinite; }
/* Strings-remaining, drawn as banjo strings rather than hearts: this is the one
   place in the game where something is actually lost, and it should look like
   losing a string off the instrument. */
.bb-pvp-strings { display: flex; gap: 5px; justify-content: center; margin-top: 6px; }
.bb-pvp-strings i {
  width: 6px; height: 24px; border-radius: 3px; background: #ffd97a;
  box-shadow: 0 0 8px rgba(255,217,122,0.6); transition: all 0.3s ease;
}
.bb-pvp-strings i.gone { background: rgba(255,255,255,0.14); box-shadow: none; height: 14px; }

@media (max-height: 560px) {
  .bb-screen { gap: 10px; justify-content: flex-start; padding-top: 12px; }
  .bb-screen h1 { font-size: clamp(22px, 5vw, 40px); }
  .bb-controls { gap: 4px 16px; }
  .bb-goal { display: none; }
}
`

/** Emoji stand-ins for each critter, used on badges and the roster. */
const EMOJI = {
  raccoon: '🦝', goat: '🐐', penguin: '🐧', pug: '🐶', pigeon: '🕊️', owl: '🦉',
}

function el(tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html !== undefined) n.innerHTML = html
  return n
}

export class HUD {
  constructor(parent = document.getElementById('ui') || document.body) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    this._style = style

    this.root = el('div', 'bb-root')
    parent.appendChild(this.root)

    this._buildPlay()
    this._buildDuel()
    this._buildPvp()
    this._buildScreens()

    this._toasts = []
  }

  // -------------------------------------------------------------------------
  // In-play HUD
  // -------------------------------------------------------------------------

  _buildPlay() {
    // One meter stack per local player, built up front. Two is the cap for
    // split-screen and the second one simply stays hidden the rest of the time,
    // which is cheaper and far less bug-prone than building it on demand.
    this.stacks = []
    for (let i = 0; i < 2; i++) {
      const stack = el('div', 'bb-pstack hide')
      const name = el('div', 'bb-pname solo', '')
      const melt = el('div', 'bb-panel bb-melt')
      melt.innerHTML =
        '<div class="lab"><span>🍫 Banjo</span><span class="bb-melt-word">Nice and cold</span></div>' +
        '<div class="bar"><i></i></div>'
      const flight = el('div', 'bb-panel bb-flight')
      flight.innerHTML =
        '<div class="lab"><span>🪽 Flying banjo</span><span class="bb-flight-word">Ready</span></div>' +
        '<div class="bar"><i></i></div>'
      stack.appendChild(name)
      stack.appendChild(melt)
      stack.appendChild(flight)
      this.root.appendChild(stack)
      this.stacks.push({
        root: stack,
        name,
        melt,
        meltFill: melt.querySelector('.bar > i'),
        meltWord: melt.querySelector('.bb-melt-word'),
        flight,
        flightFill: flight.querySelector('.bar > i'),
        flightWord: flight.querySelector('.bb-flight-word'),
      })
    }

    // Chocolate chips are SHARED in co-op — everybody is filling one jar — so
    // this is one panel at the top right, not one per player.
    this.chipPanel = el('div', 'bb-panel bb-chips', '<span>🍫</span><em class="n">0</em>')
    this.chipPanel.style.position = 'absolute'
    this.chipPanel.style.top = 'calc(66px + var(--safe-t))'
    this.chipPanel.style.right = 'calc(14px + var(--safe-r))'
    this.root.appendChild(this.chipPanel)
    this.chipCount = this.chipPanel.querySelector('.n')

    this.band = el('div', 'bb-band')
    this.root.appendChild(this.band)
    this.badges = {}
    for (const c of CRITTERS) {
      const b = el('div', 'bb-badge', EMOJI[c.id] || '🎵')
      b.title = c.name
      this.band.appendChild(b)
      this.badges[c.id] = b
    }

    this.goal = el('div', 'bb-goal')
    this.root.appendChild(this.goal)

    // One prompt per viewport, so "press X to duel" appears next to the player
    // it is actually talking to.
    this.prompts = []
    for (let i = 0; i < 2; i++) {
      const pr = el('div', `bb-prompt p${i}`)
      this.root.appendChild(pr)
      this.prompts.push(pr)
    }
    this.prompt = this.prompts[0] // kept for the smoke tests and old call sites

    this.splitBar = el('div', 'bb-splitbar')
    this.root.appendChild(this.splitBar)

    this.netPill = el('div', 'bb-netpill', '')
    this.root.appendChild(this.netPill)

    this.toastBox = el('div', 'bb-toasts')
    this.root.appendChild(this.toastBox)

    this._viewports = 1
  }

  /**
   * Lay the HUD out for `n` local viewports.
   *
   * The only thing that actually moves is player 2's meter stack, which is
   * pushed down to the top of the lower half. Everything else is a class on the
   * root and lives in the stylesheet, so there is exactly one place that knows
   * what split-screen looks like.
   */
  setViewports(n) {
    const count = Math.max(1, Math.min(2, n | 0))
    this._viewports = count
    this.root.classList.toggle('split', count > 1)
    this.stacks[1].root.classList.toggle('hide', count < 2)
    // 50% of the viewport, plus the same 14px inset the top stack gets.
    this.stacks[1].root.style.setProperty('--pstack-top', count > 1 ? '50vh' : '0px')
    for (let i = 0; i < this.stacks.length; i++) {
      this.stacks[i].name.classList.toggle('solo', count < 2)
    }
    this.prompts[1].classList.toggle('show', false)
  }

  /** Name and colour for one player's meter stack. */
  setPlayerIdentity(i, name, accent) {
    const st = this.stacks[i]
    if (!st) return
    if (st.name.textContent !== name) st.name.textContent = name
    st.name.style.color = accent
    st.root.classList.remove('hide')
  }

  /** Show or hide one player's meter stack entirely. */
  setPlayerVisible(i, v) {
    const st = this.stacks[i]
    if (st) st.root.classList.toggle('hide', !v)
  }

  /**
   * @param {number} melt 0..1
   * @param {number} [i] which local player
   */
  setMelt(melt, i = 0) {
    const st = this.stacks[i]
    if (!st) return
    st.meltFill.style.width = `${Math.round(melt * 100)}%`
    st.melt.classList.toggle('hot', melt > 0.72)
    // Words a child can be told once and then recognise by the colour alone.
    const word =
      melt < 0.08 ? 'Nice and cold'
        : melt < 0.3 ? 'Just fine'
          : melt < 0.55 ? 'Getting soft…'
            : melt < 0.8 ? 'Warm! Find ice!'
              : 'MELTING! RUN!'
    if (st.meltWord.textContent !== word) st.meltWord.textContent = word
  }

  /**
   * The flying-banjo meter.
   * @param {number} fuel 0..1
   * @param {boolean} flying whether it is out right now
   * @param {number} [i] which local player
   */
  setFlight(fuel, flying, i = 0) {
    const st = this.stacks[i]
    if (!st) return
    // Hidden until the player has enough to actually take off, so a full-looking
    // bar never sits there refusing to launch.
    st.flight.classList.toggle('show', true)
    st.flightFill.style.width = `${Math.round(fuel * 100)}%`
    st.flight.classList.toggle('flying', flying)
    st.flight.classList.toggle('empty', fuel < 0.12)
    const word = flying
      ? 'Flying!'
      : fuel < 0.12 ? 'Recharging…' : fuel > 0.98 ? 'Ready — press B' : 'Ready'
    if (st.flightWord.textContent !== word) st.flightWord.textContent = word
  }

  setChips(n) {
    if (this.chipCount.textContent !== String(n)) this.chipCount.textContent = String(n)
  }

  /** @param {object} band `{ [critterId]: { won: bool, star: bool } }` */
  setBand(band) {
    for (const c of CRITTERS) {
      const b = this.badges[c.id]
      const rec = band[c.id]
      b.classList.toggle('got', !!(rec && rec.won))
      let star = b.querySelector('.star')
      if (rec && rec.star && !star) {
        star = el('div', 'star', '⭐')
        b.appendChild(star)
      } else if ((!rec || !rec.star) && star) {
        star.remove()
      }
    }
  }

  setGoal(html) {
    if (this.goal.innerHTML !== html) this.goal.innerHTML = html
  }

  /** @param {string|null} text null hides it */
  /**
   * @param {string|null} text
   * @param {string} [key] the button glyph on the left
   * @param {number} [i] which viewport it belongs to
   */
  setPrompt(text, key = 'X', i = 0) {
    const pr = this.prompts[i]
    if (!pr) return
    if (!text) {
      pr.classList.remove('show')
      return
    }
    const html = `<span class="bb-key">${key}</span><span>${text}</span>`
    if (pr.innerHTML !== html) pr.innerHTML = html
    pr.classList.add('show')
  }

  toast(text, ms = 2600) {
    const t = el('div', 'bb-toast', text)
    this.toastBox.appendChild(t)
    const rec = { el: t, out: false }
    this._toasts.push(rec)
    window.setTimeout(() => {
      t.classList.add('out')
      window.setTimeout(() => {
        t.remove()
        const i = this._toasts.indexOf(rec)
        if (i >= 0) this._toasts.splice(i, 1)
      }, 420)
    }, ms)
  }

  setPlayVisible(v) {
    const nodes = [this.chipPanel, this.band, this.goal, this.splitBar]
    for (const st of this.stacks) nodes.push(st.root)
    for (const n of nodes) n.style.display = v ? '' : 'none'
    if (!v) {
      for (let i = 0; i < this.prompts.length; i++) this.setPrompt(null, 'X', i)
    } else {
      // Player 2's stack and the split bar are only ever visible in split-screen;
      // un-hiding everything above would otherwise resurrect them in solo.
      this.setViewports(this._viewports)
    }
  }

  /** The little connection pill during an online game. */
  setNetStatus(text, accent = '#57d96a') {
    if (!text) {
      this.netPill.classList.remove('show')
      return
    }
    const html = `<span class="bb-dot on" style="background:${accent};box-shadow:0 0 10px ${accent}"></span><span>${text}</span>`
    if (this.netPill.innerHTML !== html) this.netPill.innerHTML = html
    this.netPill.classList.add('show')
  }

  // -------------------------------------------------------------------------
  // Duel
  // -------------------------------------------------------------------------

  _buildDuel() {
    this.duel = el('div', 'bb-duel')
    this.root.appendChild(this.duel)

    const top = el('div', 'bb-duel-top')
    top.innerHTML =
      '<div class="bb-duel-name"></div>' +
      '<div class="bb-duel-round"></div>' +
      '<div class="bb-duel-state"></div>' +
      '<div class="bb-pips"></div>'
    this.duel.appendChild(top)
    this.duelName = top.querySelector('.bb-duel-name')
    this.duelRound = top.querySelector('.bb-duel-round')
    this.duelState = top.querySelector('.bb-duel-state')
    this.duelPips = top.querySelector('.bb-pips')

    const strings = el('div', 'bb-strings')
    this.duel.appendChild(strings)
    this.stringEls = []
    const labels = ['A', 'B', 'X', 'Y']
    for (let i = 0; i < 4; i++) {
      const s = el('div', 'bb-string')
      s.style.borderColor = STRING_COLORS[i]
      s.style.background = `${STRING_COLORS[i]}44`
      s.innerHTML = `<div class="btn">${labels[i]}</div><div class="num">${i + 1}</div>`
      strings.appendChild(s)
      this.stringEls.push(s)
    }

    this.duelTimer = el('div', 'bb-timer', '<i></i>')
    this.duel.appendChild(this.duelTimer)
    this.duelTimerFill = this.duelTimer.querySelector('i')
  }

  showDuel(critter) {
    this.duel.classList.add('show')
    this.duelName.textContent = critter.name
    this.setPlayVisible(false)
    this._lastPips = null
  }

  hideDuel() {
    this.duel.classList.remove('show')
    this.setPlayVisible(true)
    for (const s of this.stringEls) s.classList.remove('lit')
  }

  /**
   * @param {import('./Duel.js').Duel} duel
   * @param {string} state
   */
  updateDuel(duel, state) {
    this.duelRound.textContent = `Round ${Math.min(duel.roundIndex + 1, duel.totalRounds)} of ${duel.totalRounds}`

    const words = {
      intro: ['Howdy!', ''],
      call: ['LISTEN…', 'listen'],
      response: ['YOUR TURN!', 'your-turn'],
      mistake: ['Oops! Try again', 'oops'],
      roundWon: ['YEE-HAW!', 'yay'],
      won: ['YOU WON!', 'yay'],
      done: ['', ''],
    }
    const [text, cls] = words[state] || ['', '']
    if (this.duelState.textContent !== text) this.duelState.textContent = text
    this.duelState.className = `bb-duel-state ${cls}`

    // Pips. Rebuilt only when the phrase length changes; restyled every frame.
    if (this._lastPips !== duel.phrase.length) {
      this._lastPips = duel.phrase.length
      this.duelPips.innerHTML = ''
      this._pipEls = duel.phrase.map(() => {
        const p = el('div', 'bb-pip')
        this.duelPips.appendChild(p)
        return p
      })
    }
    const shown = state === 'call' ? duel.callIndex : duel.progress - 1
    this._pipEls.forEach((p, i) => {
      const done = i <= shown
      p.classList.toggle('done', done)
      // During the call the pips reveal the colours as they are played; during
      // the response they show what you have already got right. Either way the
      // player is never asked to hold more in their head than they have seen.
      p.style.background = done ? STRING_COLORS[duel.phrase[i]] : 'rgba(255,255,255,0.14)'
      const nowIndex = state === 'call' ? duel.callIndex : duel.progress
      p.classList.toggle('now', i === nowIndex && state !== 'roundWon')
    })

    // Light the struck string.
    for (let i = 0; i < 4; i++) {
      const lit = duel.litString === i
      const s = this.stringEls[i]
      s.classList.toggle('lit', lit)
      s.style.boxShadow = lit ? `0 0 26px 8px ${STRING_COLORS[i]}` : 'none'
      s.style.background = lit ? STRING_COLORS[i] : `${STRING_COLORS[i]}44`
    }

    // Response timer.
    const responding = state === 'response'
    this.duelTimer.classList.toggle('show', responding)
    if (responding) {
      const total = 4.5 * duel.phrase.length
      const frac = Math.max(0, duel.responseLeft / total)
      this.duelTimerFill.style.width = `${frac * 100}%`
      this.duelTimer.classList.toggle('low', frac < 0.25)
    }
  }

  // -------------------------------------------------------------------------
  // Full-screen panels
  // -------------------------------------------------------------------------

  _buildScreens() {
    // --- title -------------------------------------------------------------
    this.title = el('div', 'bb-screen')
    this.title.innerHTML = `
      <h1>BILLY BOB JOE BOB</h1>
      <h2>and the Chocolate Banjo</h2>
      <p>
        Billy Bob Joe Bob lives in the back of the <b>Giga-Mart Wholesale Club</b>, in a fort made of
        paper towels, with a banjo made of magic chocolate. Six critters in this store can play, and
        every one of them wants a duel. Beat them all and they'll join your band for the big show on
        the Free Sample Stage.
      </p>
      <p><b>Watch out:</b> the banjo is chocolate. Stay away from the rotisserie, and cool off in the
        freezer aisle when it gets soft.</p>
      <p><b>Playing together:</b> two of you on this television, or up to four over the internet.
        Press <b>X</b> on another player and you duel each <i>other</i>. Big Earl the forklift can be
        driven, and his forks go all the way up.</p>
      <button class="bb-btn bb-play">PLAY</button>
      <div class="bb-padstate"><span class="bb-dot"></span><span class="bb-padtext">No controller found — keyboard works too</span></div>
      <div class="bb-controls">
        <div><span class="bb-pad">L</span> Walk around</div>
        <div><span class="bb-pad">R</span> Look around</div>
        <div><span class="bb-pad a">A</span> Jump</div>
        <div><span class="bb-pad x">X</span> Duel / drive / get out</div>
        <div><span class="bb-pad b">B</span> Flying banjo</div>
        <div><span class="bb-pad y">Y</span> Dance</div>
        <div><span class="bb-pad">☰</span> Pause</div>
        <div><span class="bb-pad">A B X Y</span> The four banjo strings</div>
      </div>
      <p style="opacity:0.7;font-size:13px">
        Keyboard player 1: <b>WASD</b> walk · <b>arrows</b> look · <b>Space</b> jump · <b>E</b> duel ·
        <b>Q</b> flying banjo · <b>1 2 3 4</b> the strings · <b>Esc</b> pause<br>
        Keyboard player 2: <b>IJKL</b> walk · <b>numpad 8 4 6 2</b> look · <b>Right Shift</b> jump ·
        <b>numpad 0</b> duel · <b>numpad .</b> flying banjo · <b>numpad 7 9 1 3</b> the strings
      </p>
    `
    this.root.appendChild(this.title)
    this.playBtn = this.title.querySelector('.bb-play')
    this.padDot = this.title.querySelector('.bb-dot')
    this.padText = this.title.querySelector('.bb-padtext')

    // --- how are we playing? -----------------------------------------------
    // Between the title and the store. Three routes in, and the two co-op ones
    // are deliberately given equal weight with solo: a child who wants to play
    // with somebody should not have to find a submenu.
    this.join = el('div', 'bb-screen')
    this.join.innerHTML = `
      <h1>WHO'S PLAYING?</h1>
      <div class="bb-modes">
        <button class="bb-mode bb-m-solo">
          <span class="em">🪕</span><span class="t">Just me</span>
          <span class="d">One player, the whole store.</span>
        </button>
        <button class="bb-mode bb-m-split">
          <span class="em">🪕🪕</span><span class="t">Two of us, here</span>
          <span class="d">Split screen on this television. Second controller, or the second keyboard set.</span>
        </button>
        <button class="bb-mode bb-m-online">
          <span class="em">🌐</span><span class="t">Somebody far away</span>
          <span class="d">Up to four players over the internet. You get a four-letter code to share.</span>
        </button>
      </div>

      <div class="bb-online">
        <div class="bb-codebox">
          <button class="bb-btn bb-host">MAKE A NEW GAME</button>
          <span style="opacity:0.7">or</span>
          <input class="bb-code" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false">
          <button class="bb-btn bb-joincode">JOIN</button>
        </div>
        <div class="bb-roomcode"></div>
        <div class="bb-netstatus"></div>
      </div>

      <button class="bb-btn bb-backtitle" style="background:linear-gradient(180deg,#8a7a6a,#5a4a3a)">BACK</button>
    `
    this.root.appendChild(this.join)
    this.joinSolo = this.join.querySelector('.bb-m-solo')
    this.joinSplit = this.join.querySelector('.bb-m-split')
    this.joinOnline = this.join.querySelector('.bb-m-online')
    this.joinOnlineBox = this.join.querySelector('.bb-online')
    this.hostBtn = this.join.querySelector('.bb-host')
    this.joinCodeInput = this.join.querySelector('.bb-code')
    this.joinCodeBtn = this.join.querySelector('.bb-joincode')
    this.roomCodeEl = this.join.querySelector('.bb-roomcode')
    this.netStatusEl = this.join.querySelector('.bb-netstatus')
    this.backTitleBtn = this.join.querySelector('.bb-backtitle')

    // Type a code in lower case and it should still work; a four-year-old's
    // older sibling is reading it off a phone.
    this.joinCodeInput.addEventListener('input', () => {
      const v = this.joinCodeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
      if (this.joinCodeInput.value !== v) this.joinCodeInput.value = v
    })

    // --- pause -------------------------------------------------------------
    this.pause = el('div', 'bb-screen')
    this.pause.innerHTML = `
      <h1>PAUSED</h1>
      <div class="bb-roster"></div>
      <button class="bb-btn bb-resume">KEEP PLAYING</button>
      <p style="opacity:0.75;font-size:14px">Press <b>☰</b> on the controller, or <b>Esc</b>, to come back.</p>
    `
    this.root.appendChild(this.pause)
    this.resumeBtn = this.pause.querySelector('.bb-resume')
    this.rosterBox = this.pause.querySelector('.bb-roster')

    // --- finale ------------------------------------------------------------
    this.finale = el('div', 'bb-screen')
    this.finale.innerHTML = `
      <h1>🪕 THE BIG SHOW 🪕</h1>
      <h2>The whole band is on the stage</h2>
      <p class="bb-finale-text"></p>
      <button class="bb-btn bb-again">PLAY SOME MORE</button>
    `
    this.root.appendChild(this.finale)
    this.againBtn = this.finale.querySelector('.bb-again')
    this.finaleText = this.finale.querySelector('.bb-finale-text')
  }

  // -------------------------------------------------------------------------
  // The join screen
  // -------------------------------------------------------------------------

  showJoin(v) {
    this.join.classList.toggle('show', v)
    if (v) this.setJoinSelection(this._joinSel || 0)
  }

  /**
   * Highlight one of the three mode buttons.
   *
   * Exists so the whole way into a game is walkable from a gamepad. Two children
   * with two controllers and no mouse is the single most likely way split-screen
   * gets started, and a join screen that needs a click would make that
   * impossible.
   */
  setJoinSelection(i) {
    this._joinSel = i
    const buttons = [this.joinSolo, this.joinSplit, this.joinOnline]
    buttons.forEach((b, k) => b.classList.toggle('sel', k === i))
  }

  get joinSelection() { return this._joinSel || 0 }

  /** Reveal the host/join controls under the three big buttons. */
  showOnlineBox(v) {
    this.joinOnlineBox.classList.toggle('show', v)
    this.joinOnline.classList.toggle('sel', v)
    if (v) this.joinCodeInput.focus()
  }

  /** @param {string} text @param {boolean} [isError] */
  setNetMessage(text, isError = false) {
    this.netStatusEl.textContent = text || ''
    this.netStatusEl.classList.toggle('err', !!isError)
  }

  /** The room code, big enough to read out across a room. */
  setRoomCode(code) {
    this.roomCodeEl.textContent = code || ''
  }

  /** What the player typed, cleaned up. */
  get typedCode() {
    return (this.joinCodeInput.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
  }

  // -------------------------------------------------------------------------
  // Player-versus-player duel
  // -------------------------------------------------------------------------

  _buildPvp() {
    this.pvp = el('div', 'bb-duel')
    this.root.appendChild(this.pvp)

    const top = el('div', 'bb-duel-top')
    top.innerHTML =
      '<div class="bb-duel-name">BANJO DUEL!</div>' +
      '<div class="bb-duel-round"></div>' +
      '<div class="bb-duel-state"></div>' +
      '<div class="bb-pvp-sides"></div>' +
      '<div class="bb-pips"></div>'
    this.pvp.appendChild(top)
    this.pvpRound = top.querySelector('.bb-duel-round')
    this.pvpState = top.querySelector('.bb-duel-state')
    this.pvpPips = top.querySelector('.bb-pips')

    const sides = top.querySelector('.bb-pvp-sides')
    this.pvpSides = []
    for (let i = 0; i < 2; i++) {
      const d = el('div', 'bb-pvp-side')
      // Built from START_STRINGS rather than hard-coded, so changing how many
      // strings a player gets changes the picture too. Three markers under a
      // player who actually has four is a silent lie about the rules.
      d.innerHTML =
        '<div class="who"></div><div class="role"></div>' +
        `<div class="bb-pvp-strings">${'<i></i>'.repeat(START_STRINGS)}</div>`
      sides.appendChild(d)
      this.pvpSides.push({
        root: d,
        who: d.querySelector('.who'),
        role: d.querySelector('.role'),
        strings: Array.from(d.querySelectorAll('.bb-pvp-strings i')),
      })
    }

    // The same four coloured circles as the critter duel, in the same order and
    // the same place on the screen. A duel is a duel; only the opponent changed.
    const strings = el('div', 'bb-strings')
    this.pvp.appendChild(strings)
    this.pvpStringEls = []
    const labels = ['A', 'B', 'X', 'Y']
    for (let i = 0; i < 4; i++) {
      const st = el('div', 'bb-string')
      st.style.borderColor = STRING_COLORS[i]
      st.style.background = `${STRING_COLORS[i]}44`
      st.innerHTML = `<div class="btn">${labels[i]}</div><div class="num">${i + 1}</div>`
      strings.appendChild(st)
      this.pvpStringEls.push(st)
    }

    this.pvpTimer = el('div', 'bb-timer', '<i></i>')
    this.pvp.appendChild(this.pvpTimer)
    this.pvpTimerFill = this.pvpTimer.querySelector('i')
  }

  /** @param {object} duel a PvpDuel */
  showPvp(duel) {
    this.pvp.classList.add('show')
    this.setPlayVisible(false)
    for (let i = 0; i < 2; i++) {
      const side = duel.sides[i]
      this.pvpSides[i].who.textContent = side.name
      this.pvpSides[i].who.style.color = side.accent || '#fff5e6'
    }
    this._pvpPipCount = -1
  }

  hidePvp() {
    this.pvp.classList.remove('show')
    this.setPlayVisible(true)
    for (const s of this.pvpStringEls) s.classList.remove('lit')
  }

  /**
   * @param {object} duel a PvpDuel
   * @param {string} state
   */
  updatePvp(duel, state) {
    const round = `Round ${duel.roundIndex + 1} · ${duel.roundLength} note${duel.roundLength === 1 ? '' : 's'}`
    if (this.pvpRound.textContent !== round) this.pvpRound.textContent = round

    const active = duel.activeSide
    const activeName = active >= 0 ? duel.sides[active].name : ''
    const words = {
      intro: ['BANJO DUEL!', 'yay'],
      call: [`${activeName}: MAKE A TUNE!`, 'your-turn'],
      handover: ['Now play it back…', 'listen'],
      echo: [`${activeName}: PLAY IT BACK!`, 'your-turn'],
      good: ['YEE-HAW!', 'yay'],
      miss: ['Oops! Lost a string', 'oops'],
      won: [duel.winner >= 0 ? `${duel.sides[duel.winner].name} WINS!` : '', 'yay'],
      done: ['', ''],
    }
    const [text, cls] = words[state] || ['', '']
    if (this.pvpState.textContent !== text) this.pvpState.textContent = text
    this.pvpState.className = `bb-duel-state ${cls}`

    // Who is up, and how many strings each has left.
    for (let i = 0; i < 2; i++) {
      const s = this.pvpSides[i]
      s.root.classList.toggle('active', i === active)
      const role = i === active
        ? (state === 'call' ? 'YOUR TUNE' : state === 'echo' ? 'COPY IT' : '')
        : (active >= 0 ? 'listening' : '')
      if (s.role.textContent !== role) s.role.textContent = role
      const left = duel.strings[i]
      s.strings.forEach((el2, k) => el2.classList.toggle('gone', k >= left))
    }

    // Pips: one per note played so far in this phrase. During the CALL they
    // appear as the caller improvises; during the ECHO they light up as the
    // other player gets them right — which is exactly the memory aid a small
    // player needs and the same contract the critter duel uses.
    const shownLen = duel.phrase.length
    if (this._pvpPipCount !== shownLen) {
      this._pvpPipCount = shownLen
      this.pvpPips.innerHTML = ''
      this._pvpPipEls = duel.phrase.map(() => {
        const pip = el('div', 'bb-pip')
        this.pvpPips.appendChild(pip)
        return pip
      })
    }
    const colors = duel.pipColors()
    const upto = state === 'echo' ? duel.progress - 1 : shownLen - 1
    ;(this._pvpPipEls || []).forEach((pip, i) => {
      const done = i <= upto
      pip.classList.toggle('done', done)
      pip.style.background = done ? colors[i] : 'rgba(255,255,255,0.14)'
      pip.classList.toggle('now', i === (state === 'echo' ? duel.progress : shownLen))
    })

    // The struck string flashes, whoever struck it.
    for (let i = 0; i < 4; i++) {
      this.pvpStringEls[i].classList.toggle('lit', duel.litString === i)
    }

    // The clock. Only shown while somebody is actually on it.
    const live = state === 'call' || state === 'echo'
    this.pvpTimer.classList.toggle('show', live)
    if (live) {
      const frac = duel.clockLeft / duel.clockTotal
      this.pvpTimerFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`
      this.pvpTimer.classList.toggle('low', frac < 0.3)
    }
  }

  showTitle(v) { this.title.classList.toggle('show', v) }
  showPause(v) { this.pause.classList.toggle('show', v) }
  showFinale(v) { this.finale.classList.toggle('show', v) }

  /** Reflect whether a gamepad is plugged in, on the title screen. */
  setPadConnected(n) {
    this.padDot.classList.toggle('on', n > 0)
    this.padText.textContent = n > 0
      ? `Controller ready — ${n === 1 ? 'player 1' : `${n} connected`}`
      : 'No controller found — keyboard works too'
  }

  /** Fill the pause-screen roster. */
  setRoster(band) {
    this.rosterBox.innerHTML = ''
    for (const c of CRITTERS) {
      const rec = band[c.id]
      const card = el('div', `card${rec && rec.won ? ' got' : ''}`)
      card.innerHTML =
        `<span class="em">${EMOJI[c.id]}</span><b>${c.name}</b><br>` +
        (rec && rec.won
          ? `In the band${rec.star ? ' ⭐' : ''}`
          : `<span style="opacity:0.7">${c.zone}</span>`)
      this.rosterBox.appendChild(card)
    }
  }

  setFinaleText(html) { this.finaleText.innerHTML = html }

  dispose() {
    this.root.remove()
    this._style.remove()
  }
}
