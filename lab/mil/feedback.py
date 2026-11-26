"""Engineer feedback and listening results (schema: docs/MERGE_INTELLIGENCE_LAB_FEEDBACK_SCHEMA.md).

Feedback never modifies an experiment's results: it is stored beside them, append-only per
item (edits keep the previous text in `history`). Blind trials are stored separately from
non-blind evaluations.
"""

from __future__ import annotations

import random
import uuid

from . import FEEDBACK_SCHEMA, LISTENING_SCHEMA
from .store import atomic_write_json, now, read_json

DECISION_VERDICTS = {
    "correct": "Correct adjustment",
    "too_much": "Correct direction, too much",
    "too_little": "Correct direction, not enough",
    "wrong_direction": "Incorrect direction",
    "wrong_type": "Incorrect type of intervention",
    "unnecessary": "Unnecessary adjustment",
    "missed": "Missed adjustment",
    "musical_change": "Intentional musical change treated as a problem",
    "correct_no_action": "Appropriate decision to do nothing",
    "unable": "Unable to evaluate",
}
CATEGORIES = {
    "activity": "Activity detection", "priority": "Incorrect source priority", "excessive_gain": "Excessive gain correction",
    "insufficient_gain": "Insufficient gain correction", "wrong_type": "Incorrect intervention type", "timing": "Timing problem",
    "instability": "Controller instability", "tonal": "Incorrect tonal interpretation", "dynamics": "Incorrect dynamics interpretation",
    "context": "Incorrect context", "expression": "Failure to preserve musical expression", "mic_management": "Incorrect microphone management",
    "profile": "Reference profile limitation", "plugin": "Plugin behaviour limitation", "other": "Other",
}
AUTO_CATEGORY = {"too_much": "excessive_gain", "too_little": "insufficient_gain", "wrong_direction": "excessive_gain",
                 "wrong_type": "wrong_type", "unnecessary": "excessive_gain", "musical_change": "expression", "missed": "insufficient_gain"}
PREFERRED_KINDS = ["fader", "group_fader", "eq", "compression", "dynamic_eq", "deesser", "transient", "mic_activity",
                   "speech_level", "none", "other"]
FINDING_VERDICTS = {  # verdicts on stereo-only diagnostic findings (programme comparisons)
    "agree_audible": "Agree — I can hear it",
    "agree_intended": "Real, but intended for this recording/venue",
    "measured_not_audible": "Measured, but not audible to me",
    "disagree": "Disagree — the finding is wrong",
    "unsure": "Unsure",
}
OVERALL_ASPECTS = ["overall", "vocal_balance", "instrument_balance", "tonal_clarity", "low_end", "vocal_intelligibility", "dynamics",
                   "transients", "musical_expression", "naturalness", "ambience", "speech_clarity", "broadcast_quality"]
OVERALL_VALUES = ["improved", "no_difference", "degraded", "na"]
BLIND_CHOICES = ["A", "B", "no_preference", "unable"]


def _fb_path(edir):
    return edir / "feedback.json"


def load(edir):
    fb = read_json(_fb_path(edir)) or {}
    fb.setdefault("schema", FEEDBACK_SCHEMA)
    for k in ("decisions", "notes", "missed", "overall", "findings"):
        fb.setdefault(k, [])
    return fb


def _save(edir, fb):
    fb["modified"] = now()
    atomic_write_json(_fb_path(edir), fb)


