// world/Textures.js — every surface in the store, drawn on a 2D canvas at boot.
//
// There is not one image file in this project. Each function here returns a
// THREE.Texture built from an OffscreenCanvas (or a real one, where that is
// unavailable), and everything is cached by key: the store has ~40 racking
// bays and they must not each upload their own copy of the same steel.
//
// A note on sizes: these are deliberately small (256–512). A warehouse store
// is seen from ten metres away with a bright overhead light on it, and the
// detail budget is far better spent on having MANY different product boxes
// than on any one of them being sharp.

import * as THREE from 'three'
import { rng } from '../core/Rng.js'

const cache = new Map()

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(w, h)
    } catch (e) {
      // Some older Safari builds expose the constructor but refuse 2D contexts.
    }
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * Draw into a fresh canvas and wrap the result in a cached THREE.Texture.
 * @param {string} key cache key — MUST vary with every parameter that changes
 *                     the drawing, or two different surfaces will share one.
 */
function texture(key, w, h, draw, opts = {}) {
  const hit = cache.get(key)
  if (hit) return hit

  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d')
  draw(ctx, w, h)

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = opts.wrapS || THREE.RepeatWrapping
  tex.wrapT = opts.wrapT || THREE.RepeatWrapping
  tex.anisotropy = opts.anisotropy ?? 4
  tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1])
  tex.needsUpdate = true
  cache.set(key, tex)
  return tex
}

/** Drop every cached texture. Called on teardown so a reload doesn't leak VRAM. */
export function disposeTextures() {
  for (const t of cache.values()) t.dispose()
  cache.clear()
}

// ===========================================================================
// Floors and structure
// ===========================================================================

/** Polished sealed concrete: grey, faintly mottled, with control joints. */
export function concreteTexture() {
  return texture('concrete', 512, 512, (ctx, w, h) => {
    const r = rng(1337)
    ctx.fillStyle = '#9a9a96'
    ctx.fillRect(0, 0, w, h)

    // Mottling. Big soft blobs first, then fine speckle — real power-troweled
    // concrete has both scales and only having one reads as noise.
    for (let i = 0; i < 260; i++) {
      const x = r() * w
      const y = r() * h
      const rad = 8 + r() * 46
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
      const v = 138 + Math.floor(r() * 36)
      g.addColorStop(0, `rgba(${v},${v},${v - 2},0.35)`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, rad, 0, Math.PI * 2)
      ctx.fill()
    }
    for (let i = 0; i < 4000; i++) {
      const v = 120 + Math.floor(r() * 70)
      ctx.fillStyle = `rgba(${v},${v},${v},0.25)`
      ctx.fillRect(r() * w, r() * h, 1.5, 1.5)
    }

    // Saw-cut control joints on a 4m grid, which at this repeat lands on the
    // edges of the tile.
    ctx.strokeStyle = 'rgba(70,70,70,0.55)'
    ctx.lineWidth = 3
    ctx.strokeRect(0, 0, w, h)

    // Scuffs from a thousand pallet jacks.
    ctx.strokeStyle = 'rgba(90,88,84,0.16)'
    for (let i = 0; i < 40; i++) {
      ctx.lineWidth = 1 + r() * 3
      ctx.beginPath()
      const x = r() * w
      const y = r() * h
      ctx.arc(x, y, 20 + r() * 90, r() * 6, r() * 6)
      ctx.stroke()
    }
  }, { repeat: [1, 1] })
}

/** The yellow-and-black hatched safety striping around the loading dock. */
export function hazardTexture() {
  return texture('hazard', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#f2c200'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#1c1c1c'
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.rotate(Math.PI / 4)
    for (let i = -3; i < 4; i++) ctx.fillRect(i * 44 - 11, -w, 22, w * 2)
    ctx.restore()
  })
}

