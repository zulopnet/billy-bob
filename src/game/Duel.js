// game/Duel.js — the banjo duel: call, and response.
//
// A critter plays a phrase of coloured notes; you play it back on the four
// face buttons. Three or four rounds, each one note longer than the last.
//
// THE CENTRAL DESIGN RULE: you cannot lose a duel.
//
// A wrong note does not end anything. It makes a funny slide-whistle noise,
// the critter shrugs, and the SAME phrase is played again. Get it wrong three
// times in a row and the phrase quietly gets one note shorter until you can do
// it. A five-year-old will absolutely hit the wrong button, repeatedly, and a
// game that punishes that gets switched off. What's left to actually play for
// is the star: a round cleared with no mistakes at all is worth a gold one, and
// that turns out to be plenty of stakes for anybody.
//
// The other rule: every note is consonant with every other note (see STRINGS in
// Audio.js), so a child mashing all four buttons at once is rewarded with a
// chord rather than a car crash.

import { makePhrase } from '../core/Audio.js'
import { NoteMotes } from './NoteMotes.js'

/** How long each note of the critter's phrase is held, in seconds. */
const CALL_NOTE = 0.42
/** Gap after the call before the player's turn opens. */
const CALL_TAIL = 0.5
/**
 * Seconds allowed per note in the response. Deliberately enormous — this is a
 * safety net for a controller put down mid-round, not a challenge.
 */
const RESPONSE_TIME = 4.5
/** Wrong answers in a row before the phrase gets easier. */
const MERCY_AFTER = 3

export const DUEL_STATE = {
  INTRO: 'intro',
  CALL: 'call',
  RESPONSE: 'response',
  ROUND_WON: 'roundWon',
  MISTAKE: 'mistake',
  WON: 'won',
  DONE: 'done',
}

export class Duel {
  /**
   * @param {object} critter one of CRITTERS from chars/Rigs.js
   * @param {import('../core/Audio.js').Audio} audio
   * @param {THREE.Scene} scene for the floating note motes
   * @param {() => number} [rand]
   */
  constructor(critter, audio, scene, rand = Math.random) {
    this.critter = critter
    this.audio = audio
    this.scene = scene
    this.rand = rand

    this.state = DUEL_STATE.INTRO
    this.roundIndex = 0
    this.rounds = critter.rounds
    this.phrase = []
    this.progress = 0
    this.mistakes = 0
    this.consecutiveMistakes = 0
    this.perfectRounds = 0
    this._roundClean = true

    this.timer = 1.9 // intro dwell
    this.callIndex = -1
    this.responseLeft = 0
    this._litFor = 0
    this._callDone = false

    /** Set each frame: which string is lit, and by whom. -1 for none. */
    this.litString = -1
    this.litBy = null

    /** One-frame flags the HUD and the rigs read. */
    this.events = []

    this._motes = new NoteMotes(scene)

    this._makeRound()
  }

  get totalRounds() {
    return this.rounds.length
  }

  /** 0..1 through the whole duel, for the HUD bar. */
  get overallProgress() {
    return (this.roundIndex + (this.state === DUEL_STATE.ROUND_WON ? 1 : 0)) / this.rounds.length
  }

  _makeRound() {
    let length = this.rounds[Math.min(this.roundIndex, this.rounds.length - 1)]
    // Mercy: after enough wrong answers the phrase shortens, floor of two.
    const mercy = Math.floor(this.consecutiveMistakes / MERCY_AFTER)
    length = Math.max(2, length - mercy)
    this.phrase = makePhrase(length, this.rand)
    this.progress = 0
    this._roundClean = true
  }

  _emit(type, data) {
    this.events.push({ type, ...data })
  }

  /** Begin playing the phrase at the player. */
  _startCall() {
    this.state = DUEL_STATE.CALL
    this.callIndex = -1
    this._callDone = false
    this.timer = 0.25
    this._emit('callStart')
  }

  _startResponse() {
    this.state = DUEL_STATE.RESPONSE
    this.progress = 0
    this.responseLeft = RESPONSE_TIME * this.phrase.length
    this.litString = -1
    this._emit('responseStart')
  }

