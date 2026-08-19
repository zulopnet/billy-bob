// game/FlyingBanjo.js — press B and the banjo flies.
//
// B used to say "howdy". It says this now.
//
// The problem it solves: the racking in the Giga-Mart is 8m tall and loaded to
// 6.3m, the ceiling is at 11m, and a good third of the interesting places in the
// building are simply above where a jump can reach. Big Earl's forks solve that
// for two players. This solves it for one.
//
// While it is out, the player's body stands where it was left and the camera
// goes with the banjo — so this is a mode, not a gadget. Three rules keep it
// from becoming a way to break the game or to get lost:
//
//   * It runs on a flight meter, and when the meter empties the banjo simply
//     flies home on its own. It cannot strand anybody, anywhere, ever.
//   * It is tethered. Past TETHER metres from the body it is pulled back, hard
//     enough that you cannot cross the store with it and gently enough that you
//     do not notice the leash until you lean on it.
//   * It cannot go through the building. Soft collision, generous radius: this
//     is a thing for reaching a shelf, not a noclip.

import * as THREE from 'three'
import { makeFlyingBanjo } from '../chars/Rigs.js'
import { STORE } from '../world/Store.js'
import { clamp, damp, dampAngle } from '../core/MathUtils.js'

/** Seconds of flight on a full meter. */
export const FLIGHT_TIME = 20

/** How fast the meter refills once the banjo is back. */
const REFILL_RATE = 1 / 14

const SPEED = 9.5
const CLIMB = 6.5
const ACCEL = 22
const TURN_RATE = 9

/** Never below this: it is a flying banjo, not a rolling one. */
const FLOOR_CLEARANCE = 0.9
/** Stay under the roof trusses. */
const CEILING = STORE.ceiling - 0.7

/** Metres from the player's body before the leash starts pulling. */
const TETHER = 26
/** How hard the leash pulls, per metre past the tether, in m/s. */
const TETHER_PULL = 2.4

/** Collision radius against the store. Fat, so it bumps rather than clips. */
const RADIUS = 0.55

/** Metres from the body at which a returning banjo is considered home. */
const HOME_DIST = 1.6

export const FLIGHT = {
  STOWED: 'stowed',
  FLYING: 'flying',
  RETURNING: 'returning',
}

export class FlyingBanjo {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/Store.js').Store} store
   * @param {import('../core/Audio.js').Audio} audio
   */
  constructor(scene, store, audio) {
    this.store = store
    this.audio = audio

    this.rig = makeFlyingBanjo()
    this.group = this.rig.group
    this.group.visible = false
    scene.add(this.group)

    this.state = FLIGHT.STOWED
    this.pos = new THREE.Vector3()
    this.vel = new THREE.Vector3()
    this.yaw = 0
    /** 0..1. Empties while flying, refills while stowed. */
    this.fuel = 1

    this._turn = 0
    this._climb = 0
    this._chirp = 0
    this._fwd = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._move = new THREE.Vector3()
  }

  get active() { return this.state !== FLIGHT.STOWED }
  /** The point the camera should look at while this is out. */
  get eye() { return this.pos }

  /**
   * Send it up.
   * @param {THREE.Vector3} from the player's shoulder
   * @param {number} yaw the direction the player is facing
   * @returns {boolean} false if there is not enough left in the meter
   */
  launch(from, yaw) {
    if (this.state !== FLIGHT.STOWED) return false
    // A sliver of meter buys a moment of flight and then a forced recall, which
    // reads as the button being broken. Make it refuse instead.
    if (this.fuel < 0.12) return false
    this.state = FLIGHT.FLYING
    this.pos.set(from.x, Math.max(from.y + 1.4, this.store.groundHeight(from.x, from.z, from.y + 3) + FLOOR_CLEARANCE), from.z)
    this.vel.set(0, 2.5, 0)
    this.yaw = yaw
    this.group.visible = true
    this.group.position.copy(this.pos)
    this.audio.roll(62, { gain: 0.5 })
    return true
  }

  /** Call it back. It flies home rather than blinking out. */
  recall() {
    if (this.state === FLIGHT.FLYING) {
      this.state = FLIGHT.RETURNING
      this.audio.pluck(50, { gain: 0.5 })
    }
  }

  /** Put it away instantly, wherever it is. For a duel, a pause or a melt. */
  stow() {
    this.state = FLIGHT.STOWED
    this.group.visible = false
    this.vel.set(0, 0, 0)
  }

