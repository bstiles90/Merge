"""Shared measurement engine for references, comparison mixes and speech mics.

The same functions analyse every kind of material, so reference and live measurements
are directly comparable (vision §9). Time base: 100 ms blocks (`HOP_S`).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.signal import resample_poly, stft

from . import features as F

HOP_S = F.HOP_S

# Octave bands for tonal decisions: centres ~63 Hz .. 16 kHz (9 bands).
BAND_EDGES = F.band_edges(44.2, 22700, 1)   # 9 octave bands, centres 63 Hz .. 16 kHz
BAND_CENTRES = np.sqrt(BAND_EDGES[:-1] * BAND_EDGES[1:])

# Source-specific activity thresholds (initial values; see `mi study activity`).
#   rel_lu   : group momentary loudness must be within this of the program's
#   abs_lufs : absolute floor
#   margin_lu: above the group's own idle floor (5th percentile, trailing 60 s)
#   on_s/off_s: hysteresis hold times
ACTIVITY_DEFAULTS = {
    "vocals": {"rel_lu": -25.0, "abs_lufs": -60.0, "margin_lu": 10.0, "on_s": 0.3, "off_s": 1.5},
    "drums": {"rel_lu": -30.0, "abs_lufs": -60.0, "margin_lu": 8.0, "on_s": 0.2, "off_s": 2.0},
    "bass": {"rel_lu": -30.0, "abs_lufs": -60.0, "margin_lu": 8.0, "on_s": 0.3, "off_s": 2.0},
    "guitars": {"rel_lu": -30.0, "abs_lufs": -60.0, "margin_lu": 8.0, "on_s": 0.3, "off_s": 1.5},
    "keys": {"rel_lu": -30.0, "abs_lufs": -60.0, "margin_lu": 8.0, "on_s": 0.3, "off_s": 2.0},
    "synths": {"rel_lu": -30.0, "abs_lufs": -60.0, "margin_lu": 8.0, "on_s": 0.3, "off_s": 2.0},
    "speech": {"rel_lu": -20.0, "abs_lufs": -55.0, "margin_lu": 10.0, "on_s": 0.2, "off_s": 1.0},
    "default": {"rel_lu": -28.0, "abs_lufs": -60.0, "margin_lu": 8.0, "on_s": 0.3, "off_s": 1.5},
}


def activity_params(role: str, overrides: dict | None = None) -> dict:
    p = dict(ACTIVITY_DEFAULTS.get(role, ACTIVITY_DEFAULTS["default"]))
    if overrides:
        p.update({k: v for k, v in overrides.get(role, {}).items() if k in p})
    return p


def block_stats(x: np.ndarray, sr: int):
    """K-weighted block power (100 ms), sample peak per block, plain mean square per block."""
    x2 = np.atleast_2d(x)
    p = F.block_power(x2, sr)
    hop = int(round(sr * HOP_S))
    nb = len(p)
    y = np.abs(x2[:, : nb * hop]).reshape(x2.shape[0], nb, hop)
    peak = y.max(axis=2).max(axis=0)
    ms = (y ** 2).mean(axis=2).sum(axis=0)
    return p, peak, ms


def rolling_percentile(v: np.ndarray, n: int, q: float) -> np.ndarray:
    """Trailing-window percentile of a finite-valued series (NaN-safe), evaluated every 10 blocks."""
    out = np.full(len(v), np.nan)
    for i in range(0, len(v), 10):
        w = v[max(0, i - n + 1) : i + 1]
        w = w[np.isfinite(w)]
        if len(w):
            out[i : i + 10] = np.percentile(w, q)
    return out


def activity(p_src: np.ndarray, p_prog: np.ndarray, params: dict) -> np.ndarray:
    """Three-part activity test with hysteresis (algorithms doc §2.5).

    The idle-floor term (`margin_lu` above the source's own 5th percentile over the trailing 60 s)
    only applies when the source actually has quiet periods: its median must sit at least
    2 x margin above that percentile. A source that plays continuously has no idle floor -
    otherwise its own playing level would be mistaken for one (found on the demo workspace).
    """
    m = F.lufs_from_ms(F.windowed(p_src, 4))
    mp = F.lufs_from_ms(F.windowed(p_prog, 4))
    W = int(60 / HOP_S)
    floor = rolling_percentile(m, W, 5)
    med = rolling_percentile(m, W, 50)
    has_idle = np.isfinite(floor) & np.isfinite(med) & (med - floor > 2 * params["margin_lu"]) & (floor > params["abs_lufs"])
    floor_term = np.where(has_idle, floor + params["margin_lu"], -np.inf)
    raw = (m > params["abs_lufs"]) & (m > mp + params["rel_lu"]) & (m > floor_term)
    on_n = max(1, int(round(params["on_s"] / HOP_S)))
    off_n = max(1, int(round(params["off_s"] / HOP_S)))
    out = np.zeros(len(raw), bool)
    state, run = False, 0
    for i, r in enumerate(raw):
        if r != state:
            run += 1
            if (r and run >= on_n) or (not r and run >= off_n):
                state, run = r, 0
        else:
            run = 0
        out[i] = state
    return out


def band_frames(x: np.ndarray, sr: int, nfft: int = 4096):
    """Octave-band power per STFT frame (hop nfft/2). Returns (times_s, bands_db[frames, bands])."""
    mono = np.atleast_2d(x).mean(axis=0)
    f, t, Z = stft(mono, fs=sr, nperseg=nfft, noverlap=nfft // 2, boundary=None, padded=False)
    P = np.abs(Z) ** 2
    out = []
    for a, b in zip(BAND_EDGES[:-1], BAND_EDGES[1:]):
        sel = (f >= a) & (f < b)
        out.append(P[sel].sum(axis=0))
    return t, 10 * np.log10(np.array(out).T + 1e-20)


def band_mean(times, bands_db, t0=None, t1=None, mask_times=None):
    """Energy-average band levels (dB) over a time range, optionally only where mask_times is True."""
    sel = np.ones(len(times), bool)
    if t0 is not None:
        sel &= times >= t0
    if t1 is not None:
        sel &= times < t1
    if mask_times is not None:
        sel &= mask_times
    if not sel.any():
        return np.full(bands_db.shape[1], np.nan)
    return 10 * np.log10(np.mean(10 ** (bands_db[sel] / 10), axis=0) + 1e-20)


def frames_active(times, active_blocks):
    idx = np.minimum((times / HOP_S).astype(int), len(active_blocks) - 1)
    return active_blocks[idx]


def loudness_weights(e_db: np.ndarray) -> np.ndarray:
    """Specific-loudness-like band weights (E^0.25, floor 1 %), from exp03."""
    w = (10 ** (np.nan_to_num(e_db, nan=-200) / 10)) ** 0.25
    w = w / max(w.sum(), 1e-20)
    return np.maximum(w, 0.01)


def tonal_shape(e_db: np.ndarray) -> np.ndarray:
    """Band levels with overall (loudness-weighted) level removed."""
    w = loudness_weights(e_db)
    return e_db - float((w * e_db).sum() / w.sum())


def momentary_spread(p: np.ndarray, act: np.ndarray) -> float:
    m = F.lufs_from_ms(F.windowed(p, 4))[act & (np.arange(len(p)) >= 4)]
    m = m[np.isfinite(m)]
    return float(np.percentile(m, 95) - np.percentile(m, 10)) if len(m) >= 20 else float("nan")


def crest_db(peak: np.ndarray, ms: np.ndarray, act: np.ndarray, win: int = 30) -> float:
    vals = []
    for i in range(0, len(peak) - win, win):
        a = act[i : i + win]
        if a.mean() < 0.8:
            continue
        rms = np.sqrt(ms[i : i + win].mean())
        if rms > 0:
            vals.append(20 * np.log10(peak[i : i + win].max() / rms))
    return float(np.median(vals)) if vals else float("nan")


def true_peak_dbtp(x: np.ndarray, sr: int) -> float:
    """4x oversampled peak (BS.1770-style approximation), processed in 10 s chunks."""
    x2 = np.atleast_2d(x)
    pk = 0.0
    step = 10 * sr
    for i in range(0, x2.shape[1], step):
        y = resample_poly(x2[:, i : i + step + 64], 4, 1, axis=1)
        pk = max(pk, float(np.max(np.abs(y))))
    return 20 * np.log10(pk + 1e-12)


def lra(p: np.ndarray) -> float:
    """EBU Tech 3342 loudness range from 100 ms block powers."""
    st = F.windowed(p, 30)[29:]
    st = st[F.lufs_from_ms(st) > -70]
    if len(st) < 10:
        return float("nan")
    rel = F.lufs_from_ms(st.mean()) - 20
    v = F.lufs_from_ms(st[F.lufs_from_ms(st) > rel])
    return float(np.percentile(v, 95) - np.percentile(v, 10))


def stereo_width(x: np.ndarray) -> float:
    if np.atleast_2d(x).shape[0] < 2:
        return 0.0
    L, R = x[0], x[1]
    return float(np.mean((L - R) ** 2) / max(np.mean((L + R) ** 2), 1e-20))


@dataclass
class GroupAnalysis:
    """Everything measured for a set of groups that play together (reference stems or a mix)."""
    groups: list
    sr: int
    nb: int
    p: dict = field(default_factory=dict)          # group -> K-weighted block power
    peak: dict = field(default_factory=dict)
    ms: dict = field(default_factory=dict)
    st: dict = field(default_factory=dict)         # short-term loudness (LUFS) per block
    active: dict = field(default_factory=dict)
    band_t: np.ndarray = None
    bands: dict = field(default_factory=dict)      # group -> frames x bands (dB)
    p_prog: np.ndarray = None                      # program (sum of groups, or the master)
    st_prog: np.ndarray = None
    density: np.ndarray = None                     # number of active groups per block

    def to_summary(self) -> dict:
        return {
            g: {
                "active_fraction": round(float(self.active[g].mean()), 3),
                "integrated_LUFS": round(_integrated_from_p(self.p[g]), 2),
                "momentary_spread_LU": round(momentary_spread(self.p[g], self.active[g]), 2),
                "crest_dB": round(crest_db(self.peak[g], self.ms[g], self.active[g]), 2),
            }
            for g in self.groups
        }


def _integrated_from_p(p: np.ndarray) -> float:
    m = F.windowed(p, 4)[3:]
    m = m[F.lufs_from_ms(m) > -70]
    if not len(m):
        return float("-inf")
    rel = F.lufs_from_ms(m.mean()) - 10
    m = m[F.lufs_from_ms(m) > rel]
    return float(F.lufs_from_ms(m.mean())) if len(m) else float("-inf")


def analyse_groups(signals: dict, sr: int, program: np.ndarray | None = None, activity_overrides: dict | None = None,
                   role_of: dict | None = None, with_bands: bool = True) -> GroupAnalysis:
    groups = list(signals.keys())
    stats = {g: block_stats(signals[g], sr) for g in groups}
    nb = min(len(s[0]) for s in stats.values())
    ga = GroupAnalysis(groups, sr, nb)
    for g in groups:
        p, pk, ms = stats[g]
        ga.p[g], ga.peak[g], ga.ms[g] = p[:nb], pk[:nb], ms[:nb]
        ga.st[g] = F.short_term(ga.p[g])
    if program is not None:
        ga.p_prog = block_stats(program, sr)[0][:nb]
    else:
        ga.p_prog = sum(ga.p[g] for g in groups)  # power additivity (verified within 0.32 LU, exp01)
    ga.st_prog = F.short_term(ga.p_prog)
    for g in groups:
        role = (role_of or {}).get(g, g)
        ga.active[g] = activity(ga.p[g], ga.p_prog, activity_params(role, activity_overrides))
    ga.density = sum(ga.active[g].astype(int) for g in groups)
    if with_bands:
        for g in groups:
            t, b = band_frames(signals[g], sr)
            ga.band_t, ga.bands[g] = t, b
    return ga


def density_class(n_active: np.ndarray, n_groups: int) -> np.ndarray:
    """sparse / medium / full by fraction of groups active."""
    frac = n_active / max(n_groups, 1)
    return np.where(frac <= 0.4, "sparse", np.where(frac >= 0.8, "full", "medium"))


# --------------------------------------------------------------------------- density research (0.5.0)
DENSITY_MEASURES = {
    "count": "Active groups (current classifier input)",
    "count_no_bed": "Active groups, excluding 'sustained beds' (groups active >= 95 % of the song)",
    "n_effective": "Loudness-weighted effective number of the OTHER active groups: (sum p)^2 / sum p^2",
    "prominent": "OTHER active groups within 12 LU of the loudest of them (short-term)",
    "intensity": "Short-term loudness of the OTHER groups combined, relative to their own integrated loudness (section energy)",
}


def density_measures(ga: "GroupAnalysis", exclude=(), bed_fraction: float = 0.95, prominence_lu: float = 12.0) -> dict:
    """Alternative per-block descriptions of arrangement density, for research (density study).

    `exclude`: the pair being studied. Loudness-based measures use only the other groups, otherwise a
    measure would partly contain the pair's own balance (circular). The operator still uses
    `density_class(count)`; nothing here changes its behaviour."""
    G = list(ga.groups)
    act = np.array([ga.active[g] for g in G])                      # groups x blocks
    beds = [g for g, a in zip(G, act) if a.mean() >= bed_fraction]
    oth = [i for i, g in enumerate(G) if g not in exclude]
    keep = np.array([g not in beds for g in G])
    out = {"count": act.sum(0).astype(float), "count_no_bed": act[keep].sum(0).astype(float), "beds": beds,
           "active_fraction": {g: round(float(a.mean()), 3) for g, a in zip(G, act)}}
    if oth:
        st = np.array([ga.st[G[i]] for i in oth])
        ao = act[oth]
        p = np.where(ao & np.isfinite(st), 10 ** (np.nan_to_num(st, nan=-200) / 10), 0.0)
        with np.errstate(invalid="ignore", divide="ignore"):
            out["n_effective"] = np.where(p.sum(0) > 0, p.sum(0) ** 2 / np.maximum((p ** 2).sum(0), 1e-30), 0.0)
        stm = np.where(ao, np.nan_to_num(st, nan=-200), -200)
        loud = stm.max(0)
        out["prominent"] = (((stm >= loud - prominence_lu) & ao).sum(0)).astype(float)
        pb = sum(ga.p[G[i]] for i in oth)
        out["intensity"] = F.lufs_from_ms(F.windowed(pb, 30)) - _integrated_from_p(pb)
    else:
        n = len(ga.density)
        out.update({"n_effective": np.zeros(n), "prominent": np.zeros(n), "intensity": np.zeros(n)})
    return out
