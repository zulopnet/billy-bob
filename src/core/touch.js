// touch.js — the shared mobile layer.
//
// One file, copied verbatim into each of the four games (they are separate
// self-contained bundles with no shared package, so a copy is the honest way to
// share this). If you fix a bug here, fix it in all four:
//
//   ~/cave-ray/game/src/core/touch.js
//   ~/dog/src/core/touch.js
//   ~/forged-dominion_3D/src/ui/touch.js
//   ~/billy-bob/src/core/touch.js
//
// What it provides:
//   isTouchDevice()  — feature detection, not UA sniffing, with a URL override
//   MobileShell      — orientation gate, fullscreen, iOS gesture suppression
//   TouchLayer       — floating sticks, look zones and buttons over the canvas
//
// Everything here is DOM + CSS. No canvas, no per-frame allocation, no
// dependency on Three.js — the games differ too much to share anything above
// this line.

// ===========================================================================
// Detection
// ===========================================================================

/**
 * Is this a touch-first device?
 *
 * Feature detection rather than a user-agent string: iPadOS Safari has lied
 * about being a Mac since iOS 13, and every UA table goes stale. `pointer:
 * coarse` is true when the PRIMARY pointer is a finger, so a laptop with a
 * touchscreen and a trackpad correctly reads as desktop.
 *
 * `?touch=1` forces the mobile UI on (for testing from a desktop browser) and
 * `?touch=0` forces it off (for a tablet with a keyboard and mouse attached).
 */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false
  try {
    const q = new URLSearchParams(window.location.search).get('touch')
    if (q === '1' || q === 'true' || q === 'on') return true
    if (q === '0' || q === 'false' || q === 'off') return false
  } catch (e) {
    // A malformed query string is not a reason to fail to boot.
  }
  const coarse = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
  const points = (navigator && navigator.maxTouchPoints) || 0
  return !!coarse && points > 0
}

/** iOS/iPadOS, which needs several workarounds the other platforms do not. */
export function isIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ reports a desktop Mac UA but is the only "Mac" with a touchscreen.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1
}

// ===========================================================================
// Stylesheet (injected once, shared by the shell and the control layer)
// ===========================================================================

const STYLE_ID = 'touch-layer-style'

const CSS = `
.tl-root, .tl-gate {
  position: fixed;
  inset: 0;
  z-index: 60;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.tl-root { pointer-events: none; }
.tl-root[hidden] { display: none; }

/* Zones are invisible catchers. They sit UNDER the buttons in paint order so a
   button always wins the pointer, and they never draw anything themselves. */
.tl-zone {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
  background: transparent;
}

/* --- floating stick ------------------------------------------------------ */
/* The base is placed wherever the thumb lands rather than being pinned to a
   fixed spot. On a phone held in two hands the thumb never arrives in the same
   place twice, and a fixed nub means the first 100ms of every input is spent
   hunting for it. */
.tl-stick-base, .tl-stick-knob {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 140ms ease;
  will-change: transform, opacity;
}
.tl-stick-base {
  border: 2px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(2px);
}
.tl-stick-knob {
  border: 2px solid rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.28);
}
.tl-stick-base.on, .tl-stick-knob.on { opacity: 1; }

/* A dim resting hint so a first-time player knows the left side is a stick. */
.tl-stick-hint {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  border: 2px dashed rgba(255, 255, 255, 0.22);
  opacity: 1;
  transition: opacity 200ms ease;
}
.tl-stick-hint.off { opacity: 0; }

/* --- buttons ------------------------------------------------------------- */
.tl-btn {
  position: absolute;
  display: grid;
  place-items: center;
  pointer-events: auto;
  touch-action: none;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.4);
  background: rgba(12, 18, 26, 0.5);
  backdrop-filter: blur(3px);
  color: #fff;
  font-weight: 700;
  line-height: 1.05;
  text-align: center;
  letter-spacing: 0.02em;
  transition: background 90ms ease, transform 90ms ease, border-color 90ms ease;
}
.tl-btn.square { border-radius: 14px; }
.tl-btn.on {
  background: rgba(255, 255, 255, 0.42);
  border-color: #fff;
  transform: scale(0.93);
}
.tl-btn.latched {
  background: rgba(255, 207, 107, 0.5);
  border-color: #ffcf6b;
}
.tl-btn[hidden] { display: none; }
.tl-btn small {
  display: block;
  font-size: 0.62em;
  font-weight: 600;
  opacity: 0.75;
  letter-spacing: 0.06em;
}

/* --- orientation gate ---------------------------------------------------- */
.tl-gate {
  z-index: 90;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
  padding: 2rem;
  text-align: center;
  color: #e8f2f8;
  background: radial-gradient(ellipse at 50% 40%, #16202c 0%, #05080c 75%);
  pointer-events: auto;
}
.tl-gate.show { display: flex; }
.tl-gate h2 {
  margin: 0;
  font-size: clamp(1.1rem, 5vw, 1.6rem);
  font-weight: 700;
  letter-spacing: 0.02em;
}
.tl-gate p {
  margin: 0;
  max-width: 24rem;
  font-size: 0.95rem;
  line-height: 1.5;
  color: rgba(232, 242, 248, 0.62);
}
/* A phone that rotates itself, so the instruction is unambiguous without words. */
.tl-gate .glyph {
  width: 76px;
  height: 122px;
  border: 3px solid rgba(232, 242, 248, 0.75);
  border-radius: 12px;
  animation: tl-rotate 2.4s ease-in-out infinite;
}
@keyframes tl-rotate {
  0%, 32% { transform: rotate(0deg); }
  56%, 88% { transform: rotate(-90deg); }
  100% { transform: rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  .tl-gate .glyph { animation: none; transform: rotate(-90deg); }
}
`

function injectStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

// ===========================================================================
// MobileShell — orientation, fullscreen, and the platform's sharp edges
// ===========================================================================

/**
 * Wraps the things every touch build needs before a single control is drawn:
 * a landscape gate, a best-effort fullscreen + orientation lock, and the
 * suppression of Safari's pinch-zoom / double-tap-zoom / long-press-callout,
 * all three of which fire constantly during normal play and are indistinguishable
 * from a bug when they do.
 */
export class MobileShell {
  /**
   * @param {object} opts
   * @param {string} [opts.title] headline shown on the rotate gate
   * @param {string} [opts.body] supporting line on the rotate gate
   * @param {boolean} [opts.requireLandscape=true] gate portrait entirely
   * @param {HTMLElement} [opts.fullscreenTarget] element to make fullscreen
   */
  constructor({
    title = 'Rotate your phone',
    body = 'This game is played in landscape.',
    requireLandscape = true,
    fullscreenTarget = null,
  } = {}) {
    injectStyle()
    this.requireLandscape = requireLandscape
    this.fullscreenTarget = fullscreenTarget || document.documentElement
    this._cbs = []
    this._disposed = false
    this._armed = false

    // --- rotate gate -------------------------------------------------------
    const gate = document.createElement('div')
    gate.className = 'tl-gate'
    gate.innerHTML =
      '<div class="glyph"></div>' +
      `<h2></h2><p></p>`
    gate.querySelector('h2').textContent = title
    gate.querySelector('p').textContent = body
    document.body.appendChild(gate)
    this.gate = gate

    // --- listeners ---------------------------------------------------------
    this._onResize = () => this._sync()
    window.addEventListener('resize', this._onResize)
    window.addEventListener('orientationchange', this._onResize)
    if (window.screen && screen.orientation) {
      screen.orientation.addEventListener?.('change', this._onResize)
    }

    // Safari fires `gesturestart` for pinch-zoom on the PAGE. Left alone, a
    // two-finger camera gesture zooms the document instead, and the game is
    // then rendered at 2x under a viewport the player cannot get back.
    this._onGesture = (e) => e.preventDefault()
    document.addEventListener('gesturestart', this._onGesture, { passive: false })
    document.addEventListener('gesturechange', this._onGesture, { passive: false })
    document.addEventListener('gestureend', this._onGesture, { passive: false })

    // iOS has no `touch-action: none` on the document scroller, so a drag that
    // starts on the canvas still rubber-bands the whole page. Non-passive
    // preventDefault on a multi-touch or canvas-origin move is the only fix.
    this._onTouchMove = (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault()
    }
    document.addEventListener('touchmove', this._onTouchMove, { passive: false })

    // Double-tap-to-zoom is not suppressed by touch-action on older iOS.
    let lastTouchEnd = 0
    this._onTouchEnd = (e) => {
      const now = Date.now()
      if (now - lastTouchEnd < 320) e.preventDefault()
      lastTouchEnd = now
    }
    document.addEventListener('touchend', this._onTouchEnd, { passive: false })

    this._sync()
  }

