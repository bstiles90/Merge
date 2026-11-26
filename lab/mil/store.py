"""Research workspaces: everything the Lab knows, stored as plain JSON next to the results.

A workspace is a folder the engineer chooses (default ~/Documents/Merge Intelligence Lab/<name>).
The Lab creates and manages everything inside it; the engineer never edits it by hand.

    <workspace>/
      lab.json                      workspace manifest (schema, name, settings)
      library/references.json       imported references (files by reference or copied)
      library/mixes.json            comparison mixes
      library/speech.json           speech recordings (multi-mic)
      audio/<item-id>/              audio copied into the workspace (only when "copy" is chosen)
      profiles/<id>/                Sound Profiles (profile.json, profile.md, meta.json)
      experiments/<id>/             one folder per experiment - never overwritten
      exports/                      research packages for Claude
      .staging/  .cache/            internal (safe to delete)

Original audio is never modified, moved or deleted. Imported files are referenced at their
current location by default (no duplication of large multitracks); each file is fingerprinted
so a moved file can be detected and relinked.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import shutil
import threading
import uuid
import zipfile
from pathlib import Path

from . import APP_VERSION, WORKSPACE_SCHEMA
from .paths import user_settings_dir

KINDS = ("references", "mixes", "speech")
_lock = threading.RLock()


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"


def atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, indent=1, default=str))
    os.replace(tmp, path)


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def fingerprint(path: Path) -> str:
    """Fast content fingerprint: size + SHA-256 of the first and last 4 MB (whole file if smaller)."""
    p = Path(path)
    size = p.stat().st_size
    h = hashlib.sha256(str(size).encode())
    with open(p, "rb") as f:
        h.update(f.read(4 << 20))
        if size > 8 << 20:
            f.seek(-(4 << 20), 2)
            h.update(f.read())
    return h.hexdigest()[:24]


def audio_info(path: Path) -> dict:
    import soundfile as sf
    i = sf.info(str(path))
    return {"sr": i.samplerate, "channels": i.channels, "frames": i.frames, "subtype": i.subtype,
            "format": i.format, "duration_s": round(i.frames / max(i.samplerate, 1), 3)}


# --------------------------------------------------------------------------- app settings
class AppSettings:
    """Per-user application settings (not part of any workspace)."""

    def __init__(self):
        self.path = user_settings_dir() / "settings.json"
        self.data = read_json(self.path, {}) or {}
        self.data.setdefault("recent_workspaces", [])
        self.data.setdefault("onboarding_done", False)

    def save(self):
        atomic_write_json(self.path, self.data)

    def remember(self, root: Path):
        r = str(Path(root).resolve())
        rec = [x for x in self.data["recent_workspaces"] if x != r]
        self.data["recent_workspaces"] = [r] + rec[:9]
        self.data["last_workspace"] = r
        self.save()


# --------------------------------------------------------------------------- workspace
DEFAULT_SETTINGS = {"import_mode": "reference", "listening_lufs": -18.0, "crossfade_ms": 8}


class Workspace:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.manifest = read_json(self.root / "lab.json")
        if not self.manifest or self.manifest.get("schema") != WORKSPACE_SCHEMA:
            raise ValueError(f"{self.root} is not a Merge Intelligence Lab workspace")
        self.manifest.setdefault("settings", {})
        for k, v in DEFAULT_SETTINGS.items():
            self.manifest["settings"].setdefault(k, v)

    # ---- lifecycle
    @classmethod
    def create(cls, root: Path, name: str) -> "Workspace":
        root = Path(root)
        if (root / "lab.json").exists():
            raise ValueError("A workspace already exists in that folder - use Open instead")
        if root.exists() and any(p for p in root.iterdir() if not p.name.startswith(".")):
            root = root / safe_name(name)
            if root.exists() and (root / "lab.json").exists():
                raise ValueError("A workspace with that name already exists there")
        for sub in ("library", "audio", "profiles", "experiments", "exports", ".staging", ".cache"):
            (root / sub).mkdir(parents=True, exist_ok=True)
        atomic_write_json(root / "lab.json", {"schema": WORKSPACE_SCHEMA, "id": uuid.uuid4().hex, "name": name,
                                              "created": now(), "created_by": APP_VERSION, "settings": dict(DEFAULT_SETTINGS)})
        for k in KINDS:
            atomic_write_json(root / "library" / f"{k}.json", [])
        (root / "README.txt").write_text(
            "Merge Intelligence Lab workspace.\n\nThis folder is managed by the Lab: open it from the Lab (File > Open Workspace).\n"
            "Your original audio is not stored here unless you chose to copy it.\nKeep this folder out of public repositories.\n")
        return cls(root)

    def save_manifest(self):
        atomic_write_json(self.root / "lab.json", self.manifest)

    def rename(self, name: str):
        self.manifest["name"] = name
        self.save_manifest()

    # ---- library
    def _lib(self, kind: str) -> Path:
        if kind not in KINDS:
            raise ValueError(kind)
        return self.root / "library" / f"{kind}.json"

    def items(self, kind: str) -> list:
        return read_json(self._lib(kind), []) or []

    def get(self, kind: str, item_id: str) -> dict:
        for it in self.items(kind):
            if it["id"] == item_id:
                return it
        raise KeyError(f"{kind} {item_id} not found")

    def _save(self, kind: str, items: list):
        atomic_write_json(self._lib(kind), items)

    def file_record(self, path: str, item_id: str, copy: bool | None = None) -> dict:
        """Register one audio file: referenced in place, or copied into the workspace."""
        src = Path(path).expanduser().resolve()
        if not src.is_file():
            raise FileNotFoundError(f"File not found: {src}")
        mode = (self.manifest["settings"]["import_mode"] if copy is None else ("copy" if copy else "reference"))
        stored = "external"
        p = src
        if mode == "copy":
            dest = self.root / "audio" / item_id / src.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                shutil.copy2(src, dest)
            p, stored = dest, "workspace"
        st = p.stat()
        rec = {"id": uuid.uuid4().hex[:10], "name": src.name, "path": str(p), "original_path": str(src), "stored": stored,
               "size": st.st_size, "mtime": st.st_mtime, "fingerprint": fingerprint(p)}
        try:
            rec.update(audio_info(p))
        except Exception as e:
            rec["error"] = f"Not a readable audio file ({e.__class__.__name__})"
        return rec

    def add(self, kind: str, item: dict) -> dict:
        with _lock:
            items = self.items(kind)
            item.setdefault("id", new_id({"references": "ref", "mixes": "mix", "speech": "sp"}[kind]))
            item.setdefault("created", now())
            items.append(item)
            self._save(kind, items)
            return item

    def update(self, kind: str, item_id: str, patch: dict) -> dict:
        with _lock:
            items = self.items(kind)
            for it in items:
                if it["id"] == item_id:
                    it.update(patch)
                    it["modified"] = now()
                    self._save(kind, items)
                    return it
            raise KeyError(item_id)

    def remove(self, kind: str, item_id: str, delete_copied: bool = False) -> None:
        """Remove from the library. Original files are never deleted; copies inside the workspace only on request."""
        with _lock:
            items = self.items(kind)
            keep = [it for it in items if it["id"] != item_id]
            self._save(kind, keep)
            if delete_copied:
                d = self.root / "audio" / item_id
                if d.is_dir() and d.resolve().is_relative_to(self.root):
                    shutil.rmtree(d)

    @staticmethod
    def files_of(item: dict) -> list:
        out = []
        for key in ("master", "mix"):
            if item.get(key):
                out.append(item[key])
        for key in ("stems", "raw", "mics"):
            out += [x["file"] for x in item.get(key, []) or []]
        return out

    def missing(self) -> list:
        res = []
        for kind in KINDS:
            for it in self.items(kind):
                for f in self.files_of(it):
                    if not Path(f["path"]).is_file():
                        res.append({"kind": kind, "item_id": it["id"], "item": it.get("title") or it.get("name"), "file_id": f["id"],
                                    "name": f["name"], "path": f["path"]})
        return res

    def relink(self, kind: str, item_id: str, file_id: str, new_path: str, force: bool = False) -> dict:
        with _lock:
            items = self.items(kind)
            for it in items:
                if it["id"] != item_id:
                    continue
                for f in self.files_of(it):
                    if f["id"] == file_id:
                        p = Path(new_path).expanduser().resolve()
                        fp = fingerprint(p)
                        if fp != f["fingerprint"] and not force:
                            return {"ok": False, "reason": "That file's content differs from the original import. "
                                                           "Choose the same file, or relink anyway to accept the change."}
                        f.update({"path": str(p), "fingerprint": fp, "size": p.stat().st_size, "mtime": p.stat().st_mtime,
                                  "relinked": now()})
                        self._save(kind, items)
                        return {"ok": True}
            raise KeyError(file_id)

    # ---- profiles
    def profiles(self) -> list:
        out = []
        for d in sorted((self.root / "profiles").iterdir()) if (self.root / "profiles").is_dir() else []:
            m = read_json(d / "meta.json")
            if m:
                out.append(m)
        return sorted(out, key=lambda m: m.get("created", ""), reverse=True)

    def profile_dir(self, pid: str) -> Path:
        return self.root / "profiles" / pid

    # ---- experiments
    def experiments(self, include_archived=True) -> list:
        out = []
        d = self.root / "experiments"
        for e in d.iterdir() if d.is_dir() else []:
            m = read_json(e / "experiment.json")
            if m and (include_archived or not m.get("archived")):
                out.append(m)
        return sorted(out, key=lambda m: m.get("created", ""), reverse=True)

    def exp_dir(self, eid: str) -> Path:
        return self.root / "experiments" / eid

    def experiment(self, eid: str) -> dict:
        m = read_json(self.exp_dir(eid) / "experiment.json")
        if not m:
            raise KeyError(eid)
        return m

    def save_experiment(self, exp: dict):
        atomic_write_json(self.exp_dir(exp["id"]) / "experiment.json", exp)

    # ---- housekeeping
    def usage(self) -> dict:
        def size(p: Path):
            return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0
        ext = 0
        for kind in KINDS:
            for it in self.items(kind):
                for f in self.files_of(it):
                    if f.get("stored") == "external" and Path(f["path"]).is_file():
                        ext += Path(f["path"]).stat().st_size
        return {"copied_audio": size(self.root / "audio"), "experiments": size(self.root / "experiments"),
                "profiles": size(self.root / "profiles"), "exports": size(self.root / "exports"),
                "cache": size(self.root / ".cache") + size(self.root / ".staging"), "external_audio_referenced": ext}

    def backup(self, dest: Path, include_audio: bool = False) -> str:
        """Zip the workspace (library, profiles, experiments, feedback). Audio only if asked."""
        dest = Path(dest)
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
            for f in self.root.rglob("*"):
                rel = f.relative_to(self.root)
                if not f.is_file() or rel.parts[0] in (".staging", ".cache"):
                    continue
                if not include_audio and f.suffix.lower() in (".wav", ".aif", ".aiff", ".flac"):
                    continue
                z.write(f, rel.as_posix())
        return str(dest)

    def summary(self) -> dict:
        exps = self.experiments()
        fb = 0
        trials = 0
        for e in exps:
            f = read_json(self.exp_dir(e["id"]) / "feedback.json", {}) or {}
            fb += sum(len(f.get(k, [])) for k in ("decisions", "notes", "missed")) + len(f.get("overall", []))
            trials += len((read_json(self.exp_dir(e["id"]) / "listening.json", {}) or {}).get("trials", []))
        return {"root": str(self.root), "name": self.manifest["name"], "id": self.manifest["id"], "settings": self.manifest["settings"],
                "counts": {"references": len(self.items("references")), "mixes": len(self.items("mixes")), "speech": len(self.items("speech")),
                           "profiles": len(self.profiles()), "experiments": len(exps),
                           "experiments_complete": sum(1 for e in exps if e.get("status") == "complete"),
                           "feedback_items": fb, "listening_trials": trials}}


def safe_name(s: str) -> str:
    keep = "".join(c if c.isalnum() or c in " -_." else "_" for c in s).strip()
    return keep or "workspace"
