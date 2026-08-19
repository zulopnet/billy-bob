// net/NetClient.js — online co-op for Billy Bob Joe Bob.
//
// Lifted from ~/dog/src/net/NetClient.js, which has been carrying Zulop Bay's
// four-pup co-op for a year. The interpolation, the clock sync and the "never
// let the network take the frame loop down" discipline are that file's; the
// payload and the shared-world snapshot are this game's.
//
// DESIGN RULE ONE, unchanged and non-negotiable: **the game is fully playable
// with no server at all.** `enabled` starts false, every method is safe to call
// offline, every send is a no-op, and if the socket dies mid-game we quietly
// fire onPeerLeave for every peer, flip `enabled` back to false and let the
// store carry on as single-player. Nothing in here is allowed to throw into the
// frame loop, because the person playing is five and "it froze" is the end of
// the session.
//
// Sync model:
//   - Local player state goes out at 20 Hz, and only when it meaningfully moved.
//   - Remote players are buffered with their server timestamps and played back
//     100 ms in the past, lerping position and short-way-around slerping yaw
//     between the two surrounding snapshots. On a gap we dead-reckon with the
//     last known velocity for at most 250 ms, then freeze. Never a teleport.
//   - The shared world (which chips are gone, who is in the band, where Big Earl
//     is parked) is host-authoritative at 5 Hz, and immediately on any discrete
//     change.
//   - sendEvent/onEvent carry one-shot events — a duel won, a note struck in a
//     player-versus-player duel, a horn — so the juice fires on every machine.
//
// Integration contract: each peer object owned by this class is
//   { id, name, char, index, state, player }
// `state` is a stable, reused object holding the *interpolated* values for the
// current frame. If the integrator assigns `peer.player` (a RemotePlayer) in
// onPeerJoin, update() hands it `peer.state` every frame automatically.

import { clamp, lerp, angleDelta } from '../core/MathUtils.js'

const DEFAULT_PORT = 8080

const SEND_HZ = 20            // local player state rate
const SEND_DT = 1 / SEND_HZ
const WORLD_HZ = 5            // host world-snapshot rate
const WORLD_DT = 1 / WORLD_HZ
const PING_DT = 2.0           // clock-sync ping period, seconds

const INTERP_DELAY_MS = 100   // play remotes 100 ms in the past
const MAX_EXTRAP_MS = 250     // dead-reckon at most this far past the last snapshot
const BUFFER_MAX = 40         // snapshots kept per peer (~2 s at 20 Hz)

const POS_EPS = 0.01          // 1 cm
const YAW_EPS = Math.PI / 180 // 1 degree

const CONNECT_TIMEOUT_MS = 6000

/** Max players in a room. Must match BB_MAX_PLAYERS on the server. */
export const MAX_NET_PLAYERS = 4

/** Snapshot record kept in a peer's interpolation buffer. */
function makeSnap() {
  return {
    t: 0, px: 0, py: 0, pz: 0, yaw: 0, vx: 0, vy: 0, vz: 0,
    s: 'idle', melt: 0,
    // Big Earl's pose, carried by whoever is driving him. `fork` is -1 when this
    // player is not the driver, which is also how a client knows to ignore it.
    fork: -1, fx: 0, fz: 0, fh: 0, fl: 0,
  }
}

/** A stable state object we can mutate in place forever. */
function makeState(index = 0) {
  return {
    i: index, p: [0, 0, 0], r: 0, v: [0, 0, 0], s: 'idle', char: null,
    melt: 0, fork: -1, fx: 0, fz: 0, fh: 0, fl: 0, t: 0,
  }
}

