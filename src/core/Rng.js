// Deterministic RNG. Every machine must generate the same world for LAN play,
// so nothing in this project may call Math.random().

/** mulberry32 — small, fast, good enough for scattering foliage. */
export function rng(seed = 1) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random float in [min, max). */
export function rangeFrom(r, min, max) {
  return min + r() * (max - min)
}

/** Random integer in [min, max]. */
export function intFrom(r, min, max) {
  return Math.floor(min + r() * (max - min + 1))
}

/** Pick one element. */
export function pick(r, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]
}

/**
 * Classic 2D value noise with smooth interpolation. Deterministic for a given seed.
 * Returns roughly -1..1.
 */
export function makeNoise2D(seed = 1337) {
  const r = rng(seed)
  const perm = new Uint8Array(512)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]

  const grad = (hash, x, y) => {
    // 8 gradient directions
    const h = hash & 7
    const u = h < 4 ? x : y
    const v = h < 4 ? y : x
    return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v)
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)

  return function noise2D(x, y) {
    const X = Math.floor(x) & 255
    const Y = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const u = fade(xf)
    const v = fade(yf)
    const aa = perm[perm[X] + Y]
    const ab = perm[perm[X] + Y + 1]
    const ba = perm[perm[X + 1] + Y]
    const bb = perm[perm[X + 1] + Y + 1]
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf))
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1))
    return (x1 + v * (x2 - x1)) * 0.5
  }
}

/** Fractal brownian motion over a noise2D function. */
export function fbm(noise, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}
