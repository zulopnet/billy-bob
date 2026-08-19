// game/PvpDuel.js — one player against another.
//
// Press X on somebody who is not a critter and this is what happens. It is the
// same call-and-response shape as Duel.js and a completely different game:
//
//   * The phrase is IMPROVISED, not generated. Whoever is calling plays however
//     many notes the round asks for, on whatever strings they like, and the
//     other one has to play it straight back.
//   * Then they swap. The caller becomes the echo and the echo becomes the
//     caller, and the phrase gets one note longer.
//   * It goes on until somebody runs out of strings.
//
// WHERE THIS DIFFERS FROM THE CRITTER DUEL, AND WHY.
//
// A critter duel cannot be lost, on purpose — losing to the game is miserable
// and there is nothing to be gained from it. Losing to your brother is a
// completely different thing: it is the entire point, he is right there, and
// you can immediately play again. So this one has a loser.
//
// It is still padded to within an inch of its life. Each player has three
// strings, not one. A caller who freezes is never punished — the clock running
// out on a CALL plays a note for them and moves on, because a small child
// staring at four buttons with everybody watching is the one failure state that
// actually stops the game. Only the ECHO can cost you a string.
//
// NETWORKING. Notes are the only input this machine has, so both clients run
// the identical state machine and feed it the identical note stream: local
// presses go in directly and are relayed, remote ones arrive as events and go
// in the same way. The one thing that is not a note is a timeout, so exactly
// one side owns those — `authority`, which is the player who started the duel.
// Everything else is derived, and the two copies cannot drift apart.

import { STRING_COLORS } from '../core/Audio.js'
import { NoteMotes } from './NoteMotes.js'

/** Strings each player starts with. Three, so one slip is never the duel. */
export const START_STRINGS = 3

/** Notes in the first round, and the most it ever grows to. */
const FIRST_ROUND = 1
const MAX_ROUND = 6

/** Seconds a player gets per note before the clock runs out. Generous. */
const CALL_TIME = 7.0
const ECHO_TIME = 6.0

/** Dwell times, in seconds. */
const INTRO_TIME = 2.4
const HANDOVER_TIME = 1.4
const RESULT_TIME = 1.6
const WON_TIME = 3.4

export const PVP_STATE = {
  INTRO: 'intro',
  CALL: 'call',
  HANDOVER: 'handover',
  ECHO: 'echo',
  GOOD: 'good',
  MISS: 'miss',
  WON: 'won',
  DONE: 'done',
}

export class PvpDuel {
  /**
   * @param {object} opts
   * @param {object} opts.a the challenger — the one who pressed X
   * @param {object} opts.b the challenged
   *   Each side is `{ key, name, accent, local, slot, netId }`. `local` decides
   *   whether this client reads a gamepad for them or waits for the wire.
   * @param {import('../core/Audio.js').Audio} opts.audio
   * @param {THREE.Scene} opts.scene
   * @param {boolean} opts.authority true on the one client that owns timeouts
   * @param {(note:number, side:number) => void} [opts.onLocalNote] called for
   *   every note a LOCAL player strikes, so Game can relay it
   */
  constructor({ a, b, audio, scene, authority = true, onLocalNote = null }) {
    this.sides = [a, b]
    this.audio = audio
    this.authority = !!authority
    this.onLocalNote = onLocalNote

    this.state = PVP_STATE.INTRO
    this.timer = INTRO_TIME

    /** Index into `sides` of whoever is calling this round. */
    this.caller = 0
    this.roundLength = FIRST_ROUND
    this.roundIndex = 0

    /** The improvised phrase for this round, as it is played. */
    this.phrase = []
    /** How far the echoing player has got through it. */
    this.progress = 0

    this.strings = [START_STRINGS, START_STRINGS]
    /** Set once somebody has run out. */
    this.winner = -1
    this.loser = -1

    /** Which string is lit right now, and which side struck it. */
    this.litString = -1
    this.litSide = -1
    this._litFor = 0

    /** One-frame events, drained by Game every update. */
    this.events = []

    this._motes = new NoteMotes(scene)
    this._clock = 0
  }

