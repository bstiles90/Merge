"""Experiment 02: reference-driven group balance under controlled disturbances.

Compares three controllers on synthetic five-group material with KNOWN injected
disturbances (the 'controlled level disturbance' tests of the vision, section 23.1):

  A  mix-relative integrator   r_g = L_g - L_mix, integrate (target - r_g) on the
                               measured (post-offset) signal. The textbook loop.
  B  pairwise integrator       same loop, but on pairwise co-active differences.
  C  pairwise feed-forward     (proposed) estimate the SOURCE state by removing the
                               offsets Intelligence itself applied, solve a small
                               regularised least-squares problem for the offsets
                               that would put the co-active pairwise differences
                               inside the reference tolerance band, then apply them
                               through deadband + hysteresis + rate limit + bounds.

Timeline (seconds)            disturbance (dB, at the source)      ideal response
  0- 20  clean                -                                    nothing
 20- 40  guitars too loud     guitars +3                           guitars -3
 40- 60  vocal too quiet      vocals -3                            vocals +3 (or band -)
 60- 80  whole band builds    all +3                               nothing (musical lift)
 80-100  keys stop playing    keys silent                          nothing (no boost)
100-120  back to clean        -                                    offsets back to 0

Measurement model: piecewise-constant gain per 100 ms block, so the post-offset
K-weighted block power is exactly src_power * 10^(o/10) (no audio re-render needed).
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from mi import features as F
from mi import synth as S

FS = S.FS
G = S.GROUPS
NG = len(G)
DUR = 120.0
NB = int(DUR / F.HOP_S)
BASE_GAIN_DB = {"vocals": -10.0, "drums": -9.0, "bass": -8.0, "guitars": -15.0, "keys": -13.0}  # engineer's mix
HYST_DB = 0.5
PRIORITY = {"vocals": 3.0, "drums": 1.0, "bass": 1.0, "guitars": 1.0, "keys": 0.7}


def block_powers(stems):
    return np.stack([F.block_power(stems[g], FS)[:NB] for g in G])  # (NG, NB)


# ---------------------------------------------------------------- reference profile
def build_profile(ref_p):
    """Pairwise co-active short-term loudness differences: median + IQR per pair."""
    mix = ref_p.sum(axis=0)
    act = np.stack([F.activity(ref_p[i], mix) for i in range(NG)])
    st = np.stack([F.short_term(ref_p[i]) for i in range(NG)])
    prof = {}
    for a in range(NG):
        for b in range(a + 1, NG):
            m = act[a] & act[b] & np.isfinite(st[a]) & np.isfinite(st[b])
            m[:30] = False
            d = st[a, m] - st[b, m]
            prof[(a, b)] = (float(np.median(d)), float(np.percentile(d, 75) - np.percentile(d, 25)), int(m.sum()))
    return prof


# ---------------------------------------------------------------- disturbances
def disturbance_db():
    d = np.zeros((NG, NB))
    t = np.arange(NB) * F.HOP_S
    d[G.index("guitars"), (t >= 20) & (t < 40)] += 3
    d[G.index("vocals"), (t >= 40) & (t < 60)] -= 3
    d[:, (t >= 60) & (t < 80)] += 3
    d[G.index("keys"), (t >= 80) & (t < 100)] = -200  # stops playing
    return d


# ---------------------------------------------------------------- solver (controller C)
def solve_offsets(Lsrc, active, prof, o_cur, lam=0.05, max_db=4.0, mode="edge", l1=True):
    """min sum_w (Lsrc_a+o_a - Lsrc_b-o_b - target_ab)^2 + lam*|o|^2 over co-active pairs.
    Residuals inside +-max(1 dB, IQR/2) count as zero (tolerance band, not a point target).
    Inactive groups keep their current offset (they are not in any equation)."""
    # Dead-zone (hinge) least squares, solved by a few active-set iterations:
    #   loss_ab(e) = 0 inside the tolerance band, (|e| - tol)^2 outside   ("edge")
    #   pairs found outside the engage band are pulled to 0.8 x the median ("median")
    # Pairs inside the band impose NOTHING unless the correction pushes them out,
    # so fixing one group does not get dragged back by the pairs that were fine.
    o = o_cur.copy()
    act_idx = [i for i in range(NG) if active[i]]
    pairs = []
    for (a, b), (med, iqr, n) in prof.items():
        if active[a] and active[b] and n >= 50 and np.isfinite(Lsrc[a]) and np.isfinite(Lsrc[b]):
            base = (Lsrc[a] - Lsrc[b]) - med
            tol = max(1.0, iqr / 2) if mode == "edge" else max(1.5, iqr / 3)
            engaged = mode == "median" and abs(base) > tol
            pairs.append((a, b, base, tol, engaged, PRIORITY[G[a]] * PRIORITY[G[b]]))
    if len(act_idx) < 2 or not pairs:
        return o
    col = {g: j for j, g in enumerate(act_idx)}
    x = np.zeros(len(act_idx))
    for _ in range(10):
        rows, rhs, w = [], [], []
        for a, b, base, tol, engaged, wt in pairs:
            e = base + x[col[a]] - x[col[b]]
            if engaged:
                goal = 0.2 * base  # leave 20 % of the deviation: conservative
            elif abs(e) > tol:
                goal = np.sign(e) * tol
            else:
                continue
            r = np.zeros(len(act_idx))
            r[col[a]], r[col[b]] = 1, -1
            rows.append(r)
            rhs.append(goal - base)
            w.append(wt)
        if not rows:
            x[:] = 0
            break
        Wq = np.sqrt(np.array(w))[:, None]
        # Sparsity prior (L1, via iteratively reweighted ridge): explain the deviation with
        # as FEW moved controls as possible - "the source that changed is the one to fix" -
        # instead of the min-norm solution that nudges every fader a little.
        nx = x.copy()
        for _ in range(20):
            reg = np.sqrt(lam / (np.abs(nx) + 0.05)) if l1 else np.full(len(act_idx), np.sqrt(lam))
            Aw = np.vstack([np.array(rows) * Wq, np.diag(reg)])
            bw = np.concatenate([np.array(rhs) * Wq[:, 0], np.zeros(len(act_idx))])
            nx, *_ = np.linalg.lstsq(Aw, bw, rcond=None)
            if not l1:
                break
        nx[np.abs(nx) < 0.25] = 0.0
        if np.allclose(nx, x, atol=1e-3):
            break
        x = nx
    o[act_idx] = np.clip(x, -max_db, max_db)
    return o


def run(controller, src_p, prof, decide_every=5, evidence_blocks=60, mode="edge", l1=True):
    o = np.zeros(NG)  # applied offsets (dB)
    target = np.zeros(NG)
    held = np.zeros(NG, bool)
    hist_o = np.zeros((NG, NB))
    post_p = np.zeros_like(src_p)
    rate = 0.5 * F.HOP_S  # dB per block (0.5 dB/s)
    integ = np.zeros(NG)
    for k in range(NB):
        post_p[:, k] = src_p[:, k] * 10 ** (o / 10)
        if k >= 40 and k % decide_every == 0:
            lo = max(0, k - 30)
            win = slice(max(0, k - evidence_blocks), k + 1)
            mix = post_p[:, : k + 1].sum(axis=0)
            act = np.array([F.activity(post_p[i, : k + 1], mix)[-1] for i in range(NG)])
            # short-term (3 s) loudness of each group, measured post-offset
            Lpost = np.array([F.lufs_from_ms(post_p[i, lo : k + 1].mean()) for i in range(NG)])
            if controller == "C":
                # robust source estimate: median over the evidence window of per-block ST loudness
                # with Intelligence's own (known) offsets removed -> it never chases itself
                Lsrc = np.array([
                    np.median(F.short_term(src_p[i, : k + 1])[win][np.isfinite(F.short_term(src_p[i, : k + 1])[win])])
                    if np.isfinite(Lpost[i]) else -np.inf for i in range(NG)
                ])
                want = solve_offsets(Lsrc, act, prof, target, mode=mode, l1=l1)
                # hysteresis: re-target only when the new solution differs by more than HYST_DB
                for i in range(NG):
                    if not act[i]:
                        continue  # hold: never boost (or cut) an inactive source
                    if abs(want[i] - target[i]) > HYST_DB or (abs(want[i]) < 0.5 and abs(target[i]) > 0):
                        target[i] = want[i] if abs(want[i]) >= 0.5 else 0.0
            elif controller in ("A", "B"):
                ki = 0.25  # dB per decision per LU of error (~1.25 dB/s/LU at 2 Hz)
                if controller == "A":
                    Lmix = F.lufs_from_ms(mix[lo:].mean())
                    for i in range(NG):
                        if np.isfinite(Lpost[i]):
                            # target: reference median of L_g - L_mix ... approximated from pairwise
                            err = (Lpost[i] - Lmix) - REF_MIXREL[i]
                            integ[i] -= ki * err
                else:
                    for i in range(NG):
                        if not act[i]:
                            continue
                        errs = []
                        for (a, b), (med, iqr, n) in prof.items():
                            if i in (a, b) and act[a] and act[b]:
                                e = (Lpost[a] - Lpost[b]) - med
                                errs.append(e if i == a else -e)
                        if errs:
                            integ[i] -= ki * np.mean(errs) / 2
                target = np.clip(integ, -4, 4)
        # rate-limited execution layer
        o = o + np.clip(target - o, -rate, rate)
        hist_o[:, k] = o
    return hist_o, post_p


def summarise(hist_o):
    t = np.arange(NB) * F.HOP_S
    seg = {"clean_0_20": (10, 20), "guitars+3_20_40": (32, 40), "vocals-3_40_60": (52, 60),
           "band+3_60_80": (72, 80), "keys_off_80_100": (92, 100), "clean_100_120": (112, 120)}
    res = {}
    for name, (a, b) in seg.items():
        m = (t >= a) & (t < b)
        res[name] = {g: round(float(hist_o[i, m].mean()), 2) for i, g in enumerate(G)}
    d = np.diff(hist_o, axis=1)
    res["total_movement_dB"] = round(float(np.abs(d).sum()), 1)
    res["direction_reversals"] = int(sum(np.sum(np.diff(np.sign(d[i][np.abs(d[i]) > 1e-6])) != 0) for i in range(NG)))
    res["max_abs_offset_dB"] = round(float(np.abs(hist_o).max()), 2)
    return res


if __name__ == "__main__":
    ref = S.make_groups(DUR, seed=10)
    ref_stems = {g: ref[g] * S.db(BASE_GAIN_DB[g]) for g in G}
    ref_p = block_powers(ref_stems)
    prof = build_profile(ref_p)
    # mix-relative reference targets for controller A
    mixp = ref_p.sum(axis=0)
    REF_MIXREL = []
    for i in range(NG):
        act = F.activity(ref_p[i], mixp)
        act[:30] = False
        REF_MIXREL.append(float(np.median((F.short_term(ref_p[i]) - F.short_term(mixp))[act])))

    live = S.make_groups(DUR, seed=11)  # a different 'performance'
    live_p = block_powers({g: live[g] * S.db(BASE_GAIN_DB[g]) for g in G})
    src_p = live_p * 10 ** (disturbance_db() / 10)

    out = {"profile_pairwise_median_iqr": {f"{G[a]}-{G[b]}": [round(m, 2), round(q, 2)] for (a, b), (m, q, n) in prof.items()}}
    for c, mode, name in [("A", "edge", "A_mixrelative_integrator"), ("B", "edge", "B_pairwise_integrator"),
                          ("C", "edge", "C1_pairwise_feedforward_band_edge"), ("C", "median", "C2_pairwise_feedforward_to_median"),
                          ("C", "median-ridge", "C3_to_median_ridge_prior_instead_of_L1")]:
        h, _ = run(c, src_p, prof, mode=mode.split("-")[0], l1=not mode.endswith("ridge"))
        out[name] = summarise(h)
    Path(__file__).parent.joinpath("results").mkdir(exist_ok=True)
    Path(__file__).parent.joinpath("results/exp02.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))
