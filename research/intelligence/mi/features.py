"""Measurement primitives for Merge Intelligence research (Phase 0 experiments).

Isolated research code: NOT part of the production engine. Everything here is
deliberately simple, dependency-light (numpy + scipy) and mirrors what a native
C++ implementation would compute, so results carry over.

Conventions
- Signals are float64 numpy arrays, shape (n,) mono or (2, n) stereo, full scale = 1.0.
- Loudness follows ITU-R BS.1770 (K-weighting, 400 ms momentary, 3 s short-term,
  -70 LUFS absolute gate, -10 LU relative gate for integrated).
- "Blocks" are 100 ms hops (the R128 meter update rate, and the same 100 ms
  sub-block structure Merge's native LoudnessMeter already uses).
"""

from __future__ import annotations

import numpy as np
from scipy.signal import lfilter

HOP_S = 0.1  # 100 ms block hop


# --------------------------------------------------------------------- K-weighting
def k_weighting_coeffs(fs: float):
    """BS.1770 K-weighting as two biquads for an arbitrary sample rate.

    Same closed form as libebur128 / pyloudnorm, and as Merge's native
    engine (engine/src/Mixer.cpp, LoudnessMeter::prepare). Returns
    ((b_shelf, a_shelf), (b_hp, a_hp)).
    """
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / fs)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b_s = np.array([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0])
    a_s = np.array([1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / fs)
    a0 = 1 + K / Q + K * K
    b_h = np.array([1.0, -2.0, 1.0])
    a_h = np.array([1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    return (b_s, a_s), (b_h, a_h)


def k_weight(x: np.ndarray, fs: float) -> np.ndarray:
    (bs, as_), (bh, ah) = k_weighting_coeffs(fs)
    return lfilter(bh, ah, lfilter(bs, as_, x, axis=-1), axis=-1)


def _as2d(x: np.ndarray) -> np.ndarray:
    return x[None, :] if x.ndim == 1 else x


def lufs_from_ms(ms):
    ms = np.asarray(ms, dtype=float)
    with np.errstate(divide="ignore"):
        return np.where(ms > 0, -0.691 + 10 * np.log10(np.maximum(ms, 1e-300)), -np.inf)


def block_power(x: np.ndarray, fs: float) -> np.ndarray:
    """K-weighted channel-summed mean square per 100 ms block (G=1 for L/R).

    A mono signal is treated as BS.1770 does a single channel (no +3 dB).
    """
    y = _as2d(k_weight(x, fs))
    hop = int(round(fs * HOP_S))
    nb = y.shape[1] // hop
    y = y[:, : nb * hop].reshape(y.shape[0], nb, hop)
    return (y ** 2).mean(axis=2).sum(axis=0)


def windowed(power_blocks: np.ndarray, n_blocks: int) -> np.ndarray:
    """Trailing moving average over n blocks (momentary: 4, short-term: 30)."""
    c = np.cumsum(np.concatenate([[0.0], power_blocks]))
    out = np.empty_like(power_blocks)
    for i in range(len(power_blocks)):
        lo = max(0, i + 1 - n_blocks)
        out[i] = (c[i + 1] - c[lo]) / (i + 1 - lo)
    return out


def momentary(power_blocks):
    return lufs_from_ms(windowed(power_blocks, 4))


def short_term(power_blocks):
    return lufs_from_ms(windowed(power_blocks, 30))


def integrated(x: np.ndarray, fs: float) -> float:
    """BS.1770 gated integrated loudness (400 ms blocks, 75 % overlap)."""
    p = block_power(x, fs)
    m = windowed(p, 4)[3:]  # complete 400 ms blocks only
    m = m[lufs_from_ms(m) > -70]
    if not len(m):
        return -np.inf
    rel = lufs_from_ms(m.mean()) - 10
    m = m[lufs_from_ms(m) > rel]
    return float(lufs_from_ms(m.mean())) if len(m) else -np.inf


# ----------------------------------------------------------------- spectral shape
def band_edges(lo=40.0, hi=16000.0, per_octave=1):
    n = int(np.floor(np.log2(hi / lo) * per_octave))
    return lo * 2 ** (np.arange(n + 1) / per_octave)


def band_energies_db(x: np.ndarray, fs: float, edges=None, nfft=4096) -> np.ndarray:
    """Long-term average spectrum in bands (dB), Welch-style (Hann, 50 % overlap)."""
    edges = band_edges() if edges is None else edges
    x = _as2d(x).mean(axis=0)
    hop = nfft // 2
    w = np.hanning(nfft)
    frames = [x[i : i + nfft] * w for i in range(0, len(x) - nfft, hop)]
    if not frames:
        return np.full(len(edges) - 1, -np.inf)
    P = np.mean(np.abs(np.fft.rfft(np.array(frames), axis=1)) ** 2, axis=0)
    f = np.fft.rfftfreq(nfft, 1 / fs)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        sel = (f >= a) & (f < b)
        out.append(10 * np.log10(P[sel].sum() + 1e-20))
    return np.array(out)


def tonal_shape(band_db: np.ndarray, weights=None) -> np.ndarray:
    """Spectral shape with overall level removed (energy-weighted mean subtracted)."""
    w = np.ones_like(band_db) if weights is None else weights
    lin = 10 ** (band_db / 10)
    level = 10 * np.log10((lin * w).sum() / w.sum())
    return band_db - level


# ---------------------------------------------------------------------- dynamics
def crest_factor_db(x: np.ndarray) -> float:
    x = _as2d(x).mean(axis=0)
    rms = np.sqrt(np.mean(x ** 2))
    return float(20 * np.log10(np.max(np.abs(x)) / max(rms, 1e-12)))


def loudness_spread(power_blocks: np.ndarray, active: np.ndarray, lo=10, hi=95) -> float:
    """Percentile spread (LU) of short-term loudness over active blocks (LRA-like)."""
    st = short_term(power_blocks)[active]
    st = st[np.isfinite(st)]
    if len(st) < 10:
        return float("nan")
    return float(np.percentile(st, hi) - np.percentile(st, lo))


def activity(power_blocks: np.ndarray, mix_power_blocks: np.ndarray, rel_lu=-25.0, abs_lufs=-60.0, n_blocks=4):
    """Source activity per block: momentary loudness above an absolute floor and
    within `rel_lu` of the program's momentary loudness. Mirrors the 'no signal'
    vs 'silence' distinction of Perez-Gonzalez & Reiss (2009) adaptive gating."""
    lg = lufs_from_ms(windowed(power_blocks, n_blocks))
    lm = lufs_from_ms(windowed(mix_power_blocks, n_blocks))
    return (lg > abs_lufs) & (lg > lm + rel_lu)
