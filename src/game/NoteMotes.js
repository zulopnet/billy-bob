// game/NoteMotes.js — the little coloured lights that fly between two players.
//
// Pulled out of Duel.js when the player-versus-player duel wanted exactly the
// same effect. Both duels own one of these and neither knows where anybody is
// standing: the endpoints are handed in every frame by Game.

import * as THREE from 'three'
import { STRING_COLORS_HEX } from '../core/Audio.js'

export class NoteMotes {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.group = new THREE.Group()
    scene.add(this.group)
    this.list = []
    this._from = null
    this._to = null
    // One sphere shared by every mote. Each needs its own material (the colour
    // and the fade differ) but the geometry never does, and a duel can spawn
    // thirty of these.
    this._geo = new THREE.SphereGeometry(0.16, 8, 6)
  }

  /**
   * @param {THREE.Vector3} from the 'call' end
   * @param {THREE.Vector3} to the 'response' end
   */
  setEndpoints(from, to) {
    this._from = from
    this._to = to
  }

  /**
   * @param {number} note 0..3
   * @param {'from'|'to'} who which end it launches from
   */
  spawn(note, who) {
    if (!this._from || !this._to) return
    const m = new THREE.Mesh(
      this._geo,
      new THREE.MeshBasicMaterial({
        color: STRING_COLORS_HEX[note] || 0xffffff, transparent: true, opacity: 0.95,
      }),
    )
    const a = who === 'from' ? this._from : this._to
    const b = who === 'from' ? this._to : this._from
    m.position.copy(a)
    m.position.y += 1.2
    this.group.add(m)
    this.list.push({
      mesh: m,
      from: m.position.clone(),
      to: b.clone().setY(b.y + 1.4),
      t: 0,
      life: 0.7,
    })
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]
      p.t += dt / p.life
      if (p.t >= 1) {
        this.group.remove(p.mesh)
        p.mesh.material.dispose()
        this.list.splice(i, 1)
        continue
      }
      // A lobbed arc, so the note visibly travels between the two of you rather
      // than sliding along the floor.
      p.mesh.position.lerpVectors(p.from, p.to, p.t)
      p.mesh.position.y += Math.sin(p.t * Math.PI) * 1.6
      p.mesh.scale.setScalar(1 + Math.sin(p.t * Math.PI) * 0.6)
      p.mesh.material.opacity = 0.95 * (1 - p.t * p.t)
    }
  }

  /** Tear down. Call when the duel ends, or the motes leak. */
  dispose() {
    for (const p of this.list) p.mesh.material.dispose()
    this.list.length = 0
    this._geo.dispose()
    if (this.group.parent) this.group.parent.remove(this.group)
  }
}
