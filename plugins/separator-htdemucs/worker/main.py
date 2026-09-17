"""Source separation with Hybrid Transformer Demucs.

`lite` is `htdemucs` (one pass, the 8 GB laptop baseline) and `full` is
`htdemucs_ft` (four fine-tuned models bagged, roughly four times the work).
Both produce drums, bass, other and vocals at 44.1 kHz.

Job:
    {"kind": "separate", "input": "<abs wav>", "outDir": "<abs dir>"}
    -> {"stems": [{"stem": "drums", "path": "drums.wav", ...}], "model": ..., "elapsedSec": ...}
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from decomposable_worker import Cancelled, Job, Progress, Worker, log, serve


class Separator(Worker):
    name = "separator-htdemucs"
    version = "1.0.0"
    capabilities = ["separate"]

    def __init__(self) -> None:
        self.model = None
        self.model_id = ""
        self.device = "cpu"
        self.sources: list[str] = []

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        import torch
        from demucs.pretrained import get_model

        self.device = _resolve_device(device)
        self.model_id = model or ("htdemucs_ft" if profile == "full" else "htdemucs")
        started = time.time()
        self.model = get_model(self.model_id)
        self.model.eval()
        self.model.to(self.device)
        self.sources = list(self.model.sources)
        log(
            f"{self.model_id} loaded on {self.device} in {time.time() - started:.1f}s "
            f"(sources: {', '.join(self.sources)}, torch {torch.__version__})"
        )

    def run(self, job: Job, progress: Progress) -> Any:
        if job.get("kind") != "separate":
            raise ValueError(f"unknown job kind {job.get('kind')!r}")
        import torch
        import torchaudio
        from demucs.apply import apply_model

        source = Path(job["input"])
        out_dir = Path(job["outDir"])
        out_dir.mkdir(parents=True, exist_ok=True)

        wav, sample_rate = torchaudio.load(str(source))
        if sample_rate != self.model.samplerate:
            wav = torchaudio.functional.resample(wav, sample_rate, self.model.samplerate)
            sample_rate = self.model.samplerate
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]

        # Demucs expects the mixture normalised by its own statistics.
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std()
        normalised = (wav - mean) / (std if std > 0 else 1.0)

        started = time.time()
        total_samples = normalised.shape[-1]

        def on_step(state: dict) -> None:
            progress.raise_if_cancelled()
            models = max(1, state.get("models", 1))
            index = state.get("model_idx_in_bag", 0)
            offset = state.get("segment_offset", 0)
            fraction = (index + min(1.0, offset / max(1, total_samples))) / models
            progress(min(0.99, fraction), f"separating with {self.model_id}")

        progress(0.02, f"separating with {self.model_id} on {self.device}")
        with torch.no_grad():
            estimates = apply_model(
                self.model,
                normalised[None],
                device=self.device,
                shifts=int(job.get("shifts", 0)),
                split=True,
                overlap=float(job.get("overlap", 0.25)),
                progress=False,
                callback=on_step,
            )[0]
        estimates = estimates * (std if std > 0 else 1.0) + mean

        stems = []
        for name, estimate in zip(self.sources, estimates):
            path = out_dir / f"{name}.wav"
            torchaudio.save(str(path), estimate.cpu(), sample_rate, encoding="PCM_S", bits_per_sample=16)
            stems.append(
                {
                    "stem": name,
                    "path": path.name,
                    "sampleRate": sample_rate,
                    "channels": int(estimate.shape[0]),
                    "durationSec": float(estimate.shape[-1] / sample_rate),
                    "peak": float(estimate.abs().max()),
                    "rms": float(estimate.pow(2).mean().sqrt()),
                }
            )

        progress(1.0, "done")
        return {
            "stems": stems,
            "model": self.model_id,
            "device": self.device,
            "sampleRate": sample_rate,
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


serve(Separator())
