"""Merge Intelligence offline research prototype - command line.

    ./run.sh demo  <workspace>                 make a synthetic workspace to try everything
    ./run.sh check <workspace>                 list what was recognised; flag spec problems
    ./run.sh profile <workspace> [--name N]    references -> Sound Profile (+ report)
    ./run.sh compare <workspace> <mix>         analyse, recommend, render before/after (+ report)
    ./run.sh speech  <workspace> <name>        speech prototype: gain sharing + leveller
    ./run.sh all     <workspace>               profile, then every mix and speech set
    ./run.sh study <name> <workspace> ...      investigations (activity | beta | response | generalization | processing)

Outputs go to <workspace>/results/... (overwritten each run unless you pass --tag).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import audio_io as io
from .layout import find_references, load_config, load_mix, map_stems, audio_files


def _out(ws: Path, kind: str, name: str, tag: str | None) -> Path:
    return ws / "results" / kind / (f"{name}-{tag}" if tag else name)


def cmd_demo(a):
    from .demo import make
    ws = make(Path(a.workspace), dur=a.seconds)
    print(f"demo workspace written to {ws}\nnext:  ./run.sh all {ws}")


def cmd_check(a):
    ws = Path(a.workspace)
    problems = 0
    print(f"workspace {ws.resolve()}")
    refs = find_references(ws)
    print(f"\nreferences/ ({len(refs)})")
    for r in refs:
        print(f"  {r.name}: master={'yes' if r.master else 'MISSING'}; " + ", ".join(f"{g}<-{[p.name for p in r.stems.files[g]]}" for g in r.stems.groups()))
        if r.stems.unmapped:
            print(f"    unrecognised (ignored): {[p.name for p in r.stems.unmapped]}")
        problems += _check_files([r.master] if r.master else [], r.stems)
    mixes = sorted(p for p in (ws / "mixes").iterdir() if p.is_dir()) if (ws / "mixes").is_dir() else []
    print(f"\nmixes/ ({len(mixes)})")
    for d in mixes:
        m = load_mix(d)
        print(f"  {m.name}: mix.wav={'yes' if m.mix else 'no'}; raw/={'yes' if m.raw else 'no'}; " + ", ".join(f"{g}<-{[p.name for p in m.stems.files[g]]}" for g in m.stems.groups()))
        problems += _check_files([m.mix] if m.mix else [], m.stems)
    sp = sorted(p for p in (ws / "speech").iterdir() if p.is_dir()) if (ws / "speech").is_dir() else []
    print(f"\nspeech/ ({len(sp)})")
    for d in sp:
        files = audio_files(d / "mics" if (d / "mics").is_dir() else d)
        print(f"  {d.name}: {[p.name for p in files]}")
    print(f"\n{problems} problem(s) found" if problems else "\nno problems found")


def _check_files(extra, stemset):
    import soundfile as sf
    n = 0
    lengths = []
    for p in extra + [p for g in stemset.groups() for p in stemset.files[g]]:
        info = sf.info(str(p))
        lengths.append(info.frames / info.samplerate)
        issues = []
        if info.samplerate != io.PROJECT_SR:
            issues.append(f"{info.samplerate} Hz (expected {io.PROJECT_SR})")
        if info.subtype not in ("PCM_24", "FLOAT", "DOUBLE", "PCM_32"):
            issues.append(f"{info.subtype} (24-bit or 32-bit float expected)")
        if issues:
            n += 1
            print(f"    ! {p.name}: " + "; ".join(issues))
    if lengths and max(lengths) - min(lengths) > 0.01:
        n += 1
        print(f"    ! lengths differ by {max(lengths) - min(lengths):.2f} s (export with identical start and end)")
    return n


def cmd_profile(a):
    from .reference import analyse_reference, build_profile, save_profile
    from .report import profile_report
    ws = Path(a.workspace)
    cfg = load_config(ws)
    refs = find_references(ws)
    if a.refs:
        keep = set(a.refs.split(","))
        refs = [r for r in refs if r.name in keep]
    if not refs:
        sys.exit("no references found under references/ (see docs/MERGE_INTELLIGENCE_AUDIO_SPEC.md)")
    analyses = []
    for r in refs:
        t = time.time()
        meta, ga = analyse_reference(r, cfg.get("activity"))
        analyses.append((meta, ga))
        print(f"  analysed {r.name} ({meta['duration_s']:.0f} s) in {time.time() - t:.1f} s; recon error {meta['quality'].get('reconErr_dB')} dB")
        for w in meta["warnings"] + meta["quality"]["flags"]:
            print(f"    - {w}")
    prof = build_profile(analyses, a.name)
    out = ws / "profiles" / f"{a.name}.json"
    save_profile(prof, out)
    profile_report(prof, out.with_suffix(".md"))
    print(f"profile: {out}\nreport:  {out.with_suffix('.md')}")
    return out


def _latest_profile(ws: Path, given: str | None) -> dict:
    from .reference import load_profile
    if given:
        return load_profile(Path(given))
    profs = sorted((ws / "profiles").glob("*.json"), key=lambda p: p.stat().st_mtime) if (ws / "profiles").is_dir() else []
    if not profs:
        sys.exit("no profile: run `profile` first or pass --profile")
    return load_profile(profs[-1])


def cmd_compare(a):
    from .compare import compare
    ws = Path(a.workspace)
    prof = _latest_profile(ws, a.profile)
    out = _out(ws, "compare", a.mix, a.tag)
    t = time.time()
    res, actions = compare(ws, a.mix, prof, load_config(ws), out, inject_spec=a.inject, beta=a.beta, evidence_s=a.evidence,
                           rate=a.rate, render=not a.no_render, render_experimental=a.experimental_render, seed=a.seed,
                           plots=not a.no_plots)
    print(f"done in {time.time() - t:.0f} s -> {out}/report.md")
    if res.get("injection_score"):
        for j in res["injection_score"]["injections"]:
            print(f"  {j['group']} {j['db']:+.1f} dB: corrected {j['achieved_dB']:+.2f} dB ({100 * (j['corrected_fraction'] or 0):.0f} %)")
    return res


def cmd_speech(a):
    from .speech import run_speech
    ws = Path(a.workspace)
    out = _out(ws, "speech", a.name, a.tag)
    res = run_speech(ws, a.name, load_config(ws), out, seed=a.seed, plots=not a.no_plots)
    print(f"-> {out}/report.md")
    return res


def cmd_all(a):
    ws = Path(a.workspace)
    a.name, a.refs = a.name or "profile", None
    if (ws / "references").is_dir():
        cmd_profile(a)
    for d in sorted(p for p in (ws / "mixes").iterdir() if p.is_dir()) if (ws / "mixes").is_dir() else []:
        ns = argparse.Namespace(workspace=a.workspace, mix=d.name, profile=None, inject=None, beta=None, evidence=None, rate=None,
                                no_render=False, experimental_render=True, seed=a.seed, tag=a.tag, no_plots=False)
        print(f"\ncompare {d.name}")
        cmd_compare(ns)
    for d in sorted(p for p in (ws / "speech").iterdir() if p.is_dir()) if (ws / "speech").is_dir() else []:
        print(f"\nspeech {d.name}")
        cmd_speech(argparse.Namespace(workspace=a.workspace, name=d.name, seed=a.seed, tag=a.tag, no_plots=False))


def cmd_study(a):
    from . import studies
    ws = Path(a.workspace)
    fn = {"activity": studies.activity_study, "beta": studies.beta_study, "response": studies.response_study,
          "generalization": studies.generalization_study, "processing": studies.processing_study,
          "density": studies.density_study}[a.study]
    out = ws / "results" / "studies" / a.study
    out.mkdir(parents=True, exist_ok=True)
    res = fn(ws, a, out)
    (out / "result.json").write_text(json.dumps(res, indent=1, default=float))
    print(f"-> {out}/report.md")


def cmd_program(a):
    """Programme analysis of stereo files; Program Sound Profile from them; optional diagnostic comparison."""
    from .program import analyse_program_file, build_program_profile, compare_program
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    items = []
    for p in a.files:
        m = analyse_program_file(p, Path(p).stem)
        m.pop("series", None)
        items.append({"id": Path(p).stem, "title": Path(p).stem, "analysis": m})
        s = m["scalars"]
        print(f"{Path(p).name}: {s['loudness']['integrated_LUFS']} LUFS, LRA {s['loudness']['LRA_LU']} LU, "
              f"tilt {s['spectrum']['tilt_dB_per_oct']} dB/oct, side/mid {s['stereo']['sideToMid_dB']} dB")
    prof = build_program_profile(items)
    (out / "program_profile.json").write_text(json.dumps(prof, indent=1, default=float))
    print(f"-> {out}/program_profile.json ({prof['n_references']} references)")
    if a.compare:
        m = analyse_program_file(a.compare, Path(a.compare).stem)
        m.pop("series", None)
        c = compare_program(m, prof)
        (out / "comparison.json").write_text(json.dumps(c, indent=1, default=float))
        print(c["note"])
        for f in c["findings"]:
            print(" -", f["text"])
        print(f"-> {out}/comparison.json")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mi", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("demo", help="write a synthetic demo workspace")
    s.add_argument("workspace"); s.add_argument("--seconds", type=float, default=90.0); s.set_defaults(fn=cmd_demo)
    s = sub.add_parser("check", help="show what the prototype recognises in a workspace")
    s.add_argument("workspace"); s.set_defaults(fn=cmd_check)
    s = sub.add_parser("profile", help="build a Sound Profile from references/")
    s.add_argument("workspace"); s.add_argument("--name", default="profile"); s.add_argument("--refs", help="comma-separated subset")
    s.set_defaults(fn=cmd_profile)
    s = sub.add_parser("compare", help="compare a mix with the profile; recommend; render")
    s.add_argument("workspace"); s.add_argument("mix"); s.add_argument("--profile")
    s.add_argument("--inject", help='known disturbances, e.g. "guitars:+3@30-60,vocals:-3@90-120"')
    s.add_argument("--beta", type=float, help="0 = engineer baseline, 1 = reference (default from config, else 0.5)")
    s.add_argument("--evidence", type=float, help="evidence window in seconds (default 6)")
    s.add_argument("--rate", type=float, help="offset rate limit, dB/s (default 0.5)")
    s.add_argument("--experimental-render", action="store_true", help="also write after_experimental_eq.wav")
    s.add_argument("--no-render", action="store_true"); s.add_argument("--no-plots", action="store_true")
    s.add_argument("--seed", type=int); s.add_argument("--tag")
    s.set_defaults(fn=cmd_compare)
    s = sub.add_parser("speech", help="speech prototype on speech/<name>/mics")
    s.add_argument("workspace"); s.add_argument("name"); s.add_argument("--seed", type=int); s.add_argument("--tag")
    s.add_argument("--no-plots", action="store_true"); s.set_defaults(fn=cmd_speech)
    s = sub.add_parser("all", help="profile + every mix + every speech set")
    s.add_argument("workspace"); s.add_argument("--name"); s.add_argument("--seed", type=int); s.add_argument("--tag")
    s.set_defaults(fn=cmd_all)
    s = sub.add_parser("study", help="parameter investigations")
    s.add_argument("study", choices=["activity", "beta", "response", "generalization", "processing", "density"])
    s.add_argument("workspace"); s.add_argument("--mix", help="mix name (default: first under mixes/)")
    s.add_argument("--profile"); s.add_argument("--inject", help="disturbances for the response study")
    s.set_defaults(fn=cmd_study)
    s = sub.add_parser("program", help="programme analysis of stereo masters (no stems) and diagnostic comparison")
    s.add_argument("files", nargs="+", help="stereo reference masters")
    s.add_argument("--compare", help="a stereo recording to place within the references' ranges (diagnostic only)")
    s.add_argument("--out", default="results/program")
    s.set_defaults(fn=cmd_program)
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