/** Galvanised steel racking uprights — a punched channel section. */
export function steelTexture() {
  return texture('steel', 128, 256, (ctx, w, h) => {
    const r = rng(88)
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, '#6c7176')
    g.addColorStop(0.35, '#aeb4b9')
    g.addColorStop(0.6, '#8d9398')
    g.addColorStop(1, '#5f6469')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    // Spangle, the crystalline pattern galvanising leaves behind.
    for (let i = 0; i < 200; i++) {
      const v = 150 + Math.floor(r() * 80)
      ctx.fillStyle = `rgba(${v},${v + 4},${v + 8},0.2)`
      ctx.beginPath()
      ctx.arc(r() * w, r() * h, 2 + r() * 7, 0, Math.PI * 2)
      ctx.fill()
    }
    // Punched slots every 50mm, which is what makes it read as racking.
    ctx.fillStyle = 'rgba(30,34,38,0.85)'
    for (let y = 12; y < h; y += 28) {
      ctx.fillRect(w * 0.42, y, w * 0.16, 12)
    }
  })
}

/** Orange painted racking beams. */
export function beamTexture() {
  return texture('beam', 128, 64, (ctx, w, h) => {
    const r = rng(9001)
    ctx.fillStyle = '#d2601a'
    ctx.fillRect(0, 0, w, h)
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(255,255,255,0.25)')
    g.addColorStop(0.5, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.3)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    // Chips and scrapes where the forks have hit it.
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = `rgba(120,120,125,${0.3 + r() * 0.4})`
      ctx.fillRect(r() * w, r() * h, 2 + r() * 9, 1 + r() * 3)
    }
  })
}

/** Corrugated cardboard, for the pallets of stock. */
export function cardboardTexture(seed = 3) {
  return texture(`cardboard:${seed}`, 256, 256, (ctx, w, h) => {
    const r = rng(seed * 7919)
    ctx.fillStyle = '#c69a63'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 2600; i++) {
      const v = 140 + Math.floor(r() * 70)
      ctx.fillStyle = `rgba(${v},${v - 26},${v - 66},0.28)`
      ctx.fillRect(r() * w, r() * h, 2, 2)
    }
    // Flute lines — the giveaway that it is corrugated and not just brown.
    ctx.strokeStyle = 'rgba(150,110,66,0.22)'
    ctx.lineWidth = 1
    for (let x = 0; x < w; x += 6) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    // Packing tape down the middle.
    ctx.fillStyle = 'rgba(224,206,170,0.55)'
    ctx.fillRect(w * 0.44, 0, w * 0.12, h)
    // A shipping label.
    ctx.fillStyle = '#f2ede2'
    ctx.fillRect(w * 0.62, h * 0.16, w * 0.3, h * 0.2)
    ctx.fillStyle = '#3a3a3a'
    for (let i = 0; i < 14; i++) {
      const bw = 1 + Math.floor(r() * 4)
      ctx.fillRect(w * 0.64 + i * 6, h * 0.19, bw, h * 0.09)
    }
  })
}

// ===========================================================================
// Product boxes
// ===========================================================================

/**
 * A shelf-stable product box: a bold colour field, a white label band and a
 * blocky pseudo-logo. Deliberately abstract — this is a made-up warehouse
 * store selling made-up brands, and none of these are meant to resemble a real
 * product.
 */
