// chars/Rigs.js — everybody in the store, built from primitives.
//
// Faces are geometry rather than textures on purpose: at the distance a
// third-person camera sits, a painted face reads as a smudge, whereas two white
// spheres with black pupils read as EYES from across the building. It also
// means a rig can look at things, which is most of what makes these feel alive.
//
// Every rig exposes the same shape:
//   { group, update(dt, state), parts }
// where `state` is `{ speed, grounded, strumming, happy, lookAt }`. Nothing
// here knows about the game — Player and Critters drive them.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { chocolateTexture } from '../world/Textures.js'
import { STRING_COLORS_HEX } from '../core/Audio.js'

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, ...opts })

/** Shared geometry — a rig is built dozens of times and these never change. */
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 12, 10),
  lowSphere: new THREE.SphereGeometry(0.5, 8, 6),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
  torus: new THREE.TorusGeometry(0.5, 0.14, 6, 16),
}

function part(geo, material, pos, scale, rot) {
  const m = new THREE.Mesh(geo, material)
  if (pos) m.position.set(pos[0], pos[1], pos[2])
  if (scale) m.scale.set(scale[0], scale[1], scale[2])
  if (rot) m.rotation.set(rot[0], rot[1], rot[2])
  m.castShadow = true
  return m
}

/**
 * A pair of eyes on a pivot, so a rig can glance at things.
 * @returns {THREE.Group} with `.pupils` for the two pupil meshes
 */
function makeEyes(radius, spread, y, z, pupilColor = 0x111111) {
  const g = new THREE.Group()
  const whiteMat = mat(0xffffff, { roughness: 0.35 })
  const pupilMat = mat(pupilColor, { roughness: 0.4 })
  g.pupils = []
  for (const s of [-1, 1]) {
    const eye = part(G.sphere, whiteMat, [s * spread, y, z], [radius * 2, radius * 2, radius * 1.4])
    g.add(eye)
    const pupil = part(
      G.sphere, pupilMat,
      [s * spread, y, z + radius * 0.62],
      [radius * 0.95, radius * 0.95, radius * 0.7],
    )
    g.add(pupil)
    g.pupils.push(pupil)
    pupil.userData.home = pupil.position.clone()
  }
  return g
}

/**
 * Collapse a group's DIRECT mesh children into one merged mesh per material.
 *
 * A raccoon is twenty-odd primitives, and none of them move relative to its
 * body — the parts that DO animate (the eyes' pupils, the instrument) live in
 * child Groups, which this deliberately leaves alone. Six critters plus Billy
 * Bob went from ~180 meshes to ~40 for exactly no visual difference.
 *
 * Only ever call this on a group whose mesh children are static with respect to
 * it. Merging something that needed to move on its own is not a subtle bug: the
 * part simply stops animating and nothing errors.
 */
function mergeStatic(group) {
  const byMat = new Map()
  const keep = []
  for (const child of group.children.slice()) {
    // `userData.animated` opts a mesh out — Big Earl's beacon spins on its own
    // transform and would silently stop if it were baked into the body.
    if (!child.isMesh || child.children.length || child.userData.animated) {
      keep.push(child)
      continue
    }
    const g = child.geometry.clone()
    child.updateMatrix()
    g.applyMatrix4(child.matrix)
    let list = byMat.get(child.material)
    if (!list) byMat.set(child.material, (list = []))
    list.push(g)
    group.remove(child)
  }
  for (const [material, geos] of byMat) {
    let merged = null
    try {
      merged = mergeGeometries(geos, false)
    } catch (e) {
      merged = null
    }
    if (merged) {
      const m = new THREE.Mesh(merged, material)
      m.castShadow = true
      group.add(m)
      for (const g of geos) g.dispose()
    } else {
      // Attribute sets didn't line up. Put them back rather than lose a face.
      for (const g of geos) group.add(new THREE.Mesh(g, material))
    }
  }
  return keep
}

/** A simple smiling mouth: a torus arc rotated to open downward. */
function makeSmile(width, y, z, color = 0x3a1f14) {
  const geo = new THREE.TorusGeometry(width, width * 0.16, 6, 14, Math.PI)
  const m = new THREE.Mesh(geo, mat(color, { roughness: 0.6 }))
  m.position.set(0, y, z)
  m.rotation.z = Math.PI
  m.castShadow = false
  return m
}

// ===========================================================================
// The chocolate banjo
// ===========================================================================

/**
 * The banjo itself: a chocolate drum head, a chocolate neck, and four strings
 * in the duel colours so the thing the player is looking at matches the buttons
 * they are pressing.
 *
 * `setMelt(t)` runs 0 (solid, cold) to 1 (a puddle). Melting droops the neck,
 * sags the pot, shifts the colour toward a glossy brown and dims the magic
 * glow — all of it continuous, so the meter on the HUD and the object in the
 * player's hands always agree.
 */
