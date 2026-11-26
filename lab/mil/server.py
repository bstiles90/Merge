"""The Lab's local API and UI server (127.0.0.1 only, random port, per-launch secret token).

The window (pywebview) loads the UI from here; the UI calls /api/*. Nothing listens on the
network, and requests without the launch token are refused, so no web page can reach it.
"""

from __future__ import annotations

import json
import mimetypes
import re
import secrets
import shutil
import sys
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import APP_NAME, APP_VERSION, EXPERIMENT_SCHEMA
from . import capabilities as CAP
from . import comparison as CMP
from . import export as EXP
from . import feedback as FB
from .jobs import JobManager
from .paths import build_info, default_workspace_parent, ensure_backend_importable, web_root
from .store import AppSettings, Workspace, atomic_write_json, new_id, now, read_json

ensure_backend_importable()


class LabState:
    def __init__(self):
        self.settings = AppSettings()
        self.ws: Workspace | None = None
        self.jobs = JobManager()
        self.token = secrets.token_urlsafe(24)
        self.info = build_info()
        self.desktop = None  # set by main.py when running in a window
        self.client_log = []  # errors and audio checks reported by the UI (included in diagnostics)
        self.audio_check = None
        last = self.settings.data.get("last_workspace")
        if last:
            try:
                self.open(Path(last))
            except Exception:
                pass

    def open(self, root: Path):
        self.ws = Workspace(root)
        self.settings.remember(self.ws.root)
        self._recover()

    def _recover(self):
        """Experiments left 'running' by a previous session (app closed or crashed) become 'interrupted'."""
        live = {j.payload.get("exp_id") for j in self.jobs.jobs.values() if j.status in ("queued", "running")}
        for e in self.ws.experiments():
            if e.get("status") in ("running", "queued") and e["id"] not in live:
                shutil.rmtree(self.ws.exp_dir(e["id"]) / ".run", ignore_errors=True)
                e.update({"status": "interrupted", "error": "The Lab was closed before this experiment finished. Rerun it."})
                self.ws.save_experiment(e)
        shutil.rmtree(self.ws.root / ".staging", ignore_errors=True)
        (self.ws.root / ".staging").mkdir(exist_ok=True)

    def need_ws(self) -> Workspace:
        if not self.ws:
            raise ApiError("Open or create a workspace first", 409)
        return self.ws


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


ROUTES = []


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")
    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn
    return deco


# ============================================================================ app & workspace
@route("GET", "/api/state")
def api_state(st: LabState, q, body):
    if not getattr(st, "_ui_seen", False):
        st._ui_seen = True
        print("[lab] UI client connected", flush=True)  # CI launch check greps for this
    ws = st.ws
    out = {"app": {"name": APP_NAME, **st.info}, "onboarding_done": st.settings.data.get("onboarding_done", False),
           "recent_workspaces": [r for r in st.settings.data.get("recent_workspaces", []) if (Path(r) / "lab.json").is_file()],
           "default_workspace_parent": str(default_workspace_parent()), "desktop": st.desktop is not None,
           "workspace": ws.summary() if ws else None, "jobs": st.jobs.list()}
    if ws:
        exps = ws.experiments()
        lc = {e["id"]: len(FB.listening(ws.exp_dir(e["id"]))["trials"]) for e in exps}
        out["capabilities"] = CAP.capabilities(exps, lc)
        out["levels"] = CAP.LEVELS
        out["recent_experiments"] = [_exp_brief(e) for e in exps[:8]]
    return out


@route("POST", "/api/client-log")
def api_client_log(st, q, body):
    entry = {"time": now(), **{k: body.get(k) for k in ("kind", "message", "detail", "results", "userAgent")}}
    st.client_log = (st.client_log + [entry])[-200:]
    if body.get("kind") == "audiocheck":
        st.audio_check = body.get("results")
    return {"ok": True}


@route("GET", "/api/client-log")
def api_client_log_get(st, q, body):
    return {"items": st.client_log, "audio_check": st.audio_check}


@route("POST", "/api/onboarding/done")
def api_onboarded(st, q, body):
    st.settings.data["onboarding_done"] = True
    st.settings.save()
    return {"ok": True}


@route("POST", "/api/workspace/create")
def api_ws_create(st, q, body):
    name = (body.get("name") or "Worship research").strip()
    from .store import safe_name
    root = Path(body["path"]) if body.get("path") else Path(body.get("parent") or default_workspace_parent()) / safe_name(name)
    ws = Workspace.create(root, name)
    st.open(ws.root)
    if body.get("demo"):
        jid = st.jobs.submit("demo", {"ws": str(ws.root)}, "Creating demo material").id
        return {"workspace": st.ws.summary(), "job": jid}
    return {"workspace": st.ws.summary()}


@route("POST", "/api/workspace/open")
def api_ws_open(st, q, body):
    st.open(Path(body["path"]))
    return {"workspace": st.ws.summary()}


@route("POST", "/api/workspace/close")
def api_ws_close(st, q, body):
    st.ws = None
    st.settings.data.pop("last_workspace", None)
    st.settings.save()
    return {"ok": True}


