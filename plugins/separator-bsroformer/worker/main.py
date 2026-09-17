"""Source separation with Band-Split / Mel-Band RoFormer, via `audio-separator`.

A deliberately different implementation of the same `separator` contract as
`separator-htdemucs`, so that swapping one for another is exercised on something
real. The models here are two-stem (vocals and instrumental) rather than
four-stem, which is the honest reason the contract returns a list of named stems
and never promises which ones.

Job:
    {"kind": "separate", "input": "<abs wav>", "outDir": "<abs dir>"}
    -> {"stems": [{"stem": "vocals", "path": "vocals.wav", ...}], "model": ..., "elapsedSec": ...}
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any

from decomposable_worker import Job, Progress, Worker, log, serve

MODELS = {
    # Mel-Band RoFormer: smaller and faster, the laptop baseline.
    "mel-roformer-1143": "model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt",
    # BS-RoFormer: the best-scoring of the pair, and the slower one.
    "bs-roformer-1297": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
}


class RoformerSeparator(Worker):
    name = "separator-bsroformer"
    version = "1.0.0"
    capabilities = ["separate"]

    def __init__(self) -> None:
        self.separator = None
        self.model_id = ""
        self.checkpoint = ""
        self.device = "cpu"
        self.sample_rate = 44100

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        self.model_id = model if model in MODELS else ("bs-roformer-1297" if profile == "full" else "mel-roformer-1143")
        self.checkpoint = MODELS[self.model_id]
        self.device = _pin_device(device)

        # Imported here rather than at module scope: audio-separator pulls in
        # onnxruntime and torch, and the device pinning above has to happen first.
        from audio_separator.separator import Separator

        here = Path(__file__).parent
        started = time.time()
        self.separator = Separator(
            log_level=40,
            model_file_dir=str(here / "models"),
            output_dir=str(here / "out"),   # staging; every job moves its results out
            output_format="WAV",
            sample_rate=self.sample_rate,
            use_autocast=self.device == "cuda",
        )
        self.separator.load_model(model_filename=self.checkpoint)
        log(f"{self.model_id} ({self.checkpoint}) loaded on {self.device} in {time.time() - started:.1f}s")

    def run(self, job: Job, progress: Progress) -> Any:
        if job.get("kind") != "separate":
            raise ValueError(f"unknown job kind {job.get('kind')!r}")
        import soundfile

        source = Path(job["input"])
        out_dir = Path(job["outDir"])
        out_dir.mkdir(parents=True, exist_ok=True)

        progress.raise_if_cancelled()
        # audio-separator offers no progress callback, so a long separation
        # reports its stages rather than a fraction. See the plugin README.
        progress(0.05, f"separating with {self.model_id} on {self.device}")

        # audio-separator writes to the output directory it was constructed with
        # and returns names that it has already truncated at the first dot, so
        # neither the path nor the name it hands back can be used directly.
        # Separate into a staging directory we own, then take what is actually
        # there.
        staging = Path(self.separator.output_dir)
        staging.mkdir(parents=True, exist_ok=True)
        for stale in staging.glob("*.wav"):
            stale.unlink()

        started = time.time()
        self.separator.separate(str(source))
        progress(0.9, "writing stems")

        produced = sorted(staging.glob("*.wav"))
        if not produced:
            raise RuntimeError(f"{self.model_id} produced no stems")

        stems = []
        for path in produced:
            stem = _stem_name(path.name)
            target = out_dir / f"{stem}.wav"
            # shutil.move, not Path.replace: the staging directory is beside the
            # worker and the workspace may be on another filesystem entirely.
            shutil.move(str(path), str(target))
            data, rate = soundfile.read(str(target), always_2d=True)
            stems.append(
                {
                    "stem": stem,
                    "path": target.name,
                    "sampleRate": int(rate),
                    "channels": int(data.shape[1]),
                    "durationSec": float(data.shape[0] / rate),
                    "peak": float(abs(data).max()) if data.size else 0.0,
                    "rms": float((data**2).mean() ** 0.5) if data.size else 0.0,
                }
            )

        progress(1.0, "done")
        return {
            "stems": stems,
            "model": self.model_id,
            "device": self.device,
            "sampleRate": self.sample_rate,
            "elapsedSec": round(time.time() - started, 2),
        }

    def shutdown(self) -> None:
        self.separator = None


def _stem_name(filename: str) -> str:
    """`song_(Vocals)_model_bs_roformer....wav` -> `vocals`."""
    if "(" in filename and ")" in filename:
        return filename.split("(", 1)[1].split(")", 1)[0].strip().lower().replace(" ", "-")
    return Path(filename).stem.lower()


def _pin_device(requested: str) -> str:
    """
    audio-separator picks its own device at construction. The only reliable way
    to hold it to the one the supervisor chose is to hide the others first.
    """
    import torch

    if requested == "cuda" and torch.cuda.is_available():
        return "cuda"
    if requested == "mps" and torch.backends.mps.is_available():
        return "mps"
    if requested in ("cuda", "mps"):
        log(f"{requested} was asked for but is not available here; falling back to cpu")
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"
    return "cpu"


serve(RoformerSeparator())
