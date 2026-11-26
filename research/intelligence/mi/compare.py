"""Compare a mix against a Sound Profile, recommend actions, render before/after.

    mi compare <workspace> <mix-name> --profile profiles/<name>.json

Truth-known validation on REAL stems: add injected disturbances (mix.toml [[inject]] or
--inject "guitars:+3@30-60"). The mix is disturbed by exactly known amounts, and the report
scores how much of each disturbance the operator removed - and how much it moved anything else.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

from . import analysis as A
from . import audio_io as io
from . import controller as C
from . import features as F
from . import render as R
from . import ALGORITHM_VERSION, RESULT_SCHEMA
from .actions import ControlAction, permissions_from_config, validate, write_jsonl
from .layout import GROUP_LABEL, load_mix
from .operator import MusicSpecialist, ProgramSpecialist, arbitrate
from .reference import load_group_signals


def parse_injections(spec: str | None, meta: dict) -> list:
    out = []
    for d in meta.get("inject", []) or []:
        out.append({"group": d["group"], "db": float(d["db"]), "start": float(d["start"]), "end": float(d["end"])})
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\w+):([+-]?[\d.]+)@([\d.]+)-([\d.]+)$", part)
        if not m:
            raise ValueError(f"bad --inject item '{part}' (expected group:+3@30-60)")
        out.append({"group": m[1], "db": float(m[2]), "start": float(m[3]), "end": float(m[4])})
    return out


def inject(signals: dict, injections: list, sr: int) -> dict:
    out = {g: s.copy() for g, s in signals.items()}
    for j in injections:
        if j["group"] not in out:
            raise ValueError(f"inject: no group '{j['group']}' in this mix")
        a, b = int(j["start"] * sr), int(j["end"] * sr)
        ramp = int(0.05 * sr)  # 50 ms ramps: a level change, not a click
        g = np.ones(out[j["group"]].shape[1])
        g[a:b] = 10 ** (j["db"] / 20)
        if ramp and b - a > 2 * ramp:
            g[a:a + ramp] = np.linspace(1, 10 ** (j["db"] / 20), ramp)
            g[b - ramp:b] = np.linspace(10 ** (j["db"] / 20), 1, ramp)
        out[j["group"]] = out[j["group"]] * g
    return out


def score_injections(hist, groups, injections, nb, hist_clean=None, bounds=(-4.0, 4.0)):
    """Response to each known disturbance, isolated from everything else the operator does.

    Scored on (offsets with the disturbance) - (offsets on the identical undisturbed mix), so a
    reference-driven correction that would happen anyway (beta > 0) is not counted as response.
    Evaluated over the second half of each window."""
    t = np.arange(nb) * A.HOP_S
    resp = hist - hist_clean if hist_clean is not None else hist
    res = []
    for j in injections:
        i = groups.index(j["group"])
        m = (t >= (j["start"] + j["end"]) / 2) & (t < j["end"])
        got = float(resp[i, m].mean()) if m.any() else float("nan")
        others = [float(np.abs(resp[k, m]).mean()) for k in range(len(groups)) if k != i]
        at_bound = float(np.mean((hist[i, m] <= bounds[0] + 0.05) | (hist[i, m] >= bounds[1] - 0.05))) if m.any() else 0.0
        res.append({**j, "ideal_dB": -j["db"], "achieved_dB": round(got, 2),
                    "corrected_fraction": round(-got / j["db"], 2) if j["db"] else None,
                    "max_other_mean_abs_dB": round(max(others), 2) if others else 0.0,
                    "saturated": at_bound > 0.5})
    clean = np.ones(nb, bool)
    for j in injections:
        clean &= ~((t >= j["start"]) & (t < j["end"] + 15))
    spurious = float(np.sqrt(np.mean(resp[:, clean] ** 2))) if clean.any() else float("nan")
    return {"injections": res, "rms_response_outside_disturbances_dB": round(spurious, 2),
            "scored_against": "undisturbed run" if hist_clean is not None else "zero"}


def baseline_mask(spec, nb, total_s):
    """Approved baseline: [start, end], a list of such regions, or "all"."""
    if spec == "all" or spec is None:
        spec = [[0, total_s]] if spec == "all" else [[0, 60]]
    regions = [spec] if spec and not isinstance(spec[0], (list, tuple)) else list(spec)
    m = np.zeros(nb, bool)
    for a, b in regions:
        m[int(float(a) / A.HOP_S):int(float(b) / A.HOP_S)] = True
    return m, [[float(a), float(b)] for a, b in regions]


def compare(workspace: Path, mix_name: str, profile: dict, cfg: dict, out_dir: Path, inject_spec=None, beta=None,
            evidence_s=None, rate=None, render=True, render_experimental=False, seed=None, plots=True, log=print,
            render_groups=False, blind=True):
    pkg = load_mix(workspace / "mixes" / mix_name)
    sr = io.PROJECT_SR
    signals, warns = load_group_signals(pkg.stems, sr)
    if not signals:
        raise ValueError(f"mix '{mix_name}': no stems recognised in {pkg.folder}/stems")
    n = min(s.shape[1] for s in signals.values())
    signals = {g: s[:, :n] for g, s in signals.items()}
    excluded = set((cfg.get("intelligence") or {}).get("exclude_groups", []))
    groups = [g for g in profile["groups"] if g in signals and g not in excluded]
    unmanaged = [g for g in signals if g not in groups]
    if unmanaged:
        warns.append(f"groups passed through untouched (not in the profile, or excluded from Intelligence): {unmanaged}")
    checks = {"duration_s": round(n / sr, 1), "groups": groups, "unmapped_files": [p.name for p in pkg.stems.unmapped]}
    if pkg.mix is not None:
        mx = io.read(pkg.mix, sr)
        m = min(n, mx.samples)
        ssum = sum(signals.values())[:, :m]
        err = mx.stereo()[:, :m] - ssum
        checks["mix_vs_stem_sum_dB"] = round(float(10 * np.log10(np.sum(err ** 2) / max(np.sum(mx.stereo()[:, :m] ** 2), 1e-20))), 1)
        if checks["mix_vs_stem_sum_dB"] > -20:
            warns.append("mix.wav differs from the sum of the stems (master-bus processing, or stems not exported from the "
                         "same mix). Comparisons use the stem sum; export stems pre-master for a fair before/after.")
    cfgc = cfg.get("controller", {})
    P = C.ControllerParams(**{k: v for k, v in cfgc.items() if k in C.ControllerParams.__dataclass_fields__})
    if beta is not None:
        P.beta = beta
    if evidence_s is not None:
        P.evidence_s = evidence_s
    if rate is not None:
        P.rate_db_s = rate
    perm = permissions_from_config(cfg)
    P.min_db, P.max_db = perm["groupGainOffset"]["min"], perm["groupGainOffset"]["max"]
    P.rate_db_s = min(P.rate_db_s, perm["groupGainOffset"].get("rate_db_s", P.rate_db_s))
    act_over = cfg.get("activity")

    injections = parse_injections(inject_spec, pkg.meta)
    log(f"analysing {len(groups)} groups, {n / sr:.0f} s" + (f", {len(injections)} injected disturbance(s)" if injections else ""))
    ga_clean = A.analyse_groups({g: signals[g] for g in groups}, sr, activity_overrides=act_over)
    work = inject(signals, injections, sr) if injections else signals
    ga = A.analyse_groups({g: work[g] for g in groups}, sr, activity_overrides=act_over) if injections else ga_clean

    bmask, regions = baseline_mask(pkg.meta.get("baseline", [0, 60]), ga.nb, n / sr)
    bw = regions[0]  # tone / dynamics anchor: the first approved region
    targets = C.build_targets(groups, profile["balance"], ga_clean, bmask, P.beta)

    music = MusicSpecialist(profile, P, perm)
    program = ProgramSpecialist(profile, perm, cfg.get("program", {}).get("true_peak_ceiling", -1.0))
    hist, events, bal_actions = music.balance(ga, targets)
    static_o, static_actions = music.static_balance(ga, targets)
    tone_table, tone_actions = music.tone(ga, tuple(bw))
    dyn_table, dyn_actions = music.dynamics(ga, tuple(bw))

    before = sum(work[g] for g in work)
    after = R.apply_offsets(work, groups, hist, sr)
    prog_before, prog_acts = program.assess(before, ga.p_prog, sr, ga)
    p_after = sum(ga.p[g] * 10 ** (hist[i] / 10) for i, g in enumerate(groups)) + sum(
        A.block_stats(work[g], sr)[0][:ga.nb] for g in unmanaged) if unmanaged else sum(ga.p[g] * 10 ** (hist[i] / 10) for i, g in enumerate(groups))
    prog_after, _ = program.assess(after, p_after, sr)

    actions = arbitrate(bal_actions + static_actions + tone_actions + dyn_actions + prog_acts, hist, groups)
    if not actions:
        actions = [ControlAction("none", {}, 0.0, reason={"text": "no deviation outside tolerance"}, specialist="operator")]

    # pairwise table: whole-song co-active medians vs targets
    pairs = []
    for (a, b), per in targets.items():
        st = C.pair_stats(ga, a, b)
        t = per["all"]
        if st is None:
            continue
        dev = st["median"] - t["median"]
        pairs.append({"pair": f"{a}-{b}", "live_median_LU": round(st["median"], 2), "target_LU": round(t["median"], 2),
                      "reference_LU": None if t["ref"] is None else round(t["ref"], 2),
                      "baseline_LU": None if t["baseline"] is None else round(t["baseline"], 2),
                      "tolerance_LU": round(max(P.engage_lu, t["iqr"] / 3), 2), "deviation_LU": round(dev, 2),
                      "outside": bool(abs(dev) > max(P.engage_lu, t["iqr"] / 3)), "coactive_s": round(st["n"] * A.HOP_S, 1)})

    out_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "mix": mix_name, "profile": profile.get("name"), "checks": checks, "warnings": warns,
        "schema": RESULT_SCHEMA, "algorithm_version": ALGORITHM_VERSION,
        "controller": {k: v for k, v in P.__dict__.items()}, "baseline_window_s": bw, "baseline_regions_s": regions,
        "excluded_groups": sorted(excluded), "permissions": perm, "injections": injections,
        "groups": ga.to_summary(), "pairs": pairs,
        "static_offsets_dB": {g: round(float(static_o[i]), 2) for i, g in enumerate(groups)},
        "offset_summary": C.summarise_offsets(hist, groups), "events": events,
        "tone": tone_table, "dynamics": dyn_table, "program_before": prog_before, "program_after": prog_after,
        "density_fraction": {c: round(float((A.density_class(ga.density, len(groups)) == c).mean()), 3) for c in ("sparse", "medium", "full")},
    }
    if injections:
        hist_clean, _ = C.run(ga_clean, targets, P)
        result["injection_score"] = score_injections(hist, groups, injections, ga.nb, hist_clean, (P.min_db, P.max_db))
    tcol = np.arange(ga.nb) * A.HOP_S
    np.savetxt(out_dir / "activity.csv", np.column_stack([tcol] + [ga.active[g].astype(int) for g in groups] + [ga.density]),
               delimiter=",", header="time_s," + ",".join(groups) + ",n_active", comments="", fmt="%.3f")
    np.savetxt(out_dir / "loudness.csv", np.column_stack([tcol] + [np.nan_to_num(ga.st[g], nan=-120.0, neginf=-120.0) for g in groups]),
               delimiter=",", header="time_s," + ",".join(groups), comments="", fmt="%.2f")
    np.savetxt(out_dir / "offsets.csv", np.column_stack([np.arange(ga.nb) * A.HOP_S, hist.T]), delimiter=",",
               header="time_s," + ",".join(groups), comments="", fmt="%.3f")
    if render:
        versions = {"before": before, "after": after}
        if render_experimental:
            exp = after.copy()
            applied = []
            for a in actions:
                if a.kind == "eqBandGain" and a.time_s is None and a.status != "withheld":
                    g = a.target["group"]
                    exp += R.peaking(work[g], a.target["band_hz"], a.proposed, sr) - work[g]
                    applied.append(a.summary())
            versions["after_experimental_eq"] = exp
            result["experimental_render"] = {"applied": applied, "note": "generic bell EQ standing in for the strip's own "
                                             "EQ plugin; not a validated capability"}
        gsets = None
        if render_groups:
            gsets = {"before": {g: work[g] for g in list(groups) + unmanaged},
                     "after": {**{g: work[g] * R.block_gain_to_samples(hist[i], work[g].shape[1], sr) for i, g in enumerate(groups)},
                               **{g: work[g] for g in unmanaged}}}
        result["render"] = R.write_listening_set(out_dir / "audio", versions, sr, seed=seed, group_sets=gsets, blind=blind)
    (out_dir / "analysis.json").write_text(json.dumps(result, indent=1, default=float))
    write_jsonl(actions, out_dir / "decisions.jsonl")
    from .report import compare_report
    compare_report(result, actions, ga, hist, out_dir, plots=plots)
    return result, actions