@route("POST", "/api/workspace/rename")
def api_ws_rename(st, q, body):
    st.need_ws().rename(body["name"])
    return {"workspace": st.ws.summary()}


@route("POST", "/api/workspace/settings")
def api_ws_settings(st, q, body):
    ws = st.need_ws()
    ws.manifest["settings"].update({k: v for k, v in body.items() if k in ("import_mode", "listening_lufs", "crossfade_ms")})
    ws.save_manifest()
    return {"workspace": ws.summary()}


@route("GET", "/api/workspace/usage")
def api_ws_usage(st, q, body):
    ws = st.need_ws()
    return {"usage": ws.usage(), "missing": ws.missing()}


@route("POST", "/api/workspace/backup")
def api_ws_backup(st, q, body):
    ws = st.need_ws()
    dest = body.get("dest") or str(ws.root.parent / f"{ws.manifest['name']} backup {now()[:10]}.zip")
    return {"path": ws.backup(Path(dest), bool(body.get("include_audio")))}


@route("POST", "/api/workspace/demo")
def api_ws_demo(st, q, body):
    ws = st.need_ws()
    return {"job": st.jobs.submit("demo", {"ws": str(ws.root)}, "Creating demo material").id}


# ============================================================================ library
@route("GET", "/api/library/(references|mixes|speech|recordings)")
def api_lib(st, q, body, kind):
    ws = st.need_ws()
    items = ws.items(kind)
    for it in items:
        it["_missing"] = [f["name"] for f in ws.files_of(it) if not Path(f["path"]).is_file()]
    return {"items": items}


@route("POST", "/api/files/inspect")
def api_inspect(st, q, body):
    """Expand folders, read basic audio info and suggest a source group per file (no audio decode)."""
    from mi.layout import role_for
    from .store import audio_info
    paths = []
    for p in body.get("paths", []):
        P = Path(p).expanduser()
        if P.is_dir():
            paths += sorted(x for x in P.rglob("*") if x.suffix.lower() in (".wav", ".aif", ".aiff", ".flac", ".wave") and not x.name.startswith("."))
        elif P.is_file():
            paths.append(P)
    out = []
    for P in paths:
        rec = {"path": str(P.resolve()), "name": P.name, "suggested_group": role_for(P.name), "is_master": P.stem.lower() in ("master", "mix", "stereo", "2track")}
        try:
            rec.update(audio_info(P))
        except Exception:
            rec["error"] = "Not a readable audio file"
        out.append(rec)
    return {"files": out}


@route("POST", "/api/files/loudness")
def api_loudness(st, q, body):
    """Integrated loudness of a library file (used to level-match reference playback). Cached by fingerprint."""
    from .store import fingerprint
    from .tasks import _stream_stats
    ws = st.need_ws()
    p = Path(body["path"])
    if not p.is_file() or not _allowed_audio(st, p):
        raise ApiError("file not available", 404)
    cache = ws.root / ".cache" / "loudness.json"
    c = read_json(cache, {}) or {}
    fp = fingerprint(p)
    if fp not in c:
        c[fp] = _stream_stats(p).get("integrated_LUFS")
        atomic_write_json(cache, c)
    return {"integrated_LUFS": c[fp]}


@route("POST", "/api/validate")
def api_validate(st, q, body):
    return {"job": st.jobs.submit("validate", body, "Checking audio").id}


@route("POST", "/api/library/(references|mixes|speech|recordings)/add")
def api_lib_add(st, q, body, kind):
    ws = st.need_ws()
    copy = body.get("copy")
    item = dict(body.get("item", {}))
    item = ws.add(kind, item)
    patch = {}
    try:
        if body.get("master"):
            patch["master"] = ws.file_record(body["master"], item["id"], copy)
        if body.get("mix"):
            patch["mix"] = ws.file_record(body["mix"], item["id"], copy)
        for key in ("stems", "raw"):
            if body.get(key):
                patch[key] = [{"file": ws.file_record(f["path"], item["id"], copy), "group": f["group"]} for f in body[key] if f.get("group")]
        if body.get("mics"):
            patch["mics"] = [{"file": ws.file_record(f["path"], item["id"], copy), "name": f.get("name") or Path(f["path"]).stem,
                              "role": f.get("role", "speech"), "weight_db": float(f.get("weight_db", 0.0))} for f in body["mics"]]
    except Exception as e:
        ws.remove(kind, item["id"], delete_copied=True)
        raise ApiError(str(e))
    if body.get("validation"):
        patch["validation"] = body["validation"]
    item = ws.update(kind, item["id"], patch)
    out = {"item": item}
    if kind == "references" and item.get("master"):  # programme analysis starts straight away
        out["job"] = st.jobs.submit("analyse_refs", {"ws": str(ws.root), "ids": [item["id"]]}, f"Analysing {item.get('title') or 'reference'}").id
    return out


def _title_from_name(name: str) -> dict:
    """'Artist - Title.wav' -> artist/title (a common export naming); otherwise the file name is the title."""
    stem = Path(name).stem.replace("_", " ").strip()
    for sep in (" - ", " – ", " — "):
        if sep in stem:
            a, t = stem.split(sep, 1)
            return {"artist": a.strip(), "title": t.strip()}
    return {"artist": "", "title": stem}


