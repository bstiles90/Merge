"""Specialists propose; the operator arbitrates (strategy architecture §4.3-§5).

Offline prototype scope:
  MusicSpecialist   balance (validated), tone (experimental), dynamics (experimental)
  ProgramSpecialist program loudness / LRA / true peak (diagnostic), headroom steering (experimental)
  (SpeechSpecialist lives in speech.py; Hybrid and Audience are declared but not implemented yet)

Arbitration rules implemented here:
  R1/R2  estimates are offset-free and activity-gated (inside controller.run)
  R3     one owner per control per objective: at most one gain-layer action per group/time
  R5     program steering may only reduce, never undo activity/context attenuation
  Timescale precedence: dynamics recommendations are deferred for groups whose balance is
         still being corrected (level first, then tone, then dynamics)
  Permissions validate everything; only VALIDATED capabilities are ever rendered.
"""

from __future__ import annotations

import numpy as np

from . import analysis as A
from . import controller as C
from .actions import VALIDATED, ControlAction, validate

# --------------------------------------------------------------------- EQ candidate basis
EQ_Q = 1.4  # ~1 octave bell


def peaking_response_db(f0, freqs, sr=48000, q=EQ_Q, gain=1.0):
    Aa = 10 ** (gain / 40)
    w = 2 * np.pi * f0 / sr
    al = np.sin(w) / (2 * q)
    b = np.array([1 + al * Aa, -2 * np.cos(w), 1 - al * Aa])
    a = np.array([1 + al / Aa, -2 * np.cos(w), 1 - al / Aa])
    z = np.exp(-1j * 2 * np.pi * np.asarray(freqs) / sr)
    H = (b[0] + b[1] * z + b[2] * z ** 2) / (a[0] + a[1] * z + a[2] * z ** 2)
    return 20 * np.log10(np.abs(H))


EQ_BANDS = [float(c) for c in A.BAND_CENTRES[1:8]]   # 125 Hz .. 8 kHz candidate bands
BASIS = {f: peaking_response_db(f, A.BAND_CENTRES) for f in EQ_BANDS}
COST = {"fader": 0.3, "eq": 0.8}


def explain_tonal(d, w, allow_fader=True, eq_max=3.0):
    """exp03 action selection: which candidate best EXPLAINS band deviation d (dB)?"""
    d = np.nan_to_num(d)
    cands = [{"kind": "none", "res": float((w * d ** 2).sum()), "cost": 0.0}]
    if allow_fader:
        g = float((w * d).sum() / w.sum())
        cands.append({"kind": "fader", "fader": -g, "res": float((w * (d - g) ** 2).sum()), "cost": COST["fader"]})
    for f, r in BASIS.items():
        for with_f in ((False, True) if allow_fader else (False,)):
            X = np.stack([r, np.ones_like(r)], 1) if with_f else r[:, None]
            sol, *_ = np.linalg.lstsq(X * np.sqrt(w)[:, None], d * np.sqrt(w), rcond=None)
            h, gg = float(sol[0]), float(sol[1]) if with_f else 0.0
            hc = float(np.clip(h, -3 * eq_max, 3 * eq_max))
            res = float((w * (d - hc * r - gg) ** 2).sum())
            cands.append({"kind": "eq+fader" if with_f else "eq", "band_hz": round(f), "eq": -hc, "fader": -gg,
                          "res": res, "cost": COST["eq"] + (COST["fader"] if with_f else 0.0)})
    for c in cands:
        c["score"] = c["res"] + c["cost"]
    best = min(cands, key=lambda c: c["score"])
    return best, sorted(cands, key=lambda c: c["score"])[:4]


