// world/Batch.js — collapse hundreds of static props into a handful of draws.
//
// The store is built out of small primitives: a shrub is a pot, a trunk and
// three leaf spheres, and there are thirty shrubs. Built naively that is 150
// meshes and 150 draw calls for one corner of one department, and the first
// version of this store shipped 807 draw calls in total.
//
// None of that geometry ever moves. So instead of instancing it (which still
// costs a draw per geometry+material pair, and needs the pieces to be
// identical), every static prop is baked into world space and merged into ONE
// mesh per material. Thirty shrubs become three draws — pots, trunks, leaves —
// no matter how many different sphere sizes are involved.
//
// The trade is memory: merged geometry duplicates vertices instead of reusing
// one buffer. For primitives this small that is a rounding error, and it buys
// back the thing that actually costs frames on a phone.
//
// Anything that MOVES must not go through here. Use a plain Mesh (or an
// InstancedMesh, for the pickups) for those.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export class Batch {
  /** @param {THREE.Object3D} root where the merged meshes are added */
  constructor(root) {
    this.root = root
    /** @type {Map<THREE.Material, {mat: THREE.Material, geos: THREE.BufferGeometry[]}>} */
    this._buckets = new Map()
    this.meshes = []
  }

  /**
   * Bake one prop into the batch.
   *
   * @param {THREE.BufferGeometry} geo shared source geometry — NOT consumed
   * @param {THREE.Material} mat the bucket key; reuse material objects or you
   *                             get one draw call per prop and no saving at all
   * @param {number[]} pos [x,y,z]
   * @param {number[]} [scale] [x,y,z]
   * @param {number[]} [rot] [x,y,z] euler, radians
   */
  add(geo, mat, pos, scale, rot) {
    const g = geo.clone()
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    if (rot) q.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]))
    m.compose(
      new THREE.Vector3(pos[0], pos[1], pos[2]),
      q,
      new THREE.Vector3(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1),
    )
    g.applyMatrix4(m)

    let b = this._buckets.get(mat)
    if (!b) this._buckets.set(mat, (b = { mat, geos: [] }))
    b.geos.push(g)
    return this
  }

  /**
   * Merge every bucket and add the results to the root.
   *
   * @param {object} [opts] `{ castShadow, receiveShadow }`
   * @returns {THREE.Mesh[]}
   */
  flush(opts = {}) {
    for (const { mat, geos } of this._buckets.values()) {
      if (!geos.length) continue
      // mergeGeometries returns null if the attribute sets don't line up — a
      // real possibility when mixing geometries from different constructors
      // (one with uv2, one without). Falling back to individual meshes keeps
      // the store correct rather than silently losing a department.
      let merged = null
      try {
        merged = mergeGeometries(geos, false)
      } catch (e) {
        merged = null
      }

      if (merged) {
        const mesh = new THREE.Mesh(merged, mat)
        mesh.castShadow = opts.castShadow ?? true
        mesh.receiveShadow = opts.receiveShadow ?? true
        this.root.add(mesh)
        this.meshes.push(mesh)
        for (const g of geos) g.dispose()
      } else {
        console.warn('[Batch] merge failed; falling back to individual meshes')
        for (const g of geos) {
          const mesh = new THREE.Mesh(g, mat)
          mesh.castShadow = opts.castShadow ?? true
          mesh.receiveShadow = opts.receiveShadow ?? true
          this.root.add(mesh)
          this.meshes.push(mesh)
        }
      }
    }
    this._buckets.clear()
    return this.meshes
  }
}

/**
 * A pool of identical animated objects sharing one draw call.
 *
 * Used for the pickups: ~100 chocolate chips that all bob and spin, and vanish
 * one at a time when collected. An InstancedMesh is the right shape for that —
 * they are genuinely identical, they genuinely all move, and "collected" is
 * just a matrix parked below the floor.
 */
export class InstancePool {
  /**
   * @param {THREE.Object3D} root
   * @param {THREE.BufferGeometry} geo
   * @param {THREE.Material} mat
   * @param {number} capacity
   */
  constructor(root, geo, mat, capacity) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity)
    this.mesh.frustumCulled = false // the pool spans the whole building
    this.mesh.castShadow = true
    this.mesh.count = 0
    root.add(this.mesh)
    this.capacity = capacity
    this._m4 = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler()
    this._v = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._n = 0
  }

  /** Claim a slot. @returns {number} the instance index */
  claim() {
    if (this._n >= this.capacity) return -1
    const i = this._n++
    this.mesh.count = this._n
    return i
  }

  /** Position/orient one instance. */
  set(i, x, y, z, rotY = 0, scale = 1) {
    if (i < 0) return
    this._e.set(0, rotY, 0)
    this._q.setFromEuler(this._e)
    this._v.set(x, y, z)
    this._s.setScalar(scale)
    this._m4.compose(this._v, this._q, this._s)
    this.mesh.setMatrixAt(i, this._m4)
  }

  /** Park an instance out of sight. Cheaper and safer than a zero scale. */
  hide(i) {
    if (i < 0) return
    this._m4.makeTranslation(0, -500, 0)
    this.mesh.setMatrixAt(i, this._m4)
  }

  /** Call once per frame after all set()/hide() calls. */
  commit() {
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh)
  }
}