  /**
   * @param {number} dt
   * @param {object} input the owning player's InputState
   * @param {THREE.Vector3} bodyPos where the player's body is standing
   * @param {number} camYaw the camera's yaw, so the stick is camera-relative
   */
  update(dt, input, bodyPos, camYaw) {
    if (this.state === FLIGHT.STOWED) {
      this.fuel = Math.min(1, this.fuel + REFILL_RATE * dt)
      return this.state
    }

    if (this.state === FLIGHT.FLYING) {
      this.fuel = Math.max(0, this.fuel - dt / FLIGHT_TIME)
      if (this.fuel <= 0) {
        this.state = FLIGHT.RETURNING
        this.audio.pluck(44, { gain: 0.5 })
      }
      this._fly(dt, input, bodyPos, camYaw)
    } else {
      this._returnHome(dt, bodyPos)
    }

    // --- collide ------------------------------------------------------------
    const before = this._scratchBefore || (this._scratchBefore = new THREE.Vector3())
    before.copy(this.pos)
    this.store.resolve(this.pos, RADIUS, 0.5)
    if (!before.equals(this.pos)) {
      // Bled rather than reflected: a bounce sends it somewhere the player did
      // not ask for, which at 6m up is disorienting.
      this.vel.x *= 0.35
      this.vel.z *= 0.35
    }

    const floor = this.store.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.3) + FLOOR_CLEARANCE
    if (this.pos.y < floor) { this.pos.y = floor; this.vel.y = Math.max(0, this.vel.y) }
    if (this.pos.y > CEILING) { this.pos.y = CEILING; this.vel.y = Math.min(0, this.vel.y) }

    this.group.position.copy(this.pos)
    this.group.rotation.y = this.yaw
    this.rig.update(dt, {
      speed: Math.hypot(this.vel.x, this.vel.z), turn: this._turn, climb: this._climb,
    })

    // A note every so often, so you can hear where it is when it is out of shot.
    this._chirp -= dt
    if (this._chirp <= 0) {
      this._chirp = 1.4
      this.audio.playString((Math.random() * 4) | 0, { gain: 0.16 })
    }

    return this.state
  }

  _fly(dt, input, bodyPos, camYaw) {
    const mx = input.moveX || 0
    const my = input.moveY || 0
    const mag = Math.min(1, Math.hypot(mx, my))

    // Camera-relative, exactly like walking, so nothing has to be relearned.
    this._fwd.set(-Math.sin(camYaw), 0, -Math.cos(camYaw))
    this._right.set(this._fwd.z, 0, -this._fwd.x)
    this._move.copy(this._fwd).multiplyScalar(my).addScaledVector(this._right, mx)
    if (this._move.lengthSq() > 1e-6) this._move.normalize()

    const tx = this._move.x * SPEED * mag
    const tz = this._move.z * SPEED * mag
    this.vel.x = damp(this.vel.x, tx, ACCEL * 0.35, dt)
    this.vel.z = damp(this.vel.z, tz, ACCEL * 0.35, dt)

    // A climbs, Y descends — the same two buttons that raise and lower Big
    // Earl's forks, because "up" should mean up on everything in this game.
    let climb = 0
    if (input.jump && input.jump.down) climb += 1
    if (input.dance && input.dance.down) climb -= 1
    climb += (input.triggerR || 0) - (input.triggerL || 0)
    climb = clamp(climb, -1, 1)
    this._climb = climb
    this.vel.y = damp(this.vel.y, climb * CLIMB, 8, dt)

    // --- the leash ----------------------------------------------------------
    const dx = this.pos.x - bodyPos.x
    const dz = this.pos.z - bodyPos.z
    const far = Math.hypot(dx, dz)
    if (far > TETHER) {
      const over = far - TETHER
      const pull = Math.min(SPEED, over * TETHER_PULL)
      this.vel.x -= (dx / far) * pull
      this.vel.z -= (dz / far) * pull
    }

    this.pos.addScaledVector(this.vel, dt)

    if (mag > 0.12) {
      const want = Math.atan2(this._move.x, this._move.z)
      const prev = this.yaw
      this.yaw = dampAngle(this.yaw, want, TURN_RATE, dt)
      // Bank into the turn, measured from what the yaw actually did this frame.
      this._turn = damp(this._turn, clamp((this.yaw - prev) / Math.max(dt, 1e-4) * 0.35, -1, 1), 8, dt)
    } else {
      this._turn = damp(this._turn, 0, 6, dt)
    }
  }

  /** Fly back to the player under its own power. */
  _returnHome(dt, bodyPos) {
    const tx = bodyPos.x
    const ty = bodyPos.y + 1.5
    const tz = bodyPos.z
    const dx = tx - this.pos.x
    const dy = ty - this.pos.y
    const dz = tz - this.pos.z
    const d = Math.hypot(dx, dy, dz)

    if (d < HOME_DIST) {
      this.stow()
      this.audio.pluck(67, { gain: 0.45 })
      return
    }

    // Faster the further out it is, so a long way home is not a long wait.
    const speed = Math.min(18, 5 + d * 0.9)
    this.vel.set((dx / d) * speed, (dy / d) * speed, (dz / d) * speed)
    this.pos.addScaledVector(this.vel, dt)
    this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), TURN_RATE, dt)
    this._climb = clamp(dy * 0.2, -1, 1)
    this._turn = damp(this._turn, 0, 6, dt)
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group)
    this.rig.dispose?.()
  }
}
