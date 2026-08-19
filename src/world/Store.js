// world/Store.js — the Giga-Mart Wholesale Club.
//
// A fictional warehouse store: ~120m x 90m of sealed concrete under an 11m
// roof deck, six aisles of steel racking, and six departments around the edge.
// Everything is built from primitives and the canvas textures in Textures.js.
//
// Three things live here and nothing else should:
//   1. GEOMETRY   — the building, the racking, the departments, the props
//   2. COLLISION  — a uniform grid of AABBs, queried by Player
//   3. ZONES      — which department a point is in, and how HOT it is, which is
//                   the whole basis of the melt mechanic
//
// Layout, looking down (+X right, +Z toward the front doors):
//
//        -60                    0                    +60
//   -45   +--------------------------------------------+
//         | TVs  |   LOADING DOCK      |               |
//         |------|---------------------|    GARDEN     |
//         |      |                     |     CENTRE    |
//    0    |FREEZER   aisles 1..6       |               |
//         |      |                     |---------------|
//         |------|                     |  FOOD COURT   |
//         |BAKERY|                     |   (HOT)       |
//   +45   +---------- FRONT / STAGE --------------------+

import * as THREE from 'three'
import { rng, intFrom, rangeFrom } from '../core/Rng.js'
import { Batch } from './Batch.js'
import {
  concreteTexture, hazardTexture, steelTexture, beamTexture, cardboardTexture,
  productTexture, signTexture, bannerTexture, frostTexture, turfTexture,
  screenTexture, corrugatedTexture, tileTexture,
} from './Textures.js'

export const STORE = {
  minX: -60, maxX: 60,
  minZ: -45, maxZ: 45,
  ceiling: 11,
}

/**
 * Departments. `heat` drives the melt meter in Player:
 *   +1 = the banjo melts fast, -1 = it re-freezes, 0 = nothing happens.
 * Bounds are inclusive AABBs on the floor plane; the first match wins, so the
 * order of this array matters and the general sales floor is last.
 */
export const ZONES = [
  {
    id: 'freezer', name: 'Frosty Foods', heat: -1,
    minX: -60, maxX: -44, minZ: -22, maxZ: 20,
    color: 0x9fd8ec,
  },
  {
    id: 'bakery', name: 'The Bakery', heat: 0.55,
    minX: -60, maxX: -44, minZ: 22, maxZ: 45,
    color: 0xe8b04a,
  },
  {
    id: 'foodcourt', name: 'The Hot Rotisserie', heat: 1,
    minX: 30, maxX: 60, minZ: 14, maxZ: 45,
    color: 0xef7a3a,
  },
  {
    id: 'garden', name: 'Garden & Patio', heat: 0.15,
    minX: 30, maxX: 60, minZ: -45, maxZ: 12,
    color: 0x63a94f,
  },
  {
    id: 'dock', name: 'The Loading Dock', heat: 0,
    minX: -42, maxX: 28, minZ: -45, maxZ: -32,
    color: 0xd8b23a,
  },
  {
    id: 'tvs', name: 'The Television Wall', heat: 0,
    minX: -60, maxX: -44, minZ: -45, maxZ: -24,
    color: 0x7a86e8,
  },
  {
    id: 'stage', name: 'The Free Sample Stage', heat: 0,
    minX: -16, maxX: 16, minZ: 30, maxZ: 45,
    color: 0xe8c33a,
  },
  {
    id: 'floor', name: 'The Aisles', heat: 0,
    minX: -60, maxX: 60, minZ: -45, maxZ: 45,
    color: 0xaaaaaa,
  },
]

/** Aisle signage. Read these out loud; that is most of the joke. */
const AISLES = [
  { n: 1, label: 'CEREAL & PANCAKE MIX' },
  { n: 2, label: 'NAPKINS & PAPER TOWELS' },
  { n: 3, label: 'SNACKS & CRACKERS' },
  { n: 4, label: 'ENORMOUS CANS OF BEANS' },
  { n: 5, label: 'SOAP & BUBBLES' },
  { n: 6, label: 'DOG BEDS & BIRD SEED' },
]

/** Aisle centre X positions. Six racking runs, 11m apart. */
const AISLE_X = [-38, -27, -16, -5, 6, 17]
const AISLE_MIN_Z = -30
const AISLE_MAX_Z = 26
/**
 * Distance from an aisle's centreline to the centre of the racking beside it.
 * The rack collider is 1.3m either side of that, so the walkable aisle is
 * 2*(AISLE_HALF_WIDTH - 1.3) = 4.6m across.
 */
const AISLE_HALF_WIDTH = 3.6

/**
 * Named world positions other modules need.
 *
 * `spawn` must be in the OPEN strip between the end of the racking (z=26) and
 * the checkouts (z=30.3): the aisles are only walkable along the centre lines
 * in AISLE_X, and an x that sits between two of them is inside a rack.
 */
export const POINTS = {
  spawn: new THREE.Vector3(-5, 0, 28.5),
  stage: new THREE.Vector3(0, 1.2, 38),
  fort: new THREE.Vector3(-32.5, 0, 22),
}

// ===========================================================================
// Collision
// ===========================================================================

/**
 * A uniform grid of axis-aligned boxes.
 *
 * There are ~600 solids in the finished store and the player is queried
 * against them twice a frame. A flat array would be 1200 box tests per frame,
 * which is survivable but wasteful; bucketing by an 8m cell brings it to about
 * a dozen. Boxes are immutable once added — nothing in this store moves except
 * the forklift, which is handled as a special case by Player.
 */
export class Colliders {
  constructor(cell = 8) {
    this.cell = cell
    this.boxes = []
    this.grid = new Map()
  }

  _key(cx, cz) {
    return cx * 73856093 ^ cz * 19349663
  }