export function makeBanjo() {
  const group = new THREE.Group()
  const choc = chocolateTexture()

  const bodyMat = new THREE.MeshStandardMaterial({
    map: choc, color: 0xffffff, roughness: 0.42, metalness: 0.08,
    emissive: 0x5a3418, emissiveIntensity: 0.12,
  })

  const pot = part(G.cyl, bodyMat, [0, 0, 0], [0.62, 0.16, 0.62], [Math.PI / 2, 0, 0])
  group.add(pot)

  // The head — pale, like white chocolate stretched over the pot. Kept a good
  // way off white: the magic glow below sits right on it, and a near-white
  // head under a point light blows out to a featureless disc.
  const headMat = mat(0xcdb98f, { roughness: 0.7 })
  const head = part(G.cyl, headMat, [0, 0, 0.09], [0.55, 0.02, 0.55], [Math.PI / 2, 0, 0])
  group.add(head)

  // Neck, on a pivot at the pot so melting can droop it.
  const neckPivot = new THREE.Group()
  neckPivot.position.set(0, 0.1, 0)
  group.add(neckPivot)

  const neck = part(G.box, bodyMat, [0, 0.62, 0], [0.13, 1.25, 0.1])
  neckPivot.add(neck)

  const peghead = part(G.box, bodyMat, [0, 1.32, 0], [0.2, 0.3, 0.11])
  neckPivot.add(peghead)

  // Four strings, in the four duel colours, running the length of the neck.
  const strings = []
  for (let i = 0; i < 4; i++) {
    const s = part(
      G.box,
      new THREE.MeshStandardMaterial({
        color: STRING_COLORS_HEX[i], emissive: STRING_COLORS_HEX[i],
        emissiveIntensity: 0.22, roughness: 0.3,
      }),
      // Length 1.24, not 1.5: the strings must stop at the peghead. Overrunning
      // it is what made them read as a floating rainbow rather than as strings.
      [(i - 1.5) * 0.032, 0.6, 0.06],
      [0.014, 1.24, 0.014],
    )
    s.castShadow = false
    neckPivot.add(s)
    strings.push(s)
  }

  // Tuning pegs.
  for (let i = 0; i < 4; i++) {
    const peg = part(
      G.cyl, mat(0xf0e6d2, { roughness: 0.4 }),
      [(i % 2 ? 0.11 : -0.11), 1.24 + Math.floor(i / 2) * 0.14, 0],
      [0.03, 0.16, 0.03], [0, 0, Math.PI / 2],
    )
    neckPivot.add(peg)
  }

  // The magic: a soft glow that only a magical chocolate banjo would have.
  // Behind the pot, not in front of it — in front, it lights the drum head
  // straight on and the banjo reads as a lamp.
  const glow = new THREE.PointLight(0xffb45c, 1.1, 3, 2)
  glow.position.set(0, 0.25, -0.35)
  group.add(glow)

  // Drips, revealed as it melts.
  const drips = []
  for (let i = 0; i < 5; i++) {
    const d = part(
      G.sphere, bodyMat,
      [(i - 2) * 0.2, -0.3, 0.02],
      [0.001, 0.001, 0.001],
    )
    group.add(d)
    drips.push(d)
  }

  let melt = 0
  return {
    group,
    strings,
    get melt() { return melt },
    /** @param {number} t 0 = frozen solid, 1 = a puddle on the floor */
    setMelt(t) {
      melt = Math.max(0, Math.min(1, t))
      neckPivot.rotation.x = melt * 0.55
      neckPivot.rotation.z = Math.sin(melt * 3.1) * 0.14 * melt
      pot.scale.set(0.62 + melt * 0.16, 0.16 - melt * 0.05, 0.62 + melt * 0.16)
      bodyMat.roughness = 0.42 - melt * 0.3
      bodyMat.emissiveIntensity = 0.12 * (1 - melt)
      glow.intensity = 2.4 * (1 - melt * 0.9)
      for (let i = 0; i < drips.length; i++) {
        const s = Math.max(0.001, melt * (0.1 + (i % 3) * 0.03))
        drips[i].scale.set(s, s * (1 + melt * 2), s)
        drips[i].position.y = -0.28 - melt * 0.25
      }
      for (const s of strings) s.material.emissiveIntensity = 0.5 * (1 - melt * 0.8)
    },
    /** Flash one string, for a note being played. */
    flashString(i, amount = 1) {
      const s = strings[i]
      if (s) s.material.emissiveIntensity = 0.5 + amount * 2.5
    },
    /** Decay the string flashes. Call every frame. */
    update(dt) {
      for (const s of strings) {
        const base = 0.5 * (1 - melt * 0.8)
        s.material.emissiveIntensity = Math.max(
          base, s.material.emissiveIntensity - dt * 6,
        )
      }
    },
  }
}

// ===========================================================================
// Billy Bob Joe Bob
// ===========================================================================

/**
 * The man himself. Denim overalls, a red shirt, a straw hat, and a permanent
 * grin. Built facing +Z, which is the convention every rig in this file uses.
 */
/**
 * The four people who can be playing.
 *
 * Co-op on one screen lives or dies on being able to tell at a glance which one
 * is you, and a five-year-old is not going to read a name tag. So the players
 * differ in the two biggest blocks of colour on the rig — the dungarees and the
 * shirt — rather than in some detail like a hatband, and the HUD, the join
 * screen and the duel all quote `accent` so the same colour follows a player
 * everywhere. Nobody is red or green: those two are string colours, and a red
 * player standing next to a lit red string is exactly the confusion the whole
 * colour scheme exists to avoid.
 */
export const PLAYER_SKINS = [
  {
    id: 'billy', name: 'Billy Bob Joe Bob', accent: '#4aa8ef', accentHex: 0x4aa8ef,
    skin: 0xe0a878, denim: 0x3d5a8a, shirt: 0xb8342e, straw: 0xd9bb72, band: 0x8a2f2a,
  },
  {
    id: 'sally', name: 'Sally Sue Mae Sue', accent: '#c07ae0', accentHex: 0xc07ae0,
    skin: 0xc98a5e, denim: 0x6b4a8f, shirt: 0xe0d24a, straw: 0xe6d9a8, band: 0x4a2f6a,
  },
  {
    id: 'roy', name: 'Cousin Roy Boy Roy', accent: '#f0913a', accentHex: 0xf0913a,
    skin: 0xf0c49a, denim: 0x2f6f6a, shirt: 0xe08a2e, straw: 0xc9a95e, band: 0x1f4a48,
  },
  {
    id: 'pearl', name: 'Auntie Pearl Girl Pearl', accent: '#f06fb0', accentHex: 0xf06fb0,
    skin: 0x8a5c3a, denim: 0x46466b, shirt: 0xef6fae, straw: 0xf0e4c2, band: 0x2e2e4a,
  },
]

/** Look a skin up by id or index, always returning something drawable. */
export function playerSkin(which = 0) {
  if (typeof which === 'string') {
    return PLAYER_SKINS.find((p) => p.id === which) || PLAYER_SKINS[0]
  }
  return PLAYER_SKINS[((which | 0) % PLAYER_SKINS.length + PLAYER_SKINS.length) % PLAYER_SKINS.length]
}

/**
 * @param {number|string} [which] index or id into PLAYER_SKINS. Everything else
 *   about the rig — proportions, animation, the banjo — is identical for all
 *   four, so a player never has a mechanical advantage from who they picked.
 */
