"""Reference analysis and Sound Profile generation (MERGE_INTELLIGENCE.md §7, algorithms §3)."""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
from pathlib import Path

import numpy as np

from . import analysis as A
from . import audio_io as io
from . import features as F
from .controller import pair_key
from .layout import GROUPS, ReferencePackage

PROFILE_SCHEMA = "merge.sound-profile/1"
ANALYSER_VERSION = "mi-prototype 0.5"


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def load_group_signals(stemset, sr=io.PROJECT_SR):
    """Read and sum the files of each group. Returns (signals: group->stereo array, warnings)."""
    sig, warns = {}, []
    loaded = {}
    for g in stemset.groups():
        for p in stemset.files[g]:
            loaded[str(p)] = io.read(p, sr)
    _, notes = io.align_lengths(loaded)
    warns += notes
    for a in loaded.values():
        warns += a.warnings
    for g in stemset.groups():
        sig[g] = sum(loaded[str(p)].stereo() for p in stemset.files[g])
    return sig, warns


def analyse_reference(pkg: ReferencePackage, activity_overrides=None) -> tuple[dict, A.GroupAnalysis]:
    sr = io.PROJECT_SR
    signals, warns = load_group_signals(pkg.stems, sr)
    if not signals:
        raise ValueError(f"reference '{pkg.name}': no stems recognised in {pkg.folder} (see the audio spec for file names)")
    master = io.read(pkg.master, sr) if pkg.master else None
    n = min(s.shape[1] for s in signals.values())
    quality = {"flags": []}
    if master is not None:
        warns += master.warnings
        n = min(n, master.samples)
        stem_sum = sum(s[:, :n] for s in signals.values())
        off = io.estimate_offset(master.mono()[:n], stem_sum.mean(axis=0))
        quality["alignment_ms"] = round(off, 2)
        if abs(off) > 1.0:
            quality["flags"].append(f"stems are offset {off:.1f} ms from the master; re-export with identical start points")
        err = master.stereo()[:, :n] - stem_sum
        recon = 10 * np.log10(np.sum(err ** 2) / max(np.sum(master.stereo()[:, :n] ** 2), 1e-20))
        quality["reconErr_dB"] = round(float(recon), 1)
        if recon > -15:
            quality["flags"].append("stems do not reconstruct the master well (> -15 dB error): separation artefacts, "
                                    "missing stems or individually normalised stems")
        elif recon < -60:
            quality["exact_reconstruction"] = True
            quality["flags"].append("stems add up to the master exactly (< -60 dB error): typical of separation tools that put the "
                                    "remainder into one stem, or of a master rendered from the stems. Reconstruction cannot judge "
                                    "separation quality (bleed) for this reference.")
    else:
        quality["flags"].append("no master.wav: program measures are taken from the sum of the stems")
    signals = {g: s[:, :n] for g, s in signals.items()}
    prog = master.stereo()[:, :n] if master is not None else None
    ga = A.analyse_groups(signals, sr, program=prog, activity_overrides=activity_overrides)
    prog_sig = prog if prog is not None else sum(signals.values())
    p_prog = ga.p_prog
    program = {
        "integrated_LUFS": round(A._integrated_from_p(p_prog), 2),
        "LRA_LU": round(A.lra(p_prog), 2),
        "truePeak_dBTP": round(A.true_peak_dbtp(prog_sig, sr), 2),
        "width": round(A.stereo_width(prog_sig), 3),
    }
    tb = A.band_frames(prog_sig, sr)
    pshape = A.tonal_shape(A.band_mean(*tb))
    program["tilt_dB_per_oct"] = round(float(np.polyfit(np.log2(A.BAND_CENTRES), pshape, 1)[0]), 2)
    meta = {
        "id": pkg.name, "title": pkg.meta.get("title", pkg.name), "kind": pkg.meta.get("kind", "music"),
        "weight": float(pkg.meta.get("weight", 1.0)), "excluded": bool(pkg.meta.get("exclude", False)),
        "duration_s": round(n / sr, 1),
        "files": {"master": {"name": pkg.master.name, "sha256": file_hash(pkg.master)} if pkg.master else None,
                  "stems": [{"group": g, "name": p.name, "sha256": file_hash(p)} for g in pkg.stems.groups() for p in pkg.stems.files[g]],
                  "unmapped": [p.name for p in pkg.stems.unmapped]},
        "quality": quality, "program": program, "groups": ga.to_summary(), "warnings": warns,
    }
    return meta, ga


