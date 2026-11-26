"""Merge Intelligence Lab entry point.

Double-click the app: this starts the local server and opens the window. There is nothing
to configure. Developer/CI options (never needed by the engineer):

    --serve            run without a window and print the URL (browser testing)
    --port N           fixed port (default: a free one)
    --selftest         headless end-to-end check of the packaged app, then exit
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import sys
import threading
from pathlib import Path


def _prepare_env():
    from .paths import user_settings_dir
    os.environ.setdefault("MPLBACKEND", "Agg")
    os.environ.setdefault("MPLCONFIGDIR", str(user_settings_dir() / "matplotlib"))


class DesktopApi:
    """Called from the UI through pywebview (native dialogs, Finder, clipboard)."""

    def __init__(self, state):
        self.state = state
        self.window = None

    def _dialog(self, kind, multiple=False, types=(), directory="", save_name=""):
        import webview
        d = {"open": webview.FileDialog.OPEN, "folder": webview.FileDialog.FOLDER, "save": webview.FileDialog.SAVE}[kind]
        res = self.window.create_file_dialog(d, directory=directory, allow_multiple=multiple, save_filename=save_name,
                                             file_types=tuple(types))
        if not res:
            return None
        return list(res) if isinstance(res, (list, tuple)) else [res]

    def open_audio(self, multiple=True):
        return self._dialog("open", multiple, ("Audio files (*.wav;*.aif;*.aiff;*.flac;*.WAV)", "All files (*.*)"))

    def open_folder(self):
        r = self._dialog("folder")
        return r[0] if r else None

    def save_file(self, name="research.zip"):
        r = self._dialog("save", save_name=name)
        return r[0] if r else None


def run_window(state, url):
    import webview
    api = DesktopApi(state)
    state.desktop = api
    win = webview.create_window("Merge Intelligence Lab", url, js_api=api, width=1440, height=920, min_size=(1100, 700),
                                background_color="#101214")
    api.window = win

    def on_loaded():
        print("[lab] window loaded", flush=True)
        # Finder drag and drop: pywebview resolves the real file paths on the Python side
        try:
            from webview.dom import DOMEventHandler
            def on_drop(e):
                files = e.get("dataTransfer", {}).get("files", [])
                paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
                if paths:
                    win.evaluate_js(f"window.labDropped && window.labDropped({json.dumps(paths)})")
            win.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
            win.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, True)
        except Exception as ex:  # drag and drop is a convenience; dialogs always work
            print("drag and drop unavailable:", ex)
    win.events.loaded += on_loaded
    webview.start(debug=bool(os.environ.get("MIL_DEBUG")), private_mode=False)


def main(argv=None):
    multiprocessing.freeze_support()
    _prepare_env()
    ap = argparse.ArgumentParser(prog="merge-intelligence-lab")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--selftest-dir")
    a, _ = ap.parse_known_args(argv)
    if a.selftest:
        from .selftest import run
        sys.exit(run(a.selftest_dir))
    from .server import LabState, start_server
    state = LabState()
    srv = start_server(state, a.port)
    url = f"http://127.0.0.1:{srv.server_address[1]}/#t={state.token}"
    if a.serve:
        print(url, flush=True)
        threading.Event().wait()
    else:
        run_window(state, url)
    srv.shutdown()


if __name__ == "__main__":
    main()
