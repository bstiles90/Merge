"""Research packages for Claude Code (docs/MERGE_INTELLIGENCE_LAB_RESEARCH_EXPORT.md).

A package is a ZIP with a human summary (SUMMARY.md), a review prompt (PROMPT.md), a manifest,
and per-experiment evidence. By default it contains NO audio, no absolute file paths, and no
credentials. Audio is included only when explicitly selected. Nothing is uploaded anywhere.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import zipfile
from pathlib import Path

from . import APP_VERSION, PACKAGE_SCHEMA
from . import comparison as CMP
from . import feedback as FB
from .paths import build_info
from .store import read_json

AUDIO_EXT = {".wav", ".aif", ".aiff", ".flac"}
EVIDENCE = ["analysis.json", "decisions.jsonl", "offsets.csv", "activity.csv", "loudness.csv", "speech_blocks.csv", "result.json",
            "program_series.csv"]
RENAME = {"analysis.json": "measurements.json", "result.json": "study_result.json"}
BAD_VERDICTS = {"too_much", "too_little", "wrong_direction", "wrong_type", "unnecessary", "missed", "musical_change"}
GOOD_VERDICTS = {"correct", "correct_no_action"}


def resolve_scope(ws, scope: dict) -> dict:
    exps = ws.experiments()
    ids = []
    if scope.get("experiments"):
        ids = list(scope["experiments"])
    elif scope.get("algorithm_version"):
        ids = [e["id"] for e in exps if e.get("algorithm_version") == scope["algorithm_version"]]
    elif scope.get("failed"):
        ids = [e["id"] for e in exps if e.get("status") in ("failed", "cancelled", "interrupted")]
    elif scope.get("profile_id"):
        ids = [e["id"] for e in exps if e.get("inputs", {}).get("profile_id") == scope["profile_id"]]
    elif scope.get("comparison"):
        ids = list(scope["comparison"])
    elif scope.get("session"):
        ids = [e["id"] for e in exps]
    profiles = sorted({ws.experiment(i).get("inputs", {}).get("profile_id") for i in ids} - {None})
    if scope.get("profile_id"):
        profiles = sorted(set(profiles) | {scope["profile_id"]})
    return {"experiments": ids, "profiles": profiles, "comparison": scope.get("comparison")}


class _Sanitizer:
    def __init__(self, ws, anonymize=False):
        self.root = str(ws.root)
        self.home = str(Path.home())
        self.anon = anonymize
        self.names = {}
        # folders of every library file (external drives, shared volumes...), longest first
        dirs = set()
        for kind in ("references", "mixes", "speech", "recordings"):
            for it in ws.items(kind):
                for f in ws.files_of(it):
                    for key in ("path", "original_path"):
                        if f.get(key):
                            dirs.add(str(Path(f[key]).parent))
        self.dirs = sorted((d for d in dirs if len(d) > 1), key=len, reverse=True)
        if anonymize:
            for kind, label in (("references", "Reference"), ("mixes", "Mix"), ("speech", "Speech recording"), ("recordings", "Broadcast recording")):
                for k, it in enumerate(ws.items(kind), 1):
                    for key in ("title", "name"):
                        if it.get(key):
                            self.names[it[key]] = f"{label} {k}"

    def text(self, s: str) -> str:
        s = s.replace(self.root, "<workspace>")
        s = re.sub(r"(/Users/[^/\s\"']+|/home/[^/\s\"']+|[A-Za-z]:\\\\Users\\\\[^\\\s\"']+)", "<home>", s)
        s = s.replace(self.home, "<home>")
        for d in self.dirs:
            s = s.replace(d, "<audio folder>")
        # any remaining absolute path: keep only the file name
        s = re.sub(r"(?<![\w<>:/.])/(?:[^/\s\"'`]+(?: [^/\s\"'`]+)*/)+([^/\s\"'`]*)", r"…/\1", s)
        s = re.sub(r"\b[A-Za-z]:\\(?:[^\\\s\"']+\\)+([^\\\s\"']*)", r"…\\\1", s)
        for n, a in self.names.items():
            s = s.replace(n, a)
        return s

    def obj(self, o):
        if isinstance(o, dict):
            out = {}
            for k, v in o.items():
                if k in ("path", "original_path") and isinstance(v, str):
                    out[k] = Path(v).name if not self.anon else "<file>"
                else:
                    out[k] = self.obj(v)
            return out
        if isinstance(o, list):
            return [self.obj(x) for x in o]
        if isinstance(o, str):
            return self.text(o)
        if isinstance(o, float) and not math.isfinite(o):
            return None  # NaN/Infinity would make the package's JSON unreadable for reviewers
        return o


def _plan(ws, sel, opts):
    """List of (arcname, source_path_or_None, data_or_None, category)."""
    inc_audio_r = bool(opts.get("include_rendered_audio"))
    inc_audio_o = bool(opts.get("include_original_audio"))
    inc_comments = opts.get("include_comments", True)
    plan = []
    for pid in sel["profiles"]:
        d = ws.profile_dir(pid)
        for f, arc in (("profile.json", "sound_profile.json"), ("profile.md", "sound_profile.md"), ("meta.json", "meta.json")):
            if (d / f).is_file():
                plan.append((f"sound_profiles/{pid}/{arc}", d / f, None, "evidence"))
    for eid in sel["experiments"]:
        edir = ws.exp_dir(eid)
        res = edir / "results"
        exp = read_json(edir / "experiment.json", {})
        plan.append((f"experiments/{eid}/experiment.json", None, exp, "evidence"))
        for f in EVIDENCE:
            if (res / f).is_file():
                plan.append((f"experiments/{eid}/{RENAME.get(f, f)}", res / f, None, "evidence"))
        for f in ("report.md",):
            if (res / f).is_file():
                plan.append((f"experiments/{eid}/report.md", res / f, None, "report"))
        for png in sorted(res.glob("*.png")) if res.is_dir() else []:
            plan.append((f"experiments/{eid}/{png.name}", png, None, "plot"))
        fb = FB.load(edir)
        if not inc_comments:
            fb = _strip_comments(fb)
        plan.append((f"experiments/{eid}/engineer_feedback.json", None, fb, "feedback"))
        ls = FB.listening(edir)
        ls = {**ls, "trials": [dict(t, answer=(dict(t["answer"], comment="") if (t.get("answer") and not inc_comments) else t.get("answer")))
                               for t in ls["trials"]], "tally": FB.tally(ls["trials"])}
        plan.append((f"experiments/{eid}/listening_results.json", None, ls, "feedback"))
        diag = {"status": exp.get("status"), "error": exp.get("error"), "warnings": (read_json(res / "analysis.json", {}) or {}).get("warnings", [])}
        plan.append((f"experiments/{eid}/diagnostics.json", None, diag, "evidence"))
        if inc_audio_r and (res / "audio").is_dir():
            for f in sorted((res / "audio").rglob("*")):
                if f.suffix.lower() in AUDIO_EXT and "blind" not in f.parts:
                    plan.append((f"experiments/{eid}/audio/{f.relative_to(res / 'audio').as_posix()}", f, None, "audio"))
        if inc_audio_o:
            for kind, key in (("mixes", "mix_id"), ("speech", "speech_id")):
                iid = exp.get("inputs", {}).get(key)
                if iid:
                    try:
                        it = ws.get(kind, iid)
                    except KeyError:
                        continue
                    for fr in ws.files_of(it):
                        if Path(fr["path"]).is_file():
                            plan.append((f"original_audio/{iid}/{fr['name']}", Path(fr["path"]), None, "audio"))
    if sel.get("comparison") and len(sel["comparison"]) == 2:
        a, b = sel["comparison"]
        plan.append((f"comparisons/{a}__{b}.json", None, CMP.compare(ws, a, b), "evidence"))
    return plan


def _strip_comments(fb):
    fb = json.loads(json.dumps(fb))
    for k in ("decisions", "notes", "missed", "overall", "findings"):
        for x in fb.get(k, []):
            for f in ("comment", "notes", "text", "preferred_notes"):
                if f in x:
                    x[f] = "<excluded>"
            x.pop("history", None)
    return fb


def preview(ws, scope, opts) -> dict:
    sel = resolve_scope(ws, scope)
    plan = _plan(ws, sel, opts)
    files = []
    for arc, src, data, cat in plan:
        size = src.stat().st_size if src is not None else len(json.dumps(data, default=str))
        files.append({"path": arc, "size": size, "category": cat})
    return {"selection": sel, "files": files + [{"path": "SUMMARY.md", "size": 0, "category": "summary"},
                                                 {"path": "PROMPT.md", "size": 0, "category": "summary"},
                                                 {"path": "manifest.json", "size": 0, "category": "summary"}],
            "contains_audio": any(f["category"] == "audio" for f in files),
            "contains_comments": bool(opts.get("include_comments", True)),
            "total_bytes": sum(f["size"] for f in files)}


def build(ws, scope, opts, dest: Path | None = None) -> dict:
    sel = resolve_scope(ws, scope)
    if not sel["experiments"] and not sel["profiles"]:
        raise ValueError("Nothing to export in that selection")
    plan = _plan(ws, sel, opts)
    san = _Sanitizer(ws, bool(opts.get("anonymize")))
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    name = f"merge-lab-research-{stamp}"
    dest = Path(dest) if dest else ws.root / "exports" / f"{name}.zip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    summary = summary_md(ws, sel, san, opts)
    prompt = review_prompt(sel, name)
    info = build_info()
    manifest = {"schema": PACKAGE_SCHEMA, "created": dt.datetime.now().isoformat(timespec="seconds"), "package": name,
                "app_version": APP_VERSION, "algorithm_versions": sorted({ws.experiment(e).get("algorithm_version") or "?" for e in sel["experiments"]}),
                "git_commit": info.get("git_commit"), "scope": scope, "selection": sel,
                "privacy": {"audio_included": any(c == "audio" for *_, c in plan), "comments_included": bool(opts.get("include_comments", True)),
                            "anonymized_names": bool(opts.get("anonymize")), "absolute_paths": "removed"},
                "files": [arc for arc, *_ in plan] + ["SUMMARY.md", "PROMPT.md"],
                "schemas": {"experiment": "merge.lab.experiment/1", "feedback": "merge.lab.feedback/1", "listening": "merge.lab.listening/1",
                            "measurements": "merge.intelligence.result/1"},
                "reproduce": "Rerun each experiment in Merge Intelligence Lab with the original audio (identified by the fingerprints in "
                             "experiment.json). Derived measurements alone cannot reproduce the audio results."}
    tmp = dest.with_name(f".{dest.name}.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}/SUMMARY.md", summary)
        z.writestr(f"{name}/PROMPT.md", prompt)
        z.writestr(f"{name}/manifest.json", json.dumps(manifest, indent=1, default=str))
        for arc, src, data, cat in plan:
            if data is not None:
                z.writestr(f"{name}/{arc}", json.dumps(san.obj(data), indent=1, default=str))
            elif cat == "audio" or src.suffix.lower() in (".png",):
                z.write(src, f"{name}/{arc}")
            elif src.suffix in (".json",):
                z.writestr(f"{name}/{arc}", json.dumps(san.obj(json.loads(src.read_text())), indent=1, default=str))
            elif src.suffix == ".jsonl":
                lines = [json.dumps(san.obj(json.loads(l)), default=str) for l in src.read_text().splitlines() if l.strip()]
                z.writestr(f"{name}/{arc}", "\n".join(lines) + "\n")
            else:
                z.writestr(f"{name}/{arc}", san.text(src.read_text(errors="replace")))
    os.replace(tmp, dest)
    return {"path": str(dest), "name": name, "summary": summary, "prompt": prompt, "files": len(plan) + 3}


def summary_md(ws, sel, san, opts) -> str:
    L = ["# Merge Intelligence Lab: research package", "",
         f"Created {dt.datetime.now().isoformat(timespec='minutes')} with Merge Intelligence Lab {APP_VERSION}.", ""]
    if sel["profiles"]:
        L += ["## Sound Profiles", ""]
        for pid in sel["profiles"]:
            m = read_json(ws.profile_dir(pid) / "meta.json", {}) or {}
            comp = m.get("composition") or {}
            L.append(f"- **{san.text(m.get('name', pid))}** ({pid}): {len(m.get('reference_ids', []))} reference(s)"
                     + (f" ({comp.get('with_stems', 0)} with stems, {comp.get('master_only', 0)} master-only; programme analysis of "
                        f"{comp.get('program_analysed', 0)})" if comp else "")
                     + f", algorithm {m.get('algorithm_version')}, status {m.get('status')}")
            for lim in m.get("limitations", []):
                L.append(f"  - limitation: {san.text(lim)}")
        L.append("")
    for eid in sel["experiments"]:
        exp = ws.experiment(eid)
        res = ws.exp_dir(eid) / "results"
        a = read_json(res / "analysis.json", {}) or {}
        L += [f"## Experiment {eid}: {san.text(exp.get('name', ''))}", "",
              f"- Type: {exp['type']}{' (' + exp['config'].get('study', '') + ' study)' if exp['type'] == 'study' else ''}; "
              f"status **{exp.get('status')}**; algorithm {exp.get('algorithm_version')}; app {exp.get('app_version')}; "
              f"material {'synthetic demo' if exp.get('synthetic') else 'real recordings'}",
              f"- Settings: `{json.dumps({k: v for k, v in exp.get('config', {}).items() if k not in ('activity',)}, default=str)}`"]
        if exp.get("injections"):
            L.append("- Known disturbances: " + "; ".join(f"{j['group']} {j['db']:+g} dB @ {j['start']:g}-{j['end']:g} s" for j in exp["injections"]))
        if exp.get("error"):
            L.append(f"- Error: `{san.text(exp['error'].splitlines()[-1] if exp['error'] else '')}`")
        if exp["type"] == "music" and a:
            os_ = a.get("offset_summary", {})
            L += [f"- Intended task: keep the group balance within the profile's ranges (beta {a.get('controller', {}).get('beta')}, "
                  f"evidence {a.get('controller', {}).get('evidence_s')} s, rate {a.get('controller', {}).get('rate_db_s')} dB/s)",
                  f"- Pairs outside tolerance (whole song): {sum(1 for p in a.get('pairs', []) if p['outside'])} of {len(a.get('pairs', []))}",
                  f"- Validated gain decisions: {len(a.get('events', []))}; movement {os_.get('total_movement_dB')} dB, "
                  f"{os_.get('direction_reversals')} reversals, largest {os_.get('max_abs_offset_dB')} dB",
                  "- Mean offsets: " + ", ".join(f"{g} {v:+.2f} dB" for g, v in os_.get("mean_offset_dB", {}).items())]
            if a.get("injection_score"):
                for j in a["injection_score"]["injections"]:
                    L.append(f"- Disturbance {j['group']} {j['db']:+g} dB: corrected {100 * (j['corrected_fraction'] or 0):.0f} %"
                             f"{' (SATURATED at the permission bound)' if j.get('saturated') else ''}; other groups moved ≤ {j['max_other_mean_abs_dB']} dB")
            low = [g for g, v in a.get("groups", {}).items() if v.get("active_fraction", 1) < 0.2]
            if low:
                L.append(f"- Activity: {', '.join(low)} classified active < 20 % of the time (check activity detection)")
        if exp["type"] == "speech" and a:
            L += [f"- Handovers: {a.get('handovers')}; idle noise {a.get('idle_noise_before_db')} -> {a.get('idle_noise_after_db')} dB",
                  "- Mics: " + "; ".join(f"{san.text(m['name'])} floor {m['floor_s']} s, level {m['speech_LUFS']} LUFS, leveller {m['leveller_db']} dB" for m in a.get("mics", [])),
                  f"- Calibration: {a.get('calibration', {}).get('note', '')}"]
        if exp["type"] == "program" and a:
            c = a.get("comparison", {})
            L += [f"- Stereo recording compared with the Program Sound Profile of {san.text(str(a.get('profile')))} "
                  f"({c.get('n_references')} references{', few: ranges are indicative' if c.get('few_references') else ''}). "
                  "DIAGNOSTIC ONLY: stereo findings do not identify sources and are not processing instructions.",
                  f"- Findings: {len(c.get('findings', []))}"]
            L += [f"  - {san.text(f['text'])}" for f in c.get("findings", [])]
        fb = FB.load(ws.exp_dir(eid))
        if fb.get("findings"):
            L.append(f"- Engineer verdicts on findings: " + ", ".join(f"{x.get('finding_id')}: {FB.FINDING_VERDICTS.get(x['verdict'], x['verdict'])}"
                                                                   for x in fb["findings"]))
        bad = [x for x in fb["decisions"] if x["verdict"] in BAD_VERDICTS]
        good = [x for x in fb["decisions"] if x["verdict"] in GOOD_VERDICTS]
        L.append(f"- Engineer feedback: {len(fb['decisions'])} decision evaluations ({len(good)} judged right, {len(bad)} judged wrong), "
                 f"{len(fb['notes'])} notes, {len(fb['missed'])} missed interventions, {len(fb['overall'])} overall evaluations")
        for x in bad:
            pref = x.get("preferred") or {}
            L.append(f"  - problem: {FB.DECISION_VERDICTS[x['verdict']]} at {x.get('time_s', '?')} s on {x.get('target', '?')}"
                     f"{' - preferred ' + str(pref.get('kind')) + ' ' + str(pref.get('value', '')) if pref else ''}"
                     f"{': ' + san.text(x.get('comment', '')) if opts.get('include_comments', True) and x.get('comment') else ''}")
        for x in fb["missed"]:
            L.append(f"  - missed: {x.get('issue', '')} on {x.get('target', '?')} at {x.get('start_s', '?')}-{x.get('end_s', '?')} s"
                     f"{': ' + san.text(x.get('comment', '')) if opts.get('include_comments', True) and x.get('comment') else ''}")
        for o in fb["overall"]:
            r = o.get("ratings", {})
            L.append(f"  - overall ({'blind' if o.get('blind') else 'non-blind'}, version {o.get('version', '?')}): "
                     + ", ".join(f"{k} {v}" for k, v in r.items() if v != "na"))
        t = FB.tally(FB.listening(ws.exp_dir(eid))["trials"])
        if t["answered"]:
            L.append(f"- Blind A/B: {t['answered']} answered: {t['preferences']} ({t['note']})")
        L.append("")
    L += ["## Issues to investigate", ""]
    issues = []
    for eid in sel["experiments"]:
        exp = ws.experiment(eid)
        if exp.get("status") != "complete":
            issues.append(f"{eid}: {exp.get('status')}")
        a = read_json(ws.exp_dir(eid) / "results" / "analysis.json", {}) or {}
        for j in (a.get("injection_score") or {}).get("injections", []):
            if j.get("saturated"):
                issues.append(f"{eid}: correction of {j['group']} saturated at its permission bound")
            elif j.get("corrected_fraction") is not None and j["corrected_fraction"] < 0.5:
                issues.append(f"{eid}: only {100 * j['corrected_fraction']:.0f} % of the {j['group']} disturbance was corrected")
        fb = FB.load(ws.exp_dir(eid))
        cats = {}
        for x in fb["decisions"] + fb["missed"]:
            if x.get("category"):
                cats[x["category"]] = cats.get(x["category"], 0) + 1
        for c, n in cats.items():
            issues.append(f"{eid}: {n} feedback item(s) in category '{FB.CATEGORIES.get(c, c)}'")
    L += [f"- {i}" for i in issues] or ["- none recorded"]
    L += ["", "Files: see manifest.json. Measurements are in `experiments/<id>/measurements.json`, every decision in "
          "`decisions.jsonl` (programme comparisons: diagnostic findings), per-block offsets/activity/loudness/programme series in the CSV files, engineer judgements in `engineer_feedback.json` "
          "and blind trials in `listening_results.json`.", ""]
    return "\n".join(L)


def review_prompt(sel, package_name) -> str:
    ids = ", ".join(sel["experiments"]) or "(profiles only)"
    return f"""Please review the Merge Intelligence Lab research package `{package_name}` (experiments: {ids}).

