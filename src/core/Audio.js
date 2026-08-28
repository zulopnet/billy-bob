// core/Audio.js — every sound in this game, generated from nothing, with one
// deliberate exception: the three backing beds. See BEDS below.
//
// Apart from those three loops there are no samples. Three things live in this
// module:
//
//   1. A Karplus-Strong plucked string, rendered offline into an AudioBuffer
//      and cached per pitch. This is what makes the chocolate banjo sound like
//      a banjo rather than like a sine wave: a banjo is a very bright, very
//      fast-decaying string over a drum head, which is exactly what a
//      short-loop KS with a gentle lowpass and a thump transient produces.
//
//   2. A lookahead step sequencer for the backing music. `setTimeout` is far
//      too jittery to place notes on a beat, so the timer only ever *schedules*
//      — every note is given an absolute `AudioContext.currentTime` and the
//      audio thread places it to the sample. Every bed still runs on this;
//      the store bed prefers a file and falls back to it.
//
//   3. A recorded-bed player, for the three backing loops.
//
// All melodies here are original. The duel phrases are generated at runtime
// from a pentatonic set (see PENTATONIC below), which is also why a child
// mashing buttons never produces a wrong-sounding note — every combination of
// the four strings is consonant.

const A4 = 440
const MIDI_A4 = 69

/** MIDI note number -> Hz. */
export function mtof(midi) {
  return A4 * Math.pow(2, (midi - MIDI_A4) / 12)
}

/**
 * The four banjo strings, as MIDI notes: G3 B3 D4 G4 — a G major triad plus
 * the octave. Every subset of these four notes is a consonant chord, so a
 * five-year-old hammering all four at once gets a G chord, not a car crash.
 *
 * Index order is left-to-right on screen and matches STRING_BUTTONS in
 * Input.js: 0 green/A, 1 red/B, 2 blue/X, 3 yellow/Y.
 */
export const STRINGS = [55, 59, 62, 67]

/** Colours for the four strings, shared by the HUD and the 3D note motes. */
export const STRING_COLORS = ['#57d96a', '#ef4a4a', '#4aa8ef', '#f5d130']
export const STRING_COLORS_HEX = [0x57d96a, 0xef4a4a, 0x4aa8ef, 0xf5d130]

/** G major pentatonic, two octaves, for the backing melodies. */
const PENTATONIC = [55, 57, 59, 62, 64, 67, 69, 71, 74, 76]

// ===========================================================================
// The recorded beds
// ===========================================================================
//
// The only samples in this game. Each is an ACE-Step 1.5 render — the prompts
// that produced them are in tools/music-spec.json — cut to a 16-bar region on a
// downbeat and wrap-crossfaded by tools/loopify.py so `loop = true` has no
// audible seam. A raw generation opens with an intro and closes with a
// fade-out, and seams badly every pass.
//
// All three are in G major, at the tempo of the pattern each replaces, and that
// is not cosmetic: STRINGS is a G major set and a duel plays those pitches
// straight over whatever bed is running, so a bed in another key makes every
// *correct* answer sound wrong.
//
// Vorbis first, because decodeAudioData hands back exactly the encoded sample
// count and the loop point stays sample-accurate; MP3 and AAC carry encoder
// padding that shows up as a tick at the wrap. The AAC files are only there for
// Safari, which will not decode Vorbis. Mono, because nothing in a bed is
// panned and stereo doubled the download for nothing.
//
// `gain` is measured, not guessed. Over 20s through the same graph the
// generated arrangements run -15.0 (store), -15.9 (duel) and -13.1 dB RMS
// (finale), and these files -17.0, -17.2 and -18.3. The numbers below put the
// store bed 2 dB under the arrangement it replaces — a continuous recording at
// equal RMS crowds the effects that play over it — and then hold the other two
// at their original level *relative to the store bed*, so the game keeps its
// dynamic arc: the duel drops back, the finale opens up.
const BEDS = {
  store: {
    bpm: 132,
    gain: 1.0,
    sources: [
      ['audio/ogg; codecs=vorbis', new URL('../audio/store-loop.ogg', import.meta.url).href],
      ['audio/mp4; codecs=mp4a.40.2', new URL('../audio/store-loop.m4a', import.meta.url).href],
    ],
  },
  duel: {
    bpm: 146,
    gain: 0.92,
    sources: [
      ['audio/ogg; codecs=vorbis', new URL('../audio/duel-loop.ogg', import.meta.url).href],
      ['audio/mp4; codecs=mp4a.40.2', new URL('../audio/duel-loop.m4a', import.meta.url).href],
    ],
  },
  finale: {
    bpm: 152,
    gain: 1.45,
    sources: [
      ['audio/ogg; codecs=vorbis', new URL('../audio/finale-loop.ogg', import.meta.url).href],
      ['audio/mp4; codecs=mp4a.40.2', new URL('../audio/finale-loop.m4a', import.meta.url).href],
    ],
  },
}