export function makeBillyBob(which = 0) {
  const group = new THREE.Group()
  const pal = playerSkin(which)

  const skin = mat(pal.skin)
  const denim = mat(pal.denim, { roughness: 0.95 })
  const shirt = mat(pal.shirt, { roughness: 0.95 })
  const boot = mat(0x4a3123, { roughness: 0.9 })
  const straw = mat(pal.straw, { roughness: 0.95 })

  // --- body ---------------------------------------------------------------
  const body = new THREE.Group()
  body.position.y = 0.95
  group.add(body)

  const torso = part(G.box, denim, [0, 0, 0], [0.62, 0.72, 0.42])
  body.add(torso)

  // Overall straps and the bib, so it reads as dungarees and not a blue box.
  for (const s of [-1, 1]) {
    body.add(part(G.box, denim, [s * 0.19, 0.44, -0.14], [0.11, 0.3, 0.1]))
  }
  body.add(part(G.box, denim, [0, 0.32, 0.22], [0.36, 0.28, 0.03]))
  // The one brass button.
  body.add(part(G.cyl, mat(0xd6a63a, { metalness: 0.6, roughness: 0.35 }),
    [0, 0.4, 0.245], [0.05, 0.02, 0.05], [Math.PI / 2, 0, 0]))

  // Shirt showing above the bib.
  body.add(part(G.box, shirt, [0, 0.46, 0], [0.58, 0.22, 0.4]))

  // --- head ---------------------------------------------------------------
  const head = new THREE.Group()
  head.position.set(0, 0.78, 0)
  body.add(head)

  head.add(part(G.sphere, skin, [0, 0, 0], [0.62, 0.66, 0.6]))
  const eyes = makeEyes(0.09, 0.15, 0.06, 0.26)
  head.add(eyes)
  head.add(makeSmile(0.16, -0.09, 0.28))
  // Nose.
  head.add(part(G.sphere, skin, [0, -0.01, 0.3], [0.11, 0.09, 0.12]))
  // A magnificent moustache.
  head.add(part(G.box, mat(0x6b4423), [0, -0.045, 0.29], [0.28, 0.06, 0.07]))
  // Ears.
  for (const s of [-1, 1]) head.add(part(G.sphere, skin, [s * 0.31, 0.02, 0], [0.1, 0.14, 0.08]))

  // Straw hat.
  const hat = new THREE.Group()
  hat.position.y = 0.3
  head.add(hat)
  hat.add(part(G.cyl, straw, [0, 0.02, 0], [0.86, 0.03, 0.86]))
  hat.add(part(G.cyl, straw, [0, 0.14, 0], [0.46, 0.22, 0.46]))
  hat.add(part(G.cyl, mat(pal.band), [0, 0.06, 0], [0.48, 0.06, 0.48]))

  // --- limbs --------------------------------------------------------------
  // Each limb hangs from a pivot at the shoulder/hip so a rotation swings it.
  const limb = (x, y, material, len, thick) => {
    const pivot = new THREE.Group()
    pivot.position.set(x, y, 0)
    const m = part(G.box, material, [0, -len / 2, 0], [thick, len, thick])
    pivot.add(m)
    return pivot
  }

  const armL = limb(-0.4, 0.5, shirt, 0.62, 0.16)
  const armR = limb(0.4, 0.5, shirt, 0.62, 0.16)
  body.add(armL, armR)
  // Hands.
  armL.add(part(G.sphere, skin, [0, -0.66, 0], [0.19, 0.19, 0.19]))
  armR.add(part(G.sphere, skin, [0, -0.66, 0], [0.19, 0.19, 0.19]))

  const legL = limb(-0.18, -0.36, denim, 0.62, 0.22)
  const legR = limb(0.18, -0.36, denim, 0.62, 0.22)
  body.add(legL, legR)
  legL.add(part(G.box, boot, [0, -0.68, 0.05], [0.26, 0.16, 0.36]))
  legR.add(part(G.box, boot, [0, -0.68, 0.05], [0.26, 0.16, 0.36]))

  // --- the banjo ----------------------------------------------------------
  const banjo = makeBanjo()
  // Held the way a picker actually holds one: pot at the right hip, neck up
  // and across to the LEFT, drum head facing forward.
  //
  // The rig faces +Z, the banjo is built with its neck along +Y and its head
  // facing +Z. So a POSITIVE rotation about Z swings the neck to the player's
  // left (screen right when you are looking at his face), and a small negative
  // rotation about X tips the top of the neck back toward his shoulder. Getting
  // the sign of that Z rotation wrong points the neck at the floor.
  banjo.group.position.set(0.3, 0.02, 0.3)
  banjo.group.rotation.set(-0.12, 0, 0.72)
  banjo.group.scale.setScalar(0.8)
  body.add(banjo.group)

  // Collapse the static parts. `body`, `head` and `hat` each hold a pile of
  // primitives that never move relative to their parent; the limbs, the eyes
  // and the banjo are Groups and are left alone.
  mergeStatic(hat)
  mergeStatic(head)
  mergeStatic(body)

  group.traverse((o) => { if (o.isMesh) o.castShadow = true })

  // --- animation ----------------------------------------------------------
  let t = 0
  let strumSwing = 0
  let bobPhase = 0

  return {
    group,
    banjo,
    skin: pal,
    parts: { body, head, eyes, hat, armL, armR, legL, legR },

    /**
     * @param {number} dt
     * @param {object} s `{ speed, grounded, strumming, melt, dance }`
     */
    update(dt, s = {}) {
      t += dt
      const speed = s.speed || 0
      const moving = speed > 0.25

      // Walk cycle. Stride frequency rises with speed, which is what stops a
      // fast walk from looking like a slow one played faster.
      if (moving) {
        bobPhase += dt * (3.2 + speed * 0.85)
        const swing = Math.min(0.85, 0.22 + speed * 0.1)
        legL.rotation.x = Math.sin(bobPhase) * swing
        legR.rotation.x = -Math.sin(bobPhase) * swing
        armR.rotation.x = -Math.sin(bobPhase) * swing * 0.5
        body.position.y = 0.95 + Math.abs(Math.sin(bobPhase)) * 0.055
        body.rotation.z = Math.sin(bobPhase) * 0.035
      } else {
        // Idle: breathe, and tap a foot, because he is always hearing music.
        bobPhase += dt * 2.2
        legL.rotation.x *= 1 - Math.min(1, dt * 8)
        legR.rotation.x = Math.sin(bobPhase * 2) * 0.06
        armR.rotation.x *= 1 - Math.min(1, dt * 8)
        body.position.y = 0.95 + Math.sin(t * 1.6) * 0.014
        body.rotation.z *= 1 - Math.min(1, dt * 8)
      }

      if (!s.grounded) {
        legL.rotation.x = -0.4
        legR.rotation.x = 0.25
        armL.rotation.x = -0.9
        armR.rotation.x = -0.9
      }

      // The strumming arm. A struck note kicks `strumSwing` and it decays,
      // which gives a real follow-through rather than a pose snap.
      if (s.strumming) strumSwing = 1
      strumSwing = Math.max(0, strumSwing - dt * 4.5)
      armL.rotation.x = -0.55 - strumSwing * 0.5
      armL.rotation.z = 0.55 + Math.sin(strumSwing * Math.PI) * 0.7

      if (s.dance) {
        body.rotation.y = Math.sin(t * 8) * 0.35
        hat.position.y = 0.3 + Math.abs(Math.sin(t * 8)) * 0.12
        legL.rotation.x = Math.sin(t * 8) * 0.7
        legR.rotation.x = -Math.sin(t * 8) * 0.7
      } else {
        body.rotation.y *= 1 - Math.min(1, dt * 6)
        hat.position.y += (0.3 - hat.position.y) * Math.min(1, dt * 6)
      }

      // Head bob to the beat, always. He never stops hearing the music.
      head.rotation.z = Math.sin(t * 4.4) * 0.05
      head.rotation.x = Math.sin(t * 2.2) * 0.03

      banjo.update(dt)
      if (s.melt !== undefined) banjo.setMelt(s.melt)
    },
  }
}

// ===========================================================================
// Critters
// ===========================================================================

/**
 * The six musicians of the Giga-Mart. Each is a small pile of primitives with
 * the same interface as Billy Bob, plus an `instrument` group that animates
 * while they play.
 */
export const CRITTERS = [
  {
    id: 'raccoon',
    name: 'Ricky Raccoon',
    blurb: 'Lives in the cereal. Plays a washboard he found in aisle 5.',
    voice: 'tin',
    transpose: 0,
    rounds: [3, 3, 4],
    zone: 'Aisle 1',
    color: 0x8b8f96,
    pos: [-38, 2.6, 12],
    scale: 1.15,
    onPlatform: true,
  },
  {
    id: 'goat',
    name: 'Doris the Goat',
    blurb: 'Ate the garden centre. Sorry about the garden centre.',
    voice: 'twang',
    transpose: 2,
    rounds: [3, 4, 4],
    zone: 'Garden & Patio',
    color: 0xeae4d6,
    pos: [45, 0, -14],
  },
  {
    id: 'penguin',
    name: 'Chilly Pete',
    blurb: 'Has never once left the freezer aisle. Plays icicles.',
    voice: 'glass',
    transpose: 5,
    rounds: [4, 4, 5],
    zone: 'Frosty Foods',
    color: 0x1c2028,
    // On top of a chest freezer, which is at x=-49 — see _buildFreezer.
    pos: [-49, 1.06, 4],
  },
  {
    id: 'pug',
    name: 'Meatball',
    blurb: 'Under the third table. Waiting for a dropped free sample.',
    voice: 'thumpy',
    transpose: -5,
    rounds: [4, 5, 5],
    zone: 'The Hot Rotisserie',
    color: 0xd9b184,
    pos: [43, 0, 26],
    // A pug is genuinely small, and at true scale on a big tiled floor he read
    // as a beige smudge from across the food court. Scale is display-only.
    scale: 1.4,
  },
  {
    id: 'pigeon',
    name: 'Sir Reginald',
    blurb: 'Got in through the roller door in 2019. Very fancy.',
    voice: 'mando',
    transpose: 7,
    rounds: [5, 5, 6],
    zone: 'The Television Wall',
    color: 0x6f7a85,
    pos: [-52, 0, -34],
    scale: 1.7,
  },
  {
    // Big Earl used to hold this seat. He is a vehicle now — see makeForklift —
    // so the Loading Dock needed somebody who could still hold a tune, and the
    // hardest duel in the game with it.
    id: 'owl',
    name: 'Wanda the Warehouse Owl',
    blurb: 'Sleeps in the rafters. Wakes up for a good tune.',
    voice: 'whistle',
    transpose: 12,
    rounds: [5, 6, 6, 7],
    zone: 'The Loading Dock',
    color: 0xa8895e,
    // On the dock floor, not up in her rafters. She is the sixth and last duel
    // and putting her somewhere that needs the flying banjo to reach would make
    // finishing the game depend on finding a mode you can miss.
    pos: [-4, 0, -38],
    scale: 1.5,
    big: true,
  },
]

/** Build the mesh for one critter id. */
export function makeCritter(id) {
  const build = BUILDERS[id]
  if (!build) throw new Error(`unknown critter: ${id}`)
  const rig = build()
  // Every builder piles its static parts straight onto `body`, so one merge
  // here covers all six of them.
  mergeStatic(rig.body)
  rig.group.traverse((o) => { if (o.isMesh) o.castShadow = true })
  return rig
}

/**
 * Shared animation for the small four-legged/two-legged critters: a bounce, an
 * instrument that swings while playing, and eyes that track the player.
 */
function animator(group, opts) {
  const { body, instrument, eyes, extras } = opts
  let t = 0
  let playSwing = 0
  return function update(dt, s = {}) {
    t += dt
    if (s.playing) playSwing = 1
    playSwing = Math.max(0, playSwing - dt * 3)

    // Idle bounce, faster while playing — they're keeping time.
    const rate = s.playing ? 9 : 2.6
    const amp = s.playing ? 0.08 : 0.025
    body.position.y = (opts.baseY || 0) + Math.abs(Math.sin(t * rate)) * amp
    body.rotation.z = Math.sin(t * rate * 0.5) * (s.playing ? 0.1 : 0.03)

    if (instrument) {
      instrument.rotation.z = Math.sin(t * 14) * 0.5 * playSwing
      instrument.position.y = (instrument.userData.baseY || 0) + playSwing * 0.06
    }

    // Look at the player. Pupils only, which is cheap and reads instantly.
    if (eyes && s.lookAt) {
      const local = group.worldToLocal(s.lookAt.clone())
      const yaw = Math.max(-1, Math.min(1, local.x / (Math.abs(local.z) + 2)))
      const pitch = Math.max(-1, Math.min(1, (local.y - 1) / 3))
      for (const p of eyes.pupils) {
        const home = p.userData.home
        p.position.x = home.x + yaw * 0.035
        p.position.y = home.y + pitch * 0.025
      }
    }

    if (extras) extras(dt, t, s, playSwing)
  }
}

