"""Regression suite: the Phase 0 synthetic experiments and the offline prototype.

    ./run.sh test            (or: .venv/bin/python -m pytest -q tests)

Each experiment script is executed exactly as a user would run it; its results JSON is then
checked against the findings recorded in docs/MERGE_INTELLIGENCE_RESEARCH.md §11 and the
Dugan supplement. Tolerances are deliberately a little looser than the recorded values, so
legitimate refactoring passes and behavioural regressions fail.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))


def run_exp(name: str) -> dict:
    subprocess.run([sys.executable, "-W", "ignore", str(HERE / f"{name}.py")], cwd=HERE, check=True,
                   stdout=subprocess.DEVNULL)
    return json.loads((HERE / "results" / f"{name.split('_')[0]}.json").read_text())


# ----------------------------------------------------------------------------- exp01
def test_exp01_loudness():
    r = run_exp("exp01_loudness_validation")
    assert r["coef_max_abs_err_vs_bs1770_table"] < 1e-12
    for case in r["integrated_agreement_LUFS"].values():
        assert abs(case["diff"]) < 0.1                       # pyloudnorm's approximated filter: ~0.04 LU
    assert abs(r["integrated_agreement_LUFS"]["1k_sine_-20dBFS_stereo"]["ours"] + 20.0) < 0.05
    assert r["additivity_short_term_LU"]["p95_abs"] < 0.5


# ----------------------------------------------------------------------------- exp02
def test_exp02_balance_controller():
    r = run_exp("exp02_balance_controller")
    c2 = r["C2_pairwise_feedforward_to_median"]
    assert c2["guitars+3_20_40"]["guitars"] <= -1.8           # corrects most of +3 dB
    assert c2["vocals-3_40_60"]["vocals"] >= 2.0              # corrects most of -3 dB
    for seg in ("band+3_60_80", "keys_off_80_100", "clean_100_120", "clean_0_20"):
        assert max(abs(v) for v in c2[seg].values()) < 0.4    # ignores builds, dropouts, clean material
    others = [v for g, v in c2["guitars+3_20_40"].items() if g != "guitars"]
    assert max(abs(v) for v in others) < 0.3                  # L1 prior: fixes only the offender
    b = r["B_pairwise_integrator"]
    assert c2["direction_reversals"] < b["direction_reversals"] / 2
    assert r["A_mixrelative_integrator"]["band+3_60_80"]["vocals"] > 3.0   # the textbook loop winds up


# ----------------------------------------------------------------------------- exp03
def test_exp03_action_selection():
    r = run_exp("exp03_eq_vs_fader")["part2_action_selection"]
    own = {k: v["vs_own_baseline"]["decision"] for k, v in r.items()}
    assert own["none"] == "no action"
    assert own["level+3"].startswith("fader -")
    assert "EQ band 250 Hz -" in own["lowmid+5"]
    assert "EQ band 4000 Hz +" in own["presence-4"]
    assert own["vocalist-B"] == "no action"                   # baseline-anchored tone
    assert r["vocalist-B"]["vs_reference_stem"]["decision"] != "no action"   # stem-anchored tone is fooled
    assert r["presence-4"]["energy_weighted_vs_reference_stem"]["decision"] == "no action"  # energy weighting hides it


# ----------------------------------------------------------------------------- exp04
@pytest.mark.slow
def test_exp04_compression_not_identifiable():
    r = run_exp("exp04_compression_identifiability")
    s = r["unknown_input_match_summary"]
    assert s["n_matches"] >= 10
    assert len(s["distinct_input_dynamics"]) >= 2
    assert s["gr_mean_range_db"][1] - s["gr_mean_range_db"][0] > 8


# ----------------------------------------------------------------------------- exp05
def test_exp05_gain_sharing():
    r = run_exp("exp05_gain_sharing")
    for case in r["A_patent_examples"].values():
        assert np.max(np.abs(np.array(case["gains_dB"]) - np.array(case["patent_dB"]))) < 0.4   # recorded: within 0.3 dB
        assert abs(case["total_power_gain_dB"]) < 0.15
    b = r["B_bleed_comb_noise"]
    assert b["comb_ripple_1to4k_dB_all_open"] - b["comb_ripple_1to4k_dB_gain_sharing"] > 2.0
    assert abs(b["ambient_noise_in_pauses_dB_gain_sharing"] - b["one_mic_ambient_dB_reference"]) < 1.0
    c = r["C_singing_vocals"]
    assert c["after_gain_sharing_dB"][1] < -10                # gain sharing doubles the BGV offset
    assert abs(c["after_soft_gate_dB"][1] - c["measured_relative_before_dB"][1]) < 1.0
    for mic in ("mic1", "mic2", "mic3"):
        d = r["D_layering"][mic]
        assert abs(d["layered_request_while_talking_dB"] - d["true_speech_level_correction_dB"]) < 1.0
        assert d["layered_request_while_idle_dB"] == 0.0
        assert d["naive_post_automix_request_while_idle_dB"] >= 5.0


# ----------------------------------------------------------------------------- prototype
@pytest.fixture(scope="module")
def demo_ws(tmp_path_factory):
    from mi.demo import make
    ws = make(tmp_path_factory.mktemp("ws"), dur=90.0)
    from mi.cli import main
    main(["profile", str(ws)])
    main(["compare", str(ws), "demo-mix", "--seed", "1", "--experimental-render"])
    main(["speech", str(ws), "demo-speech", "--seed", "1"])
    return ws


def test_prototype_outputs_exist(demo_ws):
    c = demo_ws / "results" / "compare" / "demo-mix"
    for f in ("report.md", "analysis.json", "decisions.jsonl", "offsets.csv", "offsets.png", "audio/before.wav",
              "audio/after.wav", "audio/after_experimental_eq.wav", "audio/blind/A.wav", "audio/blind/key.json"):
        assert (c / f).exists(), f
    assert (demo_ws / "profiles" / "profile.md").exists()
    s = demo_ws / "results" / "speech" / "demo-speech"
    for f in ("report.md", "audio/before.wav", "audio/after.wav", "audio/after_automix.wav"):
        assert (s / f).exists(), f


def test_prototype_truth_known_correction(demo_ws):
    r = json.loads((demo_ws / "results" / "compare" / "demo-mix" / "analysis.json").read_text())
    for j in r["injection_score"]["injections"]:
        assert 0.5 <= j["corrected_fraction"] <= 1.2, j
        assert j["max_other_mean_abs_dB"] < 0.6, j
    assert r["injection_score"]["rms_response_outside_disturbances_dB"] < 0.3


def test_prototype_continuous_sources_are_active(demo_ws):
    """Regression for the idle-floor bug: a continuously playing source must not be 'inactive'."""
    r = json.loads((demo_ws / "results" / "compare" / "demo-mix" / "analysis.json").read_text())
    for g in ("bass", "guitars", "drums"):
        assert r["groups"][g]["active_fraction"] > 0.95, g


def test_prototype_maturity_labels(demo_ws):
    acts = [json.loads(l) for l in (demo_ws / "results" / "compare" / "demo-mix" / "decisions.jsonl").read_text().splitlines()]
    assert acts
    for a in acts:
        if a["kind"] in ("eqBandGain", "compressionIntensity", "programSteering"):
            assert a["maturity"] == "experimental" and a["status"] in ("recommendation-only", "deferred", "withheld")
        if a["kind"] in ("groupGainOffset", "staticGroupOffset"):
            assert a["maturity"] == "validated"
            assert a["bounds"][0] <= a["proposed"] <= a["bounds"][1]


def test_prototype_render_is_loudness_matched(demo_ws):
    from mi import audio_io as io
    from mi import features as F
    a = io.read(demo_ws / "results" / "compare" / "demo-mix" / "audio" / "before.wav")
    b = io.read(demo_ws / "results" / "compare" / "demo-mix" / "audio" / "after.wav")
    assert abs(F.integrated(a.data, a.sr) - F.integrated(b.data, b.sr)) < 0.2
    assert np.max(np.abs(a.data - b.data)) > 1e-3            # the actions did change the audio


def test_speech_prototype(demo_ws):
    r = json.loads((demo_ws / "results" / "speech" / "demo-speech" / "analysis.json").read_text())
    assert r["handovers"] >= 2
    need = {"pulpit": -20 - r["mics"][[m["name"] for m in r["mics"]].index("pulpit")]["speech_LUFS"]}
    for m in r["mics"]:
        assert m["floor_s"] > 15, m
        assert m["share_idle_db"] < -8, m
        if m["leveller_db"] is not None and m["speech_LUFS"] is not None:
            assert abs(m["leveller_db"] - (r["target_LUFS"] - m["speech_LUFS"])) < 1.5, m


def test_gain_share_matches_patent():
    from mi.speech import gain_share
    rng = np.random.default_rng(0)
    sr, n = 48000, 48000 * 4
    mics = [rng.standard_normal(n) * 10 ** (lv / 20) for lv in (0, -20, -20, -20)]
    g, share = gain_share(mics, sr, last_hold=False)
    gdb = 20 * np.log10(share[:, len(share[0]) // 2:].mean(axis=1))
    assert np.max(np.abs(gdb - np.array([0, -20, -20, -20]))) < 0.5


def test_processing_vs_performance(demo_ws):
    from mi.cli import main
    main(["study", "processing", str(demo_ws)])
    r = json.loads((demo_ws / "results" / "studies" / "processing" / "result.json").read_text())
    v = {tuple(w["t"]): w["verdict"] for w in r["vocals"]["windows"]}
    assert v[(20, 30)].startswith("performance")             # known performance change, fixed processing
    assert v[(80, 90)] == "processing changed"                # known threshold change from 70 s
    assert all(w["verdict"] == "no meaningful change" for w in r["drums"]["windows"])


def test_studies_run(demo_ws):
    from mi.cli import main
    for s in ("activity", "beta", "response", "generalization"):
        main(["study", s, str(demo_ws)])
        assert (demo_ws / "results" / "studies" / s / "report.md").exists()
    r = json.loads((demo_ws / "results" / "studies" / "generalization" / "result.json").read_text())
    assert all(row["outside"] == 0 for row in r["rows"])