  /** True while the device is being held in portrait. */
  get portrait() {
    return window.innerHeight > window.innerWidth
  }

  /** True when the game should be interactive (landscape, or portrait allowed). */
  get ready() {
    return !this.requireLandscape || !this.portrait
  }

  /** Register `(ready) => {}`, fired whenever the gate opens or closes. */
  onReady(cb) {
    if (typeof cb === 'function') this._cbs.push(cb)
    return () => {
      const i = this._cbs.indexOf(cb)
      if (i >= 0) this._cbs.splice(i, 1)
    }
  }

  /**
   * Go fullscreen and pin the orientation. MUST be called from inside a real
   * user gesture handler (a tap on the title screen) or every browser refuses.
   *
   * All of it is best-effort and none of it is load-bearing: iPhone Safari
   * supports neither fullscreen nor orientation lock, which is exactly why the
   * rotate gate above exists rather than relying on the lock.
   */
  async armImmersive() {
    if (this._armed || this._disposed) return
    this._armed = true
    const el = this.fullscreenTarget
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
    } catch (e) {
      // Denied, or unsupported. Fine — we still play, just with the URL bar.
    }
    try {
      if (this.requireLandscape && screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape')
      }
    } catch (e) {
      // Unsupported on iOS and on any browser not in fullscreen. The gate covers it.
    }
    this._sync()
  }

  _sync() {
    if (this._disposed) return
    const ready = this.ready
    this.gate.classList.toggle('show', !ready)
    for (const cb of this._cbs) {
      try {
        cb(ready)
      } catch (e) {
        // A listener throwing must never wedge the orientation gate shut.
      }
    }
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('orientationchange', this._onResize)
    screen.orientation?.removeEventListener?.('change', this._onResize)
    document.removeEventListener('gesturestart', this._onGesture)
    document.removeEventListener('gesturechange', this._onGesture)
    document.removeEventListener('gestureend', this._onGesture)
    document.removeEventListener('touchmove', this._onTouchMove)
    document.removeEventListener('touchend', this._onTouchEnd)
    this.gate.remove()
    this._cbs.length = 0
  }
}

// ===========================================================================
// Widgets
// ===========================================================================

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Capture a pointer, tolerating the cases where the browser refuses.
 *
 * `setPointerCapture` throws NotFoundError whenever the pointer is already gone
 * by the time the handler runs — a real occurrence on a loaded phone, where a
 * quick tap's pointerup can be dispatched before our pointerdown handler is
 * reached. Letting that throw propagate would abandon the rest of the handler
 * with the widget half-armed and its pointer id set, i.e. permanently stuck.
 * Capture is an optimisation (it keeps a drag alive outside the element); the
 * widget works without it, so a failure here is not worth a single dropped frame.
 */
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId)
  } catch (e) {
    // Pointer already released, or a synthetic event. Carry on uncaptured.
  }
}

/**
 * A floating analog stick.
 *
 * Axis convention matches the gamepad code in every game here:
 *   x: +1 = right     y: +1 = FORWARD / UP
 * (i.e. already negated from screen coordinates, where +y is down.)
 */