const BUILDERS = {
  // --- Ricky Raccoon ------------------------------------------------------
  raccoon() {
    const group = new THREE.Group()
    const body = new THREE.Group()
    body.position.y = 0.42
    group.add(body)

    const fur = mat(0x8b8f96)
    const dark = mat(0x2b2f36)
    const pale = mat(0xd8d5cc)

    body.add(part(G.sphere, fur, [0, 0, 0], [0.5, 0.46, 0.62]))
    const head = part(G.sphere, fur, [0, 0.32, 0.28], [0.4, 0.38, 0.38])
    body.add(head)
    // The mask, which is the entire point of a raccoon.
    body.add(part(G.box, dark, [0, 0.34, 0.44], [0.36, 0.13, 0.08]))
    body.add(part(G.cone, pale, [0, 0.26, 0.46], [0.16, 0.18, 0.16], [Math.PI / 2, 0, 0]))
    body.add(part(G.sphere, dark, [0, 0.26, 0.53], [0.07, 0.06, 0.07]))
    for (const s of [-1, 1]) {
      body.add(part(G.cone, fur, [s * 0.19, 0.56, 0.26], [0.14, 0.16, 0.14]))
    }
    const eyes = makeEyes(0.055, 0.11, 0.35, 0.44)
    body.add(eyes)

    // Ringed tail — five alternating segments on a curve.
    for (let i = 0; i < 5; i++) {
      const seg = part(
        G.sphere, i % 2 ? dark : fur,
        [0, 0.08 + i * 0.11, -0.42 - i * 0.13],
        [0.19 - i * 0.015, 0.19 - i * 0.015, 0.19 - i * 0.015],
      )
      body.add(seg)
    }
    for (const s of [-1, 1]) {
      body.add(part(G.box, dark, [s * 0.24, -0.3, 0.16], [0.13, 0.28, 0.16]))
    }

    // The washboard.
    const instrument = new THREE.Group()
    instrument.position.set(0.34, 0.02, 0.3)
    instrument.userData.baseY = 0.02
    const boardMat = mat(0xc9a86a, { roughness: 0.9 })
    instrument.add(part(G.box, boardMat, [0, 0, 0], [0.34, 0.44, 0.06]))
    for (let i = 0; i < 6; i++) {
      instrument.add(part(
        G.cyl, mat(0xb8bcc2, { metalness: 0.7, roughness: 0.3 }),
        [0, 0.16 - i * 0.06, 0.04], [0.15, 0.02, 0.15], [0, 0, Math.PI / 2],
      ))
    }
    body.add(instrument)

    return { group, body, instrument, update: animator(group, { body, instrument, eyes, baseY: 0.42 }) }
  },

  // --- Doris the Goat -----------------------------------------------------
  goat() {
    const group = new THREE.Group()
    const body = new THREE.Group()
    body.position.y = 0.62
    group.add(body)

    const wool = mat(0xeae4d6, { roughness: 0.95 })
    const horn = mat(0xb9a888, { roughness: 0.7 })
    const hoof = mat(0x3a332c)

    body.add(part(G.sphere, wool, [0, 0, 0], [0.52, 0.5, 0.86]))
    const head = part(G.box, wool, [0, 0.3, 0.55], [0.3, 0.3, 0.42])
    body.add(head)
    body.add(part(G.box, wool, [0, 0.22, 0.78], [0.2, 0.18, 0.2]))
    body.add(part(G.sphere, mat(0x2e2a26), [0, 0.24, 0.88], [0.09, 0.07, 0.06]))
    // Horns, swept back.
    for (const s of [-1, 1]) {
      body.add(part(G.cone, horn, [s * 0.14, 0.5, 0.44], [0.09, 0.36, 0.09], [-0.7, 0, s * 0.2]))
    }
    // Ears.
    for (const s of [-1, 1]) {
      body.add(part(G.box, wool, [s * 0.22, 0.36, 0.5], [0.16, 0.06, 0.12], [0, 0, s * 0.4]))
    }
    // The beard, which is compulsory.
    body.add(part(G.cone, wool, [0, 0.06, 0.72], [0.09, 0.26, 0.09], [Math.PI, 0, 0]))
    const eyes = makeEyes(0.06, 0.14, 0.34, 0.72, 0x2a2620)
    body.add(eyes)

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = part(G.box, wool, [sx * 0.26, -0.42, sz * 0.4], [0.14, 0.5, 0.14])
        body.add(leg)
        body.add(part(G.box, hoof, [sx * 0.26, -0.68, sz * 0.4], [0.16, 0.1, 0.18]))
      }
    }

    // A mouth harp on a stand — she has no hands, so it hovers where a goat
    // would nose at it.
    const instrument = new THREE.Group()
    instrument.position.set(0, 0.24, 0.98)
    instrument.userData.baseY = 0.24
    instrument.add(part(G.box, mat(0xcfd4d9, { metalness: 0.65, roughness: 0.3 }),
      [0, 0, 0], [0.34, 0.09, 0.1]))
    instrument.add(part(G.box, mat(0x7a4a24), [0, -0.05, 0], [0.3, 0.04, 0.11]))
    body.add(instrument)

    return { group, body, instrument, update: animator(group, { body, instrument, eyes, baseY: 0.62 }) }
  },

  // --- Chilly Pete --------------------------------------------------------
  penguin() {
    const group = new THREE.Group()
    const body = new THREE.Group()
    body.position.y = 0.5
    group.add(body)

    const black = mat(0x1c2028, { roughness: 0.7 })
    const white = mat(0xf4f6f8, { roughness: 0.7 })
    const orange = mat(0xf0932b, { roughness: 0.6 })

    body.add(part(G.sphere, black, [0, 0, 0], [0.46, 0.66, 0.42]))
    body.add(part(G.sphere, white, [0, -0.03, 0.14], [0.34, 0.54, 0.3]))
    body.add(part(G.sphere, black, [0, 0.5, 0.02], [0.38, 0.36, 0.36]))
    body.add(part(G.sphere, white, [0, 0.45, 0.16], [0.26, 0.24, 0.22]))
    body.add(part(G.cone, orange, [0, 0.44, 0.28], [0.1, 0.2, 0.1], [Math.PI / 2, 0, 0]))
    const eyes = makeEyes(0.06, 0.11, 0.56, 0.2)
    body.add(eyes)
    // Flippers.
    for (const s of [-1, 1]) {
      body.add(part(G.box, black, [s * 0.42, -0.02, 0], [0.09, 0.44, 0.22], [0, 0, s * 0.25]))
    }
    // Feet.
    for (const s of [-1, 1]) {
      body.add(part(G.box, orange, [s * 0.15, -0.66, 0.1], [0.2, 0.08, 0.3]))
    }
    // A little bobble hat, because it is cold in there.
    body.add(part(G.cyl, mat(0xd94f4f), [0, 0.72, 0.02], [0.36, 0.14, 0.36]))
    body.add(part(G.sphere, mat(0xf4f6f8), [0, 0.84, 0.02], [0.14, 0.14, 0.14]))

    // Icicle chimes.
    const instrument = new THREE.Group()
    instrument.position.set(0.42, 0.1, 0.2)
    instrument.userData.baseY = 0.1
    const ice = new THREE.MeshStandardMaterial({
      color: 0xbfe8f7, transparent: true, opacity: 0.75,
      roughness: 0.15, metalness: 0.1, emissive: 0x2b6d8c, emissiveIntensity: 0.35,
    })
    instrument.add(part(G.box, mat(0x8a8f96, { metalness: 0.6 }), [0, 0.18, 0], [0.36, 0.03, 0.03]))
    for (let i = 0; i < 4; i++) {
      instrument.add(part(G.cone, ice,
        [-0.13 + i * 0.09, 0.02, 0], [0.05, 0.3 - i * 0.04, 0.05], [Math.PI, 0, 0]))
    }
    body.add(instrument)

    return { group, body, instrument, update: animator(group, { body, instrument, eyes, baseY: 0.5 }) }
  },

  // --- Meatball -----------------------------------------------------------
  pug() {
    const group = new THREE.Group()
    const body = new THREE.Group()
    // 0.46, not 0.38: the legs reach 0.45 below the body origin, so at 0.38 his
    // paws were 7cm under the concrete.
    body.position.y = 0.46
    group.add(body)

    const fawn = mat(0xd9b184)
    const black = mat(0x2a2622)

    body.add(part(G.sphere, fawn, [0, 0, 0], [0.5, 0.44, 0.66]))
    body.add(part(G.sphere, fawn, [0, 0.26, 0.42], [0.42, 0.4, 0.38]))
    // The squashed black face.
    body.add(part(G.sphere, black, [0, 0.22, 0.58], [0.28, 0.24, 0.14]))
    body.add(part(G.sphere, black, [0, 0.24, 0.66], [0.1, 0.08, 0.08]))
    const eyes = makeEyes(0.075, 0.13, 0.32, 0.55)
    body.add(eyes)
    // Folded ears.
    for (const s of [-1, 1]) {
      body.add(part(G.box, black, [s * 0.3, 0.42, 0.38], [0.12, 0.2, 0.1], [0.3, 0, s * 0.3]))
    }
    // The curly tail: three shrinking spheres.
    for (let i = 0; i < 3; i++) {
      body.add(part(G.sphere, fawn,
        [0.06 * i, 0.24 + i * 0.06, -0.5 - i * 0.05], [0.12 - i * 0.02, 0.12 - i * 0.02, 0.12 - i * 0.02]))
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        body.add(part(G.box, fawn, [sx * 0.26, -0.3, sz * 0.32], [0.16, 0.3, 0.16]))
      }
    }

    // A squeaky-toy bass: a rubber bone on a broom handle.
    const instrument = new THREE.Group()
    instrument.position.set(0.4, 0.24, 0.1)
    instrument.userData.baseY = 0.24
    instrument.add(part(G.cyl, mat(0xb07a3a), [0, 0.2, 0], [0.04, 0.9, 0.04]))
    instrument.add(part(G.box, mat(0xe85d8a, { roughness: 0.5 }), [0, -0.24, 0], [0.3, 0.12, 0.12]))
    for (const s of [-1, 1]) {
      instrument.add(part(G.sphere, mat(0xe85d8a), [s * 0.16, -0.24, 0], [0.14, 0.14, 0.14]))
    }
    instrument.add(part(G.box, mat(0xf4e9c8), [0, 0.2, 0.03], [0.012, 0.8, 0.012]))
    body.add(instrument)

    return { group, body, instrument, update: animator(group, { body, instrument, eyes, baseY: 0.46 }) }
  },

  // --- Sir Reginald -------------------------------------------------------
  pigeon() {
    const group = new THREE.Group()
    const body = new THREE.Group()
    body.position.y = 0.34
    group.add(body)

    const grey = mat(0x6f7a85)
    const irid = mat(0x4a7a6e, { metalness: 0.4, roughness: 0.35 })
    const orange = mat(0xd98b3a)

    body.add(part(G.sphere, grey, [0, 0, 0], [0.34, 0.34, 0.48]))
    body.add(part(G.sphere, irid, [0, 0.24, 0.12], [0.24, 0.26, 0.24]))
    body.add(part(G.sphere, grey, [0, 0.42, 0.16], [0.26, 0.24, 0.26]))
    body.add(part(G.cone, orange, [0, 0.4, 0.34], [0.06, 0.16, 0.06], [Math.PI / 2, 0, 0]))
    const eyes = makeEyes(0.045, 0.09, 0.46, 0.24, 0xc23b34)
    body.add(eyes)
    // Wings.
    for (const s of [-1, 1]) {
      body.add(part(G.box, grey, [s * 0.3, 0.02, -0.04], [0.07, 0.26, 0.44], [0, 0, s * 0.2]))
    }
    body.add(part(G.box, grey, [0, 0.02, -0.46], [0.3, 0.05, 0.3], [-0.3, 0, 0]))
    for (const s of [-1, 1]) {
      body.add(part(G.cyl, orange, [s * 0.1, -0.34, 0.04], [0.03, 0.2, 0.03]))
    }
    // A tiny top hat. He is very fancy.
    body.add(part(G.cyl, mat(0x1a1a1e), [0, 0.6, 0.14], [0.3, 0.02, 0.3]))
    body.add(part(G.cyl, mat(0x1a1a1e), [0, 0.7, 0.14], [0.17, 0.2, 0.17]))

    // A mandolin, scaled for a bird.
    const instrument = new THREE.Group()
    instrument.position.set(0.3, 0.04, 0.16)
    instrument.userData.baseY = 0.04
    instrument.add(part(G.sphere, mat(0x7a3f1e, { roughness: 0.4 }), [0, 0, 0], [0.24, 0.24, 0.1]))
    instrument.add(part(G.box, mat(0x5a2f16), [0, 0.26, 0], [0.06, 0.34, 0.05]))
    instrument.add(part(G.box, mat(0xd8d2c2), [0, 0.16, 0.05], [0.09, 0.5, 0.01]))
    body.add(instrument)

    return { group, body, instrument, update: animator(group, { body, instrument, eyes, baseY: 0.34 }) }
  },

  // --- Wanda the Warehouse Owl --------------------------------------------
  owl() {
    const group = new THREE.Group()
    const body = new THREE.Group()
    body.position.y = 0.52
    group.add(body)

    const feather = mat(0xa8895e)
    const pale = mat(0xe8dcc0)
    const beakMat = mat(0xe0a83a, { roughness: 0.5 })

    // An owl is mostly head. Exaggerating that is what makes the silhouette
    // read as "owl" from across the loading dock rather than "brown lump".
    body.add(part(G.sphere, feather, [0, 0, 0], [0.86, 0.92, 0.78]))
    body.add(part(G.sphere, pale, [0, -0.12, 0.3], [0.5, 0.6, 0.3]))

    const head = new THREE.Group()
    head.position.set(0, 0.56, 0)
    body.add(head)
    head.add(part(G.sphere, feather, [0, 0, 0], [0.86, 0.76, 0.8]))

    // The facial disc: two pale saucers the eyes sit inside.
    for (const sx of [-1, 1]) {
      head.add(part(G.cyl, pale, [sx * 0.19, 0.02, 0.3],
        [0.42, 0.05, 0.42], [Math.PI / 2, 0, 0]))
    }
    // Enormous eyes. Radius 0.16 against a 0.86-wide head is roughly double
    // what the other critters get, and it is the whole character.
    const eyes = makeEyes(0.16, 0.19, 0.03, 0.34)
    head.add(eyes)
    head.add(part(G.cone, beakMat, [0, -0.12, 0.36], [0.16, 0.24, 0.16], [Math.PI / 2, 0, 0]))

    // Ear tufts, angled outward.
    for (const sx of [-1, 1]) {
      head.add(part(G.cone, feather, [sx * 0.3, 0.36, -0.02],
        [0.18, 0.36, 0.18], [0, 0, -sx * 0.42]))
    }

    // Wings on shoulder pivots, so she can mantle them while she plays.
    const wings = []
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group()
      pivot.position.set(sx * 0.42, 0.12, 0)
      pivot.add(part(G.sphere, feather, [sx * 0.1, -0.28, 0], [0.26, 0.7, 0.42]))
      body.add(pivot)
      wings.push(pivot)
      pivot.userData.side = sx
    }

    // Talons.
    for (const sx of [-1, 1]) {
      body.add(part(G.box, beakMat, [sx * 0.2, -0.5, 0.1], [0.18, 0.1, 0.3]))
    }

    // A slide whistle made out of a mailing tube. The plunger really slides:
    // it is the one part of the instrument that moves, and it moves on its own
    // transform, so it stays out of the static merge.
    const instrument = new THREE.Group()
    instrument.position.set(0.62, 0.1, 0.32)
    instrument.userData.baseY = 0.1
    instrument.add(part(G.cyl, mat(0xc9a06a, { roughness: 0.8 }),
      [0, 0, 0], [0.16, 0.9, 0.16], [0, 0, -Math.PI / 2]))
    instrument.add(part(G.cyl, mat(0xd8d2c2, { roughness: 0.5 }),
      [-0.5, 0, 0], [0.1, 0.14, 0.1], [0, 0, -Math.PI / 2]))
    const plunger = part(G.box, mat(0x8a6a44), [0.5, 0, 0], [0.3, 0.07, 0.07])
    plunger.userData.animated = true
    instrument.add(plunger)
    body.add(instrument)

    const baseAnim = animator(group, { body, instrument, eyes, baseY: 0.52 })

    return {
      group, body, instrument,
      update(dt, s = {}) {
        baseAnim(dt, s)
        // The plunger runs in and out while she plays, and parks when she stops.
        const t = (plunger.userData.t = (plunger.userData.t || 0) + dt)
        plunger.position.x = s.playing ? 0.5 + Math.sin(t * 7) * 0.16 : 0.5
        for (const w of wings) {
          const flare = s.playing ? 0.5 + Math.sin(t * 6) * 0.25 : 0.06
          w.rotation.z = -w.userData.side * flare
        }
      },
    }
  },
}

