"""Investigations to run before committing to final controller behaviour.

    ./run.sh study activity       <ws> [--mix M]   source-specific activity thresholds
    ./run.sh study beta           <ws> [--mix M]   reference-versus-baseline weighting
    ./run.sh study response       <ws> [--mix M]   evidence windows and response rates (truth-known)
    ./run.sh study generalization <ws>             leave-one-reference-out across arrangements
    ./run.sh study processing     <ws> [--mix M]   processing outcome vs natural performance change

Each writes results/studies/<name>/report.md and result.json. With real recordings these are
the experiments that set the defaults; on the synthetic demo they only prove the tooling works.
"""

from __future__ import annotations

import itertools
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import analysis as A
from . import controller as C
from . import features as F
from .compare import inject, parse_injections, score_injections
from .layout import find_references, load_config, load_mix
from .reference import analyse_reference, build_profile, load_group_signals, load_profile
from .report import _lbl, _table


def _mix_name(ws: Path, a) -> str:
    if getattr(a, "mix", None):
        return a.mix
    mixes = sorted(p.name for p in (ws / "mixes").iterdir() if p.is_dir()) if (ws / "mixes").is_dir() else []
    if not mixes:
        raise SystemExit("no mixes/ in workspace")
    return mixes[0]


def _profile(ws: Path, a) -> dict:
    if getattr(a, "profile", None):
        return load_profile(Path(a.profile))
    profs = sorted((ws / "profiles").glob("*.json"), key=lambda p: p.stat().st_mtime)
    if not profs:
        raise SystemExit("no profile: run `profile` first")
    return load_profile(profs[-1])


def _prepare(ws, mix, profile, cfg, injections=None, activity_overrides=None):
    pkg = load_mix(ws / "mixes" / mix)
    sig, _ = load_group_signals(pkg.stems)
    n = min(s.shape[1] for s in sig.values())
    sig = {g: s[:, :n] for g, s in sig.items()}
    groups = [g for g in profile["groups"] if g in sig]
    over = activity_overrides if activity_overrides is not None else cfg.get("activity")
    ga_clean = A.analyse_groups({g: sig[g] for g in groups}, 48000, activity_overrides=over, with_bands=False)
    ga = ga_clean
    if injections:
        dist = inject(sig, injections, 48000)
        ga = A.analyse_groups({g: dist[g] for g in groups}, 48000, activity_overrides=over, with_bands=False)
    from .compare import baseline_mask
    bmask, _ = baseline_mask(pkg.meta.get("baseline", [0, 60]), ga.nb, n / 48000)
    return pkg, sig, groups, ga_clean, ga, bmask


def _default_injections(ga, groups):
    T = ga.nb * A.HOP_S
    loud = max(groups, key=lambda g: float(np.mean(ga.p[g])) if g != "vocals" else -1)
    out = [{"group": loud, "db": 3.0, "start": round(0.25 * T), "end": round(0.45 * T)}]
    if "vocals" in groups:
        out.append({"group": "vocals", "db": -3.0, "start": round(0.55 * T), "end": round(0.75 * T)})
    return out


def _write(out: Path, title: str, lines: list):
    (out / "report.md").write_text("\n".join([f"# Study: {title}", ""] + lines))


