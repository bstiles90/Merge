"""Compare two experiments (typically the same material on two algorithm versions).

Only measured numbers and recorded feedback are compared. A newer version is never assumed
to be better.
"""

from __future__ import annotations

from . import feedback as FB
from .store import read_json


def metrics(ws, eid) -> dict:
    exp = ws.experiment(eid)
    d = ws.exp_dir(eid) / "results"
    a = read_json(d / "analysis.json", {}) or {}
    fb = FB.load(ws.exp_dir(eid))
    ls = FB.listening(ws.exp_dir(eid))
    m = {"id": eid, "name": exp.get("name"), "type": exp["type"], "algorithm_version": exp.get("algorithm_version"),
         "app_version": exp.get("app_version"), "created": exp.get("created"), "status": exp.get("status"),
         "input": exp.get("inputs", {}).get("item_name"), "profile": exp.get("inputs", {}).get("profile_name")}
    for k, v in (exp.get("config") or {}).items():
        if isinstance(v, (int, float, str, bool)) and k not in ("seed",):
            m[f"setting: {k}"] = v
    if exp["type"] == "music" and a:
        os_ = a.get("offset_summary", {})
        m.update({"pairs_outside": sum(1 for p in a.get("pairs", []) if p["outside"]), "decisions": len(a.get("events", [])),
                  "total_movement_dB": os_.get("total_movement_dB"), "direction_reversals": os_.get("direction_reversals"),
                  "max_abs_offset_dB": os_.get("max_abs_offset_dB"),
                  "tone_recommendations": sum(1 for g in a.get("tone", {}).values() for w in g.get("vs_baseline_windows", []) if w["explanation"] in ("eq", "eq+fader")),
                  "dynamics_flags": sum(1 for g in a.get("dynamics", {}).values() for w in g.get("windows", []) if abs(w["z"]) > 1)})
        if a.get("injection_score"):
            inj = a["injection_score"]["injections"]
            m["injection_corrected_mean"] = round(sum(j["corrected_fraction"] for j in inj) / len(inj), 3) if inj else None
            m["injection_other_max_dB"] = max((j["max_other_mean_abs_dB"] for j in inj), default=None)
            m["response_outside_rms_dB"] = a["injection_score"].get("rms_response_outside_disturbances_dB")
    if exp["type"] == "speech" and a:
        m.update({"handovers": a.get("handovers"), "idle_noise_reduction_dB": round((a.get("idle_noise_before_db") or 0) - (a.get("idle_noise_after_db") or 0), 2),
                  "leveller": {x["name"]: x["leveller_db"] for x in a.get("mics", [])}})
    if exp["type"] == "program" and a:
        cm = a.get("comparison", {})
        m.update({"findings": len(cm.get("findings", [])), "metrics_outside": sum(1 for r in cm.get("metrics", []) if r["status"] == "outside"),
                  "metrics_edge": sum(1 for r in cm.get("metrics", []) if r["status"] == "edge"), "profile_references": cm.get("n_references")})
    verdicts = {}
    for x in fb["decisions"]:
        verdicts[x["verdict"]] = verdicts.get(x["verdict"], 0) + 1
    m["feedback"] = {"decision_verdicts": verdicts, "notes": len(fb["notes"]), "missed": len(fb["missed"]),
                     "overall": [o.get("ratings", {}).get("overall") for o in fb["overall"]]}
    m["blind"] = FB.tally(ls["trials"])
    return m


LOWER_IS_BETTER = {"pairs_outside", "direction_reversals", "response_outside_rms_dB", "injection_other_max_dB", "total_movement_dB"}
HIGHER_IS_BETTER = {"injection_corrected_mean", "idle_noise_reduction_dB"}


def compare(ws, a_id, b_id) -> dict:
    A, B = metrics(ws, a_id), metrics(ws, b_id)
    rows = []
    for k in sorted(set(A) | set(B)):
        if k in ("id", "name", "feedback", "blind", "leveller", "created", "status"):
            continue
        va, vb = A.get(k), B.get(k)
        if va == vb:
            change = "unchanged"
        elif isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            if k in LOWER_IS_BETTER:
                change = "improved" if vb < va else "regressed"
            elif k in HIGHER_IS_BETTER:
                change = "improved" if vb > va else "regressed"
            else:
                change = "changed"
        else:
            change = "changed"
        rows.append({"metric": k, "a": va, "b": vb, "change": change})
    return {"a": A, "b": B, "rows": rows,
            "note": "Improved/regressed apply only to metrics with a clear direction (e.g. fewer reversals). Movement can "
                    "drop because a version does less, not because it does better: listen before concluding."}
