"""Stage Lab library items into the research backend's folder layout.

The backend (research/intelligence, package `mi`) reads a workspace laid out as
references/<song>/{master.wav, stems/}, mixes/<mix>/{stems/, mix.wav, raw/, mix.toml},
speech/<name>/{mics/, speech.toml} and config.toml. Rather than reimplementing any of it,
every Lab job builds that layout in <workspace>/.staging/<job>/ from LINKS to the engineer's
files (symlinks; hard links or copies where symlinks are unavailable), with the engineer's
source assignments written as explicit `[roles]` tables. The same audio and settings therefore
produce the same results in the Lab and on the command line.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


# ----------------------------------------------------------------------------- TOML writer
def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(float(v)) if isinstance(v, float) else str(v)
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    raise TypeError(f"unsupported TOML value {v!r}")


def to_toml(d: dict) -> str:
    """Minimal TOML for the backend's config files: scalars, arrays, tables, arrays of tables."""
    lines, tables, arrays = [], [], []
    for k, v in d.items():
        if isinstance(v, dict):
            tables.append((k, v))
        elif isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            arrays.append((k, v))
        elif v is not None:
            lines.append(f"{_key(k)} = {_toml_value(v)}")

    def emit_table(prefix, t):
        out = [f"\n[{prefix}]"]
        sub = []
        for k, v in t.items():
            if isinstance(v, dict):
                sub.append((f"{prefix}.{_key(k)}", v))
            elif v is not None:
                out.append(f"{_key(k)} = {_toml_value(v)}")
        for p, st in sub:
            out += emit_table(p, st)
        return out

    for k, t in tables:
        lines += emit_table(_key(k), t)
    for k, arr in arrays:
        for t in arr:
            lines.append(f"\n[[{_key(k)}]]")
            lines += [f"{_key(kk)} = {_toml_value(vv)}" for kk, vv in t.items() if vv is not None]
    return "\n".join(lines).lstrip("\n") + "\n"


def _key(k: str) -> str:
    return k if k.replace("_", "").replace("-", "").isalnum() else _toml_value(str(k))


# ----------------------------------------------------------------------------- linking
def link(src: Path, dest: Path) -> str:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        dest.unlink()
    try:
        os.symlink(src, dest)
        return "symlink"
    except (OSError, NotImplementedError):
        pass
    try:
        os.link(src, dest)
        return "hardlink"
    except OSError:
        shutil.copy2(src, dest)
        return "copy"


def _ext(path: str) -> str:
    return Path(path).suffix.lower() or ".wav"


def stage_stems(entries: list, folder: Path) -> dict:
    """entries: [{"file": {path}, "group": g}] -> links named '<group> NN.ext'; returns the [roles] table."""
    roles, counts = {}, {}
    for e in entries:
        g = e.get("group")
        if not g or g == "exclude":
            continue
        counts[g] = counts.get(g, 0) + 1
        stem = f"{g} {counts[g]:02d}"
        link(Path(e["file"]["path"]), folder / f"{stem}{_ext(e['file']['path'])}")
        roles[stem] = g
    return roles


def stage_reference(ref: dict, root: Path, weight: float | None = None) -> None:
    d = root / "references" / ref["id"]
    if ref.get("master"):
        link(Path(ref["master"]["path"]), d / f"master{_ext(ref['master']['path'])}")
    roles = stage_stems(ref.get("stems", []), d / "stems")
    meta = {"title": ref.get("title") or ref["id"], "kind": ref.get("category", "music"),
            "weight": float(ref.get("weight", 1.0) if weight is None else weight), "exclude": not ref.get("include", True),
            "roles": roles}
    (d / "reference.toml").write_text(to_toml(meta))


def stage_mix(mix: dict, root: Path, baseline=None, injections=None, tacet=None) -> str:
    name = mix["id"]
    d = root / "mixes" / name
    roles = stage_stems(mix.get("stems", []), d / "stems")
    if mix.get("mix"):
        link(Path(mix["mix"]["path"]), d / f"mix{_ext(mix['mix']['path'])}")
    if mix.get("raw"):
        stage_stems(mix["raw"], d / "raw")
    meta = {"roles": roles}
    bl = baseline if baseline is not None else mix.get("baseline")
    if bl:
        meta["baseline"] = bl
    if injections:
        meta["inject"] = [{"group": j["group"], "db": float(j["db"]), "start": float(j["start"]), "end": float(j["end"])} for j in injections]
    tac = tacet if tacet is not None else mix.get("tacet")
    if tac:
        meta["tacet"] = [{"group": t["group"], "start": float(t["start"]), "end": float(t["end"])} for t in tac]
    (d / "mix.toml").write_text(to_toml(meta))
    return name


def stage_speech(sp: dict, root: Path, settings: dict) -> str:
    name = sp["id"]
    d = root / "speech" / name
    used, weights, exclude = set(), {}, []
    for m in sp.get("mics", []):
        base = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (m.get("name") or Path(m["file"]["name"]).stem)).strip() or "mic"
        stem = base
        k = 2
        while stem in used:
            stem, k = f"{base} {k}", k + 1
        used.add(stem)
        m["_stem"] = stem
        if m.get("role", "speech") != "speech":
            exclude.append(stem)  # audience / excluded mics never join the speech automix set
            continue
        link(Path(m["file"]["path"]), d / "mics" / f"{stem}{_ext(m['file']['path'])}")
        weights[stem] = float(m.get("weight_db", 0.0))
    meta = {k: settings[k] for k in ("target_lufs", "last_hold", "depth_db") if k in settings}
    meta["exclude"] = exclude
    meta["weights"] = weights
    (d / "speech.toml").write_text(to_toml(meta))
    return name


def write_config(root: Path, cfg: dict) -> None:
    (root / "config.toml").write_text(to_toml(cfg))


def clean(root: Path) -> None:
    shutil.rmtree(root, ignore_errors=True)