# --------------------------------------------------------------------- activity
def activity_study(ws, a, out):
    cfg = load_config(ws)
    mix = _mix_name(ws, a)
    pkg = load_mix(ws / "mixes" / mix)
    sig, _ = load_group_signals(pkg.stems)
    n = min(s.shape[1] for s in sig.values())
    sig = {g: s[:, :n] for g, s in sig.items()}
    p = {g: A.block_stats(sig[g], 48000)[0] for g in sig}
    nb = min(len(v) for v in p.values())
    p = {g: v[:nb] for g, v in p.items()}
    prog = sum(p.values())
    truth = {}
    for t in pkg.meta.get("tacet", []) or []:  # annotated silences: [[tacet]] group/start/end
        m = truth.setdefault(t["group"], np.ones(nb, bool))
        m[int(t["start"] / A.HOP_S):int(t["end"] / A.HOP_S)] = False
    grid = list(itertools.product([-35.0, -30.0, -25.0, -20.0], [6.0, 10.0], [1.0, 2.0]))
    res, lines = {}, ["Sweeps the activity gate per group: relative threshold vs program (LU), idle-floor margin (LU), "
                      "release hold (s). With `[[tacet]]` annotations in mix.toml, errors are measured against them; "
                      "without, only stability (state changes per minute) and active share are reported.", ""]
    for g in sig:
        rows = []
        for rel, margin, off in grid:
            prm = {**A.activity_params(g, cfg.get("activity")), "rel_lu": rel, "margin_lu": margin, "off_s": off}
            act = A.activity(p[g], prog, prm)
            toggles = int(np.sum(act[1:] != act[:-1])) / (nb * A.HOP_S / 60)
            row = {"rel_lu": rel, "margin_lu": margin, "off_s": off, "active": round(float(act.mean()), 3), "toggles_per_min": round(toggles, 2)}
            if g in truth:
                tr = truth[g]
                row["false_active"] = round(float((act & ~tr).sum() / max((~tr).sum(), 1)), 3)
                row["missed"] = round(float((~act & tr).sum() / max(tr.sum(), 1)), 3)
                row["score"] = row["false_active"] + row["missed"] + 0.02 * toggles
            else:
                row["score"] = 0.02 * toggles
            rows.append(row)
        best = min(rows, key=lambda r: r["score"]) if g in truth else None
        default = A.activity_params(g, cfg.get("activity"))
        res[g] = {"rows": rows, "best": best, "has_truth": g in truth}
        lines += [f"## {_lbl(g)}" + (" (annotated tacet available)" if g in truth else ""), "",
                  _table(rows, [("rel", lambda r: r["rel_lu"]), ("margin", lambda r: r["margin_lu"]), ("release", lambda r: r["off_s"]),
                                ("active", lambda r: f"{100 * r['active']:.0f} %"), ("changes/min", lambda r: r["toggles_per_min"]),
                                ("false active", lambda r: r.get("false_active", "-")), ("missed", lambda r: r.get("missed", "-"))]),
                  "", (f"Best against the annotations: rel {best['rel_lu']} LU, margin {best['margin_lu']} LU, release {best['off_s']} s."
                       if best else f"No annotations for this group: keeping the defaults (rel {default['rel_lu']} LU, margin "
                       f"{default['margin_lu']} LU, release {default['off_s']} s). Add [[tacet]] entries to mix.toml to tune it."), ""]
    lines += ["To adopt, add to config.toml, e.g.", "", "```toml", "[activity.vocals]", "rel_lu = -25.0", "margin_lu = 10.0", "off_s = 1.5", "```"]
    _write(out, "source-specific activity thresholds", lines)
    return res


# --------------------------------------------------------------------- beta
def beta_study(ws, a, out):
    cfg, prof = load_config(ws), _profile(ws, a)
    mix = _mix_name(ws, a)
    pkg = load_mix(ws / "mixes" / mix)
    inj = parse_injections(getattr(a, "inject", None), pkg.meta)
    pkg, sig, groups, ga_clean, ga, bmask = _prepare(ws, mix, prof, cfg, inj)
    rows = []
    for beta in [0.0, 0.25, 0.5, 0.75, 1.0]:
        P = C.ControllerParams(beta=beta)
        tg = C.build_targets(groups, prof["balance"], ga_clean, bmask, beta)
        hist, events = C.run(ga, tg, P)
        so, _ = C.static_solve(ga, tg, P)
        s = C.summarise_offsets(hist, groups)
        row = {"beta": beta, "static": {g: round(float(so[i]), 2) for i, g in enumerate(groups)},
               "movement_dB": s["total_movement_dB"], "reversals": s["direction_reversals"],
               "mean_abs_offset_dB": round(float(np.mean(np.abs(hist))), 2)}
        if inj:
            hc, _ = C.run(ga_clean, tg, P)
            sc = score_injections(hist, groups, inj, ga.nb, hc)
            row["corrected_mean"] = round(float(np.mean([j["corrected_fraction"] for j in sc["injections"]])), 2)
            row["spurious_rms_dB"] = sc["rms_response_outside_disturbances_dB"]
        rows.append(row)
    lines = ["beta blends the targets: 0 keeps the engineer's own relationships (from the baseline window), 1 aims at the "
             "reference. Low beta = 'hold my mix'; high beta = 'move my mix toward the reference'.", "",
             _table(rows, [("beta", lambda r: r["beta"]), ("Whole-song starting point", lambda r: ", ".join(f"{_lbl(g)} {v:+.1f}" for g, v in r["static"].items() if abs(v) >= 0.25) or "none"),
                           ("Mean |offset|", lambda r: f"{r['mean_abs_offset_dB']} dB"), ("Movement", lambda r: f"{r['movement_dB']} dB"),
                           ("Reversals", lambda r: r["reversals"]), ("Injected corrected", lambda r: f"{100 * r['corrected_mean']:.0f} %" if "corrected_mean" in r else "-"),
                           ("Spurious RMS", lambda r: f"{r['spurious_rms_dB']} dB" if "spurious_rms_dB" in r else "-")]), "",
             "Read with your ears: render `compare --beta 0 / 0.5 / 1 --tag b0 ...` and compare the after.wav files."]
    _write(out, "reference-versus-baseline weighting", lines)
    return {"rows": rows}