export function productTexture(seed) {
  return texture(`product:${seed}`, 256, 256, (ctx, w, h) => {
    const r = rng(seed * 2654435761 + 17)
    const hue = Math.floor(r() * 360)
    const base = `hsl(${hue}, ${52 + r() * 30}%, ${42 + r() * 18}%)`
    const accent = `hsl(${(hue + 150 + r() * 60) % 360}, 70%, 58%)`

    ctx.fillStyle = base
    ctx.fillRect(0, 0, w, h)

    // A diagonal accent swoosh — every consumer package has one.
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.moveTo(0, h * (0.55 + r() * 0.2))
    ctx.lineTo(w, h * (0.3 + r() * 0.25))
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    ctx.fill()

    // White label band with abstract "text" bars. Real glyphs at this size are
    // unreadable mush; bars read as text from every distance the player sees.
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.fillRect(w * 0.1, h * 0.12, w * 0.8, h * 0.3)
    ctx.fillStyle = base
    ctx.fillRect(w * 0.14, h * 0.17, w * (0.3 + r() * 0.36), h * 0.09)
    ctx.fillStyle = 'rgba(60,60,60,0.7)'
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(w * 0.14, h * (0.29 + i * 0.037), w * (0.24 + r() * 0.42), h * 0.022)
    }

    // Contents blob: a big simple shape suggesting whatever is inside.
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.beginPath()
    const shape = Math.floor(r() * 3)
    if (shape === 0) {
      ctx.arc(w * 0.5, h * 0.68, w * 0.16, 0, Math.PI * 2)
    } else if (shape === 1) {
      ctx.roundRect?.(w * 0.34, h * 0.55, w * 0.32, h * 0.26, 12)
      if (!ctx.roundRect) ctx.rect(w * 0.34, h * 0.55, w * 0.32, h * 0.26)
    } else {
      ctx.moveTo(w * 0.5, h * 0.52)
      ctx.lineTo(w * 0.68, h * 0.82)
      ctx.lineTo(w * 0.32, h * 0.82)
      ctx.closePath()
    }
    ctx.fill()

    // Price flag, because a warehouse club is nothing without one.
    ctx.fillStyle = '#e33'
    ctx.fillRect(w * 0.66, h * 0.86, w * 0.28, h * 0.11)
    ctx.fillStyle = '#fff'
    ctx.fillRect(w * 0.7, h * 0.895, w * 0.2, h * 0.04)

    // Edge shading so the flat box face still has a hint of form.
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(255,255,255,0.14)')
    g.addColorStop(0.5, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.25)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })
}

// ===========================================================================
// Signage
// ===========================================================================

/**
 * An aisle sign. Real text, because these ARE meant to be read — by an adult
 * reading them aloud, mostly, which is half the fun of the aisle names.
 */
export function signTexture(number, label, bg = '#123a6b') {
  return texture(`sign:${number}:${label}:${bg}`, 512, 256, (ctx, w, h) => {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.fillRect(0, 0, w, h * 0.5)

    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 150px system-ui, sans-serif'
    ctx.fillText(String(number), w * 0.18, h * 0.5)

    ctx.font = 'bold 54px system-ui, sans-serif'
    ctx.textAlign = 'left'
    // Wrap onto two lines if it doesn't fit — some of these names are long.
    const words = label.split(' ')
    const lines = ['']
    for (const word of words) {
      const test = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${word}` : word
      if (ctx.measureText(test).width > w * 0.6 && lines[lines.length - 1]) lines.push(word)
      else lines[lines.length - 1] = test
    }
    const startY = h * 0.5 - ((lines.length - 1) * 60) / 2
    lines.forEach((line, i) => ctx.fillText(line, w * 0.34, startY + i * 60))
  }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping })
}

/** A big banner: coloured field, huge centred words. */
export function bannerTexture(text, bg = '#b8232f', fg = '#ffffff') {
  return texture(`banner:${text}:${bg}:${fg}`, 1024, 256, (ctx, w, h) => {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = fg
    ctx.lineWidth = 10
    ctx.strokeRect(14, 14, w - 28, h - 28)
    ctx.fillStyle = fg
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    let size = 110
    ctx.font = `bold ${size}px system-ui, sans-serif`
    while (ctx.measureText(text).width > w * 0.86 && size > 26) {
      size -= 6
      ctx.font = `bold ${size}px system-ui, sans-serif`
    }
    ctx.fillText(text, w / 2, h / 2 + 4)
  }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping })
}

// ===========================================================================
// Departments
// ===========================================================================

/** Frost on the freezer-door glass. */
export function frostTexture() {
  return texture('frost', 256, 256, (ctx, w, h) => {
    const r = rng(4242)
    ctx.fillStyle = 'rgba(200,232,245,0.5)'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 500; i++) {
      const x = r() * w
      const y = r() * h
      const rad = 2 + r() * 16
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
      g.addColorStop(0, 'rgba(255,255,255,0.6)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, rad, 0, Math.PI * 2)
      ctx.fill()
    }
    // Wiped streaks where someone opened the door.
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 6; i++) {
      ctx.lineWidth = 12 + r() * 26
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.beginPath()
      ctx.moveTo(r() * w, r() * h)
      ctx.quadraticCurveTo(r() * w, r() * h, r() * w, r() * h)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  })
}

/** Artificial turf for the garden centre. */
export function turfTexture() {
  return texture('turf', 256, 256, (ctx, w, h) => {
    const r = rng(777)
    ctx.fillStyle = '#3f7a33'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 5000; i++) {
      const g = 90 + Math.floor(r() * 80)
      ctx.strokeStyle = `rgba(${40 + Math.floor(r() * 30)},${g},${38},0.7)`
      ctx.lineWidth = 1 + r()
      const x = r() * w
      const y = r() * h
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + (r() - 0.5) * 5, y - 3 - r() * 6)
      ctx.stroke()
    }
  })
}

/** A wall of televisions showing a test pattern. */
export function screenTexture(seed = 1) {
  return texture(`screen:${seed}`, 256, 160, (ctx, w, h) => {
    const r = rng(seed * 31337)
    const bars = ['#c8c800', '#00c8c8', '#00c800', '#c800c8', '#c80000', '#0000c8', '#141414']
    const bw = w / bars.length
    bars.forEach((c, i) => {
      ctx.fillStyle = c
      ctx.fillRect(i * bw, 0, bw + 1, h * 0.7)
    })
    ctx.fillStyle = '#101018'
    ctx.fillRect(0, h * 0.7, w, h * 0.3)
    // Scanline haze, so the wall of them shimmers rather than sitting flat.
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1)
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255,255,255,${r() * 0.12})`
      ctx.fillRect(0, r() * h, w, 1)
    }
  }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping })
}

