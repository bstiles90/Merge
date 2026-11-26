"""Work that runs in background processes (one process per job).

Every task reports progress through `report(stage, fraction, text)` and returns a JSON-able
result. All audio work calls the research backend (`mi`); nothing here reimplements an algorithm.
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
import traceback
from pathlib import Path

import numpy as np

from .paths import ensure_backend_importable
from .store import Workspace, atomic_write_json, now, read_json
from . import staging as S

ensure_backend_importable()

CORE_GROUPS = ["vocals", "drums", "bass", "guitars", "keys", "synths"]
GROUP_LABEL = {"vocals": "vocal", "drums": "drum", "bass": "bass", "guitars": "guitar", "keys": "keys", "synths": "synth"}


# ============================================================================ validation
def _stream_stats(path, sr_expected=48000, block=48000 * 10):
    """Peak, clipped samples, integrated loudness - streamed, constant memory."""
    import soundfile as sf
    from scipy.signal import lfilter
    from mi import features as F
    from mi import analysis as A
    info = sf.info(str(path))
    (bs, as_), (bh, ah) = F.k_weighting_coeffs(info.samplerate)
    z1 = np.zeros((info.channels, 2))
    z2 = np.zeros((info.channels, 2))
    hop = int(round(info.samplerate * 0.1))
    rem = np.zeros((info.channels, 0))
    pows, peak, clipped = [], 0.0, 0
    with sf.SoundFile(str(path)) as f:
        for x in f.blocks(blocksize=block, dtype="float64", always_2d=True):
            x = x.T
            peak = max(peak, float(np.max(np.abs(x))) if x.size else 0.0)
            clipped += int(np.sum(np.abs(x) >= 0.999))
            y, z1 = lfilter(bs, as_, x, axis=1, zi=z1)
            y, z2 = lfilter(bh, ah, y, axis=1, zi=z2)
            y = np.concatenate([rem, y], axis=1)
            nb = y.shape[1] // hop
            if nb:
                pows.append((y[:, : nb * hop].reshape(y.shape[0], nb, hop) ** 2).mean(axis=2).sum(axis=0))
            rem = y[:, nb * hop:]
    p = np.concatenate(pows) if pows else np.zeros(0)
    lufs = A._integrated_from_p(p) if len(p) >= 4 else float("-inf")
    m = F.lufs_from_ms(F.windowed(p, 4)) if len(p) >= 4 else np.array([-np.inf])
    m = m[np.isfinite(m)]
    return {"peak_dbfs": round(20 * np.log10(peak + 1e-12), 2), "clipped_samples": clipped,
            "integrated_LUFS": round(float(lufs), 1) if np.isfinite(lufs) else None,
            "active_level_LUFS": round(float(np.percentile(m, 95)), 1) if len(m) else None}


def validate(payload, report):
    """Plain-language validation of a set of files (reference package, comparison mix, or speech set)."""
    import soundfile as sf
    from mi import audio_io as io
    kind = payload.get("kind", "reference")
    files = payload.get("files", [])
    master = payload.get("master")
    findings, per_file = [], []
    allp = ([{"path": master, "group": "master"}] if master else []) + files
    for k, f in enumerate(allp):
        report("Checking files", k / max(len(allp), 1), Path(f["path"]).name)
        rec = {"name": Path(f["path"]).name, "path": f["path"], "group": f.get("group")}
        try:
            i = sf.info(f["path"])
            rec.update({"sr": i.samplerate, "channels": i.channels, "subtype": i.subtype, "duration_s": round(i.frames / i.samplerate, 2),
                        "frames": i.frames})
            rec.update(_stream_stats(f["path"]))
        except Exception as e:
            rec["error"] = f"This file can't be read as audio ({e.__class__.__name__})."
            findings.append({"level": "error", "text": f"{rec['name']}: this file can't be read as audio."})
            per_file.append(rec)
            continue
        if rec["sr"] != 48000:
            findings.append({"level": "warn", "text": f"{rec['name']} is {rec['sr'] / 1000:g} kHz. It will be converted to 48 kHz for "
                                                      "analysis (your file is not changed). Exporting at 48 kHz avoids the conversion."})
        if rec["subtype"] in ("PCM_16", "PCM_U8", "PCM_S8"):
            findings.append({"level": "info", "text": f"{rec['name']} is {rec['subtype'].replace('PCM_', '')}-bit. 24-bit or 32-bit float "
                                                      "is preferred (quiet stems keep more detail)."})
        if rec["clipped_samples"] > 0:
            label = "master" if f.get("group") == "master" else (GROUP_LABEL.get(f.get("group"), f.get("group") or "file") + " stem")
            findings.append({"level": "warn", "text": f"The {label} ({rec['name']}) appears to be clipped: {rec['clipped_samples']} samples "
                                                      "at full scale. Clipping distorts the loudness and peak measurements."})
        if kind == "speech" and rec["channels"] > 1:
            findings.append({"level": "info", "text": f"{rec['name']} has {rec['channels']} channels; it will be mixed to mono. "
                                                      "Supply one mono file per microphone where you can."})
        per_file.append(rec)
    ok = [r for r in per_file if "error" not in r]
    if ok:
        durs = [r["duration_s"] for r in ok]
        if max(durs) - min(durs) > 0.01:
            findings.append({"level": "warn", "text": f"The files differ in length by {max(durs) - min(durs):.2f} s. They must be exported "
                                                      "with identical start and end points; analysis trims to the shortest."})
        rates = {r["sr"] for r in ok}
        if len(rates) > 1:
            findings.append({"level": "warn", "text": f"The files use different sample rates ({', '.join(f'{x / 1000:g} kHz' for x in sorted(rates))})."})
    groups = [f.get("group") for f in files]
    unassigned = [Path(f["path"]).name for f in files if not f.get("group")]
    if unassigned:
        findings.append({"level": "warn", "text": f"No source group assigned for: {', '.join(unassigned)}. These files will be ignored."})
    if kind == "reference" and not files and master:
        findings.append({"level": "info", "text": "Master only (no stems): the programme will be analysed now — spectrum, loudness, "
                                                  "dynamics, transients and stereo. Stems can be attached later for source-level balance."})
    if kind in ("reference", "mix") and files:
        for g in CORE_GROUPS:
            if g not in groups:
                findings.append({"level": "info", "text": f"There is no {GROUP_LABEL[g]} stem. Relationships involving "
                                                          f"{GROUP_LABEL[g]}s can't be learned{' or checked' if kind == 'mix' else ''} from this {kind}."})
        multi = {g: groups.count(g) for g in set(groups) if g and groups.count(g) > 1}
        for g, c in multi.items():
            findings.append({"level": "info", "text": f"{c} files are assigned to {GROUP_LABEL.get(g, g)}; they are summed into one group."})
    recon = None
    align = None
    if master and ok and all(r.get("sr") == ok[0]["sr"] for r in ok) and "error" not in per_file[0]:
        report("Comparing the stems with the master", 0.9, "")
        try:
            recon, align = _recon(master, [f["path"] for f in files if f.get("group")])
        except Exception as e:
            findings.append({"level": "info", "text": f"The stems could not be compared with the master ({e.__class__.__name__})."})
        if align is not None and abs(align) > 1.0:
            findings.append({"level": "error", "text": f"These stems do not appear to begin at the same position as the master "
                                                       f"(about {align:+.1f} ms apart). Re-export them with identical start points."})
        if recon is not None:
            if recon > -15:
                findings.append({"level": "warn", "text": f"The combined stems differ significantly from the {'mastered recording' if kind == 'reference' else 'stereo mix'} "
                                                          f"(reconstruction error {recon:.1f} dB). "
                                                          + ("Possible causes: separation artefacts, a missing stem, or stems that were normalised. "
                                                             "The reference will count less in the profile." if kind == "reference" else
                                                             "The stereo mix probably includes master-bus processing that the stems don't have. "
                                                             "Comparisons use the sum of the stems.")})
            elif recon > -20:
                findings.append({"level": "info", "text": f"The stems add up to the {'master' if kind == 'reference' else 'mix'} reasonably well (reconstruction error {recon:.1f} dB)."})
            elif recon < -60:
                findings.append({"level": "info", "text": f"The stems add up to the {'master' if kind == 'reference' else 'mix'} exactly (reconstruction error {recon:.0f} dB). "
                                                          "Real multitrack stems never sum this perfectly: these were probably made by separation software "
                                                          "that puts the remainder into one stem, or the master was rendered from the stems. This check "
                                                          "therefore says nothing about separation quality (bleed between stems)."})
            else:
                findings.append({"level": "ok", "text": f"The stems add up to the {'master' if kind == 'reference' else 'mix'} well (reconstruction error {recon:.1f} dB)."})
            if kind == "reference":
                findings.append({"level": "info", "text": "Reconstruction error shows whether the stems add up to the master. It does not "
                                                          "prove the separation is clean: bleed between separated stems can still add up perfectly."})
    if kind == "speech" and len(ok) > 1:
        lv = {r["name"]: r.get("active_level_LUFS") for r in ok if r.get("active_level_LUFS") is not None}
        if lv and max(lv.values()) - min(lv.values()) > 10:
            findings.append({"level": "warn", "text": "The microphones are not level-matched (loudest speech moments differ by "
                                                      f"{max(lv.values()) - min(lv.values()):.0f} dB). Gain sharing compares raw levels, so set mic "
                                                      "weights to compensate, or record with matched input gain."})
    status = "error" if any(f["level"] == "error" for f in findings) else ("warn" if any(f["level"] == "warn" for f in findings) else "ok")
    return {"status": status, "files": per_file, "findings": findings, "reconstruction_error_dB": recon, "alignment_ms": align,
            "checked": now()}


def _recon(master, stems, max_s=600):
    import soundfile as sf
    from mi import audio_io as io
    m = sf.read(master, frames=int(30 * sf.info(master).samplerate), dtype="float64", always_2d=True)[0]
    srate = sf.info(master).samplerate
    st = None
    for p in stems:
        x = sf.read(p, frames=len(m), dtype="float64", always_2d=True)[0]
        x = np.column_stack([x[:, 0], x[:, 0]]) if x.shape[1] == 1 else x[:, :2]
        x = np.pad(x, ((0, max(0, len(m) - len(x))), (0, 0)))[: len(m)]
        st = x if st is None else st + x
    mm = np.column_stack([m[:, 0], m[:, 0]]) if m.shape[1] == 1 else m[:, :2]
    align = io.estimate_offset(mm.mean(axis=1), st.mean(axis=1), srate)
    num = den = 0.0
    handles = [sf.SoundFile(master)] + [sf.SoundFile(p) for p in stems]
    try:
        total = 0
        while total < max_s * srate:
            blk = handles[0].read(srate * 10, dtype="float64", always_2d=True)
            if not len(blk):
                break
            blk = np.column_stack([blk[:, 0], blk[:, 0]]) if blk.shape[1] == 1 else blk[:, :2]
            ssum = np.zeros_like(blk)
            for h in handles[1:]:
                x = h.read(len(blk), dtype="float64", always_2d=True)
                x = np.column_stack([x[:, 0], x[:, 0]]) if x.shape[1] == 1 else x[:, :2]
                ssum[: len(x)] += x
            num += float(np.sum((blk - ssum) ** 2))
            den += float(np.sum(blk ** 2))
            total += len(blk)
    finally:
        for h in handles:
            h.close()
    return round(10 * np.log10(num / max(den, 1e-20)), 1), round(align, 2)


# ============================================================================ programme analysis of references
PROGRAM_SUMMARY_KEYS = ["loudness.integrated_LUFS", "loudness.LRA_LU", "loudness.truePeak_dBTP", "loudness.PLR_dB", "dynamics.crest_dB",
                        "spectrum.tilt_dB_per_oct", "stereo.sideToMid_dB", "stereo.correlation", "transients.onsetRate_per_s"]


def ensure_program(ws, ref: dict, force=False) -> dict | None:
    """Programme analysis of a reference's master, cached by fingerprint + algorithm version."""
    from mi.program import analyse_program_file, get_metric
    if not ref.get("master"):
        return None
    fp, algo = ref["master"]["fingerprint"], _algo()
    if not force:
        d = ws.program_analysis(ref["id"], fp, algo)
        if d:
            return d["analysis"]
    a = analyse_program_file(ref["master"]["path"], ref.get("title", ""))
    atomic_write_json(ws.program_path(ref["id"]), {"ref_id": ref["id"], "fingerprint": fp, "algorithm_version": algo, "analysed": now(), "analysis": a})
    summary = {k: get_metric(a["scalars"], k) for k in PROGRAM_SUMMARY_KEYS}
    ws.update("references", ref["id"], {"program": {"status": "analysed", "analysed": now(), "algorithm_version": algo, "summary": summary,
                                                    "warnings": a.get("warnings", [])}})
    return a


