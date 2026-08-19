// game/Game.js — the machine that runs everything.
//
// Owns the renderer, the scene, the mode state machine and the entity lists.
// Modes are: title -> join -> play <-> duel/pvp, play -> pause, play -> finale.
//
// The one structural rule, unchanged: Player, Duel, Store, Forklift and HUD know
// nothing about each other. Everything they need to say passes through here.
// That is what makes the duel testable on its own, what kept the melt mechanic
// from leaking into six files, and what made co-op an addition rather than a
// rewrite.
//
// CO-OP, IN THREE SENTENCES.
//   * Split-screen is two Players, two cameras and two viewport rectangles. The
//     store, the chips and the band are shared; the melt meter, the camera and
//     the flying banjo are per-player.
//   * Online is one local Player per browser plus a RemotePlayer for each peer,
//     fed by NetClient. The host owns the shared world; everything else is
//     interpolated from the wire.
//   * They are an either/or on the join screen, on purpose. Two local players
//     sharing one socket would need two seats in the room and two outbound
//     streams, and nobody has asked for four children on two televisions.
//
// A duel — with a critter or with another player — takes the whole screen and
// un-splits it. It is a shared moment: the other player watches, and can strum
// along without scoring. That is both nicer to watch and enormously simpler than
// running two independent duel state machines side by side.

import * as THREE from 'three'
import { Input } from '../core/Input.js'
import { Audio } from '../core/Audio.js'
import { Store, STORE, POINTS } from '../world/Store.js'
import { Player } from './Player.js'
import { RemotePlayer } from './RemotePlayer.js'
import { Duel, DUEL_STATE } from './Duel.js'
import { PvpDuel, PVP_STATE } from './PvpDuel.js'
import { Forklift, FORKLIFT_RANGE } from './Forklift.js'
import { FLIGHT } from './FlyingBanjo.js'
import { HUD } from './HUD.js'
import { CRITTERS, makeCritter, PLAYER_SKINS } from '../chars/Rigs.js'
import { InstancePool } from '../world/Batch.js'
import { rng, rangeFrom } from '../core/Rng.js'
import { MobileShell, isTouchDevice } from '../core/touch.js'
import { NetClient } from '../net/NetClient.js'
import { damp } from '../core/MathUtils.js'

const MODE = {
  TITLE: 'title',
  JOIN: 'join',
  PLAY: 'play',
  DUEL: 'duel',
  PVP: 'pvp',
  PAUSE: 'pause',
  FINALE: 'finale',
}

/** How the people playing are connected to each other. */
export const SESSION = {
  SOLO: 'solo',
  SPLIT: 'split',
  ONLINE: 'online',
}

/** How close you must be to a critter to start a duel. */
const TALK_RANGE = 4.2
const PICKUP_RANGE = 1.5
/** How close two players must be to duel each other. Tighter than a critter:
 *  brushing past somebody must not start a duel neither of them asked for. */
const PVP_RANGE = 3.2
/** Where Big Earl is parked: the open strip of the loading dock. */
const FORKLIFT_SPOT = { x: -14, z: -37 }

export class Game {
  constructor(canvas) {
    this.canvas = canvas
    this.mode = MODE.TITLE
    this.elapsed = 0
    this._raf = null
    this._last = 0
    this._disposed = false

    // Quality. A phone gets fewer props, no shadows and a capped pixel ratio;
    // decided once, here, before a single mesh is built.
    const q = new URLSearchParams(location.search)
    this.touch = isTouchDevice()
    this.quality = q.get('quality') || (this.touch ? 'low' : 'high')

    /** Session shape. Chosen on the join screen, or forced by the URL. */
    this.session = SESSION.SOLO

    /** @type {Player[]} everybody on this machine. */
    this.localPlayers = []
    /** @type {RemotePlayer[]} everybody else. */
    this.remotes = []
    /** Rebuilt whenever membership changes; NetClient reads it. */
    this._playerList = []
    /** One camera per local player. */
    this.cameras = []
    this.viewportCount = 1

    /** `{ [critterId]: { won, star } }` — shared by everybody in the game. */
    this.band = {}
    this.chips = 0

    // A lobby launch carries the room code, the player's name and the seed that
    // makes every client scatter the identical chocolate chips.
    const room = (q.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
    this.urlRoom = room.length === 4 ? room : null
    this.urlName = q.get('name') || null
    this.seed = Number(q.get('seed')) || 0xbb7
    this.rand = rng(this.seed)

    this.net = new NetClient(this)
    this._wireNet()
  }

  /**
   * Everybody in the game, local first.
   *
   * NetClient walks this looking for the first entry with `isLocal !== false` to
   * decide whose position to broadcast, so the ordering is load-bearing: a
   * remote peer ahead of the local player would put somebody else's coordinates
   * on the wire under our name.
   */
  get players() {
    return this._playerList
  }

  _refreshPlayerList() {
    this._playerList = this.localPlayers.concat(this.remotes)
  }

  /**
   * The shared world, as the host publishes it and a client applies it.
   *
   * Handed to NetClient as `ctx.world`. Deliberately small: positions are their
   * owners' business, and everything here is something that must not disagree
   * between two screens — how many chips are in the jar, which ones are still on
   * the floor, and who is in the band.
   */
  get world() {
    return this._worldView || (this._worldView = {
      getNetState: () => ({
        chips: this.chips,
        taken: this.pickups.reduce((acc, p, i) => { if (p.taken) acc.push(i); return acc }, []),
        band: this.band,
        fork: {
          driver: this.forklift && this.forklift.driver ? this.net.id : -1,
          x: this.forklift ? this.forklift.pos.x : 0,
          z: this.forklift ? this.forklift.pos.z : 0,
          h: this.forklift ? this.forklift.heading : 0,
          l: this.forklift ? this.forklift.lift : 0,
        },
      }),
      applyNetState: (s) => this._applyWorld(s),
    })
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Build the world, yielding to the browser between steps so the boot screen
   * actually repaints. Doing this in one synchronous block is the classic way
   * to ship a game that looks frozen for four seconds on a mid-range phone.
   *
   * @param {(frac: number, msg: string) => void} onProgress
   */
  async boot(onProgress = () => {}) {
    const yieldFrame = () => new Promise((r) => requestAnimationFrame(() => r()))

    onProgress(0.02, 'Waking up the renderer…')
    this._initRenderer()
    await yieldFrame()

    this.store = new Store(this.scene, { quality: this.quality })
    const steps = this.store.buildSteps()
    for (let i = 0; i < steps.length; i++) {
      const [msg, fn] = steps[i]
      onProgress(0.05 + (i / steps.length) * 0.75, msg)
      await yieldFrame()
      fn()
    }

    onProgress(0.82, 'Finding the critters…')
    await yieldFrame()
    this._initEntities()

    onProgress(0.9, 'Starting the forklift…')
    await yieldFrame()
    this.forklift = new Forklift(this.scene, this.store, this.audio, FORKLIFT_SPOT)

    onProgress(0.94, 'Scattering the chocolate chips…')
    await yieldFrame()
    this._initPickups()

    onProgress(0.97, 'Tuning up…')
    await yieldFrame()
    this.hud = new HUD()
    this._wireUI()

    // Render one real frame BEFORE the boot screen comes down. A frozen page
    // shows the last thing it PAINTED, so handing over to a black canvas is
    // indistinguishable from a crash.
    this.renderer.render(this.scene, this.cameras[0])
    onProgress(1, 'Ready!')
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1.5 : 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight, false)
    this.renderer.shadowMap.enabled = this.quality !== 'low'
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0xb9bec4)

    // Two cameras, built up front. The second is idle in every mode but
    // split-screen, and an idle PerspectiveCamera costs nothing.
    for (let i = 0; i < 2; i++) {
      const cam = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 300)
      cam.position.set(0, 6, 30)
      this.cameras.push(cam)
    }
    /** The camera for anything that is not split — the title, a duel, the show. */
    this.camera = this.cameras[0]

    this.input = new Input()
    this.audio = new Audio()

    if (this.touch) {
      this.shell = new MobileShell({
        title: 'Turn your phone sideways',
        body: 'Billy Bob Joe Bob is played in landscape.',
        fullscreenTarget: document.documentElement,
      })
    }

