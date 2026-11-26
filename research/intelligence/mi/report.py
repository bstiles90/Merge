"""Human-readable reports (Markdown + optional PNG plots)."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import analysis as A
from .actions import CAPABILITIES, EXPERIMENTAL, VALIDATED
from .layout import GROUP_LABEL

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:  # pragma: no cover
    plt = None


def _lbl(g):
    return GROUP_LABEL.get(g, g)


def _table(rows, cols):
    out = ["| " + " | ".join(c for c, _ in cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        out.append("| " + " | ".join(str(f(r)) for _, f in cols) + " |")
    return "\n".join(out)


def maturity_legend():
    rows = [(k, v[0], v[1], v[2]) for k, v in CAPABILITIES.items() if k != "none"]
    return _table(rows, [("Capability", lambda r: f"`{r[0]}`"), ("Layer", lambda r: r[1]),
                         ("Maturity", lambda r: "**VALIDATED**" if r[2] == VALIDATED else r[2]), ("Meaning", lambda r: r[3])])


# --------------------------------------------------------------------- profile
def profile_report(profile: dict, path: Path):
    L = [f"# Sound Profile: {profile['name']}", "", f"Created {profile['created']} by {profile['analysis']['code']}.", "",
         "## References", ""]
    L.append(_table(profile["references"], [
        ("Reference", lambda r: r["title"]), ("Kind", lambda r: r["kind"]), ("Weight", lambda r: r["weight"]),
        ("Excluded", lambda r: "yes" if r["excluded"] else ""), ("Length", lambda r: f"{r['duration_s']:.0f} s"),
        ("Integrated", lambda r: f"{r['program']['integrated_LUFS']:.1f} LUFS"), ("LRA", lambda r: f"{r['program']['LRA_LU']:.1f} LU"),
        ("True peak", lambda r: f"{r['program']['truePeak_dBTP']:.1f} dBTP"),
        ("Stem recon. error", lambda r: f"{r['quality'].get('reconErr_dB', '-')} dB"),
        ("Flags", lambda r: "; ".join(r["quality"]["flags"]) or "-")]))
    L += ["", "Reconstruction error compares the master with the sum of its stems. Below about -20 dB is good; "
          "above -15 dB means the stems do not add up to the master (separation artefacts, missing or normalised stems) "
          "and the reference is down-weighted.", "", "## Balance targets (pairwise, co-active)", "",
          "Each row: how much louder the first group is than the second (short-term loudness, LU), measured only while "
          "both are playing. These relationships do not depend on mastering loudness.", ""]
    rows = []
    for k, v in profile["balance"].items():
        a, b = k.split("|")
        al = v["byDensity"].get("all", {})
        rows.append((f"{_lbl(a)} - {_lbl(b)}", al.get("median"), al.get("p25"), al.get("p75"),
                     {c: v["byDensity"].get(c, {}).get("median") for c in ("sparse", "medium", "full")}, v["nRefs"], v["confidence"],
                     round(al.get("n", 0) * A.HOP_S)))
    L.append(_table(rows, [("Pair", lambda r: r[0]), ("Median LU", lambda r: r[1]), ("p25..p75", lambda r: f"{r[2]} .. {r[3]}"),
                           ("Sparse / medium / full", lambda r: " / ".join("-" if r[4][c] is None else f"{r[4][c]:+.1f}" for c in r[4])),
                           ("Refs", lambda r: r[5]), ("Confidence", lambda r: r[6]), ("Co-active time", lambda r: f"{r[7]} s")]))
    L += ["", "## Tonal tendencies (level-normalised octave bands, dB)", "",
          "Tendencies only. Live tone is judged mainly against the engineer's own approved baseline (exp03).", ""]
    cen = A.BAND_CENTRES
    L.append("| Group | " + " | ".join(f"{c:.0f}" if c < 1000 else f"{c / 1000:.0f}k" for c in cen) + " |")
    L.append("|---|" + "---|" * len(cen))
    for g, t in profile["tonal"].items():
        L.append(f"| {_lbl(g)} | " + " | ".join(f"{m:+.1f}±{q / 2:.1f}" for m, q in zip(t["shape_dB"]["median"], t["shape_dB"]["iqr"])) + " |")
    L += ["", "## Dynamics tendencies", "", _table(list(profile["dynamics"].items()), [
        ("Group", lambda r: _lbl(r[0])), ("Momentary spread (p95-p10)", lambda r: f"{r[1]['momentarySpread_LU']['median']} LU"),
        ("Crest", lambda r: f"{r[1]['crest_dB']['median']} dB")]),
        "", "Includes mastering, so it cannot be separated from bus processing. Compressor settings are not recoverable (exp04).",
        "", "## Program (median of references; informational)", "",
        "\n".join(f"- {k}: {v}" for k, v in profile["program"].items()), ""]
    path.write_text("\n".join(L))


# --------------------------------------------------------------------- compare
def _plots(result, ga, hist, out_dir):
    if plt is None:
        return []
    files = []
    t = np.arange(ga.nb) * A.HOP_S
    fig, ax = plt.subplots(2, 1, figsize=(12, 6.5), sharex=True)
    for i, g in enumerate(ga.groups):
        st = ga.st[g].copy()
        st[~ga.active[g]] = np.nan
        ax[0].plot(t, st, lw=0.8, label=_lbl(g))
        ax[1].plot(t, hist[i], lw=1.4, label=_lbl(g))
    for j in result.get("injections", []):
        ax[1].axvspan(j["start"], j["end"], color="0.85", zorder=0)
        ax[1].text(j["start"], 3.6, f"{j['group']} {j['db']:+.0f} dB injected", fontsize=7)
    bw = result["baseline_window_s"]
    ax[0].axvspan(bw[0], bw[1], color="#e8f0ff", zorder=0, label="baseline window")
    ax[0].set_ylabel("short-term LUFS (active only)")
    ax[1].set_ylabel("Intelligence offset (dB)")
    ax[1].set_xlabel("time (s)")
    ax[1].set_ylim(-4.5, 4.5)
    ax[1].axhline(0, color="k", lw=0.5)
    ax[0].legend(fontsize=7, ncol=6, loc="lower left")
    ax[0].set_title("Group loudness and the validated balance offsets")
    fig.tight_layout()
    fig.savefig(out_dir / "offsets.png", dpi=110)
    plt.close(fig)
    files.append("offsets.png")
    if result["pairs"]:
        fig, ax = plt.subplots(figsize=(10, 0.35 * len(result["pairs"]) + 1.2))
        ys = np.arange(len(result["pairs"]))
        devs = [p["deviation_LU"] for p in result["pairs"]]
        tols = [p["tolerance_LU"] for p in result["pairs"]]
        ax.barh(ys, devs, color=["#d9534f" if p["outside"] else "#5b9bd5" for p in result["pairs"]])
        for y, tl in zip(ys, tols):
            ax.plot([-tl, tl], [y, y], color="k", lw=0.6)
            ax.plot([-tl, -tl], [y - 0.3, y + 0.3], color="k", lw=0.6)
            ax.plot([tl, tl], [y - 0.3, y + 0.3], color="k", lw=0.6)
        ax.set_yticks(ys)
        ax.set_yticklabels([p["pair"] for p in result["pairs"]], fontsize=8)
        ax.axvline(0, color="k", lw=0.5)
        ax.set_xlabel("whole-song deviation from target (LU); bracket = tolerance")
        fig.tight_layout()
        fig.savefig(out_dir / "pairs.png", dpi=110)
        plt.close(fig)
        files.append("pairs.png")
    return files


def compare_report(result, actions, ga, hist, out_dir: Path, plots=True):
    figs = _plots(result, ga, hist, out_dir) if plots else []
    c = result["checks"]
    L = [f"# Merge Intelligence offline report: {result['mix']}", "",
         f"Profile **{result['profile']}** | {c['duration_s']:.0f} s | groups: {', '.join(_lbl(g) for g in c['groups'])}", "",
         "> Offline research prototype. Nothing here touched a live mixer. Only **VALIDATED** capabilities were applied "
         "to `audio/after.wav`; **experimental** items are recommendations for review and listening.", ""]
    if result["warnings"]:
        L += ["## Input checks", ""] + [f"- {w}" for w in result["warnings"]] + [""]
    if "mix_vs_stem_sum_dB" in c:
        L += [f"- mix.wav vs sum of stems: {c['mix_vs_stem_sum_dB']} dB (below -20 dB means the stems add up to the mix)", ""]
    L += ["## Listening", ""]
    if "render" in result:
        r = result["render"]
        L += [f"All files are loudness-matched to {r['target_LUFS']} LUFS integrated (common peak trim {r['common_peak_trim_dB']} dB), "
              "so level differences cannot bias the comparison.", "",
              "- `audio/before.wav`: the mix as supplied" + (" **with the injected disturbances**" if result["injections"] else ""),
              "- `audio/after.wav`: the same, with only the validated balance offsets applied",
              f"- {r.get('blind') or 'Blind A/B tests: in Merge Intelligence Lab (Listening Room)'}"]
        if "after_experimental_eq.wav" in r["files"].values():
            L += ["- `audio/after_experimental_eq.wav`: plus experimental EQ recommendations (generic bell EQ, **not validated**)"]
        L.append("")
    if result["injections"]:
        s = result["injection_score"]
        L += ["## Truth-known validation (injected disturbances)", "",
              _table(s["injections"], [("Group", lambda r: _lbl(r["group"])), ("Injected", lambda r: f"{r['db']:+.1f} dB @ {r['start']:.0f}-{r['end']:.0f} s"),
                                        ("Ideal correction", lambda r: f"{r['ideal_dB']:+.1f} dB"), ("Achieved", lambda r: f"{r['achieved_dB']:+.2f} dB"),
                                        ("Corrected", lambda r: f"{100 * r['corrected_fraction']:.0f} %" if r["corrected_fraction"] is not None else "-"),
                                        ("Largest other-group move", lambda r: f"{r['max_other_mean_abs_dB']:.2f} dB"),
                                        ("Note", lambda r: "**saturated at the permission bound**: the offset budget was already used "
                                                           "by the reference-driven correction (apply the starting point first)" if r.get("saturated") else "")]), "",
              f"Scored as the difference between this run and the identical run without the disturbances, so reference-driven "
              f"corrections that would happen anyway are not counted. Response outside the disturbance windows: "
              f"**{s['rms_response_outside_disturbances_dB']} dB RMS** (lower is better).", ""]
    L += ["## Activity and dynamics per group", "", _table(list(result["groups"].items()), [
        ("Group", lambda r: _lbl(r[0])), ("Active", lambda r: f"{100 * r[1]['active_fraction']:.0f} %"),
        ("Integrated", lambda r: f"{r[1]['integrated_LUFS']:.1f} LUFS"), ("Momentary spread", lambda r: f"{r[1]['momentary_spread_LU']} LU"),
        ("Crest", lambda r: f"{r[1]['crest_dB']} dB")]), "",
        "Density of the arrangement (share of time): " + ", ".join(f"{k} {100 * v:.0f} %" for k, v in result["density_fraction"].items()), "",
        "## Balance vs Sound Profile", "",
        f"Targets blend the engineer's baseline (window {result['baseline_window_s'][0]:.0f}-{result['baseline_window_s'][1]:.0f} s) "
        f"and the reference: beta = {result['controller']['beta']} (0 = keep the engineer's relationships, 1 = match the reference).", ""]
    L.append(_table(result["pairs"], [("Pair", lambda r: r["pair"]), ("Live", lambda r: f"{r['live_median_LU']:+.1f}"),
                                      ("Reference", lambda r: "-" if r["reference_LU"] is None else f"{r['reference_LU']:+.1f}"),
                                      ("Baseline", lambda r: "-" if r["baseline_LU"] is None else f"{r['baseline_LU']:+.1f}"),
                                      ("Target", lambda r: f"{r['target_LU']:+.1f}"), ("Deviation", lambda r: f"{r['deviation_LU']:+.1f}"),
                                      ("Tolerance", lambda r: f"±{r['tolerance_LU']:.1f}"), ("Outside?", lambda r: "**yes**" if r["outside"] else ""),
                                      ("Co-active", lambda r: f"{r['coactive_s']:.0f} s")]))
    L += [""] + [f"![{f}]({f})" for f in figs] + [""]
    so = result["static_offsets_dB"]
    L += ["### Whole-song starting point (one bounded solve)", "",
          ", ".join(f"{_lbl(g)} {v:+.1f} dB" for g, v in so.items() if abs(v) >= 0.25) or "No change needed.", "",
          "### Time-varying offsets (what `after.wav` contains)", ""]
    os_ = result["offset_summary"]
    L += [f"- total movement {os_['total_movement_dB']} dB, {os_['direction_reversals']} direction reversals, "
          f"largest offset {os_['max_abs_offset_dB']} dB", "- mean offset: " + ", ".join(f"{_lbl(g)} {v:+.2f}" for g, v in os_["mean_offset_dB"].items()),
          f"- {len(result['events'])} re-target decisions (full list in `decisions.jsonl`, per-block values in `offsets.csv`)", ""]
    if result["events"]:
        L += [_table(result["events"][:25], [("t (s)", lambda r: r["t"]), ("Group", lambda r: _lbl(r["group"])),
                                             ("Offset", lambda r: f"{r['from']:+.1f} -> {r['to']:+.1f} dB"), ("Density", lambda r: r["density"]),
                                             ("Why (engaged pairs, deviation LU)", lambda r: "; ".join(f"{a}-{b} {d:+.1f}" for a, b, d in r["engaged_pairs"][:3]))]), ""]
        if len(result["events"]) > 25:
            L += [f"(first 25 of {len(result['events'])})", ""]
    L += ["## Tone (experimental)", "",
          "Two comparisons per group: against the reference *tendency* (wide tolerance, ±3 dB minimum per band) and against "
          "the group's own approved baseline window. A recommendation names the band of an existing EQ to adjust; executing "
          "it needs the strip's Plugin Intelligence Map.", ""]
    for g, row in result["tone"].items():
        vr = row.get("vs_reference")
        drift = [w for w in row["vs_baseline_windows"] if w["explanation"] in ("eq", "eq+fader")]
        L.append(f"- **{_lbl(g)}**: vs reference: " + (f"{vr['explanation']}" + (f" ({vr['band_hz']} Hz {vr['eq_dB']:+.1f} dB)" if vr["explanation"] == "eq" else "") if vr else "no reference tendency")
                 + f"; drift vs baseline: {len(drift)} window(s)" + (": " + ", ".join(f"{w['t'][0]}-{w['t'][1]} s {w['band_hz']} Hz {w['eq_dB']:+.1f}" for w in drift[:4]) if drift else ""))
    L += ["", "## Dynamics (experimental)", "",
          "Momentary-loudness spread (p95-p10) per 60 s window vs the baseline window. A change can be the performance (leave it) "
          "or the processing (adjust it). With `raw/` stems, `mi study processing` separates the two.", ""]
    for g, row in result["dynamics"].items():
        flagged = [w for w in row["windows"] if abs(w["z"]) > 1]
        L.append(f"- **{_lbl(g)}**: spread {row['momentary_spread_LU']} LU (baseline {row['baseline_spread_LU']}, reference tendency "
                 f"{row['reference_tendency_LU']}); flagged windows: {len(flagged)}")
    pb, pa = result["program_before"], result["program_after"]
    L += ["", "## Program", "", _table([("Before", pb), ("After", pa)], [
        ("", lambda r: r[0]), ("Integrated", lambda r: f"{r[1]['integrated_LUFS']:.1f} LUFS"), ("LRA", lambda r: f"{r[1]['LRA_LU']:.1f} LU"),
        ("True peak", lambda r: f"{r[1]['truePeak_dBTP']:.1f} dBTP"), ("Width", lambda r: r[1]["width"])]), "", pb["note"], ""]
    L += ["## All actions considered", ""]
    for kind in ("groupGainOffset", "staticGroupOffset", "eqBandGain", "compressionIntensity", "programSteering", "none"):
        acts = [a for a in actions if a.kind == kind]
        if not acts:
            continue
        L.append(f"### `{kind}` ({len(acts)})")
        L.append("")
        for a in acts[:30]:
            st = a.status + (f" - {a.withheld_reason}" if a.withheld_reason else "")
            L.append(f"- {a.summary()} _({st}; confidence {a.confidence:.1f})_")
        if len(acts) > 30:
            L.append(f"- ... {len(acts) - 30} more in `decisions.jsonl`")
        L.append("")
    L += ["## Capability maturity", "", maturity_legend(), ""]
    (out_dir / "report.md").write_text("\n".join(L))


# --------------------------------------------------------------------- speech
def speech_report(res: dict, out_dir: Path, figs=()):
    L = [f"# Speech Intelligence offline report: {res['name']}", "",
         f"{len(res['mics'])} microphones | {res['duration_s']:.0f} s | target speech loudness {res['target_LUFS']} LUFS (short-term)", "",
         "> Offline prototype. Gain sharing (US 3,992,584 maths) decides **which** mic holds the floor; the layered leveller "
         "decides **how loud** the active talker is. Both are VALIDATED on synthetic tests (exp05); real-audio behaviour is "
         "what this report measures.", ""]
    if res["warnings"]:
        L += ["## Input checks", ""] + [f"- {w}" for w in res["warnings"]] + [""]
    L += ["## Listening", "", "- `audio/before.wav`: all mics open at unity (what you'd hear without an automixer)",
          "- `audio/after_automix.wav`: gain sharing only", "- `audio/after.wav`: gain sharing + speech leveller",
          "- Blind A/B tests: in Merge Intelligence Lab's Listening Room", "", "## Microphones", ""]
    L.append(_table(res["mics"], [("Mic", lambda r: r["name"]), ("Weight", lambda r: f"{r['weight_db']:+.1f} dB"),
                                  ("Holds the floor", lambda r: f"{r['floor_s']:.0f} s"), ("Median share while talking", lambda r: f"{r['share_talking_db']:+.1f} dB"),
                                  ("Median share otherwise", lambda r: f"{r['share_idle_db']:+.1f} dB"),
                                  ("Speech level (pre-automix)", lambda r: f"{r['speech_LUFS']:.1f} LUFS" if r["speech_LUFS"] is not None else "-"),
                                  ("Leveller correction", lambda r: f"{r['leveller_db']:+.1f} dB" if r["leveller_db"] is not None else "-")]))
    L += ["", f"- Ambient/idle noise: all-open {res['idle_noise_before_db']} dB vs automix {res['idle_noise_after_db']} dB "
          f"(difference {res['idle_noise_before_db'] - res['idle_noise_after_db']:+.1f} dB) in blocks where nobody holds the floor",
          f"- Handovers (floor changes): {res['handovers']}", ""] + [f"![{f}]({f})" for f in figs] + ["", "## Actions", ""]
    for a in res["actions"]:
        L.append(f"- {a}")
    (out_dir / "report.md").write_text("\n".join(L))