@route("POST", "/api/library/references/batch")
def api_ref_batch(st, q, body):
    """Batch import of stereo masters without stems: one reference per file, then programme analysis."""
    ws = st.need_ws()
    known = {(r.get("master") or {}).get("fingerprint") for r in ws.items("references")}
    created, skipped = [], []
    for f in body.get("files", []):
        try:
            item = ws.add("references", {**_title_from_name(f["path"]), "album": "", "version": "", "category": body.get("category", "music"),
                                         "arrangement": body.get("arrangement", ""), "weight": float(body.get("weight", 1.0)), "include": True,
                                         "notes": "", "batch": True, "stems": []})
            rec = ws.file_record(f["path"], item["id"], body.get("copy"))
            if rec.get("error"):
                ws.remove("references", item["id"], delete_copied=True)
                skipped.append({"name": Path(f["path"]).name, "reason": rec["error"]})
                continue
            if rec["fingerprint"] in known:
                ws.remove("references", item["id"], delete_copied=True)
                skipped.append({"name": rec["name"], "reason": "already in the library"})
                continue
            known.add(rec["fingerprint"])
            if f.get("title"):
                item["title"] = f["title"]
            if f.get("artist") is not None:
                item["artist"] = f["artist"]
            ws.update("references", item["id"], {"master": rec, "title": item["title"], "artist": item["artist"]})
            created.append(item["id"])
        except Exception as e:
            skipped.append({"name": Path(f.get("path", "?")).name, "reason": str(e)})
    out = {"created": created, "skipped": skipped}
    if created:
        out["job"] = st.jobs.submit("analyse_refs", {"ws": str(ws.root), "ids": created}, f"Analysing {len(created)} master(s)").id
    return out


@route("GET", "/api/library/references/role-suggestions")
def api_role_suggestions(st, q, body):
    """Stems whose file name now maps to a different group (e.g. Synths that were filed under the old Keys & Other)."""
    from mi.layout import role_for
    out = []
    for r in st.need_ws().items("references"):
        for e in r.get("stems", []) or []:
            g = role_for(e["file"]["name"])
            if g and g != e["group"]:
                out.append({"ref_id": r["id"], "reference": r.get("title"), "file_id": e["file"]["id"], "file": e["file"]["name"],
                            "current": e["group"], "suggested": g})
    return {"items": out}


@route("POST", "/api/library/references/regroup")
def api_regroup(st, q, body):
    """Change the group of existing stems without reimporting audio. Profiles are not changed; rebuild them."""
    ws = st.need_ws()
    by_ref = {}
    for c in body.get("changes", []):
        by_ref.setdefault(c["ref_id"], {})[c["file_id"]] = c["group"]
    changed = []
    for rid, m in by_ref.items():
        it = ws.get("references", rid)
        stems = it.get("stems", []) or []
        n = 0
        for e in stems:
            if e["file"]["id"] in m and m[e["file"]["id"]] != e["group"]:
                e["group"] = m[e["file"]["id"]]
                n += 1
        if n:
            ws.update("references", rid, {"stems": stems, "roles_changed": now()})
            changed.append(rid)
    return {"changed": changed}


@route("POST", "/api/library/references/attach-stems")
def api_ref_attach(st, q, body):
    """Attach stems to an existing reference (e.g. a master imported earlier). The master is unchanged."""
    ws = st.need_ws()
    it = ws.get("references", body["id"])
    stems = [{"file": ws.file_record(f["path"], it["id"], body.get("copy")), "group": f["group"]} for f in body.get("stems", []) if f.get("group")]
    if not stems:
        raise ApiError("Choose at least one stem with a group")
    patch = {"stems": stems, "stems_attached": now()}
    if body.get("validation"):
        patch["validation"] = body["validation"]
    return {"item": ws.update("references", it["id"], patch)}


@route("POST", "/api/references/analyse")
def api_ref_analyse(st, q, body):
    ws = st.need_ws()
    return {"job": st.jobs.submit("analyse_refs", {"ws": str(ws.root), "ids": body.get("ids"), "force": bool(body.get("force"))},
                                  "Analysing masters").id}


def _ref_program_view(a: dict) -> dict:
    return {"scalars": a["scalars"], "spectrum_shape": a["spectrum"]["shape_dB"], "variation_p10": a["spectrum"]["variation_p10_dB"],
            "variation_p90": a["spectrum"]["variation_p90_dB"], "stereo_bands": a["stereo_bands"]["values"], "curves": a["curves"],
            "duration_s": a["duration_s"]}


