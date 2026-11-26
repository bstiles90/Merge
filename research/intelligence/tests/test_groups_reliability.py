"""0.5.0: six source groups, song-equal reference weighting, target reliability, non-circular density measures."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mi import analysis as A
from mi.layout import GROUPS, role_for
from mi.reference import target_reliability, _wq


def test_keys_and_synths_are_separate_groups():
    assert "keys" in GROUPS and "synths" in GROUPS
    expect = {"Synths.wav": "synths", "Pad.wav": "synths", "Lead Synth.wav": "synths", "Other.wav": "synths", "Strings.wav": "synths",
              "Keys.wav": "keys", "Piano.wav": "keys", "Organ.wav": "keys", "Rhodes.wav": "keys",
              "Lead Vocal.wav": "vocals", "BGV.wav": "vocals", "Synth Bass.wav": "bass", "Click.wav": None}
    assert {n: role_for(n) for n in expect} == expect


def test_target_reliability_statistics():
    rng = np.random.default_rng(1)
    data = [(f"r{i}", m + 0.1 * rng.standard_normal(300 * (i + 1)), np.ones(300 * (i + 1))) for i, m in enumerate([0.0, 2.0, 4.0, 6.0])]
    r = target_reliability(data)
    assert r["nRefs"] == 4 and abs(r["betweenRefSD"] - np.std([0, 2, 4, 6], ddof=1)) < 0.05
    lo, hi = r["targetCI80"]
    assert 0 <= lo < hi <= 6 and r["targetCI80_width"] > 1
    assert target_reliability(data[:2]).get("targetCI80") is None   # fewer than 3 songs: no interval


def test_song_equal_weighting_is_length_independent():
    short, long_ = np.full(100, 6.0), np.zeros(1000)
    w_old = np.concatenate([np.ones(100), np.ones(1000)])
    w_new = np.concatenate([np.ones(100) / 100, np.ones(1000) / 1000])
    v = np.concatenate([short, long_])
    assert _wq(v, w_old, 0.5) == 0.0                      # before 0.5.0 the long song decided the target
    assert 0.0 < _wq(v, w_new, 0.5) < 6.0                 # now both songs count equally


def test_density_measures_do_not_contain_the_pair_itself():
    rng = np.random.default_rng(3)
    sr = 48000
    sig = {g: 0.1 * rng.standard_normal((2, sr * 20)) for g in ("vocals", "drums", "bass", "synths")}
    ga = A.analyse_groups(sig, sr, with_bands=False)
    a = A.density_measures(ga, exclude=("vocals", "drums"))
    sig2 = dict(sig, vocals=sig["vocals"] * 4.0)           # +12 dB on one member of the pair
    b = A.density_measures(A.analyse_groups(sig2, sr, with_bands=False), exclude=("vocals", "drums"))
    for k in ("n_effective", "prominent", "intensity"):
        assert np.allclose(np.nan_to_num(a[k]), np.nan_to_num(b[k]), atol=1e-6), k