def analyse_references(payload, report):
    """Batch programme analysis (master-only or stem-equipped references alike)."""
    ws = Workspace(Path(payload["ws"]))
    ids = payload.get("ids") or [r["id"] for r in ws.items("references")]
    done, failed, skipped = [], [], []
    for k, rid in enumerate(ids):
        try:
            ref = ws.get("references", rid)
        except KeyError:
            continue
        report("Analysing masters", k / max(len(ids), 1), ref.get("title", rid))
        if not ref.get("master"):
            skipped.append({"id": rid, "reason": "no master file"})
            continue
        if not Path(ref["master"]["path"]).is_file():
            skipped.append({"id": rid, "reason": "master file missing (relink it)"})
            continue
        try:
            ensure_program(ws, ref, bool(payload.get("force")))
            done.append(rid)
        except Exception as e:
            failed.append({"id": rid, "error": f"{e.__class__.__name__}: {e}"})
            ws.update("references", rid, {"program": {"status": "failed", "error": str(e)}})
    return {"analysed": done, "failed": failed, "skipped": skipped}


def program_items(ws, ref_ids, weights=None, compute=True, report=None):
    from mi.program import build_program_profile  # noqa: F401  (import check)
    items = []
    for k, rid in enumerate(ref_ids):
        ref = ws.get("references", rid)
        if report:
            report("Analysing masters", 0.05 + 0.4 * k / max(len(ref_ids), 1), ref.get("title", rid))
        a = ensure_program(ws, ref) if compute else (ws.program_analysis(rid) or {}).get("analysis")
        if a:
            w = float((weights or {}).get(rid, ref.get("weight", 1.0)))
            items.append({"id": rid, "title": ref.get("title"), "weight": w, "has_stems": bool(ref.get("stems")), "analysis": a})
    return items