# --------------------------------------------------------------------- response
def response_study(ws, a, out):
    cfg, prof = load_config(ws), _profile(ws, a)
    mix = _mix_name(ws, a)
    pkg = load_mix(ws / "mixes" / mix)
    inj = parse_injections(getattr(a, "inject", None), pkg.meta)
    pkg, sig, groups, ga_clean, ga0, bmask = _prepare(ws, mix, prof, cfg, None)
    if not inj:
        inj = _default_injections(ga0, groups)
    _, _, _, ga_clean, ga, bmask = _prepare(ws, mix, prof, cfg, inj)
    tg = C.build_targets(groups, prof["balance"], ga_clean, bmask, cfg.get("controller", {}).get("beta", 0.5))
    rows = []
    t = np.arange(ga.nb) * A.HOP_S
    for ev, rate in itertools.product([3.0, 6.0, 12.0], [0.25, 0.5, 1.0]):
        P = C.ControllerParams(evidence_s=ev, rate_db_s=rate)
        hist, _ = C.run(ga, tg, P)
        hc, _ = C.run(ga_clean, tg, P)
        sc = score_injections(hist, groups, inj, ga.nb, hc)
        resp = hist - hc
        t50 = []
        for j in inj:
            i = groups.index(j["group"])
            m = (t >= j["start"]) & (t < j["end"])
            reach = np.where(m & (np.sign(-j["db"]) * resp[i] >= 0.5 * abs(j["db"])))[0]
            t50.append(round(float(t[reach[0]] - j["start"]), 1) if len(reach) else None)
        s = C.summarise_offsets(hist, groups)
        rows.append({"evidence_s": ev, "rate_db_s": rate, "corrected": round(float(np.mean([x["corrected_fraction"] for x in sc["injections"]])), 2),
                     "time_to_50pct_s": t50, "spurious_rms_dB": sc["rms_response_outside_disturbances_dB"], "reversals": s["direction_reversals"]})
    best = max(rows, key=lambda r: r["corrected"] - 2 * r["spurious_rms_dB"] - 0.01 * r["reversals"])
    lines = ["Response is scored against the identical undisturbed run, so only the reaction to the known disturbance counts.", "",
             "Known disturbances: " + "; ".join(f"{_lbl(j['group'])} {j['db']:+.0f} dB @ {j['start']}-{j['end']} s" for j in inj), "",
             _table(rows, [("Evidence window", lambda r: f"{r['evidence_s']:.0f} s"), ("Rate", lambda r: f"{r['rate_db_s']} dB/s"),
                           ("Corrected (mean)", lambda r: f"{100 * r['corrected']:.0f} %"), ("Time to 50 %", lambda r: ", ".join("-" if x is None else f"{x} s" for x in r["time_to_50pct_s"])),
                           ("Spurious RMS", lambda r: f"{r['spurious_rms_dB']} dB"), ("Reversals", lambda r: r["reversals"])]), "",
             f"Best balance of accuracy, stability and restraint here: evidence {best['evidence_s']:.0f} s, rate {best['rate_db_s']} dB/s. "
             "Faster is not automatically better: check spurious movement and listen."]
    _write(out, "evidence windows and response times", lines)
    return {"injections": inj, "rows": rows, "best": best}


