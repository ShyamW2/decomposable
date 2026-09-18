"""Chord recognition straight from audio, as a second opinion.

The roadmap asked for madmom's CNN chord recogniser. madmom 0.16.1 no longer
builds: its sdist needs a Cython and a setuptools from 2018, and there are no
wheels for any Python this project supports. See ADR-009.

What is here instead is the classical method it would have been compared
against: a constant-Q chroma, cosine similarity against binary chord templates,
and a Viterbi pass whose only prior is that chords last longer than a frame. It
is deterministic, it needs no weights, and it runs faster than real time on a
laptop CPU.

The point of this worker is not to be the best chord recogniser. It is to be a
*different* one: the `harmony` plugin reaches its answer through transcribed
notes, this reaches its own through the spectrum, and where two roads disagree
the `consensus` plugin has something real to mark.

Job:
    {"kind": "chords", "input": "<abs wav>", "beats": [0.5, 1.0, ...], "switchPenalty": 3.0}
    -> {"chords": [{"startSec": 0, "endSec": 2, "root": 2, "quality": "min7",
                    "symbol": "Dm7", "score": 0.8, "runnerUp": "F6"}], ...}
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from decomposable_worker import Job, Progress, Worker, log, serve

NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# Deliberately small. A template recogniser cannot tell a 13th from a 6th on a
# real recording, and offering to is how a second opinion becomes noise.
TEMPLATES: list[tuple[str, str, list[int]]] = [
    ("maj", "", [0, 4, 7]),
    ("min", "m", [0, 3, 7]),
    ("dom7", "7", [0, 4, 7, 10]),
    ("maj7", "maj7", [0, 4, 7, 11]),
    ("min7", "m7", [0, 3, 7, 10]),
    ("dim", "dim", [0, 3, 6]),
    ("maj6", "6", [0, 4, 7, 9]),
]

# How much the root and the third are worth against the fifth, matching the
# harmony engine's own weighting so that a disagreement is about the audio
# rather than about two different ideas of what a chord is.
TONE_WEIGHT = {0: 1.0, 3: 1.0, 4: 1.0, 6: 0.9, 7: 0.45, 9: 0.9, 10: 1.0, 11: 1.0}

PROFILES = {
    "lite": {"id": "chroma-cqt", "hpss": False, "cens": False},
    "full": {"id": "chroma-cens-hpss", "hpss": True, "cens": True},
}

# Cosine similarity against a chord template lands in a narrow band — a real
# recording rarely scores below 0.6 or above 0.95 — so the differences that
# matter are small. `SHARPNESS` turns that band into log-probabilities with
# enough spread for the smoother to have an opinion about, and `SWITCH_PENALTY`
# is what a chord change costs against them: roughly, a label must be this many
# nats better, summed over the frames it holds, before it is worth moving to.
SHARPNESS = 25.0
SWITCH_PENALTY = 4.0

# What "no chord" scores. Fixed rather than a template: a flat twelve-bin vector
# correlates well with any real chroma, because real chroma is never sparse, so
# a uniform template competing on cosine similarity wins everywhere and the
# whole song comes back as N.C.
NO_CHORD_LEVEL = 0.55

# The low register, scored separately. Without it the whole method cannot tell
# F6 from Dm7 or C from Am7 — they are the same pitch classes, and only the bass
# says which. This is the same cue the harmony engine leans on hardest, which
# also keeps the two producers comparably informed: a disagreement between them
# should be about the evidence, not about one of them being deaf to the bass.
BASS_WEIGHT = 0.3

# A bass player alternating root and fifth is the most ordinary thing in music,
# and crediting only the root makes the second half of every bar look like a new
# chord on the fifth — Dm7 becoming Am7 when the bass walks D to A. Crediting
# the fifth as well, at less than half the weight, is the smallest model of a
# bass line that does not have that hole in it.
BASS_FIFTH_WEIGHT = 0.4


class ChordAudio(Worker):
    name = "chord-audio"
    version = "1.0.0"
    capabilities = ["chords"]

    def __init__(self) -> None:
        self.profile = "lite"
        self.settings = PROFILES["lite"]
        self.model_id = "chroma-cqt"
        self.device = "cpu"
        self.states = _build_states()

    def load(self, device: str, model: str, profile: str, config: Any) -> None:
        import librosa  # noqa: F401  (the import is the slow part; pay for it here)

        self.profile = profile if profile in PROFILES else "lite"
        self.settings = PROFILES[self.profile]
        self.model_id = model or self.settings["id"]
        self.device = "cpu"
        log(f"chord-audio ready: {self.model_id} on cpu")

    def run(self, job: Job, progress: Progress) -> Any:
        if job.get("kind") != "chords":
            raise ValueError(f"unknown job kind {job.get('kind')!r}")
        import librosa

        source = Path(job["input"])
        started = time.time()
        sr = 22050
        hop = 2048

        progress(0.05, "loading audio")
        y, sr = librosa.load(str(source), sr=sr, mono=True)
        progress.raise_if_cancelled()

        if self.settings["hpss"]:
            # Percussion is broadband and smears every chroma bin; taking it out
            # is most of what separates `full` from `lite` here.
            progress(0.15, "separating harmonic content")
            y = librosa.effects.harmonic(y, margin=4)
            progress.raise_if_cancelled()

        progress(0.35, "computing chroma")
        if self.settings["cens"]:
            chroma = librosa.feature.chroma_cens(y=y, sr=sr, hop_length=hop)
        else:
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
        # C1 to C3: the register a bass line actually lives in.
        bass = librosa.feature.chroma_cqt(
            y=y, sr=sr, hop_length=hop, fmin=librosa.note_to_hz("C1"), n_octaves=2
        )
        bass = bass[:, : chroma.shape[1]]
        times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)

        beats = [float(t) for t in (job.get("beats") or [])]
        if len(beats) >= 2:
            # Chords change on beats. Averaging inside the beat is both a better
            # estimate and far fewer Viterbi states to walk.
            progress(0.5, "syncing chroma to the beat grid")
            chroma, spans = _beat_sync(chroma, times, beats)
            bass, _ = _beat_sync(bass, times, beats)
        else:
            spans = [(float(t), float(times[i + 1]) if i + 1 < len(times) else float(t) + hop / sr)
                     for i, t in enumerate(times)]

        progress.raise_if_cancelled()
        progress(0.7, "matching templates")
        emission = _emission(chroma, bass, self.states)

        progress(0.85, "smoothing")
        path = _viterbi(emission, float(job.get("switchPenalty", SWITCH_PENALTY)))
        chords = _segments(path, emission, spans, self.states)

        progress(1.0, "done")
        return {
            "chords": chords,
            "model": self.model_id,
            "device": self.device,
            "grid": "beats" if len(beats) >= 2 else "frames",
            "elapsedSec": round(time.time() - started, 2),
        }


def _build_states() -> list[dict[str, Any]]:
    """Every root against every template, plus one state for "no chord"."""
    states: list[dict[str, Any]] = []
    for root in range(12):
        for quality, symbol, intervals in TEMPLATES:
            vector = np.zeros(12)
            for interval in intervals:
                vector[(root + interval) % 12] = TONE_WEIGHT.get(interval, 0.5)
            states.append(
                {
                    "root": root,
                    "quality": quality,
                    "symbol": f"{NAMES[root]}{symbol}",
                    "vector": vector / np.linalg.norm(vector),
                }
            )
    # No chord has no template; see NO_CHORD_LEVEL.
    states.append({"root": -1, "quality": "none", "symbol": "N.C.", "vector": None})
    return states


def _beat_sync(chroma: np.ndarray, times: np.ndarray, beats: list[float]):
    """Mean chroma inside each beat, and the span each one covers."""
    columns = []
    spans = []
    for start, end in zip(beats, beats[1:]):
        mask = (times >= start) & (times < end)
        if not mask.any():
            continue
        columns.append(chroma[:, mask].mean(axis=1))
        spans.append((float(start), float(end)))
    if not columns:
        return chroma, [(float(t), float(t)) for t in times]
    return np.stack(columns, axis=1), spans


def _emission(chroma: np.ndarray, bass: np.ndarray, states: list[dict[str, Any]]) -> np.ndarray:
    """
    How well each template explains each frame: cosine similarity over the full
    chroma, plus how much of the low register is sitting on the template's root.
    """
    frames = _unit_rows(chroma.T)
    templates = np.stack([state["vector"] for state in states if state["vector"] is not None])
    similarity = np.clip(frames @ templates.T, 0.0, 1.0)

    # Bass energy at each root, scaled so the loudest low note in a frame is 1.
    low = bass.T
    low = low / np.where(low.max(axis=1, keepdims=True) > 0, low.max(axis=1, keepdims=True), 1)
    roots = np.array([state["root"] for state in states if state["vector"] is not None])
    rooted = (low[:, roots] + BASS_FIFTH_WEIGHT * low[:, (roots + 7) % 12]) / (1 + BASS_FIFTH_WEIGHT)
    similarity = (similarity + BASS_WEIGHT * rooted) / (1 + BASS_WEIGHT)

    no_chord = np.full((similarity.shape[0], 1), NO_CHORD_LEVEL)
    return np.concatenate([similarity, no_chord], axis=1)


def _unit_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.where(norms > 0, norms, 1)


def _viterbi(emission: np.ndarray, switch_penalty: float) -> np.ndarray:
    """
    The only prior is that a chord lasts longer than one frame. Without it a
    template recogniser flickers between relative majors and minors on every
    passing note, which would drown the consensus layer in false disagreement.

    Staying costs nothing and moving costs `switch_penalty`, which is the same
    model as a self-transition probability and far easier to reason about: the
    penalty is in the same units as the sharpened similarities it competes with.
    """
    frames, count = emission.shape
    logp = SHARPNESS * emission
    scores = logp[0].copy()
    backpointers = np.zeros((frames, count), dtype=np.int32)

    for t in range(1, frames):
        best_index = int(scores.argmax())
        best_other = scores[best_index] - switch_penalty
        take_self = scores >= best_other
        backpointers[t] = np.where(take_self, np.arange(count), best_index)
        scores = np.where(take_self, scores, best_other) + logp[t]
        scores -= scores.max()  # underflow guard; the argmax is unchanged

    path = np.zeros(frames, dtype=np.int32)
    path[-1] = int(scores.argmax())
    for t in range(frames - 1, 0, -1):
        path[t - 1] = backpointers[t][path[t]]
    return path


def _segments(path: np.ndarray, emission: np.ndarray, spans, states) -> list[dict[str, Any]]:
    """Runs of one label, collapsed into one chord each."""
    out: list[dict[str, Any]] = []
    start_index = 0
    for i in range(1, len(path) + 1):
        if i < len(path) and path[i] == path[start_index]:
            continue
        state = states[int(path[start_index])]
        window = emission[start_index:i, int(path[start_index])]
        ranked = np.argsort(-emission[start_index:i].mean(axis=0))
        runner_up = states[int(ranked[1])]["symbol"] if len(ranked) > 1 else None
        out.append(
            {
                "startSec": spans[start_index][0],
                "endSec": spans[i - 1][1],
                "root": int(state["root"]),
                "quality": state["quality"],
                "symbol": state["symbol"],
                "score": round(float(window.mean()), 4),
                "runnerUp": runner_up,
            }
        )
        start_index = i
    return out


serve(ChordAudio())