  /** @param {object} b `{minX,maxX,minY,maxY,minZ,maxZ}` plus any extra fields */
  add(b) {
    const i = this.boxes.length
    this.boxes.push(b)
    const c = this.cell
    const x0 = Math.floor(b.minX / c)
    const x1 = Math.floor(b.maxX / c)
    const z0 = Math.floor(b.minZ / c)
    const z1 = Math.floor(b.maxZ / c)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz)
        let list = this.grid.get(k)
        if (!list) this.grid.set(k, (list = []))
        list.push(i)
      }
    }
    return b
  }

  /** Convenience: add a box from a centre + half-extents. */
  addBox(cx, cy, cz, hx, hy, hz, extra) {
    return this.add({
      minX: cx - hx, maxX: cx + hx,
      minY: cy - hy, maxY: cy + hy,
      minZ: cz - hz, maxZ: cz + hz,
      ...extra,
    })
  }

  /**
   * Every box whose cell overlaps the query circle. Pushed into `out` (which is
   * reused frame to frame — this is on the hot path and must not allocate).
   */
  query(x, z, radius, out) {
    out.length = 0
    const c = this.cell
    const x0 = Math.floor((x - radius) / c)
    const x1 = Math.floor((x + radius) / c)
    const z0 = Math.floor((z - radius) / c)
    const z1 = Math.floor((z + radius) / c)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.grid.get(this._key(cx, cz))
        if (!list) continue
        for (const i of list) {
          const b = this.boxes[i]
          if (out.indexOf(b) === -1) out.push(b)
        }
      }
    }
    return out
  }
}

// ===========================================================================
// Materials
// ===========================================================================

function stdMat(opts) {
  return new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02, ...opts })
}

/**
 * Source geometries for batched props. Unit-sized and shared: Batch clones and
 * transforms them, so these are never mutated and never drawn directly.
 */
const SRC = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 8, 6),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  cone3: new THREE.ConeGeometry(0.5, 1, 3),
  plane: new THREE.PlaneGeometry(1, 1),
  taperedCyl: new THREE.CylinderGeometry(0.5, 0.36, 1, 10),
}

// ===========================================================================
// The store
// ===========================================================================