// ===========================================================================
// The flying banjo
// ===========================================================================

/**
 * The banjo, with wings, for when it is flying on its own.
 *
 * A separate object from the one on the player's back rather than the same mesh
 * reparented: the held banjo droops with the melt meter and is welded into the
 * strum animation, and borrowing it would leave the player visibly unarmed and
 * the melt indicator pointing at a thing on the far side of the store. This one
 * is a copy that can be flown without touching any of that.
 */
export function makeFlyingBanjo() {
  const group = new THREE.Group()
  const banjo = makeBanjo()
  // Laid back so the drum head faces up and the neck trails behind, like the
  // nose of a small aeroplane.
  banjo.group.rotation.set(-1.15, 0, 0)
  banjo.group.scale.setScalar(0.85)
  group.add(banjo.group)

  // Two wings on pivots at the pot. Translucent and faintly glowing, because
  // this is the magic-chocolate part of the game and it should not read as an
  // aircraft.
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0xffe6a8, emissive: 0xffc35a, emissiveIntensity: 0.9,
    roughness: 0.3, transparent: true, opacity: 0.72, side: THREE.DoubleSide,
  })
  const wings = []
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group()
    pivot.position.set(s * 0.24, 0.08, 0)
    const w = part(G.sphere, wingMat, [s * 0.5, 0, -0.05], [1.0, 0.08, 0.5])
    w.castShadow = false
    pivot.add(w)
    pivot.userData.side = s
    group.add(pivot)
    wings.push(pivot)
  }

  // A soft light so it lights the shelf it is hovering next to. This is the
  // only reason you can see what you are collecting up near an 8m rack.
  const glow = new THREE.PointLight(0xffd27a, 2.2, 9, 2)
  group.add(glow)

  let t = 0
  return {
    group,
    banjo,
    /**
     * @param {number} dt
     * @param {object} s `{ speed, climb }` — both only drive the animation.
     */
    update(dt, s = {}) {
      t += dt
      const beat = 14 + (s.speed || 0) * 0.9
      const flap = Math.sin(t * beat)
      for (const w of wings) {
        w.rotation.z = -w.userData.side * (0.5 + flap * 0.55)
        w.rotation.x = flap * 0.12
      }
      // Bank into a turn and nose up when climbing, so it reads as flying
      // rather than sliding along an invisible rail.
      group.rotation.z = -clampNum(s.turn || 0, -1, 1) * 0.5
      group.rotation.x = clampNum(s.climb || 0, -1, 1) * -0.22
      glow.intensity = 1.9 + Math.abs(flap) * 0.7
      banjo.update(dt)
    },
    dispose() {
      glow.dispose?.()
    },
  }
}