# ============================================================================ profiles
def build_profile(payload, report):
    """Sound Profile from any mix of master-only and stem-equipped references.

    Stem-equipped references feed the source-level profile (unchanged algorithm); every reference
    with a master feeds the Program Sound Profile."""
    from mi.layout import find_references
    from mi.program import build_program_profile
    from mi.reference import PROFILE_SCHEMA, ANALYSER_VERSION, analyse_reference, build_profile as _build, save_profile
    from mi.report import profile_report
    ws = Workspace(Path(payload["ws"]))
    pid = payload["profile_id"]
    pdir = ws.profile_dir(pid)
    meta = read_json(pdir / "meta.json")
    stage = ws.root / ".staging" / pid
    S.clean(stage)
    try:
        weights = meta.get("weights", {})
        refs_all = [ws.get("references", r) for r in meta["reference_ids"]]
        stem_ids = [r["id"] for r in refs_all if r.get("stems")]
        for rid in stem_ids:
            S.stage_reference(ws.get("references", rid), stage, weights.get(rid))
        refs = {r.name: r for r in find_references(stage)} if stem_ids else {}
        analyses = []
        ids = [r for r in stem_ids if r in refs]
        for k, rid in enumerate(ids):
            report("Analysing stems", 0.45 + 0.45 * k / max(len(ids), 1), ws.get("references", rid).get("title", rid))
            m, ga = analyse_reference(refs[rid], meta.get("activity"))
            m["title"] = ws.get("references", rid).get("title", rid)
            analyses.append((m, ga))
        pitems = program_items(ws, [r["id"] for r in refs_all], weights, report=report)
        report("Building the Sound Profile", 0.95, "")
        if analyses:
            prof = _build(analyses, meta["name"])
        else:
            prof = {"schema": PROFILE_SCHEMA, "name": meta["name"], "created": now(),
                    "analysis": {"code": ANALYSER_VERSION, "hop_s": 0.1}, "groups": [], "references": [], "balance": {}, "tonal": {},
                    "dynamics": {}, "program": {}, "settings": {"baselineBlend_beta": 0.5, "minRefsForAssist": 3},
                    "notes": ["Built from stereo masters only: no source-level (stem) intelligence yet. Attach stems to references "
                              "and build a new version to add it."]}
        if pitems:
            prof["program_profile"] = build_program_profile(pitems)
            if not prof.get("program"):
                pp = prof["program_profile"]["metrics"]
                prof["program"] = {k.split(".")[1]: (pp[k]["stats"] or {}).get("median") for k in
                                   ("loudness.integrated_LUFS", "loudness.LRA_LU", "loudness.truePeak_dBTP", "spectrum.tilt_dB_per_oct")}
        if not analyses and not pitems:
            raise ValueError("None of the chosen references has a master or stems that could be analysed.")
        prof["composition"] = {"references": len(refs_all), "with_stems": len(ids), "master_only": sum(1 for r in refs_all if not r.get("stems")),
                               "program_analysed": len(pitems), "source_level": bool(analyses)}
        prof["lab"] = {"profile_id": pid, "reference_ids": meta["reference_ids"], "stem_reference_ids": ids, "weights": weights}
        save_profile(prof, pdir / "profile.json")
        if analyses:
            profile_report(prof, pdir / "profile.md")
        else:
            (pdir / "profile.md").write_text(program_profile_md(prof))
        meta.update({"status": "complete", "finished": now(), "algorithm_version": _algo(), "limitations": limitations(prof),
                     "groups": prof["groups"], "composition": prof["composition"]})
        atomic_write_json(pdir / "meta.json", meta)
        return {"profile_id": pid}
    except Exception:
        meta.update({"status": "failed", "error": traceback.format_exc(limit=4)})
        atomic_write_json(pdir / "meta.json", meta)
        raise
    finally:
        S.clean(stage)


