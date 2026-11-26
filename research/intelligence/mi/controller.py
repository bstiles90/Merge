"""Reference-driven group balance controller (exp02 controller C2, generalised).

  * pairwise, co-active, density-conditioned targets          (algorithms §3, §5.1)
  * target = (1 - beta) * engineer baseline + beta * reference (algorithms §3.3)
  * offset-free source estimates: decisions never see their own offsets (rule R1)
  * dead-zone least squares with an L1 (sparsity) prior        (algorithms §6.1)
  * hysteresis, rate limit, bounds                             (algorithms §11)

Validated on synthetic disturbances (exp02, tests/test_regression.py). On real audio its
behaviour is exactly what `mi compare` / `mi study response` measure.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import features as F
from .analysis import HOP_S, density_class


@dataclass
class ControllerParams:
    beta: float = 0.5               # 0 = keep the engineer's baseline relationships, 1 = reference
    evidence_s: float = 6.0         # robust median window
    decide_hz: float = 2.0
    hysteresis_db: float = 0.5      # re-target only when the new solution differs by more (exp02: 1.0 froze corrections)
    rate_db_s: float = 0.5
    max_db: float = 4.0
    min_db: float = -4.0
    engage_lu: float = 1.5          # engage threshold floor (also >= IQR/3)
    aim: float = 0.8                # once engaged, correct this fraction of the deviation
    lam: float = 0.05               # L1 weight
    min_pair_blocks: int = 50
    min_coverage: float = 0.5       # a group is only judged when active for >= this share of the evidence window
    priority: dict = field(default_factory=lambda: {"vocals": 3.0, "keys": 0.7})

    def prio(self, g):
        return self.priority.get(g, 1.0)


def pair_key(a, b):
    return f"{a}|{b}"


def pair_stats(ga, a, b, mask=None):
    """Median / IQR / count of co-active short-term differences between groups a and b."""
    m = ga.active[a] & ga.active[b] & np.isfinite(ga.st[a]) & np.isfinite(ga.st[b])
    m[:30] = False
    if mask is not None:
        m &= mask
    d = ga.st[a][m] - ga.st[b][m]
    if len(d) < 10:
        return None
    return {"median": float(np.median(d)), "iqr": float(np.percentile(d, 75) - np.percentile(d, 25)),
            "p10": float(np.percentile(d, 10)), "p90": float(np.percentile(d, 90)), "n": int(len(d))}


def build_targets(groups, profile_balance, baseline_ga=None, baseline_mask=None, beta=0.5, min_blocks=100):
    """Per pair and density class: target median and tolerance IQR."""
    targets = {}
    for i, a in enumerate(groups):
        for b in groups[i + 1:]:
            ref = profile_balance.get(pair_key(a, b))
            sign = 1.0
            if ref is None and profile_balance.get(pair_key(b, a)) is not None:
                ref, sign = profile_balance[pair_key(b, a)], -1.0
            base = pair_stats(baseline_ga, a, b, baseline_mask) if baseline_ga is not None else None
            per = {}
            for cls in ("sparse", "medium", "full", "all"):
                r = None
                if ref is not None:
                    r = ref["byDensity"].get(cls)
                    if r is None or r["n"] < min_blocks:
                        r = ref["byDensity"].get("all")
                if r is None and base is None:
                    continue
                ref_med = sign * r["median"] if r is not None else None
                iqr = r["iqr"] if r is not None else (base["iqr"] if base else 3.0)
                if base is not None and ref_med is not None:
                    med = (1 - beta) * base["median"] + beta * ref_med
                elif ref_med is not None:
                    med = ref_med
                else:
                    med = base["median"]
                per[cls] = {"median": med, "iqr": iqr, "ref": ref_med, "baseline": base["median"] if base else None}
            if per:
                targets[(a, b)] = per
    return targets


def solve(groups, L, active, targets, cls, o_cur, P: ControllerParams):
    """Dead-zone LS + L1 over the active groups. Returns (offsets, pair_residuals)."""
    o = o_cur.copy()
    idx = [i for i, g in enumerate(groups) if active[i] and np.isfinite(L[i])]
    pairs = []
    for (a, b), per in targets.items():
        ia, ib = groups.index(a), groups.index(b)
        if ia not in idx or ib not in idx:
            continue
        t = per.get(cls) or per.get("all")
        base = (L[ia] - L[ib]) - t["median"]
        tol = max(P.engage_lu, t["iqr"] / 3)
        pairs.append((ia, ib, base, tol, abs(base) > tol, P.prio(a) * P.prio(b)))
    if len(idx) < 2 or not pairs:
        return o, pairs
    col = {g: j for j, g in enumerate(idx)}
    x = np.zeros(len(idx))
    for _ in range(10):
        rows, rhs, w = [], [], []
        for ia, ib, base, tol, engaged, wt in pairs:
            e = base + x[col[ia]] - x[col[ib]]
            if engaged:
                goal = (1 - P.aim) * base
            elif abs(e) > tol:
                goal = np.sign(e) * tol
            else:
                continue
            r = np.zeros(len(idx))
            r[col[ia]], r[col[ib]] = 1, -1
            rows.append(r)
            rhs.append(goal - base)
            w.append(wt)
        if not rows:
            x[:] = 0
            break
        Wq = np.sqrt(np.array(w))[:, None]
        nx = x.copy()
        for _ in range(20):
            reg = np.sqrt(P.lam / (np.abs(nx) + 0.05))
            Aw = np.vstack([np.array(rows) * Wq, np.diag(reg)])
            bw = np.concatenate([np.array(rhs) * Wq[:, 0], np.zeros(len(idx))])
            nx, *_ = np.linalg.lstsq(Aw, bw, rcond=None)
        nx[np.abs(nx) < 0.25] = 0.0
        if np.allclose(nx, x, atol=1e-3):
            break
        x = nx
    for g, j in col.items():
        o[g] = float(np.clip(x[j], P.min_db, P.max_db))
    return o, pairs


def run(ga, targets, P: ControllerParams, src_p=None):
    """Simulate the controller over a whole mix. Returns offsets [G, NB] and decision events.

    `src_p` (optional) overrides the group powers, e.g. for injected disturbances."""
    groups = ga.groups
    G, NB = len(groups), ga.nb
    p = src_p if src_p is not None else np.stack([ga.p[g] for g in groups])
    st = np.stack([F.short_term(p[i]) for i in range(G)])
    act = np.stack([ga.active[g] for g in groups])
    dens = density_class(act.sum(axis=0), G)
    o = np.zeros(G)
    target = np.zeros(G)
    hist = np.zeros((G, NB))
    events = []
    every = max(1, int(round(1 / (P.decide_hz * HOP_S))))
    W = int(round(P.evidence_s / HOP_S))
    rate = P.rate_db_s * HOP_S
    for k in range(NB):
        if k >= 40 and k % every == 0:
            win = slice(max(0, k - W), k + 1)
            L = np.full(G, -np.inf)
            for i in range(G):
                v = st[i, win][act[i, win] & np.isfinite(st[i, win])]
                if len(v) >= max(5, P.min_coverage * (win.stop - win.start)):
                    L[i] = np.median(v)
            a_now = act[:, k] & np.isfinite(L)
            want, pairs = solve(groups, L, a_now, targets, dens[k], target, P)
            for i in range(G):
                if not a_now[i]:
                    continue  # hold: never boost or cut an inactive source
                if abs(want[i] - target[i]) > P.hysteresis_db or (abs(want[i]) < 0.5 and target[i] != 0):
                    new = want[i] if abs(want[i]) >= 0.5 else 0.0
                    if new != target[i]:
                        impl = [(groups[a], groups[b], round(base, 2)) for a, b, base, tol, eng, wt in pairs if eng and i in (a, b)]
                        events.append({"t": round(k * HOP_S, 1), "group": groups[i], "from": round(float(target[i]), 2),
                                       "to": round(float(new), 2), "density": str(dens[k]), "engaged_pairs": impl})
                        target[i] = new
        o = o + np.clip(target - o, -rate, rate)
        hist[:, k] = o
    return hist, events


def static_solve(ga, targets, P: ControllerParams):
    """One whole-song solve (a 'starting point' recommendation, like a fader-assist pass)."""
    groups = ga.groups
    L = np.array([np.median(ga.st[g][ga.active[g] & np.isfinite(ga.st[g])]) if (ga.active[g] & np.isfinite(ga.st[g])).sum() > 20 else -np.inf for g in groups])
    act = np.isfinite(L)
    Pq = ControllerParams(**{**P.__dict__, "aim": 1.0, "max_db": 6.0, "min_db": -6.0})
    o, pairs = solve(groups, L, act, targets, "all", np.zeros(len(groups)), Pq)
    return o, pairs


def summarise_offsets(hist, groups):
    d = np.diff(hist, axis=1)
    rev = 0
    for i in range(len(groups)):
        nz = d[i][np.abs(d[i]) > 1e-6]
        rev += int(np.sum(np.diff(np.sign(nz)) != 0))
    return {"total_movement_dB": round(float(np.abs(d).sum()), 2), "direction_reversals": rev,
            "max_abs_offset_dB": round(float(np.abs(hist).max()), 2) if hist.size else 0.0,
            "mean_offset_dB": {g: round(float(hist[i].mean()), 2) for i, g in enumerate(groups)}}
