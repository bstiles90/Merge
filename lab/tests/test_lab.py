"""Merge Intelligence Lab tests: workspace storage, staging, feedback, export privacy,
job failure/cancel atomicity, Lab == CLI equivalence. The end-to-end self-test is `slow`."""

import json
import os
import shutil
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf


def _tone(path, seconds=12, f=220.0, amp=0.2, sr=48000, ch=2):
    t = np.arange(int(seconds * sr)) / sr
    x = amp * np.sin(2 * np.pi * f * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.25 * t))
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, np.column_stack([x] * ch) if ch > 1 else x, sr, subtype="PCM_24")
    return path


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("MIL_SETTINGS_DIR", str(tmp_path / "settings"))
    src = tmp_path / "src"
    files = {g: _tone(src / f"{g.capitalize()}.wav", f=110 * (i + 1)) for i, g in enumerate(["vocals", "drums", "bass", "guitars", "keys"])}
    from mil.store import Workspace
    ws = Workspace.create(tmp_path / "ws", "Test")
    return ws, src, files


# ------------------------------------------------------------------ storage
def test_workspace_layout_and_reopen(env):
    ws, _, _ = env
    from mil.store import Workspace
    for sub in ("library", "audio", "profiles", "experiments", "exports"):
        assert (ws.root / sub).is_dir()
    ws.rename("Renamed")
    assert Workspace(ws.root).manifest["name"] == "Renamed"


def test_reference_by_default_never_deletes_originals(env):
    ws, src, files = env
    it = ws.add("mixes", {"name": "m"})
    rec = ws.file_record(str(files["vocals"]), it["id"], copy=False)
    assert rec["stored"] == "external" and Path(rec["path"]) == files["vocals"].resolve()
    copied = ws.file_record(str(files["drums"]), it["id"], copy=True)
    assert copied["stored"] == "workspace" and Path(copied["path"]).is_relative_to(ws.root)
    ws.update("mixes", it["id"], {"stems": [{"file": rec, "group": "vocals"}, {"file": copied, "group": "drums"}]})
    ws.remove("mixes", it["id"], delete_copied=True)
    assert files["vocals"].is_file() and files["drums"].is_file(), "originals must never be deleted"
    assert not Path(copied["path"]).exists(), "the workspace's own copy is removed"


def test_missing_file_and_relink_checks_content(env, tmp_path):
    ws, src, files = env
    it = ws.add("mixes", {"name": "m"})
    rec = ws.file_record(str(files["bass"]), it["id"], copy=False)
    ws.update("mixes", it["id"], {"stems": [{"file": rec, "group": "bass"}]})
    moved = tmp_path / "moved" / "Bass.wav"
    moved.parent.mkdir()
    shutil.move(files["bass"], moved)
    assert [m["name"] for m in ws.missing()] == ["Bass.wav"]
    other = _tone(tmp_path / "other.wav", f=999)
    assert ws.relink("mixes", it["id"], rec["id"], str(other))["ok"] is False
    assert ws.relink("mixes", it["id"], rec["id"], str(moved))["ok"] is True
    assert ws.missing() == []


def test_backup_excludes_audio_by_default(env):
    ws, _, files = env
    it = ws.add("mixes", {"name": "m"})
    ws.file_record(str(files["keys"]), it["id"], copy=True)
    z = ws.backup(ws.root.parent / "b.zip")
    with zipfile.ZipFile(z) as f:
        assert not any(n.lower().endswith(".wav") for n in f.namelist())
        assert any(n.endswith("lab.json") for n in f.namelist())


# ------------------------------------------------------------------ staging
def test_staging_writes_explicit_roles_and_links(env, tmp_path):
    ws, src, files = env
    from mil import staging as S
    from mi.layout import load_toml
    mix = {"id": "mix-1", "stems": [{"file": {"path": str(files[g])}, "group": g} for g in files]}
    name = S.stage_mix(mix, tmp_path / "stage", baseline=[[0, 5]], injections=[{"group": "keys", "db": 3, "start": 2, "end": 6}])
    d = tmp_path / "stage" / "mixes" / name
    meta = load_toml(d / "mix.toml")
    assert set(meta["roles"].values()) == set(files)
    assert meta["baseline"] == [[0, 5]]
    for p in (d / "stems").iterdir():
        assert sf.info(str(p)).frames == sf.info(str(files[meta["roles"][p.stem]])).frames