export class Store {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] `{ quality }` — 'low' halves the prop counts
   */
  constructor(scene, opts = {}) {
    this.scene = scene
    this.quality = opts.quality || 'high'
    this.low = this.quality === 'low'
    this.colliders = new Colliders(8)
    this.root = new THREE.Group()
    this.root.name = 'store'
    scene.add(this.root)

    /** Meshes that animate (fans, screens, the rotisserie). */
    this._animated = []
    /** Scratch array for collision queries — never reallocated. */
    this._hits = []
    this._rand = rng(0xba7)
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /** Build everything. Split into steps so the boot screen can show progress. */
  buildSteps() {
    return [
      ['Sweeping the floor…', () => this._buildShell()],
      ['Putting up the racking…', () => this._buildAisles()],
      ['Stacking the pallets…', () => this._buildPallets()],
      ['Turning on the freezers…', () => this._buildFreezer()],
      ['Lighting the ovens…', () => this._buildFoodCourt()],
      ['Watering the plants…', () => this._buildGarden()],
      ['Opening the roller door…', () => this._buildDock()],
      ['Plugging in the TVs…', () => this._buildTVs()],
      ['Baking the muffins…', () => this._buildBakery()],
      ['Building the stage…', () => this._buildFrontAndStage()],
      ['Hanging the lights…', () => this._buildLights()],
    ]
  }

  // --- shell ---------------------------------------------------------------

  _buildShell() {
    const { minX, maxX, minZ, maxZ, ceiling } = STORE
    const w = maxX - minX
    const d = maxZ - minZ

    // Floor.
    const floorTex = concreteTexture()
    floorTex.repeat.set(w / 8, d / 8)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      stdMat({ map: floorTex, roughness: 0.55, metalness: 0.05 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
    floor.receiveShadow = true
    this.root.add(floor)

    // Department floor patches, laid a hair above the concrete so they never
    // z-fight with it.
    this._floorPatch(tileTexture(), 30, 60, 14, 45, 4)
    this._floorPatch(turfTexture(), 30, 60, -45, 12, 3)
    const hz = hazardTexture()
    this._floorPatch(hz, -42, 28, -45, -32, 2)

    // Walls. Corrugated steel, inward-facing.
    const wallMat = stdMat({ map: corrugatedTexture('#8f9aa3'), side: THREE.DoubleSide })
    wallMat.map.repeat.set(w / 4, ceiling / 4)
    const wall = (x, z, width, rotY) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(width, ceiling), wallMat)
      m.position.set(x, ceiling / 2, z)
      m.rotation.y = rotY
      this.root.add(m)
    }
    wall((minX + maxX) / 2, minZ, w, 0)
    wall((minX + maxX) / 2, maxZ, w, Math.PI)
    wall(minX, (minZ + maxZ) / 2, d, Math.PI / 2)
    wall(maxX, (minZ + maxZ) / 2, d, -Math.PI / 2)

    // Wall colliders — thick slabs so a fast player can never tunnel through.
    const t = 2
    this.colliders.addBox((minX + maxX) / 2, ceiling / 2, minZ - t, w / 2 + t, ceiling, t)
    this.colliders.addBox((minX + maxX) / 2, ceiling / 2, maxZ + t, w / 2 + t, ceiling, t)
    this.colliders.addBox(minX - t, ceiling / 2, (minZ + maxZ) / 2, t, ceiling, d / 2 + t)
    this.colliders.addBox(maxX + t, ceiling / 2, (minZ + maxZ) / 2, t, ceiling, d / 2 + t)

    // Roof deck, seen from below. It faces straight DOWN, so the hemisphere
    // light gives it the ground colour and nothing else — at 0x2a2f36 that
    // came out as a black void filling the top half of any wide shot. A mid
    // grey plus a little self-illumination keeps it reading as a ceiling.
    const roof = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      stdMat({ color: 0x5c646d, roughness: 1, emissive: 0x1a1e23, emissiveIntensity: 1 }),
    )
    roof.rotation.x = Math.PI / 2
    roof.position.set((minX + maxX) / 2, ceiling, (minZ + maxZ) / 2)
    this.root.add(roof)

    // Roof trusses. Purely visual, and cheap: one instanced box.
    const trussGeo = new THREE.BoxGeometry(w, 0.35, 0.35)
    const trussMat = stdMat({ color: 0x4b525a, roughness: 0.7, metalness: 0.4 })
    const count = this.low ? 9 : 18
    const trusses = new THREE.InstancedMesh(trussGeo, trussMat, count)
    const m4 = new THREE.Matrix4()
    for (let i = 0; i < count; i++) {
      const z = minZ + ((i + 0.5) * d) / count
      m4.makeTranslation((minX + maxX) / 2, ceiling - 0.6, z)
      trusses.setMatrixAt(i, m4)
    }
    trusses.instanceMatrix.needsUpdate = true
    this.root.add(trusses)
  }

  _floorPatch(tex, x0, x1, z0, z1, repeatDiv) {
    const t = tex.clone()
    t.needsUpdate = true
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set((x1 - x0) / repeatDiv, (z1 - z0) / repeatDiv)
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, z1 - z0),
      stdMat({ map: t, roughness: 0.7 }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2)
    m.receiveShadow = true
    this.root.add(m)
    return m
  }

  // --- racking -------------------------------------------------------------

  /**
   * Six runs of pallet racking. Each run is two back-to-back bays of uprights
   * and beams, loaded with product boxes.
   *
   * All of it is instanced: uprights and beams share one geometry each, and the
   * ~700 product boxes are bucketed into eight InstancedMeshes by texture. That
   * is the difference between 900 draw calls and about a dozen.
   */
  _buildAisles() {
    const rackH = 8
    const bayW = 2.8
    const depth = 1.15 // half-depth of one side of the run
    const levels = [0, 2.1, 4.2, 6.3]
    const bays = Math.floor((AISLE_MAX_Z - AISLE_MIN_Z) / bayW)

    const uprightGeo = new THREE.BoxGeometry(0.14, rackH, 0.14)
    const uprightMat = stdMat({ map: steelTexture(), metalness: 0.6, roughness: 0.5 })
    const beamGeo = new THREE.BoxGeometry(bayW, 0.16, 0.1)
    const beamMat = stdMat({ map: beamTexture(), metalness: 0.3, roughness: 0.6 })

    const uprightCount = AISLE_X.length * 2 * (bays + 1) * 2
    const beamCount = AISLE_X.length * 2 * bays * levels.length * 2
    const uprights = new THREE.InstancedMesh(uprightGeo, uprightMat, uprightCount)
    const beams = new THREE.InstancedMesh(beamGeo, beamMat, beamCount)
    uprights.castShadow = beams.castShadow = !this.low

    const m4 = new THREE.Matrix4()
    let ui = 0
    let bi = 0

    // Product boxes, bucketed by texture.
    const PRODUCTS = this.low ? 4 : 8
    const boxGeo = new THREE.BoxGeometry(1, 1, 1)
    const buckets = []
    for (let p = 0; p < PRODUCTS; p++) {
      buckets.push({
        mat: stdMat({ map: productTexture(p + 1), roughness: 0.75 }),
        xf: [],
      })
    }

    const r = this._rand

    for (const ax of AISLE_X) {
      // Two sides of the run, one facing each aisle.
      //
      // AISLE_HALF_WIDTH is the number that matters here, and getting it wrong
      // is not subtle: at the original 2.15 the two rack faces left a walkable
      // gap of 1.3m between them, so every aisle was a canyon barely wider than
      // Billy Bob, no camera could see anything but boxes, and duels framed the
      // inside of a shelf. 3.6 gives a 4.6m aisle — a real warehouse-club aisle,
      // wide enough for the follow camera and for a forklift to have got in.
      for (const side of [-1, 1]) {
        const sx = ax + side * AISLE_HALF_WIDTH

        for (let b = 0; b <= bays; b++) {
          const z = AISLE_MIN_Z + b * bayW
          for (const dz of [-depth, depth]) {
            m4.makeTranslation(sx, rackH / 2, z + dz * 0)
            // Uprights sit at the front and back of the frame depth.
            m4.setPosition(sx + (dz > 0 ? depth : -depth) * 0.001 + dz * 0, rackH / 2, z)
            uprights.setMatrixAt(ui++, m4)
          }
          if (b === bays) continue

          for (const ly of levels) {
            for (const dz of [-1, 1]) {
              m4.makeTranslation(sx + dz * depth, ly + 0.08, z + bayW / 2)
              m4.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
              beams.setMatrixAt(bi++, m4)
            }
          }

          // Load the bay. Lower levels are full pallets, upper levels are
          // sparser — which is both true of a real store and a cheap way to
          // let daylight from the roof lights through the racking.
          for (let li = 0; li < levels.length; li++) {
            if (li >= 2 && r() < 0.28) continue
            const per = li === 0 ? 2 : intFrom(r, 1, 2)
            for (let k = 0; k < per; k++) {
              const bw = bayW / per - 0.18
              const bh = rangeFrom(r, 1.1, 1.7)
              const bd = rangeFrom(r, 1.4, 2.0)
              const bx = sx + rangeFrom(r, -0.1, 0.1)
              const by = levels[li] + 0.16 + bh / 2
              const bz = z + bayW / 2 + (k - (per - 1) / 2) * (bayW / per)
              const bucket = buckets[intFrom(r, 0, PRODUCTS - 1)]
              bucket.xf.push([bx, by, bz, bw, bh, bd])
            }
          }
        }

        // One solid collider per rack run rather than per box: the player can
        // never get inside the racking, so the interior detail is invisible to
        // collision and 700 box colliders would be pure cost.
        //
        // 1.3 half-depth is a shade less than the widest box (1.0 half-depth
        // plus jitter), so the player stops a few centimetres shy of the
        // cardboard instead of clipping into it.
        this.colliders.addBox(
          sx, rackH / 2, (AISLE_MIN_Z + AISLE_MAX_Z) / 2,
          1.3, rackH / 2, (AISLE_MAX_Z - AISLE_MIN_Z) / 2,
          { kind: 'rack' },
        )
      }
    }

    uprights.count = ui
    beams.count = bi
    uprights.instanceMatrix.needsUpdate = true
    beams.instanceMatrix.needsUpdate = true
    this.root.add(uprights, beams)

    for (const bucket of buckets) {
      if (!bucket.xf.length) continue
      const im = new THREE.InstancedMesh(boxGeo, bucket.mat, bucket.xf.length)
      im.castShadow = !this.low
      im.receiveShadow = !this.low
      bucket.xf.forEach(([x, y, z, sx2, sy, sz], i) => {
        m4.makeScale(sx2, sy, sz)
        m4.setPosition(x, y, z)
        im.setMatrixAt(i, m4)
      })
      im.instanceMatrix.needsUpdate = true
      this.root.add(im)
    }

    // Hanging aisle signs.
    AISLES.forEach((a, i) => {
      const tex = signTexture(a.n, a.label)
      // FrontSide, not DoubleSide. Every aisle gets a sign at BOTH ends, each
      // facing outward, so the back of one is never the only thing you can
      // see — and a double-sided sign viewed from behind shows its text
      // mirrored, which looks like a rendering bug. Cull it instead.
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(4.4, 2.2),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide, toneMapped: false }),
      )
      sign.position.set(AISLE_X[i], 6.4, AISLE_MAX_Z + 1.5)
      this.root.add(sign)

      const back = sign.clone()
      back.position.z = AISLE_MIN_Z - 1.5
      back.rotation.y = Math.PI
      this.root.add(back)

      // The rod it hangs from.
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 4, 6),
        stdMat({ color: 0x555b61, metalness: 0.6 }),
      )
      rod.position.set(AISLE_X[i], 8.5, AISLE_MAX_Z + 1.5)
      this.root.add(rod)
    })

    this.aisleX = AISLE_X
  }

  // --- climbable pallets ---------------------------------------------------

  /**
   * Free-standing pallet stacks down the middle of the aisles. These are the
   * only things in the store the player can climb, and they are what turn six
   * straight corridors into a playground: every aisle has a route along the
   * top, and the raccoon is only reachable that way.
   */
  _buildPallets() {
    const r = this._rand
    const cardMat = [1, 2, 3].map((s) => stdMat({ map: cardboardTexture(s), roughness: 0.9 }))
    const palletMat = stdMat({ color: 0xa8895c, roughness: 0.95 })

    // Sixty-odd stacks of two or three boxes each is ~200 meshes if built
    // literally. None of them move, so they all collapse into four draws.
    const batch = new Batch(this.root)

    this.platforms = []

    const place = (x, z, height, w = 2.2, d = 2.2) => {
      batch.add(SRC.box, palletMat, [x, 0.08, z], [w, 0.16, d])

      // Cardboard on top, in one or two tiers.
      const tiers = height > 1.4 ? 2 : 1
      let y = 0.16
      for (let i = 0; i < tiers; i++) {
        const th = (height - 0.16) / tiers
        batch.add(
          SRC.box, cardMat[intFrom(r, 0, cardMat.length - 1)],
          [x + rangeFrom(r, -0.06, 0.06), y + th / 2, z + rangeFrom(r, -0.06, 0.06)],
          [w - 0.12 - i * 0.18, th, d - 0.12 - i * 0.18],
        )
        y += th
      }

      this.colliders.addBox(x, height / 2, z, w / 2, height / 2, d / 2, { kind: 'platform' })
      this.platforms.push({ x, z, height })
    }

    // A staircase of stacks in every aisle, so there is always a way up.
    for (const ax of AISLE_X) {
      let z = AISLE_MIN_Z + 4
      while (z < AISLE_MAX_Z - 4) {
        if (r() < 0.55) {
          const h = [0.9, 1.5, 2.1][intFrom(r, 0, 2)]
          place(ax + rangeFrom(r, -0.6, 0.6), z, h)
          z += rangeFrom(r, 5, 9)
        } else {
          z += rangeFrom(r, 4, 7)
        }
      }
    }

    // A deliberate three-step climb to the top of aisle 1's racking, where
    // Ricky sits. Hand-placed, not random: the route to a critter must exist
    // every single time.
    place(AISLE_X[0] + 0.2, 6, 0.9, 2.4, 2.4)
    place(AISLE_X[0] - 0.4, 9, 1.7, 2.4, 2.4)
    place(AISLE_X[0] + 0.3, 12, 2.6, 2.6, 2.6)

    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })
  }

  // --- departments ---------------------------------------------------------

  _buildFreezer() {
    const z0 = -22
    const z1 = 20
    // Doors hard against the left wall (x=-60), so the department's open floor
    // is entirely in front of them.
    const x = -57

    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xd8f0fa, transparent: true, opacity: 0.35, roughness: 0.12,
      metalness: 0, transmission: 0.5, thickness: 0.4,
    })
    const frostMat = new THREE.MeshStandardMaterial({
      map: frostTexture(), transparent: true, opacity: 0.55, roughness: 0.9,
    })
    const caseMat = stdMat({ color: 0xdfe6ea, roughness: 0.4, metalness: 0.3 })

    const batch = new Batch(this.root)
    const doors = Math.floor((z1 - z0) / 2.2)
    for (let i = 0; i < doors; i++) {
      const z = z0 + 1.1 + i * 2.2

      batch.add(SRC.box, caseMat, [x, 2.1, z], [2.4, 4.2, 2.1])
      batch.add(SRC.plane, glassMat, [x + 1.06, 2.1, z], [1.9, 3.4, 1], [0, Math.PI / 2, 0])
      batch.add(SRC.plane, frostMat, [x + 1.09, 2.1, z], [1.9, 3.4, 1], [0, Math.PI / 2, 0])

      // The cold blue glow inside. Only a handful of real lights — one per door
      // would be nineteen shadow-less point lights fighting over the same wall.
      if (!this.low && i % 4 === 0) {
        const glow = new THREE.PointLight(0x9fd8ec, 8, 9, 2)
        glow.position.set(x + 0.4, 2.4, z)
        this.root.add(glow)
      }
    }

    this.colliders.addBox(x, 2.1, (z0 + z1) / 2, 1.2, 2.1, (z1 - z0) / 2)

    // The chest freezers you can walk between, out in front of the doors.
    const chestMat = stdMat({ color: 0xe6eef2, roughness: 0.35, metalness: 0.25 })
    const lidMat = new THREE.MeshStandardMaterial({
      color: 0xbfe6f5, transparent: true, opacity: 0.6,
      emissive: 0x2b6d8c, emissiveIntensity: 0.6,
    })
    // x=-49, NOT -38. At -38 these sat exactly on aisle 1's centreline, boxed
    // in by that aisle's racking and outside their own department entirely —
    // which put Chilly Pete in the cereal aisle and reported his zone as "The
    // Aisles". Keep them inside the freezer zone (x -60..-44).
    const chestX = -49
    for (let i = 0; i < 5; i++) {
      const z = z0 + 4 + i * 8
      batch.add(SRC.box, chestMat, [chestX, 0.5, z], [3.4, 1.0, 5.4])
      batch.add(SRC.box, lidMat, [chestX, 1.06, z], [3.2, 0.12, 5.2])
      this.colliders.addBox(chestX, 0.53, z, 1.7, 0.53, 2.7, { kind: 'platform' })
      this.platforms.push({ x: chestX, z, height: 1.06 })
    }
    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })

    this._banner('FROSTY FOODS', -55.5, 6.5, -1, 0x1d6f96, Math.PI / 2, 10)
  }

  _buildFoodCourt() {
    const tableMat = stdMat({ color: 0xe4dfd2, roughness: 0.5 })
    const legMat = stdMat({ color: 0x6a6f75, metalness: 0.6, roughness: 0.4 })
    const benchMat = stdMat({ color: 0xc4483f, roughness: 0.7 })

    // Picnic tables.
    const batch = new Batch(this.root)
    for (let i = 0; i < 6; i++) {
      const x = 36 + (i % 3) * 7
      const z = 22 + Math.floor(i / 3) * 9
      batch.add(SRC.box, tableMat, [x, 0.78, z], [4.4, 0.14, 1.6])
      this.colliders.addBox(x, 0.4, z, 2.2, 0.4, 0.8, { kind: 'platform' })
      this.platforms.push({ x, z, height: 0.85 })

      for (const dz of [-1.4, 1.4]) {
        batch.add(SRC.box, benchMat, [x, 0.45, z + dz], [4.4, 0.12, 0.5])
      }
      for (const dx of [-1.8, 1.8]) {
        batch.add(SRC.cyl, legMat, [x + dx, 0.39, z], [0.14, 0.78, 0.14])
      }
    }
    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })

    // THE ROTISSERIE. The hottest thing in the store, and the reason the banjo
    // melts, so it had better LOOK like it.
    //
    // Built as five slabs around an open front rather than one solid box: as a
    // solid box the spits were sealed inside it and invisible, and the whole
    // department's centrepiece rendered as a grey slab with a glow on it. The
    // opening faces -Z, toward the seating, and the glass goes in front of it.
    const ovenMat = stdMat({ color: 0x8d959c, metalness: 0.75, roughness: 0.32 })
    const ob = new Batch(this.root)
    ob.add(SRC.box, ovenMat, [50, 1.7, 41.1], [9, 3.4, 0.25])   // back
    ob.add(SRC.box, ovenMat, [50, 3.3, 40], [9, 0.25, 2.4])     // top
    ob.add(SRC.box, ovenMat, [50, 0.12, 40], [9, 0.25, 2.4])    // bottom
    ob.add(SRC.box, ovenMat, [45.6, 1.7, 40], [0.25, 3.4, 2.4]) // left cheek
    ob.add(SRC.box, ovenMat, [54.4, 1.7, 40], [0.25, 3.4, 2.4]) // right cheek
    ob.flush({ castShadow: !this.low, receiveShadow: !this.low })

    // The collider stays a single solid: the inside of an oven is not a place
    // the player needs to be able to stand.
    this.colliders.addBox(50, 1.7, 40, 4.5, 1.7, 1.3)

    // Spits, INSIDE the opening. These turn, which is what sells "hot".
    const spitMat = stdMat({ color: 0xc98a3d, roughness: 0.6 })
    for (let i = 0; i < 3; i++) {
      const spit = new THREE.Group()
      for (let k = 0; k < 4; k++) {
        const bird = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), spitMat)
        bird.scale.set(1, 0.8, 1.25)
        bird.position.set(0, 0, -0.9 + k * 0.6)
        spit.add(bird)
      }
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), legMat)
      rod.rotation.x = Math.PI / 2
      spit.add(rod)
      spit.position.set(47 + i * 3, 1.0 + (i % 2) * 1.3, 40)
      this.root.add(spit)
      this._animated.push({ mesh: spit, spin: 1.4 })
    }

    // Glass, LAST and facing -Z so it sits between the spits and the viewer.
    // A default-FrontSide plane at the old rotation faced into the oven and was
    // simply culled away.
    const ovenGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(8.6, 3.0),
      new THREE.MeshStandardMaterial({
        color: 0xffb347, emissive: 0xff7a1a, emissiveIntensity: 0.9,
        transparent: true, opacity: 0.3, roughness: 0.15, side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    ovenGlass.position.set(50, 1.7, 38.82)
    ovenGlass.rotation.y = Math.PI
    this.root.add(ovenGlass)

    const heatLight = new THREE.PointLight(0xff7a1a, 40, 26, 2)
    heatLight.position.set(50, 3, 38)
    this.root.add(heatLight)
    this._heatLight = heatLight

    // The heat haze: a big soft additive plane above the oven.
    const haze = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 6),
      new THREE.MeshBasicMaterial({
        color: 0xff9a3a, transparent: true, opacity: 0.09,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    )
    haze.rotation.y = Math.PI
    haze.position.set(50, 4.5, 38.2)
    this.root.add(haze)
    this._animated.push({ mesh: haze, bob: 0.5, bobSpeed: 1.1 })

    this._banner('THE HOT ROTISSERIE — MIND YOUR BANJO', 45, 6.6, 44.4, 0xb8232f, Math.PI, 16)
  }

  _buildGarden() {
    const potMat = stdMat({ color: 0xb2593e, roughness: 0.9 })
    const leafMat = stdMat({ color: 0x3f8f3a, roughness: 0.85 })
    const trunkMat = stdMat({ color: 0x6b4a2c, roughness: 0.95 })
    const r = this._rand
    const n = this.low ? 14 : 30
    const batch = new Batch(this.root)

    for (let i = 0; i < n; i++) {
      const x = rangeFrom(r, 33, 57)
      const z = rangeFrom(r, -42, 8)
      const scale = rangeFrom(r, 0.7, 1.5)

      batch.add(SRC.taperedCyl, potMat, [x, 0.3 * scale, z], [scale, 0.6 * scale, scale])
      batch.add(SRC.cyl6, trunkMat,
        [x, (0.6 + 0.55) * scale, z], [0.2 * scale, 1.1 * scale, 0.2 * scale])

      // Three offset spheres make a convincing shrub for the price of three
      // spheres, and at garden-centre density that matters.
      for (let k = 0; k < 3; k++) {
        const s = scale * rangeFrom(r, 0.7, 1.1) * 1.1
        batch.add(SRC.sphere, leafMat, [
          x + rangeFrom(r, -0.3, 0.3) * scale,
          (1.5 + k * 0.28) * scale,
          z + rangeFrom(r, -0.3, 0.3) * scale,
        ], [s, s, s])
      }
      this.colliders.addBox(x, 0.5 * scale, z, 0.5 * scale, 0.5 * scale, 0.5 * scale)
    }

    // Patio furniture, stacked on pallets — climbable.
    const stackMat = stdMat({ color: 0x7a8c9b, roughness: 0.6 })
    for (let i = 0; i < 4; i++) {
      const x = 35 + i * 6
      const z = -20
      batch.add(SRC.box, stackMat, [x, 0.8, z], [2.6, 1.6, 2.6])
      this.colliders.addBox(x, 0.8, z, 1.3, 0.8, 1.3, { kind: 'platform' })
      this.platforms.push({ x, z, height: 1.6 })
    }

    // A gazebo, because every garden centre has one and it makes a landmark.
    const gazMat = stdMat({ color: 0x2f6f4f, roughness: 0.8 })
    batch.add(SRC.cone, gazMat, [45, 3.2, -6], [6.8, 1.8, 6.8])
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      batch.add(SRC.cyl6, trunkMat,
        [45 + Math.cos(a) * 2.6, 1.2, -6 + Math.sin(a) * 2.6], [0.18, 2.4, 0.18])
    }

    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })

    this._banner('GARDEN & PATIO', 45, 6.2, -44.4, 0x2f6f4f, 0, 14)
  }

  _buildDock() {
    // Roller shutter door.
    const door = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 6),
      stdMat({ map: corrugatedTexture('#b0562a'), roughness: 0.8 }),
    )
    door.material.map.repeat.set(3, 2)
    door.position.set(-8, 3, -44.8)
    this.root.add(door)

    // Stacked empty pallets.
    const palletMat = stdMat({ color: 0xa8895c, roughness: 0.95 })
    const r = this._rand
    const batch = new Batch(this.root)
    for (let i = 0; i < 5; i++) {
      const x = -30 + i * 9
      const z = -39
      const h = rangeFrom(r, 0.9, 1.9)
      batch.add(SRC.box, palletMat, [x, h / 2, z], [2.4, h, 2.4])
      this.colliders.addBox(x, h / 2, z, 1.2, h / 2, 1.2, { kind: 'platform' })
      this.platforms.push({ x, z, height: h })
    }

    // Shrink-wrapped towers, which are the tallest climbable things back here.
    const wrapMat = new THREE.MeshStandardMaterial({
      color: 0xbfd4e0, transparent: true, opacity: 0.72, roughness: 0.35,
    })
    for (let i = 0; i < 3; i++) {
      const x = 6 + i * 7
      const z = -37 - (i % 2) * 4
      batch.add(SRC.box, wrapMat, [x, 1.4, z], [2.6, 2.8, 2.6])
      this.colliders.addBox(x, 1.4, z, 1.3, 1.4, 1.3, { kind: 'platform' })
      this.platforms.push({ x, z, height: 2.8 })
    }
    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })

    this._banner('LOADING DOCK — STAFF ONLY (AND BILLY BOB)', -8, 7.4, -44.5, 0x8a6d1e, 0, 18)
  }

  _buildTVs() {
    const wallX = -59.4
    const frameMat = stdMat({ color: 0x14161a, roughness: 0.5 })
    const cols = 5
    const rows = 4
    const batch = new Batch(this.root)
    // Four screen materials cycled across twenty TVs, so the wall reads as a
    // wall of different pictures for four draw calls instead of twenty.
    const screenMats = [0, 1, 2, 3].map((i) => new THREE.MeshBasicMaterial({
      map: screenTexture(1 + i), toneMapped: false,
    }))
    for (let c = 0; c < cols; c++) {
      for (let rw = 0; rw < rows; rw++) {
        const z = -42 + c * 3.6
        const y = 1.4 + rw * 2.0
        batch.add(SRC.box, frameMat, [wallX, y, z], [0.14, 1.7, 3.0])
        batch.add(SRC.plane, screenMats[(c + rw) % 4],
          [wallX + 0.09, y, z], [2.7, 1.45, 1], [0, Math.PI / 2, 0])
      }
    }
    batch.flush({ castShadow: false, receiveShadow: false })
    const glow = new THREE.PointLight(0x88aaff, 12, 22, 2)
    glow.position.set(-56, 4, -34)
    this.root.add(glow)

    this._banner('TELEVISION WALL', -59, 9.4, -34, 0x2b3a8a, Math.PI / 2, 12)
  }

  _buildBakery() {
    const counterMat = stdMat({ color: 0xd8c39a, roughness: 0.7 })
    const muffinTop = stdMat({ color: 0x8a5a2b, roughness: 0.9 })
    const muffinCase = stdMat({ color: 0xefe2c4, roughness: 0.95 })

    const counter = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 18), counterMat)
    counter.position.set(-52, 0.55, 34)
    counter.castShadow = counter.receiveShadow = !this.low
    this.root.add(counter)
    this.colliders.addBox(-52, 0.55, 34, 1.6, 0.55, 9, { kind: 'platform' })
    this.platforms.push({ x: -52, z: 34, height: 1.1 })

    // Absurdly large muffins. A five-year-old finds this extremely funny and
    // it costs two primitives each.
    const batch = new Batch(this.root)
    for (let i = 0; i < 6; i++) {
      const z = 27 + i * 2.6
      batch.add(SRC.taperedCyl, muffinCase, [-52, 1.4, z], [1, 0.6, 1])
      batch.add(SRC.sphere, muffinTop, [-52, 1.85, z], [1.32, 0.92, 1.32])
    }
    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })

    // The ovens — warm, but nothing like the rotisserie.
    const oven = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 3.2, 9),
      stdMat({ color: 0x9aa2a8, metalness: 0.7, roughness: 0.35 }),
    )
    oven.position.set(-58, 1.6, 34)
    this.root.add(oven)
    this.colliders.addBox(-58, 1.6, 34, 1.2, 1.6, 4.5)

    const warm = new THREE.PointLight(0xffb066, 14, 18, 2)
    warm.position.set(-55, 3, 34)
    this.root.add(warm)

    this._banner('THE BAKERY', -59, 6.4, 34, 0x8a5a2b, Math.PI / 2, 12)
  }

  _buildFrontAndStage() {
    // Checkout lanes.
    const beltMat = stdMat({ color: 0x2c2f33, roughness: 0.9 })
    const standMat = stdMat({ color: 0xdfe3e6, roughness: 0.6 })
    const batch = new Batch(this.root)
    for (let i = 0; i < 8; i++) {
      const x = -30 + i * 8
      if (Math.abs(x) < 18) continue // leave the middle open for the stage
      batch.add(SRC.box, standMat, [x, 0.52, 33], [1.4, 1.05, 5.4])
      this.colliders.addBox(x, 0.52, 33, 0.7, 0.52, 2.7, { kind: 'platform' })
      this.platforms.push({ x, z: 33, height: 1.05 })
      batch.add(SRC.box, beltMat, [x, 1.07, 33], [1.1, 0.06, 4.6])
    }

    // THE FREE SAMPLE STAGE — a low round riser at the front of the store.
    const stage = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 7.4, 1.2, 32),
      stdMat({ color: 0x7a3a1e, roughness: 0.8 }),
    )
    stage.position.copy(POINTS.stage).setY(0.6)
    stage.receiveShadow = true
    this.root.add(stage)
    this.colliders.addBox(POINTS.stage.x, 0.6, POINTS.stage.z, 7, 0.6, 7, { kind: 'platform' })
    this.platforms.push({ x: POINTS.stage.x, z: POINTS.stage.z, height: 1.2 })

    // Bunting around the rim. Four colours, four draws.
    const buntMats = [0xef4a4a, 0xf5d130, 0x57d96a, 0x4aa8ef].map(
      (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }),
    )
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      batch.add(SRC.cone3, buntMats[i % 4], [
        POINTS.stage.x + Math.cos(a) * 7.6, 2.6, POINTS.stage.z + Math.sin(a) * 7.6,
      ], [0.44, 0.5, 0.44], [Math.PI, 0, 0])
    }

    // Six microphone stands, one per band member, in a semicircle.
    this.bandSpots = []
    const poleMat = stdMat({ color: 0x24272b, metalness: 0.6, roughness: 0.4 })
    const micMat = stdMat({ color: 0x3a3f45, metalness: 0.5 })
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * (0.15 + (i / 5) * 0.7)
      const x = POINTS.stage.x + Math.cos(a) * 4.6
      const z = POINTS.stage.z + Math.sin(a) * 4.6
      this.bandSpots.push(new THREE.Vector3(x, 1.2, z))
      batch.add(SRC.cyl6, poleMat, [x, 1.95, z], [0.09, 1.5, 0.09])
      batch.add(SRC.sphere, micMat, [x, 2.74, z], [0.22, 0.22, 0.22])
    }

    this._banner('GIGA-MART WHOLESALE CLUB', 0, 8.6, 44.4, 0x123a6b, Math.PI, 26)
    this._banner('★ FREE SAMPLE STAGE ★', 0, 5.4, 44.2, 0xe8a51e, Math.PI, 14)

    // Billy Bob's fort: a horseshoe of paper-towel packs he calls home.
    const packMat = stdMat({ color: 0xf0efe6, roughness: 0.95 })
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (0.15 + (i / 8) * 0.7)
      const x = POINTS.fort.x + Math.cos(a) * 3.2
      const z = POINTS.fort.z + Math.sin(a) * 3.2
      const h = 1.6 + (i % 3) * 0.5
      batch.add(SRC.box, packMat, [x, h / 2, z], [1.3, h, 1.3], [0, a, 0])
      this.colliders.addBox(x, h / 2, z, 0.65, h / 2, 0.65, { kind: 'platform' })
      this.platforms.push({ x, z, height: h })
    }

    batch.flush({ castShadow: !this.low, receiveShadow: !this.low })
  }

  /**
   * Hang a banner.
   *
   * FACING CONVENTION, get this wrong and the text renders mirrored: a plane's
   * normal points at +Z, so `rotY` is the direction the banner FACES, and every
   * banner must face INTO the building.
   *   back wall  (z = -45): rotY 0
   *   front wall (z = +45): rotY π
   *   left wall  (x = -60): rotY π/2
   *   right wall (x = +60): rotY -π/2
   */
  _banner(text, x, y, z, color, rotY = 0, width = 14) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(width, width / 4),
      new THREE.MeshBasicMaterial({
        map: bannerTexture(text, `#${color.toString(16).padStart(6, '0')}`),
        // FrontSide: see the facing convention above. From the wrong side a
        // banner should vanish, not read backwards.
        side: THREE.FrontSide, toneMapped: false,
      }),
    )
    m.position.set(x, y, z)
    m.rotation.y = rotY
    this.root.add(m)
    return m
  }

  // --- lighting ------------------------------------------------------------

  _buildLights() {
    // A warehouse is lit flat and bright from a high grid of fixtures. Getting
    // that feeling is mostly ambient: the hemisphere light does the work and
    // the single directional exists to cast the player's shadow, which is the
    // only shadow a child actually reads.
    const hemi = new THREE.HemisphereLight(0xf2f6ff, 0x6a6a66, 2.1)
    this.scene.add(hemi)

    const ambient = new THREE.AmbientLight(0xffffff, 0.45)
    this.scene.add(ambient)

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.5)
    sun.position.set(24, 30, 18)
    sun.castShadow = !this.low
    if (sun.castShadow) {
      sun.shadow.mapSize.set(1024, 1024)
      sun.shadow.camera.near = 1
      sun.shadow.camera.far = 90
      const s = 26
      sun.shadow.camera.left = -s
      sun.shadow.camera.right = s
      sun.shadow.camera.top = s
      sun.shadow.camera.bottom = -s
      sun.shadow.bias = -0.0012
      sun.shadow.normalBias = 0.03
    }
    this.scene.add(sun)
    this.scene.add(sun.target)
    this.sun = sun

    // The fixtures themselves — emissive strips, no light attached. Twenty-four
    // real lights would look identical and cost a fortune.
    const stripGeo = new THREE.BoxGeometry(3.6, 0.12, 0.5)
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xfff8e8, toneMapped: false })
    const cols = 7
    const rows = this.low ? 5 : 9
    const strips = new THREE.InstancedMesh(stripGeo, stripMat, cols * rows)
    const m4 = new THREE.Matrix4()
    let i = 0
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        m4.makeTranslation(
          STORE.minX + ((c + 0.5) * (STORE.maxX - STORE.minX)) / cols,
          STORE.ceiling - 1.1,
          STORE.minZ + ((r + 0.5) * (STORE.maxZ - STORE.minZ)) / rows,
        )
        strips.setMatrixAt(i++, m4)
      }
    }
    strips.instanceMatrix.needsUpdate = true
    this.root.add(strips)

    // A faint warm fog: it hides the far wall, gives the aisles depth, and
    // costs nothing.
    this.scene.fog = new THREE.Fog(0xb9bec4, 45, 145)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Which department contains this point. Never returns null. */
  zoneAt(x, z) {
    for (const zone of ZONES) {
      if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ) return zone
    }
    return ZONES[ZONES.length - 1]
  }

  /**
   * How hot it is here, 0..1 hot and 0..-1 cold, falling off with distance from
   * the actual heat source rather than snapping at the zone boundary — which
   * is what lets the melt meter creep up as you approach the rotisserie
   * instead of slamming on the instant you cross a line.
   */
  heatAt(x, z) {
    const zone = this.zoneAt(x, z)
    let h = zone.heat

    // The rotisserie is the real furnace: a radial hot spot on top of the
    // food-court base heat.
    const dx = x - 50
    const dz = z - 39
    const d = Math.hypot(dx, dz)
    if (d < 22) h = Math.max(h, 1.6 * (1 - d / 22))

    // The freezer doors chill the aisle in front of them.
    if (x < -30 && z > -24 && z < 22) {
      const t = Math.max(0, 1 - (x + 44) / -14)
      h = Math.min(h, -Math.max(0.35, t))
    }
    return Math.max(-1, Math.min(1.4, h))
  }

  /**
   * Ground height under a point — the top of the tallest platform whose
   * footprint contains it, or 0 for bare concrete.
   *
   * `maxY` is the player's feet: a platform above the feet is a ceiling, not a
   * floor, and standing under a table must not teleport you onto it.
   */
  groundHeight(x, z, maxY = Infinity) {
    let best = 0
    const boxes = this.colliders.query(x, z, 0.6, this._hits)
    for (const b of boxes) {
      if (b.kind !== 'platform') continue
      if (x < b.minX - 0.35 || x > b.maxX + 0.35) continue
      if (z < b.minZ - 0.35 || z > b.maxZ + 0.35) continue
      if (b.maxY > maxY + 0.35) continue
      if (b.maxY > best) best = b.maxY
    }
    return best
  }

  /**
   * Push a vertical capsule out of every box it overlaps.
   *
   * Resolution is per-axis and takes the smallest penetration, which is the
   * cheapest thing that behaves correctly at a corner. `feetY` and `headY`
   * bound the body: a box entirely above the head or below the feet is ignored,
   * which is exactly what makes standing on a pallet work — once you are on top
   * of it, it stops being a wall.
   *
   * @param {THREE.Vector3} pos mutated in place
   * @param {number} radius
   * @param {number} height
   * @returns {boolean} true if anything was pushed
   */
  resolve(pos, radius, height) {
    const boxes = this.colliders.query(pos.x, pos.z, radius + 0.5, this._hits)
    const feetY = pos.y + 0.15 // a small step-up, so kerbs don't stop you dead
    const headY = pos.y + height
    let touched = false

    for (const b of boxes) {
      if (b.maxY <= feetY || b.minY >= headY) continue

      const px = Math.min(b.maxX + radius - pos.x, pos.x - (b.minX - radius))
      if (px <= 0) continue
      const pz = Math.min(b.maxZ + radius - pos.z, pos.z - (b.minZ - radius))
      if (pz <= 0) continue

      touched = true
      if (px < pz) {
        pos.x += pos.x < (b.minX + b.maxX) / 2 ? -px : px
      } else {
        pos.z += pos.z < (b.minZ + b.maxZ) / 2 ? -pz : pz
      }
    }

    // Keep everyone inside the building regardless.
    pos.x = Math.max(STORE.minX + radius, Math.min(STORE.maxX - radius, pos.x))
    pos.z = Math.max(STORE.minZ + radius, Math.min(STORE.maxZ - radius, pos.z))
    return touched
  }

  /** Is there a solid box between two points? Used to hide off-screen markers. */
  update(dt, elapsed) {
    for (const a of this._animated) {
      if (a.spin) a.mesh.rotation.x += a.spin * dt
      if (a.bob) a.mesh.position.y = a.mesh.position.y + Math.sin(elapsed * a.bobSpeed) * a.bob * dt
    }
    if (this._heatLight) {
      // Flicker, so the oven feels alive.
      this._heatLight.intensity = 36 + Math.sin(elapsed * 7.3) * 4 + Math.sin(elapsed * 13.1) * 2
    }
  }
}
