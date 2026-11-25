"""Experiment 04: can compressor settings be inferred from the processed output?

Vision 7.3: "Do not assume that the amount of compression applied to a reference
source can be uniquely determined from its processed output." This quantifies it.

1. One synthetic vocal is compressed with a grid of (threshold, ratio) settings,
   output loudness-matched (auto make-up). For a 'true' setting we count how many
   OTHER settings produce output dynamics statistics within measurement tolerance
   (crest factor +-0.5 dB, short-term loudness spread +-0.5 LU, momentary spread
   +-0.5 LU). If many do, the setting is not identifiable from those statistics.
2. The same compressor applied to a calmer and a more dynamic delivery of the same
   vocal: how much do the output statistics move with the INPUT alone? (This is why
   a dynamics target has to be a target for the output's behaviour, reached by
   closed-loop adjustment of a compression-intensity control, not a recovered setting.)
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from mi import features as F
from mi import synth as S

FS = 24000  # dynamics statistics do not need full band; keeps the per-sample loop fast
DUR = 12.0


def stats(y):
    p = F.block_power(y, FS)
    act = np.isfinite(F.short_term(p)) & (F.momentary(p) > F.momentary(p).max() - 30)
    act[:30] = False
    m = F.momentary(p)[act]
    return {
        "crest_db": F.crest_factor_db(y),
        "st_spread_lu": F.loudness_spread(p, act, 10, 95),
        "mom_spread_lu": float(np.percentile(m, 95) - np.percentile(m, 10)),
        "gr_mean_db": None,
    }


def loud_match(y, ref_lufs=-23.0):
    return y * 10 ** ((ref_lufs - F.integrated(y, FS)) / 20)


def vocal(dyn, seed=5):
    rng = np.random.default_rng(seed)
    v = S.vocal(DUR, rng, fs=FS)
    t = np.arange(len(v)) / FS
    phrase = 1 + dyn * np.sin(2 * np.pi * t / 5.0)  # delivery: louder/quieter phrases
    return 0.3 * v * np.clip(phrase, 0.1, None)


thr_grid = np.arange(-40, -9, 3.0)
ratio_grid = [1.5, 2, 3, 4, 6, 10]
x = vocal(0.6)
xin = stats(x)
table = {}
for T in thr_grid:
    for R in ratio_grid:
        y, gr = S.compressor(x, T, R, fs=FS)
        st = stats(loud_match(y))
        st["gr_mean_db"] = float(np.mean(gr[np.abs(x) > 1e-3]))
        table[(float(T), float(R))] = st

true = (-25.0, 4.0)
ts = table[true]
tol = {"crest_db": 0.5, "st_spread_lu": 0.5, "mom_spread_lu": 0.5}
aliases = [k for k, v in table.items() if k != true and all(abs(v[m] - ts[m]) <= tol[m] for m in tol)]

# 2. input dependency
deliv = {}
for name, dyn in [("calm", 0.2), ("dynamic", 0.9)]:
    xi = vocal(dyn, seed=5)
    y, gr = S.compressor(xi, *true, fs=FS)
    deliv[name] = {"input": {k: round(v, 2) for k, v in stats(xi).items() if v is not None},
                   "output": {k: round(v, 2) for k, v in stats(loud_match(y)).items() if v is not None}}

out = {
    "input_stats": {k: round(v, 2) for k, v in xin.items() if v is not None},
    "true_setting": {"threshold_db": true[0], "ratio": true[1], **{k: round(v, 2) for k, v in ts.items()}},
    "grid_size": len(table),
    "tolerance": tol,
    "settings_indistinguishable_from_true": [
        {"threshold_db": k[0], "ratio": k[1], "gr_mean_db": round(table[k]["gr_mean_db"], 1),
         **{m: round(table[k][m], 2) for m in tol}} for k in aliases],
    "same_compressor_two_deliveries": deliv,
}
Path(__file__).parent.joinpath("results/exp04.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))


# 3. The reference situation: only the OUTPUT is known; the dry input's dynamics are not.
#    Search (input delivery x threshold x ratio) for combinations whose output statistics
#    match the true output within tolerance.
joint = []
for dyn in [0.2, 0.4, 0.6, 0.9, 1.2]:
    xi = vocal(dyn, seed=5)
    for T in np.arange(-40, -9, 1.5):
        for R in ratio_grid:
            y, gr = S.compressor(xi, float(T), float(R), fs=FS)
            st = stats(loud_match(y))
            if all(abs(st[m] - ts[m]) <= tol[m] for m in tol):
                joint.append({"input_dyn": dyn, "threshold_db": float(T), "ratio": float(R),
                              "gr_mean_db": round(float(np.mean(gr[np.abs(xi) > 1e-3])), 1),
                              **{m: round(st[m], 2) for m in tol}})
out["unknown_input_matches"] = joint
out["unknown_input_match_summary"] = {
    "n_matches": len(joint),
    "distinct_input_dynamics": sorted({j["input_dyn"] for j in joint}),
    "gr_mean_range_db": [min(j["gr_mean_db"] for j in joint), max(j["gr_mean_db"] for j in joint)] if joint else None,
}
Path(__file__).parent.joinpath("results/exp04.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out["unknown_input_match_summary"], indent=2))
for j in joint:
    print(j)