// ===========================================================================
// Karplus-Strong
// ===========================================================================

/**
 * Render one plucked note into a Float32Array.
 *
 * @param {number} sampleRate
 * @param {number} freq       fundamental, Hz
 * @param {number} seconds    buffer length
 * @param {object} [opts]
 * @param {number} [opts.decay]      per-sample loop gain; 0.999 rings, 0.99 plonks
 * @param {number} [opts.brightness] 0..1 — how much of the last sample carries
 *                                   over. Low = dull nylon, high = metallic banjo.
 * @param {number} [opts.thump]      amount of drum-head transient mixed in
 * @param {() => number} [opts.rand] noise source (kept injectable so the same
 *                                   note is bit-identical every time)
 */
function renderPluck(sampleRate, freq, seconds, opts = {}) {
  const decay = opts.decay ?? 0.9965
  const brightness = opts.brightness ?? 0.55
  const thump = opts.thump ?? 0.35
  const rand = opts.rand || Math.random

  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)

  // Delay line length sets the pitch. Fractional lengths would be more in tune
  // at high pitches; at the range this game plays in, rounding is inaudible.
  const N = Math.max(2, Math.round(sampleRate / freq))
  const line = new Float32Array(N)
  for (let i = 0; i < N; i++) line[i] = rand() * 2 - 1

  // A banjo's pick attack is brighter than white noise alone; pre-emphasise the
  // first few samples so the initial burst has a percussive edge.
  for (let i = 0; i < Math.min(N, 24); i++) line[i] *= 1.6

  let idx = 0
  let prev = 0
  // Drum-head thump: a fast sine sweep an octave and a half below, decaying in
  // ~60ms. This is the body of the instrument, and leaving it out is the single
  // biggest reason a naive KS sounds like a rubber band instead of a banjo.
  const thumpFreq = freq * 0.4
  const thumpDecay = Math.exp(-1 / (sampleRate * 0.055))
  let thumpAmp = thump
  let thumpPhase = 0
  const thumpStep = (2 * Math.PI * thumpFreq) / sampleRate

  for (let i = 0; i < n; i++) {
    const cur = line[idx]
    // One-pole averaging lowpass in the feedback path — the classic KS filter,
    // weighted so `brightness` controls how fast the highs bleed away.
    const filtered = brightness * cur + (1 - brightness) * prev
    prev = cur
    line[idx] = filtered * decay
    idx = (idx + 1) % N

    let s = cur
    if (thumpAmp > 1e-4) {
      s += Math.sin(thumpPhase) * thumpAmp
      thumpPhase += thumpStep
      thumpAmp *= thumpDecay
    }
    out[i] = s
  }

  // Fade the tail so a truncated buffer never clicks.
  const fade = Math.min(n, Math.floor(sampleRate * 0.03))
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade
  // And a 2ms fade-in, for the same reason at the head.
  const rise = Math.min(n, Math.floor(sampleRate * 0.002))
  for (let i = 0; i < rise; i++) out[i] *= i / rise

  return out
}