# --------------------------------------------------------------------- generalization
def generalization_study(ws, a, out):
    cfg = load_config(ws)
    refs = [r for r in find_references(ws) if not r.meta.get("exclude")]
    if len(refs) < 2:
        raise SystemExit("needs at least 2 references")
    analysed = [analyse_reference(r, cfg.get("activity")) for r in refs]
    rows = []
    for k, (meta, ga) in enumerate(analysed):
        prof = build_profile([x for i, x in enumerate(analysed) if i != k], "loo")
        groups = [g for g in prof["groups"] if g in ga.groups]
        tg = C.build_targets(groups, prof["balance"], None, None, beta=1.0)
        devs, outside = [], 0
        for (x, y), per in tg.items():
            st = C.pair_stats(ga, x, y)
            if st is None:
                continue
            tol = max(1.5, per["all"]["iqr"] / 3)
            d = st["median"] - per["all"]["median"]
            devs.append(abs(d))
            outside += abs(d) > tol
        ga.groups = groups
        hist, events = C.run(ga, tg, C.ControllerParams(beta=1.0))
        dens = A.density_class(ga.density, len(groups))
        rows.append({"held_out": meta["id"], "pairs": len(devs), "outside": int(outside), "mean_abs_dev_LU": round(float(np.mean(devs)), 2) if devs else None,
                     "movement_dB": C.summarise_offsets(hist, groups)["total_movement_dB"], "mean_abs_offset_dB": round(float(np.mean(np.abs(hist))), 2),
                     "density": {c: round(float((dens == c).mean()), 2) for c in ("sparse", "medium", "full")}})
    lines = ["Each reference is held out in turn and compared with a profile built from the others. A professionally mixed "
             "reference should mostly sit inside the tolerance band: pairs 'outside' and controller movement here are false "
             "problems, i.e. the price of generalising across songs and arrangements.", "",
             _table(rows, [("Held-out reference", lambda r: r["held_out"]), ("Pairs", lambda r: r["pairs"]), ("Outside band", lambda r: r["outside"]),
                           ("Mean |deviation|", lambda r: f"{r['mean_abs_dev_LU']} LU"), ("Controller mean |offset|", lambda r: f"{r['mean_abs_offset_dB']} dB"),
                           ("Movement", lambda r: f"{r['movement_dB']} dB"), ("Arrangement (sparse/medium/full)", lambda r: " / ".join(f"{100 * v:.0f} %" for v in r["density"].values()))]),
             "", "If held-out references are often outside the band, widen tolerances, add references, or lower beta."]
    _write(out, "generalisation across arrangements (leave one reference out)", lines)
    return {"rows": rows}


# --------------------------------------------------------------------- arrangement density (0.5.0)
def _explained(d, x, k=3):
    """Share of the variance of pair differences d explained by k quantile classes of x (within one song)."""
    ok = np.isfinite(d) & np.isfinite(x)
    d, x = d[ok], x[ok]
    if len(d) < 60 or np.ptp(x) == 0:
        return None
    edges = np.unique(np.quantile(x, np.linspace(0, 1, k + 1)[1:-1]))
    cls = np.digitize(x, edges)
    tot = float(np.var(d))
    if tot == 0:
        return None
    within = sum(float(np.var(d[cls == c])) * (cls == c).sum() for c in np.unique(cls)) / len(d)
    return 1.0 - within / tot