// ===========================================================================
// Big Earl, the forklift
// ===========================================================================

/** How far above its parked height the fork carriage can travel, in metres. */
export const FORK_LIFT_RANGE = 4.6

/**
 * Big Earl. He used to be the sixth critter; now he is the thing you drive.
 *
 * Two structural notes:
 *
 *  * The forks are on their own `carriage` Group that slides up the mast, so
 *    the lift is one Y assignment rather than moving four meshes in step. That
 *    group is also what Game reads to build the moving platform a second player
 *    can stand on — `carriage.getWorldPosition` is the authority for where the
 *    forks actually are, so the collision box can never drift from the picture.
 *
 *  * He is built FACING +Z with the mast and forks at his BACK, which is how he
 *    was drawn as a critter, and the googly eyes are on the counterweight. That
 *    is deliberate and it is the joke: Earl always reverses toward you, beeping.
 *    Driving does not change it — pushing the stick forward drives the way the
 *    eyes are looking, so a child steers the face, and the forks follow behind.
 */
export function makeForklift() {
  const group = new THREE.Group()
  const body = new THREE.Group()
  body.position.y = 0.7
  group.add(body)

  const orange = mat(0xe8891e, { roughness: 0.55, metalness: 0.25 })
  const dark = mat(0x2b2f36, { roughness: 0.6 })
  const steel = mat(0x9aa2a8, { metalness: 0.7, roughness: 0.35 })

  body.add(part(G.box, orange, [0, 0, 0], [1.5, 0.9, 2.2]))
  // The seat. A driver is parented here, so it is a real position and not a
  // decorative panel.
  body.add(part(G.box, dark, [0, 0.5, 0.5], [1.2, 0.14, 0.9]))

  // Overhead guard.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      body.add(part(G.box, steel, [sx * 0.62, 0.9, 0.3 + sz * 0.55], [0.09, 1.5, 0.09]))
    }
  }
  body.add(part(G.box, steel, [0, 1.68, 0.3], [1.4, 0.1, 1.3]))

  // Mast rails: static, and tall enough to justify the travel.
  const mast = new THREE.Group()
  mast.position.set(0, 0, -1.14)
  body.add(mast)
  for (const s of [-1, 1]) {
    mast.add(part(G.box, steel, [s * 0.42, 1.9, 0], [0.14, 6.2, 0.16]))
  }
  mast.add(part(G.box, steel, [0, 4.98, 0], [1.0, 0.14, 0.18]))

  // The carriage: backplate plus the two forks, all of it sliding as one.
  const carriage = new THREE.Group()
  carriage.position.set(0, -0.42, 0)
  carriage.userData.animated = true
  mast.add(carriage)
  carriage.add(part(G.box, steel, [0, 0.34, 0.02], [1.0, 0.8, 0.1]))
  for (const s of [-1, 1]) {
    carriage.add(part(G.box, steel, [s * 0.42, 0, -0.46], [0.16, 0.09, 1.1]))
  }
  // A deck laid across the forks. Without it a player standing on Earl is
  // balancing on two 16cm bars, and the platform they are actually riding is a
  // solid box — the picture has to match the collision or it reads as a bug.
  carriage.add(part(G.box, mat(0xc8873a, { roughness: 0.9 }), [0, 0.07, -0.5], [1.2, 0.06, 1.0]))

  // Wheels, on pivots so they can spin with the drive.
  const wheels = []
  for (const sx of [-1, 1]) {
    for (const [sz, r] of [[-0.8, 0.42], [0.75, 0.3]]) {
      const w = part(G.cyl, dark,
        [sx * 0.74, -0.46 + (r - 0.42), sz], [r * 2, 0.24, r * 2], [0, 0, Math.PI / 2])
      w.userData.animated = true
      body.add(w)
      wheels.push(w)
    }
  }

  const eyes = makeEyes(0.24, 0.4, 0.34, 1.14)
  body.add(eyes)
  body.add(makeSmile(0.42, -0.1, 1.16, 0x1a1a1e))

  const beacon = part(G.sphere, new THREE.MeshStandardMaterial({
    color: 0xffa726, emissive: 0xff8000, emissiveIntensity: 2, roughness: 0.3,
  }), [0, 1.82, 0.3], [0.18, 0.2, 0.18])
  beacon.userData.animated = true
  body.add(beacon)

  // The air horn is still bolted on. It is the horn now, not an instrument.
  const horn = new THREE.Group()
  horn.position.set(0.9, 0.7, 0.2)
  horn.add(part(G.cone, mat(0xd4b23a, { metalness: 0.7, roughness: 0.25 }),
    [0, 0, 0], [0.34, 0.7, 0.34], [0, 0, -Math.PI / 2]))
  horn.add(part(G.cyl, steel, [-0.4, 0, 0], [0.1, 0.3, 0.1], [0, 0, Math.PI / 2]))
  body.add(horn)

  mergeStatic(mast)
  mergeStatic(carriage)
  mergeStatic(body)
  group.traverse((o) => { if (o.isMesh) o.castShadow = true })

  let t = 0
  /** Metres the carriage is raised above its parked position. */
  let lift = 0

  return {
    group, body, mast, carriage, wheels, eyes, beacon,

    /** Where the forks are, in the carriage's own space, before the lift. */
    forkRestY: -0.42,

    get lift() { return lift },

    /**
     * @param {number} dt
     * @param {object} s `{ speed, steer, lift, driven }`
     *   `lift` is the wanted carriage height in metres, 0..FORK_LIFT_RANGE.
     */
    update(dt, s = {}) {
      t += dt
      if (s.lift !== undefined) lift = clampNum(s.lift, 0, FORK_LIFT_RANGE)
      carriage.position.y = this.forkRestY + lift

      // Wheels roll at the speed the body is actually moving.
      const spin = (s.speed || 0) * dt * 2.4
      for (const w of wheels) w.rotation.x += spin

      // The beacon turns whenever Earl is awake. Parked, it idles slowly, which
      // is what makes him findable across a dark loading dock.
      beacon.rotation.y += dt * (s.driven ? 9 : 3)
      beacon.material.emissiveIntensity =
        1.2 + Math.abs(Math.sin(t * (s.driven ? 6 : 2.4))) * 2.2

      // The eyes look where he is going, which is backwards. Of course.
      for (const p of eyes.pupils) {
        const home = p.userData.home
        p.position.x = home.x + clampNum((s.steer || 0), -1, 1) * 0.05
      }
    },
  }
}

