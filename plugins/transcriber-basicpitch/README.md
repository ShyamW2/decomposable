# transcriber-basicpitch

Audio to notes with [Basic Pitch](https://github.com/spotify/basic-pitch), run
through ONNX. Provides the `transcriber` service and the `note` layer.

This is the transcriber the `lite` profile is defined by: one small CNN, no GPU,
no model download, faster than real time on a laptop CPU. It is
instrument-agnostic — it tells you a pitch was sounding, not what was playing it
— so notes are attributed to the stem they were transcribed from.

## Profiles

Basic Pitch has one published model, so the profiles differ in decoding rather
than in weights. The manifest cannot say that; this can.

| Profile | Onset | Frame | Min note | What changes |
|---------|-------|-------|----------|--------------|
| `lite` | 0.50 | 0.30 | 127.7 ms | the published defaults |
| `full` | 0.35 | 0.22 | 58 ms | finds more of a quiet inner voice, and more of the reverb tail |

Every threshold is also a config key, so a stem can be tuned individually —
`minFrequency` and `maxFrequency` are worth setting when you know a stem is a
bass or a vocal.

## Weights and licence

The ONNX model ships inside the `basic-pitch` package. Nothing is downloaded at
runtime and nothing is committed here. Basic Pitch is Apache 2.0, model included.

## Devices

`cpu` only. The manifest says so. The ONNX runtime in this venv has no GPU
build, and the model is small enough that it would not matter.

TensorFlow is overridden out of the dependency set in the worker's
`pyproject.toml`: basic-pitch 0.4.0 requires it unconditionally on Linux even
though ONNX is what loads the model here, and TensorFlow <2.15.1 has no CPython
3.12 wheels at all. Half a gigabyte of dependency that is never imported is not
something the 8 GB baseline (O-7) can afford.

**Mac status:** not yet verified on Apple Silicon (O-9). There is nothing
device-specific in this worker — it is CPU everywhere — so the risk is the
dependency set rather than the code. basic-pitch pulls `coremltools` rather than
TensorFlow on Darwin, which is a different resolution than the one tested here.

## Known failure modes

- **Reverb and sustain become notes.** Lowering the frame threshold for `full`
  buys inner voices at the cost of tails that outlast the chord, which then land
  in the next harmony window as foreign notes.
- **No instrument, so no bass line.** Every note from a given stem gets that
  stem's weighting. A bass note that leaked into `other` is weighted as `other`.
  `transcriber-muscriptor` does not have this limitation.
- **Polyphony beyond about four voices degrades.** Dense piano voicings lose
  inner notes, which shows up as a missing 5th or 9th rather than a wrong root.
- **Octave errors on low bass.** Below about MIDI 40 the model sometimes places
  a note an octave high, which moves the bass note and therefore the chord's
  inversion.