def upsert(edir, kind: str, item: dict, exp: dict) -> dict:
    """kind: decisions | notes | missed | overall | findings. New items get an id; edits keep history."""
    if kind not in ("decisions", "notes", "missed", "overall", "findings"):
        raise ValueError(kind)
    if kind == "findings" and item.get("verdict") not in FINDING_VERDICTS:
        raise ValueError("unknown finding verdict")
    fb = load(edir)
    item = dict(item)
    if kind == "decisions":
        if item.get("verdict") not in DECISION_VERDICTS:
            raise ValueError("unknown verdict")
        if not item.get("category"):
            item["category"] = AUTO_CATEGORY.get(item["verdict"])
            item["category_auto"] = True
    if kind == "overall":
        for a, v in (item.get("ratings") or {}).items():
            if a not in OVERALL_ASPECTS or v not in OVERALL_VALUES:
                raise ValueError(f"bad rating {a}={v}")
        item.setdefault("blind", False)
    if item.get("category") and item["category"] not in CATEGORIES:
        raise ValueError("unknown category")
    item["algorithm_version"] = exp.get("algorithm_version")
    item["experiment_id"] = exp["id"]
    lst = fb[kind]
    if item.get("id"):
        for i, old in enumerate(lst):
            if old["id"] == item["id"]:
                hist = old.get("history", []) + [{k: v for k, v in old.items() if k != "history"}]
                item["history"] = hist[-20:]
                item["created"] = old.get("created")
                item["modified"] = now()
                lst[i] = item
                _save(edir, fb)
                return item
    item["id"] = uuid.uuid4().hex[:10]
    item["created"] = now()
    lst.append(item)
    _save(edir, fb)
    return item


def delete(edir, kind, item_id):
    fb = load(edir)
    fb[kind] = [x for x in fb[kind] if x["id"] != item_id]
    _save(edir, fb)


# --------------------------------------------------------------------------- blind listening
def _ls_path(edir):
    return edir / "listening.json"


def listening(edir):
    d = read_json(_ls_path(edir)) or {}
    d.setdefault("schema", LISTENING_SCHEMA)
    d.setdefault("trials", [])
    return d


def new_trial(edir, exp, versions: list, segment: list | None, mode="ab") -> dict:
    """Randomise which version is A and which is B. The assignment is stored, never sent to the UI
    until the trial is answered (or revealed)."""
    if len(versions) != 2:
        raise ValueError("a blind A/B trial compares exactly two versions")
    order = list(versions)
    random.SystemRandom().shuffle(order)
    t = {"id": uuid.uuid4().hex[:10], "created": now(), "mode": mode, "assignment": {"A": order[0], "B": order[1]},
         "segment_s": segment, "algorithm_version": exp.get("algorithm_version"), "experiment_id": exp["id"],
         "answer": None, "revealed": False}
    d = listening(edir)
    d["trials"].append(t)
    atomic_write_json(_ls_path(edir), d)
    return public_trial(t)


def answer_trial(edir, tid, choice, comment="", confidence=None):
    if choice not in BLIND_CHOICES:
        raise ValueError("choice")
    d = listening(edir)
    for t in d["trials"]:
        if t["id"] == tid:
            if t["answer"] is not None:
                raise ValueError("this trial was already answered")
            t["answer"] = {"choice": choice, "comment": comment, "confidence": confidence, "answered": now()}
            t["preferred_version"] = t["assignment"].get(choice) if choice in ("A", "B") else None
            atomic_write_json(_ls_path(edir), d)
            return t
    raise KeyError(tid)


def reveal_trial(edir, tid):
    d = listening(edir)
    for t in d["trials"]:
        if t["id"] == tid:
            t["revealed"] = True
            atomic_write_json(_ls_path(edir), d)
            return t
    raise KeyError(tid)


def trial_version(edir, tid, letter):
    for t in listening(edir)["trials"]:
        if t["id"] == tid:
            return t["assignment"][letter]
    raise KeyError(tid)


def public_trial(t):
    out = {k: v for k, v in t.items() if k != "assignment"}
    if t.get("answer") is not None or t.get("revealed"):
        out["assignment"] = t["assignment"]
    return out


def tally(trials):
    """Counts only - a handful of informal trials is not statistically conclusive (reported as such)."""
    done = [t for t in trials if t.get("answer")]
    pref = {}
    for t in done:
        v = t.get("preferred_version") or t["answer"]["choice"]
        pref[v] = pref.get(v, 0) + 1
    return {"answered": len(done), "pending": len(trials) - len(done), "preferences": pref,
            "note": "Informal blind trials. Fewer than ~10 answered trials per comparison are not statistically conclusive."}