    this._onResize = () => this._resize()
    window.addEventListener('resize', this._onResize)
    window.addEventListener('orientationchange', this._onResize)
  }

  _resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setSize(w, h, false)
    this._applyAspects()
  }

  /** Each camera's aspect depends on how tall its viewport is. */
  _applyAspects() {
    const w = window.innerWidth
    const h = window.innerHeight
    const n = this.viewportCount
    for (let i = 0; i < this.cameras.length; i++) {
      this.cameras[i].aspect = w / (n > 1 ? h / 2 : h)
      this.cameras[i].updateProjectionMatrix()
    }
  }

  _initEntities() {
    // Player 1 always exists. Player 2 is built the moment a session that needs
    // one is chosen, because building a rig nobody will drive costs a merge, a
    // banjo and a flying banjo for nothing.
    this.localPlayers = [this._makeLocalPlayer(0)]
    this.player = this.localPlayers[0]
    this._refreshPlayerList()

    // Critters.
    this.critters = CRITTERS.map((def) => {
      const rig = makeCritter(def.id)
      // Display-only scale. A pug and a pigeon at true size are almost
      // invisible from across a warehouse, and finding them is the game.
      if (def.scale) rig.group.scale.setScalar(def.scale)
      const pos = new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2])
      // Snap onto whatever is underneath, so a hand-typed Y can never leave
      // somebody hovering.
      pos.y = Math.max(pos.y, this.store.groundHeight(pos.x, pos.z, pos.y + 2))
      rig.group.position.copy(pos)
      rig.group.rotation.y = Math.atan2(POINTS.spawn.x - pos.x, POINTS.spawn.z - pos.z)
      this.scene.add(rig.group)

      // The quest marker: a slowly spinning cone pointing down at them.
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.34, 0.8, 5),
        new THREE.MeshBasicMaterial({ color: 0xf5d130 }),
      )
      marker.rotation.x = Math.PI
      marker.position.set(pos.x, pos.y + (def.big ? 3.4 : 2.1), pos.z)
      this.scene.add(marker)

      return {
        def, rig, marker, pos,
        home: pos.clone(),
        won: false,
        star: false,
        onStage: false,
        stageTarget: null,
      }
    })

    this._confetti = new Confetti(this.scene, this.quality === 'low' ? 120 : 260)
  }

  /** Build one local Player and wire the things Game owns for it. */
  _makeLocalPlayer(slot) {
    const p = new Player(this.scene, this.store, this.audio, { slot, skin: slot })
    p.onMelted = () => {
      this.hud.toast(`🍫 ${this.localPlayers.length > 1 ? p.name + '’s' : 'Your'} banjo melted! Chilly Pete re-froze it.`, 3200)
    }
    // Every player can stand on Big Earl's forks. The forklift may not exist yet
    // at boot, so this is topped up in _beginSession too.
    if (this.forklift) p.groundProviders.push(this.forklift)
    // Spread the spawns so two players do not start inside each other.
    if (slot > 0) {
      p.pos.x += slot * 2.2
      p.group.position.copy(p.pos)
    }
    return p
  }

  // -------------------------------------------------------------------------
  // Sessions: solo, split-screen, online
  // -------------------------------------------------------------------------

  _wireUI() {
    // Title -> the join screen. There is no longer a single PLAY button that
    // drops you straight into the store, because "who is playing" has to be
    // answered before any player exists.
    this.hud.playBtn.addEventListener('click', () => this._showJoin())
    this.hud.backTitleBtn.addEventListener('click', () => {
      this.hud.showJoin(false)
      this.hud.showTitle(true)
      this.mode = MODE.TITLE
    })

    const modeButtons = [this.hud.joinSolo, this.hud.joinSplit, this.hud.joinOnline]
    modeButtons.forEach((b, i) => {
      // Hovering moves the pad highlight as well, so the mouse and the
      // controller never disagree about what is selected.
      b.addEventListener('mouseenter', () => this.hud.setJoinSelection(i))
      b.addEventListener('click', () => this._pickJoin(i))
    })
    this.hud.hostBtn.addEventListener('click', () => this._hostOnline())
    this.hud.joinCodeBtn.addEventListener('click', () => this._joinOnline(this.hud.typedCode))
    this.hud.joinCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinOnline(this.hud.typedCode)
    })

    this.hud.resumeBtn.addEventListener('click', () => this._setMode(MODE.PLAY))
    this.hud.againBtn.addEventListener('click', () => {
      this.hud.showFinale(false)
      this._setMode(MODE.PLAY)
      this.audio.setMusic('store', { intensity: 1 })
      // Send everybody home so the store is playable again after the show.
      for (const c of this.critters) {
        c.onStage = false
        c.rig.group.position.copy(c.home)
      }
    })
    this.hud.showTitle(true)
    this.hud.setPlayVisible(false)
    this.hud.setBand(this.band)
    this.hud.setRoster(this.band)
  }

  /** Act on one of the three mode buttons, whichever input picked it. */
  _pickJoin(i) {
    this.hud.setJoinSelection(i)
    if (i === 0) this._beginSession(SESSION.SOLO)
    else if (i === 1) this._beginSession(SESSION.SPLIT)
    else {
      this.hud.showOnlineBox(true)
      this.hud.setNetMessage('Make a game and read the code out, or type the one you were given.')
    }
  }

  _showJoin() {
    this.mode = MODE.JOIN
    this.hud.showTitle(false)
    this.hud.showJoin(true)
    // Arriving from the lobby with a room code in the URL: skip the choosing and
    // dial straight in, because the choice was already made on the other page.
    if (this.urlRoom) {
      this.hud.showOnlineBox(true)
      this.hud.joinCodeInput.value = this.urlRoom
      this._joinOnline(this.urlRoom, { create: true })
    }
  }

  async _hostOnline() {
    this.hud.setNetMessage('Opening a game…')
    try {
      await this.audio.unlock()
      const code = await this.net.host(this.urlName || 'Billy Bob', PLAYER_SKINS[0].id)
      this.hud.setRoomCode(code)
      this.hud.setNetMessage('Tell your friend this code. Starting…')
      this._beginSession(SESSION.ONLINE)
    } catch (err) {
      this.hud.setNetMessage(err.message || 'Could not open a game.', true)
    }
  }

  /**
   * @param {string} code
   * @param {{create?: boolean}} [opts] `create` opens the room if it is not
   *   there yet — see NetClient.join. Only ever set for a lobby launch, where
   *   everybody dials the same code at the same moment.
   */
  async _joinOnline(code, opts = {}) {
    if (!code || code.length !== 4) {
      this.hud.setNetMessage('A game code is four letters, like BANJ.', true)
      return
    }
    this.hud.setNetMessage(`Looking for game ${code}…`)
    try {
      await this.audio.unlock()
      // A placeholder look for the handshake. The real one is dealt from the
      // seat the server gives us, in _beginSession — which is what makes four
      // players four visibly different people without anybody having to choose,
      // and it cannot be decided before the server has said which seat we got.
      const room = await this.net.join(code, PLAYER_SKINS[0].id, opts)
      this.hud.setRoomCode(room || code)
      this.hud.setNetMessage('You are in! Starting…')
      this._beginSession(SESSION.ONLINE)
    } catch (err) {
      this.hud.setNetMessage(err.message || 'Could not join that game.', true)
    }
  }

  /**
   * Commit to a session shape and start playing.
   *
   * The only place local players are created, viewports are set and the second
   * keyboard half is armed — so there is exactly one path from "who is playing"
   * to a running game, whichever button got us here.
   */
  async _beginSession(session) {
    this.session = session

    // Split-screen is the only mode with a second body on this machine.
    if (session === SESSION.SPLIT && this.localPlayers.length < 2) {
      this.localPlayers.push(this._makeLocalPlayer(1))
    } else if (session !== SESSION.SPLIT && this.localPlayers.length > 1) {
      for (let i = 1; i < this.localPlayers.length; i++) this._disposeLocalPlayer(this.localPlayers[i])
      this.localPlayers.length = 1
    }
    this._refreshPlayerList()

    // Online seats are dealt by the server, so our own look follows our index.
    if (session === SESSION.ONLINE && this.net.enabled) {
      const skin = PLAYER_SKINS[this.net.index % PLAYER_SKINS.length]
      if (skin.id !== this.player.skin.id) this._reskinLocal(0, skin.id)
    }

    for (const p of this.localPlayers) {
      p.groundProviders.length = 0
      p.groundProviders.push(this.forklift)
    }

    this.viewportCount = session === SESSION.SPLIT ? 2 : 1
    this._applyAspects()
    this.input.enableSecondKeyboard(session === SESSION.SPLIT)

    this.hud.setViewports(this.viewportCount)
    for (let i = 0; i < 2; i++) {
      const p = this.localPlayers[i]
      if (p) this.hud.setPlayerIdentity(i, p.name, p.skin.accent)
      this.hud.setPlayerVisible(i, !!p)
    }

    await this._startPlay()
  }

  /** Swap a local player's look, keeping their position and meters. */
  _reskinLocal(i, skinId) {
    const old = this.localPlayers[i]
    if (!old) return
    const fresh = new Player(this.scene, this.store, this.audio, {
      slot: old.slot, skin: skinId,
    })
    fresh.pos.copy(old.pos)
    fresh.facing = old.facing
    fresh.camYaw = old.camYaw
    fresh.onMelted = old.onMelted
    this._disposeLocalPlayer(old)
    this.localPlayers[i] = fresh
    if (i === 0) this.player = fresh
    this._refreshPlayerList()
  }

  _disposeLocalPlayer(p) {
    if (!p) return
    this.scene.remove(p.group)
    p.flight.dispose()
  }

  async _startPlay() {
    // The click that got us here is the user gesture every browser demands
    // before an AudioContext will run, and the only one we are guaranteed to
    // get. Unlocking anywhere else is how a game ships silent.
    await this.audio.unlock()
    if (this.shell) this.shell.armImmersive()

    this.hud.showTitle(false)
    this.hud.showJoin(false)
    this._setMode(MODE.PLAY)
    this.audio.setMusic('store', { intensity: 0.5 })
    this.audio.paChime()

    if (this.session === SESSION.SPLIT) {
      this.hud.toast('🪕🪕 Two players! Press X on each other to duel.', 5000)
    } else if (this.session === SESSION.ONLINE) {
      this.hud.toast(`🌐 Game code ${this.net.roomCode || '????'} — tell your friends!`, 6000)
    } else {
      this.hud.toast('🪕 Find a critter and press X to duel!', 4200)
    }
  }

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  _wireNet() {
    this.net.onPeerJoin((peer) => {
      const avatar = new RemotePlayer(this.scene, peer)
      peer.player = avatar
      this.remotes.push(avatar)
      this._refreshPlayerList()
      if (this.hud) this.hud.toast(`👋 ${avatar.name} joined!`, 2600)
    })

    this.net.onPeerLeave((peer) => {
      const avatar = peer.player
      if (!avatar) return
      const i = this.remotes.indexOf(avatar)
      if (i >= 0) this.remotes.splice(i, 1)
      avatar.dispose()
      peer.player = null
      this._refreshPlayerList()
      // A duel with somebody who just closed their laptop has to end, or the
      // other player sits waiting for a note that is never coming.
      if (this.pvp && this.pvp.remotePeerId === peer.id) this._endPvp('left')
      if (this.hud) this.hud.toast(`${avatar.name} left.`, 2600)
    })

    this.net.onStatus((s) => {
      if (!this.hud) return
      if (s === 'offline') {
        this.hud.setNetStatus('Lost the connection — playing on alone', '#ef7a3a')
      } else if (s === 'online' || s === 'host') {
        this.hud.setNetStatus(`${this.net.roomCode || ''} · ${this.remotes.length + 1} playing`)
      }
    })

    this.net.onEvent((type, data, from) => this._onNetEvent(type, data, from))
  }

  _onNetEvent(type, d, from) {
    switch (type) {
      case 'duelWon':
        // Somebody else beat a critter. The band is shared, so it counts here.
        this._recordBandWin(d.id, d.star, false)
        break

      case 'chip': {
        // Relayed the instant it is taken rather than waiting for the 5 Hz world
        // snapshot, so two players cannot both collect the same chip.
        //
        // The count goes up HERE as well as at the collector's end. The jar is
        // shared, and the host is the one who publishes the total: without this
        // the host never counts anybody else's chips and then overwrites the
        // whole room with its own lower number twice a second.
        const item = this.pickups[d.i]
        if (item && !item.taken && item.kind === 'chip') this.chips++
        this._takePickup(d.i, false)
        break
      }

      case 'pvpStart':
        if (d && d.target === this.net.id) this._acceptPvp(from)
        break

      case 'pvpNote':
        if (this.pvp) this.pvp.pressNote(d.side, d.note, true)
        break

      case 'pvpEnd':
        if (this.pvp) this._endPvp('left')
        break

      case 'horn':
        this.audio.pluck(43, { voice: 'horn', gain: 0.6 })
        break

      default:
        break
    }
  }

  /** A world snapshot from the host. */
  _applyWorld(s) {
    if (!s) return
    if (typeof s.chips === 'number') this.chips = s.chips
    if (Array.isArray(s.taken)) {
      for (const i of s.taken) this._takePickup(i, false)
    }
    if (s.band) {
      for (const id of Object.keys(s.band)) {
        if (!this.band[id]) this._recordBandWin(id, s.band[id].star, false)
      }
    }
    // Big Earl, when nobody local is driving him. A driver's own 20 Hz state
    // wins over this — see _applyRemoteForklift.
    if (s.fork && this.forklift && !this.forklift.driver && s.fork.driver < 0) {
      this.forklift.applyNetState({ fx: s.fork.x, fz: s.fork.z, fh: s.fork.h, fl: s.fork.l })
    }
  }

  /** Let whichever peer is driving Big Earl move him on our screen. */
  _applyRemoteForklift() {
    if (!this.forklift || this.forklift.driver) return
    for (const peer of this.net.peers) {
      const st = peer.state
      if (st && st.fork === peer.id) {
        this.forklift.applyNetState(st)
        return
      }
    }
  }

  _initPickups() {
    this.pickups = []
    const r = this.rand

    // One pool per distinct primitive. `PICKUP_PARTS` is the recipe for each
    // kind: the pools it fills, and the local offset/scale of each piece.
    const pools = this._pools = {
      // Dark chocolate on grey concrete is close to invisible from standing
      // height, which for the game's only collectible is fatal. The chip is
      // lifted toward milk chocolate, given real emissive, and sat inside a
      // fat bright halo — the halo is what actually reads across an aisle.
      chip: new InstancePool(this.scene,
        new THREE.ConeGeometry(0.26, 0.4, 7),
        new THREE.MeshStandardMaterial({
          color: 0x7a4620, roughness: 0.3, metalness: 0.1,
          emissive: 0x8a5020, emissiveIntensity: 0.9,
        }), 200),
      chipHalo: new InstancePool(this.scene,
        new THREE.TorusGeometry(0.38, 0.055, 6, 16).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: 0xffd27a, transparent: true, opacity: 0.85, toneMapped: false,
        }), 200),
      pop: new InstancePool(this.scene,
        new THREE.BoxGeometry(0.26, 0.5, 0.12),
        new THREE.MeshStandardMaterial({
          color: 0x6fd0f0, roughness: 0.2, emissive: 0x2b8db0,
          emissiveIntensity: 0.8, transparent: true, opacity: 0.9,
        }), 32),
      popStick: new InstancePool(this.scene,
        new THREE.BoxGeometry(0.07, 0.24, 0.05),
        new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 0.9 }), 32),
      sampleCup: new InstancePool(this.scene,
        new THREE.CylinderGeometry(0.18, 0.13, 0.16, 10),
        new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.8 }), 32),
      sampleFood: new InstancePool(this.scene,
        new THREE.SphereGeometry(0.11, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xc9743a, roughness: 0.7 }), 32),
    }

    /** kind -> [poolName, yOffset][] */
    const PARTS = {
      chip: [['chip', 0], ['chipHalo', 0]],
      pop: [['pop', 0.16], ['popStick', -0.16]],
      sample: [['sampleCup', 0], ['sampleFood', 0.1]],
    }

    const add = (kind, x, y, z) => {
      const slots = []
      for (const [pool, dy] of PARTS[kind]) {
        const i = pools[pool].claim()
        if (i < 0) return // pool full — silently skip rather than corrupt it
        slots.push({ pool: pools[pool], i, dy })
      }
      this.pickups.push({ slots, kind, taken: false, phase: r() * 6.28, baseY: y, x, z })
    }

    // Chocolate chips down every aisle and on top of every platform, because
    // the reward for climbing has to be visible from the floor.
    for (const p of this.store.platforms) {
      if (r() < 0.55) add('chip', p.x, p.height + 0.55, p.z)
    }
    for (let i = 0; i < (this.quality === 'low' ? 26 : 46); i++) {
      const x = rangeFrom(r, -55, 55)
      const z = rangeFrom(r, -40, 40)
      add('chip', x, this.store.groundHeight(x, z, 3) + 0.6, z)
    }

    // Ice pops, only where they are needed: on the warm side of the store.
    const popSpots = [
      [34, 20], [40, 32], [52, 24], [46, 16], [30, 38],
      [-52, 28], [-48, 40], [-46, 24],
      [20, 8], [26, -14], [10, 30],
    ]
    for (const [x, z] of popSpots) {
      add('pop', x, this.store.groundHeight(x, z, 3) + 0.55, z)
    }

    // Free samples clustered where a real store puts them: the ends of aisles.
    for (const ax of this.store.aisleX) {
      for (const z of [-28, 24]) {
        if (r() < 0.7) add('sample', ax + rangeFrom(r, -1, 1), 0.7, z)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Modes
  // -------------------------------------------------------------------------

  _setMode(mode) {
    this.mode = mode
    this.hud.showPause(mode === MODE.PAUSE)
    const playing = mode === MODE.PLAY
    this.hud.setPlayVisible(playing || mode === MODE.FINALE)

    // A duel takes the whole screen and un-splits it. Everybody watches.
    const duelling = mode === MODE.DUEL || mode === MODE.PVP
    const wantViewports = this.session === SESSION.SPLIT && !duelling ? 2 : 1
    if (wantViewports !== this.viewportCount) {
      this.viewportCount = wantViewports
      this._applyAspects()
      this.hud.setViewports(wantViewports)
    }

    // EVERY local player is locked during a duel, duellists included.
    //
    // `locked` is not "cannot act" — it is "your body stands still and your
    // camera is being framed for you", which is exactly right for both the two
    // people in the duel and the one watching. Freeing the duellist instead
    // hands their camera back to the follow rig mid-duel and lets a bystander
    // wander out of a shot the screen has just un-split to show.
    for (const p of this.localPlayers) {
      p.locked = duelling || mode === MODE.PAUSE
    }

    if (this.input.touch) this.input.setTouchVisible(playing || duelling)
    if (mode === MODE.PAUSE) this.hud.setRoster(this.band)
  }

  _allWon() {
    return this.critters.every((c) => c.won)
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start() {
    this._last = performance.now()
    const tick = (now) => {
      if (this._disposed) return
      this._raf = requestAnimationFrame(tick)
      // Clamp: a tab that was backgrounded hands back a dt of several seconds,
      // and integrating that once teleports the player through the building.
      const dt = Math.min(0.05, (now - this._last) / 1000)
      this._last = now
      this.elapsed += dt
      this.update(dt)
      this._render()
    }
    this._raf = requestAnimationFrame(tick)
  }

  /**
   * Draw one or two viewports.
   *
   * Split-screen here is genuinely just scissor plus viewport, because this game
   * renders straight to the canvas with no post-processing chain. (Zulop Bay
   * needs a whole render-target-and-blit dance for the same feature purely
   * because an EffectComposer cannot render into a sub-rectangle.)
   *
   * Player 1 is on TOP. Stacked rather than side-by-side: at a 62° field of view
   * a tall thin viewport shows almost none of an aisle, and every aisle in this
   * building runs away from the camera.
   */
  _render() {
    const w = window.innerWidth
    const h = window.innerHeight
    const r = this.renderer

    if (this.viewportCount < 2) {
      r.setScissorTest(false)
      r.setViewport(0, 0, w, h)
      r.render(this.scene, this.camera)
      return
    }

    r.setScissorTest(true)
    const half = Math.floor(h / 2)
    for (let i = 0; i < 2; i++) {
      // WebGL's origin is bottom-left, so player 1 (the top half) is the one
      // with the HIGHER y. Getting this backwards silently swaps the two views.
      const y = i === 0 ? h - half : 0
      r.setViewport(0, y, w, half)
      r.setScissor(0, y, w, half)
      r.render(this.scene, this.cameras[i])
    }
    r.setScissorTest(false)
  }

  update(dt) {
    this.input.update(dt)
    const inputs = this.localPlayers.map((p) => this.input.getState(p.slot))
    const input = inputs[0] || this.input.getState(0)

    if (this.mode === MODE.TITLE) {
      this.hud.setPadConnected(this.input.connectedPads)
      // A press of A or Start on the pad also opens the join screen, so a child
      // who has picked up the controller never has to go and find the mouse.
      if (input.menuConfirm.pressed || input.pause.pressed) this._showJoin()
      this._orbitTitleCamera(dt)
      this.store.update(dt, this.elapsed)
      return
    }

    if (this.mode === MODE.JOIN) {
      this._orbitTitleCamera(dt)
      this.store.update(dt, this.elapsed)
      // The whole screen is walkable from a pad: left/right moves the highlight,
      // A takes it. Two children with two controllers and no mouse is the most
      // likely way split-screen ever gets started.
      if (input.menuLeft.pressed) this.hud.setJoinSelection((this.hud.joinSelection + 2) % 3)
      if (input.menuRight.pressed) this.hud.setJoinSelection((this.hud.joinSelection + 1) % 3)
      if (input.menuConfirm.pressed) this._pickJoin(this.hud.joinSelection)
      if (input.menuBack.pressed) {
        this.hud.showJoin(false)
        this.hud.showTitle(true)
        this.mode = MODE.TITLE
      }
      return
    }

    if (input.pause.pressed) {
      if (this.mode === MODE.PLAY) { this._setMode(MODE.PAUSE); this.audio.duckMusic(0.3) }
      else if (this.mode === MODE.PAUSE) { this._setMode(MODE.PLAY); this.audio.unduckMusic() }
      // A player duel is the one mode that can, in principle, run forever: two
      // players who never miss are never eliminated. Pause is the way out.
      // (A critter duel does not need one — it always ends by itself.)
      else if (this.mode === MODE.PVP) this._endPvp('quit')
    }
    if (this.mode === MODE.PAUSE) return

    this.store.update(dt, this.elapsed)
    this._confetti.update(dt)

    // The network runs every frame in every mode: a duel must not stop other
    // people's avatars from moving on this screen.
    this.net.update(dt, this)
    this._applyRemoteForklift()
    for (const rp of this.remotes) rp.update(dt, this.player ? this.player.eye : null)

    if (this.mode === MODE.DUEL) {
      this._updateDuel(dt, input)
    } else if (this.mode === MODE.PVP) {
      this._updatePvp(dt, inputs)
    } else {
      this._updateForklift(dt, inputs)
      for (let i = 0; i < this.localPlayers.length; i++) {
        const p = this.localPlayers[i]
        // A player driving Big Earl gets their camera from the ride, not from
        // Player — two things writing camera.position in a frame is a shake.
        p.update(dt, inputs[i], this.cameras[i])
        if (this.forklift.isDriver(p)) this._placeDriveCamera(dt, this.cameras[i], p)
      }
      this._updatePickups(dt)
      this._updateCritters(dt)
      this._updateInteraction(dt, inputs)
      this._updateMeters()
      if (this.mode === MODE.FINALE) this._updateFinale(dt, input)
    }

    if (this.session === SESSION.ONLINE && this.net.enabled) {
      this.hud.setNetStatus(`${this.net.roomCode || ''} · ${this.remotes.length + 1} playing`)
    }

    this._updateSun()
  }

  /** Push the per-player meters into the HUD. */
  _updateMeters() {
    for (let i = 0; i < this.localPlayers.length && i < 2; i++) {
      const p = this.localPlayers[i]
      this.hud.setMelt(p.melt, i)
      this.hud.setFlight(p.flight.fuel, p.flight.active, i)
    }
    this.hud.setChips(this.chips)
  }

  /**
   * Keep the shadow camera on somebody, or the one shadow that matters is
   * outside the frustum for most of the store. Player 1 wins the tie: chasing
   * the midpoint of two players who have wandered apart puts the shadow box
   * around neither of them.
   */
  _updateSun() {
    if (!this.store.sun || !this.store.sun.castShadow) return
    const p = this.player.pos
    this.store.sun.position.set(p.x + 20, 30, p.z + 16)
    this.store.sun.target.position.set(p.x, 0, p.z)
    this.store.sun.target.updateMatrixWorld()
  }

  /** Slow orbit around the stage behind the title and join screens. */
  _orbitTitleCamera(dt) {
    const a = this.elapsed * 0.09
    const t = POINTS.stage
    this.camera.position.set(
      t.x + Math.cos(a) * 22, 7.5 + Math.sin(a * 0.7) * 1.6, t.z + Math.sin(a) * 22 - 8,
    )
    this.camera.lookAt(t.x, 2.2, t.z)
  }

  // -------------------------------------------------------------------------
  // Critters, pickups, interaction
  // -------------------------------------------------------------------------

  _updateCritters(dt) {
    const eye = this.player.eye
    for (const c of this.critters) {
      const playing = this.mode === MODE.FINALE && c.onStage
      c.rig.update(dt, { lookAt: eye, playing })

      // The finale walk: everybody strolls to their mic stand.
      if (c.stageTarget) {
        const g = c.rig.group.position
        g.x = damp(g.x, c.stageTarget.x, 2.2, dt)
        g.y = damp(g.y, c.stageTarget.y, 2.2, dt)
        g.z = damp(g.z, c.stageTarget.z, 2.2, dt)
        c.rig.group.rotation.y = Math.atan2(
          POINTS.stage.x - g.x - 0.001, POINTS.stage.z - g.z + 4,
        ) + Math.PI
        if (g.distanceTo(c.stageTarget) < 0.15) { c.onStage = true; c.stageTarget = null }
      }

      // Marker: hidden once they're in the band, during the show, and during a
      // duel — where it would otherwise hang in the middle of the two-shot.
      const show = !c.won && this.mode !== MODE.FINALE && this.mode !== MODE.DUEL
      c.marker.visible = show
      if (show) {
        c.marker.rotation.y += dt * 2
        c.marker.position.y =
          c.rig.group.position.y + (c.def.big ? 3.4 : 2.1) + Math.sin(this.elapsed * 2.4) * 0.18
        c.marker.position.x = c.rig.group.position.x
        c.marker.position.z = c.rig.group.position.z
      }
    }
  }

  /**
   * Pickups.
   *
   * Every LOCAL player collects, and so does a flying banjo — reaching the
   * things you cannot jump to is the entire reason that mode exists, so the
   * banjo has to be able to pick them up on its own.
   */
  _updatePickups(dt) {
    for (let idx = 0; idx < this.pickups.length; idx++) {
      const item = this.pickups[idx]
      if (item.taken) continue

      const y = item.baseY + Math.sin(this.elapsed * 2.6 + item.phase) * 0.13
      const rotY = this.elapsed * 1.9 + item.phase
      for (const s of item.slots) s.pool.set(s.i, item.x, y + s.dy, item.z, rotY)

      for (const p of this.localPlayers) {
        // The flying banjo has a fatter grab radius than a walking player: at 6m
        // up, judging a 1.5m sphere by eye is genuinely hard.
        const probe = p.flight.active ? p.flight.pos : p.pos
        const range = p.flight.active ? PICKUP_RANGE * 1.7 : PICKUP_RANGE
        const eyeY = p.flight.active ? probe.y : probe.y + 0.9
        const dx = item.x - probe.x
        const dz = item.z - probe.z
        if (dx * dx + dz * dz > range * range) continue
        if (Math.abs(y - eyeY) > (p.flight.active ? 2.2 : 1.6)) continue
        this._collect(idx, item, p)
        break
      }
    }
    // One upload per pool per frame, after every instance has been placed.
    for (const pool of Object.values(this._pools)) pool.commit()
  }

  /** @param {Player} by who walked (or flew) into it. */
  _collect(idx, item, by) {
    this._takePickup(idx, true)

    if (item.kind === 'chip') {
      this.chips++
      this.audio.chip(this.chips)
      // The music thickens as the store gets emptier of chocolate. A small
      // thing, but it makes collecting feel like it is building toward
      // something even before the band exists.
      this.audio.setMusic('store', { intensity: 0.5 + Math.min(0.5, this.chips / 60) })
    } else if (item.kind === 'pop') {
      by.chill(0.6)
      this.hud.toast('🧊 Ahh, that\'s better!', 1600)
    } else {
      by.pep(9)
      this.hud.toast('🍢 Free sample! Extra zoom for a bit.', 1900)
    }
  }

  /**
   * Mark one pickup gone.
   * @param {boolean} relay true when WE took it and the others must be told
   */
  _takePickup(idx, relay) {
    const item = this.pickups[idx]
    if (!item || item.taken) return
    item.taken = true
    for (const s of item.slots) s.pool.hide(s.i)
    if (relay && this.net.enabled) this.net.sendEvent('chip', { i: idx })
  }

  /**
   * What each local player can do where they are standing.
   *
   * Runs once per local player with that player's own input, which is what makes
   * split-screen work: two people can be reading two different prompts and
   * pressing X for two different reasons in the same frame.
   */
  _updateInteraction(dt, inputs) {
    if (this.mode !== MODE.PLAY) return

    for (let i = 0; i < this.localPlayers.length; i++) {
      const p = this.localPlayers[i]
      const input = inputs[i]
      if (!input) continue

      // Driving Big Earl owns X entirely — the Forklift itself watches for the
      // press and tells us. Nothing else here should fire.
      if (this.forklift.isDriver(p)) {
        this.hud.setPrompt('Hop out', 'X', i)
        continue
      }

      // Somebody who got out of Earl THIS frame sits the rest of the frame out.
      //
      // _updateForklift runs before this and consumes X to end the ride, but
      // `pressed` is a one-frame edge that everything downstream can still see.
      // Earl's own EXIT_COOLDOWN stops that press putting you straight back in
      // his seat — this stops it doing everything ELSE X does at the spot you
      // were just dropped. Park Earl beside Wanda, press X to get out, and
      // without this you are instantly in a banjo duel you did not ask for.
      if (p === this._exitedThisFrame) {
        this.hud.setPrompt(null, 'X', i)
        continue
      }

      // The flying banjo owns B, always, in every situation below.
      if (input.fly && input.fly.pressed) this._toggleFlight(p, i)

      if (p.flight.active) {
        // "Bring it back" while it is already on its way back is a prompt for a
        // button that does nothing, which is exactly how a child learns that
        // buttons sometimes do nothing.
        const coming = p.flight.state === FLIGHT.RETURNING
        this.hud.setPrompt(coming ? 'Coming back…' : 'Bring the banjo back', 'B', i)
        continue
      }

      // --- a critter? -------------------------------------------------------
      //
      // Checked BEFORE the other player, deliberately. Two players in co-op
      // walk around together, so they are within duelling range of each other
      // almost permanently — and if that won, standing side by side in front of
      // Ricky Raccoon would make it impossible to duel Ricky Raccoon. The six
      // critters are the game's spine and they sit in six fixed places; giving
      // them priority costs player-versus-player nothing except those six
      // spots, and makes both prompts predictable.
      let best = null
      let bestD = TALK_RANGE
      for (const c of this.critters) {
        if (c.won) continue
        const d = c.rig.group.position.distanceTo(p.pos)
        if (d < bestD) { bestD = d; best = c }
      }
      if (best) {
        this.hud.setPrompt(`Duel ${best.def.name}!`, 'X', i)
        if (input.strum.pressed) { this._beginDuel(best, p); return }
        continue
      }

      // --- another player? --------------------------------------------------
      const rival = this._nearestRival(p)
      if (rival) {
        this.hud.setPrompt(`Duel ${rival.name}!`, 'X', i)
        if (input.strum.pressed) { this._beginPvp(p, rival); return }
        continue
      }

      // --- Big Earl? --------------------------------------------------------
      if (this.forklift.canEnter && this.forklift.pos.distanceTo(p.pos) < FORKLIFT_RANGE) {
        this.hud.setPrompt('Drive Big Earl!', 'X', i)
        if (input.strum.pressed) {
          this.forklift.enter(p)
          this.hud.toast('🚜 Stick to drive · A up · Y down · B honk · X to hop out', 5200)
          continue
        }
        continue
      }

      // --- the big show? ----------------------------------------------------
      const onStage = p.pos.distanceTo(POINTS.stage) < 7.5 && this._allWon()
      if (onStage) {
        this.hud.setPrompt('Start the big show!', 'X', i)
        if (input.strum.pressed) { this._beginFinale(); return }
        continue
      }

      // --- nothing in particular -------------------------------------------
      this.hud.setPrompt(null, 'X', i)
      // Free strumming, anywhere, any time. This turns out to be what a
      // five-year-old does for the first ten minutes, so it had better sound
      // good and it had better always work.
      if (input.strum.pressed) {
        this.audio.strum()
        p.strum()
      }
      if (input.howdy && input.howdy.pressed) {
        this.audio.pluck(55, { gain: 0.6 })
        this.hud.toast('“Howdy!”', 1100)
      }
    }

    this._updateGoal()
  }

  /** B: send the banjo up, or call it back. */
  _toggleFlight(p, i) {
    const what = p.toggleFlight()
    if (what === 'launched') {
      this.hud.toast('🪽 Off it goes! Stick to fly · A up · Y down · B to call it back', 4200)
      this.input.rumble(p.slot, 0.4, 140)
    } else if (what === 'empty') {
      this.hud.toast('🪽 The banjo needs a moment to catch its breath.', 1800)
    }
  }

  /**
   * The nearest OTHER player close enough to challenge.
   *
   * Deliberately ignores anyone already busy — driving, flying, or duelling —
   * because a duel invitation that yanks somebody out of a forklift six metres
   * up is a bug, not a feature.
   */
  _nearestRival(p) {
    let best = null
    let bestD = PVP_RANGE
    const consider = (other) => {
      if (!other || other === p) return
      if (other.externalControl || (other.flight && other.flight.active)) return
      const d = Math.hypot(other.pos.x - p.pos.x, other.pos.z - p.pos.z)
      if (d < bestD && Math.abs(other.pos.y - p.pos.y) < 2.5) { bestD = d; best = other }
    }
    for (const other of this.localPlayers) consider(other)
    for (const other of this.remotes) consider(other)
    return best
  }

  _updateGoal() {
    const left = this.critters.filter((c) => !c.won)
    if (!left.length) {
      this.hud.setGoal('🌟 <b>Everybody\'s in the band!</b><br>Go to the Free Sample Stage at the front of the store and press <b>X</b>.')
      return
    }
    const zone = this.store.zoneAt(this.player.pos.x, this.player.pos.z)
    const next = left[0]
    this.hud.setGoal(
      `📍 You are in <b>${zone.name}</b><br>` +
      `🎵 ${left.length} critter${left.length > 1 ? 's' : ''} left to duel. ` +
      `Try <b>${next.def.name}</b> in <b>${next.def.zone}</b>.`,
    )
  }

  // -------------------------------------------------------------------------
  // Big Earl
  // -------------------------------------------------------------------------

  _updateForklift(dt, inputs) {
    // Cleared every frame; set below if somebody hops out this frame. See the
    // note in _updateInteraction for what it is for.
    this._exitedThisFrame = null
    const driver = this.forklift.driver
    let driverInput = null
    if (driver) {
      const i = this.localPlayers.indexOf(driver)
      driverInput = i >= 0 ? inputs[i] : null
    }

    const wantsOut = this.forklift.update(dt, driverInput)
    // Anybody riding the forks moves with them. Done before the players' own
    // update so their collision and ground checks run on the carried position.
    this.forklift.carry(this.localPlayers)

    // The driver's body rides in the seat. Done here rather than in Forklift so
    // that Player stays the only thing that ever writes a player's position.
    if (driver) {
      const seat = this.forklift.seatPos()
      driver.pos.copy(seat)
      driver.facing = this.forklift.heading
    }

    // Whoever is driving carries Earl's pose in their own packet. Everybody
    // else clears the field, or a client who got out would go on insisting they
    // are the authority for a forklift they are standing next to.
    for (const p of this.localPlayers) {
      p.forkNet = (p === driver && this.net.enabled)
        ? { fork: this.net.id, ...this.forklift.getNetState() }
        : null
    }
    if (wantsOut) {
      this.forklift.exit()
      this._exitedThisFrame = driver
      this.hud.toast('🚜 Thanks, Earl.', 1600)
    }
  }

  /**
   * Chase camera for whoever is driving. Higher and further back than walking.
   *
   * The boom is PULLED IN when there is something behind Earl, the same way
   * Player._placeCamera does it, because a fixed 9.5m boom does not survive
   * contact with the building. Earl parks at z = -37 and the back wall is at
   * z = -45: boarding him where he starts, facing into the store, put the
   * camera at z = -46.5 — outside the building, looking at the inside face of
   * the wall. The whole screen was a flat grey rectangle until you drove away.
   */
  _placeDriveCamera(dt, camera, driver) {
    const f = this.forklift
    const dirX = -Math.sin(f.heading)
    const dirZ = -Math.cos(f.heading)
    const eyeY = f.pos.y + 5.2 + f.lift * 0.55

    // How far back we can actually go. `_clearance` is Player's coarse ray
    // march; the driver is a Player, so borrow theirs rather than writing a
    // second one that can disagree with it.
    let back = 9.5
    if (driver && typeof driver._clearance === 'function') {
      back = Math.min(back, Math.max(3.2, driver._clearance(f.pos.x, eyeY, f.pos.z, dirX, dirZ, back) - 0.6))
    }

    // And never outside the shell, which the collision grid does not model.
    const margin = 1.2
    let wantX = f.pos.x + dirX * back
    let wantZ = f.pos.z + dirZ * back
    wantX = Math.max(STORE.minX + margin, Math.min(STORE.maxX - margin, wantX))
    wantZ = Math.max(STORE.minZ + margin, Math.min(STORE.maxZ - margin, wantZ))
    const wantY = Math.min(STORE.ceiling - 0.6, eyeY)

    camera.position.set(
      damp(camera.position.x, wantX, 5, dt),
      damp(camera.position.y, wantY, 5, dt),
      damp(camera.position.z, wantZ, 5, dt),
    )
    // Look at the forks, not the cab: what the player actually needs to see is
    // where the load is, and at full lift that is five metres above Earl's roof.
    camera.lookAt(f.pos.x, f.pos.y + 1.2 + f.lift * 0.8, f.pos.z)
  }

  // -------------------------------------------------------------------------
  // Duel with a critter
  // -------------------------------------------------------------------------

  /** @param {Player} [by] which local player is duelling. */
  _beginDuel(critter, by = this.localPlayers[0]) {
    this.activeCritter = critter
    this.duelPlayer = by
    this.duel = new Duel(critter.def, this.audio, this.scene, () => this.rand())
    this._setMode(MODE.DUEL)

    by.faceDuel(critter.rig.group.position)
    critter.rig.group.rotation.y = Math.atan2(
      by.pos.x - critter.rig.group.position.x,
      by.pos.z - critter.rig.group.position.z,
    )

    this.hud.showDuel(critter.def)
    this.audio.setMusic('duel', { intensity: 0.6 })
    if (this.input.setDuelLabels) this.input.setDuelLabels(true)
  }

  _updateDuel(dt, input) {
    const duel = this.duel
    const me = this.duelPlayer
    // The duellist's own input, whichever slot they are on — in split-screen
    // player 2 must be able to duel with player 2's controller.
    const myInput = this.input.getState(me.slot) || input

    duel.setEndpoints(this.activeCritter.rig.group.position, me.pos)
    const state = duel.update(dt, myInput)

    // Feed the rigs. The critter animates while the CALL plays; the player
    // animates while the RESPONSE does. That alternation is what sells it as a
    // conversation rather than two people playing at once.
    const critterPlaying = state === DUEL_STATE.CALL || state === DUEL_STATE.WON
    this.activeCritter.rig.update(dt, { lookAt: me.eye, playing: critterPlaying })

    for (const ev of duel.events) {
      if (ev.type === 'idleNote') {
        // Played along out of turn: animate it, but no rumble and no scoring.
        me.strum()
        me.rig.banjo.flashString(ev.note, 0.5)
      } else if (ev.type === 'playerNote') {
        me.strum()
        me.rig.banjo.flashString(ev.note, ev.correct ? 1 : 0.3)
        if (ev.correct) this.input.rumble(me.slot, 0.35, 90)
        else this.input.rumble(me.slot, 0.7, 260)
      } else if (ev.type === 'callNote') {
        me.rig.banjo.flashString(ev.note, 0.4)
      } else if (ev.type === 'roundWon') {
        this._confetti.burst(me.pos.x, me.pos.y + 2.4, me.pos.z, 40)
        if (ev.clean) this.hud.toast('⭐ Perfect round!', 1800)
      } else if (ev.type === 'mercy') {
        this.hud.toast('🪕 Let\'s try a shorter one!', 2200)
      } else if (ev.type === 'won') {
        this._winDuel()
      }
    }

    // Player.update drives the rig itself (via _updateLocked) — advancing it a
    // second time here made the idle and strum animations run at double speed.
    me.update(dt, myInput, this.camera)

    // The player NOT duelling still gets a frame, so a split-screen partner does
    // not freeze mid-stride for the length of a duel.
    for (const p of this.localPlayers) {
      if (p !== me) p.update(dt, this.input.getState(p.slot), null)
    }

    this.hud.updateDuel(duel, state)
    this._updateMeters()

    if (state === DUEL_STATE.DONE) this._endDuel()
  }

  _winDuel() {
    const c = this.activeCritter
    this._recordBandWin(c.def.id, this.duel.gotStar, true)
    this.chips += 5

    const p = c.rig.group.position
    this._confetti.burst(p.x, p.y + 2, p.z, 140)
    this.input.rumble(this.duelPlayer.slot, 0.9, 500)
  }

  /**
   * Put a critter in the band.
   * @param {boolean} relay true when it happened here and the room must be told
   */
  _recordBandWin(id, star, relay) {
    const c = this.critters.find((x) => x.def.id === id)
    if (!c || c.won) return
    c.won = true
    c.star = !!star
    this.band[id] = { won: true, star: !!star }
    this.hud.setBand(this.band)
    if (relay && this.net.enabled) this.net.sendEvent('duelWon', { id, star: !!star })
  }

  _endDuel() {
    const c = this.activeCritter
    this.duel.dispose()
    this.duel = null
    this.duelPlayer.endDuel()
    this.duelPlayer = null
    this.hud.hideDuel()
    if (this.input.setDuelLabels) this.input.setDuelLabels(false)
    this._setMode(MODE.PLAY)

    const remaining = this.critters.filter((x) => !x.won).length
    this.audio.setMusic('store', { intensity: 0.5 + (6 - remaining) / 12 })

    this.hud.toast(
      `🎉 ${c.def.name} joined the band!${c.star ? ' ⭐ Gold star!' : ''}`, 3400,
    )
    if (remaining === 0) {
      window.setTimeout(() => {
        this.audio.paChime()
        this.hud.toast('📢 “Attention shoppers: the band is complete!”', 4500)
        this.hud.toast('🎪 Head to the Free Sample Stage at the front!', 5000)
      }, 1400)
    }
  }

  // -------------------------------------------------------------------------
  // Duel with another player
  // -------------------------------------------------------------------------

  /** True while this player is one of the two in a player duel. */
  _inPvp(p) {
    return !!this.pvp && (this.pvpBodies[0] === p || this.pvpBodies[1] === p)
  }

  /**
   * @param {Player} challenger the local player who pressed X
   * @param {Player|RemotePlayer} rival
   */
  _beginPvp(challenger, rival) {
    const remote = rival.isLocal === false
    const peer = remote ? this.net.peers.find((x) => x.player === rival) : null
    if (remote && !peer) return

    this._openPvp({
      bodies: [challenger, rival],
      sides: [this._sideOf(challenger), this._sideOf(rival)],
      authority: true,
      remotePeerId: peer ? peer.id : -1,
    })
    if (peer) this.net.sendEvent('pvpStart', { target: peer.id })
  }

  /** Somebody out there pressed X on us. */
  _acceptPvp(fromId) {
    if (this.pvp || this.mode !== MODE.PLAY) return
    const peer = this.net.peerById(fromId)
    if (!peer || !peer.player) return
    // Side 0 is always the challenger, on BOTH machines. That agreement is the
    // whole reason a relayed note lands on the right player.
    this._openPvp({
      bodies: [peer.player, this.player],
      sides: [this._sideOf(peer.player), this._sideOf(this.player)],
      authority: false,
      remotePeerId: peer.id,
    })
  }

  /** Describe one participant for PvpDuel and the HUD. */
  _sideOf(p) {
    return {
      key: p.isLocal === false ? `net${p.peer ? p.peer.id : 0}` : `slot${p.slot}`,
      name: p.name,
      accent: p.skin.accent,
      local: p.isLocal !== false,
      slot: p.isLocal === false ? -1 : p.slot,
    }
  }

  _openPvp({ bodies, sides, authority, remotePeerId }) {
    this.pvpBodies = bodies
    this.pvp = new PvpDuel({
      a: sides[0],
      b: sides[1],
      audio: this.audio,
      scene: this.scene,
      authority,
      onLocalNote: (note, side) => {
        if (this.net.enabled) this.net.sendEvent('pvpNote', { note, side })
      },
    })
    this.pvp.remotePeerId = remotePeerId

    this._setMode(MODE.PVP)
    // Both of them turn to face each other, and the camera takes the same
    // side-on two-shot the critter duel uses.
    for (let i = 0; i < 2; i++) {
      const me = bodies[i]
      const them = bodies[1 - i]
      if (me.isLocal === false) continue
      me.faceDuel(them.pos)
    }
    this.hud.showPvp(this.pvp)
    this.audio.setMusic('duel', { intensity: 0.85 })
    if (this.input.setDuelLabels) this.input.setDuelLabels(true)
  }

  _updatePvp(dt, inputs) {
    const duel = this.pvp
    const [ba, bb] = this.pvpBodies
    duel.setEndpoints(ba.pos, bb.pos)

    // Read a string press from each LOCAL side. Out-of-turn presses still go in
    // — PvpDuel decides whether they score or just make a noise.
    for (let side = 0; side < 2; side++) {
      const info = duel.sides[side]
      if (!info.local) continue
      const input = this.input.getState(info.slot)
      if (!input) continue
      for (let n = 0; n < 4; n++) {
        const b = input[`string${n + 1}`]
        if (b && b.pressed) { duel.pressNote(side, n); break }
      }
    }

    const state = duel.update(dt)

    for (const ev of duel.events) {
      const body = ev.side !== undefined ? this.pvpBodies[ev.side] : null
      if (ev.type === 'callNote' || ev.type === 'idleNote' || ev.type === 'echoNote') {
        if (body && body.strum) body.strum()
        if (body && body.rig && body.rig.banjo) {
          body.rig.banjo.flashString(ev.note, ev.correct === false ? 0.3 : 1)
        }
        if (ev.type === 'echoNote' && body && body.isLocal !== false) {
          this.input.rumble(body.slot, ev.correct ? 0.3 : 0.7, ev.correct ? 90 : 260)
        }
      } else if (ev.type === 'lostString') {
        if (body) this._confetti.burst(body.pos.x, body.pos.y + 2.2, body.pos.z, 12)
      } else if (ev.type === 'echoDone') {
        if (body) this._confetti.burst(body.pos.x, body.pos.y + 2.4, body.pos.z, 40)
      } else if (ev.type === 'won') {
        this._winPvp(ev.winner)
      }
    }

    // Both bodies keep animating. Exactly ONE of them places the camera: in
    // split-screen both are local, and two players running _placeDuelCamera on
    // the same THREE.Camera in one frame is a camera that vibrates between two
    // nearly-identical two-shots. The first local side owns it; the framing is
    // symmetric, so which one wins does not matter.
    let cameraTaken = false
    for (let i = 0; i < 2; i++) {
      const body = this.pvpBodies[i]
      if (body.isLocal === false) continue
      const info = duel.sides[i]
      body.update(dt, this.input.getState(info.slot) || inputs[0], cameraTaken ? null : this.camera)
      cameraTaken = true
    }
    for (const p of this.localPlayers) {
      if (!this._inPvp(p)) p.update(dt, this.input.getState(p.slot), null)
    }

    this.hud.updatePvp(duel, state)
    this._updateMeters()

    if (state === PVP_STATE.DONE) this._endPvp('finished')
  }

  _winPvp(winner) {
    const body = this.pvpBodies[winner]
    this._confetti.burst(body.pos.x, body.pos.y + 2.2, body.pos.z, 160)
    if (body.isLocal !== false) this.input.rumble(body.slot, 0.9, 500)
    // Both of them get chips. The loser walked away from a duel with something,
    // which is the whole difference between this and losing.
    this.chips += 6
  }

  /**
   * @param {'finished'|'quit'|'left'} why
   *   `finished` — somebody ran out of strings. The authority tells the room.
   *   `quit`     — somebody here pressed pause. Either side may call it off, so
   *                either side has to be able to say so.
   *   `left`     — we are REACTING to the other side going away or calling it
   *                off, so saying anything would bounce the message back.
   */
  _endPvp(why = 'finished') {
    if (!this.pvp) return
    const duel = this.pvp
    const winner = duel.winner
    const names = duel.sides.map((s) => s.name)

    if (this.net.enabled && (why === 'quit' || (why === 'finished' && duel.authority))) {
      this.net.sendEvent('pvpEnd', {})
    }

    duel.dispose()
    this.pvp = null

    for (const body of this.pvpBodies) {
      if (body.isLocal !== false) body.endDuel()
    }
    this.pvpBodies = []
    this.hud.hidePvp()
    if (this.input.setDuelLabels) this.input.setDuelLabels(false)
    this._setMode(MODE.PLAY)
    this.audio.setMusic('store', { intensity: 0.7 })

    if (why !== 'finished') {
      this.hud.toast('🪕 Duel called off. Have another go whenever you like!', 3000)
    } else if (winner >= 0) {
      this.hud.toast(`🏆 ${names[winner]} wins the duel! Well played, ${names[1 - winner]}.`, 4200)
    }
  }

  // -------------------------------------------------------------------------
  // Finale
  // -------------------------------------------------------------------------

  _beginFinale() {
    this._setMode(MODE.FINALE)
    this._finaleTime = 0
    this.audio.setMusic('finale')
    this.audio.cheer()
    for (let i = 0; i < 2; i++) this.hud.setPrompt(null, 'X', i)
    // _updateInteraction (and with it _updateGoal) stops running outside PLAY,
    // so the goal line would otherwise sit on "go to the stage" through the
    // entire show. Set the last one by hand.
    this.hud.setGoal('🎪 <b>The big show!</b><br>Press <b>X</b> to play along.')

    // Everybody walks on and takes a mic stand.
    this.critters.forEach((c, i) => {
      c.stageTarget = this.store.bandSpots[i].clone()
    })
  }

  _updateFinale(dt, input) {
    this._finaleTime += dt

    // Let them play along — ALL of them. A five-year-old who has just been
    // handed a stage, a band and a spotlight is going to hammer X, and so is
    // the one sitting next to them. `input` is optional so the smoke test can
    // drive this without synthesising a controller.
    for (let i = 0; i < this.localPlayers.length; i++) {
      const p = this.localPlayers[i]
      const pi = this.input.getState(p.slot) || (i === 0 ? input : null)
      if (!pi) continue
      if (pi.strum && pi.strum.pressed) {
        this.audio.strum({ gain: 0.8 })
        p.strum()
        this._confetti.burst(p.pos.x, p.pos.y + 2.2, p.pos.z, 24)
      }
      if (pi.howdy && pi.howdy.pressed) this.audio.cheer()
    }

    // Confetti keeps coming, in bursts on the beat.
    this._confettiTimer = (this._confettiTimer || 0) - dt
    if (this._confettiTimer <= 0) {
      this._confettiTimer = 0.45
      this._confetti.burst(
        POINTS.stage.x + (this.rand() - 0.5) * 14,
        6.5,
        POINTS.stage.z + (this.rand() - 0.5) * 10,
        30,
      )
    }

    // Give them fourteen seconds of the actual show before any UI appears.
    if (this._finaleTime > 14 && !this._finaleShown) {
      this._finaleShown = true
      const stars = this.critters.filter((c) => c.star).length
      const melted = this.localPlayers.reduce((n, p) => n + p.meltedCount, 0)
      const who = this.localPlayers.length > 1 || this.remotes.length
        ? `Billy Bob Joe Bob, friends, and the Giga-Mart Six`
        : `Billy Bob Joe Bob and the Giga-Mart Six`
      this.hud.setFinaleText(
        `${who} played until closing time.<br><br>` +
        `🍫 <b>${this.chips}</b> chocolate chips collected<br>` +
        `⭐ <b>${stars}</b> of 6 gold stars<br>` +
        `🫠 Banjos melted <b>${melted}</b> time${melted === 1 ? '' : 's'}` +
        (stars === 6 ? '<br><br>🏆 <b>A perfect show. Not one wrong note.</b>' : ''),
      )
      this.hud.showFinale(true)
    }
  }

  // -------------------------------------------------------------------------

  dispose() {
    this._disposed = true
    if (this._raf) cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('orientationchange', this._onResize)
    this.input.dispose()
    this.audio.stopMusic()
    this.net.dispose()
    for (const rp of this.remotes) rp.dispose()
    for (const p of this.localPlayers) p.flight.dispose()
    if (this.shell) this.shell.dispose()
    if (this.hud) this.hud.dispose()
    this.renderer.dispose()
  }
}

// ===========================================================================
// Confetti
// ===========================================================================

/**
 * One InstancedMesh of little coloured rectangles with a pool of ballistic
 * particles. Reusing a fixed pool means a burst never allocates, which matters
 * because the finale fires one every 0.45s for as long as the player watches.
 */
class Confetti {
  constructor(scene, count) {
    const geo = new THREE.PlaneGeometry(0.14, 0.22)
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, count)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    this.count = count
    this.parts = []
    for (let i = 0; i < count; i++) {
      this.parts.push({ life: 0, x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, spin: 0 })
    }
    this._next = 0
    this._m4 = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler()
    this._s = new THREE.Vector3(1, 1, 1)
    this._c = new THREE.Color()
    this._colors = [0xef4a4a, 0x57d96a, 0x4aa8ef, 0xf5d130, 0xff8fd0, 0xffffff]
  }

  burst(x, y, z, n) {
    for (let i = 0; i < n; i++) {
      const p = this.parts[this._next]
      this._next = (this._next + 1) % this.count
      p.life = 2.4 + Math.random() * 1.4
      p.x = x + (Math.random() - 0.5) * 1.2
      p.y = y
      p.z = z + (Math.random() - 0.5) * 1.2
      const a = Math.random() * Math.PI * 2
      const s = 1.5 + Math.random() * 4
      p.vx = Math.cos(a) * s
      p.vz = Math.sin(a) * s
      p.vy = 3.5 + Math.random() * 4.5
      p.rx = Math.random() * 6.28
      p.ry = Math.random() * 6.28
      p.spin = (Math.random() - 0.5) * 14
      this._c.set(this._colors[(Math.random() * this._colors.length) | 0])
      this.mesh.setColorAt(this._next, this._c)
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  update(dt) {
    let any = false
    for (let i = 0; i < this.count; i++) {
      const p = this.parts[i]
      if (p.life <= 0) {
        // Park dead confetti far below the floor rather than scaling it to zero:
        // a zero-scale matrix is a degenerate transform and some drivers spend
        // real time on it.
        this._m4.makeTranslation(0, -100, 0)
        this.mesh.setMatrixAt(i, this._m4)
        continue
      }
      any = true
      p.life -= dt
      p.vy -= 11 * dt
      // Air drag, so it flutters down instead of falling like a stone.
      p.vx *= 1 - 1.6 * dt
      p.vz *= 1 - 1.6 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.rx += p.spin * dt
      p.ry += p.spin * 0.6 * dt
      if (p.y < 0.02) { p.y = 0.02; p.vy = 0; p.vx *= 0.6; p.vz *= 0.6 }

      this._e.set(p.rx, p.ry, 0)
      this._q.setFromEuler(this._e)
      this._m4.compose({ x: p.x, y: p.y, z: p.z }, this._q, this._s)
      this.mesh.setMatrixAt(i, this._m4)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = any
  }
}