1. Read SUMMARY.md and manifest.json. Note the exact algorithm version(s), app version and git commit.
2. For each experiment, review experiment.json (configuration, source mappings, baseline, injected disturbances, permissions).
3. Check out the matching commit and review the implementation in research/intelligence/mi/ that produced these results.
4. Analyse the objective results in measurements.json, decisions.jsonl and the CSV files.
5. Analyse the engineer feedback (engineer_feedback.json) and blind listening results (listening_results.json).
6. Identify incorrect or unnecessary decisions, and missed interventions.
7. Look for recurring failure patterns across experiments, not single observations.
8. For each pattern, decide where it originates: measurement, reference representation (Sound Profile), activity detection,
   problem identification, intervention selection, execution, or controller stability.
9. Propose improvements, with the evidence that supports each one.
10. List the additional experiments needed to confirm or reject each proposal.
11. Add regression tests that capture the problem before changing behaviour.
12. Implement only the improvements that are justified, when asked.
13. Preserve the original research evidence; never rewrite recorded results or feedback.
14. Document the changes (algorithm version bump, research docs).
15. Produce an updated Merge Intelligence Lab build so the same experiments can be rerun and compared.

Do not change the algorithms on the strength of a single subjective observation. Weigh it against the other experiments,
the regression suite and the research documents, and aim for behaviour that generalises across songs, arrangements and
recordings - not for one song, one reference or one comment.
"""
