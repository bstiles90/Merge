"""Where things live: the research backend, the bundled web UI, per-user settings."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from . import APP_NAME, APP_VERSION

FROZEN = getattr(sys, "frozen", False)
BUNDLE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))  # lab/ in development
REPO = Path(__file__).resolve().parents[2]                                        # development only


def ensure_backend_importable() -> None:
    """Development: put research/intelligence on sys.path. Packaged: `mi` is bundled."""
    try:
        import mi  # noqa: F401
        return
    except ImportError:
        pass
    cand = REPO / "research" / "intelligence"
    if cand.is_dir():
        sys.path.insert(0, str(cand))


def web_root() -> Path:
    return BUNDLE / "web"


def user_settings_dir() -> Path:
    if os.environ.get("MIL_SETTINGS_DIR"):  # tests and the self-test: isolated settings
        d = Path(os.environ["MIL_SETTINGS_DIR"])
    elif sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / APP_NAME
    elif os.name == "nt":
        d = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
    else:
        d = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "merge-intelligence-lab"
    d.mkdir(parents=True, exist_ok=True)
    return d


def default_workspace_parent() -> Path:
    docs = Path.home() / "Documents"
    return (docs if docs.is_dir() else Path.home()) / APP_NAME


def build_info() -> dict:
    """App version, algorithm version and git commit (stamped by the build; `git` in development)."""
    info = {"app_version": APP_VERSION, "git_commit": None, "build_date": None, "frozen": FROZEN}
    stamp = BUNDLE / "build_info.json"
    if stamp.is_file():
        try:
            info.update(json.loads(stamp.read_text()))
        except Exception:
            pass
    if not info.get("git_commit") and not FROZEN:
        try:
            info["git_commit"] = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
                                                capture_output=True, text=True, timeout=3).stdout.strip() or None
        except Exception:
            pass
    try:
        ensure_backend_importable()
        import mi
        info["algorithm_version"] = mi.ALGORITHM_VERSION
    except Exception as e:  # pragma: no cover
        info["algorithm_version"] = None
        info["backend_error"] = str(e)
    info["python"] = sys.version.split()[0]
    info["platform"] = sys.platform
    return info