  /**
   * @param {number} dt
   * @param {object} input InputState for slot 0
   * @returns {string} the current state
   */
  update(dt, input) {
    this.events.length = 0
    this._updateMotes(dt)

    // The lit string decays back to nothing so a flash reads as a flash.
    if (this._litFor > 0) {
      this._litFor -= dt
      if (this._litFor <= 0) this.litString = -1
    }

    // Outside the player's turn the strings still SOUND, they just don't count.
    //
    // A five-year-old holds a controller and presses things. If the buttons go
    // dead for the four seconds the critter is playing, the game reads as
    // broken — and worse, they learn that the buttons sometimes do nothing.
    // Letting the note ring quietly costs nothing (every string is consonant
    // with the phrase being played) and keeps the banjo feeling like an
    // instrument rather than a quiz.
    if (this.state !== DUEL_STATE.RESPONSE) this._idleStrum(input)

    switch (this.state) {
      case DUEL_STATE.INTRO:
        this.timer -= dt
        if (this.timer <= 0) this._startCall()
        break

      case DUEL_STATE.CALL:
        this._updateCall(dt)
        break

      case DUEL_STATE.RESPONSE:
        this._updateResponse(dt, input)
        break

      case DUEL_STATE.MISTAKE:
        this.timer -= dt
        if (this.timer <= 0) this._startCall()
        break

      case DUEL_STATE.ROUND_WON:
        this.timer -= dt
        if (this.timer <= 0) {
          this.roundIndex++
          if (this.roundIndex >= this.rounds.length) {
            this.state = DUEL_STATE.WON
            this.timer = 2.6
            this.audio.duelWin()
            this._emit('won')
          } else {
            this.consecutiveMistakes = 0
            this._makeRound()
            this._startCall()
          }
        }
        break

      case DUEL_STATE.WON:
        this.timer -= dt
        if (this.timer <= 0) this.state = DUEL_STATE.DONE
        break

      default:
        break
    }

    return this.state
  }

  /** Play a string for the feel of it, with no effect on the duel. */
  _idleStrum(input) {
    if (!input) return
    for (let i = 0; i < 4; i++) {
      const b = input[`string${i + 1}`]
      if (!b || !b.pressed) continue
      // Quieter than a scoring note, so the difference between "playing along"
      // and "your turn" is still audible.
      this.audio.playString(i, { gain: 0.45 })
      this._emit('idleNote', { note: i })
      break
    }
  }

  _updateCall(dt) {
    this.timer -= dt
    if (this.timer > 0) return

    // The tail is its own beat: the last note has to be allowed to RING before
    // the player's turn opens, or the phrase and the response run together and
    // it stops being call-and-response at all.
    if (this._callDone) {
      this._callDone = false
      this._startResponse()
      return
    }

    this.callIndex++
    if (this.callIndex >= this.phrase.length) {
      this._callDone = true
      this.timer = CALL_TAIL
      return
    }

    const note = this.phrase[this.callIndex]
    this.audio.playString(note, { voice: this.critter.voice, transpose: this.critter.transpose })
    this.litString = note
    this.litBy = 'critter'
    this._litFor = CALL_NOTE * 0.8
    this.timer = CALL_NOTE
    this.spawnMote(note, 'critter')
    this._emit('callNote', { note, index: this.callIndex })
  }

  _updateResponse(dt, input) {
    this.responseLeft -= dt

    // Timeout: treat it exactly like a wrong note. Nothing is lost, the phrase
    // simply gets played again.
    if (this.responseLeft <= 0) {
      this._miss(-1)
      return
    }

    // Which string, if any, was struck this frame. First one wins, so mashing
    // two at once is judged on one of them rather than counting as two.
    let pressed = -1
    for (let i = 0; i < 4; i++) {
      const b = input[`string${i + 1}`]
      if (b && b.pressed) { pressed = i; break }
    }
    if (pressed < 0) return

    const want = this.phrase[this.progress]
    this.litString = pressed
    this.litBy = 'player'
    this._litFor = 0.28
    this.spawnMote(pressed, 'player')
    this._emit('playerNote', { note: pressed, correct: pressed === want })

    if (pressed !== want) {
      this._miss(pressed)
      return
    }

    this.audio.duelHit(pressed, 0, this.progress)
    this.progress++

    if (this.progress >= this.phrase.length) {
      this.state = DUEL_STATE.ROUND_WON
      this.timer = 1.5
      this.consecutiveMistakes = 0
      if (this._roundClean) this.perfectRounds++
      this.audio.roundWin()
      this._emit('roundWon', { clean: this._roundClean })
    }
  }

  _miss(note) {
    this.mistakes++
    this.consecutiveMistakes++
    this._roundClean = false
    this.audio.duelMiss()
    this.state = DUEL_STATE.MISTAKE
    this.timer = 1.35
    this.progress = 0
    this._emit('missed', { note })

    // Mercy kicks in between attempts, never mid-phrase.
    if (this.consecutiveMistakes > 0 && this.consecutiveMistakes % MERCY_AFTER === 0) {
      const before = this.phrase.length
      this._makeRound()
      if (this.phrase.length < before) this._emit('mercy', { length: this.phrase.length })
    }
  }

  /** True if every round was cleared without a single wrong note. */
  get gotStar() {
    return this.mistakes === 0
  }

  // -------------------------------------------------------------------------
  // Note motes — the little coloured lights that fly between the two players
  // -------------------------------------------------------------------------

  /**
   * Positions are handed in by Game each frame (`setEndpoints`), because the
   * duel itself deliberately knows nothing about where anybody is standing.
   */
  setEndpoints(critterPos, playerPos) {
    this._motes.setEndpoints(critterPos, playerPos)
  }

  spawnMote(note, who) {
    this._motes.spawn(note, who === 'critter' ? 'from' : 'to')
  }

  _updateMotes(dt) {
    this._motes.update(dt)
  }

  /** Tear down the motes. Call when the duel ends, or they leak. */
  dispose() {
    this._motes.dispose()
  }
}