class MusicSpecialist:
    name = "music"

    def __init__(self, profile, params: C.ControllerParams, permissions):
        self.profile, self.P, self.perm = profile, params, permissions

    # ----------------------------------------------------------------- balance
    def balance(self, ga, targets, src_p=None):
        hist, events = C.run(ga, targets, self.P, src_p=src_p)
        actions = []
        for ev in events:
            a = ControlAction("groupGainOffset", {"group": ev["group"]}, ev["to"], baseline=0.0,
                              bounds=(self.P.min_db, self.P.max_db), specialist=self.name,
                              reason={"code": "balanceDeviation", "density": ev["density"], "engaged_pairs": ev["engaged_pairs"],
                                      "text": "co-active pairwise loudness outside the profile band: "
                                              + "; ".join(f"{p[0]}-{p[1]} {p[2]:+.1f} LU" for p in ev["engaged_pairs"][:3])},
                              expected=[{"metric": f"pairwise({ev['group']})", "delta": round(ev["to"] - ev["from"], 2)}],
                              confidence=0.8, time_s=(ev["t"], ev["t"]))
            a.candidates = [{"summary": f"{ev['group']} offset {ev['from']:+.1f} -> {ev['to']:+.1f} dB"}, {"summary": "no change"}]
            actions.append(validate(a, self.perm))
        return hist, events, actions

    def static_balance(self, ga, targets):
        o, pairs = C.static_solve(ga, targets, self.P)
        acts = []
        for i, g in enumerate(ga.groups):
            if abs(o[i]) < 0.25:
                continue
            engaged = [(ga.groups[a], ga.groups[b], round(base, 2)) for a, b, base, tol, eng, wt in pairs if eng and i in (a, b)]
            acts.append(validate(ControlAction("staticGroupOffset", {"group": g}, float(o[i]), specialist=self.name,
                                               reason={"code": "staticBalance", "engaged_pairs": engaged,
                                                       "text": "whole-song starting point vs profile target"},
                                               confidence=0.7), self.perm))
        return o, acts

    # ----------------------------------------------------------------- tone
    def tone(self, ga, baseline_t=(0, 60), window_s=30.0):
        acts, table = [], {}
        prof = self.profile.get("tonal", {})
        for g in ga.groups:
            mask = A.frames_active(ga.band_t, ga.active[g])
            e_all = A.band_mean(ga.band_t, ga.bands[g], mask_times=mask)
            row = {"live_shape_dB": None, "vs_reference": None, "vs_baseline_windows": []}
            if np.all(np.isfinite(e_all)):
                shape = A.tonal_shape(e_all)
                row["live_shape_dB"] = np.round(shape, 1).tolist()
                if g in prof:
                    ref = np.array(prof[g]["shape_dB"]["median"])
                    iqr = np.array(prof[g]["shape_dB"]["iqr"])
                    d = shape - ref
                    tol = np.maximum(3.0, iqr)
                    w = A.loudness_weights(e_all)
                    best, top = explain_tonal(np.where(np.abs(d) > tol, d - np.sign(d) * tol, 0.0), w, allow_fader=False)
                    row["vs_reference"] = {"deviation_dB": np.round(d, 1).tolist(), "tolerance_dB": np.round(tol, 1).tolist(),
                                           "explanation": best["kind"], "band_hz": best.get("band_hz"), "eq_dB": round(best.get("eq", 0.0), 1)}
                    if best["kind"] == "eq":
                        acts.append(validate(ControlAction(
                            "eqBandGain", {"group": g, "band_hz": best["band_hz"]}, best["eq"], specialist=self.name,
                            reason={"code": "tonalVsReferenceTendency",
                                    "text": f"{g} differs from the reference tendency by more than its tolerance around {best['band_hz']} Hz; "
                                            "reference tone is a tendency only - confirm by listening"},
                            candidates=[{"summary": c["kind"] + (f" {c.get('band_hz')} Hz {c.get('eq', 0):+.1f}" if 'band_hz' in c else ""),
                                         "score": round(c["score"], 2)} for c in top],
                            confidence=0.4), self.perm))
            # drift vs the engineer's baseline (exp03: the right anchor for tone)
            b = A.band_mean(ga.band_t, ga.bands[g], *baseline_t, mask_times=mask)
            if np.all(np.isfinite(b)):
                t_end = ga.band_t[-1] if len(ga.band_t) else 0
                t = baseline_t[1]
                while t + window_s <= t_end + 1e-6:
                    e = A.band_mean(ga.band_t, ga.bands[g], t, t + window_s, mask_times=mask)
                    if np.all(np.isfinite(e)) and mask[(ga.band_t >= t) & (ga.band_t < t + window_s)].mean() > 0.5:
                        best, top = explain_tonal(e - b, A.loudness_weights(e))
                        row["vs_baseline_windows"].append({"t": [round(t), round(t + window_s)], "explanation": best["kind"],
                                                          "band_hz": best.get("band_hz"), "eq_dB": round(best.get("eq", 0.0), 1),
                                                          "fader_dB": round(best.get("fader", 0.0), 1)})
                        if best["kind"] in ("eq", "eq+fader"):
                            acts.append(validate(ControlAction(
                                "eqBandGain", {"group": g, "band_hz": best["band_hz"]}, best["eq"], specialist=self.name,
                                time_s=(t, t + window_s),
                                reason={"code": "tonalDriftVsBaseline",
                                        "text": f"{g} tone drifted from its approved baseline near {best['band_hz']} Hz"},
                                candidates=[{"summary": c["kind"], "score": round(c["score"], 2)} for c in top],
                                confidence=0.5), self.perm))
                    t += window_s
            table[g] = row
        return table, acts

    # ----------------------------------------------------------------- dynamics
    def dynamics(self, ga, baseline_t=(0, 60), window_s=60.0):
        acts, table = [], {}
        prof = self.profile.get("dynamics", {})
        nb_b = (int(baseline_t[0] / A.HOP_S), int(baseline_t[1] / A.HOP_S))
        for g in ga.groups:
            spread = A.momentary_spread(ga.p[g], ga.active[g])
            base_mask = np.zeros(ga.nb, bool)
            base_mask[nb_b[0]:nb_b[1]] = True
            base_spread = A.momentary_spread(ga.p[g], ga.active[g] & base_mask)
            ref = (prof.get(g) or {}).get("momentarySpread_LU", {}).get("median")
            row = {"momentary_spread_LU": round(spread, 2), "baseline_spread_LU": round(base_spread, 2),
                   "reference_tendency_LU": ref, "windows": []}
            w = int(window_s / A.HOP_S)
            for k in range(nb_b[1], ga.nb - w + 1, w):
                m = np.zeros(ga.nb, bool)
                m[k:k + w] = True
                s = A.momentary_spread(ga.p[g], ga.active[g] & m)
                if not np.isfinite(s) or not np.isfinite(base_spread):
                    continue
                z = (s - base_spread) / 1.5
                row["windows"].append({"t": [round(k * A.HOP_S), round((k + w) * A.HOP_S)], "spread_LU": round(s, 2), "z": round(z, 2)})
                if abs(z) > 1:
                    acts.append(validate(ControlAction(
                        "compressionIntensity", {"group": g}, 1.0 if z > 0 else -1.0, unit="step", specialist=self.name,
                        time_s=(k * A.HOP_S, (k + w) * A.HOP_S),
                        reason={"code": "dynamicsVsBaseline",
                                "text": f"{g} momentary-loudness spread {s:.1f} LU vs approved {base_spread:.1f} LU "
                                        f"({'more variable' if z > 0 else 'flatter'}). Check whether this is the performance "
                                        "(leave it) or the processing (adjust) - see `mi study processing`"},
                        confidence=0.4), self.perm))
            table[g] = row
        return table, acts


