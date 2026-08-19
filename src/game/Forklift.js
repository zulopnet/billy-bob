// game/Forklift.js — Big Earl, made drivable.
//
// Earl used to be the sixth critter you duelled. He is a vehicle now, and the
// owl took his seat in the band.
//
// The driving model is copied in spirit from ~/dog/src/game/Driving.js, which
// is the one in this house that has actually been played by a five-year-old:
//
//   · one stick does everything — push forward to go, pull back to reverse,
//     push sideways to steer. No accelerator button, no gears, nothing to hold.
//   · velocity is ALWAYS along the heading, so Earl physically cannot spin out,
//     drift or end up facing a way nobody asked for.
//   · the steering assist is huge at walking pace (he pivots almost on the
//     spot) and tapers off with speed, so a full-speed flick does not whip the
//     camera round.
//   · nothing here damages, stalls or strands anybody. A genuine wedge — no
//     movement at all for seconds, with the stick pushed — is answered with a
//     quiet shove backwards, never a warp.
//
// The forks go up and down, and that is the co-op half of this module: the deck
// on the carriage is a real moving platform (`platform()`), and Game feeds it to
// every other player's ground check. One child drives, the other rides up to the
// top of the racking. That, and the flying banjo, are the two ways to reach the
// things you cannot jump to.

import * as THREE from 'three'
import { makeForklift, FORK_LIFT_RANGE } from '../chars/Rigs.js'
import { clamp, damp, lerp } from '../core/MathUtils.js'

/** Metres per second, forward and in reverse. Earl is not quick. */
const FWD = 7.4
const REV = 3.2
const ACCEL = 2.6

/** Turn rate in rad/s at a standstill and at top speed. */
const TURN_LO = 2.3
const TURN_HI = 0.9

/** Fork travel, metres per second. */
const LIFT_RATE = 2.2

/** Collision discs. Earl is 1.5 wide and about 3.3 long with the forks. */
const DISC_R = 1.05
const DISC_FWD = 0.75
const DISC_BACK = -1.05
const BODY_HEIGHT = 2.4

/**
 * How long X is ignored after climbing in.
 *
 * Game fires the interaction check in the same frame it starts the ride, so the
 * very press that puts a child in the seat is still flagged `pressed` when this
 * module's first update runs. Without this you simply could not get in.
 */
const ENTER_GRACE = 0.35

/**
 * How long X is ignored after climbing OUT — and this one is not symmetry, it
 * is a bug fix.
 *
 * X is read TWICE in one frame by two different things: Game's _updateForklift
 * asks the ride whether the driver wants out, and Game's _updateInteraction
 * (which runs later in the same frame, off the same InputState) asks whether
 * anybody is standing next to Earl wanting to get in. `pressed` is a one-frame
 * edge, so both see the same press — and since exit() puts you down 2.1m away,
 * comfortably inside the 3.6m boarding range, the press that got you out
 * immediately put you back in. The symptom is "X does not get me out of the
 * forklift", and it is indistinguishable from the button being dead.
 */
const EXIT_COOLDOWN = 0.6

/** Where the driver sits, in Earl's local space. */
const SEAT = new THREE.Vector3(0, 1.28, 0.5)

/** How close you have to be to climb in. */
export const FORKLIFT_RANGE = 3.6

export class Forklift {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/Store.js').Store} store
   * @param {import('../core/Audio.js').Audio} audio
   * @param {THREE.Vector3|{x:number,z:number}} spot where he is parked
   */
  constructor(scene, store, audio, spot) {
    this.store = store
    this.audio = audio

    this.rig = makeForklift()
    this.group = this.rig.group
    scene.add(this.group)

    this.pos = new THREE.Vector3(spot.x, 0, spot.z)
    this.pos.y = store.groundHeight(this.pos.x, this.pos.z, 3)
    this.heading = 0
    this.speed = 0
    this.steer = 0
    this.lift = 0

    /** The Player currently driving, or null. */
    this.driver = null
    this._grace = 0
    this._exitFor = 0
    this._stuck = 0
    // Last frame's pose. Riders are carried by the DELTA rather than parented,
    // because parenting a Player would put its position in a space Player itself
    // knows nothing about, and every collision test downstream would be wrong.
    this._prevX = this.pos.x
    this._prevZ = this.pos.z
    this._prevH = this.heading
    this._beepTimer = 0
    this._hornCooldown = 0

    /** Reused so the platform query allocates nothing. */
    this._plat = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0 }
    this._worldSeat = new THREE.Vector3()
    this._carriageWorld = new THREE.Vector3()