export class NetClient {
  constructor(ctx) {
    this.ctx = ctx

    this._ws = null
    this._enabled = false
    this._isHost = false
    this._closing = false

    this.id = 0        // our server-assigned client id
    this.index = 0     // our slot 0..3 in the room
    this.roomCode = null
    this.name = 'Billy Bob'

    this._peers = []
    this._peerById = new Map()

    this._joinResolve = null
    this._joinReject = null

    this._onJoin = []
    this._onLeave = []
    this._onEvent = []
    this._onStatus = []

    this._sendAcc = 0
    this._worldAcc = 0
    this._pingAcc = 0

    // clock sync: serverTime ≈ Date.now() + _clockOffset
    this._clockOffset = 0
    this._bestRtt = Infinity
    this._pingSeq = 1
    this._pingSentAt = new Map()

    // reused outbound objects — the hot path allocates nothing
    this._out = makeState(0)
    this._outMsg = { t: 'state', s: this._out }
    this._worldMsg = { t: 'world', s: null }
    this._eventMsg = { t: 'event', e: '', d: null }
    this._pingMsg = { t: 'ping', c: 0 }

    // last thing we actually put on the wire, for change detection
    this._lastSent = {
      px: 0, py: 0, pz: 0, yaw: 0, s: '', char: '', melt: 0, fork: -1, valid: false,
    }
    // last world snapshot we broadcast, for immediate-on-change detection
    this._lastWorld = { chips: -1, taken: -1, band: '', driver: -1, valid: false }
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  get enabled() { return this._enabled }

  /** Offline you are, trivially, the authority. */
  get isHost() { return this._enabled ? this._isHost : true }

  get peers() { return this._peers }

  /** Server time in ms, best estimate. Falls back to local time offline. */
  serverNow() { return Date.now() + this._clockOffset }

  onPeerJoin(cb) { if (typeof cb === 'function') this._onJoin.push(cb) }
  onPeerLeave(cb) { if (typeof cb === 'function') this._onLeave.push(cb) }
  onEvent(cb) { if (typeof cb === 'function') this._onEvent.push(cb) }
  /** Connection status text for the HUD: 'connecting'|'online'|'host'|'offline'|a message. */
  onStatus(cb) { if (typeof cb === 'function') this._onStatus.push(cb) }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * Where the relay lives.
   *
   *   1. `?ws=` — an explicit override, for testing against another host.
   *   2. Served from the website (`/games/billy-bob/`) — the relay is mounted on
   *      that same origin at `/ws/bb`. It has to be the same origin: the page is
   *      https and a ws:// dial to another port is blocked as mixed content.
   *   3. Otherwise a LAN server on the default port.
   */
  _url() {
    let host = 'localhost'
    let secure = false
    try {
      if (typeof location !== 'undefined' && location.hostname) {
        host = location.hostname
        secure = location.protocol === 'https:'
        const proto = secure ? 'wss' : 'ws'

        const override = new URLSearchParams(location.search).get('ws')
        if (override) return override

        if (location.pathname.startsWith('/games/billy-bob')) {
          return `${proto}://${location.host}/ws/bb`
        }
        if (location.port && Number(location.port) !== DEFAULT_PORT) {
          return `${proto}://${location.host}/ws/bb`
        }
      }
    } catch {
      /* non-browser context — fall through to localhost */
    }
    return `${secure ? 'wss' : 'ws'}://${host}:${DEFAULT_PORT}/ws/bb`
  }

  /** Open a socket. Resolves when it is open; rejects with a child-safe message. */
  _connect() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('This computer cannot connect to other players.'))
        return
      }
      this.disconnect(true)
      this._closing = false

      let ws
      try {
        ws = new WebSocket(this._url())
      } catch {
        reject(new Error('Could not reach the game server.'))
        return
      }
      this._ws = ws

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* ignore */ }
        reject(new Error('Could not reach the game server.'))
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._emitStatus('connecting')
        resolve()
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Could not reach the game server.'))
      }
      ws.onclose = () => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new Error('Could not reach the game server.'))
          return
        }
        this._handleClose()
      }
      ws.onmessage = (ev) => this._handleMessage(ev)
    })
  }

  /**
   * Host a game.
   * @returns {Promise<string>} the 4-letter room code
   */
  async host(name = 'Billy Bob', char = 'billy', code = null) {
    this.name = String(name || 'Billy Bob').slice(0, 16)
    await this._connect()
    const room = await this._awaitAccept({ t: 'host', name: this.name, char, code })
    this._isHost = true
    this._enabled = true
    this._emitStatus('host')
    return room
  }

  /**
   * Join an existing game.
   * @param {string} code 4 letters, case-insensitive
   * @param {{create?: boolean}} [opts] `create` opens the room if it does not
   *   exist yet. That is what makes a lobby-arranged match race-free: everyone
   *   navigates at once holding the same code and whichever socket arrives first
   *   opens the room instead of erroring with "no game found".
   */
  async join(code, char = 'billy', opts = {}) {
    const clean = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
    if (clean.length !== 4) throw new Error('A game code is 4 letters, like BANJ.')
    await this._connect()
    await this._awaitAccept({
      t: 'join', code: clean, name: this.name, char, create: !!opts.create,
    })
    this._isHost = false
    this._enabled = true
    this._emitStatus('online')
    return this.roomCode
  }

  /** Send a host/join request and wait for the server's verdict. */
  _awaitAccept(msg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._joinReject) return
        this._joinResolve = this._joinReject = null
        this.disconnect(true)
        reject(new Error('The game server did not answer. Try again.'))
      }, CONNECT_TIMEOUT_MS)
      const r = resolve
      const j = reject
      this._joinResolve = (v) => { clearTimeout(timer); r(v) }
      this._joinReject = (e) => { clearTimeout(timer); j(e) }
      this._raw(msg)
    })
  }

  /** Close the socket and drop cleanly back to single-player. */
  disconnect(silent = false) {
    const ws = this._ws
    this._closing = true
    this._ws = null
    if (ws) {
      try { if (ws.readyState === 1) ws.send('{"t":"leave"}') } catch { /* ignore */ }
      try {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        ws.close()
      } catch { /* ignore */ }
    }
    if (silent) {
      this._peers.length = 0
      this._peerById.clear()
    } else {
      this._teardownPeers()
    }
    this._enabled = false
    this._isHost = false
    this.roomCode = null
    this._lastSent.valid = false
    this._lastWorld.valid = false
    if (!silent) this._emitStatus('offline')
  }

  /** Socket died on its own — go quiet, keep playing. */
  _handleClose() {
    if (!this._enabled && !this._peers.length) {
      this._ws = null
      return
    }
    this._ws = null
    this._teardownPeers()
    this._enabled = false
    this._isHost = false
    this.roomCode = null
    this._lastSent.valid = false
    this._lastWorld.valid = false
    this._emitStatus('offline')
  }

  _teardownPeers() {
    for (let i = this._peers.length - 1; i >= 0; i--) this._fire(this._onLeave, this._peers[i])
    this._peers.length = 0
    this._peerById.clear()
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /** Raw send — silently drops if there is no open socket. */
  _raw(obj) {
    const ws = this._ws
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  /**
   * Fire a one-shot game event to every other peer.
   * Does NOT loop back locally — the caller already knows it happened.
   */
  sendEvent(type, payload = null) {
    if (!this._enabled || typeof type !== 'string') return
    this._eventMsg.e = type
    this._eventMsg.d = payload
    this._raw(this._eventMsg)
    this._eventMsg.d = null // don't pin the payload alive
  }

  _handleMessage(ev) {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return
    }
    if (!msg || typeof msg.t !== 'string') return

    try {
      switch (msg.t) {
        case 'welcome':
          this.id = msg.id | 0
          if (typeof msg.now === 'number') this._clockOffset = msg.now - Date.now()
          break

        case 'hosted':
        case 'joined': {
          this.id = msg.id | 0
          this.index = msg.index | 0
          this.roomCode = msg.code || null
          this._out.i = this.index
          this._isHost = !!msg.host
          if (Array.isArray(msg.peers)) for (const p of msg.peers) this._addPeer(p)
          const res = this._joinResolve
          this._joinResolve = this._joinReject = null
          if (res) res(this.roomCode)
          break
        }

        case 'error': {
          const rej = this._joinReject
          this._joinResolve = this._joinReject = null
          const err = new Error(msg.msg || 'Could not join that game.')
          err.code = msg.code || 'ERROR'
          if (rej) {
            this.disconnect(true)
            rej(err)
          } else {
            this._emitStatus(err.message)
          }
          break
        }

        case 'peerJoin':
          if (msg.peer) this._addPeer(msg.peer)
          break

        case 'leave':
          this._removePeer(msg.id | 0)
          break

        case 'hostChange':
          this._isHost = (msg.id | 0) === this.id
          this._lastWorld.valid = false
          this._emitStatus(this._isHost ? 'host' : 'online')
          break

        case 'state':
          if (msg.s) this._ingestState(msg.s)
          break

        case 'world':
          if (msg.s && !this._isHost) this._applyWorld(msg.s)
          break

        case 'event':
          this._fireEvent(msg.e, msg.d, msg.from | 0)
          break

        case 'pong': {
          const sent = this._pingSentAt.get(msg.c)
          if (sent !== undefined) {
            this._pingSentAt.delete(msg.c)
            const rtt = Date.now() - sent
            // Keep the offset from the lowest-latency sample we have seen; let
            // "best" decay slowly so we still track real clock drift.
            if (rtt <= this._bestRtt || this._bestRtt === Infinity) {
              this._bestRtt = rtt
              this._clockOffset = msg.now + rtt * 0.5 - Date.now()
            }
            this._bestRtt += 1
          }
          break
        }

        default:
          break
      }
    } catch {
      // A malformed peer must never break the frame loop.
    }
  }

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  _addPeer(info) {
    const id = info.id | 0
    if (!id || id === this.id) return null
    if (this._peerById.has(id)) return this._peerById.get(id)
    if (this._peers.length >= MAX_NET_PLAYERS - 1) return null

    const buf = new Array(BUFFER_MAX)
    for (let i = 0; i < BUFFER_MAX; i++) buf[i] = makeSnap()

    const index = typeof info.index === 'number' ? info.index : this._peers.length + 1
    const peer = {
      id,
      name: typeof info.name === 'string' ? info.name : 'Player',
      char: typeof info.char === 'string' ? info.char : null,
      index,
      state: makeState(index),
      player: null, // integrator assigns a RemotePlayer here
      _buf: buf,
      _n: 0,
      _head: 0,
      _lastT: 0,
    }
    this._peers.push(peer)
    this._peerById.set(id, peer)
    this._fire(this._onJoin, peer)
    return peer
  }

  _removePeer(id) {
    const peer = this._peerById.get(id)
    if (!peer) return
    this._peerById.delete(id)
    const i = this._peers.indexOf(peer)
    if (i >= 0) this._peers.splice(i, 1)
    this._fire(this._onLeave, peer)
  }

  /** @returns {object|null} the peer with this client id. */
  peerById(id) {
    return this._peerById.get(id | 0) || null
  }

  /** Push a remote player state into that peer's interpolation buffer. */
  _ingestState(s) {
    const id = s.id | 0
    let peer = this._peerById.get(id)
    if (!peer) {
      // A state arriving before its peerJoin (or after a reconnect) still counts.
      peer = this._addPeer({ id, name: 'Player', char: s.char, index: s.i })
      if (!peer) return
    }
    if (typeof s.char === 'string' && s.char !== peer.char) peer.char = s.char
    if (typeof s.i === 'number') peer.index = s.i

    const t = typeof s.t === 'number' ? s.t : this.serverNow()
    if (t < peer._lastT) return // out-of-order packet: the newer one already won
    peer._lastT = t

    const snap = peer._buf[peer._head]
    const p = s.p
    const v = s.v
    snap.t = t
    snap.px = p ? +p[0] || 0 : 0
    snap.py = p ? +p[1] || 0 : 0
    snap.pz = p ? +p[2] || 0 : 0
    snap.yaw = +s.r || 0
    snap.vx = v ? +v[0] || 0 : 0
    snap.vy = v ? +v[1] || 0 : 0
    snap.vz = v ? +v[2] || 0 : 0
    snap.s = typeof s.s === 'string' ? s.s : 'idle'
    snap.melt = +s.melt || 0
    snap.fork = Number.isFinite(s.fork) ? s.fork | 0 : -1
    snap.fx = +s.fx || 0
    snap.fz = +s.fz || 0
    snap.fh = +s.fh || 0
    snap.fl = +s.fl || 0

    peer._head = (peer._head + 1) % BUFFER_MAX
    if (peer._n < BUFFER_MAX) peer._n++
  }

  /** Snapshot `k` back from the newest (0 = newest). */
  _snapAt(peer, k) {
    const idx = (peer._head - 1 - k + BUFFER_MAX * 2) % BUFFER_MAX
    return peer._buf[idx]
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt, ctx) {
    if (!this._enabled) return
    const c = ctx || this.ctx
    if (!c) return

    try {
      // --- clock sync -------------------------------------------------------
      this._pingAcc += dt
      if (this._pingAcc >= PING_DT) {
        this._pingAcc = 0
        const seq = this._pingSeq++
        this._pingSentAt.set(seq, Date.now())
        if (this._pingSentAt.size > 8) {
          const first = this._pingSentAt.keys().next()
          if (!first.done) this._pingSentAt.delete(first.value)
        }
        this._pingMsg.c = seq
        this._raw(this._pingMsg)
      }

      // --- outbound: local player at 20 Hz, only when it moved --------------
      this._sendAcc += dt
      if (this._sendAcc >= SEND_DT) {
        this._sendAcc = 0
        this._sendLocalState(c)
      }

      // --- outbound: the shared world, host only ---------------------------
      if (this._isHost) {
        this._worldAcc += dt
        this._sendWorld(c, this._worldAcc >= WORLD_DT)
        if (this._worldAcc >= WORLD_DT) this._worldAcc = 0
      }

      // --- inbound: interpolate every remote player -------------------------
      const renderTime = this.serverNow() - INTERP_DELAY_MS
      for (let i = 0; i < this._peers.length; i++) this._interpolate(this._peers[i], renderTime)
    } catch {
      // The network must never take the frame loop down with it.
    }
  }

  /**
   * The player whose state we broadcast.
   *
   * Online play is one human per browser: `ctx.players[0]`. Split-screen and
   * online are deliberately not combined — two local players sharing one socket
   * would need two outbound streams and two seats in the room, and the join
   * screen offers it as an either/or for exactly that reason.
   */
  _localPlayer(ctx) {
    const list = (ctx || this.ctx || {}).players
    if (!list) return null
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].isLocal !== false) return list[i]
    }
    return null
  }

  /** Read the local player's state and put it on the wire if it changed enough. */
  _sendLocalState(ctx) {
    const player = this._localPlayer(ctx)
    if (!player || typeof player.getNetState !== 'function') return
    const s = player.getNetState()
    if (!s) return

    const p = s.p
    const v = s.v
    const px = p ? p[0] : 0
    const py = p ? p[1] : 0
    const pz = p ? p[2] : 0
    const yaw = s.r || 0
    const anim = s.s || 'idle'
    const char = s.char || null

    const last = this._lastSent
    if (last.valid) {
      const moved =
        Math.abs(px - last.px) > POS_EPS ||
        Math.abs(py - last.py) > POS_EPS ||
        Math.abs(pz - last.pz) > POS_EPS ||
        Math.abs(angleDelta(last.yaw, yaw)) > YAW_EPS ||
        anim !== last.s ||
        char !== last.char ||
        Math.abs((s.melt || 0) - last.melt) > 0.02 ||
        (s.fork | 0) !== last.fork
      if (!moved) return
    }

    const out = this._out
    out.i = this.index
    out.p[0] = px
    out.p[1] = py
    out.p[2] = pz
    out.r = yaw
    out.v[0] = v ? v[0] : 0
    out.v[1] = v ? v[1] : 0
    out.v[2] = v ? v[2] : 0
    out.s = anim
    out.char = char
    out.melt = s.melt || 0
    out.fork = s.fork | 0
    out.fx = s.fx || 0
    out.fz = s.fz || 0
    out.fh = s.fh || 0
    out.fl = s.fl || 0
    out.t = this.serverNow() // the server restamps this authoritatively

    if (!this._raw(this._outMsg)) return

    last.px = px
    last.py = py
    last.pz = pz
    last.yaw = yaw
    last.s = anim
    last.char = char
    last.melt = s.melt || 0
    last.fork = s.fork | 0
    last.valid = true
  }

  /**
   * Host-authoritative world push.
   *
   * Discrete things (the chip count, the band roster, who has Big Earl) go out
   * the instant they change; everything else rides the 5 Hz tick.
   */
  _sendWorld(ctx, tick) {
    const world = ctx.world
    if (!world || typeof world.getNetState !== 'function') return
    const s = world.getNetState()
    if (!s) return

    const lw = this._lastWorld
    const bandKey = s.band ? Object.keys(s.band).sort().join(',') : ''
    const changed =
      !lw.valid ||
      s.chips !== lw.chips ||
      (s.taken ? s.taken.length : 0) !== lw.taken ||
      bandKey !== lw.band ||
      (s.fork ? s.fork.driver : -1) !== lw.driver

    if (!changed && !tick) return

    this._worldMsg.s = s
    const ok = this._raw(this._worldMsg)
    this._worldMsg.s = null
    if (!ok) return

    lw.chips = s.chips
    lw.taken = s.taken ? s.taken.length : 0
    lw.band = bandKey
    lw.driver = s.fork ? s.fork.driver : -1
    lw.valid = true
  }

  _applyWorld(s) {
    const w = this.ctx && this.ctx.world
    if (w && typeof w.applyNetState === 'function') {
      try { w.applyNetState(s) } catch { /* a bad snapshot must not stop the game */ }
    }
  }

  /**
   * Fill `peer.state` with the value for `renderTime`, then hand it to the
   * peer's RemotePlayer if one has been attached.
   */
  _interpolate(peer, renderTime) {
    const n = peer._n
    const st = peer.state
    if (n === 0) return

    const newest = this._snapAt(peer, 0)

    if (n === 1 || renderTime >= newest.t) {
      // Ahead of the newest snapshot: dead-reckon, then freeze.
      const ahead = clamp(renderTime - newest.t, 0, MAX_EXTRAP_MS) / 1000
      st.p[0] = newest.px + newest.vx * ahead
      st.p[1] = newest.py + newest.vy * ahead
      st.p[2] = newest.pz + newest.vz * ahead
      st.r = newest.yaw
      st.v[0] = newest.vx
      st.v[1] = newest.vy
      st.v[2] = newest.vz
      st.s = newest.s
      st.melt = newest.melt
      st.fork = newest.fork
      st.fx = newest.fx
      st.fz = newest.fz
      st.fh = newest.fh
      st.fl = newest.fl
    } else {
      // Find the pair that straddles renderTime (newest-first walk; the buffer
      // is short and almost always hits on the first or second step).
      let hi = newest
      let lo = null
      for (let k = 1; k < n; k++) {
        const s = this._snapAt(peer, k)
        if (s.t <= renderTime) { lo = s; break }
        hi = s
      }
      if (!lo) {
        lo = this._snapAt(peer, n - 1)
        hi = lo
      }
      const span = hi.t - lo.t
      const a = span > 0 ? clamp((renderTime - lo.t) / span, 0, 1) : 1
      st.p[0] = lerp(lo.px, hi.px, a)
      st.p[1] = lerp(lo.py, hi.py, a)
      st.p[2] = lerp(lo.pz, hi.pz, a)
      st.r = lo.yaw + angleDelta(lo.yaw, hi.yaw) * a // short way around
      st.v[0] = lerp(lo.vx, hi.vx, a)
      st.v[1] = lerp(lo.vy, hi.vy, a)
      st.v[2] = lerp(lo.vz, hi.vz, a)
      st.s = a < 0.5 ? lo.s : hi.s
      st.melt = lerp(lo.melt, hi.melt, a)
      // The forklift interpolates with its driver, or the mast visibly stutters
      // at 5 Hz while the driver's head glides at 20.
      st.fork = hi.fork
      st.fx = lerp(lo.fx, hi.fx, a)
      st.fz = lerp(lo.fz, hi.fz, a)
      st.fh = lo.fh + angleDelta(lo.fh, hi.fh) * a
      st.fl = lerp(lo.fl, hi.fl, a)
    }

    st.i = peer.index
    st.char = peer.char
    st.t = renderTime

    const rp = peer.player
    if (rp && typeof rp.applyNetState === 'function') {
      try { rp.applyNetState(st) } catch { /* a remote avatar glitch must not stop the frame */ }
    }
  }

  // -------------------------------------------------------------------------
  // Callback plumbing
  // -------------------------------------------------------------------------

  _fire(list, arg) {
    for (let i = 0; i < list.length; i++) {
      try { list[i](arg) } catch { /* a listener must never break the net loop */ }
    }
  }

  _fireEvent(type, payload, from) {
    if (typeof type !== 'string') return
    for (let i = 0; i < this._onEvent.length; i++) {
      try { this._onEvent[i](type, payload, from) } catch { /* ignore */ }
    }
  }

  _emitStatus(s) {
    for (let i = 0; i < this._onStatus.length; i++) {
      try { this._onStatus[i](s) } catch { /* ignore */ }
    }
  }

  dispose() {
    this.disconnect()
    this._onJoin.length = 0
    this._onLeave.length = 0
    this._onEvent.length = 0
    this._onStatus.length = 0
    this._pingSentAt.clear()
  }
}