def quality_weight(meta: dict) -> float:
    w = meta["weight"]
    r = meta["quality"].get("reconErr_dB")
    if r is not None and r > -15:
        w *= 0.5  # down-weight poorly reconstructing references (algorithms §3.1)
    return w


def _wq(values, weights, q):
    """Weighted quantile."""
    v, w = np.asarray(values), np.asarray(weights)
    o = np.argsort(v)
    v, w = v[o], w[o]
    c = np.cumsum(w) - 0.5 * w
    return float(np.interp(q * w.sum(), c, v))


def target_reliability(per_ref_data, n_boot: int = 400, seed: int = 0) -> dict:
    """How well the references pin down a pair's target: measured statistics only (no heuristic score).

    - refMedians: each reference's own median difference and co-active seconds
    - betweenRefSD: sample SD (n-1) of the reference medians
    - targetCI80: 10th-90th percentile of the pooled target when the references themselves are resampled
      (bootstrap over songs: how much the target would move with a different set of songs)
    - independentWindows: co-active time / 3 s (short-term windows overlap, so blocks are not independent)
    """
    if not per_ref_data:
        return {}
    meds = [float(np.median(d)) for _, d, _ in per_ref_data]
    secs = [round(len(d) * A.HOP_S, 1) for _, d, _ in per_ref_data]
    out = {"nRefs": len(per_ref_data),
           "refMedians": [{"id": i, "median_LU": round(mv, 2), "coactive_s": s} for (i, _, _), mv, s in zip(per_ref_data, meds, secs)],
           "betweenRefSD": round(float(np.std(meds, ddof=1)), 2) if len(meds) > 1 else None,
           "refRange_LU": [round(min(meds), 2), round(max(meds), 2)],
           "independentWindows": int(sum(secs) / 3.0)}
    if len(per_ref_data) >= 3:
        rng = np.random.default_rng(seed)
        sub = []
        for _, d, w in per_ref_data:  # subsample long arrays: the bootstrap is over songs, not blocks
            k = max(1, len(d) // 400)
            sub.append((d[::k], w[::k] * k))
        boots = []
        for _ in range(n_boot):
            pick = rng.integers(0, len(sub), len(sub))
            v = np.concatenate([sub[i][0] for i in pick])
            ww = np.concatenate([sub[i][1] for i in pick])
            boots.append(_wq(v, ww, 0.5))
        lo, hi = np.percentile(boots, [10, 90])
        out["targetCI80"] = [round(float(lo), 2), round(float(hi), 2)]
        out["targetCI80_width"] = round(float(hi - lo), 2)
    else:
        out["note"] = "fewer than 3 references with this pair: no interval"
    return out


def build_profile(analyses: list, name: str = "Sound Profile") -> dict:
    """Aggregate per-reference analyses [(meta, GroupAnalysis)] into a Sound Profile."""
    use = [(m, ga) for m, ga in analyses if not m["excluded"]]
    if not use:
        raise ValueError("no usable references (all excluded)")
    groups = [g for g in GROUPS if any(g in ga.groups for _, ga in use)]
    groups += sorted({g for _, ga in use for g in ga.groups} - set(groups))
    balance = {}
    for i, a in enumerate(groups):
        for b in groups[i + 1:]:
            pools = {c: ([], []) for c in ("sparse", "medium", "full", "all")}
            per_ref, per_ref_data = [], []
            for m, ga in use:
                if a not in ga.groups or b not in ga.groups:
                    continue
                act = ga.active[a] & ga.active[b] & np.isfinite(ga.st[a]) & np.isfinite(ga.st[b])
                act[:30] = False
                if act.sum() < 10:
                    continue
                d = ga.st[a][act] - ga.st[b][act]
                # down-weight blocks where one stem is likely residual bleed (> 25 LU below the other).
                # Since 0.5.0 each reference contributes equally whatever its length (block weights / block count):
                # before, a 10-minute song counted twice as much as a 5-minute one.
                wblk = np.where(np.abs(d) > 25, 0.2, 1.0) * quality_weight(m) / len(d)
                cls = A.density_class(ga.density, len(ga.groups))[act]
                for c in ("sparse", "medium", "full"):
                    sel = cls == c
                    pools[c][0].extend(d[sel]); pools[c][1].extend(wblk[sel])
                pools["all"][0].extend(d); pools["all"][1].extend(wblk)
                per_ref.append(float(np.median(d)))
                per_ref_data.append((m["id"], d, wblk))
            if not pools["all"][0]:
                continue
            byd = {}
            for c, (v, w) in pools.items():
                if len(v) < 10:
                    continue
                byd[c] = {"median": round(_wq(v, w, 0.5), 2), "p10": round(_wq(v, w, 0.1), 2), "p25": round(_wq(v, w, 0.25), 2),
                          "p75": round(_wq(v, w, 0.75), 2), "p90": round(_wq(v, w, 0.9), 2), "n": len(v)}
                byd[c]["iqr"] = round(max(byd[c]["p75"] - byd[c]["p25"], 0.0), 2)
            sd = float(np.std(per_ref)) if len(per_ref) > 1 else None
            conf = min(1.0, len(per_ref) / 3) * (float(np.exp(-sd / 3)) if sd is not None else 0.6)
            balance[pair_key(a, b)] = {"byDensity": byd, "nRefs": len(per_ref),
                                       "betweenRefSD": round(sd, 2) if sd is not None else None, "confidence": round(conf, 2),
                                       "reliability": target_reliability(per_ref_data)}
    tonal, dynamics = {}, {}
    for g in groups:
        shapes, spreads, crests = [], [], []
        for m, ga in use:
            if g not in ga.groups:
                continue
            mask = A.frames_active(ga.band_t, ga.active[g])
            e = A.band_mean(ga.band_t, ga.bands[g], mask_times=mask)
            if np.all(np.isfinite(e)):
                shapes.append(A.tonal_shape(e))
            spreads.append(A.momentary_spread(ga.p[g], ga.active[g]))
            crests.append(A.crest_db(ga.peak[g], ga.ms[g], ga.active[g]))
        if shapes:
            S = np.array(shapes)
            tonal[g] = {"band_centres_hz": [round(float(c)) for c in A.BAND_CENTRES],
                        "shape_dB": {"median": np.round(np.median(S, 0), 2).tolist(),
                                     "iqr": np.round(np.percentile(S, 75, 0) - np.percentile(S, 25, 0), 2).tolist()},
                        "nRefs": len(shapes), "use": "tendency (wide tolerance; tone is anchored to the engineer's baseline)"}
        sp = [s for s in spreads if np.isfinite(s)]
        cr = [c for c in crests if np.isfinite(c)]
        dynamics[g] = {"momentarySpread_LU": {"median": round(float(np.median(sp)), 2) if sp else None,
                                              "spread": round(float(np.ptp(sp)), 2) if len(sp) > 1 else None},
                       "crest_dB": {"median": round(float(np.median(cr)), 2) if cr else None},
                       "includesMastering": True}
    progs = [m["program"] for m, _ in use]
    return {
        "schema": PROFILE_SCHEMA, "name": name, "created": _dt.datetime.now().isoformat(timespec="seconds"),
        "analysis": {"code": ANALYSER_VERSION, "hop_s": A.HOP_S, "bands": "octave 63 Hz - 16 kHz",
                     "activity": A.ACTIVITY_DEFAULTS},
        "groups": groups,
        "references": [{k: m[k] for k in ("id", "title", "kind", "weight", "excluded", "duration_s", "files", "quality", "program", "groups")}
                       for m, _ in analyses],
        "balance": balance, "tonal": tonal, "dynamics": dynamics,
        "program": {k: round(float(np.median([p[k] for p in progs if np.isfinite(p[k])])), 2) for k in progs[0]},
        "settings": {"baselineBlend_beta": 0.5, "minRefsForAssist": 3},
        "notes": ["Pairwise co-active short-term loudness differences are invariant to mastering loudness.",
                  "Tonal and dynamics entries are tendencies, not targets (exp03, exp04).",
                  "Compressor settings cannot be recovered from mastered references (exp04)."],
    }


def save_profile(profile: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile, indent=1, default=float))


def load_profile(path: Path) -> dict:
    p = json.loads(Path(path).read_text())
    if p.get("schema") != PROFILE_SCHEMA:
        raise ValueError(f"{path}: not a {PROFILE_SCHEMA} file")
    return p