def program_profile_md(prof: dict) -> str:
    pp = prof.get("program_profile")
    L = [f"# Sound Profile: {prof['name']}", "", "Programme-only profile (stereo masters, no stems).", ""]
    if pp:
        L += [f"References analysed: {pp['n_references']}", "", "| Measure | p10 | median | p90 | unit |", "|---|---|---|---|---|"]
        for k, m in pp["metrics"].items():
            s = m["stats"] or {}
            L.append(f"| {m['label']} | {s.get('p10', '–')} | {s.get('median', '–')} | {s.get('p90', '–')} | {m['unit']} |")
        L += [""] + [f"- {n}" for n in pp["notes"]]
    return "\n".join(L) + "\n"


def limitations(prof: dict) -> list:
    """Plain-language limits of a profile, derived only from its contents."""
    out = []
    comp = prof.get("composition") or {}
    if comp and not comp.get("source_level"):
        out.append("No stems yet: this profile describes the finished programme only (spectrum, loudness, dynamics, transients, "
                   "stereo). It cannot guide source balance; attach stems to references and build a new version to add that.")
        out.append("Programme measures include mastering. Comparisons against them are diagnostic evidence, not instructions.")
        n = comp.get("program_analysed", 0)
        if n < 3:
            out.append(f"Only {n} analysed master(s): programme ranges are indicative. Ten or more references give useful ranges.")
        return out
    if comp.get("master_only"):
        out.append(f"{comp['master_only']} of {comp['references']} reference(s) are master-only: they inform the Program Sound "
                   "Profile but not source-level balance.")
    refs = [r for r in prof["references"] if not r["excluded"]]
    if len(refs) == 1:
        out.append("Built from one song: it says nothing about how much these relationships vary between songs. Three or more "
                   "references are recommended.")
    for g in CORE_GROUPS:
        have = sum(1 for r in refs if g in r.get("groups", {}))
        if have < len(refs):
            out.append(f"{GROUP_LABEL[g].capitalize()} is missing from {len(refs) - have} of {len(refs)} reference(s).")
    exact = [r["title"] for r in refs if r["quality"].get("exact_reconstruction")]
    if exact:
        out.append(f"{len(exact)} of {len(refs)} reference(s) have stems that add up to the master exactly ({', '.join(exact)}): probably "
                   "separated stems. Bleed between them cannot be detected; if present it pulls balance targets toward 'more equal'.")
    for r in refs:
        if r["quality"].get("reconErr_dB") is not None and r["quality"]["reconErr_dB"] > -15:
            out.append(f"'{r['title']}': its stems don't add up to the master well; it counts half in the profile.")
    for k, v in prof["balance"].items():
        al = v["byDensity"].get("all", {})
        if al and al.get("n", 0) * 0.1 < 30:
            a, b = k.split("|")
            out.append(f"Only {al['n'] * 0.1:.0f} s of {GROUP_LABEL.get(a, a)} and {GROUP_LABEL.get(b, b)} playing together: weak evidence for that relationship.")
    out.append("Tonal tendencies are not exact EQ targets; live tone is judged against your own approved baseline.")
    out.append("Processed dynamics do not reveal compressor settings (references include mastering).")
    return out


