"""Offline rendering for listening comparisons.

Only VALIDATED capabilities (bounded gain offsets) are applied to `after.wav`. An optional
`after_experimental_eq.wav` applies EQ recommendations with a generic bell as a stand-in
for the strip's own EQ plugin; it is clearly labelled and never part of the validated path.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

from . import audio_io as io
from . import features as F
from .analysis import HOP_S


def block_gain_to_samples(offsets_db: np.ndarray, n: int, sr: int) -> np.ndarray:
    """Per-block dB offsets -> smooth per-sample linear gain (linear interpolation of dB)."""
    hop = int(round(sr * HOP_S))
    centres = (np.arange(len(offsets_db)) + 0.5) * hop
    g_db = np.interp(np.arange(n), centres, offsets_db)
    return 10 ** (g_db / 20)


def apply_offsets(signals: dict, groups: list, hist: np.ndarray, sr: int) -> np.ndarray:
    n = min(s.shape[1] for s in signals.values())
    out = np.zeros((2, n))
    for i, g in enumerate(groups):
        out += signals[g][:, :n] * block_gain_to_samples(hist[i], n, sr)
    for g in signals:
        if g not in groups:
            out += signals[g][:, :n]
    return out


def peaking(x, f0, gain_db, sr, q=1.4):
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / sr
    al = np.sin(w) / (2 * q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    return lfilter(b / a[0], a / a[0], x, axis=-1)


def loudness_match(pair: dict, target_lufs: float = -18.0, peak_ceiling_db: float = -1.0, sr: int = io.PROJECT_SR) -> dict:
    """Bring every version to the same integrated loudness; then one common gain keeps all sample
    peaks under the ceiling (no limiter: nothing may change the comparison except the actions).
    Returns (matched versions, info). info["gains_dB"] holds the listening gain applied to each
    version, so it is never confused with what the operator did."""
    gains = {k: 10 ** ((target_lufs - F.integrated(v, sr)) / 20) for k, v in pair.items()}
    peaks = max(float(np.max(np.abs(v))) * gains[k] for k, v in pair.items())
    common = min(1.0, 10 ** (peak_ceiling_db / 20) / max(peaks, 1e-12))
    info = {"target_LUFS": target_lufs, "common_peak_trim_dB": round(20 * np.log10(common), 2),
            "gains_dB": {k: round(float(20 * np.log10(g * common)), 2) for k, g in gains.items()}}
    return {k: v * gains[k] * common for k, v in pair.items()}, info


def write_listening_set(out_dir: Path, versions: dict, sr: int, seed: int | None = None, target_lufs=-18.0,
                        blind: bool = True, group_sets: dict | None = None) -> dict:
    """Writes <name>.wav for every version (loudness-matched) plus blind/A.wav, blind/B.wav (+ key.json).

    group_sets: optional {version: {group: signal}} - each version's group contributions, written to
    groups/<group>-<version>.wav with THAT version's listening gain, so solo/mute audition keeps the
    exact relative levels of the corresponding mix."""
    matched, info = loudness_match(versions, target_lufs, sr=sr)
    paths = {}
    for k, v in matched.items():
        paths[k] = io.write(out_dir / f"{k}.wav", v, sr)
    if blind and "before" in matched and "after" in matched:
        order = ["before", "after"]
        random.Random(seed).shuffle(order)
        bdir = out_dir / "blind"
        io.write(bdir / "A.wav", matched[order[0]], sr)
        io.write(bdir / "B.wav", matched[order[1]], sr)
        (bdir / "key.json").write_text(json.dumps({"A": order[0], "B": order[1]}, indent=1))
        info["blind"] = "blind/A.wav, blind/B.wav (answer in blind/key.json - don't open it until you've listened)"
    info["files"] = {k: Path(p).name for k, p in paths.items()}
    if group_sets:
        info["groups"] = {}
        for ver, gs in group_sets.items():
            g_lin = 10 ** (info["gains_dB"][ver] / 20)
            for g, sig in gs.items():
                name = f"groups/{g}-{ver}.wav"
                io.write(out_dir / name, sig * g_lin, sr)
                info["groups"].setdefault(g, {})[ver] = name
    return info
