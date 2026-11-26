"""Stress test: validate a full-length six-stem import in the (packaged) Lab and check that it stays responsive.

    python lab/tests/stress_validate.py "<app executable or 'dev'>" [minutes] [48k24|44k1float]

Starts the app with --serve, writes six stereo 24-bit stems plus a stereo mix (default 7 minutes),
then runs the import check exactly as the Music Lab wizard does, while measuring
  - total time and progress,
  - API latency during the check (the window talks to this API; a stall freezes the UI),
  - memory of the main process and of the job process,
and finally checks that a running check can be cancelled. Exits non-zero on failure.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

LIMIT_S = 180          # a full check must finish well within this
LATENCY_LIMIT_S = 2.0  # worst API response while a check runs
QUIET_LIMIT_S = 15.0   # longest acceptable time without a progress update


def make_files(d: Path, minutes: float, sr: int = 48000, subtype: str = "PCM_24", stem_short_s: float = 0.0) -> None:
    rng = np.random.default_rng(0)
    names = ["Vocals", "Drums", "Bass", "Guitars", "Keys", "Synths"]
    for n in names:
        with sf.SoundFile(d / f"{n}.wav", "w", sr, 2, subtype) as f:
            for _ in range(int(minutes * 6)):
                f.write((0.05 * rng.standard_normal((sr * 10, 2))).astype(np.float32))
    hs = [sf.SoundFile(d / f"{n}.wav") for n in names]
    with sf.SoundFile(d / "Mix.wav", "w", sr, 2, subtype) as f:
        while True:
            b = [h.read(sr * 10, dtype="float32") for h in hs]
            if not len(b[0]):
                break
            f.write(sum(b) * 0.9)
        if stem_short_s:  # the mix runs on after the stems end (common in exported multitracks)
            f.write(np.zeros((int(stem_short_s * sr), 2), np.float32))
    for h in hs:
        h.close()


def rss_mb(pid: int) -> float:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return int(out) / 1024 if out else 0.0
    except Exception:
        return 0.0


def children(pid: int) -> list[int]:
    try:
        out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
        return [int(x) for x in out]
    except Exception:
        return []


def main():
    app = sys.argv[1]
    minutes = float(sys.argv[2]) if len(sys.argv) > 2 else 7.0
    variant = sys.argv[3] if len(sys.argv) > 3 else "48k24"
    tmp = Path(tempfile.mkdtemp(prefix="mil-stress-"))
    print(f"writing six {minutes:g}-minute stems + mix ({variant}) ...", flush=True)
    if variant == "44k1float":
        make_files(tmp, minutes, 44100, "FLOAT", stem_short_s=1.3)
    else:
        make_files(tmp, minutes)
    env = dict(os.environ, MIL_SETTINGS_DIR=str(tmp / "settings"))
    cmd = [sys.executable, str(Path(__file__).resolve().parents[1] / "launch.py"), "--serve"] if app == "dev" else [app, "--serve"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    url = None
    t0 = time.time()
    while time.time() - t0 < 60:
        line = proc.stdout.readline()
        m = re.search(r"http://127\.0\.0\.1:\d+/#t=([\w-]+)", line or "")
        if m:
            url = m.group(0)
            break
    if not url:
        print("FAIL: the app did not start"); proc.kill(); sys.exit(1)
    threading.Thread(target=lambda: [print("[app]", l.rstrip(), flush=True) for l in proc.stdout], daemon=True).start()
    base, tok = url.split("/#")[0], url.split("t=")[1]

    def call(method, path, body=None, timeout=60):
        r = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                   headers={"X-Lab-Token": tok, "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return json.loads(x.read())

    failures = []
    try:
        call("POST", "/api/workspace/create", {"parent": str(tmp), "name": "Stress"})
        groups = {"Vocals": "vocals", "Drums": "drums", "Bass": "bass", "Guitars": "guitars", "Keys": "keys", "Synths": "synths"}
        payload = {"kind": "mix", "master": str(tmp / "Mix.wav"), "files": [{"path": str(tmp / f"{n}.wav"), "group": g} for n, g in groups.items()]}
        # the wizard first inspects the files (main process), then starts the check (job process)
        a = time.time(); call("POST", "/api/files/inspect", {"paths": [str(tmp)]}); print(f"inspect: {time.time() - a:.2f} s")
        t0 = time.time()
        jid = call("POST", "/api/validate", payload)["job"]
        worst, peak_main, peak_job, last = 0.0, 0.0, 0.0, None
        last_change, quiet_worst = time.time(), 0.0
        while True:
            a = time.time()
            j = call("GET", f"/api/jobs/{jid}")["job"]
            call("GET", "/api/jobs")
            worst = max(worst, time.time() - a)
            peak_main = max(peak_main, rss_mb(proc.pid))
            for c in children(proc.pid):
                peak_job = max(peak_job, rss_mb(c))
            s = (j["stage"], j["fraction"], j.get("text"))
            quiet_worst = max(quiet_worst, time.time() - last_change)
            if s != last:
                last_change = time.time()
                print(f"{time.time() - t0:6.1f} s  {j['stage']}  {100 * j['fraction']:.0f} %  {j.get('text') or ''}", flush=True)
                last = s
            if j["status"] in ("done", "error", "cancelled"):
                break
            if time.time() - t0 > LIMIT_S:
                failures.append(f"check did not finish within {LIMIT_S} s (stuck at {j['stage']} {100 * j['fraction']:.0f} %)")
                call("POST", f"/api/jobs/{jid}/cancel", {})
                break
            time.sleep(0.25)
        took = time.time() - t0
        res = j.get("result") or {}
        print(f"result: status={j['status']} in {took:.1f} s; reconstruction {res.get('reconstruction_error_dB')} dB, "
              f"alignment {res.get('alignment_ms')} ms; worst API latency {worst * 1000:.0f} ms; "
              f"peak memory main {peak_main:.0f} MB, job {peak_job:.0f} MB; longest time without progress {quiet_worst:.1f} s", flush=True)
        if quiet_worst > QUIET_LIMIT_S:
            failures.append(f"no progress for {quiet_worst:.1f} s during the check (looks frozen to the engineer)")
        if j["status"] != "done":
            failures.append(f"check ended with status {j['status']}: {j.get('error')}")
        if res.get("reconstruction_error_dB") is None and j["status"] == "done":
            failures.append("no reconstruction error measured")
        if worst > LATENCY_LIMIT_S:
            failures.append(f"API stalled for {worst:.1f} s during the check (the window would freeze)")
        # cancel a running check
        jid = call("POST", "/api/validate", payload)["job"]
        time.sleep(3)
        call("POST", f"/api/jobs/{jid}/cancel", {})
        time.sleep(1)
        j = call("GET", f"/api/jobs/{jid}")["job"]
        left = children(proc.pid)
        print(f"cancel: status={j['status']}; job processes left: {len(left)}")
        if j["status"] != "cancelled":
            failures.append(f"cancel did not stop the check (status {j['status']})")
    except Exception as e:
        failures.append(f"{e.__class__.__name__}: {e}")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures)); sys.exit(1)
    print("PASS: full-length six-stem check finished, the API stayed responsive and cancel works")


if __name__ == "__main__":
    main()
