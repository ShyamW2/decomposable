"""Audio to notes with Spotify's Basic Pitch.

One small CNN, no GPU, no fine-tuning: the CPU baseline the 8 GB laptop profile
is defined by (O-7). It is instrument-agnostic, which means it does not tell you
what it heard, only that something was at that pitch for that long.

There is one published model, so `lite` and `full` differ in decoding rather
than in weights: `full` lowers the onset and frame thresholds and shortens the
minimum note, which finds more of a quiet inner voice and also more of the
reverb tail. The README says so; the manifest cannot.

Job:
    {"kind": "transcribe", "input": "<abs wav>", "stem": "other"}
    -> {"notes": [{"midi": 60, "startSec": 0.5, "endSec": 1.0, "velocity": 0.8}], ...}
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from decomposable_worker import Job, Progress, Worker, log, serve

PROFILES = {
    # onset threshold, frame threshold, minimum note length in ms
    "lite": (0.5, 0.3, 127.7),
    "full": (0.35, 0.22, 58.0),
}


class BasicPitch(Worker):
    name = "transcriber-basicpitch"
    version = "1.0.0"
    capabilities = ["transcribe"]

    def __init__(self) -> None:
        self.model_id = "icassp-2022"
        self.profile = "lite"
        self.device = "cpu"
        self.model = None

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        # ONNX only. The TensorFlow build of this model is half a gigabyte of
        # dependency for the same numbers, and this is the laptop baseline.
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model

        self.profile = profile if profile in PROFILES else "lite"
        self.model_id = model or f"icassp-2022-{self.profile}"
        self.device = "cpu"
        started = time.time()
        self.model = Model(ICASSP_2022_MODEL_PATH)
        log(f"basic-pitch ({self.model_id}) loaded in {time.time() - started:.1f}s from {ICASSP_2022_MODEL_PATH}")

    def run(self, job: Job, progress: Progress) -> Any:
        if job.get("kind") != "transcribe":
            raise ValueError(f"unknown job kind {job.get('kind')!r}")
        from basic_pitch.inference import predict

        source = Path(job["input"])
        onset, frame, minimum = PROFILES[self.profile]
        started = time.time()
        # `predict` has no progress callback and does not stream, so the honest
        # report is "started" and then "finished" rather than a fake ramp.
        progress(0.05, f"transcribing {job.get('stem', 'audio')} with basic-pitch")
        progress.raise_if_cancelled()

        _, _, note_events = predict(
            str(source),
            self.model,
            onset_threshold=float(job.get("onsetThreshold", onset)),
            frame_threshold=float(job.get("frameThreshold", frame)),
            minimum_note_length=float(job.get("minimumNoteLengthMs", minimum)),
            minimum_frequency=job.get("minFrequency"),
            maximum_frequency=job.get("maxFrequency"),
            melodia_trick=bool(job.get("melodiaTrick", True)),
        )

        notes = [
            {
                "midi": int(pitch),
                "startSec": float(start),
                "endSec": float(end),
                "velocity": round(float(amplitude), 4),
            }
            for start, end, pitch, amplitude, _bends in note_events
            if end > start
        ]
        notes.sort(key=lambda note: (note["startSec"], note["midi"]))

        progress(1.0, "done")
        return {
            "notes": notes,
            "model": self.model_id,
            "device": self.device,
            "elapsedSec": round(time.time() - started, 2),
        }

    def shutdown(self) -> None:
        self.model = None


serve(BasicPitch())
