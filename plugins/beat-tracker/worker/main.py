"""Beat and downbeat tracking.

`lite` is librosa's onset-strength beat tracker: CPU only, no weights to
download, and no opinion about where the bar starts. `full` is Beat This!, a
transformer that finds downbeats as well and is worth the model download when
the bar line matters.

Job:
    {"kind": "beats", "input": "<abs wav>"}
    -> {"beats": [{"timeSec": 0.5, "beatInBar": 1, "bpm": 120.0}], "bpm": 120.0, ...}

`beatInBar` is 1 on a downbeat and 0 when the model has no idea, which is
always the case for librosa. Downstream must treat 0 as "unknown", not as "not
a downbeat": the harmony engine only needs the boundaries, but a lead sheet
needs the bar lines and should say so when it does not have them.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from decomposable_worker import Job, Progress, Worker, log, serve

LITE = "librosa"
FULL = "beat-this"


class BeatTracker(Worker):
    name = "beat-tracker"
    version = "1.0.0"
    capabilities = ["beats"]

    def __init__(self) -> None:
        self.model_id = LITE
        self.device = "cpu"
        self.tracker = None

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        self.model_id = model or (FULL if profile == "full" else LITE)
        self.device = _resolve_device(device if self.model_id == FULL else "cpu")
        if self.model_id == FULL:
            from beat_this.inference import File2Beats

            started = time.time()
            # Weights are downloaded on first use and never committed (ADR-008).
            self.tracker = File2Beats(checkpoint_path="final0", device=self.device, dbn=False)
            log(f"beat_this loaded on {self.device} in {time.time() - started:.1f}s")
        else:
            import librosa  # noqa: F401  (paid for here rather than inside the first job)

            log("librosa beat tracker ready on cpu")

    def run(self, job: Job, progress: Progress) -> Any:
        if job.get("kind") != "beats":
            raise ValueError(f"unknown job kind {job.get('kind')!r}")
        source = Path(job["input"])
        started = time.time()
        progress(0.05, f"tracking beats with {self.model_id}")

        if self.model_id == FULL:
            beats, downbeats = self.tracker(str(source))
            beats = np.asarray(beats, dtype=float)
            downbeats = set(np.round(np.asarray(downbeats, dtype=float), 4).tolist())
        else:
            import librosa

            y, sr = librosa.load(str(source), sr=22050, mono=True)
            progress.raise_if_cancelled()
            _, frames = librosa.beat.beat_track(y=y, sr=sr, units="time")
            beats = np.asarray(frames, dtype=float)
            downbeats = set()

        progress(0.9, "labelling bars")
        bpm = _tempo(beats)
        out = []
        position = 0
        for t in beats:
            if downbeats:
                if round(float(t), 4) in downbeats:
                    position = 1
                elif position:
                    position += 1
            out.append({"timeSec": float(t), "beatInBar": int(position), "bpm": bpm})

        progress(1.0, "done")
        return {
            "beats": out,
            "bpm": bpm,
            "downbeats": len(downbeats),
            "model": self.model_id,
            "device": self.device,
            "elapsedSec": round(time.time() - started, 2),
        }

    def shutdown(self) -> None:
        self.tracker = None


def _tempo(beats: np.ndarray) -> float | None:
    """Median inter-beat interval, which is steadier than the mean on rubato."""
    if len(beats) < 2:
        return None
    gaps = np.diff(beats)
    gaps = gaps[gaps > 0]
    return round(float(60.0 / np.median(gaps)), 2) if len(gaps) else None


def _resolve_device(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    import torch

    if requested == "cuda" and torch.cuda.is_available():
        return "cuda"
    if requested == "mps" and torch.backends.mps.is_available():
        return "mps"
    if requested in ("cuda", "mps"):
        log(f"{requested} was asked for but is not available here; falling back to cpu")
    return "cpu"


serve(BeatTracker())
