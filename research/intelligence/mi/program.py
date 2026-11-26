"""Program (stereo master) analysis and the Program Sound Profile.

Works on a finished stereo recording alone - a mastered reference without stems, or a stereo
broadcast/livestream recording - so references can be collected before stems exist.

What a stereo programme can and cannot tell (see MERGE_INTELLIGENCE_LAB.md §10):
it describes the *result* (spectral balance, loudness, dynamics, transients, stereo image and
how they evolve). It cannot say which source caused a difference, so every comparison against
a Program Sound Profile is *diagnostic evidence*, never a source diagnosis or a processing
instruction. Source-level intelligence still comes from stems (reference.py).

Reused measurements: BS.1770 block power, integrated loudness, LRA, true peak, momentary
spread, crest (analysis.py / features.py); tonal shape with loudness weights (exp03).
New measurements (documented in the research doc, §Program analysis): third-octave spectral
shape and its time variation, per-band side/mid ratio, inter-channel correlation, mono-downmix
loudness change, block crest and onset density (spectral flux) as transient descriptors.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt, stft

from . import analysis as A
from . import features as F
from . import audio_io as io

PROGRAM_SCHEMA = "merge.program-analysis/1"
PROGRAM_PROFILE_SCHEMA = "merge.program-profile/1"
THIRD_EDGES = F.band_edges(35.5, 17800, 3)                  # 27 third-octave bands, ~40 Hz .. 16 kHz
THIRD_CENTRES = np.sqrt(THIRD_EDGES[:-1] * THIRD_EDGES[1:])
CURVE_POINTS = 50                                            # time-varying curves: 2 % of the recording per point
NFFT = 8192
GATE_LU = 20.0                                               # programme regions: short-term within 20 LU of integrated

# metric key -> (label, unit, domain, explanation). Keys are paths into the "scalars" dict.
METRICS = {
    "loudness.integrated_LUFS": ("Integrated loudness", "LUFS", "loudness", "Average loudness of the whole recording (BS.1770)."),
    "loudness.LRA_LU": ("Loudness range", "LU", "loudness", "Spread of short-term loudness (EBU Tech 3342): small = steady, large = varied."),
    "loudness.shortterm_p95_LUFS": ("Loud passages (short-term p95)", "LUFS", "loudness", "How loud the loudest 5 % of the recording is."),
    "loudness.truePeak_dBTP": ("True peak", "dBTP", "loudness", "Highest inter-sample peak."),
    "loudness.PLR_dB": ("Peak-to-loudness ratio", "dB", "dynamics", "True peak minus integrated loudness. Low values indicate heavy limiting."),
    "dynamics.crest_dB": ("Crest factor", "dB", "dynamics", "Peak to RMS over 3 s windows (median)."),
    "dynamics.momentarySpread_LU": ("Momentary loudness spread", "LU", "dynamics", "Momentary loudness p95 minus p10 during programme."),
    "dynamics.shortTermSpread_LU": ("Short-term loudness spread", "LU", "dynamics", "Short-term loudness p95 minus p10 during programme."),
    "transients.blockCrest_p50_dB": ("Block crest (typical)", "dB", "transients", "Peak to RMS within 100 ms blocks, median: punch of everyday material."),
    "transients.blockCrest_p90_dB": ("Block crest (strong hits)", "dB", "transients", "Peak to RMS within 100 ms blocks, 90th percentile: the sharpest transients."),
    "transients.hfBlockCrest_p50_dB": ("High-frequency block crest", "dB", "transients", "Block crest above 2 kHz: attack definition (sticks, picks, consonants)."),
    "transients.onsetRate_per_s": ("Onset density", "/s", "transients", "Detected note/hit onsets per second (spectral flux)."),
    "spectrum.tilt_dB_per_oct": ("Spectral tilt", "dB/oct", "spectrum", "Slope of the spectral shape: more negative = darker."),
    "spectrum.low_vs_mid_dB": ("Low end vs mids", "dB", "spectrum", "Energy 40-160 Hz relative to 400 Hz-1.6 kHz (shape)."),
    "spectrum.high_vs_mid_dB": ("Highs vs mids", "dB", "spectrum", "Energy 4-16 kHz relative to 400 Hz-1.6 kHz (shape)."),
    "stereo.sideToMid_dB": ("Stereo width (side/mid)", "dB", "stereo", "Side energy relative to mid energy: higher = wider."),
    "stereo.correlation": ("Inter-channel correlation", "", "stereo", "1 = mono, 0 = unrelated channels, negative = out of phase."),
    "stereo.correlation_p10": ("Correlation, widest moments", "", "stereo", "10th percentile of block correlation."),
    "stereo.balance_dB": ("Left/right balance", "dB", "stereo", "Left minus right energy."),
    "stereo.monoLoss_LU": ("Mono downmix change", "LU", "stereo", "Loudness change when summed to mono; strongly negative = phase cancellation."),
}


# Smallest difference reported as a finding, beyond the references' range: below these, differences are within
# measurement repeatability or too small to matter (loudness ~1 LU, tonal balance ~1-1.5 dB, tilt 0.3 dB/oct).
TOLERANCE = {"loudness.integrated_LUFS": 1.0, "loudness.LRA_LU": 1.0, "loudness.shortterm_p95_LUFS": 1.0, "loudness.truePeak_dBTP": 1.0,
             "loudness.PLR_dB": 1.0, "dynamics.crest_dB": 1.0, "dynamics.momentarySpread_LU": 1.0, "dynamics.shortTermSpread_LU": 1.0,
             "transients.blockCrest_p50_dB": 0.5, "transients.blockCrest_p90_dB": 0.75, "transients.hfBlockCrest_p50_dB": 1.0,
             "transients.onsetRate_per_s": 0.5, "spectrum.tilt_dB_per_oct": 0.3, "spectrum.low_vs_mid_dB": 1.5,
             "spectrum.high_vs_mid_dB": 1.5, "stereo.sideToMid_dB": 1.5, "stereo.correlation": 0.05, "stereo.correlation_p10": 0.1,
             "stereo.balance_dB": 0.5, "stereo.monoLoss_LU": 0.5}


def _q(v, qs=(10, 50, 90)):
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    return [round(float(np.percentile(v, q)), 2) for q in qs] if len(v) else [None] * len(qs)


def _bands(P, f, edges):
    return np.array([P[(f >= a) & (f < b)].sum(axis=0) for a, b in zip(edges[:-1], edges[1:])]).T  # frames x bands


def _shape_rows(db):
    """Tonal shape per row (loudness-weighted level removed), as in exp03."""
    out = np.empty_like(db)
    for i, row in enumerate(db):
        out[i] = A.tonal_shape(row)
    return out


ONSET_NFFT, ONSET_HOP = 1024, 512                          # ~10.7 ms hop at 48 kHz
ONSET_EDGES = F.band_edges(80.0, 16000, 6)


def _flux(mono, sr):
    """Half-wave-rectified log-band spectral flux, computed in 30 s chunks (bounded memory)."""
    out = []
    chunk = 30 * sr
    prev = None
    for a in range(0, len(mono), chunk):
        seg = mono[max(0, a - ONSET_NFFT): a + chunk]
        f, _, Z = stft(seg, fs=sr, nperseg=ONSET_NFFT, noverlap=ONSET_NFFT - ONSET_HOP, boundary=None, padded=False)
        B = np.log10(_bands(np.abs(Z) ** 2, f, ONSET_EDGES) + 1e-10).T          # bands x frames
        if a > 0:
            B = B[:, ONSET_NFFT // ONSET_HOP:]                                     # drop the overlap
        if prev is not None and B.shape[1]:
            B = np.concatenate([prev, B], axis=1)
            out.append(np.maximum(np.diff(B, axis=1), 0).mean(axis=0))
        elif B.shape[1] > 1:
            out.append(np.maximum(np.diff(B, axis=1), 0).mean(axis=0))
        prev = B[:, -1:] if B.shape[1] else prev
    return np.concatenate(out) if out else np.zeros(0)


def _onsets(mono, sr):
    """Onset times (s): flux peaks above a moving-median threshold, at least 50 ms apart."""
    from scipy.ndimage import median_filter
    flux = _flux(mono, sr)
    if len(flux) < 16:
        return np.zeros(0)
    hop_s = ONSET_HOP / sr
    med = median_filter(flux, size=max(3, int(round(0.4 / hop_s))) | 1, mode="nearest")
    thr = med + 0.5 * np.std(flux)
    peaks = np.flatnonzero((flux > thr) & (flux >= np.roll(flux, 1)) & (flux >= np.roll(flux, -1)))
    keep, last = [], -10 ** 9
    gap = int(round(0.05 / hop_s))
    for i in peaks:
        if i - last >= gap:
            keep.append(i)
            last = i
    return (np.array(keep, float) + 1) * hop_s


def _curve(values, mask, n=CURVE_POINTS, how="median"):
    """Resample a block series to n points of normalised time (median of programme blocks per segment)."""
    out = []
    L = len(values)
    for k in range(n):
        a, b = int(k * L / n), max(int((k + 1) * L / n), int(k * L / n) + 1)
        v = values[a:b][mask[a:b]] if mask is not None else values[a:b]
        v = v[np.isfinite(v)]
        out.append(round(float(np.median(v) if how == "median" else np.mean(v)), 2) if len(v) else None)
    return out


def analyse_program(x: np.ndarray, sr: int = io.PROJECT_SR, title: str = "") -> dict:
    """Measure a stereo programme (channels x samples, float, 48 kHz). Mono input is treated as dual mono."""
    x = np.atleast_2d(np.asarray(x, float))
    if x.shape[0] == 1:
        x = np.vstack([x[0], x[0]])
    x = x[:2]
    L, R = x[0], x[1]
    p, peak, ms = A.block_stats(x, sr)
    nb = len(p)
    if nb < 40:
        raise ValueError("recording too short for programme analysis (needs at least 4 s)")
    I = A._integrated_from_p(p)
    st = F.lufs_from_ms(F.windowed(p, 30))
    st[:29] = np.nan
    gate = np.isfinite(st) & (st > I - GATE_LU)
    if gate.sum() < 10:
        gate = np.isfinite(st)
    mom = F.lufs_from_ms(F.windowed(p, 4))
    tp = A.true_peak_dbtp(x, sr)
    hop = int(round(sr * A.HOP_S))

    # ---- loudness & dynamics (reused measurements)
    stq = _q(st[gate], (10, 50, 90, 95))
    loudness = {"integrated_LUFS": round(I, 2), "LRA_LU": round(A.lra(p), 2), "truePeak_dBTP": round(tp, 2),
                "samplePeak_dBFS": round(20 * np.log10(float(np.max(np.abs(x))) + 1e-12), 2),
                "shortterm_p10_LUFS": stq[0], "shortterm_p50_LUFS": stq[1], "shortterm_p90_LUFS": stq[2], "shortterm_p95_LUFS": stq[3],
                "momentary_max_LUFS": round(float(np.nanmax(mom)), 2), "PLR_dB": round(tp - I, 2)}
    dynamics = {"crest_dB": round(A.crest_db(peak, ms, gate), 2), "momentarySpread_LU": round(A.momentary_spread(p, gate), 2),
                "shortTermSpread_LU": round(float(stq[3] - stq[0]), 2) if stq[0] is not None else None}

    # ---- transients
    ch_ms = ms / x.shape[0]
    bcrest = 20 * np.log10(peak / np.sqrt(np.maximum(ch_ms, 1e-20)) + 1e-12)
    sos = butter(4, 2000, "highpass", fs=sr, output="sos")
    hx = sosfilt(sos, x, axis=1)
    _, hpk, hms = A.block_stats(hx, sr)
    hcrest = 20 * np.log10(hpk[:nb] / np.sqrt(np.maximum(hms[:nb] / 2, 1e-20)) + 1e-12)

    # ---- spectrum (third octaves of the mid signal) and per-band stereo
    M, S = 0.5 * (L + R), 0.5 * (L - R)
    f, t, ZM = stft(M, fs=sr, nperseg=NFFT, noverlap=NFFT // 2, boundary=None, padded=False)
    _, _, ZS = stft(S, fs=sr, nperseg=NFFT, noverlap=NFFT // 2, boundary=None, padded=False)
    PM, PS = np.abs(ZM) ** 2, np.abs(ZS) ** 2
    fgate = A.frames_active(t, gate)
    bM = 10 * np.log10(_bands(PM, f, THIRD_EDGES) + 1e-20)
    shape = A.tonal_shape(A.band_mean(t, bM, mask_times=fgate))
    frame_shapes = _shape_rows(bM[fgate]) if fgate.sum() >= 5 else _shape_rows(bM)
    var_lo, var_hi = np.percentile(frame_shapes, 10, axis=0), np.percentile(frame_shapes, 90, axis=0)
    lf = np.log2(THIRD_CENTRES)
    tilt = float(np.polyfit(lf, shape, 1)[0])
    band = lambda lo, hi: float(np.mean(shape[(THIRD_CENTRES >= lo) & (THIRD_CENTRES <= hi)]))
    spectrum = {"band_centres_hz": [round(float(c)) for c in THIRD_CENTRES], "shape_dB": np.round(shape, 2).tolist(),
                "variation_p10_dB": np.round(var_lo, 2).tolist(), "variation_p90_dB": np.round(var_hi, 2).tolist(),
                "tilt_dB_per_oct": round(tilt, 2), "low_vs_mid_dB": round(band(40, 160) - band(400, 1600), 2),
                "high_vs_mid_dB": round(band(4000, 16000) - band(400, 1600), 2)}
    oM = _bands(PM[:, fgate] if fgate.sum() >= 5 else PM, f, A.BAND_EDGES).mean(axis=0)
    oS = _bands(PS[:, fgate] if fgate.sum() >= 5 else PS, f, A.BAND_EDGES).mean(axis=0)
    side_mid_band = 10 * np.log10((oS + 1e-20) / (oM + 1e-20))

    # ---- stereo
    Lb, Rb = L[: nb * hop].reshape(nb, hop), R[: nb * hop].reshape(nb, hop)
    eL, eR, eLR = (Lb ** 2).sum(1), (Rb ** 2).sum(1), (Lb * Rb).sum(1)
    corr_b = eLR / np.sqrt(np.maximum(eL * eR, 1e-30))
    g = gate & (eL + eR > 1e-12)
    corr = float(eLR[g].sum() / np.sqrt(max(eL[g].sum() * eR[g].sum(), 1e-30))) if g.any() else float("nan")
    pm = F.block_power(np.vstack([M, M]), sr)
    mono_I = A._integrated_from_p(pm)
    sm_b = 10 * np.log10(((Lb - Rb) ** 2).sum(1) + 1e-20) - 10 * np.log10(((Lb + Rb) ** 2).sum(1) + 1e-20)
    stereo = {"sideToMid_dB": round(10 * np.log10(max(A.stereo_width(x), 1e-10)), 2), "correlation": round(corr, 3),
              "correlation_p10": _q(corr_b[g], (10,))[0], "balance_dB": round(10 * np.log10((eL[g].sum() + 1e-20) / (eR[g].sum() + 1e-20)), 2) if g.any() else 0.0,
              "monoLoss_LU": round(mono_I - I, 2),
              "sideToMid_band_dB": {"band_centres_hz": [round(float(c)) for c in A.BAND_CENTRES], "values": np.round(side_mid_band, 2).tolist()}}

    # ---- onsets
    on_t = _onsets(M, sr)
    prog_s = float(gate.sum() * A.HOP_S)
    on_in = int(np.sum(A.frames_active(on_t, gate))) if len(on_t) else 0
    transients = {"blockCrest_p50_dB": _q(bcrest[g], (50,))[0], "blockCrest_p90_dB": _q(bcrest[g], (90,))[0],
                  "hfBlockCrest_p50_dB": _q(hcrest[g], (50,))[0], "onsetRate_per_s": round(on_in / max(prog_s, 1e-9), 2)}

    # ---- time-varying behaviour (normalised time)
    tilt_t = np.full(len(t), np.nan)
    for i in range(len(t)):
        tilt_t[i] = np.polyfit(lf, A.tonal_shape(bM[i]), 1)[0]
    blk_tilt = np.interp(np.arange(nb) * A.HOP_S, t, tilt_t)
    curves = {"points": CURVE_POINTS, "shortterm_rel_LU": _curve(st - I, gate), "tilt_dB_per_oct": _curve(blk_tilt, gate),
              "sideToMid_dB": _curve(sm_b, gate), "blockCrest_dB": _curve(bcrest, gate)}
    series = {"hop_s": A.HOP_S, "shortterm_LUFS": [None if not np.isfinite(v) else round(float(v), 2) for v in st],
              "sideToMid_dB": [round(float(v), 2) for v in sm_b], "programme": gate.astype(int).tolist()}

    scalars = {"loudness": loudness, "dynamics": dynamics, "transients": transients,
               "spectrum": {k: spectrum[k] for k in ("tilt_dB_per_oct", "low_vs_mid_dB", "high_vs_mid_dB")},
               "stereo": {k: v for k, v in stereo.items() if not isinstance(v, dict)}}
    return {"schema": PROGRAM_SCHEMA, "title": title, "duration_s": round(x.shape[1] / sr, 2), "programme_s": round(prog_s, 1),
            "scalars": scalars, "spectrum": spectrum, "stereo_bands": stereo["sideToMid_band_dB"], "curves": curves, "series": series,
            "onsets_s": [round(float(v), 3) for v in on_t[:20000]]}


def analyse_program_file(path, title: str = "") -> dict:
    a = io.read(path)
    out = analyse_program(a.data, a.sr, title)
    out["warnings"] = a.warnings
    out["file"] = {"name": str(path).replace("\\", "/").split("/")[-1], "original_sr": a.original_sr, "subtype": a.subtype,
                   "channels": int(sf_channels(path))}
    return out


def sf_channels(path):
    import soundfile as sf
    return sf.info(str(path)).channels


def get_metric(scalars: dict, key: str):
    d, _, k = key.partition(".")
    return (scalars.get(d) or {}).get(k)


# --------------------------------------------------------------------------- the Program Sound Profile
def _wq(values, weights, q):
    from .reference import _wq as wq
    return wq(values, weights, q)


def _stats(vals, ws):
    pairs = [(float(v), float(w)) for v, w in zip(vals, ws) if v is not None and np.isfinite(v) and w > 0]
    if not pairs:
        return None
    v, w = zip(*pairs)
    out = {q: round(_wq(v, w, p), 3) for q, p in (("p10", 0.1), ("p25", 0.25), ("median", 0.5), ("p75", 0.75), ("p90", 0.9))}
    out.update({"min": round(min(v), 3), "max": round(max(v), 3), "n": len(v)})
    return out


def _vec_stats(rows, ws):
    rows = [(r, w) for r, w in zip(rows, ws) if r is not None and all(x is not None for x in r) and w > 0]
    if not rows:
        return None
    R = np.array([r for r, _ in rows], float)
    W = [w for _, w in rows]
    out = {q: [round(_wq(R[:, j], W, p), 2) for j in range(R.shape[1])] for q, p in (("p10", 0.1), ("p25", 0.25), ("median", 0.5), ("p75", 0.75), ("p90", 0.9))}
    out["min"], out["max"] = np.round(R.min(0), 2).tolist(), np.round(R.max(0), 2).tolist()
    out["n"] = len(rows)
    return out


def build_program_profile(items: list) -> dict:
    """items: [{"id", "title", "weight", "analysis": analyse_program(...) result}]. Weighted quantiles across references."""
    use = [it for it in items if it.get("analysis") and it.get("weight", 1.0) > 0]
    if not use:
        raise ValueError("no analysed stereo references")
    ws = [float(it.get("weight", 1.0)) for it in use]
    scal = {k: _stats([get_metric(it["analysis"]["scalars"], k) for it in use], ws) for k in METRICS}
    curve_keys = ("shortterm_rel_LU", "tilt_dB_per_oct", "sideToMid_dB", "blockCrest_dB")
    curves = {}
    for k in curve_keys:
        rows = [it["analysis"]["curves"][k] for it in use]
        # a curve point may be None (silence); fill from neighbours so references stay comparable
        filled = []
        for r in rows:
            a = np.array([np.nan if v is None else v for v in r], float)
            if np.isfinite(a).sum() >= 2:
                idx = np.arange(len(a))
                a = np.interp(idx, idx[np.isfinite(a)], a[np.isfinite(a)])
                filled.append(a.tolist())
            else:
                filled.append(None)
        curves[k] = _vec_stats(filled, ws)
    return {"schema": PROGRAM_PROFILE_SCHEMA, "n_references": len(use),
            "metrics": {k: {"label": METRICS[k][0], "unit": METRICS[k][1], "domain": METRICS[k][2], "explanation": METRICS[k][3], "stats": scal[k]} for k in METRICS},
            "spectrum": {"band_centres_hz": use[0]["analysis"]["spectrum"]["band_centres_hz"],
                         "shape_dB": _vec_stats([it["analysis"]["spectrum"]["shape_dB"] for it in use], ws),
                         "within_reference_variation": {
                             "p10": _vec_stats([it["analysis"]["spectrum"]["variation_p10_dB"] for it in use], ws)["median"],
                             "p90": _vec_stats([it["analysis"]["spectrum"]["variation_p90_dB"] for it in use], ws)["median"]}},
            "stereo_bands": {"band_centres_hz": use[0]["analysis"]["stereo_bands"]["band_centres_hz"],
                             "sideToMid_dB": _vec_stats([it["analysis"]["stereo_bands"]["values"] for it in use], ws)},
            "curves": curves,
            "references": [{"id": it["id"], "title": it.get("title"), "weight": it.get("weight", 1.0), "has_stems": bool(it.get("has_stems")),
                            "duration_s": it["analysis"]["duration_s"], "scalars": it["analysis"]["scalars"],
                            "spectrum_shape": it["analysis"]["spectrum"]["shape_dB"],
                            "variation_p10": it["analysis"]["spectrum"]["variation_p10_dB"], "variation_p90": it["analysis"]["spectrum"]["variation_p90_dB"],
                            "stereo_bands": it["analysis"]["stereo_bands"]["values"], "curves": it["analysis"]["curves"]} for it in use],
            "notes": ["Program measures describe finished masters, including mastering. They are context and diagnostic "
                      "evidence; they do not identify which source causes a difference.",
                      "Ranges are weighted percentiles across references (p10-p90 = typical range)."
                      + (" Fewer than 3 references: ranges are indicative only." if len(use) < 3 else "")]}


# --------------------------------------------------------------------------- comparison (diagnostic only)
DIAGNOSTIC_NOTE = ("Stereo-only comparison: these findings describe the finished programme. They cannot identify which "
                   "source or channel causes a difference and are not processing instructions. Confirm by listening; "
                   "source-level conclusions need stems.")
EXPECTED_DIFFERENCES = {"loudness.integrated_LUFS": "Commercial masters are normally louder than broadcast or livestream mixes; "
                                                    "a lower level here is expected and not by itself a problem.",
                        "loudness.shortterm_p95_LUFS": "Absolute loudness follows the delivery target, not the mix balance.",
                        "loudness.truePeak_dBTP": "Peak level follows the delivery chain (limiter, platform)."}


def _status(v, s, few, tol=0.0):
    """within: inside the typical range (or within `tol` of it); edge: beyond it but inside the references' extremes
    (+tol); outside: beyond every reference by more than tol. Deviation is measured from the typical range."""
    if v is None or s is None:
        return "unknown", None
    lo, hi = (s["min"], s["max"]) if few else (s["p10"], s["p90"])
    dev = v - hi if v > hi else (v - lo if v < lo else 0.0)
    if abs(dev) <= tol:
        return "within", dev
    if not few and s["min"] - tol <= v <= s["max"] + tol:
        return "edge", dev
    return "outside", dev


def compare_program(meas: dict, profile: dict, band_margin_db: float = 1.5) -> dict:
    """Place a stereo recording within the Program Sound Profile. Returns per-metric positions and diagnostic findings."""
    few = profile["n_references"] < 3
    rows, findings = [], []
    for k, m in profile["metrics"].items():
        v = get_metric(meas["scalars"], k)
        s = m["stats"]
        stt, dev = _status(v, s, few, TOLERANCE.get(k, 0.0))
        rows.append({"metric": k, "label": m["label"], "unit": m["unit"], "domain": m["domain"], "value": v, "stats": s, "status": stt,
                     "tolerance": TOLERANCE.get(k, 0.0),
                     "deviation": None if dev is None else round(dev, 2), "explanation": METRICS[k][3],
                     "expected_difference": EXPECTED_DIFFERENCES.get(k)})
        if stt in ("outside", "edge") and k not in EXPECTED_DIFFERENCES:
            word = "above" if dev > 0 else "below"
            rng = f"{s['min']}..{s['max']}" if few else f"{s['p10']}..{s['p90']}"
            findings.append({"id": f"metric:{k}", "domain": m["domain"], "metric": k, "label": m["label"], "severity": stt,
                             "range": [s["min"], s["max"]] if few else [s["p10"], s["p90"]],
                             "value": v, "deviation": round(dev, 2),
                             "text": f"{m['label']} is {abs(dev):.2f} {m['unit']} {word} the references' {'range' if few else 'typical range'} "
                                     f"({rng} {m['unit']}); measured {v} {m['unit']}."})
    # spectral bands: contiguous runs outside the typical shape range
    sp = profile["spectrum"]["shape_dB"]
    shape = meas["spectrum"]["shape_dB"]
    centres = profile["spectrum"]["band_centres_hz"]
    lo, hi = (sp["min"], sp["max"]) if few else (sp["p10"], sp["p90"])
    devs = []
    for j, v in enumerate(shape):
        # flagged only beyond range + margin; the reported deviation is measured from the range itself
        d = v - hi[j] if v > hi[j] + band_margin_db else (v - lo[j] if v < lo[j] - band_margin_db else 0.0)
        devs.append(round(d, 2))
    j = 0
    while j < len(devs):
        if devs[j] == 0:
            j += 1
            continue
        sign = np.sign(devs[j])
        k = j
        while k + 1 < len(devs) and np.sign(devs[k + 1]) == sign and devs[k + 1] != 0:
            k += 1
        seg = devs[j:k + 1]
        peak = max(seg, key=abs)
        f0, f1 = centres[j], centres[k]
        fr = (lambda x: (f"{x / 1000:.1f}".rstrip("0").rstrip(".") + " kHz") if x >= 1000 else f"{round(x)} Hz")
        findings.append({"id": f"spectrum:{f0}-{f1}", "domain": "spectrum", "metric": "spectrum.shape", "label": f"Spectral balance {fr(f0)}–{fr(f1)}",
                         "severity": "outside" if abs(peak) >= 2 * band_margin_db else "edge", "value": None, "deviation": peak, "band_hz": [f0, f1],
                         "text": f"{'More' if sign > 0 else 'Less'} energy around {fr(f0)}{'' if f0 == f1 else '–' + fr(f1)} than the references "
                                 f"(up to {abs(peak):.1f} dB {'above' if sign > 0 else 'below'} their {'range' if few else 'typical range'}, "
                                 f"relative to the overall level)."})
        j = k + 1
    return {"schema": "merge.program-comparison/1", "few_references": few, "n_references": profile["n_references"],
            "metrics": rows, "spectrum_deviation_dB": devs, "findings": findings, "note": DIAGNOSTIC_NOTE}