class ProgramSpecialist:
    name = "program"

    def __init__(self, profile, permissions, tp_ceiling=-1.0):
        self.profile, self.perm, self.ceiling = profile, permissions, tp_ceiling

    def assess(self, program_signal, p_prog, sr, ga=None):
        tp = A.true_peak_dbtp(program_signal, sr)
        rep = {"integrated_LUFS": round(A._integrated_from_p(p_prog), 2), "LRA_LU": round(A.lra(p_prog), 2),
               "truePeak_dBTP": round(tp, 2), "width": round(A.stereo_width(program_signal), 3),
               "reference_program": self.profile.get("program"),
               "note": "Reference program loudness reflects mastering; it is reported, never chased with channel levels."}
        acts = []
        if tp > self.ceiling and ga is not None:
            shares = np.array([ga.p[g].mean() for g in ga.groups])
            shares = shares / shares.sum()
            excess = tp - self.ceiling
            for g, s in zip(ga.groups, shares):
                d = -excess * s ** 2 / float((shares ** 2).sum())
                if d < -0.1:
                    acts.append(validate(ControlAction("programSteering", {"group": g}, d, specialist=self.name,
                                                       reason={"code": "headroom", "text": f"program true peak {tp:.1f} dBTP above "
                                                               f"{self.ceiling:.1f}; steer reduction to the largest contributors"},
                                                       confidence=0.5), self.perm))
        return rep, acts


def arbitrate(actions: list, balance_hist=None, groups=None):
    """Apply precedence rules to the specialists' proposals."""
    out = []
    corrected = set()
    if balance_hist is not None:
        corrected = {g for i, g in enumerate(groups) if np.abs(balance_hist[i]).max() >= 1.0}
    for a in actions:
        if a.status == "withheld":
            out.append(a)
            continue
        if a.kind == "compressionIntensity" and a.target.get("group") in corrected:
            a.status, a.withheld_reason = "deferred", "level is still being corrected for this group (level before tone before dynamics)"
        elif a.maturity != VALIDATED:
            a.status = "recommendation-only"
        out.append(a)
    return out
