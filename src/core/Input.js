// core/Input.js — [INPUT]
//
// Gamepad + keyboard + touch -> InputState, for Billy Bob Joe Bob.
//
// Adapted from the same file in ~/dog (Zulop Bay Rescue Pups); the gamepad
// plumbing below is identical and battle-tested, only the action table differs.
//
// The four banjo strings are bound to the four face buttons on purpose: an
// Xbox pad's A/B/X/Y are physically coloured green/red/blue/yellow, and those
// are exactly the four string colours the duel draws. "Press the green one" is
// then a complete instruction for a child who cannot read yet — no mapping to
// learn, no letters to decode.
//
// Design notes, because this is a game for a five-year-old:
//  * Nothing here can ever get stuck. A held key never fights the pad: whichever source
//    showed *fresh* activity most recently owns player 1. So if a stuck key is jammed
//    "down", the moment the child touches the controller the controller wins, forever,
//    until somebody presses a fresh key.
//  * Everything degrades gracefully. Zero gamepads connected is a fully supported,
//    fully playable state — player 1 can complete the entire game on the keyboard.
//  * Pads are bound to player slots by connection order and that binding survives a
//    cable being yanked out and pushed back in (a certainty, with a five-year-old).
//  * On a phone or tablet a third source appears: an on-screen stick, a look area and
//    four face buttons, feeding player 1 through the exact same InputState. Nothing
//    downstream of this file knows or cares that a finger is driving it — which is why
//    the touch build needed no changes in Player, HUD, Interact or Mission.
//
// Axis sign convention used throughout (please read, integrators):
//    moveX / lookX :  +1 = right
//    moveY / lookY :  +1 = FORWARD / UP  (i.e. already negated from the raw gamepad axis,
//                     which reports up as -1). W and Up-arrow both give +1.
//
// InputState objects are stable and mutated in place — hold a reference to the state,
// never to its sub-objects (per §5 of ARCHITECTURE.md).

import { applyDeadzone } from './MathUtils.js'
import { isTouchDevice, TouchLayer } from './touch.js'

/**
 * Canonical action list.
 *
 * Overworld:  jump (A) · strum (X) · fly (B) · dance (Y) · camera (RB) · pause (START)
 * Duel:       string1..4 are the SAME four face buttons, read under a different name.
 *             Both sets are always populated; the mode decides which it reads.
 *
 * B used to say "howdy". It now launches the flying banjo, which is a whole mode
 * and needs a button a child can find without being told. `howdy` survives on the
 * keyboard's H only — it costs nothing and it is the joke the game opens with.
 */
export const ACTIONS = [
  'jump',
  'strum',
  'fly',
  'howdy',
  'dance',
  'camera',
  'pause',
  'menuUp',
  'menuDown',
  'menuConfirm',
  'menuBack',
]

// The four banjo strings, plus the horizontal menu directions.
const EXTRA_ACTIONS = ['menuLeft', 'menuRight', 'string1', 'string2', 'string3', 'string4']
const ALL_ACTIONS = ACTIONS.concat(EXTRA_ACTIONS)

/** String index -> the pad button that plays it, for HUD prompts. */
export const STRING_BUTTONS = ['A', 'B', 'X', 'Y']

// Menu actions get key-repeat so holding the stick scrolls a list.
const REPEATING = new Set(['menuUp', 'menuDown', 'menuLeft', 'menuRight'])
const REPEAT_DELAY = 0.40 // s before the first repeat
const REPEAT_RATE = 0.16 // s between repeats after that

/**
 * Number of *local* player slots.
 *
 * Two, for split-screen co-op. Slot 1 is driven by the second gamepad if there
 * is one, and otherwise by the second keyboard set (IJKL + numpad) once the
 * game calls `enableSecondKeyboard(true)` — which it only does in split-screen,
 * so a solo player's stray numpad press can never move an invisible P2.
 */
export const MAX_LOCAL_PLAYERS = 2

// Deadzones. Move is deliberately generous (0.22) so a wobbly thumb still walks straight;
// look is tighter (0.15) so the camera responds to a gentle nudge.
const MOVE_DEADZONE = 0.22
const LOOK_DEADZONE = 0.15

// A trigger counts as "pressed" past this analog value.
const TRIGGER_THRESHOLD = 0.35

// --- touch look tuning ------------------------------------------------------
// The look area reports PIXELS dragged; Player consumes lookX/lookY as a RATE
// (rad/s at full deflection, multiplied by dt). Dividing the pixel delta by dt
// converts one into the other, and makes the gesture frame-rate independent: a
// drag of N pixels turns the camera by the same angle at 30fps and at 120fps.
//
// LOOK_YAW_RATE is 2.6 rad/s and LOOK_PITCH_RATE 1.9 in Player.js; these gains
// are picked so a drag across half a phone screen (~400px) sweeps about 120°.
const TOUCH_YAW_GAIN = 0.0020
const TOUCH_PITCH_GAIN = 0.0027
// A flick can be hundreds of pixels in one frame. Player's response curve is
// linear past full deflection, so we allow overdrive rather than clamping to 1
// (which would make fast flicks feel mushy) but still cap the worst case.
const TOUCH_LOOK_MAX = 4

// Standard-mapping button indices. Xbox pads that report mapping === '' on Linux/Firefox
// happen to use the very same indices for the face/shoulder/menu buttons, so this table is
// shared by both paths; only the *axes* really differ between drivers.
const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DUP: 12,
  DDOWN: 13,
  DLEFT: 14,
  DRIGHT: 15,
}