def test_speech_staging_excludes_non_speech_roles(env, tmp_path):
    ws, src, files = env
    from mil import staging as S
    from mi.layout import load_toml
    sp = {"id": "sp-1", "mics": [{"file": {"path": str(files["vocals"]), "name": "a.wav"}, "name": "pastor", "role": "speech", "weight_db": 2},
                                 {"file": {"path": str(files["drums"]), "name": "b.wav"}, "name": "room", "role": "audience"}]}
    name = S.stage_speech(sp, tmp_path / "st", {"target_lufs": -20})
    meta = load_toml(tmp_path / "st" / "speech" / name / "speech.toml")
    assert meta["exclude"] == ["room"] and meta["weights"] == {"pastor": 2.0}
    assert [p.stem for p in (tmp_path / "st" / "speech" / name / "mics").iterdir()] == ["pastor"]


# ------------------------------------------------------------------ feedback & blind trials
def test_feedback_history_and_blind_assignment_hidden(env):
    ws, _, _ = env
    from mil import feedback as FB
    edir = ws.exp_dir("mx-test")
    edir.mkdir(parents=True)
    exp = {"id": "mx-test", "algorithm_version": "x"}
    a = FB.upsert(edir, "decisions", {"decision_index": 0, "verdict": "too_much", "comment": "one"}, exp)
    assert a["category"] == "excessive_gain" and a["category_auto"]
    b = FB.upsert(edir, "decisions", {**a, "comment": "two"}, exp)
    assert b["history"][0]["comment"] == "one"
    with pytest.raises(ValueError):
        FB.upsert(edir, "decisions", {"verdict": "nonsense"}, exp)
    t = FB.new_trial(edir, exp, ["before", "after"], [0, 10])
    assert "assignment" not in t
    ans = FB.public_trial(FB.answer_trial(edir, t["id"], "A"))
    assert ans["preferred_version"] == ans["assignment"]["A"]
    with pytest.raises(ValueError):
        FB.answer_trial(edir, t["id"], "B")  # one answer per trial


# ------------------------------------------------------------------ export privacy
def test_export_excludes_audio_paths_and_optionally_comments(env):
    ws, src, files = env
    from mil import export as EXP
    from mil import feedback as FB
    eid = "mx-exp"
    edir = ws.exp_dir(eid)
    (edir / "results" / "audio").mkdir(parents=True)
    shutil.copy(files["vocals"], edir / "results" / "audio" / "after.wav")
    (edir / "results" / "analysis.json").write_text(json.dumps({"warnings": [f"file {files['vocals']} short"], "where": str(ws.root)}))
    ws.save_experiment({"id": eid, "name": "E", "type": "music", "status": "complete", "inputs": {}, "config": {}, "algorithm_version": "t"})
    FB.upsert(edir, "notes", {"time_s": 1, "text": f"secret remark about {Path.home()}"}, {"id": eid})
    out = EXP.build(ws, {"experiments": [eid]}, {})
    with zipfile.ZipFile(out["path"]) as z:
        names = z.namelist()
        blob = b"".join(z.read(n) for n in names)
    assert not any(n.endswith(".wav") for n in names)
    assert str(ws.root).encode() not in blob and str(src).encode() not in blob and str(Path.home()).encode() not in blob
    assert b"secret remark" in blob
    out2 = EXP.build(ws, {"experiments": [eid]}, {"include_comments": False})
    with zipfile.ZipFile(out2["path"]) as z:
        assert b"secret remark" not in b"".join(z.read(n) for n in z.namelist())
    pv = EXP.preview(ws, {"experiments": [eid]}, {"include_rendered_audio": True})
    assert pv["contains_audio"]


# ------------------------------------------------------------------ API: token, failure atomicity, cancel
@pytest.fixture()
def server(env):
    from mil.server import LabState, start_server
    ws, src, files = env
    st = LabState()
    st.open(ws.root)
    srv = start_server(st, 0)
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def call(method, path, body=None, token=True):
        req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"X-Lab-Token": st.token if token else "", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    yield st, call, files
    srv.shutdown()