class Stick {
  constructor(layer, {
    zone,
    radius = 62,
    deadzone = 0.14,
    hintAt = null,
  }) {
    this.x = 0
    this.y = 0
    this.active = false
    this.radius = radius
    this.deadzone = deadzone
    this._pointerId = null
    this._ox = 0
    this._oy = 0

    this.zone = zone

    const base = document.createElement('div')
    base.className = 'tl-stick-base'
    base.style.width = base.style.height = `${radius * 2}px`
    const knob = document.createElement('div')
    knob.className = 'tl-stick-knob'
    knob.style.width = knob.style.height = `${radius * 0.86}px`
    layer.root.appendChild(base)
    layer.root.appendChild(knob)
    this.base = base
    this.knob = knob

    if (hintAt) {
      const hint = document.createElement('div')
      hint.className = 'tl-stick-hint'
      hint.style.width = hint.style.height = `${radius * 2}px`
      hint.style.left = hintAt.left
      hint.style.bottom = hintAt.bottom
      hint.style.transform = 'translate(-50%, 50%)'
      layer.root.appendChild(hint)
      this.hint = hint
    }

    zone.addEventListener('pointerdown', (e) => {
      if (this._pointerId !== null) return
      this._pointerId = e.pointerId
      capture(zone, e.pointerId)
      this._ox = e.clientX
      this._oy = e.clientY
      this.active = true
      base.style.left = `${this._ox}px`
      base.style.top = `${this._oy}px`
      base.style.transform = 'translate(-50%, -50%)'
      base.classList.add('on')
      knob.classList.add('on')
      this.hint?.classList.add('off')
      this._move(e.clientX, e.clientY)
      e.preventDefault()
    })

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._pointerId) return
      this._move(e.clientX, e.clientY)
      e.preventDefault()
    })

    const end = (e) => this._release(e.pointerId)
    zone.addEventListener('pointerup', end)
    zone.addEventListener('pointercancel', end)
    zone.addEventListener('lostpointercapture', end)
  }

  /** Let go, if `pointerId` is the one we are holding. */
  _release(pointerId) {
    if (pointerId !== this._pointerId) return
    this.reset()
  }

  _move(cx, cy) {
    let dx = cx - this._ox
    let dy = cy - this._oy
    const len = Math.hypot(dx, dy)
    const r = this.radius

    // Past the rim the base slides along with the thumb, so a long drag never
    // saturates and then feels dead. This is what makes a floating stick usable
    // for a five-year-old who pushes to the edge of the screen and keeps going.
    if (len > r) {
      const over = len - r
      this._ox += (dx / len) * over
      this._oy += (dy / len) * over
      this.base.style.left = `${this._ox}px`
      this.base.style.top = `${this._oy}px`
      dx = (dx / len) * r
      dy = (dy / len) * r
    }

    this.knob.style.left = `${this._ox + dx}px`
    this.knob.style.top = `${this._oy + dy}px`
    this.knob.style.transform = 'translate(-50%, -50%)'

    let nx = dx / r
    let ny = -dy / r // screen +y is down; our contract is +y forward
    const mag = Math.hypot(nx, ny)
    if (mag < this.deadzone) {
      this.x = 0
      this.y = 0
      return
    }
    // Rescale past the deadzone so the very first movement is still smooth
    // rather than jumping to `deadzone` worth of speed.
    const scaled = Math.min(1, (mag - this.deadzone) / (1 - this.deadzone))
    this.x = (nx / mag) * scaled
    this.y = (ny / mag) * scaled
  }

  setVisible(v) {
    if (this.hint) this.hint.style.display = v ? '' : 'none'
  }

  /**
   * Drop the current touch and re-centre. Call this whenever the stick is taken
   * away mid-gesture (a mode change, a menu opening): the pointerup will be
   * delivered to a hidden element or not at all, and without this the stick
   * stays deflected and the player walks into a wall behind the menu.
   */
  reset() {
    this._pointerId = null
    this.active = false
    this.x = 0
    this.y = 0
    this.base.classList.remove('on')
    this.knob.classList.remove('on')
    this.hint?.classList.remove('off')
  }
}

/**
 * A drag region that reports pixel deltas — the touch equivalent of mouse-look.
 *
 * Deltas accumulate between frames and are zeroed by `consume()`, so a frame
 * that runs long never loses input and one that runs short never double-counts.
 */