// Keyboard bindings for P1 (§5: P2 keyboard is not required):
//   WASD move · arrows look · Space jump · E interact · Q bark · F ability · C camera · Esc pause
//   Enter / Space confirm · Backspace / Esc back
//
// Keys we swallow so the page never scrolls or scrubs focus mid-game.
const SWALLOW = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Tab',
  'F1',
])

/** Create a fresh button triple. */
function makeButton() {
  return { down: false, pressed: false, released: false }
}

/** Create a fresh, zeroed InputState. */
function makeState(index) {
  const s = {
    playerIndex: index,
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    /** Analog trigger values, 0..1 — handy for the mini-games. */
    triggerL: 0,
    triggerR: 0,
    /** True while this slot is driven by a physical gamepad (false = keyboard / idle). */
    usingPad: false,
    /** True while this slot has any input source at all. */
    connected: index === 0, // P1 always has the keyboard
    anyPressed: false,
  }
  for (const a of ALL_ACTIONS) s[a] = makeButton()
  return s
}

/** Raw (pre-edge-detection) sample of one input source. */
function makeSample() {
  const r = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, triggerL: 0, triggerR: 0, buttons: {} }
  for (const a of ALL_ACTIONS) r.buttons[a] = false
  return r
}

function clearSample(r) {
  r.moveX = 0
  r.moveY = 0
  r.lookX = 0
  r.lookY = 0
  r.triggerL = 0
  r.triggerR = 0
  for (const a of ALL_ACTIONS) r.buttons[a] = false
}

/** Read a gamepad button entry that may be a number or a GamepadButton object. */
function buttonValue(buttons, i) {
  const b = buttons && buttons[i]
  if (b === undefined || b === null) return 0
  if (typeof b === 'number') return b
  if (typeof b.value === 'number' && b.value > 0) return b.value
  return b.pressed ? 1 : 0
}

function buttonDown(buttons, i, threshold = 0.5) {
  const b = buttons && buttons[i]
  if (b === undefined || b === null) return false
  if (typeof b === 'number') return b >= threshold
  if (b.pressed) return true
  return typeof b.value === 'number' && b.value >= threshold
}

/**
 * Per-gamepad bookkeeping: which slot it owns, plus a tiny running calibration of the
 * analog-trigger axes (Linux xpad rests them at -1, some drivers rest them at 0).
 */
class PadBinding {
  constructor(gpIndex, id) {
    this.gpIndex = gpIndex
    this.id = id || ''
    this.slot = -1
    // axisMin[i] = lowest value ever seen on axis i. Used to decide whether a trigger axis
    // is bipolar (-1 at rest) or unipolar (0 at rest).
    this.axisMin = []
  }

  observeAxes(axes) {
    for (let i = 0; i < axes.length; i++) {
      const v = axes[i]
      if (this.axisMin[i] === undefined || v < this.axisMin[i]) this.axisMin[i] = v
    }
  }

  /** True once we have proof that this axis rests at -1 and climbs to +1. */
  isBipolar(i) {
    return this.axisMin[i] !== undefined && this.axisMin[i] < -0.5
  }
}

export class Input {
  constructor() {
    // ---- public-ish state -------------------------------------------------
    this._states = []
    for (let i = 0; i < MAX_LOCAL_PLAYERS; i++) this._states.push(makeState(i))

    // ---- gamepad bookkeeping ---------------------------------------------
    /** @type {Map<number, PadBinding>} live pads, keyed by gamepad.index */
    this._pads = new Map()
    /** Slot -> gamepad.index (or -1). Connection order defines this. */
    this._slotToPad = new Array(MAX_LOCAL_PLAYERS).fill(-1)
    /** Remembered pad ids for vacated slots, so a replug returns to the same slot. */
    this._slotMemory = new Array(MAX_LOCAL_PLAYERS).fill(null)
    this._padCount = 0

    this._connectCbs = []
    this._disconnectCbs = []

    // ---- per-slot scratch -------------------------------------------------
    this._samples = []
    this._repeatTimers = []
    for (let i = 0; i < MAX_LOCAL_PLAYERS; i++) {
      this._samples.push(makeSample())
      const t = {}
      for (const a of ALL_ACTIONS) t[a] = 0
      this._repeatTimers.push(t)
    }

    // ---- keyboard ---------------------------------------------------------
    /** @type {Set<string>} currently-held key codes */
    this._keys = new Set()
    // Keys that went down since the last update(), held for exactly one frame.
    // A quick tap can begin and end entirely between two frames — especially at a low
    // frame rate, and small children tap very fast. Without this latch the press is
    // simply lost. Anything in here counts as held for the next sample, then clears.
    this._keysLatched = new Set()
    this._kbSample = makeSample()
    /** Player 2's half of the keyboard. Only sampled while `_kb2` is on. */
    this._kb2Sample = makeSample()
    /** True once the game turns on the split-screen second keyboard set. */
    this._kb2 = false
    /** Set by a fresh (non-repeat) keydown; consumed by update(). */
    this._kbFreshActivity = false
    this._kbAnyPressed = false
    /** 'kb' | 'pad' | 'touch' — who currently owns player 1. */
    this._p1Source = 'kb'
    /** 'kb' | 'pad' — who currently owns player 2. */
    this._p2Source = 'kb'

    // ---- touch ------------------------------------------------------------
    /** @type {TouchLayer|null} null on anything that is not touch-first. */
    this.touch = null
    /** True when this build is running the on-screen controls. */
    this.isTouch = false
    this._touchSample = makeSample()
    this._touchButtons = null
    this._moveStick = null
    this._lookZone = null

    this._anyPressed = false
    this._disposed = false

    // ---- listeners --------------------------------------------------------
    this._onKeyDown = this._handleKeyDown.bind(this)
    this._onKeyUp = this._handleKeyUp.bind(this)
    this._onBlur = this._handleBlur.bind(this)
    this._onPadEvent = this._scanPads.bind(this)

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown, { passive: false })
      window.addEventListener('keyup', this._onKeyUp, { passive: false })
      window.addEventListener('blur', this._onBlur)
      window.addEventListener('gamepadconnected', this._onPadEvent)
      window.addEventListener('gamepaddisconnected', this._onPadEvent)
      // Pick up pads that were already attached before we booted (Chrome exposes these
      // immediately; Firefox waits for the connect event, which the listener above catches).
      this._scanPads()

