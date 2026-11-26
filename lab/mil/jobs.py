"""Background jobs: every analysis runs in its own process, so the window never freezes,
a crash in analysis never takes the Lab down, and Cancel really stops the work."""

from __future__ import annotations

import multiprocessing as mp
import queue
import threading
import time
import uuid

from . import tasks


class Job:
    def __init__(self, kind, payload, title, on_finish=None):
        self.id = uuid.uuid4().hex[:10]
        self.kind, self.payload, self.title, self.on_finish = kind, payload, title, on_finish
        self.status = "queued"            # queued | running | done | error | cancelled
        self.stage, self.fraction, self.text = "Waiting", 0.0, ""
        self.result = self.error = self.traceback = None
        self.created = time.time()
        self.started = self.finished = None
        self.proc = None
        self.q = None

    def public(self):
        return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status, "stage": self.stage,
                "fraction": round(self.fraction, 3), "text": self.text, "result": self.result, "error": self.error,
                "elapsed_s": round((self.finished or time.time()) - (self.started or self.created), 1)}


class JobManager:
    def __init__(self, max_running=2):
        self.ctx = mp.get_context("spawn")
        self.jobs: dict[str, Job] = {}
        self.max_running = max_running
        self.lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def submit(self, kind, payload, title, on_finish=None) -> Job:
        j = Job(kind, payload, title, on_finish)
        with self.lock:
            self.jobs[j.id] = j
        return j

    def cancel(self, jid):
        j = self.jobs.get(jid)
        if not j or j.status not in ("queued", "running"):
            return False
        if j.proc is not None and j.proc.is_alive():
            j.proc.terminate()
            j.proc.join(5)
        j.status, j.finished, j.stage = "cancelled", time.time(), "Cancelled"
        if j.on_finish:
            j.on_finish(j)
        return True

    def list(self):
        with self.lock:
            js = sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)
        return [j.public() for j in js[:50]]

    def wait(self, jid, timeout=600):
        t0 = time.time()
        while time.time() - t0 < timeout:
            j = self.jobs[jid]
            if j.status in ("done", "error", "cancelled"):
                return j
            time.sleep(0.1)
        raise TimeoutError(jid)

    def _loop(self):
        while True:
            with self.lock:
                running = [j for j in self.jobs.values() if j.status == "running"]
                queued = sorted((j for j in self.jobs.values() if j.status == "queued"), key=lambda j: j.created)
            for j in queued[: max(0, self.max_running - len(running))]:
                j.q = self.ctx.Queue()
                j.proc = self.ctx.Process(target=tasks.entry, args=(j.kind, j.payload, j.q), daemon=True)
                j.status, j.started, j.stage = "running", time.time(), "Starting"
                j.proc.start()
            for j in running:
                self._drain(j)
                if j.status == "running" and not j.proc.is_alive():
                    self._drain(j)
                    if j.status == "running":
                        j.status, j.error, j.finished = "error", f"The analysis process stopped unexpectedly (exit code {j.proc.exitcode}).", time.time()
                        if j.on_finish:
                            j.on_finish(j)
            time.sleep(0.1)

    def _drain(self, j):
        while True:
            try:
                m = j.q.get_nowait()
            except (queue.Empty, OSError, ValueError):
                return
            if m["type"] == "progress":
                j.stage, j.fraction, j.text = m["stage"], m["fraction"], m.get("text", "")
            elif m["type"] in ("done", "error"):
                if m["type"] == "done":
                    j.status, j.result, j.fraction, j.stage = "done", m["result"], 1.0, "Finished"
                else:
                    j.status, j.error, j.traceback, j.stage = "error", m["error"], m.get("traceback"), "Failed"
                j.finished = time.time()
                if j.on_finish:
                    try:
                        j.on_finish(j)
                    except Exception:
                        pass