class LookZone {
  constructor(layer, { zone, onTap = null, tapSlop = 12, tapMs = 260 }) {
    this.dx = 0
    this.dy = 0
    this.active = false
    this._pointerId = null
    this._lx = 0
    this._ly = 0
    this._downAt = 0
    this._downX = 0
    this._downY = 0
    this._moved = 0
    this.zone = zone

    zone.addEventListener('pointerdown', (e) => {
      if (this._pointerId !== null) return
      this._pointerId = e.pointerId
      capture(zone, e.pointerId)
      this._lx = this._downX = e.clientX
      this._ly = this._downY = e.clientY
      this._downAt = performance.now()
      this._moved = 0
      this.active = true
      e.preventDefault()
    })

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._pointerId) return
      // Deliberately NOT e.movementX: it is 0 on iOS Safari for touch pointers.
      const dx = e.clientX - this._lx
      const dy = e.clientY - this._ly
      this._lx = e.clientX
      this._ly = e.clientY
      this.dx += dx
      this.dy += dy
      this._moved = Math.max(this._moved, Math.hypot(e.clientX - this._downX, e.clientY - this._downY))
      e.preventDefault()
    })

    this._onTap = onTap
    this._tapSlop = tapSlop
    this._tapMs = tapMs

    const end = (e) => this._release(e.pointerId)
    zone.addEventListener('pointerup', end)
    zone.addEventListener('pointercancel', end)
    zone.addEventListener('lostpointercapture', end)
  }

  _release(pointerId) {
    if (pointerId !== this._pointerId) return
    this._pointerId = null
    this.active = false
    if (this._onTap && this._moved < this._tapSlop && performance.now() - this._downAt < this._tapMs) {
      this._onTap(this._downX, this._downY)
    }
  }

  /** @returns {{dx:number, dy:number}} the delta since the last call, then zeroes. */
  consume() {
    const out = { dx: this.dx, dy: this.dy }
    this.dx = 0
    this.dy = 0
    return out
  }
}

/**
 * An on-screen button with the same `{down, pressed, released}` triple the
 * gamepad code produces, so a game can treat it as just another input source.
 *
 * `pressed`/`released` are one-frame edges computed in `TouchLayer.update()`.
 * A press that begins and ends between two frames is latched so a fast tap is
 * never swallowed — the same problem the keyboard path already solves.
 */
class Button {
  constructor(layer, {
    label = '',
    sub = '',
    size = 62,
    at = {},
    square = false,
    toggle = false,
    onTap = null,
    className = '',
  }) {
    this.down = false
    this.pressed = false
    this.released = false
    this.latched = false // for toggle buttons
    this.onTap = onTap

    this._rawDown = false
    this._tapLatch = false
    this._pointerId = null
    this._toggle = toggle

    const el = document.createElement('button')
    el.type = 'button'
    el.className = `tl-btn${square ? ' square' : ''}${className ? ' ' + className : ''}`
    el.style.width = el.style.height = `${size}px`
    el.style.fontSize = `${Math.round(size * 0.3)}px`
    for (const k of ['left', 'right', 'top', 'bottom']) {
      if (at[k] !== undefined) el.style[k] = at[k]
    }
    el.innerHTML = sub ? `<span>${label}<small>${sub}</small></span>` : `<span>${label}</span>`
    layer.root.appendChild(el)
    this.el = el

    el.addEventListener('pointerdown', (e) => {
      if (this._pointerId !== null) return
      // Arm BEFORE capturing: capture is the part that can fail, and a press
      // that got as far as this handler has already happened.
      this._pointerId = e.pointerId
      this._rawDown = true
      this._tapLatch = true
      capture(el, e.pointerId)
      el.classList.add('on')
      if (toggle) {
        this.latched = !this.latched
        el.classList.toggle('latched', this.latched)
      }
      if (onTap) onTap(this)
      e.preventDefault()
      e.stopPropagation()
    })

    const end = (e) => this._release(e.pointerId)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('lostpointercapture', end)
    // Stop a synthesized click from also reaching the canvas underneath.
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation() })
  }

  _release(pointerId) {
    if (pointerId !== this._pointerId) return
    this._pointerId = null
    this._rawDown = false
    this.el.classList.remove('on')
  }

  _update() {
    const down = this._rawDown || this._tapLatch
    this._tapLatch = false
    this.pressed = down && !this.down
    this.released = !down && this.down
    this.down = down
  }

  setLabel(label, sub = '') {
    this.el.innerHTML = sub ? `<span>${label}<small>${sub}</small></span>` : `<span>${label}</span>`
  }

  setLatched(v) {
    this.latched = !!v
    this.el.classList.toggle('latched', this.latched)
  }

  setVisible(v) {
    this.el.hidden = !v
    if (!v) this.reset()
  }

  /** Forget any in-flight press. Same reasoning as `Stick.reset`. */
  reset() {
    this._pointerId = null
    this._rawDown = false
    this._tapLatch = false
    this.el.classList.remove('on')
  }
}

