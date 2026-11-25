"""Experiment 03: can level-normalised spectral shape tell a TONAL problem from a LEVEL problem?

Vision section 13.2: "If a source is at an appropriate level but has excessive
low-mid energy, a small EQ adjustment may be more appropriate than reducing its
fader." This tests the measurement half of that decision on a synthetic vocal.

Disturbances applied to the live vocal (a different 'performance' from the reference):
  level+3      broadband +3 dB                         -> expected: fader
  lowmid+5     +5 dB peaking EQ at 300 Hz, Q 1.0       -> expected: EQ (low-mid band)
  presence-4   -4 dB peaking EQ at 3 kHz, Q 1.0        -> expected: EQ (presence band)
  none         nothing                                 -> expected: no action
  vocalist-B   a different vocalist (f0 165 Hz, other seed), no disturbance
               -> expected: no action, OR only a small tonal flag (natural difference)

Decision features (per group, long-term, octave bands 63 Hz - 16 kHz):
  level_dev  = K-weighted loudness relative to the rest of the mix, minus reference
  shape_dev  = tonal_shape(live) - tonal_shape(reference)  (overall level removed)
  A tonal problem is flagged when one band (or two adjacent) carries a large,
  localised shape deviation; a level problem when level_dev is large and shape_dev flat.
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from mi import features as F
from mi import synth as S

FS = S.FS
DUR = 30.0
edges = F.band_edges(44.2, 16000, 1)  # octave bands centred ~63 Hz .. 11 kHz
centres = np.sqrt(edges[:-1] * edges[1:])


def analyse(vox, rest):
    lv = F.integrated(vox, FS)
    lr = F.integrated(rest, FS)
    shape = F.tonal_shape(F.band_energies_db(vox, FS, edges))
    return lv - lr, shape


rng_ref = np.random.default_rng(20)
ref_vox = S.vocal(DUR, rng_ref) * S.db(-10)
others = S.make_groups(DUR, seed=21)
rest = sum(others[g] * S.db(x) for g, x in {"drums": -9, "bass": -8, "guitars": -15, "keys": -13}.items())
ref_level, ref_shape = analyse(ref_vox, rest)

live_vox = S.vocal(DUR, np.random.default_rng(22)) * S.db(-10)
cases = {
    "none": live_vox,
    "level+3": live_vox * S.db(3),
    "lowmid+5": S.peaking_eq(live_vox, 300, 5, 1.0),
    "presence-4": S.peaking_eq(live_vox, 3000, -4, 1.0),
    "vocalist-B": S.vocal(DUR, np.random.default_rng(23), f0=165.0) * S.db(-10),
}

TONAL_DB = 1.5   # localised band deviation needed to call a tonal problem
LEVEL_DB = 1.5   # level deviation needed to call a level problem
out = {"band_centres_hz": [round(c) for c in centres]}
for name, v in cases.items():
    lev, shape = analyse(v, rest)
    d_level = lev - ref_level
    d_shape = shape - ref_shape
    # localisation: the largest band deviation vs the spread of the others
    k = int(np.argmax(np.abs(d_shape)))
    others_spread = float(np.median(np.abs(np.delete(d_shape, k))))
    localised = abs(d_shape[k]) > TONAL_DB and abs(d_shape[k]) > 2.5 * max(others_spread, 0.2)
    if localised and abs(d_level) < 2 * LEVEL_DB:
        decision = f"EQ: {'cut' if d_shape[k] > 0 else 'boost'} ~{abs(d_shape[k]):.1f} dB near {centres[k]:.0f} Hz"
    elif abs(d_level) > LEVEL_DB:
        decision = f"fader: {'-' if d_level > 0 else '+'}{abs(d_level):.1f} dB"
    else:
        decision = "no action"
    out[name] = {
        "level_dev_LU": round(float(d_level), 2),
        "shape_dev_dB": [round(float(x), 1) for x in d_shape],
        "max_band": f"{centres[k]:.0f} Hz",
        "decision": decision,
    }

Path(__file__).parent.joinpath("results/exp03.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))


# ----------------------------------------------------------------------------------
# Part 2: action selection by model fitting (which authorised action best EXPLAINS
# the measured deviation), energy-weighted bands, a cost per used control, and two
# kinds of tonal target: the reference stem vs the source's own engineer-approved
# baseline (a "soundcheck fingerprint" taken from the first, clean, 10 s).
# ----------------------------------------------------------------------------------
def peaking_response_db(f0, fs=FS, q=1.0, gain=1.0, freqs=centres):
    A = 10 ** (gain / 40)
    w = 2 * np.pi * f0 / fs
    al = np.sin(w) / (2 * q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    z = np.exp(-1j * 2 * np.pi * freqs / fs)
    H = (b[0] + b[1] * z + b[2] * z ** 2) / (a[0] + a[1] * z + a[2] * z ** 2)
    return 20 * np.log10(np.abs(H))


EQ_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000]  # stand-in for an existing plugin's bands
BASIS = {f: peaking_response_db(f) for f in EQ_BANDS}  # dB per +1 dB band gain (~linear for small gains)
COST = {"fader": 0.3, "eq": 0.8}  # dB^2-equivalent evidence required per control (EQ needs more)
MAX = {"fader": 4.0, "eq": 3.0}


def band_levels(v):
    return F.band_energies_db(v, FS, edges)


def select_action(live, target, weighting="loudness"):
    d = band_levels(live) - band_levels(target)
    e = 10 ** (band_levels(live) / 10) + 10 ** (band_levels(target) / 10)
    if weighting == "energy":
        w = np.maximum(e / e.sum(), 0.01)
    else:  # compressive, specific-loudness-like weighting (N' ~ E^0.23, Zwicker / Moore-Glasberg)
        w = e ** 0.25
        w = np.maximum(w / w.sum(), 0.01)
    cands = [("none", 0.0, None, 0.0, float((w * d ** 2).sum()))]
    g = float((w * d).sum() / w.sum())
    cands.append(("fader", float(np.clip(-g, -MAX["fader"], MAX["fader"])), None, COST["fader"], float((w * (d - g) ** 2).sum())))
    for f, r in BASIS.items():
        for with_fader in (False, True):
            X = np.stack([r, np.ones_like(r)], 1) if with_fader else r[:, None]
            sol, *_ = np.linalg.lstsq(X * np.sqrt(w)[:, None], d * np.sqrt(w), rcond=None)
            h = float(np.clip(sol[0], -MAX["eq"] * 3, MAX["eq"] * 3))
            gg = float(sol[1]) if with_fader else 0.0
            res = float((w * (d - h * r - gg) ** 2).sum())
            cost = COST["eq"] + (COST["fader"] if with_fader else 0.0)
            cands.append(("eq+fader" if with_fader else "eq", float(np.clip(-gg, -4, 4)), (f, float(np.clip(-h, -MAX["eq"], MAX["eq"]))), cost, res))
    best = min(cands, key=lambda c: c[3] + c[4])
    kind, fader, eq, cost, res = best
    desc = {"none": "no action"}.get(kind)
    if desc is None:
        parts = []
        if eq:
            parts.append(f"EQ band {eq[0]} Hz {eq[1]:+.1f} dB")
        if kind in ("fader", "eq+fader") and abs(fader) >= 0.25:
            parts.append(f"fader {fader:+.1f} dB")
        desc = " + ".join(parts) if parts else "no action"
    return {"decision": desc, "residual_before": round(cands[0][4], 2), "residual_after": round(res, 2)}


part2 = {}
base = slice(0, int(10 * FS))
later = slice(int(10 * FS), None)
for name, v in cases.items():
    part2[name] = {
        "energy_weighted_vs_reference_stem": select_action(v, ref_vox, "energy"),
        "vs_reference_stem": select_action(v, ref_vox),
        # target = the same source's own clean first 10 s (vocalist-B: itself, undisturbed)
        "vs_own_baseline": select_action(v[later], (live_vox if name != "vocalist-B" else v)[base]),
    }
out2 = json.loads(Path(__file__).parent.joinpath("results/exp03.json").read_text())
out2["part2_action_selection"] = part2
Path(__file__).parent.joinpath("results/exp03.json").write_text(json.dumps(out2, indent=2))
print(json.dumps(part2, indent=2))