      if (isTouchDevice()) this._initTouch()
    }
  }

  // =========================================================================
  // Touch
  // =========================================================================

  /**
   * Build the on-screen controls: a floating stick on the left half, a look
   * area on the right half, and the four face buttons laid out in the same
   * diamond as the pad they stand in for — so every prompt the HUD already
   * draws ("press A", "press X") points at a button that is physically where
   * the child expects it.
   *
   * The layer sits at z-index 9, one below the HUD root's 10. That single
   * number is what makes every existing DOM menu keep working on a phone: the
   * menus paint over the sticks and take the taps themselves.
   */
  _initTouch() {
    this.isTouch = true
    const layer = new TouchLayer(document.body, { zIndex: 9 })
    this.touch = layer

    // Left 46% moves. Not 50%: the face buttons need elbow room, and a thumb
    // resting past the midline while walking would otherwise steal the look.
    this._moveStick = layer.addStick({
      zoneRect: { left: '0', top: '0', width: '46%', height: '100%' },
      radius: 64,
      deadzone: 0.12,
      hintAt: {
        left: 'calc(16% + env(safe-area-inset-left, 0px))',
        bottom: 'calc(74px + env(safe-area-inset-bottom, 0px))',
      },
    })

    this._lookZone = layer.addLookZone({
      zoneRect: { left: '46%', top: '0', width: '54%', height: '100%' },
    })

    // Diamond, anchored bottom-right. `right` grows leftward, so B (the right
    // point of a physical diamond) gets the SMALLEST right offset and X the
    // largest — read the numbers as distances from the screen edge, not as
    // positions on the pad.
    //
    // Each button is tinted with its Xbox colour and given a matching class, so
    // the duel can light them up and a child on a phone is pressing visually
    // the same four coloured things a child on a pad is.
    const sr = 'env(safe-area-inset-right, 0px)'
    const sb = 'env(safe-area-inset-bottom, 0px)'
    const btn = (label, sub, right, bottom, tint) => {
      const b = layer.addButton({
        label,
        sub,
        size: 66,
        at: { right: `calc(${right}px + ${sr})`, bottom: `calc(${bottom}px + ${sb})` },
      })
      b.el.style.borderColor = tint
      b.el.style.boxShadow = `0 0 14px ${tint}55`
      return b
    }

    this._touchButtons = {
      jump: btn('A', 'JUMP', 100, 30, '#57d96a'),
      fly: btn('B', 'FLY', 30, 100, '#ef4a4a'),
      strum: btn('X', 'STRUM', 170, 100, '#4aa8ef'),
      dance: btn('Y', 'DANCE', 100, 170, '#f5d130'),
      // Utility pair, top-right, small and square so they cannot be mistaken
      // for the round action buttons under a thumb.
      camera: layer.addButton({
        label: '◨', sub: 'VIEW', size: 46, square: true,
        at: { right: `calc(14px + ${sr})`, top: 'calc(14px + env(safe-area-inset-top, 0px))' },
      }),
      pause: layer.addButton({
        label: '❚❚', size: 46, square: true,
        at: { right: `calc(70px + ${sr})`, top: 'calc(14px + env(safe-area-inset-top, 0px))' },
      }),
    }
  }

  /**
   * Relabel the four face buttons for the duel ("A" -> "1"), and back again.
   * No-op without touch — on a pad the labels are moulded into the plastic.
   */
  setDuelLabels(on) {
    const b = this._touchButtons
    if (!b) return
    if (on) {
      b.jump.setLabel('A', '1')
      b.fly.setLabel('B', '2')
      b.strum.setLabel('X', '3')
      b.dance.setLabel('Y', '4')
    } else {
      b.jump.setLabel('A', 'JUMP')
      b.fly.setLabel('B', 'FLY')
      b.strum.setLabel('X', 'STRUM')
      b.dance.setLabel('Y', 'DANCE')
    }
  }

  /** Sample the on-screen controls into `out`. Mirrors `_readPad`'s contract. */
  _readTouch(out, dt) {
    clearSample(out)
    const layer = this.touch
    if (!layer) return
    layer.update()

    const stick = this._moveStick
    out.moveX = stick.x
    out.moveY = stick.y

    const { dx, dy } = this._lookZone.consume()
    const step = dt > 0 ? dt : 1 / 60
    const clampLook = (v) =>
      v > TOUCH_LOOK_MAX ? TOUCH_LOOK_MAX : v < -TOUCH_LOOK_MAX ? -TOUCH_LOOK_MAX : v
    out.lookX = clampLook((dx * TOUCH_YAW_GAIN) / step)
    // Screen +y is down and Player's +lookY pitches up, so dragging the finger
    // up looks up — the right-stick convention, and the one `invertY` flips.
    out.lookY = clampLook((-dy * TOUCH_PITCH_GAIN) / step)

    const b = this._touchButtons
    const bt = out.buttons
    bt.jump = b.jump.down
    bt.strum = b.strum.down
    bt.fly = b.fly.down
    bt.dance = b.dance.down
    bt.camera = b.camera.down
    bt.pause = b.pause.down

    // Menus: the stick flicks, A confirms, B goes back. Same gates as the pad
    // so a menu never scrolls two entries from one nudge.
    bt.menuUp = stick.y > 0.6
    bt.menuDown = stick.y < -0.6
    bt.menuLeft = stick.x < -0.6
    bt.menuRight = stick.x > 0.6
    bt.menuConfirm = b.jump.down
    bt.menuBack = b.fly.down

    // Same four buttons, duel names — identical to the pad path.
    bt.string1 = b.jump.down
    bt.string2 = b.fly.down
    bt.string3 = b.strum.down
    bt.string4 = b.dance.down

    out.triggerR = b.jump.down ? 1 : 0
    out.triggerL = b.dance.down ? 1 : 0
  }

  /**
   * Turn player 2's keyboard half on or off.
   *
   * Off by default and off in every single-player mode. A solo player leaning on
   * the numpad must never drive a second Billy Bob around the store, and this is
   * the only thing standing between them and that.
   */
  enableSecondKeyboard(on) {
    this._kb2 = !!on
    if (!on) clearSample(this._kb2Sample)
  }

  /** Show or hide the on-screen controls. No-op on a desktop build. */
  setTouchVisible(v) {
    if (this.touch) this.touch.setVisible(!!v)
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** @returns {number} gamepads currently attached (including any beyond slot 1). */
  get connectedPads() {
    return this._padCount
  }

  /** True if any button on any pad, or any key, went down on the last update(). */
  get anyPressed() {
    return this._anyPressed
  }

  /** Register a callback fired as `(slot, gamepad)` when a pad is bound. */
  onPadConnect(cb) {
    if (typeof cb === 'function') this._connectCbs.push(cb)
    return () => {
      const i = this._connectCbs.indexOf(cb)
      if (i >= 0) this._connectCbs.splice(i, 1)
    }
  }

  /** Register a callback fired as `(slot, gamepadIndex)` when a pad is lost. */
  onPadDisconnect(cb) {
    if (typeof cb === 'function') this._disconnectCbs.push(cb)
    return () => {
      const i = this._disconnectCbs.indexOf(cb)
      if (i >= 0) this._disconnectCbs.splice(i, 1)
    }
  }

  /** @returns {object|null} the stable InputState for a local player slot. */
  getState(playerIndex) {
    return this._states[playerIndex] || null
  }

  /**
   * Poll every source and refresh both InputStates. Call exactly once per frame,
   * before any player updates.
   * @param {number} dt seconds since the last update (already clamped by Game).
   */
  update(dt) {
    if (this._disposed) return
    const step = dt > 0 && dt < 1 ? dt : 1 / 60

    this._scanPads()

    let anyPressed = this._kbAnyPressed
    this._kbAnyPressed = false

    // --- sample the keyboard once per player half --------------------------
    this._readKeyboard(this._kbSample)
    if (this._kb2) this._readKeyboard2(this._kb2Sample)
    // The latch has now been folded into this frame's samples; release it so a tap
    // reads as exactly one frame of "down" and produces a clean pressed/released pair.
    // Both halves must have read it before it goes, or whichever ran second loses
    // the press entirely.
    this._keysLatched.clear()
    const kbActive = this._sampleIsActive(this._kbSample)
    const kb2Active = this._kb2 && this._sampleIsActive(this._kb2Sample)

    // --- sample the touch layer once (only ever drives P1) ------------------
    // Read unconditionally, even when a pad has the slot: the look area
    // accumulates pixel deltas between frames, and leaving them unconsumed
    // would fire the whole backlog at once the moment touch regained P1.
    let touchActive = false
    if (this.touch) {
      this._readTouch(this._touchSample, step)
      touchActive = this._sampleIsActive(this._touchSample)
    }

    for (let slot = 0; slot < MAX_LOCAL_PLAYERS; slot++) {
      const sample = this._samples[slot]
      clearSample(sample)

      const gp = this._getPadForSlot(slot)
      let padActive = false
      if (gp) {
        const binding = this._pads.get(gp.index)
        this._readPad(gp, binding, sample)
        padActive = this._sampleIsActive(sample)
        if (padActive) anyPressed = anyPressed || this._sampleAnyButton(sample)
      }

      let usingPad = !!gp

      if (slot === 1) {
        // Player 2 arbitrates between its pad and its keyboard half exactly the
        // way player 1 does, minus touch: the on-screen controls are a phone
        // thing and a phone has one player.
        if (padActive) this._p2Source = 'pad'
        else if (this._kb2 && this._sampleIsActive(this._kb2Sample)) this._p2Source = 'kb'
        if (!gp) this._p2Source = 'kb'
        if (this._p2Source === 'kb') {
          if (this._kb2) {
            this._copySample(this._kb2Sample, sample)
            if (kb2Active) anyPressed = anyPressed || this._sampleAnyButton(this._kb2Sample)
          } else {
            clearSample(sample)
          }
          usingPad = false
        }
      }

      if (slot === 0) {
        // Player 1 arbitration: freshest source wins. A gamepad "refreshes" every frame it
        // is being physically moved; the keyboard only refreshes on a *new* keydown. That
        // makes a jammed key harmless the instant the child touches the controller.
        //
        // Touch outranks both while a finger is actually down, so plugging a pad into a
        // tablet mid-game does not fight the on-screen stick, and letting go of the glass
        // hands the slot straight back to the pad.
        if (touchActive) this._p1Source = 'touch'
        else if (padActive) this._p1Source = 'pad'
        else if (this._kbFreshActivity) this._p1Source = 'kb'
        // Whatever the last source was, it has to be one that still exists.
        if (!gp && this._p1Source === 'pad') this._p1Source = this.touch ? 'touch' : 'kb'
        this._kbFreshActivity = false

        if (this._p1Source === 'touch') {
          this._copySample(this._touchSample, sample)
          usingPad = false
          if (touchActive) anyPressed = anyPressed || this._sampleAnyButton(this._touchSample)
        } else if (this._p1Source === 'kb') {
          this._copySample(this._kbSample, sample)
          usingPad = false
          if (kbActive) anyPressed = anyPressed || this._sampleAnyButton(this._kbSample)
        }
      }

      const state = this._states[slot]
      state.usingPad = usingPad
      state.connected = !!gp || slot === 0 || (slot === 1 && this._kb2)
      this._applySample(state, sample, this._repeatTimers[slot], step)
    }

    this._anyPressed = anyPressed
    for (const s of this._states) s.anyPressed = anyPressed
  }

  /**
   * Fire the rumble motors on a player's pad.
   * @param {number} playerIndex slot 0 or 1
   * @param {number} strength 0..1
   * @param {number} ms duration in milliseconds
   */
  rumble(playerIndex, strength = 0.6, ms = 200) {
    const gp = this._getPadForSlot(playerIndex)
    if (!gp) return
    const s = Math.max(0, Math.min(1, strength))
    const duration = Math.max(1, Math.min(5000, ms | 0))
    try {
      const act = gp.vibrationActuator
      if (act && typeof act.playEffect === 'function') {
        // The promise can reject (e.g. the pad went away mid-effect) — swallow it.
        const p = act.playEffect('dual-rumble', {
          startDelay: 0,
          duration,
          weakMagnitude: s,
          strongMagnitude: s * 0.85,
        })
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } else if (act && typeof act.pulse === 'function') {
        // Old Firefox haptic actuator.
        const p = act.pulse(s, duration)
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } else if (gp.hapticActuators && gp.hapticActuators[0]) {
        const h = gp.hapticActuators[0]
        if (typeof h.playEffect === 'function') {
          const p = h.playEffect('dual-rumble', {
            startDelay: 0,
            duration,
            weakMagnitude: s,
            strongMagnitude: s * 0.85,
          })
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } else if (typeof h.pulse === 'function') {
          const p = h.pulse(s, duration)
          if (p && typeof p.catch === 'function') p.catch(() => {})
        }
      }
    } catch (e) {
      // Rumble is a nicety, never a requirement. Silently no-op.
    }
  }

  /** Detach every listener and drop all state. */
  dispose() {
    if (this._disposed) return
    this._disposed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown)
      window.removeEventListener('keyup', this._onKeyUp)
      window.removeEventListener('blur', this._onBlur)
      window.removeEventListener('gamepadconnected', this._onPadEvent)
      window.removeEventListener('gamepaddisconnected', this._onPadEvent)
    }
    if (this.touch) {
      this.touch.dispose()
      this.touch = null
      this._moveStick = null
      this._lookZone = null
      this._touchButtons = null
    }
    this._keys.clear()
    this._keysLatched.clear()
    this._pads.clear()
    this._connectCbs.length = 0
    this._disconnectCbs.length = 0
    this._padCount = 0
    for (const s of this._states) {
      s.moveX = s.moveY = s.lookX = s.lookY = 0
      s.triggerL = s.triggerR = 0
      s.usingPad = false
      s.anyPressed = false
      for (const a of ALL_ACTIONS) {
        s[a].down = false
        s[a].pressed = false
        s[a].released = false
      }
    }
  }

  // =========================================================================
  // Gamepad plumbing
  // =========================================================================

  /** @returns {Array} the live gamepad list, or an empty array when unsupported. */
  _rawPads() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return []
    let list
    try {
      list = navigator.getGamepads()
    } catch (e) {
      return []
    }
    return list || []
  }

  /**
   * Reconcile our slot map with the browser's gamepad list. Idempotent — safe to call
   * from an event handler and from update() in the same frame.
   */
  _scanPads() {
    if (this._disposed) return
    const list = this._rawPads()

    // --- find pads that vanished ------------------------------------------
    const seen = new Set()
    let count = 0
    for (let i = 0; i < list.length; i++) {
      const gp = list[i]
      if (!gp || !gp.connected) continue
      count++
      seen.add(gp.index)
    }
    this._padCount = count

    for (const [gpIndex, binding] of Array.from(this._pads)) {
      if (seen.has(gpIndex)) continue
      this._pads.delete(gpIndex)
      if (binding.slot >= 0) {
        // Remember which pad owned this slot so a replug lands back in the same seat.
        this._slotToPad[binding.slot] = -1
        this._slotMemory[binding.slot] = binding.id
        this._notify(this._disconnectCbs, binding.slot, gpIndex)
      }
    }

    // --- bind pads that appeared ------------------------------------------
    for (let i = 0; i < list.length; i++) {
      const gp = list[i]
      if (!gp || !gp.connected) continue
      if (this._pads.has(gp.index)) continue
      const binding = new PadBinding(gp.index, gp.id)
      binding.slot = this._claimSlot(binding.id)
      this._pads.set(gp.index, binding)
      if (binding.slot >= 0) {
        this._slotToPad[binding.slot] = gp.index
        this._slotMemory[binding.slot] = binding.id
        this._notify(this._connectCbs, binding.slot, gp)
      }
    }
  }

  /**
   * Pick a slot for a newly-seen pad.
   * Priority: a vacant slot that remembers this exact pad id (the replug case), then the
   * lowest vacant slot (connection order). Extra pads beyond MAX_LOCAL_PLAYERS get -1.
   */
  _claimSlot(id) {
    for (let s = 0; s < MAX_LOCAL_PLAYERS; s++) {
      if (this._slotToPad[s] === -1 && this._slotMemory[s] && this._slotMemory[s] === id) return s
    }
    for (let s = 0; s < MAX_LOCAL_PLAYERS; s++) {
      if (this._slotToPad[s] === -1) return s
    }
    return -1
  }

  /** @returns {Gamepad|null} the live Gamepad object bound to a slot. */
  _getPadForSlot(slot) {
    const gpIndex = this._slotToPad[slot]
    if (gpIndex === undefined || gpIndex < 0) return null
    const list = this._rawPads()
    const gp = list[gpIndex]
    if (gp && gp.connected && gp.index === gpIndex) return gp
    // Fall back to a linear search — a couple of drivers renumber under us.
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].connected && list[i].index === gpIndex) return list[i]
    }
    return null
  }

  _notify(list, ...args) {
    for (const cb of list) {
      try {
        cb(...args)
      } catch (e) {
        // A listener throwing must never take the input system down.
      }
    }
  }

  /**
   * Sample one gamepad into `out`.
   *
   * Two mapping paths:
   *  - `mapping === 'standard'`: axes 0/1 = left stick, 2/3 = right stick, buttons 6/7 analog.
   *  - anything else (Xbox pads on Linux/Firefox commonly report ''): the button indices are
   *    the same, but the classic xpad axis layout is
   *      0,1 = left stick · 2 = LT · 3,4 = right stick · 5 = RT · 6,7 = D-pad hat.
   *    We detect that by axis count (>= 6) and remap. Trigger axes are only trusted once
   *    we've observed them rest at -1, so a unipolar driver can't fake a half-pressed trigger.
   */
  _readPad(gp, binding, out) {
    const axes = gp.axes || []
    const buttons = gp.buttons || []
    if (binding) binding.observeAxes(axes)

    const standard = gp.mapping === 'standard'
    const wideAxes = axes.length >= 6

    const lx = axes[0] || 0
    const ly = axes[1] || 0

    let rx = 0
    let ry = 0
    if (standard || !wideAxes) {
      rx = axes[2] || 0
      ry = axes[3] || 0
    } else {
      // Linux xpad / evdev layout.
      rx = axes[3] || 0
      ry = axes[4] || 0
    }

    // --- analog triggers ---------------------------------------------------
    let lt = buttonValue(buttons, BTN.LT)
    let rt = buttonValue(buttons, BTN.RT)
    if (!standard && wideAxes && binding) {
      if (binding.isBipolar(2)) lt = Math.max(lt, ((axes[2] || -1) + 1) * 0.5)
      if (binding.isBipolar(5)) rt = Math.max(rt, ((axes[5] || -1) + 1) * 0.5)
    }
    out.triggerL = Math.max(0, Math.min(1, lt))
    out.triggerR = Math.max(0, Math.min(1, rt))

    // --- D-pad (buttons, plus a hat on axes 6/7 for evdev pads) ------------
    let dUp = buttonDown(buttons, BTN.DUP)
    let dDown = buttonDown(buttons, BTN.DDOWN)
    let dLeft = buttonDown(buttons, BTN.DLEFT)
    let dRight = buttonDown(buttons, BTN.DRIGHT)
    if (!standard && axes.length >= 8) {
      const hx = axes[6] || 0
      const hy = axes[7] || 0
      if (hx < -0.5) dLeft = true
      if (hx > 0.5) dRight = true
      if (hy < -0.5) dUp = true
      if (hy > 0.5) dDown = true
    }

    // --- sticks ------------------------------------------------------------
    // Note the negation on Y: the raw gamepad axis is -1 when the stick is pushed away
    // from the player, but our contract is +1 = forward.
    const [mx, my] = applyDeadzone(lx, -ly, MOVE_DEADZONE, 2)
    out.moveX = mx
    out.moveY = my
    const [gx, gy] = applyDeadzone(rx, -ry, LOOK_DEADZONE, 2)
    out.lookX = gx
    out.lookY = gy

    // D-pad mirrors the left stick (§5) — full deflection, and it wins over a lazy stick.
    if (dLeft) out.moveX = -1
    if (dRight) out.moveX = 1
    if (dUp) out.moveY = 1
    if (dDown) out.moveY = -1

    // --- actions -----------------------------------------------------------
    const a = buttonDown(buttons, BTN.A)
    const b = buttonDown(buttons, BTN.B)
    const x = buttonDown(buttons, BTN.X)
    const y = buttonDown(buttons, BTN.Y)
    const bt = out.buttons
    bt.jump = a
    bt.strum = x
    bt.fly = b
    bt.dance = y || out.triggerL >= TRIGGER_THRESHOLD || out.triggerR >= TRIGGER_THRESHOLD
    bt.camera = buttonDown(buttons, BTN.RB) || buttonDown(buttons, BTN.R3)
    bt.pause = buttonDown(buttons, BTN.START)

    // The same four buttons again, under their duel names. Green A, red B,
    // blue X, yellow Y — matching the colours moulded into the pad itself.
    bt.string1 = a
    bt.string2 = b
    bt.string3 = x
    bt.string4 = y

    // Menu: D-pad first, then the left stick as a flick (a tighter gate than movement so
    // a menu never scrolls two entries from one nudge).
    bt.menuUp = dUp || my > 0.6
    bt.menuDown = dDown || my < -0.6
    bt.menuLeft = dLeft || mx < -0.6
    bt.menuRight = dRight || mx > 0.6
    bt.menuConfirm = a
    bt.menuBack = b || buttonDown(buttons, BTN.BACK)
  }

  // =========================================================================
  // Keyboard plumbing
  // =========================================================================

  _handleKeyDown(e) {
    if (this._disposed) return
    const code = e.code
    if (!code) return
    if (SWALLOW.has(code) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target
      const tag = t && t.tagName ? t.tagName.toUpperCase() : ''
      // Never steal keys from a real text field (the LAN room-code box).
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !(t && t.isContentEditable)) {
        e.preventDefault()
      }
    }
    if (e.repeat) return // OS auto-repeat is not "fresh" activity
    this._keys.add(code)
    this._keysLatched.add(code)
    this._kbFreshActivity = true
    this._kbAnyPressed = true
  }

  _handleKeyUp(e) {
    if (this._disposed) return
    if (!e.code) return
    this._keys.delete(e.code)
  }

  /** Alt-tabbing away must not leave a key jammed on. */
  _handleBlur() {
    this._keys.clear()
    this._keysLatched.clear()
  }

  /**
   * True while a real text field has focus — the online room-code box.
   *
   * Keys still reach the window listener while somebody is typing in it, so
   * without this, entering the code "BANJ" walks the join screen's selection
   * (A is menuLeft), and Backspace — the obvious way to fix a typo — reads as
   * menuBack and throws you out to the title screen. Both keyboard halves go
   * silent rather than filtering key by key: while somebody is typing, the
   * keyboard is not a controller.
   */
  _typing() {
    if (typeof document === 'undefined') return false
    const t = document.activeElement
    if (!t) return false
    const tag = t.tagName ? t.tagName.toUpperCase() : ''
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!t.isContentEditable
  }

  _readKeyboard(out) {
    clearSample(out)
    if (this._typing()) return
    const k = this._keys
    const latched = this._keysLatched
    const has = (c) => k.has(c) || latched.has(c)

    // Movement — WASD.
    //
    // The numpad used to double for this ("a left-handed lap setup"). It does not
    // any more: in split-screen the numpad is player 2's look, and a convenience
    // alias that silently steers the other player is worse than no alias.
    let mx = 0
    let my = 0
    if (has('KeyA')) mx -= 1
    if (has('KeyD')) mx += 1
    if (has('KeyW')) my += 1
    if (has('KeyS')) my -= 1
    // Normalise the diagonal so keyboard players don't move 1.41x faster corner-wise.
    if (mx !== 0 && my !== 0) {
      const inv = Math.SQRT1_2
      mx *= inv
      my *= inv
    }
    out.moveX = mx
    out.moveY = my

    // Look — arrow keys.
    let lx = 0
    let ly = 0
    if (has('ArrowLeft')) lx -= 1
    if (has('ArrowRight')) lx += 1
    if (has('ArrowUp')) ly += 1
    if (has('ArrowDown')) ly -= 1
    if (lx !== 0 && ly !== 0) {
      const inv = Math.SQRT1_2
      lx *= inv
      ly *= inv
    }
    out.lookX = lx
    out.lookY = ly

    // The four strings get TWO keyboard homes each: the number row (1234, which
    // matches the left-to-right order the duel draws them in) and the ZXCV row
    // (adjacent keys under four fingers, for anyone actually trying to be fast).
    // (No numpad here: Numpad2/4/5/8 are already the movement keys above.)
    const s1 = has('Digit1') || has('KeyZ')
    const s2 = has('Digit2') || has('KeyX')
    const s3 = has('Digit3') || has('KeyC')
    const s4 = has('Digit4') || has('KeyV')

    const bt = out.buttons
    bt.jump = has('Space')
    bt.strum = has('KeyE') || has('Enter') || has('NumpadEnter')
    bt.fly = has('KeyQ')
    bt.howdy = has('KeyH')
    bt.dance = has('KeyF')
    bt.camera = has('KeyR')
    bt.pause = has('Escape')
    bt.menuUp = has('ArrowUp') || has('KeyW')
    bt.menuDown = has('ArrowDown') || has('KeyS')
    bt.menuLeft = has('ArrowLeft') || has('KeyA')
    bt.menuRight = has('ArrowRight') || has('KeyD')
    bt.menuConfirm = has('Space') || has('Enter') || has('NumpadEnter') || has('KeyE')
    bt.menuBack = has('Escape') || has('Backspace')
    bt.string1 = s1
    bt.string2 = s2
    bt.string3 = s3
    bt.string4 = s4

    // ShiftLeft only. Right Shift is player 2's jump, and this analog trigger is
    // read as "lower the forks" by Forklift and "descend" by FlyingBanjo — so
    // sharing the key meant player 2 jumping dropped player 1's forks.
    out.triggerL = has('ShiftLeft') ? 1 : 0
    out.triggerR = has('Space') ? 1 : 0
  }

  /**
   * Player 2's half of one shared keyboard.
   *
   * Chosen so that NOTHING here collides with player 1's set, because two
   * children on one keyboard will lean on each other's keys and a shared binding
   * reads as "the game is broken":
   *
   *   move    I J K L          (the WASD shape, one hand to the right)
   *   look    numpad 8 4 6 2
   *   jump    Right Shift
   *   strum   numpad 0
   *   fly     numpad .
   *   dance   numpad +
   *   strings numpad 7 9 1 3   (top-left, top-right, bottom-left, bottom-right)
   *
   * The strings are laid out as a square rather than a run of four so a player
   * can find them by shape without looking down, which is the same reason they
   * are the four coloured face buttons on a pad.
   */
  _readKeyboard2(out) {
    clearSample(out)
    if (this._typing()) return
    const k = this._keys
    const latched = this._keysLatched
    const has = (c) => k.has(c) || latched.has(c)

    let mx = 0
    let my = 0
    if (has('KeyJ')) mx -= 1
    if (has('KeyL')) mx += 1
    if (has('KeyI')) my += 1
    if (has('KeyK')) my -= 1
    if (mx !== 0 && my !== 0) {
      const inv = Math.SQRT1_2
      mx *= inv
      my *= inv
    }
    out.moveX = mx
    out.moveY = my

    let lx = 0
    let ly = 0
    if (has('Numpad4')) lx -= 1
    if (has('Numpad6')) lx += 1
    if (has('Numpad8')) ly += 1
    if (has('Numpad2') || has('Numpad5')) ly -= 1
    if (lx !== 0 && ly !== 0) {
      const inv = Math.SQRT1_2
      lx *= inv
      ly *= inv
    }
    out.lookX = lx
    out.lookY = ly

    const s1 = has('Numpad7')
    const s2 = has('Numpad9')
    const s3 = has('Numpad1')
    const s4 = has('Numpad3')

    const bt = out.buttons
    bt.jump = has('ShiftRight')
    bt.strum = has('Numpad0')
    bt.fly = has('NumpadDecimal')
    bt.howdy = false
    bt.dance = has('NumpadAdd')
    bt.camera = has('NumpadSubtract')
    // No pause: one pause button for the television is enough, and it is P1's.
    bt.pause = false
    bt.menuUp = has('KeyI') || has('Numpad8')
    bt.menuDown = has('KeyK') || has('Numpad2')
    bt.menuLeft = has('KeyJ') || has('Numpad4')
    bt.menuRight = has('KeyL') || has('Numpad6')
    bt.menuConfirm = has('ShiftRight') || has('Numpad0')
    bt.menuBack = has('NumpadDecimal')
    bt.string1 = s1
    bt.string2 = s2
    bt.string3 = s3
    bt.string4 = s4

    out.triggerL = has('NumpadAdd') ? 1 : 0
    out.triggerR = has('ShiftRight') ? 1 : 0
  }

  // =========================================================================
  // Sample -> state
  // =========================================================================

  _copySample(src, dst) {
    dst.moveX = src.moveX
    dst.moveY = src.moveY
    dst.lookX = src.lookX
    dst.lookY = src.lookY
    dst.triggerL = src.triggerL
    dst.triggerR = src.triggerR
    for (const a of ALL_ACTIONS) dst.buttons[a] = src.buttons[a]
  }

  /** Is this source doing anything at all right now? */
  _sampleIsActive(s) {
    if (Math.abs(s.moveX) > 0.01 || Math.abs(s.moveY) > 0.01) return true
    if (Math.abs(s.lookX) > 0.01 || Math.abs(s.lookY) > 0.01) return true
    if (s.triggerL >= TRIGGER_THRESHOLD || s.triggerR >= TRIGGER_THRESHOLD) return true
    return this._sampleAnyButton(s)
  }

  _sampleAnyButton(s) {
    for (const a of ALL_ACTIONS) if (s.buttons[a]) return true
    return false
  }

  /** Fold a raw sample into a stable InputState, computing one-frame edge flags. */
  _applySample(state, sample, timers, dt) {
    state.moveX = sample.moveX
    state.moveY = sample.moveY
    state.lookX = sample.lookX
    state.lookY = sample.lookY
    state.triggerL = sample.triggerL
    state.triggerR = sample.triggerR

    for (const a of ALL_ACTIONS) {
      const btn = state[a]
      const down = !!sample.buttons[a]
      let pressed = down && !btn.down
      const released = !down && btn.down

      if (REPEATING.has(a)) {
        if (!down) {
          timers[a] = 0
        } else if (pressed) {
          timers[a] = REPEAT_DELAY
        } else {
          timers[a] -= dt
          if (timers[a] <= 0) {
            timers[a] += REPEAT_RATE
            pressed = true
          }
        }
      }

      btn.pressed = pressed
      btn.released = released
      btn.down = down
    }
  }
}