/**
 * The container. Owns a fixed, pointer-transparent root over the canvas; every
 * widget added to it opts back into pointer events for its own rectangle.
 *
 * Call `update()` exactly once per frame, before reading any button edges.
 */
export class TouchLayer {
  /**
   * @param {HTMLElement} [parent]
   * @param {object} [opts]
   * @param {number} [opts.zIndex] stacking order. Set this BELOW the game's own
   *   HUD layer so DOM menus stay tappable and simply cover the sticks.
   */
  constructor(parent = document.body, { zIndex = null } = {}) {
    injectStyle()
    const root = document.createElement('div')
    root.className = 'tl-root'
    if (zIndex !== null) root.style.zIndex = String(zIndex)
    parent.appendChild(root)
    this.root = root
    this.buttons = []
    this.sticks = []
    this.looks = []
    this.zones = []

    // The safety net. Pointer capture is what normally guarantees a widget
    // hears its own pointerup, and capture is not guaranteed: it fails if the
    // pointer is already gone, and it is dropped outright when an element is
    // hidden mid-gesture. Either way the up event lands somewhere else and the
    // widget stays held down forever — a stuck stick, which in this game means
    // walking into a wall until the tab is reloaded.
    //
    // So every release is ALSO heard at the window, in the capture phase so it
    // arrives even if something below stops propagation. `_release` is a no-op
    // for any widget not holding that id, so double delivery is harmless.
    this._onGlobalUp = (e) => {
      for (const s of this.sticks) s._release(e.pointerId)
      for (const l of this.looks) l._release(e.pointerId)
      for (const b of this.buttons) b._release(e.pointerId)
    }
    window.addEventListener('pointerup', this._onGlobalUp, true)
    window.addEventListener('pointercancel', this._onGlobalUp, true)
    // Backgrounding the tab is the other way a finger silently stops existing.
    this._onBlur = () => this.releaseAll()
    window.addEventListener('blur', this._onBlur)
    document.addEventListener('visibilitychange', this._onBlur)
  }

  /** Drop every in-flight gesture. */
  releaseAll() {
    for (const s of this.sticks) s.reset()
    for (const b of this.buttons) b.reset()
    for (const l of this.looks) {
      l._pointerId = null
      l.active = false
      l.consume()
    }
  }

  /**
   * Add an invisible catcher rectangle. Positions are CSS strings so callers
   * can use `env(safe-area-inset-*)` and percentages freely.
   */
  addZone({ left = '0', top = '0', width = '50%', height = '100%', right, bottom } = {}) {
    const z = document.createElement('div')
    z.className = 'tl-zone'
    z.style.left = left
    z.style.top = top
    z.style.width = width
    z.style.height = height
    if (right !== undefined) { z.style.right = right; z.style.left = '' }
    if (bottom !== undefined) { z.style.bottom = bottom; z.style.top = '' }
    // Zones go first so later-added buttons paint (and hit-test) above them.
    this.root.insertBefore(z, this.root.firstChild)
    this.zones.push(z)
    return z
  }

  addStick(opts = {}) {
    const zone = opts.zone || this.addZone(opts.zoneRect || { width: '45%' })
    const s = new Stick(this, { ...opts, zone })
    this.sticks.push(s)
    return s
  }

  addLookZone(opts = {}) {
    const zone = opts.zone || this.addZone(opts.zoneRect || { left: '45%', width: '55%' })
    const l = new LookZone(this, { ...opts, zone })
    this.looks.push(l)
    return l
  }

  addButton(opts = {}) {
    const b = new Button(this, opts)
    this.buttons.push(b)
    return b
  }

  /** Recompute every button's one-frame edges. Once per frame, before reads. */
  update() {
    for (const b of this.buttons) b._update()
  }

  setVisible(v) {
    this.root.hidden = !v
    if (!v) {
      this.releaseAll()
      for (const b of this.buttons) b.down = b.pressed = b.released = false
    }
  }

  dispose() {
    window.removeEventListener('pointerup', this._onGlobalUp, true)
    window.removeEventListener('pointercancel', this._onGlobalUp, true)
    window.removeEventListener('blur', this._onBlur)
    document.removeEventListener('visibilitychange', this._onBlur)
    this.root.remove()
    this.buttons.length = 0
    this.sticks.length = 0
    this.looks.length = 0
    this.zones.length = 0
  }
}
