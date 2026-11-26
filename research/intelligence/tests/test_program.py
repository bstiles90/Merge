"""Truth-known checks for the stereo programme measurements (mi/program.py)."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mi.program import analyse_program, build_program_profile, compare_program

SR = 48000
rng = np.random.default_rng(7)


def noise(seconds=20, color="pink"):
    n = int(seconds * SR)
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    if color == "pink":
        X[1:] /= np.sqrt(f[1:])
    X[0] = 0
    x = np.fft.irfft(X, n)
    return 0.1 * x / np.sqrt(np.mean(x ** 2))


def stereo(L, R=None):
    return np.vstack([L, L if R is None else R])


def test_spectral_tilt_pink_and_white():
    pink = analyse_program(stereo(noise(color="pink")))
    white = analyse_program(stereo(noise(color="white")))
    # equal energy per third octave (pink) -> flat shape; white rises 3 dB/oct
    assert abs(pink["scalars"]["spectrum"]["tilt_dB_per_oct"]) < 0.5
    assert 2.5 < white["scalars"]["spectrum"]["tilt_dB_per_oct"] < 3.5


def test_stereo_correlation_width_balance_mono_loss():
    a, b = noise(), noise()
    mono = analyse_program(stereo(a))["scalars"]["stereo"]
    assert mono["correlation"] > 0.999 and mono["sideToMid_dB"] < -60 and abs(mono["monoLoss_LU"]) < 0.05
    unrel = analyse_program(stereo(a, b))["scalars"]["stereo"]
    assert abs(unrel["correlation"]) < 0.05 and abs(unrel["sideToMid_dB"]) < 0.3
    inv = analyse_program(stereo(a, -a + 0.05 * b))["scalars"]["stereo"]
    assert inv["correlation"] < -0.95 and inv["monoLoss_LU"] < -15
    bal = analyse_program(stereo(a * 2.0, a))["scalars"]["stereo"]
    assert abs(bal["balance_dB"] - 6.02) < 0.05


def test_onset_rate_click_train():
    x = 0.002 * noise(20, "white")
    t = np.arange(len(x)) / SR
    for k in range(int(20 * 4)):                       # 4 clicks per second, decaying bursts
        i = int(k * SR / 4)
        x[i:i + 2400] += 0.5 * np.exp(-np.arange(2400) / 300) * np.sign(np.sin(2 * np.pi * 3000 * t[:2400]))
    r = analyse_program(stereo(x))["scalars"]["transients"]["onsetRate_per_s"]
    assert 3.5 <= r <= 4.5, r


def test_block_crest_sine_vs_clicks():
    t = np.arange(20 * SR) / SR
    sine = analyse_program(stereo(0.3 * np.sin(2 * np.pi * 440 * t)))["scalars"]["transients"]
    assert abs(sine["blockCrest_p50_dB"] - 3.01) < 0.2


def test_profile_ranges_and_diagnostic_comparison():
    refs = [analyse_program(stereo(noise(), noise() * 0.3)) for _ in range(4)]
    prof = build_program_profile([{"id": str(i), "analysis": a} for i, a in enumerate(refs)])
    assert prof["n_references"] == 4 and prof["metrics"]["spectrum.tilt_dB_per_oct"]["stats"]["n"] == 4
    same = compare_program(analyse_program(stereo(noise(), noise() * 0.3)), prof)
    assert not [f for f in same["findings"] if f["domain"] == "spectrum" and abs(f["deviation"]) > 1.5]
    # boost 2-4 kHz by 6 dB: the comparison must flag that region, and nothing claims a source
    x = noise()
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X[(f > 2000) & (f < 4000)] *= 2.0
    y = np.fft.irfft(X, len(x))
    c = compare_program(analyse_program(stereo(y, noise() * 0.3)), prof)
    spec = [f for f in c["findings"] if f["metric"] == "spectrum.shape" and f["deviation"] > 0]
    assert spec and spec[0]["band_hz"][0] >= 1600 and spec[0]["band_hz"][1] <= 5000
    assert "not processing instructions" in c["note"]
    assert not any(w in f["text"].lower() for f in c["findings"] for w in ("vocal", "guitar", "drum", "bass ", "keys"))