    this._apply()
  }

  get busy() { return !!this.driver }

  /**
   * Can somebody climb in right now? False while he is occupied, and for a
   * moment after somebody got out — see EXIT_COOLDOWN. Game reads this so the
   * "Drive Big Earl!" prompt does not sit there advertising a button that is
   * deliberately ignoring you.
   */
  get canEnter() { return !this.driver && this._exitFor <= 0 }

  /** True while `player` is the one driving. */
  isDriver(player) { return !!player && this.driver === player }

  // -------------------------------------------------------------------------
  // Boarding
  // -------------------------------------------------------------------------

  /** @returns {boolean} true if they got in. */
  enter(player) {
    if (!player || !this.canEnter) return false
    this.driver = player
    this._grace = ENTER_GRACE
    player.externalControl = true
    player.group.visible = false // he is inside the cab; the overhead guard hides him
    this.audio.beep(2)
    return true
  }

  /**
   * Put the driver back on solid ground beside Earl.
   *
   * Tries both sides, then the front, then gives up and drops them exactly where
   * Earl is standing — which is inside him, but he is not solid to players and
   * "you are somewhere silly" beats "you are inside a wall forever".
   */
  exit() {
    const player = this.driver
    if (!player) return false
    this.driver = null
    this._exitFor = EXIT_COOLDOWN

    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading))
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    const tries = [
      right.clone().multiplyScalar(2.1),
      right.clone().multiplyScalar(-2.1),
      fwd.clone().multiplyScalar(2.6),
      fwd.clone().multiplyScalar(-3.2),
    ]
    let placed = null
    for (const off of tries) {
      const x = this.pos.x + off.x
      const z = this.pos.z + off.z
      const probe = new THREE.Vector3(x, this.store.groundHeight(x, z, this.pos.y + 2.5), z)
      const before = probe.clone()
      this.store.resolve(probe, 0.42, 1.75)
      if (probe.distanceToSquared(before) < 0.04) { placed = probe; break }
    }
    const out = placed || new THREE.Vector3(this.pos.x, this.pos.y, this.pos.z)

    player.group.visible = true
    player.externalControl = false
    player.teleport(out.x, out.z, this.heading + Math.PI / 2)
    this.audio.beep(1)
    return true
  }

  // -------------------------------------------------------------------------
  // The moving platform
  // -------------------------------------------------------------------------

  /**
   * The deck on the forks, as a world-space AABB with a top surface.
   *
   * Read from the carriage's real world matrix rather than recomputed from
   * `lift`, so the box a player stands on can never drift away from the deck
   * they can see. Axis-aligned regardless of Earl's heading: a rotated platform
   * would need a rotated ground test everywhere in Player, and at these sizes
   * the box is within a few centimetres of the deck at any angle.
   */
  platform() {
    this.rig.carriage.getWorldPosition(this._carriageWorld)
    const c = this._carriageWorld
    const p = this._plat
    // The deck is 1.2 x 1.0, sitting a little behind the carriage backplate.
    const back = 0.5
    const bx = Math.sin(this.heading) * -back
    const bz = Math.cos(this.heading) * -back
    const half = 0.72
    p.minX = c.x + bx - half
    p.maxX = c.x + bx + half
    p.minZ = c.z + bz - half
    p.maxZ = c.z + bz + half
    p.top = c.y + 0.1
    return p
  }

  /**
   * Ground height contributed by the forks at (x, z), or 0 for "nothing here".
   * Shaped to match Store.groundHeight so Player can just take the max.
   */
  groundHeight(x, z, maxY = Infinity) {
    const p = this.platform()
    if (x < p.minX - 0.3 || x > p.maxX + 0.3) return 0
    if (z < p.minZ - 0.3 || z > p.maxZ + 0.3) return 0
    if (p.top > maxY + 0.35) return 0
    return p.top
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {object|null} input the driver's InputState, or null when parked
   * @returns {boolean} true if the driver asked to get out
   */
  update(dt, input) {
    this._prevX = this.pos.x
    this._prevZ = this.pos.z
    this._prevH = this.heading
    if (this._grace > 0) this._grace -= dt
    if (this._exitFor > 0) this._exitFor -= dt
    if (this._hornCooldown > 0) this._hornCooldown -= dt

    let wantsOut = false
    if (this.driver && input) {
      wantsOut = this._drive(dt, input)
    } else {
      // Parked: coast to a stop rather than freezing mid-roll.
      this.speed = damp(this.speed, 0, 4, dt)
      if (Math.abs(this.speed) > 0.02) this._move(dt)
    }

    this.rig.update(dt, {
      speed: this.speed, steer: this.steer, lift: this.lift, driven: !!this.driver,
    })
    this._apply()
    return wantsOut
  }

  _drive(dt, input) {
    // --- throttle -----------------------------------------------------------
    const my = input.moveY || 0
    const mx = input.moveX || 0
    const target = my >= 0 ? my * FWD : my * REV

    let lambda
    if (Math.abs(target) < 0.05) lambda = 3.2                                   // engine braking
    else if (this.speed !== 0 && Math.sign(target) !== Math.sign(this.speed)) lambda = 7.0 // braking
    else lambda = ACCEL
    this.speed = damp(this.speed, target, lambda, dt)
    if (Math.abs(this.speed) < 0.04 && Math.abs(target) < 0.05) this.speed = 0
    this.speed = clamp(this.speed, -REV * 1.05, FWD * 1.05)

    // --- steering -----------------------------------------------------------
    this.steer = damp(this.steer, clamp(mx, -1, 1), 9, dt)
    const sp01 = clamp(Math.abs(this.speed) / FWD, 0, 1)
    const rate = lerp(TURN_LO, TURN_HI, sp01)
    // A little authority even at a dead stop, so a child can pivot to face home.
    const authority = Math.abs(this.speed) > 0.3 ? 1 : 0.7
    this.heading += this.steer * rate * authority * dt

    this._move(dt)

    // --- the forks ----------------------------------------------------------
    // A (jump) raises, Y (dance) lowers. Both are held, not tapped, because a
    // held button is the only control a pre-reader reliably discovers.
    let liftInput = 0
    if (input.jump && input.jump.down) liftInput += 1
    if (input.dance && input.dance.down) liftInput -= 1
    // The triggers do the same thing for anybody who found them.
    liftInput += (input.triggerR || 0) - (input.triggerL || 0)
    if (liftInput !== 0) {
      this.lift = clamp(this.lift + clamp(liftInput, -1, 1) * LIFT_RATE * dt, 0, FORK_LIFT_RANGE)
    }

    // --- the horn -----------------------------------------------------------
    if (input.fly && input.fly.pressed && this._hornCooldown <= 0) {
      this._hornCooldown = 0.5
      this.audio.pluck(43, { voice: 'horn', gain: 1.0 })
    }

    // --- reversing beeps ----------------------------------------------------
    if (this.speed < -0.6) {
      this._beepTimer -= dt
      if (this._beepTimer <= 0) { this._beepTimer = 0.75; this.audio.beep(1) }
    } else {
      this._beepTimer = 0
    }

    // --- getting out --------------------------------------------------------
    return !!(this._grace <= 0 && input.strum && input.strum.pressed)
  }

  /** Integrate along the heading and push out of the store. */
  _move(dt) {
    const fx = Math.sin(this.heading)
    const fz = Math.cos(this.heading)
    const prevX = this.pos.x
    const prevZ = this.pos.z

    this.pos.x += fx * this.speed * dt
    this.pos.z += fz * this.speed * dt

    // Two discs, front and back, so a long vehicle cannot corner through a rack.
    for (const d of [DISC_FWD, DISC_BACK]) {
      const probe = new THREE.Vector3(
        this.pos.x + fx * d, this.pos.y, this.pos.z + fz * d,
      )
      const before = probe.clone()
      this.store.resolve(probe, DISC_R, BODY_HEIGHT)
      this.pos.x += probe.x - before.x
      this.pos.z += probe.z - before.z
    }

    this.pos.y = this.store.groundHeight(this.pos.x, this.pos.z, this.pos.y + 1.2)

    // --- anti-wedge ---------------------------------------------------------
    // Nose-against-a-wall is not stuck: you can still reverse out of it, and
    // spinning a child round would be far worse than the wall. This only catches
    // a real wedge — no movement at all, in any direction, for seconds.
    const moved = Math.hypot(this.pos.x - prevX, this.pos.z - prevZ)
    if (Math.abs(this.speed) > 0.4 && moved < 0.012) this._stuck += dt
    else this._stuck = Math.max(0, this._stuck - dt * 3)
    if (this._stuck > 2.2) {
      this._stuck = 0
      const away = Math.sign(this.speed) || 1
      this.pos.x -= fx * 0.9 * away
      this.pos.z -= fz * 0.9 * away
      this.speed = 0
    }
  }

  _apply() {
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.heading
  }

  /**
   * Move anybody standing on the forks along with them.
   *
   * Without this, driving away from under a rider leaves them hanging in the air
   * for one frame and then dropped — which is precisely the co-op moment the
   * lift exists for, broken. Riders are swept by the frame's translation AND
   * rotated about Earl's centre by the frame's turn, so riding a forklift round
   * a corner works the way it looks like it should.
   *
   * @param {Array<{pos: THREE.Vector3, facing: number, store: object}>} riders
   */
  carry(riders) {
    const dx = this.pos.x - this._prevX
    const dz = this.pos.z - this._prevZ
    let dh = this.heading - this._prevH
    if (dh > Math.PI) dh -= Math.PI * 2
    else if (dh < -Math.PI) dh += Math.PI * 2
    if (dx === 0 && dz === 0 && dh === 0) return

    const p = this.platform()
    const cos = Math.cos(dh)
    const sin = Math.sin(dh)

    for (const r of riders) {
      if (!r || r === this.driver) continue
      // On the deck: inside the footprint, and standing within a step of its top.
      if (r.pos.x < p.minX - 0.3 || r.pos.x > p.maxX + 0.3) continue
      if (r.pos.z < p.minZ - 0.3 || r.pos.z > p.maxZ + 0.3) continue
      if (Math.abs(r.pos.y - p.top) > 0.45) continue

      // Rotate about Earl's centre using the PREVIOUS centre, which is where the
      // rider actually was standing when this frame's turn began.
      if (dh !== 0) {
        const rx = r.pos.x - this._prevX
        const rz = r.pos.z - this._prevZ
        r.pos.x = this._prevX + rx * cos + rz * sin
        r.pos.z = this._prevZ - rx * sin + rz * cos
        r.facing += dh
      }
      r.pos.x += dx
      r.pos.z += dz
      // Still not allowed inside a rack: being carried is not a licence to be
      // driven through the building.
      this.store.resolve(r.pos, 0.42, 1.75)
    }
  }

  /** World-space seat position, for placing the driver and the camera. */
  seatPos(out = this._worldSeat) {
    out.copy(SEAT)
    this.group.updateMatrixWorld()
    return out.applyMatrix4(this.group.matrixWorld)
  }

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  /** Pose, for the driver to broadcast. */
  getNetState() {
    return { fx: this.pos.x, fz: this.pos.z, fh: this.heading, fl: this.lift }
  }

  /**
   * Drive Earl from the wire. Only ever called on a client that is NOT driving
   * him, so it never fights the local simulation.
   */
  applyNetState(s) {
    if (!s) return
    this.pos.x = s.fx
    this.pos.z = s.fz
    this.pos.y = this.store.groundHeight(this.pos.x, this.pos.z, this.pos.y + 1.2)
    this.heading = s.fh
    this.lift = clamp(s.fl || 0, 0, FORK_LIFT_RANGE)
    this._apply()
  }
}
