// Small shared math helpers. Frame-rate independent smoothing everywhere —
// nothing in this game should feel different at 30 fps than at 144 fps.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
export const lerp = (a, b, t) => a + (b - a) * t
export const saturate = (v) => clamp(v, 0, 1)

export function smoothstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export function smootherstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * Exponential smoothing that is correct for a variable timestep.
 * `lambda` is roughly "how fast" — 8 is snappy, 2 is lazy.
 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}

/** Same, for THREE.Vector3-likes. Mutates and returns `current`. */
export function dampVec3(current, target, lambda, dt) {
  const t = 1 - Math.exp(-lambda * dt)
  current.x += (target.x - current.x) * t
  current.y += (target.y - current.y) * t
  current.z += (target.z - current.z) * t
  return current
}

/** Shortest signed angular difference, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Damp an angle the short way around. */
export function dampAngle(current, target, lambda, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt))
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta
}

/** Radial deadzone with a squared response curve — gentle for small hands. */
export function applyDeadzone(x, y, deadzone = 0.22, curve = 2) {
  const mag = Math.hypot(x, y)
  if (mag < deadzone) return [0, 0]
  const norm = Math.min(1, (mag - deadzone) / (1 - deadzone))
  const scaled = Math.pow(norm, curve) / mag
  return [x * scaled, y * scaled]
}

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI
