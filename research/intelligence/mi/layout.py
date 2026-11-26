"""Workspace folder conventions and source-role mapping.

A workspace is a folder you point the prototype at:

    <workspace>/
      config.toml                       optional: groups, permissions, controller settings
      references/<song>/master.wav      the mastered 2-track
      references/<song>/stems/*.wav     its stems (Logic Stem Splitter names are recognised)
      references/<song>/reference.toml  optional: title, weight, exclude, role overrides, kind
      mixes/<name>/stems/*.wav          comparison mix: post-processing group stems (pre-master)
      mixes/<name>/mix.wav              optional: the 2-track of the same mix
      mixes/<name>/raw/*.wav            optional: the same groups BEFORE their plugins
      mixes/<name>/mix.toml             optional: baseline window, annotations, injections
      speech/<name>/mics/*.wav          speech prototype: one file per microphone
      speech/<name>/speech.toml         optional: weights, target loudness, roles

See docs/MERGE_INTELLIGENCE_AUDIO_SPEC.md for the full specification.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

from .audio_io import AUDIO_EXT

# Five proof-of-concept source groups (vision §24). Order is the report order.
# Six source groups since algorithm 0.5.0: Keys (piano, organ, Rhodes...) and Synths (pads, synths,
# atmospheres, strings, "other") are separate. Profiles built earlier store "keys" meaning keys + other.
GROUPS = ["vocals", "drums", "bass", "guitars", "keys", "synths"]
GROUP_LABEL = {"vocals": "Vocals", "drums": "Drums", "bass": "Bass", "guitars": "Guitars", "keys": "Keys", "synths": "Synths"}

# Filename keyword -> group. Checked in order; first match wins. Logic Pro's Stem Splitter
# produces Vocals / Drums / Bass / Guitar / Piano / Other.
ROLE_KEYWORDS = [
    ("drums", ["drum", "kit", "kick", "snare", "tom", "overhead", "oh", "cymbal", "hat", "hihat", "perc", "room"]),
    ("bass", ["bass", "sub"]),
    ("guitars", ["guitar", "gtr", "eg", "ag", "electric", "acoustic"]),
    ("synths", ["synth", "pad", "arp"]),                      # explicit instrument words win over "lead"
    ("keys", ["piano", "key", "organ", "rhodes", "wurli"]),
    ("vocals", ["vocal", "vox", "voice", "lead", "lv", "bgv", "bv", "choir", "sing"]),
    ("synths", ["atmos", "ambient", "swell", "drone", "string", "other", "track", "loop"]),
    ("keys", ["ep", "instrument"]),
]


def role_for(filename: str, overrides: dict | None = None) -> str | None:
    """Group for a file name, matched on word prefixes (so "Toms" -> drums, "Custom" -> nothing).
    Instruments are checked before vocals ("Lead Guitar" -> guitars) and synths/keys last
    ("Vocal Track" -> vocals)."""
    stem = Path(filename).stem
    if overrides:
        for k, v in overrides.items():
            if k.lower() == stem.lower():
                return None if v in ("exclude", "ignore", "") else v
    words = re.sub(r"[^a-z0-9]", " ", stem.lower()).split()
    if any(w in ("master", "mix", "2track", "stereomix") for w in words):
        return None
    for group, keys in ROLE_KEYWORDS:
        if any(w.startswith(k) for w in words for k in keys):
            return group
    return None


def load_toml(path: Path) -> dict:
    if path.is_file():
        with open(path, "rb") as f:
            return tomllib.load(f)
    return {}


def audio_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in AUDIO_EXT and not p.name.startswith("."))


@dataclass
class StemSet:
    """Files mapped to groups. Several files may feed one group (they are summed)."""
    files: dict = field(default_factory=dict)       # group -> [Path]
    unmapped: list = field(default_factory=list)    # files that matched no role

    def groups(self) -> list[str]:
        return [g for g in GROUPS if g in self.files] + sorted(g for g in self.files if g not in GROUPS)


def map_stems(folder: Path, overrides: dict | None = None) -> StemSet:
    s = StemSet()
    for p in audio_files(folder):
        g = role_for(p.name, overrides)
        if g is None:
            s.unmapped.append(p)
        else:
            s.files.setdefault(g, []).append(p)
    return s


@dataclass
class ReferencePackage:
    name: str
    folder: Path
    master: Path | None
    stems: StemSet
    meta: dict


def find_references(workspace: Path) -> list[ReferencePackage]:
    out = []
    root = workspace / "references"
    for d in sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []:
        meta = load_toml(d / "reference.toml")
        master = None
        for cand in ("master", "mix", "stereo"):
            m = [p for p in audio_files(d) if p.stem.lower() == cand]
            if m:
                master = m[0]
                break
        stems_dir = d / "stems" if (d / "stems").is_dir() else d
        stems = map_stems(stems_dir, meta.get("roles"))
        if master is not None:
            stems.unmapped = [p for p in stems.unmapped if p != master]
        out.append(ReferencePackage(d.name, d, master, stems, meta))
    return out


@dataclass
class MixPackage:
    name: str
    folder: Path
    mix: Path | None
    stems: StemSet
    raw: StemSet | None
    meta: dict


def load_mix(folder: Path) -> MixPackage:
    meta = load_toml(folder / "mix.toml")
    mix = next((p for p in audio_files(folder) if p.stem.lower() in ("mix", "master", "stereo")), None)
    stems = map_stems(folder / "stems" if (folder / "stems").is_dir() else folder, meta.get("roles"))
    if mix is not None:
        stems.unmapped = [p for p in stems.unmapped if p != mix]
    raw = map_stems(folder / "raw", meta.get("roles")) if (folder / "raw").is_dir() else None
    return MixPackage(folder.name, folder, mix, stems, raw, meta)


def load_config(workspace: Path) -> dict:
    return load_toml(workspace / "config.toml")