@route("GET", "/api/references/program-overview")
def api_ref_overview(st, q, body):
    """Aggregate of every analysed reference in the library (the same statistics a profile would freeze)."""
    from mi.program import build_program_profile
    ws = st.need_ws()
    include_all = (q.get("all") or ["0"])[0] == "1"
    items, refs = [], []
    for r in ws.items("references"):
        d = ws.program_analysis(r["id"], (r.get("master") or {}).get("fingerprint"))
        row = {"id": r["id"], "title": r.get("title"), "artist": r.get("artist"), "include": r.get("include", True), "weight": r.get("weight", 1.0),
               "has_stems": bool(r.get("stems")), "synthetic": bool(r.get("synthetic")), "analysed": bool(d),
               "stale": bool(d and d.get("algorithm_version") != st.info.get("algorithm_version"))}
        if d:
            row.update(_ref_program_view(d["analysis"]))
            if include_all or r.get("include", True):
                items.append({"id": r["id"], "title": r.get("title"), "weight": float(r.get("weight", 1.0)), "has_stems": bool(r.get("stems")),
                              "analysis": d["analysis"]})
        refs.append(row)
    return {"aggregate": build_program_profile(items) if items else None, "references": refs}


@route("GET", "/api/references/([\\w-]+)/program")
def api_ref_program(st, q, body, rid):
    d = st.need_ws().program_analysis(rid)
    if not d:
        raise ApiError("This reference has not been analysed yet", 404)
    return d


@route("POST", "/api/library/(references|mixes|speech|recordings)/update")
def api_lib_update(st, q, body, kind):
    ws = st.need_ws()
    allowed = {"title", "artist", "album", "version", "category", "arrangement", "weight", "include", "notes", "engineer_eval",
               "name", "baseline", "tacet", "mics", "stems", "raw", "validation"}
    patch = {k: v for k, v in body.get("patch", {}).items() if k in allowed}
    return {"item": ws.update(kind, body["id"], patch)}


@route("POST", "/api/library/(references|mixes|speech|recordings)/replace-file")
def api_lib_replace(st, q, body, kind):
    """Replace one file of an item (e.g. a re-exported stem). The old file is not touched."""
    ws = st.need_ws()
    it = ws.get(kind, body["id"])
    newrec = ws.file_record(body["path"], it["id"], body.get("copy"))
    for key in ("master", "mix"):
        if it.get(key) and it[key]["id"] == body["file_id"]:
            it[key] = newrec
    for key in ("stems", "raw", "mics"):
        for e in it.get(key, []) or []:
            if e["file"]["id"] == body["file_id"]:
                e["file"] = newrec
    it.pop("validation", None)
    return {"item": ws.update(kind, it["id"], {k: it.get(k) for k in ("master", "mix", "stems", "raw", "mics", "validation") if k in it or k == "validation"})}


@route("POST", "/api/library/(references|mixes|speech|recordings)/remove")
def api_lib_remove(st, q, body, kind):
    st.need_ws().remove(kind, body["id"], bool(body.get("delete_copied")))
    return {"ok": True}


@route("POST", "/api/library/relink")
def api_relink(st, q, body):
    return st.need_ws().relink(body["kind"], body["item_id"], body["file_id"], body["path"], bool(body.get("force")))


# ============================================================================ profiles
def _profile_stale(ws, meta, refs_by_id, algo):
    """Why a profile no longer reflects the current library/analysis (it is never changed: rebuild makes a new version)."""
    why = []
    if meta.get("status") != "complete":
        return why
    if meta.get("algorithm_version") and meta.get("algorithm_version") != algo:
        why.append(f"built with algorithm {meta.get('algorithm_version')}; current is {algo}")
    fin = meta.get("finished") or meta.get("created") or ""
    changed = [r.get("title") or r["id"] for rid in meta.get("reference_ids", []) for r in [refs_by_id.get(rid)] if r
               and max(r.get("roles_changed") or "", r.get("stems_attached") or "") >= fin > ""]
    if changed:
        why.append(f"stem roles or stems changed since: {', '.join(changed)}")
    missing = [rid for rid in meta.get("reference_ids", []) if rid not in refs_by_id]
    if missing:
        why.append(f"{len(missing)} reference(s) removed from the library")
    return why


@route("GET", "/api/profiles")
def api_profiles(st, q, body):
    ws = st.need_ws()
    refs = {r["id"]: r for r in ws.items("references")}
    items = ws.profiles()
    for m in items:
        m["stale"] = _profile_stale(ws, m, refs, st.info.get("algorithm_version"))
    return {"items": items}


@route("POST", "/api/profiles/([\\w-]+)/rebuild")
def api_profile_rebuild(st, q, body, pid):
    """New version of a profile from the same references and weights, with the current stem roles and algorithm.
    The original profile is kept unchanged."""
    ws = st.need_ws()
    old = read_json(ws.profile_dir(pid) / "meta.json")
    refs = {r["id"] for r in ws.items("references")}
    ids = [r for r in old.get("reference_ids", []) if r in refs]
    if not ids:
        raise ApiError("None of this profile's references are still in the library")
    base = re.sub(r" \(rebuilt[^)]*\)$", "", old.get("name", "Sound Profile"))
    new = {"name": body.get("name") or f"{base} (rebuilt {st.info.get('algorithm_version')})", "reference_ids": ids,
           "weights": old.get("weights", {}), "parent_id": pid, "notes": f"Rebuilt from {old.get('name')} ({pid})."}
    return api_profile_create(st, q, new)


