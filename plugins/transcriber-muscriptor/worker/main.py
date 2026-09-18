"""Audio to notes with MuScriptor, a transformer language model over note events.

Unlike Basic Pitch this one names the instrument it heard, which is worth more
than it sounds: a bass line found inside the `other` stem is still a bass line,
and the harmony engine weights notes by where they came from. It is also much
slower and much larger, which is why it is the `full` profile and Basic Pitch is
the baseline.

Job:
    {"kind": "transcribe", "input": "<abs wav>", "stem": "other"}
    -> {"notes": [{"midi": 60, "startSec": .5, "endSec": 1.0, "instrument": "Acoustic Grand Piano"}], ...}
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from decomposable_worker import Job, Progress, Worker, log, serve

SIZES = {"lite": "small", "full": "large"}


class MuScriptor(Worker):
    name = "transcriber-muscriptor"
    version = "1.0.0"
    capabilities = ["transcribe"]

    def __init__(self) -> None:
        self.model = None
        self.model_id = "small"
        self.device = "cpu"

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        from muscriptor import TranscriptionModel

        self.model_id = model or SIZES.get(profile, "small")
        self.device = _resolve_device(device)
        started = time.time()
        # Weights come from HuggingFace on first use and are cached under
        # ~/.cache/muscriptor; nothing is committed (ADR-008).
        self.model = TranscriptionModel.load_model(weights_path=self.model_id, device=self.device)
        log(f"muscriptor {self.model_id} loaded on {self.device} in {time.time() - started:.1f}s")

    def run(self, job: Job, progress: Progress) -> Any:
        if job.get("kind") != "transcribe":
            raise ValueError(f"unknown job kind {job.get('kind')!r}")
        from muscriptor.events import NoteEndEvent, NoteStartEvent, ProgressEvent

        source = Path(job["input"])
        started = time.time()
        stem = job.get("stem", "audio")
        progress(0.02, f"transcribing {stem} with muscriptor {self.model_id}")

        notes = []
        for event in self.model.transcribe(
            str(source),
            beam_size=int(job.get("beamSize", 1)),
            **({"instruments": job["instruments"]} if job.get("instruments") else {}),
        ):
            # Cancellation is checked between events rather than only between
            # jobs: a `large` decode of a whole song is minutes, not seconds.
            progress.raise_if_cancelled()
            if isinstance(event, ProgressEvent):
                if event.total:
                    progress(min(0.99, event.completed / event.total), f"transcribing {stem}")
            elif isinstance(event, NoteEndEvent):
                start = event.start_event
                if event.end_time > start.start_time:
                    notes.append(
                        {
                            "midi": int(start.pitch),
                            "startSec": float(start.start_time),
                            "endSec": float(event.end_time),
                            "instrument": str(start.instrument),
                        }
                    )
            elif not isinstance(event, NoteStartEvent):
                log(f"ignoring unexpected event {type(event).__name__}")

        notes.sort(key=lambda note: (note["startSec"], note["midi"]))
        progress(1.0, "done")
        return {
            "notes": notes,
            "model": f"muscriptor-{self.model_id}",
            "device": self.device,
            "elapsedSec": round(time.time() - started, 2),
        }

    def shutdown(self) -> None:
        self.model = None


def _resolve_device(requested: str) -> str:
    """Never fail because a device is missing: the baseline is always the CPU."""
    import torch

    if requested == "cuda" and torch.cuda.is_available():
        return "cuda"
    if requested == "mps" and torch.backends.mps.is_available():
        return "mps"
    if requested in ("cuda", "mps"):
        log(f"{requested} was asked for but is not available here; falling back to cpu")
    return "cpu"


serve(MuScriptor())
