# transcriber-muscriptor

Audio to notes with [MuScriptor](https://github.com/muscriptor/muscriptor), a
transformer language model over note events. Provides the `transcriber` service
and the `note` layer — the same contract `transcriber-basicpitch` provides, so
swapping them is an edit to `decomposable.config.yaml`.

The reason to pay for it: **it names the instrument it heard**. That is worth
more than it sounds. The harmony engine weights notes by where they came from —
a bass line is believed about the root, a vocal is heard but not believed — and
until now that weighting came from which stem a note was transcribed from. A
bass note that leaked into the `other` stem was weighted as `other`. With
MuScriptor it is weighted as a bass note, because the model says it is one.

## Profiles

| Profile | Weights | Notes |
|---------|---------|-------|
| `lite` | `small` | still slower than Basic Pitch by a wide margin |
| `full` | `large` | the dev box; 6 GB peak, so `auto` will not pick it on a laptop |

## Weights are gated, and this plugin has never run here

Weights are downloaded from HuggingFace on first use and cached under
`~/.cache/muscriptor`. Nothing is committed (ADR-008). But the checkpoints are
**gated**: a HuggingFace account has to accept the model licence before they can
be downloaded at all.

```
Accept at https://huggingface.co/MuScriptor/muscriptor-small (granted automatically),
then `uvx hf auth login`, or set HF_TOKEN to a read token.
```

Until somebody does that, **this plugin is written and typechecked but
unverified**. Its contract test is skipped unless both `DECOMPOSABLE_SLOW_TESTS=1`
and `HF_TOKEN` are set:

```
HF_TOKEN=... pnpm test:slow
```

`transcriber-basicpitch` is the transcriber that has actually run. Treat
everything below about MuScriptor's behaviour as what the API promises, not as
what was observed. See **O-10** in `docs/06-decisions.md`.

**Licence:** the Python package is MIT; the checkpoints are under whatever the
HuggingFace model card says, and somebody has to read it before any release that
redistributes them. This README is where that has to be recorded.

## Config

| Key | Default | What it does |
|-----|---------|--------------|
| `beamSize` | 1 | greedy. Wider is slower and usually better |
| `instruments` | — | restrict the model to a list, when the stem is known |
| `timeLimitSec` | 0 | worth setting: a `large` decode of a whole song on a CPU is minutes |

## Devices

`cpu`, `cuda`, `mps`. The worker resolves the request and falls back to CPU
rather than failing, like every other worker here.

**Mac status:** not yet verified on Apple Silicon (O-9). MuScriptor's own
loader picks float16 on `mps` deliberately, so the `mps` path is one its authors
support — but nobody here has run it.

## Known failure modes

- **Slow.** This is a language model decoding note events one at a time. On a
  laptop CPU it is far from real time, which is exactly why Basic Pitch is the
  baseline and this is the full profile.
- **Instrument labels are a guess.** A synth pad may come back as strings, and
  the harmony engine will weight it accordingly. Wrong-but-plausible is the
  usual failure, not nonsense.
- **Cancellation is checked between note events**, so a cancelled job stops
  promptly during decoding but not during model load.