def density_study(ws, a, out):
    """Is 'how many groups are active' a useful context for balance targets on these references?

    For every reference and every co-active pair, the within-song variance of the pair's loudness
    difference is split by tercile classes of each density measure (loudness-based measures describe
    only the other groups, so they cannot contain the pair's own balance). The share explained says how
    much knowing that measure tells you about the expected balance. Higher = more informative.
    Measures are compared on the same blocks, so the comparison is fair whatever their scale."""
    cfg = load_config(ws)
    refs = [r for r in find_references(ws) if not r.meta.get("exclude")]
    if not refs:
        raise SystemExit("needs at least 1 reference with stems")
    keys = list(A.DENSITY_MEASURES)
    per_measure = {k: [] for k in keys}
    pair_rows, ref_rows = {}, []
    for r in refs:
        meta, ga = analyse_reference(r, cfg.get("activity"))
        dm = A.density_measures(ga)
        cls = A.density_class(ga.density, len(ga.groups))
        ref_rows.append({"reference": meta.get("title", r.name), "groups": len(ga.groups), "beds": dm["beds"],
                         "active": dm["active_fraction"], "current": {c: round(float((cls == c).mean()), 3) for c in ("sparse", "medium", "full")}})
        G = list(ga.groups)
        for i, x in enumerate(G):
            for y in G[i + 1:]:
                act = ga.active[x] & ga.active[y] & np.isfinite(ga.st[x]) & np.isfinite(ga.st[y])
                act[:30] = False
                if act.sum() < 60:
                    continue
                d = (ga.st[x] - ga.st[y])[act]
                dmp = A.density_measures(ga, exclude=(x, y))
                row = pair_rows.setdefault(f"{x}|{y}", {k: [] for k in keys} | {"full_share": []})
                row["full_share"].append(float((cls[act] == "full").mean()))
                for k in keys:
                    e = _explained(d, dmp[k][act])
                    if e is not None:
                        row[k].append(e)
                        per_measure[k].append(e)
    rows = []
    for pk, v in pair_rows.items():
        rows.append({"pair": pk, "full_share": round(float(np.mean(v["full_share"])), 3),
                     **{k: (round(float(np.mean(v[k])), 3) if v[k] else None) for k in keys}})
    summary = {k: (round(float(np.median(v)), 3) if v else None) for k, v in per_measure.items()}
    best = max((k for k in keys if summary[k] is not None), key=lambda k: summary[k], default=None)
    lines = ["How informative is each description of arrangement density about the expected balance between two sources?",
             "Value = share of a pair's within-song variance explained by tercile classes of the measure (median over pairs and songs).", "",
             _table([{"m": k, "d": A.DENSITY_MEASURES[k], "v": summary[k]} for k in keys],
                    [("Measure", lambda r: r["m"]), ("Definition", lambda r: r["d"]), ("Variance explained", lambda r: "–" if r["v"] is None else f"{100 * r['v']:.1f} %")]),
             "", "## Current classifier: share of co-active blocks classed 'full'", "",
             _table(sorted(rows, key=lambda r: r["pair"]), [("Pair", lambda r: _lbl(r["pair"].split("|")[0]) + " / " + _lbl(r["pair"].split("|")[1])),
                                                            ("'full'", lambda r: f"{100 * r['full_share']:.0f} %"),
                                                            *[(k, (lambda kk: (lambda r: "–" if r[kk] is None else f"{100 * r[kk]:.0f} %"))(k)) for k in keys]]),
             "", "## Sustained beds and activity per reference", "",
             _table(ref_rows, [("Reference", lambda r: r["reference"]), ("Sustained (>= 95 % active)", lambda r: ", ".join(_lbl(g) for g in r["beds"]) or "none"),
                               ("Active fraction", lambda r: ", ".join(f"{_lbl(g)} {100 * v:.0f} %" for g, v in r["active"].items())),
                               ("Current sparse/medium/full", lambda r: " / ".join(f"{100 * v:.0f} %" for v in r["current"].values()))]),
             "", (f"Most informative on these references: **{best}** ({100 * summary[best]:.1f} % of within-song variance)."
                  if best and summary[best] >= 0.05 else
                  "None of the measures explains a meaningful share (>= 5 %) of within-song balance variation on these references: "
                  "arrangement density, however described, is weak context here."),
             "This is evidence for a design decision, not an automatic change: the operator keeps its current classifier until "
             "the engineer reviews this on several song sets."]
    _write(out, "arrangement density", lines)
    return {"summary": summary, "best": best, "rows": rows, "references": ref_rows}


# --------------------------------------------------------------------- processing vs performance
def _transfer_curve(x, y, bin_lu=2.0):
    """Median output loudness per input-loudness bin (the processing's level transfer)."""
    lo, hi = np.floor(np.percentile(x, 2)), np.ceil(np.percentile(x, 98))
    edges = np.arange(lo, hi + bin_lu, bin_lu)
    cx, cy = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (x >= a) & (x < b)
        if m.sum() >= 5:
            cx.append(float(np.median(x[m])))
            cy.append(float(np.median(y[m])))
    return np.array(cx), np.array(cy)


