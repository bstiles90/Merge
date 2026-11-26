"""Offline Speech Intelligence prototype (strategy architecture §4.3, algorithms §15.1/15.3).

    mi speech <workspace> <name>

Layer A (activity): gain sharing  A_i = sqrt(env(w_i x_i)^2 / env(sum_j w_j x_j)^2), as claimed in
                    US 3,992,584 (expired), with optional last-mic hold and a depth floor.
Layer O (level):    layered speech leveller. Each mic's loudness is measured BEFORE the automix
                    (rule R1); the leveller only acts while a mic holds the floor = automix share
                    > -6 dB AND the activity gate passes (rule R2, exp05 D).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import analysis as A
from . import audio_io as io
from . import features as F
from . import render as R
from .actions import ControlAction, permissions_from_config, validate, write_jsonl
from .layout import audio_files, load_toml

CTRL_HZ = 1000  # gain-sharing control rate


def ar_smooth(v: np.ndarray, attack_ms: float, release_ms: float, rate: float) -> np.ndarray:
    aa = np.exp(-1 / (attack_ms * 1e-3 * rate))
    ar = np.exp(-1 / (release_ms * 1e-3 * rate))
    y = np.empty_like(v)
    s = float(v[0]) if len(v) else 0.0
    for i, x in enumerate(v.tolist()):
        a = aa if x > s else ar
        s = a * s + (1 - a) * x
        y[i] = s
    return y


def control_power(x: np.ndarray, sr: int) -> np.ndarray:
    h = sr // CTRL_HZ
    n = len(x) // h
    return (x[: n * h].reshape(n, h) ** 2).mean(axis=1)


def gain_share(mics: list, sr: int, weights_db=None, attack_ms=10.0, release_ms=150.0, depth_db=-40.0,
               last_hold=True, hold_db=-3.0, hold_s=0.5):
    """Returns per-mic gains at CTRL_HZ (linear) and the 'share' (gain before last-hold)."""
    n_m = len(mics)
    w = np.ones(n_m) if weights_db is None else 10 ** (np.asarray(weights_db, float) / 20)
    side = [w[i] * mics[i] for i in range(n_m)]
    e = np.stack([ar_smooth(control_power(s, sr), attack_ms, release_ms, CTRL_HZ) for s in side])
    eref = ar_smooth(control_power(sum(side), sr), attack_ms, release_ms, CTRL_HZ)
    share = np.sqrt(np.maximum(e, 1e-24) / np.maximum(eref, 1e-24))
    share = np.clip(share, 10 ** (depth_db / 20), 1.0)
    g = share.copy()
    if last_hold and n_m > 1:
        thr = 10 ** (hold_db / 20)
        need = int(hold_s * CTRL_HZ)
        holder, run_m, run_n = -1, -1, 0
        top = np.argmax(share, axis=0)
        above = share[top, np.arange(share.shape[1])] > thr
        for k in range(share.shape[1]):
            if above[k]:
                if top[k] == run_m:
                    run_n += 1
                else:
                    run_m, run_n = top[k], 1
                if run_n >= need:
                    holder = run_m
            elif holder >= 0:
                g[holder, k] = 1.0  # nobody has the floor: keep the last talker's mic open
    return g, share


def to_samples(g_ctrl: np.ndarray, n: int, sr: int) -> np.ndarray:
    h = sr // CTRL_HZ
    return np.interp(np.arange(n), (np.arange(len(g_ctrl)) + 0.5) * h, g_ctrl)


def leveller(p_pre, floor, target_lufs, evidence_s=6.0, rate_db_s=1.0, hyst_db=1.0, lo=-6.0, hi=6.0):
    """Per-mic level offset (dB per 100 ms block), updated at 2 Hz, only while holding the floor."""
    nb = len(p_pre)
    st = F.short_term(p_pre)
    W = int(evidence_s / A.HOP_S)
    o, tgt = 0.0, 0.0
    out = np.zeros(nb)
    for k in range(nb):
        if k >= 30 and k % 5 == 0 and floor[k]:
            v = st[max(0, k - W):k + 1][floor[max(0, k - W):k + 1] & np.isfinite(st[max(0, k - W):k + 1])]
            if len(v) >= 10:
                want = float(np.clip(target_lufs - np.median(v), lo, hi))
                if abs(want - tgt) > hyst_db:
                    tgt = want
        o += float(np.clip(tgt - o, -rate_db_s * A.HOP_S, rate_db_s * A.HOP_S))
        out[k] = o
    return out


def run_speech(workspace: Path, name: str, cfg: dict, out_dir: Path, seed=None, plots=True, log=print):
    folder = workspace / "speech" / name
    meta = load_toml(folder / "speech.toml")
    sr = io.PROJECT_SR
    files = audio_files(folder / "mics" if (folder / "mics").is_dir() else folder)
    excluded = set(meta.get("exclude", []))
    files = [p for p in files if p.stem not in excluded]
    if len(files) < 1:
        raise ValueError(f"speech '{name}': no mic files in {folder}/mics")
    auds = {p.stem: io.read(p, sr) for p in files}
    _, warns = io.align_lengths(auds)
    for a in auds.values():
        warns += a.warnings
    names = list(auds)
    mono = [auds[k].mono() for k in names]
    n = min(len(m) for m in mono)
    mono = [m[:n] for m in mono]
    weights = [float(meta.get("weights", {}).get(k, 0.0)) for k in names]
    perm = permissions_from_config(cfg)
    depth = float(meta.get("depth_db", perm["speechAutomix"].get("depth_db", -40.0)))
    target = float(meta.get("target_lufs", -20.0))
    log(f"speech: {len(names)} mics, {n / sr:.0f} s, target {target} LUFS")

    g_ctrl, share_ctrl = gain_share(mono, sr, weights, depth_db=depth, last_hold=bool(meta.get("last_hold", True)))
    # 100 ms block views
    per_blk = int(A.HOP_S * CTRL_HZ)
    nb = min(len(F.block_power(m, sr)) for m in mono)
    share_blk = np.stack([20 * np.log10(np.maximum(share_ctrl[i][: nb * per_blk].reshape(nb, per_blk).mean(axis=1), 1e-9)) for i in range(len(names))])
    p_pre = np.stack([F.block_power(m, sr)[:nb] for m in mono])
    p_prog = p_pre.sum(axis=0)
    act = np.stack([A.activity(p_pre[i], p_prog, A.activity_params("speech", cfg.get("activity"))) for i in range(len(names))])
    floor = (share_blk > -6.0) & act
    lev = np.stack([leveller(p_pre[i], floor[i], target, lo=perm["speechLevel"]["min"], hi=perm["speechLevel"]["max"],
                             rate_db_s=perm["speechLevel"].get("rate_db_s", 1.0)) for i in range(len(names))])

    gs = [to_samples(g_ctrl[i], n, sr) for i in range(len(names))]
    lv = [R.block_gain_to_samples(lev[i], n, sr) for i in range(len(names))]
    st2 = lambda v: np.vstack([v, v])
    before = st2(sum(mono))
    after_am = st2(sum(gs[i] * mono[i] for i in range(len(names))))
    after = st2(sum(gs[i] * lv[i] * mono[i] for i in range(len(names))))

    nobody = ~floor.any(axis=0)
    nobody[:30] = False
    def blk_db(x):
        pb = F.block_power(x, sr)[:nb]
        return round(float(10 * np.log10(np.mean(pb[nobody]) + 1e-20)), 1) if nobody.any() else float("nan")
    holder = np.where(floor.any(axis=0), np.argmax(np.where(floor, share_blk, -999), axis=0), -1)
    h = holder[holder >= 0]
    handovers = int(np.sum(h[1:] != h[:-1])) if len(h) > 1 else 0

    mics, actions = [], []
    for i, k in enumerate(names):
        talking = floor[i]
        spl = None
        if talking.sum() >= 20:
            st = F.short_term(p_pre[i])[talking]
            st = st[np.isfinite(st)]
            spl = round(float(np.median(st)), 1) if len(st) else None
        lev_db = round(float(np.median(lev[i][talking])), 1) if talking.sum() >= 20 else None
        mics.append({"name": k, "weight_db": weights[i], "floor_s": round(float(talking.sum() * A.HOP_S), 1),
                     "share_talking_db": round(float(np.median(share_blk[i][talking])), 1) if talking.any() else float("nan"),
                     "share_idle_db": round(float(np.median(share_blk[i][~talking])), 1) if (~talking).any() else float("nan"),
                     "speech_LUFS": spl, "leveller_db": lev_db})
        actions.append(validate(ControlAction("speechAutomix", {"mic": k}, weights[i], unit="dB weight", specialist="speech",
                                              reason={"text": f"gain sharing member; holds the floor {talking.sum() * A.HOP_S:.0f} s"},
                                              confidence=0.9), perm))
        if lev_db is not None and abs(lev_db) >= 0.5:
            lo, hi = perm["speechLevel"]["min"], perm["speechLevel"]["max"]
            sat = lev_db <= lo + 0.05 or lev_db >= hi - 0.05
            txt = f"talker on {k} measures {spl} LUFS pre-automix vs target {target}"
            if sat:
                txt += (f"; SATURATED at the {lo:+.0f}/{hi:+.0f} dB bound - fix the gain staging (input gain or "
                        "fader) rather than relying on Intelligence")
            actions.append(validate(ControlAction("speechLevel", {"mic": k}, lev_db, specialist="speech",
                                                  reason={"text": txt, "saturated": sat}, confidence=0.8), perm))
    out_dir.mkdir(parents=True, exist_ok=True)
    render = R.write_listening_set(out_dir / "audio", {"before": before, "after_automix": after_am, "after": after}, sr, seed=seed)
    res = {"name": name, "duration_s": round(n / sr, 1), "target_LUFS": target, "mics": mics, "warnings": warns,
           "idle_noise_before_db": blk_db(before), "idle_noise_after_db": blk_db(after_am), "handovers": handovers,
           "render": render, "actions": [a.summary() for a in actions]}
    figs = []
    try:
        from .report import plt
        if plt is not None and plots:
            t = np.arange(nb) * A.HOP_S
            fig, ax = plt.subplots(2, 1, figsize=(12, 5.5), sharex=True)
            for i, k in enumerate(names):
                ax[0].plot(t, share_blk[i], lw=0.8, label=k)
                ax[1].plot(t, np.where(floor[i], lev[i], np.nan), lw=1.4, label=k)
            ax[0].set_ylabel("automix share (dB)")
            ax[0].set_ylim(depth - 2, 2)
            ax[1].set_ylabel("leveller offset (dB), while holding floor")
            ax[1].set_xlabel("time (s)")
            ax[0].legend(fontsize=7, ncol=6)
            fig.tight_layout()
            fig.savefig(out_dir / "speech.png", dpi=110)
            plt.close(fig)
            figs.append("speech.png")
    except Exception as e:  # plots are optional
        warns.append(f"plot failed: {e}")
    (out_dir / "analysis.json").write_text(json.dumps(res, indent=1, default=float))
    write_jsonl(actions, out_dir / "decisions.jsonl")
    from .report import speech_report
    speech_report(res, out_dir, figs)
    return res
