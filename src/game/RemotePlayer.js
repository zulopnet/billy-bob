// game/RemotePlayer.js — somebody else's Billy Bob, drawn from the wire.
//
// Deliberately NOT a Player. A Player is movement, collision, a melt meter, a
// camera and a flying banjo; a remote one is none of those, because all of it
// already happened on the machine that owns it. Running that code here would be
// a second, disagreeing simulation — the classic way to make a networked
// character rubber-band.
//
// So this holds a rig, a position it is told, and the smallest amount of local
// animation needed to stop it looking dead: the walk cycle is driven from the
// interpolated velocity, which is the one thing a remote client can derive for
// itself without ever disagreeing with the owner.

import * as THREE from 'three'
import { makeBillyBob, makeFlyingBanjo, playerSkin } from '../chars/Rigs.js'

export class RemotePlayer {
  /**
   * @param {THREE.Scene} scene
   * @param {object} peer the NetClient peer this avatar belongs to
   */
  constructor(scene, peer) {
    this.scene = scene
    this.peer = peer
    /** NetClient reads this to decide whose state to broadcast. */
    this.isLocal = false

    this.skin = playerSkin(peer.char || peer.index || 0)
    this.name = peer.name || this.skin.name

    this.rig = makeBillyBob(this.skin.id)
    this.group = this.rig.group
    scene.add(this.group)

    this.pos = new THREE.Vector3()
    this.vel = new THREE.Vector3()
    this.facing = 0
    this.melt = 0
    this.anim = 'idle'

    /**
     * Their flying banjo, built lazily.
     *
     * Most peers never press B, and building one per player up front is a mesh,
     * a point light and a texture each for nothing. It appears the first frame
     * they are actually flying.
     */
    this.flight = null
  }

  /** Where a duel mote should fly to, and what a critter looks at. */
  get eye() {
    return this._eye
      ? this._eye.set(this.pos.x, this.pos.y + 1.45, this.pos.z)
      : (this._eye = new THREE.Vector3(this.pos.x, this.pos.y + 1.45, this.pos.z))
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z)
  }

  /** Called by NetClient every frame with the interpolated state. */
  applyNetState(s) {
    if (!s) return
    this.pos.set(s.p[0], s.p[1], s.p[2])
    this.vel.set(s.v[0], s.v[1], s.v[2])
    this.facing = s.r
    this.melt = s.melt || 0
    this.anim = s.s || 'idle'
    if (s.char && s.char !== this.skin.id) this._reskin(s.char)
  }

  /** They picked a different look — rebuild rather than tint, it is once. */
  _reskin(id) {
    const skin = playerSkin(id)
    if (skin.id === this.skin.id) return
    this.skin = skin
    this.scene.remove(this.group)
    this.rig = makeBillyBob(skin.id)
    this.group = this.rig.group
    this.scene.add(this.group)
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3|null} lookAt somewhere for them to glance at
   */
  update(dt, lookAt = null) {
    const driving = this.anim === 'drive'
    const flying = this.anim === 'fly'

    // A driver's body is inside Big Earl's cab; the forklift itself is drawn by
    // whichever side owns it, so the avatar just gets out of the way.
    this.group.visible = !driving

    this.group.position.copy(this.pos)
    this.group.rotation.y = this.facing

    this.rig.update(dt, {
      speed: this.speed,
      grounded: this.anim !== 'air',
      melt: this.melt,
      strumming: false,
      dance: flying,
    })

    if (flying) {
      if (!this.flight) {
        this.flight = makeFlyingBanjo()
        this.scene.add(this.flight.group)
      }
      // We are not told where their banjo is — it is not worth the bandwidth —
      // so it circles their head. It reads correctly at a glance ("they are
      // flying") without pretending to a precision the wire does not carry.
      this._orbit = (this._orbit || 0) + dt * 1.8
      this.flight.group.position.set(
        this.pos.x + Math.cos(this._orbit) * 2.2,
        this.pos.y + 3.1,
        this.pos.z + Math.sin(this._orbit) * 2.2,
      )
      this.flight.group.visible = true
      this.flight.update(dt, { speed: 4, turn: 0.4, climb: 0 })
    } else if (this.flight) {
      this.flight.group.visible = false
    }

    if (lookAt && this.rig.parts && this.rig.parts.eyes) {
      // Nothing fancy: the shared rig animator already does pupil tracking for
      // critters, and Billy Bob's eyes are static geometry. Left as a hook.
    }
  }

  dispose() {
    this.scene.remove(this.group)
    if (this.flight) {
      this.scene.remove(this.flight.group)
      this.flight.dispose?.()
    }
  }
}
