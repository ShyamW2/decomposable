"""The echo worker: no model, just enough behaviour to prove the plumbing.

Job kinds:
  echo  {text, delayMs}  -> {text, workerVersion, device, model, pid}
  crash {}               -> raises, to show a bad job does not kill the process
  hog   {mib}            -> allocates memory, to show the supervisor's limit bites
"""

from __future__ import annotations

import os
import time
from typing import Any

from decomposable_worker import Job, Progress, Worker, log, serve


class Echo(Worker):
    name = "echo"

    def __init__(self) -> None:
        # The whole point of the demo: two "versions" of one worker that are
        # otherwise identical, so a swap is visible in the result of a call.
        self.version = f"{os.environ.get('ECHO_VERSION', '1')}.0.0"
        self.device = "cpu"
        self.model = ""

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        self.device = device
        self.model = model
        warmup = float(os.environ.get("ECHO_WARMUP_MS", "0")) / 1000
        if warmup:
            time.sleep(warmup)
        log(f"echo v{self.version} loaded on {device} as {model}")

    def run(self, job: Job, progress: Progress) -> Any:
        kind = job.get("kind", "echo")
        if kind == "crash":
            raise ValueError("this job was asked to fail")
        if kind == "hog":
            mib = int(job.get("mib", 256))
            self._ballast = bytearray(mib * 1024 * 1024)
            time.sleep(30)
            return {"allocatedMiB": mib}
        if kind != "echo":
            raise ValueError(f"unknown job kind {kind!r}")

        delay = float(job.get("delayMs", 0)) / 1000
        steps = 20 if delay else 1
        for step in range(steps):
            progress.raise_if_cancelled()
            if delay:
                time.sleep(delay / steps)
            progress((step + 1) / steps)
        return {
            "text": job.get("text", ""),
            "workerVersion": self.version,
            "device": self.device,
            "model": self.model,
            "pid": os.getpid(),
        }


serve(Echo())
