// game/Player.js — Billy Bob, the camera that follows him, and the melt meter.
//
// Everything in here is tuned for a five-year-old on a gamepad, which mostly
// means being generous:
//
//  * Coyote time and a jump buffer. A child presses A slightly after walking
//    off an edge and slightly before landing, essentially always. Without both
//    of these the game feels broken in a way they cannot articulate.
//  * The camera swings itself in behind you when you move. Expecting a small
//    person to drive two sticks at once is how you get a child spinning on the
//    spot looking at the ceiling.
//  * Melting is never a fail state. The banjo softens, then droops, then melts,
//    and melting just walks you to the freezer with a funny noise. Nothing is
//    ever lost. The meter exists to make the store feel like it has weather.
//
// There can now be several of these at once — two on one screen in split-screen,
// up to four in an online room — so a Player owns its own camera framing, its own
// melt meter and its own flying banjo, and nothing about it is a singleton. What
// is SHARED (the chip count, the band, the store itself) stays on Game.

import * as THREE from 'three'
import { damp, dampAngle, clamp, angleDelta } from '../core/MathUtils.js'
import { makeBillyBob, playerSkin } from '../chars/Rigs.js'
import { POINTS } from '../world/Store.js'
import { FlyingBanjo } from './FlyingBanjo.js'

const WALK_SPEED = 7.2
const RUN_BONUS = 2.6          // from a free sample
const ACCEL = 26
const AIR_ACCEL = 9
const TURN_RATE = 13
const GRAVITY = -24
const JUMP_SPEED = 8.4
const COYOTE = 0.16            // s of grace after leaving the ground
const JUMP_BUFFER = 0.18       // s a too-early press is remembered for
const RADIUS = 0.42
const HEIGHT = 1.75

// Camera.
const CAM_DIST = 8.2
const CAM_HEIGHT = 3.4
const YAW_RATE = 2.7           // rad/s at full stick
const PITCH_RATE = 1.7
const PITCH_MIN = -0.35
const PITCH_MAX = 0.95
const AUTO_FOLLOW = 1.6        // how hard the camera swings in behind you

// Melting. MELT_RATE is per second at heat = 1, so the rotisserie takes about
// twelve seconds to ruin the banjo — long enough to walk in, do something, and
// walk out, which is exactly the window the pug duel needs.
const MELT_RATE = 0.085
const COOL_RATE = 0.42

export class Player {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/Store.js').Store} store
   * @param {import('../core/Audio.js').Audio} audio
   * @param {object} [opts]
   * @param {number} [opts.slot] which local input slot drives this one, or -1
   * @param {number|string} [opts.skin] index or id into PLAYER_SKINS
   * @param {string} [opts.name] display name, for the HUD and the duel
   */
  constructor(scene, store, audio, opts = {}) {
    this.store = store
    this.audio = audio

    /** Local input slot, or -1 for a player driven from somewhere else. */
    this.slot = opts.slot === undefined ? 0 : opts.slot
    /** False only on a RemotePlayer. NetClient keys off this. */
    this.isLocal = true
    this.skin = playerSkin(opts.skin === undefined ? this.slot : opts.skin)
    this.name = opts.name || this.skin.name

    this.rig = makeBillyBob(this.skin.id)
    this.group = this.rig.group
    scene.add(this.group)

    /**
     * Extra sources of solid ground, checked alongside the store's own.
     *
     * Game puts the forklift in here. It is what makes standing on the forks
     * while somebody else drives actually work, and it is a list rather than a
     * single slot because the next moving thing should not need a rewrite.
     * @type {Array<{groundHeight:(x:number,z:number,maxY:number)=>number}>}
     */
    this.groundProviders = []

    /**
     * Set while something else owns this body — driving Big Earl, mostly. The
     * rig still animates and the melt meter still runs; movement and the camera
     * belong to whatever set the flag.
     */
    this.externalControl = false

    /** This player's own flying banjo. */
    this.flight = new FlyingBanjo(scene, store, audio)

    /**
     * Big Earl's pose, when this player is the one driving him.
     *
     * Set by Game, read by getNetState. It rides in the DRIVER's 20 Hz packet
     * rather than the host's 5 Hz world snapshot because a forklift moving at
     * 5 Hz under a driver whose own head glides at 20 Hz looks broken — and
     * because the driver is the only client that actually knows where Earl is.
     * @type {{fork:number,fx:number,fz:number,fh:number,fl:number}|null}
     */
    this.forkNet = null

    this.pos = POINTS.spawn.clone()
    this.vel = new THREE.Vector3()
    this.facing = Math.PI // start looking back into the store
    this.grounded = true
    this.groundY = 0

    this._coyote = 0
    this._buffer = 0
    this._stepTimer = 0
    this._wasGrounded = true

    // Camera orbit.
    this.camYaw = Math.PI
    this.camPitch = 0.22
    this.camPos = new THREE.Vector3()
    this._camTarget = new THREE.Vector3()
    /** Set while a duel is framed side-on; null the rest of the time. */
    this.duelTarget = null

    // Melt.
    this.melt = 0
    this._sizzleTimer = 0
    this.meltedCount = 0

    /** Seconds of free-sample speed boost remaining. */
    this.boost = 0

    /** Set by Game while a duel is running: movement is frozen, rig still plays. */
    this.locked = false

    /** Scratch, reused every frame. */
    this._fwd = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._move = new THREE.Vector3()

    this.group.position.copy(this.pos)
  }

