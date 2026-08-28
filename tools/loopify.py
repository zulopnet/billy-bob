#!/usr/bin/env python3
"""Turn an ACE-Step take into a seamless game loop.

A generated track has an intro, a fade-out and no particular bar alignment, so
playing it with `loop = true` gives an audible seam every pass. This finds a
musically sensible loop region and wrap-crossfades it so the join is inaudible:

  1. estimate the beat period from the onset envelope (autocorrelation)
  2. put the loop start on a strong onset a couple of bars in, past the intro
  3. search a window of candidate end points ~N bars later for the one whose
     following audio best matches the audio following the start — that is the
     point where the wrap sounds like a continuation
  4. crossfade the material after the end back over the head of the loop

Everything is done on the raw float samples; no external DSP libraries.
"""
import argparse, wave, numpy as np


def load(p):
    with wave.open(p, 'rb') as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        d = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    return sr, d.reshape(-1, ch) if ch > 1 else d.reshape(-1, 1)


def save(p, sr, x):
    d = np.clip(x, -1, 1)
    with wave.open(p, 'wb') as w:
        w.setnchannels(d.shape[1]); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((d * 32767).astype(np.int16).tobytes())


def onset_env(mono, sr, hop):
    """Spectral-flux onset strength, one value per hop."""
    win = hop * 2
    frames = (len(mono) - win) // hop
    w = np.hanning(win)
    S = np.abs(np.fft.rfft(mono[np.arange(frames)[:, None] * hop + np.arange(win)] * w, axis=1))
    S = np.log1p(S * 100)
    flux = np.maximum(0, np.diff(S, axis=0)).sum(axis=1)
    return flux - flux.mean()


def estimate_period(env, hop, sr, lo_bpm=90, hi_bpm=200):
    """Beat period in seconds, from the autocorrelation peak of the envelope."""
    ac = np.correlate(env, env, 'full')[len(env) - 1:]
    lo = max(1, int((60 / hi_bpm) * sr / hop))
    hi = min(len(ac) - 1, int((60 / lo_bpm) * sr / hop))
    lag = lo + int(np.argmax(ac[lo:hi]))
    # Parabolic interpolation for sub-hop resolution.
    if 0 < lag < len(ac) - 1:
        a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
        denom = a - 2 * b + c
        if denom != 0:
            lag = lag + 0.5 * (a - c) / denom
    return lag * hop / sr


def best_end(mono, sr, start, target, search, match):
    """End sample whose following `match` seconds best continue the loop start."""
    ref = mono[start:start + match]
    ref = ref - ref.mean()
    rn = np.linalg.norm(ref) + 1e-9
    best, best_score = target, -2.0
    for e in range(max(start + sr, target - search), min(len(mono) - match, target + search)):
        seg = mono[e:e + match]
        score = float(np.dot(ref, seg - seg.mean()) / (rn * (np.linalg.norm(seg - seg.mean()) + 1e-9)))
        if score > best_score:
            best_score, best = score, e
    return best, best_score


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--bars", type=float, default=8, help="target loop length in bars")
    ap.add_argument("--beats-per-bar", type=int, default=4)
    ap.add_argument("--skip", type=float, default=2.0, help="seconds of intro to skip")
    ap.add_argument("--xfade", type=float, default=0.35)
    ap.add_argument("--bpm", type=float, default=0, help="override the estimate")
    args = ap.parse_args()

    sr, x = load(args.src)
    mono = x.mean(axis=1)
    hop = 256
    env = onset_env(mono, sr, hop)

    period = 60.0 / args.bpm if args.bpm else estimate_period(env, hop, sr)
    bar = period * args.beats_per_bar
    print(f"[loop] beat {period*1000:.0f}ms ({60/period:.1f} bpm), bar {bar:.2f}s")

    # Loop start: the strongest onset inside the bar that follows --skip, so the
    # loop begins on a downbeat rather than mid-phrase.
    s0, s1 = int(args.skip * sr / hop), int((args.skip + bar) * sr / hop)
    start = int((s0 + int(np.argmax(env[s0:s1]))) * hop)

    target = start + int(round(args.bars * bar * sr))
    xf = int(args.xfade * sr)
    match = int(min(bar, 1.5) * sr)
    # Never run the search into the fade-out at the tail.
    limit = len(mono) - match - xf
    if target > limit:
        target = limit
    end, score = best_end(mono, sr, start, target, int(bar * sr / 2), match)
    print(f"[loop] start {start/sr:.2f}s  end {end/sr:.2f}s  "
          f"len {(end-start)/sr:.2f}s  wrap match {score:+.3f}")

    body = x[start:end].copy()
    tail = x[end:end + xf]
    if len(tail) < xf:
        xf = len(tail)
    if xf > 0:
        w = np.linspace(0, 1, xf)[:, None]
        # Equal-power, so the crossfade does not dip in the middle.
        body[:xf] = body[:xf] * np.sqrt(w) + tail[:xf] * np.sqrt(1 - w)

    peak = np.abs(body).max()
    if peak > 0:
        body *= min(1.0, 0.89 / peak)
    save(args.dst, sr, body)
    print(f"[loop] wrote {args.dst}  {len(body)/sr:.2f}s")


if __name__ == "__main__":
    main()