@route("POST", "/api/profiles/create")
def api_profile_create(st, q, body):
    ws = st.need_ws()
    ids = [r for r in body.get("reference_ids", []) if r]
    if not ids:
        raise ApiError("Choose at least one reference")
    pid = new_id("prof")
    meta = {"id": pid, "name": body.get("name") or "Sound Profile", "created": now(), "reference_ids": ids,
            "weights": {k: float(v) for k, v in (body.get("weights") or {}).items()}, "status": "running",
            "app_version": APP_VERSION, "parent_id": body.get("parent_id"), "notes": body.get("notes", "")}
    atomic_write_json(ws.profile_dir(pid) / "meta.json", meta)
    def done(j):
        m = read_json(ws.profile_dir(pid) / "meta.json", {})
        if m.get("status") == "running":
            m.update({"status": "failed" if j.status == "error" else j.status, "error": j.error})
            atomic_write_json(ws.profile_dir(pid) / "meta.json", m)
    jid = st.jobs.submit("profile", {"ws": str(ws.root), "profile_id": pid}, f"Building profile {meta['name']}", done).id
    return {"profile_id": pid, "job": jid}


@route("GET", "/api/profiles/([\\w-]+)")
def api_profile_get(st, q, body, pid):
    ws = st.need_ws()
    d = ws.profile_dir(pid)
    return {"meta": read_json(d / "meta.json"), "profile": read_json(d / "profile.json"),
            "report": (d / "profile.md").read_text() if (d / "profile.md").is_file() else None}


@route("POST", "/api/profiles/([\\w-]+)/(rename|delete)")
def api_profile_edit(st, q, body, pid, action):
    ws = st.need_ws()
    d = ws.profile_dir(pid)
    if action == "delete":
        used = [e["id"] for e in ws.experiments() if e.get("inputs", {}).get("profile_id") == pid]
        if used and not body.get("force"):
            raise ApiError(f"{len(used)} experiment(s) used this profile. It is kept so they stay reproducible; archive it instead.")
        shutil.rmtree(d)
        return {"ok": True}
    m = read_json(d / "meta.json")
    m["name"] = body["name"]
    atomic_write_json(d / "meta.json", m)
    return {"meta": m}


@route("GET", "/api/profiles-compare")
def api_profiles_compare(st, q, body):
    ws = st.need_ws()
    a, b = q["a"][0], q["b"][0]
    pa, pb = read_json(ws.profile_dir(a) / "profile.json"), read_json(ws.profile_dir(b) / "profile.json")
    rows = []
    for k in sorted(set(pa["balance"]) | set(pb["balance"])):
        va = (pa["balance"].get(k) or {}).get("byDensity", {}).get("all", {}).get("median")
        vb = (pb["balance"].get(k) or {}).get("byDensity", {}).get("all", {}).get("median")
        rows.append({"pair": k, "a": va, "b": vb, "diff": None if va is None or vb is None else round(vb - va, 2)})
    return {"rows": rows, "a": read_json(ws.profile_dir(a) / "meta.json"), "b": read_json(ws.profile_dir(b) / "meta.json")}


# ============================================================================ experiments
def _exp_brief(e):
    return {k: e.get(k) for k in ("id", "name", "type", "status", "created", "finished", "algorithm_version", "app_version", "synthetic",
                                  "archived", "summary", "inputs", "tags", "parent_id", "error")} | {"study": e.get("config", {}).get("study")}


def _new_experiment(st, etype, name, inputs, config, injections=None, parent_id=None, synthetic=False):
    ws = st.need_ws()
    eid = new_id({"music": "mx", "speech": "sp", "study": "st", "program": "pg"}[etype])
    fps = []
    for kind, key in (("mixes", "mix_id"), ("speech", "speech_id"), ("recordings", "recording_id")):
        if inputs.get(key):
            it = ws.get(kind, inputs[key])
            synthetic = synthetic or bool(it.get("synthetic"))
            fps = []
            for k2 in ("master", "mix"):
                if it.get(k2):
                    fps.append({"role": k2, "name": it[k2]["name"], "fingerprint": it[k2]["fingerprint"], "sr": it[k2].get("sr")})
            for k2 in ("stems", "raw", "mics"):
                for e in it.get(k2, []) or []:
                    fps.append({"role": k2, "name": e["file"]["name"], "group": e.get("group") or e.get("role"),
                                "fingerprint": e["file"]["fingerprint"], "sr": e["file"].get("sr"), "frames": e["file"].get("frames")})
            inputs = {**inputs, "item_name": it.get("name"), "source_mapping": {e["file"]["name"]: e["group"] for e in it.get("stems", []) or []}
                      if kind == "mixes" else ({m["file"]["name"]: {"role": m.get("role"), "weight_db": m.get("weight_db")} for m in it.get("mics", [])}
                      if kind == "speech" else {})}
    if inputs.get("profile_id"):
        pm = read_json(ws.profile_dir(inputs["profile_id"]) / "meta.json", {})
        inputs["profile_name"] = pm.get("name")
        inputs["profile_algorithm_version"] = pm.get("algorithm_version")
        refs = [ws.get("references", r) for r in pm.get("reference_ids", []) if any(x["id"] == r for x in ws.items("references"))]
        synthetic = synthetic or any(r.get("synthetic") for r in refs)
    exp = {"schema": EXPERIMENT_SCHEMA, "id": eid, "name": name, "type": etype, "created": now(), "status": "queued",
           "app_version": APP_VERSION, "algorithm_version": st.info.get("algorithm_version"), "git_commit": st.info.get("git_commit"),
           "inputs": inputs, "input_fingerprints": fps, "config": config, "injections": injections or [], "parent_id": parent_id,
           "synthetic": synthetic, "tags": [], "archived": False}
    ws.save_experiment(exp)
    def done(j):
        e = ws.experiment(eid)
        if e.get("status") in ("queued", "running"):
            shutil.rmtree(ws.exp_dir(eid) / ".run", ignore_errors=True)
            shutil.rmtree(ws.root / ".staging" / eid, ignore_errors=True)
            e.update({"status": "cancelled" if j.status == "cancelled" else "failed", "error": j.error or "Cancelled", "finished": now()})
            ws.save_experiment(e)
    exp["status"] = "running"
    ws.save_experiment(exp)
    job = st.jobs.submit(etype, {"ws": str(ws.root), "exp_id": eid},
                         f"{etype.capitalize()}: {name}", done)
    return {"exp_id": eid, "job": job.id}