def _algo():
    import mi
    return mi.ALGORITHM_VERSION


# ============================================================================ experiments
def _finish(ws, exp, run_dir, ok, error=None, extra=None):
    edir = ws.exp_dir(exp["id"])
    if ok:
        res = edir / "results"
        if res.exists():
            shutil.rmtree(res)
        run_dir.rename(res)
        exp.update({"status": "complete", "finished": now()})
    else:
        shutil.rmtree(run_dir, ignore_errors=True)
        exp.update({"status": "failed", "finished": now(), "error": error})
    if extra:
        exp.update(extra)
    ws.save_experiment(exp)


def _config_for(exp):
    c = exp.get("config", {})
    cfg = {"controller": {k: c[k] for k in ("beta", "evidence_s", "rate_db_s") if k in c},
           "permissions": {"groupGainOffset": {"allow": True, "min": -abs(float(c.get("max_cut_db", 4.0))),
                                               "max": abs(float(c.get("max_boost_db", 4.0))), "rate_db_s": float(c.get("rate_db_s", 0.5))}}}
    if c.get("exclude_groups"):
        cfg["intelligence"] = {"exclude_groups": list(c["exclude_groups"])}
    if c.get("activity"):
        cfg["activity"] = c["activity"]
    if c.get("speech_level"):
        cfg["permissions"]["speechLevel"] = c["speech_level"]
    return cfg