  /** World-space point the camera looks at and critters look toward. */
  get eye() {
    return this._camTarget.set(this.pos.x, this.pos.y + 1.45, this.pos.z)
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z)
  }

  /** Drop the banjo's temperature straight back to solid. */
  refreeze() {
    if (this.melt > 0.02) this.audio.refreeze()
    this.melt = 0
  }

  /** Walked into an ice pop. */
  chill(amount = 0.5) {
    this.melt = Math.max(0, this.melt - amount)
    this.audio.refreeze()
  }

  /** Ate a free sample. */
  pep(seconds = 8) {
    this.boost = Math.max(this.boost, seconds)
    this.audio.sample()
  }

  /**
   * Kick the strum animation.
   *
   * A one-frame flag rather than a direct `rig.update(0, {strumming:true})`
   * call: the rig must be advanced exactly ONCE per frame or its walk cycle and
   * idle phases run at double speed. Game used to poke the rig itself on top of
   * Player's own update, which is precisely that bug.
   */
  strum() {
    this._strumPulse = true
  }

  /**
   * Solid ground under (x, z), counting the store AND anything moving.
   *
   * `maxY` is the ceiling on what counts as floor — a shelf above your head is
   * not something you are standing on — and it is passed through unchanged, so
   * a fork carriage 5m up only becomes ground once you are level with it.
   */
  groundAt(x, z, maxY = Infinity) {
    let best = this.store.groundHeight(x, z, maxY)
    for (const g of this.groundProviders) {
      const h = g.groundHeight(x, z, maxY)
      if (h > best) best = h
    }
    return best
  }

  /** Put him somewhere, kill his momentum, and point the camera sensibly. */
  teleport(x, z, facing = Math.PI) {
    this.pos.set(x, this.groundAt(x, z, 3), z)
    this.vel.set(0, 0, 0)
    this.facing = facing
    this.camYaw = facing + Math.PI
    this.group.position.copy(this.pos)
  }

  /**
   * @param {number} dt
   * @param {object} input the InputState for slot 0
   * @param {THREE.Camera} camera
   */
  update(dt, input, camera) {
    if (this.locked) {
      this._updateLocked(dt, camera)
      return
    }
    if (this.externalControl) {
      // Somebody else — Big Earl — owns the body and the camera this frame. The
      // melt meter keeps running, because a chocolate banjo does not stop being
      // chocolate just because you got in a forklift.
      this._updateRidden(dt, input)
      return
    }
    if (this.flight.active) {
      this._updateFlying(dt, input, camera)
      return
    }

    // --- camera orbit -------------------------------------------------------
    this.camYaw -= (input.lookX || 0) * YAW_RATE * dt
    this.camPitch = clamp(
      this.camPitch + (input.lookY || 0) * PITCH_RATE * dt, PITCH_MIN, PITCH_MAX,
    )

    // --- desired movement, in camera space ----------------------------------
    const mx = input.moveX || 0
    const my = input.moveY || 0
    const mag = Math.min(1, Math.hypot(mx, my))

    this._fwd.set(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw))
    this._right.set(this._fwd.z, 0, -this._fwd.x)
    this._move
      .copy(this._fwd).multiplyScalar(my)
      .addScaledVector(this._right, mx)
    if (this._move.lengthSq() > 1e-6) this._move.normalize()

    const maxSpeed = WALK_SPEED + (this.boost > 0 ? RUN_BONUS : 0)
    const targetVX = this._move.x * maxSpeed * mag
    const targetVZ = this._move.z * maxSpeed * mag
    const accel = (this.grounded ? ACCEL : AIR_ACCEL) * dt
    this.vel.x = moveToward(this.vel.x, targetVX, accel)
    this.vel.z = moveToward(this.vel.z, targetVZ, accel)

    // Face the direction of travel.
    if (mag > 0.12) {
      this.facing = dampAngle(this.facing, Math.atan2(this._move.x, this._move.z), TURN_RATE, dt)

      // Auto-follow: the camera drifts in behind him, but only while the player
      // is NOT touching the right stick, so it never fights a deliberate look.
      if (Math.abs(input.lookX || 0) < 0.05) {
        const behind = this.facing + Math.PI
        this.camYaw += angleDelta(this.camYaw, behind) * Math.min(1, AUTO_FOLLOW * dt * mag)
      }
    }

    // --- jumping ------------------------------------------------------------
    this._coyote = this.grounded ? COYOTE : Math.max(0, this._coyote - dt)
    this._buffer = input.jump && input.jump.pressed ? JUMP_BUFFER : Math.max(0, this._buffer - dt)

    if (this._buffer > 0 && this._coyote > 0) {
      this.vel.y = JUMP_SPEED
      this.grounded = false
      this._coyote = 0
      this._buffer = 0
      this.audio.jump()
    }

    // Variable jump height: letting go of A early cuts the rise short. This is
    // the difference between a hop and a leap, and children find it instantly.
    if (this.vel.y > 0 && input.jump && !input.jump.down) {
      this.vel.y += GRAVITY * 1.8 * dt
    }

    this.vel.y += GRAVITY * dt
    if (this.vel.y < -34) this.vel.y = -34

    // --- integrate + collide ------------------------------------------------
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    this.store.resolve(this.pos, RADIUS, HEIGHT)

    this.pos.y += this.vel.y * dt
    // Ground is sampled at the feet, so a platform above the head is not a floor.
    const ground = this.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.4)
    if (this.pos.y <= ground) {
      this.pos.y = ground
      if (this.vel.y < -2.5 && !this._wasGrounded) this.audio.land()
      this.vel.y = 0
      this.grounded = true
    } else {
      this.grounded = false
    }
    this._wasGrounded = this.grounded

    // Footsteps, timed off distance travelled rather than a fixed interval, so
    // they stay in sync at every speed.
    if (this.grounded && this.speed > 0.6) {
      this._stepTimer -= this.speed * dt
      if (this._stepTimer <= 0) {
        this._stepTimer = 1.55
        this.audio.step(this.speed > WALK_SPEED * 0.8)
      }
    }

    if (this.boost > 0) this.boost -= dt

    this._updateMelt(dt)
    this._applyTransform(dt, input, camera)
  }

  /**
   * Riding: the vehicle sets `pos` and `facing`, we just animate and melt.
   *
   * The camera is deliberately NOT placed here — Game hands the ride its own
   * chase framing, and having two things write camera.position in one frame is
   * how you get a camera that vibrates.
   */
  _updateRidden(dt, input) {
    this.vel.set(0, 0, 0)
    this.flight.stow()
    this._updateMelt(dt)
    const strumming = this._strumPulse
    this._strumPulse = false
    this.rig.update(dt, { speed: 0, grounded: true, melt: this.melt, strumming })
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.facing
  }

  /**
   * Flying-banjo mode: the body stands still and the camera goes with the banjo.
   *
   * The body is deliberately left standing rather than hidden. In co-op the other
   * player needs to see where you actually are — and it is also the thing that
   * makes the leash legible: you can see what you are tethered to.
   */
  _updateFlying(dt, input, camera) {
    // Camera orbit still works while flying, so you can look around the shelf
    // you are hovering next to.
    this.camYaw -= (input.lookX || 0) * YAW_RATE * dt
    this.camPitch = clamp(
      this.camPitch + (input.lookY || 0) * PITCH_RATE * dt, PITCH_MIN, PITCH_MAX,
    )

    // The body keeps falling: launching from mid-air must not leave it hanging.
    this.vel.x = 0
    this.vel.z = 0
    this.vel.y += GRAVITY * dt
    this.pos.y += this.vel.y * dt
    const ground = this.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.4)
    if (this.pos.y <= ground) { this.pos.y = ground; this.vel.y = 0; this.grounded = true }

    this.flight.update(dt, input, this.pos, this.camYaw)
    this._updateMelt(dt)

    this.group.position.copy(this.pos)
    this.group.rotation.y = this.facing
    this._strumPulse = false
    // `dance: true` is not a cheat — the body really is dancing on the spot
    // while the banjo is away, which is the read we want from across the store.
    this.rig.update(dt, {
      speed: 0, grounded: this.grounded, melt: this.melt, strumming: false, dance: true,
    })

    if (camera) this._placeFlightCamera(dt, camera)
  }

  /** Chase the flying banjo. Closer and lower than the walking camera. */
  _placeFlightCamera(dt, camera) {
    const t = this.flight.pos
    const cp = Math.cos(this.camPitch)
    const dist = 5.4
    const wantX = t.x + Math.sin(this.camYaw) * cp * dist
    const wantY = t.y + Math.sin(this.camPitch) * dist + 1.5
    const wantZ = t.z + Math.cos(this.camYaw) * cp * dist
    camera.position.set(
      damp(camera.position.x, wantX, 8, dt),
      damp(camera.position.y, wantY, 8, dt),
      damp(camera.position.z, wantZ, 8, dt),
    )
    camera.lookAt(t.x, t.y, t.z)
  }

  /** Duel mode: he stands still and plays, and the camera holds its framing. */
  _updateLocked(dt, camera) {
    this.vel.set(0, 0, 0)
    this.flight.stow()
    this._updateMelt(dt)
    const strumming = this._strumPulse
    this._strumPulse = false
    this.rig.update(dt, { speed: 0, grounded: true, melt: this.melt, strumming })
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.facing
    if (camera) this._placeCamera(dt, camera)
  }

  _updateMelt(dt) {
    const heat = this.store.heatAt(this.pos.x, this.pos.z)
    if (heat > 0) {
      this.melt += heat * MELT_RATE * dt
      // A warning hiss that gets more frequent the closer to ruin it gets.
      this._sizzleTimer -= dt * (0.4 + this.melt * 2.2) * heat
      if (this._sizzleTimer <= 0 && this.melt > 0.3) {
        this._sizzleTimer = 1
        this.audio.sizzle()
      }
    } else if (heat < 0) {
      this.melt += heat * COOL_RATE * dt // heat is negative here
    }

    if (this.melt >= 1) {
      // Melted. Not a death — a short, funny trip to the freezer.
      this.melt = 0
      this.meltedCount++
      this.audio.melt()
      // The banjo goes with you. Leaving it flying while its owner is warped to
      // the freezer strands the camera on the far side of the building.
      this.flight.stow()
      this.teleport(-38, 0, Math.PI)
      window.setTimeout(() => this.audio.refreeze(), 700)
      if (this.onMelted) this.onMelted()
    }
    this.melt = clamp(this.melt, 0, 1)
  }

  _applyTransform(dt, input, camera) {
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.facing

    const strumming = this._strumPulse
    this._strumPulse = false
    this.rig.update(dt, {
      speed: this.speed,
      grounded: this.grounded,
      melt: this.melt,
      strumming,
      dance: !!(input.dance && input.dance.down),
    })

    if (camera) this._placeCamera(dt, camera)
  }

  /**
   * Place the follow camera, then pull it in if the store is in the way.
   *
   * The pull-in is a coarse ray march rather than a real raycast: the store is
   * a few hundred boxes and `Colliders.query` is already the cheapest way to
   * ask "is this point inside something". Sampling eight points along the boom
   * finds every wall that matters, and the failure mode (a corner clipping for
   * one frame) is invisible next to the cost of a proper raycast every frame.
   */
  _placeCamera(dt, camera) {
    if (this.duelTarget) {
      this._placeDuelCamera(dt, camera)
      return
    }
    const target = this.eye
    const cp = Math.cos(this.camPitch)
    const dirX = Math.sin(this.camYaw) * cp
    const dirZ = Math.cos(this.camYaw) * cp
    const dirY = Math.sin(this.camPitch)

    let dist = CAM_DIST
    const hits = []
    for (let i = 3; i <= 8; i++) {
      const f = (i / 8) * CAM_DIST
      const x = target.x + dirX * f
      const y = target.y + dirY * f + (CAM_HEIGHT - 1.45) * (f / CAM_DIST)
      const z = target.z + dirZ * f
      const boxes = this.store.colliders.query(x, z, 0.45, hits)
      let blocked = false
      for (const b of boxes) {
        if (x > b.minX - 0.45 && x < b.maxX + 0.45 &&
            z > b.minZ - 0.45 && z < b.maxZ + 0.45 &&
            y > b.minY && y < b.maxY) { blocked = true; break }
      }
      if (blocked) { dist = Math.max(2.6, f - 0.8); break }
    }

    const wantX = target.x + dirX * dist
    const wantY = target.y + dirY * dist + (CAM_HEIGHT - 1.45) * (dist / CAM_DIST)
    const wantZ = target.z + dirZ * dist

    // Damped, but faster on the way IN than on the way out — a camera that
    // lazily eases into a wall clips through it; one that lazily eases back out
    // just looks smooth.
    const closing = camera.position.distanceTo(target) > dist + 0.2
    const lambda = closing ? 16 : 7
    camera.position.set(
      damp(camera.position.x, wantX, lambda, dt),
      damp(camera.position.y, wantY, lambda, dt),
      damp(camera.position.z, wantZ, lambda, dt),
    )
    camera.lookAt(target.x, target.y + 0.2, target.z)
  }

  /**
   * Frame a duel.
   *
   * NOT over the shoulder. An over-the-shoulder camera points straight at the
   * critter with Billy Bob's head in the way, and the critter — whose animation
   * is half the feedback in the duel — is completely hidden behind him.
   *
   * Instead the camera swings out PERPENDICULAR to the line between the two of
   * them, so you see both in profile, facing each other, like a stand-off. It
   * also makes the note motes fly across the frame rather than into it.
   *
   * @param {THREE.Vector3} critterPos
   */
  faceDuel(critterPos) {
    const dx = critterPos.x - this.pos.x
    const dz = critterPos.z - this.pos.z
    this.facing = Math.atan2(dx, dz)
    this.duelTarget = critterPos.clone()
    this.camPitch = 0.14
  }

  /** Leave duel framing and hand the camera back to the player. */
  endDuel() {
    this.duelTarget = null
    this.camYaw = this.facing + Math.PI
  }

  /**
   * The B button: send the banjo up, or call it back.
   * @returns {'launched'|'recalled'|'empty'} what actually happened, for the HUD
   */
  toggleFlight() {
    if (this.flight.active) {
      this.flight.recall()
      return 'recalled'
    }
    return this.flight.launch(this.eye, this.facing) ? 'launched' : 'empty'
  }

  /**
   * One word for what this body is doing, for a remote client to animate from.
   * Deliberately coarse: the exact walk-cycle phase is not worth a byte, and a
   * remote avatar that guesses its own phase looks better than one that hitches
   * every time a packet is late.
   */
  get animState() {
    if (this.externalControl) return 'drive'
    if (this.flight.active) return 'fly'
    if (!this.grounded) return 'air'
    return this.speed > 0.25 ? 'walk' : 'idle'
  }

  /**
   * Everything this player puts on the wire.
   *
   * `fork` is this client's id while they are driving Big Earl and -1 otherwise
   * — that is how the receiving end knows whose forklift pose to believe.
   */
  getNetState() {
    const s = {
      p: [this.pos.x, this.pos.y, this.pos.z],
      r: this.facing,
      v: [this.vel.x, this.vel.y, this.vel.z],
      s: this.animState,
      char: this.skin.id,
      melt: this.melt,
      fork: -1,
      fx: 0, fz: 0, fh: 0, fl: 0,
    }
    if (this.forkNet) Object.assign(s, this.forkNet)
    return s
  }

  /**
   * How far a ray from (x,y,z) along (dx,dz) travels before it is inside a
   * solid. Coarse — 0.5m steps — which is all the camera needs.
   */
  _clearance(x, y, z, dx, dz, max) {
    const hits = []
    for (let d = 1; d <= max; d += 0.5) {
      const px = x + dx * d
      const pz = z + dz * d
      if (px < -59 || px > 59 || pz < -44 || pz > 44) return d - 0.5
      const boxes = this.store.colliders.query(px, pz, 0.5, hits)
      for (const b of boxes) {
        if (px > b.minX - 0.5 && px < b.maxX + 0.5 &&
            pz > b.minZ - 0.5 && pz < b.maxZ + 0.5 &&
            y > b.minY && y < b.maxY) return d - 0.5
      }
    }
    return max
  }

  /**
   * Side-on two-shot, placed wherever there is actually room.
   *
   * The first version of this always swung toward the middle of the building on
   * the theory that the middle is open. In an AISLE that is exactly wrong — the
   * open direction is along the aisle and the "middle" is a rack of beans — and
   * every duel with the raccoon framed the inside of a shelf.
   *
   * So: measure the clearance both ways with the collision grid, take the
   * roomier one, and if neither has room (a narrow aisle, both sides racked)
   * give up on side-on and go high and behind instead, looking down over Billy
   * Bob's hat. That one always works because the ceiling is 11m up and empty.
   */
  _placeDuelCamera(dt, camera) {
    const t = this.duelTarget
    const midX = (this.pos.x + t.x) / 2
    const midZ = (this.pos.z + t.z) / 2
    const midY = (this.pos.y + t.y) / 2 + 1.2

    let dirX = t.x - this.pos.x
    let dirZ = t.z - this.pos.z
    const sep = Math.max(1.5, Math.hypot(dirX, dirZ))
    dirX /= sep
    dirZ /= sep

    const perpX = dirZ
    const perpZ = -dirX
    const want = 4.2 + sep * 0.55

    const a = this._clearance(midX, midY, midZ, perpX, perpZ, want)
    const b = this._clearance(midX, midY, midZ, -perpX, -perpZ, want)

    let wantX
    let wantY
    let wantZ
    const best = Math.max(a, b)
    if (best >= 2.0) {
      // Room to stand off to the side. 2.0m is tight but at a 62° FOV it still
      // frames both of them, and an aisle only gives 2.3m.
      const s = a >= b ? 1 : -1
      const dist = Math.min(want, best - 0.3)
      wantX = midX + perpX * s * dist
      wantZ = midZ + perpZ * s * dist
      wantY = midY + 1.6
    } else {
      // Nowhere to the side at all. Back off ALONG the line instead, past the
      // player, and lift just enough to see over his hat.
      //
      // Deliberately not "straight up": the racking is 8m tall and loaded to
      // 6.3m, so a camera raised into an aisle ends up level with a shelf of
      // cardboard. Backing off down the corridor is the only direction in an
      // aisle that is reliably empty.
      wantX = this.pos.x - dirX * 6.0
      wantZ = this.pos.z - dirZ * 6.0
      wantY = Math.max(this.pos.y, t.y) + 2.6
    }

    camera.position.set(
      damp(camera.position.x, wantX, 4.5, dt),
      damp(camera.position.y, wantY, 4.5, dt),
      damp(camera.position.z, wantZ, 4.5, dt),
    )
    camera.lookAt(midX, midY - 0.3, midZ)
  }
}

/** Move a scalar toward a target by at most `maxDelta`. */
function moveToward(v, target, maxDelta) {
  const d = target - v
  return Math.abs(d) <= maxDelta ? target : v + Math.sign(d) * maxDelta
}