/** Melted / solid chocolate, for the banjo itself. */
export function chocolateTexture() {
  return texture('chocolate', 256, 256, (ctx, w, h) => {
    const r = rng(6060)
    ctx.fillStyle = '#4a2a15'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 900; i++) {
      const v = r()
      ctx.fillStyle = `rgba(${90 + v * 70},${50 + v * 44},${24 + v * 26},0.4)`
      ctx.beginPath()
      ctx.arc(r() * w, r() * h, 2 + r() * 12, 0, Math.PI * 2)
      ctx.fill()
    }
    // The moulded grid you get on the back of a chocolate bar.
    ctx.strokeStyle = 'rgba(30,16,8,0.5)'
    ctx.lineWidth = 4
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath()
      ctx.moveTo((i * w) / 4, 0)
      ctx.lineTo((i * w) / 4, h)
      ctx.moveTo(0, (i * h) / 4)
      ctx.lineTo(w, (i * h) / 4)
      ctx.stroke()
    }
  })
}

/** The corrugated steel of the back wall and roof deck. */
export function corrugatedTexture(color = '#8f9aa3') {
  return texture(`corr:${color}`, 128, 128, (ctx, w, h) => {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    for (let x = 0; x < w; x += 16) {
      const g = ctx.createLinearGradient(x, 0, x + 16, 0)
      g.addColorStop(0, 'rgba(0,0,0,0.22)')
      g.addColorStop(0.5, 'rgba(255,255,255,0.18)')
      g.addColorStop(1, 'rgba(0,0,0,0.22)')
      ctx.fillStyle = g
      ctx.fillRect(x, 0, 16, h)
    }
  })
}

/** A checkerboard of vinyl tiles for the food court. */
export function tileTexture() {
  return texture('tile', 256, 256, (ctx, w, h) => {
    const r = rng(2211)
    const s = w / 4
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#e8e3d6' : '#c23b34'
        ctx.fillRect(x * s, y * s, s, s)
      }
    }
    for (let i = 0; i < 1800; i++) {
      ctx.fillStyle = `rgba(0,0,0,${r() * 0.08})`
      ctx.fillRect(r() * w, r() * h, 2, 2)
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath()
      ctx.moveTo(i * s, 0)
      ctx.lineTo(i * s, h)
      ctx.moveTo(0, i * s)
      ctx.lineTo(w, i * s)
      ctx.stroke()
    }
  })
}