/** Local clamp: MathUtils is not imported here and one number does not earn it. */
function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// ===========================================================================
// Pickups
// ===========================================================================

/** A chocolate chip: the collectible. Spins and bobs. */
export function makeChip() {
  const g = new THREE.Group()
  const chip = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.34, 7),
    new THREE.MeshStandardMaterial({
      color: 0x4a2a15, roughness: 0.35, metalness: 0.1,
      emissive: 0x2a1508, emissiveIntensity: 0.5,
    }),
  )
  chip.castShadow = true
  g.add(chip)
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.32, 0.03, 6, 16),
    new THREE.MeshBasicMaterial({ color: 0xffc266, transparent: true, opacity: 0.7 }),
  )
  halo.rotation.x = Math.PI / 2
  g.add(halo)
  return g
}

/** An ice pop: cools the banjo down instantly. */
export function makeIcePop() {
  const g = new THREE.Group()
  const pop = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.5, 0.12),
    new THREE.MeshStandardMaterial({
      color: 0x6fd0f0, roughness: 0.2, metalness: 0.05,
      emissive: 0x2b8db0, emissiveIntensity: 0.8, transparent: true, opacity: 0.9,
    }),
  )
  pop.position.y = 0.16
  pop.castShadow = true
  g.add(pop)
  const stick = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.24, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 0.9 }),
  )
  stick.position.y = -0.16
  g.add(stick)
  return g
}

/** A free sample on a toothpick. Restores a bit of pep. */
export function makeFreeSample() {
  const g = new THREE.Group()
  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.13, 0.16, 10),
    new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.8 }),
  )
  g.add(cup)
  const food = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xc9743a, roughness: 0.7 }),
  )
  food.position.y = 0.1
  food.castShadow = true
  g.add(food)
  const pick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.34, 4),
    new THREE.MeshStandardMaterial({ color: 0xe8dcc0 }),
  )
  pick.position.y = 0.2
  g.add(pick)
  return g
}