@route("POST", "/api/experiments/(music|speech|study|program)")
def api_exp_new(st, q, body, etype):
    return _new_experiment(st, etype, body.get("name") or f"{etype} experiment", body.get("inputs", {}), body.get("config", {}),
                           body.get("injections"), body.get("parent_id"))


@route("GET", "/api/experiments")
def api_exps(st, q, body):
    return {"items": [_exp_brief(e) for e in st.need_ws().experiments()]}


@route("GET", "/api/experiments/([\\w-]+)")
def api_exp(st, q, body, eid):
    ws = st.need_ws()
    exp = ws.experiment(eid)
    res = ws.exp_dir(eid) / "results"
    out = {"experiment": exp, "analysis": read_json(res / "analysis.json"), "files": []}
    if res.is_dir():
        out["files"] = sorted(p.relative_to(res).as_posix() for p in res.rglob("*") if p.is_file())
        dec = res / "decisions.jsonl"
        out["decisions"] = [json.loads(l) for l in dec.read_text().splitlines() if l.strip()] if dec.is_file() else []
        for f in ("report.md",):
            if (res / f).is_file():
                out["report"] = (res / f).read_text()
        if (res / "result.json").is_file():
            out["study_result"] = read_json(res / "result.json")
    out["feedback"] = FB.load(ws.exp_dir(eid))
    out["listening"] = {"trials": [FB.public_trial(t) for t in FB.listening(ws.exp_dir(eid))["trials"]],
                        "tally": FB.tally(FB.listening(ws.exp_dir(eid))["trials"])}
    return out


def _csv(path):
    import csv
    if not path.is_file():
        return None
    with open(path) as f:
        rows = list(csv.reader(f))
    if not rows:
        return None
    head = rows[0]
    cols = list(zip(*[[float(x) if x != "" else None for x in r] for r in rows[1:]])) if len(rows) > 1 else [[] for _ in head]
    return {h: list(c) for h, c in zip(head, cols)}


@route("GET", "/api/experiments/([\\w-]+)/series")
def api_exp_series(st, q, body, eid):
    res = st.need_ws().exp_dir(eid) / "results"
    return {"offsets": _csv(res / "offsets.csv"), "activity": _csv(res / "activity.csv"), "loudness": _csv(res / "loudness.csv"),
            "speech": _csv(res / "speech_blocks.csv"), "program": _csv(res / "program_series.csv")}


@route("POST", "/api/experiments/([\\w-]+)/(rerun|archive|unarchive|rename|delete-renders|delete)")
def api_exp_action(st, q, body, eid, action):
    ws = st.need_ws()
    exp = ws.experiment(eid)
    if action == "rerun":
        return _new_experiment(st, exp["type"], body.get("name") or f"{exp['name']} (rerun)", {k: v for k, v in exp["inputs"].items()
                               if k in ("mix_id", "speech_id", "recording_id", "profile_id", "reference_ids")}, exp["config"], exp.get("injections"), parent_id=eid)
    if action in ("archive", "unarchive"):
        exp["archived"] = action == "archive"
    elif action == "rename":
        exp["name"] = body["name"]
    elif action == "delete-renders":
        a = ws.exp_dir(eid) / "results" / "audio"
        if a.is_dir():
            shutil.rmtree(a)
        exp["renders_deleted"] = now()
    elif action == "delete":
        if not body.get("confirm"):
            raise ApiError("confirm required")
        shutil.rmtree(ws.exp_dir(eid))
        return {"ok": True}
    ws.save_experiment(exp)
    return {"experiment": exp}


@route("GET", "/api/experiments-compare")
def api_exp_compare(st, q, body):
    return CMP.compare(st.need_ws(), q["a"][0], q["b"][0])


