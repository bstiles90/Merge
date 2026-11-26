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

CORE_GROUPS = ["vocals", "drums", "bass", "guitars", "keys"]
GROUP_LABEL = {"vocals": "vocal", "drums": "drum", "bass": "bass", "guitars": "guitar", "keys": "keys & other"}


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
    if kind in ("reference", "mix"):
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


# ============================================================================ profiles
def build_profile(payload, report):
    from mi.layout import find_references
    from mi.reference import analyse_reference, build_profile as _build, save_profile
    from mi.report import profile_report
    ws = Workspace(Path(payload["ws"]))
    pid = payload["profile_id"]
    pdir = ws.profile_dir(pid)
    meta = read_json(pdir / "meta.json")
    stage = ws.root / ".staging" / pid
    S.clean(stage)
    try:
        weights = meta.get("weights", {})
        for rid in meta["reference_ids"]:
            S.stage_reference(ws.get("references", rid), stage, weights.get(rid))
        refs = {r.name: r for r in find_references(stage)}
        analyses = []
        ids = [r for r in meta["reference_ids"] if r in refs]
        for k, rid in enumerate(ids):
            report("Analysing references", k / max(len(ids), 1), ws.get("references", rid).get("title", rid))
            m, ga = analyse_reference(refs[rid], meta.get("activity"))
            m["title"] = ws.get("references", rid).get("title", rid)
            analyses.append((m, ga))
        report("Building the Sound Profile", 0.95, "")
        prof = _build(analyses, meta["name"])
        prof["lab"] = {"profile_id": pid, "reference_ids": ids, "weights": weights}
        save_profile(prof, pdir / "profile.json")
        profile_report(prof, pdir / "profile.md")
        meta.update({"status": "complete", "finished": now(), "algorithm_version": _algo(), "limitations": limitations(prof),
                     "groups": prof["groups"]})
        atomic_write_json(pdir / "meta.json", meta)
        return {"profile_id": pid}
    except Exception:
        meta.update({"status": "failed", "error": traceback.format_exc(limit=4)})
        atomic_write_json(pdir / "meta.json", meta)
        raise
    finally:
        S.clean(stage)


def limitations(prof: dict) -> list:
    """Plain-language limits of a profile, derived only from its contents."""
    out = []
    refs = [r for r in prof["references"] if not r["excluded"]]
    if len(refs) == 1:
        out.append("Built from one song: it says nothing about how much these relationships vary between songs. Three or more "
                   "references are recommended.")
    for g in ["vocals", "drums", "bass", "guitars", "keys"]:
        have = sum(1 for r in refs if g in r.get("groups", {}))
        if have < len(refs):
            out.append(f"{GROUP_LABEL[g].capitalize()} is missing from {len(refs) - have} of {len(refs)} reference(s).")
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
            S.stage_reference(ws.get("references", rid), stage)
        S.write_config(stage, _config_for(exp))
        run_dir.mkdir(parents=True, exist_ok=True)
        ns = argparse.Namespace(mix=mix_name, profile=str(prof_path) if prof_path else None, inject=None)
        fn = {"activity": studies.activity_study, "beta": studies.beta_study, "response": studies.response_study,
              "generalization": studies.generalization_study, "processing": studies.processing_study}[study]
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
    return {"ok": True}


TASKS = {"validate": validate, "profile": build_profile, "music": run_music, "speech": run_speech, "study": run_study,
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