  /** The side whose turn it is, or -1 when nobody is being waited on. */
  get activeSide() {
    if (this.state === PVP_STATE.CALL) return this.caller
    if (this.state === PVP_STATE.ECHO) return 1 - this.caller
    return -1
  }

  /** The side that is listening rather than playing. */
  get waitingSide() {
    const a = this.activeSide
    return a < 0 ? -1 : 1 - a
  }

  /** Seconds left on the current turn's clock, for the HUD bar. */
  get clockLeft() {
    return Math.max(0, this._clock)
  }

  get clockTotal() {
    return this.state === PVP_STATE.CALL ? CALL_TIME : ECHO_TIME
  }

  _emit(type, data) {
    this.events.push({ type, ...data })
  }

  // -------------------------------------------------------------------------
  // Positions, for the motes
  // -------------------------------------------------------------------------

  /** Handed in by Game each frame; the duel knows nothing about the store. */
  setEndpoints(posA, posB) {
    // `from` is always the CALLER, so the motes fly the way the music does.
    if (this.caller === 0) this._motes.setEndpoints(posA, posB)
    else this._motes.setEndpoints(posB, posA)
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * The single entry point for a struck string, wherever it came from.
   *
   * @param {number} side 0 or 1
   * @param {number} note 0..3
   * @param {boolean} [fromNet] true when this arrived over the wire, which
   *   suppresses the relay so a note cannot echo around the room forever
   */
  pressNote(side, note, fromNet = false) {
    if (side !== 0 && side !== 1) return
    if (!(note >= 0 && note < 4)) return

    const active = this.activeSide
    if (active !== side) {
      // Out of turn. It still SOUNDS — the same reason the critter duel lets you
      // play along: buttons that go dead read as a broken game, and every string
      // is consonant with every other so it can only ever sound like music.
      this.audio.playString(note, { gain: 0.32 })
      this._emit('idleNote', { note, side })
      if (!fromNet && this.sides[side].local && this.onLocalNote) {
        // Relayed anyway, so the other screen sees the same flash. It changes
        // nothing about the duel's state on either side.
        this.onLocalNote(note, side)
      }
      return
    }

    if (!fromNet && this.sides[side].local && this.onLocalNote) this.onLocalNote(note, side)

    this.litString = note
    this.litSide = side
    this._litFor = 0.3
    this._motes.spawn(note, side === this.caller ? 'from' : 'to')

    if (this.state === PVP_STATE.CALL) this._callNote(note, side)
    else this._echoNote(note, side)
  }

  _callNote(note, side) {
    this.audio.playString(note, { gain: 0.95 })
    this.phrase.push(note)
    this._emit('callNote', { note, side, index: this.phrase.length - 1 })
    this._clock = CALL_TIME

    if (this.phrase.length >= this.roundLength) {
      this.state = PVP_STATE.HANDOVER
      this.timer = HANDOVER_TIME
      this._emit('callDone', { side })
    }
  }

  _echoNote(note, side) {
    const want = this.phrase[this.progress]
    const correct = note === want
    this._emit('echoNote', { note, side, correct, index: this.progress })

    if (!correct) {
      this.audio.duelMiss()
      this._loseString(side)
      return
    }

    this.audio.duelHit(note, 0, this.progress)
    this.progress++
    this._clock = ECHO_TIME

    if (this.progress >= this.phrase.length) {
      // Echoed the whole thing. Roles swap and the phrase grows.
      this.state = PVP_STATE.GOOD
      this.timer = RESULT_TIME
      this.audio.roundWin()
      this._emit('echoDone', { side })
    }
  }

  /** Take a string off a player and decide whether that ended it. */
  _loseString(side) {
    this.strings[side] = Math.max(0, this.strings[side] - 1)
    this._emit('lostString', { side, left: this.strings[side] })

    if (this.strings[side] <= 0) {
      this.loser = side
      this.winner = 1 - side
      this.state = PVP_STATE.WON
      this.timer = WON_TIME
      this.audio.duelWin()
      this._emit('won', { winner: this.winner, loser: this.loser })
      return
    }
    this.state = PVP_STATE.MISS
    this.timer = RESULT_TIME
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @returns {string} the current state
   */
  update(dt) {
    this.events.length = 0
    this._motes.update(dt)

    if (this._litFor > 0) {
      this._litFor -= dt
      if (this._litFor <= 0) { this.litString = -1; this.litSide = -1 }
    }

    switch (this.state) {
      case PVP_STATE.INTRO:
        this.timer -= dt
        if (this.timer <= 0) this._startCall()
        break

      case PVP_STATE.CALL:
        this._clock -= dt
        // A CALL timeout is answered by playing a note for the player who
        // froze, and the client that OWNS that player is the one that does it.
        //
        // Not `authority`: if the far machine filled in a note for a local
        // player at the same moment that player finally pressed a button, two
        // notes would enter the phrase in different orders on the two screens
        // and the duels would quietly diverge. Letting each client speak only
        // for its own player removes the race rather than narrowing it — and
        // the note then travels the ordinary relay path, like any other.
        if (this._clock <= 0 && this.sides[this.caller].local) this._timeout()
        break

      case PVP_STATE.ECHO:
        this._clock -= dt
        // An ECHO timeout costs a string, which is a scoring decision, so it
        // stays with the single authority. Two machines deciding that
        // independently is how a duel ends with different winners.
        if (this._clock <= 0 && this.authority) this._timeout()
        break

      case PVP_STATE.HANDOVER:
        this.timer -= dt
        if (this.timer <= 0) this._startEcho()
        break

      case PVP_STATE.GOOD:
        this.timer -= dt
        if (this.timer <= 0) {
          this.caller = 1 - this.caller
          this.roundIndex++
          this.roundLength = Math.min(MAX_ROUND, this.roundLength + 1)
          this._startCall()
        }
        break

      case PVP_STATE.MISS:
        this.timer -= dt
        if (this.timer <= 0) {
          // A missed echo hands the call to the player who just won the exchange,
          // and the phrase does NOT grow. Losing a string is enough.
          this.caller = 1 - this.caller
          this._startCall()
        }
        break

      case PVP_STATE.WON:
        this.timer -= dt
        if (this.timer <= 0) this.state = PVP_STATE.DONE
        break

      default:
        break
    }

    return this.state
  }

  /**
   * The clock ran out.
   *
   * On a CALL this is not a mistake and never costs anything: a note is played
   * for the player who froze and the round carries on. On an ECHO it costs a
   * string, exactly as a wrong note would.
   */
  _timeout() {
    if (this.state === PVP_STATE.CALL) {
      const side = this.caller
      const note = (Math.random() * 4) | 0
      this._emit('timeoutNote', { side, note })
      // Played as an ordinary local note, which means it relays itself.
      this.pressNote(side, note)
      return
    }
    const side = 1 - this.caller
    this.audio.duelMiss()
    this._emit('timedOut', { side })
    this._loseString(side)
  }

  _startCall() {
    this.state = PVP_STATE.CALL
    this.phrase = []
    this.progress = 0
    this._clock = CALL_TIME
    this._emit('callStart', { side: this.caller, length: this.roundLength })
  }

  _startEcho() {
    this.state = PVP_STATE.ECHO
    this.progress = 0
    this._clock = ECHO_TIME
    this._emit('echoStart', { side: 1 - this.caller })
  }

  // -------------------------------------------------------------------------

  /** Colours for the HUD's phrase pips. */
  pipColors() {
    return this.phrase.map((n) => STRING_COLORS[n])
  }

  dispose() {
    this._motes.dispose()
  }
}
