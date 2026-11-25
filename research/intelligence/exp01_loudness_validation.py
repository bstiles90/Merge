"""Experiment 01: validate the BS.1770 measurement primitives.

Questions
1. Do our K-weighting coefficients (the same closed form Merge's native engine
   uses in engine/src/Mixer.cpp) match the BS.1770 reference table at 48 kHz and
   an independent implementation (pyloudnorm)?
2. Does integrated loudness agree with pyloudnorm on tones, noise and the
   synthetic groups?
3. Is K-weighted power additive across groups (the assumption the gain-prediction
   model in exp02 relies on), and how large is the error for each group pair?
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyloudnorm as pyln

sys.path.insert(0, str(Path(__file__).parent))
from mi import features as F
from mi import synth as S

out = {}
fs = 48000

# 1. coefficients vs the BS.1770-4 table (48 kHz)
(bs, as_), (bh, ah) = F.k_weighting_coeffs(fs)
table = {
    "shelf_b": [1.53512485958697, -2.69169618940638, 1.19839281085285],
    "shelf_a": [1.0, -1.69065929318241, 0.73248077421585],
    "hp_b": [1.0, -2.0, 1.0],
    "hp_a": [1.0, -1.99004745483398, 0.99007225036621],
}
mine = {"shelf_b": bs, "shelf_a": as_, "hp_b": bh, "hp_a": ah}
out["coef_max_abs_err_vs_bs1770_table"] = float(max(np.max(np.abs(np.array(table[k]) - mine[k])) for k in table))

# 2. integrated loudness agreement
meter = pyln.Meter(fs)  # BS.1770-4
rng = np.random.default_rng(1)
t = np.arange(int(20 * fs)) / fs
cases = {
    "1k_sine_-20dBFS_stereo": np.stack([0.1 * np.sin(2 * np.pi * 1000 * t)] * 2),
    "pink_ish_noise_stereo": np.stack([S._lp(rng.standard_normal(len(t)), 4000) * 0.1] * 2),
}
groups = S.make_groups(20.0, seed=2)
for g, x in groups.items():
    cases[f"synth_{g}_mono_as_stereo"] = np.stack([x * 0.2, x * 0.2])
agree = {}
for name, x in cases.items():
    a = F.integrated(x, fs)
    b = meter.integrated_loudness(x.T)
    agree[name] = {"ours": round(a, 3), "pyloudnorm": round(float(b), 3), "diff": round(a - float(b), 3)}
out["integrated_agreement_LUFS"] = agree

# 3. power additivity of the K-weighted mix (long-term and short-term)
gains = {"vocals": 0.25, "drums": 0.3, "bass": 0.35, "guitars": 0.15, "keys": 0.2}
pg = {g: F.block_power(groups[g] * gains[g], fs) for g in groups}
mix = sum(groups[g] * gains[g] for g in groups)
pm = F.block_power(mix, fs)
st_sum = F.short_term(sum(pg.values()))
st_mix = F.short_term(pm)
err = (st_mix - st_sum)[30:]
out["additivity_short_term_LU"] = {
    "mean": round(float(np.mean(err)), 3),
    "p95_abs": round(float(np.percentile(np.abs(err), 95)), 3),
    "max_abs": round(float(np.max(np.abs(err))), 3),
}
pair = {}
for i, a in enumerate(S.GROUPS):
    for b in S.GROUPS[i + 1 :]:
        pa, pb = pg[a], pg[b]
        pab = F.block_power(groups[a] * gains[a] + groups[b] * gains[b], fs)
        e = (F.short_term(pab) - F.short_term(pa + pb))[30:]
        pair[f"{a}+{b}"] = round(float(np.percentile(np.abs(e), 95)), 3)
out["additivity_pairwise_p95_abs_LU"] = pair

Path(__file__).parent.joinpath("results").mkdir(exist_ok=True)
Path(__file__).parent.joinpath("results/exp01.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