/** A tiny deterministic PRNG so a given pitch always renders identically. */
function seededRand(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Instrument voices. Each critter gets one, so you can hear who is playing
// before you can see them.
export const VOICES = {
  banjo: { decay: 0.9962, brightness: 0.62, thump: 0.4, seconds: 1.5, gain: 0.9 },
  // Ricky the raccoon plays a washboard-ish scratchy thing: shorter, duller.
  tin: { decay: 0.988, brightness: 0.75, thump: 0.15, seconds: 0.9, gain: 0.8 },
  // Doris the goat's mouth harp: long, nasal, very little thump.
  twang: { decay: 0.9978, brightness: 0.35, thump: 0.08, seconds: 2.0, gain: 0.85 },
  // Chilly Pete's icicle chimes: pure and long.
  glass: { decay: 0.9989, brightness: 0.2, thump: 0.02, seconds: 2.6, gain: 0.7 },
  // Meatball the pug's squeaky-toy bass: fat and short.
  thumpy: { decay: 0.991, brightness: 0.18, thump: 0.9, seconds: 1.1, gain: 1.0 },
  // Sir Reginald's tiny mandolin.
  mando: { decay: 0.9955, brightness: 0.7, thump: 0.22, seconds: 1.2, gain: 0.8 },
  // Big Earl the forklift: an air horn with a string in it. Earl is a vehicle
  // now and no longer duels, but the horn voice stays — it is what the forklift
  // actually sounds when you press the horn.
  horn: { decay: 0.9975, brightness: 0.5, thump: 0.7, seconds: 1.8, gain: 1.0 },
  // Wanda the owl's slide whistle: breathy, no thump at all, and it hangs in
  // the rafters long after the note is struck.
  whistle: { decay: 0.9984, brightness: 0.9, thump: 0.03, seconds: 2.2, gain: 0.75 },
}

// ===========================================================================
// The audio engine
// ===========================================================================

export class Audio {
  constructor() {
    this.ctx = null
    this.ready = false
    this.muted = false

    /** @type {Map<string, AudioBuffer>} `${voice}:${midi}` -> rendered pluck */
    this._plucks = new Map()

    this._master = null
    this._musicGain = null
    this._sfxGain = null
    this._bedGain = null

    // --- recorded bed state ------------------------------------------------
    /** @type {AudioBufferSourceNode|null} */
    this._bedSource = null
    /** @type {Map<string, Promise<AudioBuffer>>} */
    this._bedBuffers = new Map()
    /** Beds whose file would not load or decode — never retried. */
    this._bedFailed = new Set()
    /** Bumped on every music change, so a slow decode cannot start late. */
    this._bedToken = 0

    // --- sequencer state ---------------------------------------------------
    this._timer = null
    this._nextNoteTime = 0
    this._step = 0
    this._bpm = 132
    this._pattern = null
    this._patternName = null
    this._intensity = 1
  }

  /**
   * Create the AudioContext. MUST be called from inside a real user gesture or
   * every browser hands back a context stuck in 'suspended' — which is silent
   * but reports no error at all, and looks exactly like a bug in this file.
   */
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return false
      this.ctx = new Ctx()

      this._master = this.ctx.createGain()
      this._master.gain.value = 0.85
      this._master.connect(this.ctx.destination)

      this._musicGain = this.ctx.createGain()
      this._musicGain.gain.value = 0.32
      this._musicGain.connect(this._master)

      this._sfxGain = this.ctx.createGain()
      this._sfxGain.gain.value = 0.9
      this._sfxGain.connect(this._master)

      // The bed hangs off the music bus, so duckMusic() still ducks it.
      // One node for whichever bed is playing — only ever one at a time. Its
      // level is set per bed when that bed starts, from BEDS[name].gain.
      this._bedGain = this.ctx.createGain()
      this._bedGain.gain.value = 1
      this._bedGain.connect(this._musicGain)
    }
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume()
    } catch (e) {
      return false
    }
    this.ready = this.ctx.state === 'running'
    // Fetch and decode now rather than at the first setMusic() — unlock()
    // happens on the title screen, and a bed that arrives a second into play
    // is a bed that starts audibly late.
    if (this.ready) {
      for (const name of Object.keys(BEDS)) this._bedBuffer(name).catch(() => {})
    }
    return this.ready
  }

  setMuted(m) {
    this.muted = !!m
    if (this._master) {
      this._master.gain.setTargetAtTime(this.muted ? 0 : 0.85, this.ctx.currentTime, 0.05)
    }
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0
  }

  // -------------------------------------------------------------------------
  // Plucked notes
  // -------------------------------------------------------------------------

  /** Fetch (rendering on first use) the AudioBuffer for one pitch of one voice. */
  _pluckBuffer(voice, midi) {
    const key = `${voice}:${midi}`
    let buf = this._plucks.get(key)
    if (buf) return buf

    const spec = VOICES[voice] || VOICES.banjo
    const sr = this.ctx.sampleRate
    const data = renderPluck(sr, mtof(midi), spec.seconds, {
      decay: spec.decay,
      brightness: spec.brightness,
      thump: spec.thump,
      rand: seededRand(midi * 2654435761 + voice.length * 40503),
    })
    buf = this.ctx.createBuffer(1, data.length, sr)
    buf.copyToChannel(data, 0)
    this._plucks.set(key, buf)
    return buf
  }

  /**
   * Pluck a string.
   * @param {number} midi
   * @param {object} [opts] `{ voice, when, gain, pan, detune }`
   */
  pluck(midi, opts = {}) {
    if (!this.ready) return
    const voice = opts.voice || 'banjo'
    const spec = VOICES[voice] || VOICES.banjo
    const when = opts.when || this.ctx.currentTime

    const src = this.ctx.createBufferSource()
    src.buffer = this._pluckBuffer(voice, Math.round(midi))
    // Fractional pitch (and the tiny random detune below) rides on playbackRate;
    // re-rendering a buffer per cent of detune would be absurd.
    const cents = (midi - Math.round(midi)) * 100 + (opts.detune || 0)
    src.playbackRate.value = Math.pow(2, cents / 1200)

    const g = this.ctx.createGain()
    g.gain.value = (opts.gain ?? 1) * spec.gain

    let tail = g
    if (opts.pan !== undefined && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, opts.pan))
      g.connect(p)
      tail = p
    }

    src.connect(g)
    tail.connect(opts.bus === 'music' ? this._musicGain : this._sfxGain)
    src.start(when)
    src.stop(when + src.buffer.duration / src.playbackRate.value + 0.05)
  }

  /** Play one of the four duel strings. */
  playString(index, opts = {}) {
    const i = Math.max(0, Math.min(STRINGS.length - 1, index | 0))
    this.pluck(STRINGS[i] + (opts.transpose || 0), opts)
  }

  /** A strummed chord — the four strings, rolled slightly, like a real strum. */
  strum(opts = {}) {
    if (!this.ready) return
    const t = this.ctx.currentTime
    const spread = opts.spread ?? 0.022
    const up = opts.up === true
    for (let i = 0; i < STRINGS.length; i++) {
      const k = up ? STRINGS.length - 1 - i : i
      this.pluck(STRINGS[k] + (opts.transpose || 0), {
        voice: opts.voice || 'banjo',
        when: t + i * spread,
        gain: (opts.gain ?? 0.55) * (1 - i * 0.08),
        detune: (i - 1.5) * 3,
      })
    }
  }

  /**
   * A bluegrass forward roll: thumb-index-middle across three strings, the
   * picking pattern that gives the style its rolling triplet feel. The pattern
   * is a technique, not a tune — the notes it lands on here are ours.
   */
  roll(rootMidi, opts = {}) {
    if (!this.ready) return
    const t = (opts.when || this.ctx.currentTime)
    const step = opts.step ?? 0.09
    const shape = [0, 7, 12, 0, 7, 12, 16, 12]
    for (let i = 0; i < shape.length; i++) {
      this.pluck(rootMidi + shape[i], {
        voice: opts.voice || 'banjo',
        when: t + i * step,
        gain: (opts.gain ?? 0.4) * (i % 4 === 0 ? 1.15 : 0.85),
        bus: opts.bus,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Sound effects — all oscillator/noise based
  // -------------------------------------------------------------------------

  /** Shared noise buffer, one second, generated on first use. */
  _noise() {
    if (!this._noiseBuf) {
      const sr = this.ctx.sampleRate
      const b = this.ctx.createBuffer(1, sr, sr)
      const d = b.getChannelData(0)
      const r = seededRand(0xb0b)
      for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1
      this._noiseBuf = b
    }
    return this._noiseBuf
  }

  /**
   * A filtered noise burst — footsteps, sizzles, applause, freezer hiss.
   * @param {object} o `{ dur, freq, q, type, gain, when, sweepTo }`
   */
  noiseBurst(o = {}) {
    if (!this.ready) return
    const t = o.when || this.ctx.currentTime
    const dur = o.dur ?? 0.12

    const src = this.ctx.createBufferSource()
    src.buffer = this._noise()
    src.loop = true
    // Start at a random offset so repeated footsteps aren't audibly identical.
    const off = Math.random() * (src.buffer.duration - dur - 0.01)

    const filt = this.ctx.createBiquadFilter()
    filt.type = o.type || 'bandpass'
    filt.frequency.setValueAtTime(o.freq ?? 900, t)
    if (o.sweepTo) filt.frequency.exponentialRampToValueAtTime(Math.max(40, o.sweepTo), t + dur)
    filt.Q.value = o.q ?? 1.2

    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(o.gain ?? 0.3, t + Math.min(0.012, dur * 0.2))
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    src.connect(filt)
    filt.connect(g)
    g.connect(this._sfxGain)
    src.start(t, Math.max(0, off), dur + 0.02)
    src.stop(t + dur + 0.05)
  }

  /**
   * A pitched blip.
   * @param {object} o `{ f0, f1, dur, type, gain, when }`
   */
  tone(o = {}) {
    if (!this.ready) return
    const t = o.when || this.ctx.currentTime
    const dur = o.dur ?? 0.18
    const osc = this.ctx.createOscillator()
    osc.type = o.type || 'triangle'
    osc.frequency.setValueAtTime(o.f0 ?? 440, t)
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur)

    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(o.gain ?? 0.22, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    osc.connect(g)
    g.connect(this._sfxGain)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  // --- the named effects the game actually calls ----------------------------

  step(hard = false) {
    this.noiseBurst({ dur: hard ? 0.1 : 0.07, freq: hard ? 260 : 420, q: 1.1, gain: hard ? 0.16 : 0.09 })
  }

  jump() {
    this.tone({ f0: 300, f1: 720, dur: 0.16, type: 'square', gain: 0.13 })
  }

  land() {
    this.noiseBurst({ dur: 0.13, freq: 220, sweepTo: 90, q: 0.9, gain: 0.2 })
  }

  /** Picking up a chocolate chip: a bright three-note sparkle. */
  chip(n = 0) {
    if (!this.ready) return
    const t = this.ctx.currentTime
    // Rises as the run continues, so a streak of pickups climbs the scale.
    const base = PENTATONIC[Math.min(PENTATONIC.length - 1, 4 + (n % 6))]
    for (let i = 0; i < 3; i++) {
      this.pluck(base + i * 3 + 12, { voice: 'glass', when: t + i * 0.05, gain: 0.35 })
    }
  }

  /** A free sample eaten: a happy little slurp. */
  sample() {
    this.tone({ f0: 520, f1: 980, dur: 0.14, type: 'sine', gain: 0.18 })
    this.noiseBurst({ dur: 0.09, freq: 1800, q: 2, gain: 0.08 })
  }

  /** The correct note in a duel. */
  duelHit(index, transpose = 0, streak = 0) {
    this.playString(index, { transpose, gain: 1 })
    this.tone({ f0: 1400 + streak * 90, f1: 2200 + streak * 90, dur: 0.09, type: 'sine', gain: 0.07 })
  }

  /** The wrong note: a comedic slide, never a harsh buzzer. */
  duelMiss() {
    this.tone({ f0: 420, f1: 130, dur: 0.42, type: 'sawtooth', gain: 0.12 })
    this.noiseBurst({ dur: 0.3, freq: 500, sweepTo: 150, q: 0.7, gain: 0.1 })
  }

  /** Won a round. */
  roundWin() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    ;[0, 4, 7, 12].forEach((s, i) => {
      this.pluck(67 + s, { when: t + i * 0.07, gain: 0.55 })
    })
  }

  /** Won a whole duel: a fanfare plus a crowd. */
  duelWin() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    this.roll(55, { when: t, step: 0.075, gain: 0.5 })
    ;[0, 7, 12, 16, 19].forEach((s, i) => {
      this.pluck(67 + s, { when: t + 0.62 + i * 0.09, gain: 0.7 })
    })
    this.cheer(t + 0.5)
  }

  /** A crowd of shoppers, approving. */
  cheer(when) {
    if (!this.ready) return
    const t = when || this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise()
    src.loop = true
    const filt = this.ctx.createBiquadFilter()
    filt.type = 'bandpass'
    filt.frequency.setValueAtTime(700, t)
    filt.frequency.linearRampToValueAtTime(1500, t + 0.35)
    filt.frequency.linearRampToValueAtTime(600, t + 1.6)
    filt.Q.value = 0.7
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.24, t + 0.3)
    g.gain.setValueAtTime(0.24, t + 0.9)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9)
    src.connect(filt)
    filt.connect(g)
    g.connect(this._sfxGain)
    src.start(t)
    src.stop(t + 2.0)
  }

  /** The banjo getting dangerously warm. */
  sizzle() {
    this.noiseBurst({ dur: 0.55, freq: 3200, q: 0.6, gain: 0.09, type: 'highpass' })
  }

  /** The banjo melting completely — a sad, slow droop. */
  melt() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    this.tone({ f0: 400, f1: 70, dur: 1.1, type: 'triangle', gain: 0.2 })
    this.noiseBurst({ when: t + 0.15, dur: 0.8, freq: 900, sweepTo: 120, q: 0.5, gain: 0.12 })
  }

  /** Re-frozen in the freezer aisle. */
  refreeze() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    this.noiseBurst({ dur: 0.5, freq: 6000, sweepTo: 2000, q: 0.8, gain: 0.12, type: 'highpass' })
    ;[0, 5, 9, 12].forEach((s, i) => {
      this.pluck(74 + s, { voice: 'glass', when: t + 0.05 + i * 0.06, gain: 0.3 })
    })
  }

  /** The store PA chiming before an announcement. */
  paChime() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    ;[76, 72, 69].forEach((m, i) => {
      this.tone({ f0: mtof(m), dur: 0.5, type: 'sine', gain: 0.14, when: t + i * 0.24 })
    })
  }

  /** A forklift reversing. */
  beep(times = 3) {
    if (!this.ready) return
    const t = this.ctx.currentTime
    for (let i = 0; i < times; i++) {
      this.tone({ f0: 1050, dur: 0.14, type: 'square', gain: 0.1, when: t + i * 0.32 })
    }
  }

  /** UI move / confirm. */
  uiMove() {
    this.tone({ f0: 620, dur: 0.06, type: 'square', gain: 0.07 })
  }

  uiConfirm() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    this.pluck(67, { when: t, gain: 0.5 })
    this.pluck(74, { when: t + 0.07, gain: 0.5 })
  }

  // -------------------------------------------------------------------------
  // The backing band
  // -------------------------------------------------------------------------

  /**
   * Start (or switch) the music. A name in BEDS plays its recording;
   * everything else — and any bed whose file failed — plays its PATTERN.
   *
   * @param {'title'|'store'|'duel'|'finale'|null} name  null stops the music
   * @param {object} [opts] `{ intensity }` 0..1. Scales arrangement density for
   *                        a generated pattern, and level for a recorded bed.
   */
  setMusic(name, opts = {}) {
    if (!this.ready) return
    this._intensity = opts.intensity ?? 1

    // A generated pattern answers `intensity` by adding and dropping parts. A
    // recording cannot thin its own arrangement, so for a bed it becomes a
    // level ride instead — slow, because a fast one reads as a mistake. Ride
    // the bed that is about to play, not the one leaving, or a switch lands at
    // the wrong level for a beat.
    this._rideBed(BEDS[name] ? name : this._patternName)

    if (name === this._patternName) return
    this._patternName = name

    if (!name) {
      this.stopMusic()
      return
    }

    if (BEDS[name] && !this._bedFailed.has(name)) {
      this._stopPattern()
      this._startBed(name)
      return
    }
    this._stopBed()
    this._startPattern(name)
  }

  stopMusic() {
    this._bedToken++
    this._stopBed()
    this._stopPattern()
    this._patternName = null
  }

  /** Run one of the generated arrangements. */
  _startPattern(name) {
    const P = PATTERNS[name]
    if (!P) return
    this._pattern = P
    this._bpm = P.bpm

    if (this._timer === null) {
      // Start on the next 16th boundary rather than instantly, so switching
      // tunes mid-bar doesn't produce a flam.
      this._nextNoteTime = this.ctx.currentTime + 0.08
      this._step = 0
      this._timer = setInterval(() => this._schedule(), 25)
    }
  }

  _stopPattern() {
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._pattern = null
  }

  /** Fetch + decode a bed, once. The promise is the cache entry. */
  _bedBuffer(name) {
    const cached = this._bedBuffers.get(name)
    if (cached) return cached

    const sources = BEDS[name].sources
    const probe = document.createElement('audio')
    const pick = sources.find(([type]) => probe.canPlayType(type)) || sources[0]

    const p = fetch(pick[1])
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} for ${pick[1]}`)
        return r.arrayBuffer()
      })
      .then((b) => this.ctx.decodeAudioData(b))
      .catch((e) => {
        this._bedFailed.add(name)
        throw e
      })
    this._bedBuffers.set(name, p)
    return p
  }

  /**
   * Start a recorded bed, or fall back to its generated arrangement.
   *
   * The fallback is the point of the whole shape: a missing file, an offline
   * reload or a browser that will not decode either codec must not leave the
   * store silent, and the patterns need nothing but an AudioContext.
   */
  _startBed(name) {
    const token = ++this._bedToken
    this._bedBuffer(name)
      .then((buf) => {
        // The music may have moved on while this was decoding.
        if (token !== this._bedToken || this._patternName !== name || !this.ready) return
        this._stopBed()
        const src = this.ctx.createBufferSource()
        src.buffer = buf
        src.loop = true
        src.connect(this._bedGain)
        src.start()
        this._bedSource = src
      })
      .catch(() => {
        if (token !== this._bedToken || this._patternName !== name) return
        this._startPattern(name)
      })
  }

  /** Set the bed bus to one bed's level, scaled by the current intensity. */
  _rideBed(name) {
    if (!this._bedGain) return
    const spec = BEDS[name]
    if (!spec) return
    this._bedGain.gain.setTargetAtTime(
      spec.gain * (0.55 + 0.45 * this._intensity), this.ctx.currentTime, 0.4)
  }

  _stopBed() {
    if (!this._bedSource) return
    try {
      this._bedSource.stop()
    } catch (e) {
      // Already stopped; the node is single-use either way.
    }
    this._bedSource.disconnect()
    this._bedSource = null
  }

  /** Ramp the music volume — used to duck under the duel countdown. */
  duckMusic(level = 0.35, seconds = 0.4) {
    if (!this.ready) return
    this._musicGain.gain.setTargetAtTime(0.32 * level, this.ctx.currentTime, seconds / 3)
  }

  unduckMusic(seconds = 0.6) {
    if (!this.ready) return
    this._musicGain.gain.setTargetAtTime(0.32, this.ctx.currentTime, seconds / 3)
  }

  /**
   * The lookahead scheduler. Runs every 25ms and pushes every note that falls
   * inside the next 120ms into the audio thread with an absolute start time.
   * Nothing here is timing-critical — the setInterval can be late by 50ms and
   * the music still lands exactly on the beat.
   */
  _schedule() {
    if (!this.ready || !this._pattern) return
    const P = this._pattern
    const secondsPerStep = 60 / this._bpm / 4 // 16th notes
    const horizon = this.ctx.currentTime + 0.12

    // A tab in the background throttles timers to once a second; without this
    // catch-up guard, returning to the tab would dump a hundred queued notes at
    // once. Skip forward instead.
    if (this._nextNoteTime < this.ctx.currentTime - 0.5) {
      this._nextNoteTime = this.ctx.currentTime + 0.02
    }

    while (this._nextNoteTime < horizon) {
      P.play(this, this._step, this._nextNoteTime, this._intensity)
      this._nextNoteTime += secondsPerStep
      this._step++
    }
  }
}

// ===========================================================================
// Patterns
// ===========================================================================
//
// Each pattern is a pure function of (step, time). `step` counts 16th notes
// from when the music started, so `step % 64` is the position in a four-bar
// phrase. Chords are given as MIDI roots and every melodic note is snapped
// into the current chord, which is what keeps the generated lines singable.

/** Four-bar progressions, one chord per bar. */
const PROGRESSIONS = {
  //  G     C     G     D    — the plainest, friendliest turnaround there is.
  store: [55, 60, 55, 62],
  //  G     Em    C     D
  duel: [55, 64, 60, 62],
  //  G     G     C     D
  title: [55, 55, 60, 62],
  //  G     C     D     G
  finale: [55, 60, 62, 55],
}

/** Chord tones (semitone offsets) for a major and a minor triad. */
const MAJOR = [0, 4, 7, 12, 16]
const MINOR = [0, 3, 7, 12, 15]

function chordAt(prog, step) {
  const bar = Math.floor(step / 16) % prog.length
  return prog[bar]
}

/** Em is the only minor chord in any progression here. */
function tonesFor(root) {
  return root === 64 ? MINOR : MAJOR
}

const PATTERNS = {
  title: {
    bpm: 118,
    play(a, step, t, intensity) {
      const s = step % 64
      const root = chordAt(PROGRESSIONS.title, step)
      const tones = tonesFor(root)
      // Lazy porch-swing feel: a bass note on 1 and 3, a rolled chord on 2 and 4.
      if (s % 16 === 0) a.pluck(root - 12, { voice: 'thumpy', when: t, gain: 0.5, bus: 'music' })
      if (s % 16 === 8) a.pluck(root - 5, { voice: 'thumpy', when: t, gain: 0.4, bus: 'music' })
      if (s % 8 === 4) {
        for (let i = 0; i < 3; i++) {
          a.pluck(root + tones[i] + 12, {
            when: t + i * 0.02, gain: 0.28, bus: 'music', pan: -0.2 + i * 0.2,
          })
        }
      }
      if (intensity > 0.5 && s % 4 === 2) {
        a.pluck(root + tones[(s / 2) % tones.length] + 12, { when: t, gain: 0.16, bus: 'music' })
      }
    },
  },

  store: {
    bpm: 132,
    play(a, step, t, intensity) {
      const s = step % 64
      const root = chordAt(PROGRESSIONS.store, step)
      const tones = tonesFor(root)

      // Upright bass, alternating root and fifth — the bluegrass boom-chuck.
      if (s % 8 === 0) a.pluck(root - 24, { voice: 'thumpy', when: t, gain: 0.6, bus: 'music' })
      if (s % 8 === 4) a.pluck(root - 17, { voice: 'thumpy', when: t, gain: 0.45, bus: 'music' })

      // Off-beat chop on the backbeat.
      if (s % 8 === 2 || s % 8 === 6) {
        a.noiseBurst({ when: t, dur: 0.06, freq: 2400, q: 1.4, gain: 0.05 * intensity })
      }

      // A continuous forward roll on the banjo, one note per 8th, cycling
      // through the chord. This is the bed the whole store runs on.
      if (s % 2 === 0) {
        const seq = [0, 2, 4, 1, 3, 2, 4, 3]
        const pick = tones[seq[(s / 2) % seq.length] % tones.length]
        a.pluck(root + pick + 12, {
          when: t,
          gain: 0.2 * (0.6 + intensity * 0.4),
          bus: 'music',
          pan: ((s / 2) % 3) * 0.25 - 0.25,
        })
      }

      // A fiddle-ish counter-melody that only shows up at high intensity, so
      // the music gets busier the more of the band you have recruited.
      if (intensity > 0.66 && s % 16 === 12) {
        a.pluck(root + tones[2] + 24, { voice: 'twang', when: t, gain: 0.22, bus: 'music' })
      }
    },
  },

  duel: {
    bpm: 146,
    play(a, step, t, intensity) {
      const s = step % 64
      const root = chordAt(PROGRESSIONS.duel, step)
      const tones = tonesFor(root)
      // Sparser than the store loop: the duel needs the player to hear the
      // phrase being played AT them, so the bed drops back to bass and chop.
      if (s % 8 === 0) a.pluck(root - 24, { voice: 'thumpy', when: t, gain: 0.55, bus: 'music' })
      if (s % 8 === 6) a.pluck(root - 17, { voice: 'thumpy', when: t, gain: 0.35, bus: 'music' })
      if (s % 4 === 2) {
        a.noiseBurst({ when: t, dur: 0.05, freq: 3000, q: 1.6, gain: 0.045 })
      }
      if (intensity > 0.4 && s % 16 === 14) {
        a.pluck(root + tones[1] + 12, { when: t, gain: 0.18, bus: 'music' })
      }
    },
  },

  finale: {
    bpm: 152,
    play(a, step, t) {
      const s = step % 64
      const root = chordAt(PROGRESSIONS.finale, step)
      const tones = tonesFor(root)
      // Everybody plays. This is the payoff, so it is deliberately the busiest
      // arrangement in the game.
      if (s % 8 === 0) a.pluck(root - 24, { voice: 'thumpy', when: t, gain: 0.7, bus: 'music' })
      if (s % 8 === 4) a.pluck(root - 17, { voice: 'thumpy', when: t, gain: 0.5, bus: 'music' })
      if (s % 4 === 2) a.noiseBurst({ when: t, dur: 0.07, freq: 2600, q: 1.2, gain: 0.07 })

      const seq = [0, 2, 4, 3, 1, 2, 4, 2]
      const pick = tones[seq[s % seq.length] % tones.length]
      a.pluck(root + pick + 12, { when: t, gain: 0.17, bus: 'music', pan: (s % 5) * 0.2 - 0.4 })

      if (s % 8 === 0) a.pluck(root + tones[2] + 24, { voice: 'mando', when: t, gain: 0.2, bus: 'music' })
      if (s % 16 === 8) a.pluck(root + tones[1] + 24, { voice: 'twang', when: t, gain: 0.22, bus: 'music' })
      if (s % 32 === 24) a.pluck(root + 12, { voice: 'horn', when: t, gain: 0.28, bus: 'music' })
    },
  },
}

/**
 * Generate a duel phrase: `length` string indices (0..3).
 *
 * Two rules make these fun rather than random:
 *  - no more than two of the same note in a row (a run of four identical
 *    presses reads as "the game is broken" to a child)
 *  - the phrase always ends on string 0 or 3, the two extremes, so it has an
 *    audible full stop
 */
export function makePhrase(length, rand = Math.random) {
  const out = []
  for (let i = 0; i < length; i++) {
    let n
    let guard = 0
    do {
      n = Math.floor(rand() * 4) % 4
      guard++
    } while (guard < 12 && out.length >= 2 && n === out[out.length - 1] && n === out[out.length - 2])
    out.push(n)
  }
  if (length > 2) out[length - 1] = rand() < 0.5 ? 0 : 3
  return out
}