def run_music(payload, report):
    from mi.compare import compare
    from mi.reference import load_profile
    ws = Workspace(Path(payload["ws"]))
    exp = ws.experiment(payload["exp_id"])
    stage = ws.root / ".staging" / exp["id"]
    run_dir = ws.exp_dir(exp["id"]) / ".run"
    S.clean(stage)
    shutil.rmtree(run_dir, ignore_errors=True)
    try:
        mix = ws.get("mixes", exp["inputs"]["mix_id"])
        report("Preparing", 0.02, "")
        name = S.stage_mix(mix, stage, baseline=exp["config"].get("baseline"), injections=exp.get("injections") or None)
        S.write_config(stage, _config_for(exp))
        prof = load_profile(ws.profile_dir(exp["inputs"]["profile_id"]) / "profile.json")
        from mi.layout import load_config
        stages = iter([("Analysing the mix", 0.15), ("Recommending actions", 0.45), ("Rendering listening files", 0.7), ("Writing the report", 0.9)])
        def log(msg):
            st = next(stages, None)
            if st:
                report(st[0], st[1], str(msg))
        c = exp["config"]
        res, actions = compare(stage, name, prof, load_config(stage), run_dir, render=True,
                               render_experimental=bool(c.get("render_experimental", False)), seed=c.get("seed"),
                               plots=True, log=log, render_groups=bool(c.get("render_groups", True)), blind=False)
        (run_dir / "profile_snapshot.json").write_text(json.dumps(prof))
        _finish(ws, exp, run_dir, True, extra={"algorithm_version": res.get("algorithm_version"),
                                                "summary": _music_summary(res, actions)})
        return {"exp_id": exp["id"]}
    except Exception:
        _finish(ws, exp, run_dir, False, error=traceback.format_exc(limit=6))
        raise
    finally:
        S.clean(stage)


def _music_summary(res, actions):
    kinds = {}
    for a in actions:
        kinds.setdefault(a.kind, {}).setdefault(a.status, 0)
        kinds[a.kind][a.status] += 1
    s = {"pairs_outside": sum(1 for p in res["pairs"] if p["outside"]), "pairs": len(res["pairs"]),
         "events": len(res["events"]), "offset_summary": res["offset_summary"], "actions": kinds,
         "static_offsets_dB": res["static_offsets_dB"]}
    if res.get("injection_score"):
        s["injection_score"] = res["injection_score"]
    return s


def run_speech(payload, report):
    from mi.speech import run_speech as _run
    ws = Workspace(Path(payload["ws"]))
    exp = ws.experiment(payload["exp_id"])
    stage = ws.root / ".staging" / exp["id"]
    run_dir = ws.exp_dir(exp["id"]) / ".run"
    S.clean(stage)
    shutil.rmtree(run_dir, ignore_errors=True)
    try:
        sp = ws.get("speech", exp["inputs"]["speech_id"])
        c = exp["config"]
        for m in sp.get("mics", []):  # per-experiment overrides; the library item is not changed
            nm = m.get("name") or Path(m["file"]["name"]).stem
            if nm in (c.get("mic_weights") or {}):
                m["weight_db"] = float(c["mic_weights"][nm])
            if nm in (c.get("exclude_mics") or []):
                m["role"] = "excluded"
        name = S.stage_speech(sp, stage, {"target_lufs": float(c.get("target_lufs", -20.0)), "last_hold": bool(c.get("last_hold", True)),
                                          "depth_db": float(c.get("depth_db", -40.0))})
        S.write_config(stage, _config_for(exp))
        from mi.layout import load_config
        def log(msg):
            m = str(msg)
            if m.startswith("progress "):
                _, what, frac = m.split()
                report("Analysing microphones" if what == "analysis" else "Rendering listening files",
                       (0.05 + 0.45 * float(frac)) if what == "analysis" else (0.5 + 0.45 * float(frac)), "")
            else:
                report("Preparing", 0.03, m)
        res = _run(stage, name, load_config(stage), run_dir, plots=True, log=log)
        _finish(ws, exp, run_dir, True, extra={"algorithm_version": res.get("algorithm_version"),
                                                "summary": {"mics": res["mics"], "handovers": res["handovers"], "calibration": res["calibration"]}})
        return {"exp_id": exp["id"]}
    except Exception:
        _finish(ws, exp, run_dir, False, error=traceback.format_exc(limit=6))
        raise
    finally:
        S.clean(stage)


def run_study(payload, report):
    from mi import studies
    from mi.reference import load_profile
    ws = Workspace(Path(payload["ws"]))
    exp = ws.experiment(payload["exp_id"])
    stage = ws.root / ".staging" / exp["id"]
    run_dir = ws.exp_dir(exp["id"]) / ".run"
    S.clean(stage)
    shutil.rmtree(run_dir, ignore_errors=True)
    try:
        c = exp["config"]
        study = c["study"]
        report("Preparing", 0.05, study)
        prof_path = None
        if exp["inputs"].get("profile_id"):
            prof_path = ws.profile_dir(exp["inputs"]["profile_id"]) / "profile.json"
        mix_name = None
        if exp["inputs"].get("mix_id"):
            mix_name = S.stage_mix(ws.get("mixes", exp["inputs"]["mix_id"]), stage, baseline=c.get("baseline"),
                                   injections=exp.get("injections") or None)
        for rid in exp["inputs"].get("reference_ids", []):
            ref = ws.get("references", rid)
            if ref.get("stems"):  # studies of source behaviour need stems; master-only references are skipped
                S.stage_reference(ref, stage)
        S.write_config(stage, _config_for(exp))
        run_dir.mkdir(parents=True, exist_ok=True)
        ns = argparse.Namespace(mix=mix_name, profile=str(prof_path) if prof_path else None, inject=None)
        fn = {"activity": studies.activity_study, "beta": studies.beta_study, "response": studies.response_study,
              "generalization": studies.generalization_study, "processing": studies.processing_study,
              "density": studies.density_study}[study]
        report("Running the study", 0.3, "this can take a few minutes")
        res = fn(stage, ns, run_dir)
        (run_dir / "result.json").write_text(json.dumps(res, indent=1, default=float))
        _finish(ws, exp, run_dir, True, extra={"algorithm_version": _algo()})
        return {"exp_id": exp["id"]}
    except SystemExit as e:  # the study functions exit with a plain-language reason
        _finish(ws, exp, run_dir, False, error=str(e))
        raise RuntimeError(str(e))
    except Exception:
        _finish(ws, exp, run_dir, False, error=traceback.format_exc(limit=6))
        raise
    finally:
        S.clean(stage)


