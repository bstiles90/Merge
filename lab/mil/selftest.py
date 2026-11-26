"""Headless end-to-end self-test (`Merge Intelligence Lab --selftest`).

Runs the first-release workflow through the same HTTP API the window uses: create a
workspace with demo material, validate a reference, build a Sound Profile, analyse a mix with
known disturbances, run speech, record feedback and a blind trial, export a research package,
reopen the workspace. Used by CI on the packaged app (no development environment present).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path


def run(base_dir=None) -> int:
    tmp = Path(base_dir or tempfile.mkdtemp(prefix="mil-selftest-"))
    tmp.mkdir(parents=True, exist_ok=True)
    os.environ["MIL_SETTINGS_DIR"] = str(tmp / "settings")
    from .server import LabState, start_server
    st = LabState()
    srv = start_server(st, 0)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    checks = []

    def call(method, path, body=None):
        req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"X-Lab-Token": st.token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())

    def wait(jid, what):
        t0 = time.time()
        while True:
            j = call("GET", f"/api/jobs/{jid}")["job"]
            if j["status"] in ("done", "error", "cancelled"):
                ok(j["status"] == "done", f"{what} ({time.time() - t0:.0f} s)", j.get("error") or "")
                return j
            time.sleep(0.3)

    def ok(cond, what, detail=""):
        checks.append((bool(cond), what, detail))
        print(("PASS " if cond else "FAIL ") + what + (f" - {detail}" if detail and not cond else ""), flush=True)

    try:
        # refused without the token
        try:
            urllib.request.urlopen(base + "/api/state", timeout=10)
            ok(False, "API refuses requests without the launch token")
        except urllib.error.HTTPError as e:
            ok(e.code == 403, "API refuses requests without the launch token")
        html = urllib.request.urlopen(base + "/", timeout=10).read()
        ok(b"Merge Intelligence Lab" in html, "UI is served")
        r = call("POST", "/api/workspace/create", {"parent": str(tmp), "name": "Selftest", "demo": True})
        ok(r["workspace"]["name"] == "Selftest", "workspace created")
        wait(r["job"], "demo material generated and imported")
        refs = call("GET", "/api/library/references")["items"]
        mixes = call("GET", "/api/library/mixes")["items"]
        sp = call("GET", "/api/library/speech")["items"]
        ok(len(refs) == 2 and len(mixes) == 1 and len(sp) == 1, "library holds 2 references, 1 mix, 1 speech set")
        ref = refs[0]
        v = wait(call("POST", "/api/validate", {"kind": "reference", "master": ref["master"]["path"],
                                                "files": [{"path": s["file"]["path"], "group": s["group"]} for s in ref["stems"]]})["job"],
                 "reference validation")
        val = v["result"]
        ok(val["reconstruction_error_dB"] is not None and val["reconstruction_error_dB"] < -15, "reconstruction error measured",
           str(val.get("reconstruction_error_dB")))
        r = call("POST", "/api/profiles/create", {"name": "Selftest profile", "reference_ids": [x["id"] for x in refs]})
        wait(r["job"], "Sound Profile built")
        prof = call("GET", f"/api/profiles/{r['profile_id']}")
        ok(prof["meta"]["status"] == "complete" and prof["profile"]["balance"], "profile has balance targets")
        mix = mixes[0]
        cfg = {"beta": 0.5, "evidence_s": 6.0, "rate_db_s": 0.5, "max_boost_db": 4, "max_cut_db": 4, "baseline": [[0, 15]],
               "render_experimental": True, "render_groups": True, "seed": 1}
        r = call("POST", "/api/experiments/music", {"name": "Selftest music", "inputs": {"mix_id": mix["id"], "profile_id": r["profile_id"]},
                                                    "config": cfg, "injections": mix.get("suggested_injections")})
        wait(r["job"], "music experiment")
        e = call("GET", f"/api/experiments/{r['exp_id']}")
        ok(e["experiment"]["status"] == "complete", "music experiment complete")
        inj = e["analysis"]["injection_score"]["injections"]
        ok(all(0.5 <= j["corrected_fraction"] <= 1.2 for j in inj), "known disturbances corrected 50-120 %",
           str([j["corrected_fraction"] for j in inj]))
        ok(all(f in e["files"] for f in ("audio/before.wav", "audio/after.wav", "offsets.csv", "activity.csv", "decisions.jsonl")),
           "listening files and evidence written")
        series = call("GET", f"/api/experiments/{r['exp_id']}/series")
        ok(series["offsets"] and len(series["offsets"]["time_s"]) > 100, "decision timeline series available")
        music_id = r["exp_id"]
        sp_r = call("POST", "/api/experiments/speech", {"name": "Selftest speech", "inputs": {"speech_id": sp[0]["id"]},
                                                        "config": {"target_lufs": -20, "last_hold": True, "depth_db": -40}})
        wait(sp_r["job"], "speech experiment")
        se = call("GET", f"/api/experiments/{sp_r['exp_id']}")
        ok(se["analysis"]["handovers"] >= 2, "speech handovers detected")
        # feedback, notes, blind trial
        d0 = e["analysis"]["events"][0]
        call("POST", f"/api/feedback/{music_id}/decisions", {"decision_index": 0, "time_s": d0["t"], "target": d0["group"],
                                                            "verdict": "too_much", "preferred": {"kind": "fader", "value": -1.0},
                                                            "comment": "selftest comment"})
        call("POST", f"/api/feedback/{music_id}/notes", {"time_s": 12.5, "version": "after", "text": "selftest note"})
        call("POST", f"/api/feedback/{music_id}/missed", {"start_s": 70, "end_s": 80, "target": "keys", "issue": "too quiet",
                                                         "preferred": {"kind": "fader", "value": 1.5}})
        call("POST", f"/api/feedback/{music_id}/overall", {"version": "after", "ratings": {"overall": "improved"}, "blind": False})
        t = call("POST", f"/api/listening/{music_id}/trial", {"versions": ["before", "after"], "segment": [20, 40]})["trial"]
        ok("assignment" not in t, "blind trial hides the assignment before answering")
        a = call("POST", f"/api/listening/{music_id}/trial/{t['id']}/answer", {"choice": "A"})["trial"]
        ok("assignment" in a and a["preferred_version"] in ("before", "after"), "blind trial reveals after answering")
        fb = call("GET", f"/api/experiments/{music_id}")["feedback"]
        ok(len(fb["decisions"]) == 1 and fb["decisions"][0]["category"] == "excessive_gain", "decision feedback stored and categorised")
        # rerun (cross-version workflow) and compare
        rr = call("POST", f"/api/experiments/{music_id}/rerun", {})
        wait(rr["job"], "rerun of the same experiment")
        cmp_ = call("GET", f"/api/experiments-compare?a={music_id}&b={rr['exp_id']}")
        ok(any(row["metric"] == "direction_reversals" and row["change"] == "unchanged" for row in cmp_["rows"]),
           "rerun with the same algorithm reproduces the result")
        # export
        pv = call("POST", "/api/export/preview", {"scope": {"experiments": [music_id, sp_r["exp_id"]]}, "options": {}})
        ok(not pv["contains_audio"], "default export contains no audio")
        out = call("POST", "/api/export/build", {"scope": {"experiments": [music_id, sp_r["exp_id"]]}, "options": {}})
        with zipfile.ZipFile(out["path"]) as z:
            names = z.namelist()
            blob = b"".join(z.read(n) for n in names if not n.endswith("/"))
        ok(any(n.endswith("SUMMARY.md") for n in names) and any(n.endswith("engineer_feedback.json") for n in names),
           "research package has summary and feedback")
        ok(not any(n.lower().endswith(".wav") for n in names), "research package excludes audio")
        ok(str(tmp).encode() not in blob, "research package contains no absolute workspace paths")
        # reopen
        ws_root = st.ws.root
        call("POST", "/api/workspace/close", {})
        call("POST", "/api/workspace/open", {"path": str(ws_root)})
        ok(any(x["id"] == music_id for x in call("GET", "/api/experiments")["items"]), "experiment still there after reopening")
    except Exception as ex:
        import traceback
        traceback.print_exc()
        ok(False, f"self-test aborted: {ex}")
    finally:
        srv.shutdown()
    failed = [c for c in checks if not c[0]]
    print(f"\n{len(checks) - len(failed)} passed, {len(failed)} failed", flush=True)
    if not base_dir:
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if failed else 0