# ============================================================================ feedback & listening
@route("POST", "/api/feedback/([\\w-]+)/(decisions|notes|missed|overall|findings)")
def api_fb(st, q, body, eid, kind):
    ws = st.need_ws()
    return {"item": FB.upsert(ws.exp_dir(eid), kind, body, ws.experiment(eid))}


@route("POST", "/api/feedback/([\\w-]+)/(decisions|notes|missed|overall|findings)/delete")
def api_fb_del(st, q, body, eid, kind):
    FB.delete(st.need_ws().exp_dir(eid), kind, body["id"])
    return {"ok": True}


@route("GET", "/api/feedback")
def api_fb_all(st, q, body):
    ws = st.need_ws()
    out = []
    for e in ws.experiments():
        fb = FB.load(ws.exp_dir(e["id"]))
        for kind in ("decisions", "notes", "missed", "overall", "findings"):
            for x in fb[kind]:
                out.append({**x, "kind": kind, "experiment_name": e.get("name"), "experiment_type": e["type"]})
    trials = []
    for e in ws.experiments():
        for t in FB.listening(ws.exp_dir(e["id"]))["trials"]:
            trials.append({**FB.public_trial(t), "experiment_name": e.get("name"), "experiment_type": e["type"]})
    return {"items": sorted(out, key=lambda x: x.get("created", ""), reverse=True), "trials": trials, "verdicts": FB.DECISION_VERDICTS,
            "categories": FB.CATEGORIES, "aspects": FB.OVERALL_ASPECTS, "preferred_kinds": FB.PREFERRED_KINDS,
            "finding_verdicts": FB.FINDING_VERDICTS}


@route("POST", "/api/listening/([\\w-]+)/trial")
def api_trial(st, q, body, eid):
    ws = st.need_ws()
    return {"trial": FB.new_trial(ws.exp_dir(eid), ws.experiment(eid), body["versions"], body.get("segment"))}


@route("POST", "/api/listening/([\\w-]+)/trial/([\\w-]+)/(answer|reveal)")
def api_trial_answer(st, q, body, eid, tid, action):
    ws = st.need_ws()
    if action == "answer":
        t = FB.answer_trial(ws.exp_dir(eid), tid, body["choice"], body.get("comment", ""), body.get("confidence"))
    else:
        t = FB.reveal_trial(ws.exp_dir(eid), tid)
    return {"trial": FB.public_trial(t)}


# ============================================================================ export, jobs, os
@route("POST", "/api/export/preview")
def api_export_preview(st, q, body):
    return EXP.preview(st.need_ws(), body.get("scope", {}), body.get("options", {}))


@route("POST", "/api/export/build")
def api_export_build(st, q, body):
    return EXP.build(st.need_ws(), body.get("scope", {}), body.get("options", {}), Path(body["dest"]) if body.get("dest") else None)


@route("POST", "/api/export/prompt")
def api_export_prompt(st, q, body):
    sel = EXP.resolve_scope(st.need_ws(), body.get("scope", {}))
    return {"prompt": EXP.review_prompt(sel, body.get("package_name", "the attached research package"))}


@route("GET", "/api/jobs")
def api_jobs(st, q, body):
    return {"jobs": st.jobs.list()}


@route("GET", "/api/jobs/([\\w-]+)")
def api_job(st, q, body, jid):
    j = st.jobs.jobs.get(jid)
    if not j:
        raise ApiError("no such job", 404)
    return {"job": j.public()}


@route("POST", "/api/jobs/([\\w-]+)/cancel")
def api_job_cancel(st, q, body, jid):
    return {"ok": st.jobs.cancel(jid)}


@route("POST", "/api/diagnostics/export")
def api_diag(st, q, body):
    import platform
    import zipfile
    dest = Path(body.get("dest") or (st.ws.root / "exports" if st.ws else default_workspace_parent()) / f"lab-diagnostics-{now()[:19].replace(':', '')}.zip")
    dest.parent.mkdir(parents=True, exist_ok=True)
    info = {"app": st.info, "os": platform.platform(), "python": sys.version,
            "jobs": [dict(j.public(), traceback=j.traceback) for j in st.jobs.jobs.values()],
            "client_log": st.client_log, "audio_check": st.audio_check,
            "workspace": st.ws.summary()["counts"] if st.ws else None,
            "failed_experiments": [{k: e.get(k) for k in ("id", "type", "status", "error", "algorithm_version")} for e in (st.ws.experiments() if st.ws else []) if e.get("status") != "complete"]}
    san = EXP._Sanitizer(st.ws) if st.ws else None
    with zipfile.ZipFile(dest, "w") as z:
        z.writestr("diagnostics.json", json.dumps(san.obj(info) if san else info, indent=1, default=str))
    return {"path": str(dest)}


