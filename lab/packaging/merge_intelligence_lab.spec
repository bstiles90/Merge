# PyInstaller spec for Merge Intelligence Lab. Build with:  python lab/packaging/build.py
# Bundles the Lab (lab/mil), its web UI (lab/web) and the research backend (research/intelligence/mi)
# so the packaged app needs no Python, Terminal or configuration on the engineer's machine.
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

LAB = Path(SPECPATH).parent
REPO = LAB.parent
APP = "Merge Intelligence Lab"
VERSION = os.environ.get("MIL_VERSION", "0.1.0")
sys.path[:0] = [str(LAB), str(REPO / "research" / "intelligence")]

hidden = collect_submodules("mi") + collect_submodules("mil") + ["scipy.signal", "soundfile", "matplotlib.backends.backend_agg"]
if sys.platform == "darwin":
    hidden += ["webview.platforms.cocoa"]
elif sys.platform == "win32":
    hidden += ["webview.platforms.edgechromium", "webview.platforms.winforms"]

datas = [(str(LAB / "web"), "web")]
stamp = LAB / "packaging" / "build_info.json"
if stamp.is_file():
    datas.append((str(stamp), "."))

a = Analysis([str(LAB / "launch.py")], pathex=[str(LAB), str(REPO / "research" / "intelligence")], datas=datas,
             hiddenimports=hidden, excludes=["tkinter", "pytest", "IPython", "PyQt5", "PyQt6", "PySide2", "PySide6", "pyloudnorm"],
             noarchive=False)
pyz = PYZ(a.pure)
icon = LAB / "packaging" / ("icon.icns" if sys.platform == "darwin" else "icon.ico")
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name=APP, console=False, argv_emulation=False,
          icon=str(icon) if icon.is_file() else None, codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, name=APP)
if sys.platform == "darwin":
    app = BUNDLE(coll, name=f"{APP}.app", icon=str(icon) if icon.is_file() else None, bundle_identifier="com.merge.intelligence-lab",
                 version=VERSION,
                 info_plist={"CFBundleShortVersionString": VERSION, "CFBundleVersion": VERSION, "NSHighResolutionCapable": True,
                             "LSMinimumSystemVersion": "11.0", "NSRequiresAquaSystemAppearance": False,
                             "LSApplicationCategoryType": "public.app-category.music",
                             "CFBundleDisplayName": APP})