def classify_processing(p_raw, p_proc, active, base_mask, win_blocks=100):
    """Separate performance changes from processing changes using pre- and post-processing stems.

    The baseline window defines the processing's level TRANSFER: output short-term loudness as a
    function of input short-term loudness (binned medians - not a single slope, because a
    compressor's behaviour depends on level). For each later window, the output is predicted from
    the window's own input through the baseline transfer:
      * prediction holds (|residual| < 1.5 dB) -> processing unchanged; any change in output
                                                 dynamics comes from the performance
      * prediction fails                      -> the processing changed
      * inputs outside the calibrated range   -> reported as such (cannot judge)."""
    si, so = F.short_term(p_raw), F.short_term(p_proc)
    ok = active & np.isfinite(si) & np.isfinite(so)
    ok[:30] = False
    bm = ok & base_mask
    if bm.sum() < 30:
        return None, []
    cx, cy = _transfer_curve(si[bm], so[bm])
    if len(cx) < 2:
        return None, []
    base = {"in_spread": float(np.percentile(si[bm], 95) - np.percentile(si[bm], 10)),
            "out_spread": float(np.percentile(so[bm], 95) - np.percentile(so[bm], 10)),
            "calibrated_input_LUFS": [round(float(cx[0]), 1), round(float(cx[-1]), 1)]}
    out = []
    for k in range(0, len(p_raw) - win_blocks + 1, win_blocks):
        m = np.zeros(len(p_raw), bool)
        m[k:k + win_blocks] = True
        m &= ok
        if m.sum() < 30:
            continue
        x, y = si[m], so[m]
        inside = (x >= cx[0] - 1) & (x <= cx[-1] + 1)
        pred = np.interp(x, cx, cy)
        resid = float(np.median(np.abs((y - pred)[inside]))) if inside.sum() >= 10 else float("nan")
        bias = float(np.median((y - pred)[inside])) if inside.sum() >= 10 else float("nan")
        d_in = float(np.percentile(x, 95) - np.percentile(x, 10)) - base["in_spread"]
        d_out = float(np.percentile(y, 95) - np.percentile(y, 10)) - base["out_spread"]
        if inside.mean() < 0.5:
            verdict = "input outside the calibrated range (cannot judge)"
        elif resid > 1.5 or abs(bias) > 1.5:
            verdict = "processing changed"
        elif abs(d_in) > 1.5 or abs(d_out) > 1.5:
            verdict = "performance changed (processing unchanged: leave it)"
        else:
            verdict = "no meaningful change"
        out.append({"t": [round(k * A.HOP_S), round((k + win_blocks) * A.HOP_S)], "d_in_spread": round(d_in, 2), "d_out_spread": round(d_out, 2),
                    "transfer_residual_dB": round(resid, 2), "transfer_bias_dB": round(bias, 2), "inside_calibration": round(float(inside.mean()), 2),
                    "verdict": verdict})
    return base, out


def processing_study(ws, a, out):
    cfg = load_config(ws)
    mix = _mix_name(ws, a)
    pkg = load_mix(ws / "mixes" / mix)
    if pkg.raw is None:
        raise SystemExit(f"mix '{mix}' has no raw/ folder: export the same groups BEFORE their plugins to raw/")
    proc, _ = load_group_signals(pkg.stems)
    raw, _ = load_group_signals(pkg.raw)
    from .compare import baseline_mask
    bw = pkg.meta.get("baseline", [0, 60])
    res, lines = {}, ["Compares each group's raw (pre-plugin) and processed stems. The baseline window calibrates the processing's "
                      "level transfer (output loudness vs input loudness, per 2 LU input bin). Each later window's output is predicted "
                      "from its own input through that transfer: if the prediction holds, any change in the output's dynamics is the "
                      "performance (leave it); if it fails, the processing changed.", ""]
    for g in proc:
        if g not in raw:
            continue
        n = min(proc[g].shape[1], raw[g].shape[1])
        pr = A.block_stats(raw[g][:, :n], 48000)[0]
        pp = A.block_stats(proc[g][:, :n], 48000)[0]
        nb = min(len(pr), len(pp))
        pr, pp = pr[:nb], pp[:nb]
        act = A.activity(pr, pr, A.activity_params(g, cfg.get("activity")))
        bmask, _ = baseline_mask(bw, nb, nb * A.HOP_S)
        base, wins = classify_processing(pr, pp, act, bmask)
        res[g] = {"baseline": base, "windows": wins}
        if base is None:
            continue
        lines += [f"## {_lbl(g)}", "", f"Baseline: input spread {base['in_spread']:.1f} LU, output spread {base['out_spread']:.1f} LU; "
                  f"transfer calibrated for input {base['calibrated_input_LUFS'][0]} .. {base['calibrated_input_LUFS'][1]} LUFS", "",
                  _table(wins, [("Window", lambda r: f"{r['t'][0]}-{r['t'][1]} s"), ("Δ input spread", lambda r: r["d_in_spread"]),
                                ("Δ output spread", lambda r: r["d_out_spread"]), ("Transfer residual", lambda r: f"{r['transfer_residual_dB']} dB"),
                                ("Transfer bias", lambda r: f"{r['transfer_bias_dB']} dB"), ("Verdict", lambda r: r["verdict"])]), ""]
    _write(out, "processing outcome vs natural performance change", lines)
    return res