@route("POST", "/api/os/(reveal|copy|open)")
def api_os(st, q, body, what):
    import subprocess
    if what == "copy":
        txt = body.get("text", "")
        for cmd in (["pbcopy"], ["clip"], ["xclip", "-selection", "clipboard"], ["wl-copy"]):
            try:
                subprocess.run(cmd, input=txt.encode("utf-8"), check=True, timeout=5)
                return {"ok": True}
            except Exception:
                continue
        return {"ok": False}
    p = Path(body["path"])
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(p)] if what == "reveal" else ["open", str(p)])
        elif sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select,", str(p)] if what == "reveal" else ["explorer", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p.parent if what == "reveal" else p)])
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ============================================================================ audio
def _allowed_audio(st, path: Path) -> bool:
    ws = st.ws
    if not ws:
        return False
    p = path.resolve()
    if p.is_relative_to(ws.root):
        return True
    for kind in ("references", "mixes", "speech"):
        for it in ws.items(kind):
            if any(Path(f["path"]).resolve() == p for f in ws.files_of(it)):
                return True
    return False


def _resolve_audio(st, q):
    if "trial" in q:  # blind trials: the URL never reveals the version
        eid, tid, letter = q["exp"][0], q["trial"][0], q["letter"][0]
        ver = FB.trial_version(st.ws.exp_dir(eid), tid, letter)
        return st.ws.exp_dir(eid) / "results" / "audio" / f"{ver}.wav"
    if "exp" in q:
        return st.ws.exp_dir(q["exp"][0]) / "results" / q["file"][0]
    return Path(q["path"][0])


def peaks(path: Path, n: int = 2000) -> dict:
    """Waveform overview (max |x| per bucket), cached by fingerprint."""
    import numpy as np
    import soundfile as sf
    from .store import fingerprint
    info = sf.info(str(path))
    n = max(100, min(n, 20000))
    per = max(1, info.frames // n)
    out = []
    with sf.SoundFile(str(path)) as f:
        for blk in f.blocks(blocksize=per * 256, dtype="float32", always_2d=True):
            m = np.abs(blk).max(axis=1)
            k = len(m) // per
            if k:
                out.extend(m[: k * per].reshape(k, per).max(axis=1).tolist())
            if len(m) % per:
                out.append(float(m[k * per:].max()))
    return {"duration_s": info.frames / info.samplerate, "peaks": [round(x, 4) for x in out[:n + 1]], "sr": info.samplerate}


def _test_tone() -> bytes:
    """1.2 s stereo test signal (440 Hz then 660 Hz), 48 kHz 24-bit WAV, for the audio self-check."""
    import io as _io
    import numpy as np
    import soundfile as sf
    sr = 48000
    t = np.arange(int(0.6 * sr)) / sr
    env = np.minimum(1, np.minimum(t, t[::-1]) / 0.01)
    x = np.concatenate([0.2 * np.sin(2 * np.pi * 440 * t) * env, 0.2 * np.sin(2 * np.pi * 660 * t) * env])
    buf = _io.BytesIO()
    sf.write(buf, np.column_stack([x, x]), sr, format="WAV", subtype="PCM_24")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    st: LabState = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, default=str).encode())

    def _authorised(self, q):
        tok = self.headers.get("X-Lab-Token") or (q.get("t") or [None])[0]
        return secrets.compare_digest(tok or "", self.st.token)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_HEAD(self):
        self._handle("GET")

    def _handle(self, method):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = unquote(u.path)
        if not path.startswith("/api/"):
            return self._static(path)
        if not self._authorised(q):
            return self._json(403, {"error": "not authorised"})
        try:
            if path == "/api/test-tone":
                return self._send(200, _test_tone(), "audio/wav")
            if path in ("/api/audio", "/api/peaks", "/api/file"):
                return self._audio(path, q)
            body = {}
            if method == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            for m, rx, fn in ROUTES:
                if m != method:
                    continue
                mt = rx.match(path)
                if mt:
                    return self._json(200, fn(self.st, q, body, *mt.groups()))
            self._json(404, {"error": "not found"})
        except ApiError as e:
            self._json(e.code, {"error": str(e)})
        except (KeyError, FileNotFoundError, ValueError) as e:
            self._json(400, {"error": str(e).strip("'\"") or e.__class__.__name__})
        except Exception as e:
            self._json(500, {"error": f"{e.__class__.__name__}: {e}", "traceback": traceback.format_exc(limit=5)})

    def _audio(self, path, q):
        p = _resolve_audio(self.st, q)
        if not p.is_file() or not _allowed_audio(self.st, p):
            return self._json(404, {"error": "audio not available"})
        if path == "/api/peaks":
            return self._json(200, peaks(p, int((q.get("n") or ["2000"])[0])))
        if path == "/api/file":  # report images and other small result files
            if p.suffix.lower() not in (".png", ".svg", ".json", ".csv", ".md", ".txt"):
                return self._json(404, {"error": "not available"})
            return self._send(200, p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream")
        size = p.stat().st_size
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else max(0, size - int(b))
            end = min(int(b), size - 1) if a and b else size - 1   # a range past the end is clamped (RFC 9110)
            if start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(p, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def _static(self, path):
        root = web_root()
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        p = (root / rel).resolve()
        if not p.is_relative_to(root.resolve()) or not p.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if p.suffix == ".js":
            ctype = "text/javascript"
        self._send(200, p.read_bytes(), ctype)


def start_server(state: LabState, port: int = 0):
    Handler.st = state
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