# ============================================================================ demo material
def make_demo(payload, report):
    """Synthetic demo material imported into the workspace (clearly labelled as synthetic)."""
    from mi.demo import make
    from mi.layout import find_references, load_mix, audio_files, load_toml
    ws = Workspace(Path(payload["ws"]))
    report("Generating synthetic demo audio", 0.1, "about 30 seconds")
    d = ws.root / "audio" / "demo"
    if d.exists():
        shutil.rmtree(d)
    make(d, dur=90.0)
    report("Importing demo material", 0.8, "")
    for r in find_references(d):
        item = {"title": f"Demo {r.name} (synthetic)", "category": "music", "arrangement": "Full-band worship", "weight": 1.0,
                "include": True, "synthetic": True, "notes": "Synthetic test signal, not music.", "artist": "", "album": ""}
        item = ws.add("references", item)
        stems = [{"file": ws.file_record(str(p), item["id"], copy=False), "group": g} for g in r.stems.groups() for p in r.stems.files[g]]
        ws.update("references", item["id"], {"master": ws.file_record(str(r.master), item["id"], copy=False), "stems": stems})
    mp = load_mix(d / "mixes" / "demo-mix")
    item = ws.add("mixes", {"name": "Demo mix (synthetic)", "notes": "Synthetic. Its settings include two known disturbances to test.",
                            "synthetic": True, "baseline": [[0, 15]], "tacet": mp.meta.get("tacet", [])})
    ws.update("mixes", item["id"], {"stems": [{"file": ws.file_record(str(p), item["id"], copy=False), "group": g}
                                              for g in mp.stems.groups() for p in mp.stems.files[g]],
                                    "raw": [{"file": ws.file_record(str(p), item["id"], copy=False), "group": g}
                                            for g in mp.raw.groups() for p in mp.raw.files[g]] if mp.raw else [],
                                    "suggested_injections": mp.meta.get("inject", [])})
    sp_dir = d / "speech" / "demo-speech"
    item = ws.add("speech", {"name": "Demo speech (synthetic)", "notes": "Three synthetic talkers taking turns.", "synthetic": True})
    ws.update("speech", item["id"], {"mics": [{"file": ws.file_record(str(p), item["id"], copy=False), "name": p.stem, "role": "speech",
                                               "weight_db": 0.0} for p in audio_files(sp_dir / "mics")]})
    # a master-only reference and a stereo "broadcast" recording, for the programme workflows
    from mi import audio_io as io
    report("Creating stereo-only demo material", 0.9, "")
    ra = next(r for r in find_references(d) if r.name == "ref-a")
    gains = {"vocals": 1.4, "drums": 0.8, "bass": 1.0, "guitars": 1.1, "keys": 1.2}
    mix = sum(io.read(p).stereo() * gains.get(g, 1.0) for g in ra.stems.groups() for p in ra.stems.files[g])
    mp_path = io.write(d / "masters" / "Demo Artist - Master Only (synthetic).wav", mix / max(1.0, float(np.max(np.abs(mix))) / 0.89))
    item = ws.add("references", {"title": "Demo master-only (synthetic)", "artist": "", "album": "", "category": "music", "weight": 1.0,
                                 "include": True, "synthetic": True, "notes": "Synthetic stereo master without stems."})
    ws.update("references", item["id"], {"master": ws.file_record(str(mp_path), item["id"], copy=False), "stems": []})
    bg = {"vocals": 0.8, "guitars": 1.6}
    bc = sum(io.read(p).stereo() * bg.get(g, 1.0) for g in mp.stems.groups() for p in mp.stems.files[g])
    bc_path = io.write(d / "broadcast" / "Demo livestream (synthetic).wav", 0.35 * bc / max(1e-9, float(np.max(np.abs(bc)))))
    item = ws.add("recordings", {"name": "Demo livestream (synthetic)", "synthetic": True, "category": "broadcast",
                                 "notes": "Synthetic stereo broadcast mix: vocals lower and guitars louder than the demo references."})
    ws.update("recordings", item["id"], {"mix": ws.file_record(str(bc_path), item["id"], copy=False)})
    report("Analysing the demo masters", 0.95, "")
    analyse_references({"ws": str(ws.root)}, lambda *a: None)
    return {"ok": True}


