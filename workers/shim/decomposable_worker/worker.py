"""JSON-RPC over stdio, worker side.

Requests arrive on stdin as one JSON object per line and are answered on stdout
the same way:

    -> {"id": 1, "method": "hello",  "params": {"device": "cpu", "model": "..."}}
    <- {"id": 1, "result": {"name": "echo", "version": "1.0.0", ...}}
    -> {"id": 2, "method": "run",    "params": {"kind": "echo", ...}}
    <- {"method": "progress", "params": {"id": 2, "progress": 0.5}}
    <- {"id": 2, "result": {...}}
    -> {"method": "cancel",   "params": {"id": 2}}
    -> {"method": "shutdown", "params": {}}

Jobs run on a single background thread so that `cancel` and `shutdown` are still
heard while a model is busy. stdout is rebound to stderr before any user code
runs, so a stray ``print`` in a worker cannot corrupt the protocol.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from dataclasses import dataclass
from typing import Any, Callable

Job = dict[str, Any]


@dataclass
class Progress:
    """Passed to ``Worker.run``: report progress, and notice cancellation."""

    _emit: Callable[[float, str | None], None]
    _cancelled: threading.Event

    def __call__(self, fraction: float, message: str | None = None) -> None:
        self._emit(fraction, message)

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def raise_if_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise Cancelled()


class Cancelled(Exception):
    """Raised inside a job when the kernel cancels it."""


class Worker:
    """Subclass this, set ``name`` and ``version``, implement ``run``."""

    name: str = "worker"
    version: str = "0.0.0"
    capabilities: list[str] = []

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        """Load the model. Must finish inside the manifest's warm-up budget."""

    def run(self, job: Job, progress: Progress) -> Any:
        raise NotImplementedError

    def shutdown(self) -> None:
        """Release anything the process holds. Called before exit."""


class _Channel:
    def __init__(self, out) -> None:
        self._out = out
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, separators=(",", ":"), default=_fallback)
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()


def _fallback(value: Any) -> Any:
    if hasattr(value, "tolist"):  # numpy arrays and scalars
        return value.tolist()
    return str(value)


def log(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


def serve(worker: Worker) -> None:
    # Claim the real stdout, then point everything else at stderr.
    out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    sys.stdout = sys.stderr
    channel = _Channel(out)

    jobs: "queue.Queue[tuple[int, Job] | None]" = queue.Queue()
    cancels: dict[int, threading.Event] = {}
    lock = threading.Lock()

    def work() -> None:
        while True:
            item = jobs.get()
            if item is None:
                return
            call_id, params = item
            with lock:
                cancelled = cancels.setdefault(call_id, threading.Event())
            progress = Progress(
                _emit=lambda f, m, _id=call_id: channel.send(
                    {"method": "progress", "params": {"id": _id, "progress": f, "message": m}}
                ),
                _cancelled=cancelled,
            )
            try:
                result = worker.run(params, progress)
                channel.send({"id": call_id, "result": result})
            except Cancelled:
                channel.send({"id": call_id, "error": {"message": "cancelled", "cancelled": True}})
            except Exception as error:  # a bad job must not take the process down
                channel.send(
                    {
                        "id": call_id,
                        "error": {"message": f"{type(error).__name__}: {error}", "traceback": traceback.format_exc()},
                    }
                )
            finally:
                with lock:
                    cancels.pop(call_id, None)

    thread = threading.Thread(target=work, name="decomposable-worker-jobs", daemon=True)
    thread.start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            log(f"ignoring malformed line: {line[:200]}")
            continue

        method = message.get("method")
        call_id = message.get("id")
        params = message.get("params") or {}

        if method == "hello":
            try:
                worker.load(
                    params.get("device", os.environ.get("DECOMPOSABLE_DEVICE", "cpu")),
                    params.get("model", os.environ.get("DECOMPOSABLE_MODEL", "")),
                    params.get("profile", os.environ.get("DECOMPOSABLE_PROFILE", "lite")),
                    params.get("config"),
                )
            except Exception as error:
                channel.send(
                    {
                        "id": call_id,
                        "error": {"message": f"load failed: {error}", "traceback": traceback.format_exc()},
                    }
                )
                continue
            channel.send(
                {
                    "id": call_id,
                    "result": {
                        "name": worker.name,
                        "version": worker.version,
                        "device": params.get("device", "cpu"),
                        "model": params.get("model", ""),
                        "pid": os.getpid(),
                        "capabilities": worker.capabilities,
                    },
                }
            )
        elif method == "run":
            if not isinstance(call_id, int):
                log("ignoring run without an id")
                continue
            with lock:
                cancels[call_id] = threading.Event()
            jobs.put((call_id, params))
        elif method == "cancel":
            with lock:
                event = cancels.get(params.get("id"))
            if event:
                event.set()
        elif method == "shutdown":
            break
        else:
            if isinstance(call_id, int):
                channel.send({"id": call_id, "error": {"message": f"unknown method {method!r}"}})

    jobs.put(None)
    try:
        worker.shutdown()
    finally:
        out.close()
