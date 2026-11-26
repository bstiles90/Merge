"""Build Merge Intelligence Lab with PyInstaller (used by CI; works locally too).

    python lab/packaging/build.py            # -> lab/dist/Merge Intelligence Lab(.app)

Stamps build_info.json (version, git commit, date) into the bundle so the app and every
experiment record exactly which build produced them.
"""

import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
REPO = LAB.parent


def main():
    sys.path.insert(0, str(LAB))
    sys.path.insert(0, str(REPO / "research" / "intelligence"))
    from mil import APP_VERSION
    import mi
    version = os.environ.get("MIL_VERSION", APP_VERSION)
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    stamp = {"app_version": version, "git_commit": commit, "algorithm_version": mi.ALGORITHM_VERSION,
             "build_date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "build_number": os.environ.get("GITHUB_RUN_NUMBER")}
    (LAB / "packaging" / "build_info.json").write_text(json.dumps(stamp, indent=1))
    print("build info:", stamp)
    env = dict(os.environ, MIL_VERSION=version)
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", str(LAB / "dist"),
                    "--workpath", str(LAB / "build"), str(LAB / "packaging" / "merge_intelligence_lab.spec")], check=True, env=env)


if __name__ == "__main__":
    main()
