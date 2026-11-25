"""Synthetic, reproducible stand-ins for the five proof-of-concept source groups.

These are NOT music. They are signals with roughly the right spectral region,
envelope behaviour and activity pattern for each role, so that measurement and
control logic can be tested with KNOWN ground truth (exact injected disturbances).
Musical quality can only be judged later on real multitracks (see the test plan).
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt

FS = 48000
GROUPS = ["vocals", "drums", "bass", "guitars", "keys"]


def _bp(x, lo, hi, fs=FS, order=4):
    sos = butter(order, [lo, hi], btype="band", fs=fs, output="sos")
    return sosfilt(sos, x)


def _lp(x, hi, fs=FS, order=4):
    return sosfilt(butter(order, hi, btype="low", fs=fs, output="sos"), x)


def _env_smooth(e, ms, fs=FS):
    a = np.exp(-1.0 / (ms * 1e-3 * fs))
    from scipy.signal import lfilter

    return lfilter([1 - a], [1, -a], e)


def vocal(dur, rng, fs=FS, f0=220.0):
    """Harmonic source (vibrato) + formant-ish band, with syllabic envelope and phrase gaps."""
    n = int(dur * fs)
    t = np.arange(n) / fs
    f = f0 * (1 + 0.01 * np.sin(2 * np.pi * 5.5 * t))
    ph = 2 * np.pi * np.cumsum(f) / fs
    x = sum((1 / k) * np.sin(k * ph) for k in range(1, 25))
    x = _bp(x + 0.05 * rng.standard_normal(n), 150, 9000)
    syl = np.repeat(rng.uniform(0.3, 1.0, n // int(0.25 * fs) + 1), int(0.25 * fs))[:n]
    phrase = (np.sin(2 * np.pi * t / 8.0) > -0.6).astype(float)  # ~1.5 s gap every 8 s
    return x * _env_smooth(syl * phrase, 30)


def drums(dur, rng, fs=FS, bpm=72):
    n = int(dur * fs)
    x = np.zeros(n)
    beat = int(60 / bpm * fs)
    tk = np.arange(int(0.25 * fs)) / fs
    kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-tk * 30)) * tk) * np.exp(-tk * 12)
    sn = _bp(rng.standard_normal(len(tk)), 180, 8000) * np.exp(-tk * 22)
    hh = _bp(rng.standard_normal(int(0.05 * fs)), 7000, 16000) * np.exp(-np.arange(int(0.05 * fs)) / fs * 80)
    for i, s in enumerate(range(0, n - len(tk), beat)):
        x[s : s + len(tk)] += (kick if i % 2 == 0 else sn * 0.8)
        for h in (0, beat // 2):
            if s + h + len(hh) < n:
                x[s + h : s + h + len(hh)] += 0.3 * hh
    return x


def bass(dur, rng, fs=FS, bpm=72):
    n = int(dur * fs)
    notes = [41.2, 49.0, 55.0, 36.7]
    beat = int(60 / bpm * fs) * 2
    x = np.zeros(n)
    for i, s in enumerate(range(0, n, beat)):
        m = min(beat, n - s)
        tt = np.arange(m) / fs
        f = notes[i % len(notes)]
        saw = 2 * ((tt * f) % 1) - 1
        x[s : s + m] = saw * np.minimum(1, tt / 0.01) * np.exp(-tt * 0.6)
    return _lp(x, 900)


def guitars(dur, rng, fs=FS):
    n = int(dur * fs)
    x = _bp(rng.standard_normal(n), 300, 5000)
    t = np.arange(n) / fs
    trem = 0.75 + 0.25 * np.sin(2 * np.pi * 2.4 * t)
    return np.tanh(3 * x) * trem * 0.5


def keys(dur, rng, fs=FS):
    n = int(dur * fs)
    t = np.arange(n) / fs
    chord = [261.6, 329.6, 392.0, 523.3]
    x = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) for f in chord)
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * t / 6.0)
    return _lp(x * swell, 3000) * 0.25


MAKERS = {"vocals": vocal, "drums": drums, "bass": bass, "guitars": guitars, "keys": keys}


def make_groups(dur=60.0, seed=0, fs=FS):
    rng = np.random.default_rng(seed)
    return {g: MAKERS[g](dur, rng, fs) for g in GROUPS}


def db(x):
    return 10 ** (x / 20)


def peaking_eq(x, f0, gain_db, q=1.0, fs=FS):
    """RBJ peaking biquad (the kind of band an existing EQ plugin would offer)."""
    from scipy.signal import lfilter

    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / fs
    al = np.sin(w) / (2 * q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    return lfilter(b / a[0], a / a[0], x)


def compressor(x, threshold_db, ratio, attack_ms=10.0, release_ms=120.0, knee_db=6.0, fs=FS):
    """Feed-forward log-domain compressor with smooth decoupled peak detector
    (Giannoulis, Massberg & Reiss, JAES 2012, 'Digital dynamic range compressor
    design - a tutorial and analysis'). Returns (y, gain_reduction_db)."""
    xg = 20 * np.log10(np.abs(x) + 1e-9)
    T, R, W = threshold_db, ratio, knee_db
    yg = np.where(
        2 * (xg - T) < -W,
        xg,
        np.where(2 * np.abs(xg - T) <= W, xg + (1 / R - 1) * (xg - T + W / 2) ** 2 / (2 * W), T + (xg - T) / R),
    )
    xl = xg - yg
    aA = np.exp(-1 / (attack_ms * 1e-3 * fs))
    aR = np.exp(-1 / (release_ms * 1e-3 * fs))
    yl = np.zeros_like(xl)
    y1 = 0.0
    prev = 0.0
    for i, v in enumerate(xl):  # smooth decoupled peak detector
        y1 = max(v, aR * y1 + (1 - aR) * v)
        prev = aA * prev + (1 - aA) * y1
        yl[i] = prev
    return x * 10 ** (-yl / 20), yl
