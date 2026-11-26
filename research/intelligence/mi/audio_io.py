"""Audio file input/output for the offline prototype.

Reads WAV/AIFF/FLAC through `soundfile` (libsndfile). Everything is converted to
float64, shape (channels, samples), at the project sample rate (48 kHz by default;
other rates are resampled with a polyphase filter and reported as a warning).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

PROJECT_SR = 48000
AUDIO_EXT = {".wav", ".wave", ".aif", ".aiff", ".flac"}


@dataclass
class Audio:
    data: np.ndarray            # (channels, samples) float64
    sr: int
    path: str = ""
    original_sr: int = 0
    subtype: str = ""
    warnings: list = field(default_factory=list)

    @property
    def channels(self) -> int:
        return self.data.shape[0]

    @property
    def samples(self) -> int:
        return self.data.shape[1]

    @property
    def seconds(self) -> float:
        return self.samples / self.sr

    def mono(self) -> np.ndarray:
        return self.data.mean(axis=0)

    def stereo(self) -> np.ndarray:
        return np.vstack([self.data[0], self.data[0]]) if self.channels == 1 else self.data[:2]


def read(path, sr: int = PROJECT_SR) -> Audio:
    path = Path(path)
    info = sf.info(str(path))
    x, file_sr = sf.read(str(path), dtype="float64", always_2d=True)
    x = x.T.copy()
    warnings = []
    if file_sr != sr:
        fr = Fraction(sr, file_sr).limit_denominator(1000)
        x = resample_poly(x, fr.numerator, fr.denominator, axis=1)
        warnings.append(f"{path.name}: resampled {file_sr} Hz -> {sr} Hz (supply {sr} Hz to avoid this)")
    if x.shape[0] > 2:
        warnings.append(f"{path.name}: {x.shape[0]} channels; only the first two are used")
        x = x[:2]
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak >= 0.999:
        warnings.append(f"{path.name}: sample peak {20 * math.log10(peak):.2f} dBFS - possible clipping in the export")
    return Audio(x, sr, str(path), file_sr, info.subtype, warnings)


def write(path, data: np.ndarray, sr: int = PROJECT_SR, subtype: str = "PCM_24") -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    d = np.atleast_2d(data)
    sf.write(str(path), d.T, sr, subtype=subtype)
    return str(path)


def align_lengths(items: dict) -> tuple[dict, list]:
    """Trim/pad a dict of Audio to the shortest common length; report mismatches."""
    if not items:
        return items, []
    n = min(a.samples for a in items.values())
    longest = max(a.samples for a in items.values())
    notes = []
    if longest - n > 0.01 * PROJECT_SR:
        notes.append(f"files differ in length by {(longest - n) / PROJECT_SR:.2f} s; trimmed to the shortest "
                     "(export all files with identical start and end points)")
    for a in items.values():
        a.data = a.data[:, :n]
    return items, notes


def estimate_offset(a: np.ndarray, b: np.ndarray, sr: int = PROJECT_SR, max_ms: float = 50.0) -> float:
    """Lag (ms) that best aligns b to a, by cross-correlation of the first 30 s (mono)."""
    n = min(len(a), len(b), 30 * sr)
    if n < sr:
        return 0.0
    m = int(max_ms * 1e-3 * sr)
    A = np.fft.rfft(a[:n], 2 * n)
    B = np.fft.rfft(b[:n], 2 * n)
    c = np.fft.irfft(A * np.conj(B))
    lags = np.concatenate([c[-m:], c[: m + 1]])
    k = int(np.argmax(np.abs(lags))) - m
    return 1000.0 * k / sr