def _wait(st, jid, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = st.jobs.jobs[jid]
        if j.status in ("done", "error", "cancelled"):
            return j
        time.sleep(0.2)
    raise TimeoutError


def _add_mix(call, files, seconds_files=None):
    return call("POST", "/api/library/mixes/add", {"item": {"name": "mix"}, "stems": [{"path": str(p), "group": g} for g, p in files.items()]})["item"]


def test_api_requires_token(server):
    st, call, _ = server
    with pytest.raises(urllib.error.HTTPError) as e:
        call("GET", "/api/state", token=False)
    assert e.value.code == 403


def test_failed_experiment_is_recorded_and_leaves_no_partial_results(server):
    st, call, files = server
    mix = _add_mix(call, files)
    os.remove(files["keys"])  # a source file disappears before the run
    pid = "prof-missing"
    r = call("POST", "/api/experiments/music", {"name": "fails", "inputs": {"mix_id": mix["id"], "profile_id": pid}, "config": {}})
    j = _wait(st, r["job"])
    assert j.status == "error"
    exp = call("GET", f"/api/experiments/{r['exp_id']}")["experiment"]
    assert exp["status"] == "failed" and exp["error"]
    d = st.ws.exp_dir(r["exp_id"])
    assert not (d / "results").exists() and not (d / ".run").exists()


def test_cancel_marks_experiment_cancelled(server):
    st, call, files = server
    from mil.tasks import make_demo  # noqa: F401  (import check)
    r = call("POST", "/api/workspace/demo", {})
    call("POST", f"/api/jobs/{r['job']}/cancel", {})
    j = _wait(st, r["job"])
    assert j.status == "cancelled"


# ------------------------------------------------------------------ Lab == CLI
@pytest.mark.slow
def test_lab_matches_cli(tmp_path, monkeypatch):
    """The Lab stages files and config, then calls the same backend: results must equal a CLI run."""
    monkeypatch.setenv("MIL_SETTINGS_DIR", str(tmp_path / "settings"))
    from mi.compare import compare
    from mi.layout import find_references, load_config
    from mi.reference import analyse_reference, build_profile
    from mil import tasks
    from mil.store import Workspace
    ws = Workspace.create(tmp_path / "ws", "eq")
    tasks.make_demo({"ws": str(ws.root)}, lambda *a: None)
    demo = ws.root / "audio" / "demo"
    # CLI path: the demo folder is itself a CLI workspace
    refs = find_references(demo)
    prof_cli = build_profile([analyse_reference(r) for r in refs], "cli")
    res_cli, _ = compare(demo, "demo-mix", prof_cli, load_config(demo), tmp_path / "cli", render=False, plots=False, log=lambda *a: None)
    # Lab path
    from mil.store import atomic_write_json, new_id
    pid = new_id("prof")
    atomic_write_json(ws.profile_dir(pid) / "meta.json", {"id": pid, "name": "lab", "reference_ids": [r["id"] for r in ws.items("references")], "weights": {}})
    tasks.build_profile({"ws": str(ws.root), "profile_id": pid}, lambda *a: None)
    mix = ws.items("mixes")[0]
    eid = new_id("mx")
    ws.save_experiment({"id": eid, "name": "lab", "type": "music", "status": "running", "inputs": {"mix_id": mix["id"], "profile_id": pid},
                        "config": {"baseline": mix["baseline"], "render_groups": False}, "injections": mix["suggested_injections"]})
    tasks.run_music({"ws": str(ws.root), "exp_id": eid}, lambda *a: None)
    res_lab = json.loads((ws.exp_dir(eid) / "results" / "analysis.json").read_text())
    assert [p["live_median_LU"] for p in res_lab["pairs"]] == [p["live_median_LU"] for p in res_cli["pairs"]]
    assert res_lab["offset_summary"] == res_cli["offset_summary"]
    assert res_lab["injection_score"]["injections"] == res_cli["injection_score"]["injections"]


@pytest.mark.slow
def test_selftest_end_to_end(tmp_path):
    from mil.selftest import run
    assert run(str(tmp_path)) == 0