def run_program(payload, report):
    """Compare a stereo recording with a profile's Program Sound Profile. Diagnostic only: nothing is rendered or processed."""
    import csv
    from mi.program import analyse_program_file, compare_program, DIAGNOSTIC_NOTE
    from mi import RESULT_SCHEMA
    ws = Workspace(Path(payload["ws"]))
    exp = ws.experiment(payload["exp_id"])
    run_dir = ws.exp_dir(exp["id"]) / ".run"
    shutil.rmtree(run_dir, ignore_errors=True)
    run_dir.mkdir(parents=True)
    try:
        rec = ws.get("recordings", exp["inputs"]["recording_id"])
        prof = read_json(ws.profile_dir(exp["inputs"]["profile_id"]) / "profile.json")
        pp = (prof or {}).get("program_profile")
        if not pp:
            raise ValueError("This Sound Profile has no Program Sound Profile (build a new version of it with this Lab version).")
        report("Analysing the recording", 0.1, rec.get("name", ""))
        meas = analyse_program_file(rec["mix"]["path"], rec.get("name", ""))
        report("Comparing with the profile", 0.8, "")
        cmp_ = compare_program(meas, pp, float(exp["config"].get("band_margin_db", 1.5)))
        series = meas.pop("series")
        with open(run_dir / "program_series.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time_s", "shortterm_LUFS", "sideToMid_dB", "programme"])
            for i, (a, b, c) in enumerate(zip(series["shortterm_LUFS"], series["sideToMid_dB"], series["programme"])):
                w.writerow([f"{i * series['hop_s']:.1f}", "" if a is None else a, b, c])
        result = {"schema": RESULT_SCHEMA, "kind": "program-comparison", "algorithm_version": _algo(), "recording": rec.get("name"),
                  "profile": prof.get("name"), "duration_s": meas["duration_s"], "measurement": meas, "comparison": cmp_,
                  "profile_program": pp, "note": DIAGNOSTIC_NOTE, "warnings": meas.get("warnings", [])}
        (run_dir / "analysis.json").write_text(json.dumps(result, indent=1, default=float))
        (run_dir / "decisions.jsonl").write_text("".join(json.dumps({"kind": "programFinding", **f, "maturity": "diagnostic",
                                                                  "status": "diagnostic-only"}) + "\n" for f in cmp_["findings"]))
        L = [f"# Programme comparison: {rec.get('name')}", "", f"Profile: {prof.get('name')} ({pp['n_references']} analysed references)", "",
             f"> {DIAGNOSTIC_NOTE}", "", "## Findings", ""]
        L += [f"- {f['text']}" for f in cmp_["findings"]] or ["- The recording is within the references' typical ranges on every measure."]
        L += ["", "## Measures", "", "| Measure | Recording | Profile p10 | median | p90 | Position |", "|---|---|---|---|---|---|"]
        for r in cmp_["metrics"]:
            s = r["stats"] or {}
            L.append(f"| {r['label']} | {r['value']} {r['unit']} | {s.get('p10', '–')} | {s.get('median', '–')} | {s.get('p90', '–')} | {r['status']} |")
        (run_dir / "report.md").write_text("\n".join(L) + "\n")
        n_out = sum(1 for f in cmp_["findings"])
        _finish(ws, exp, run_dir, True, extra={"algorithm_version": _algo(), "summary": {"findings": n_out, "n_references": pp["n_references"]}})
        return {"exp_id": exp["id"]}
    except Exception:
        _finish(ws, exp, run_dir, False, error=traceback.format_exc(limit=6))
        raise


TASKS = {"validate": validate, "profile": build_profile, "analyse_refs": analyse_references, "program": run_program, "music": run_music, "speech": run_speech, "study": run_study,
         "demo": make_demo}


def entry(kind, payload, q):
    """Child-process entry point."""
    import os
    os.environ.setdefault("MPLBACKEND", "Agg")
    def report(stage, fraction, text=""):
        q.put({"type": "progress", "stage": stage, "fraction": float(fraction), "text": text, "t": time.time()})
    try:
        res = TASKS[kind](payload, report)
        q.put({"type": "done", "result": res})
    except Exception as e:
        q.put({"type": "error", "error": str(e) or e.__class__.__name__, "traceback": traceback.format_exc(limit=8)})
