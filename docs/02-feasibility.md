# 02 — Feasibility

Verdict up front: every capability in the brief is buildable with open-source parts
running on the owner's machine (3× RTX 3060). Two parts are *reliably good* today
(stem separation, symbolic chord/voicing analysis), two are *good enough with
caveats* (transcription of piano, bass, and vocals; audio chord recognition), and
two are *research-grade* (transcription of guitar and dense "other" stems; clean
sheet-music quantisation). The plan in `05-roadmap.md` orders work so the reliable
parts ship first and the research-grade parts are isolated in swappable plugins.

## Capability 1: Take in MP3s

Trivial. ffmpeg decodes to 44.1 kHz float PCM. Store the original plus a decoded
WAV in a per-song workspace. Risk: none.

## Capability 2a: Stem separation

| Model | Stems | Quality | Speed on one RTX 3060 | Licence |
|-------|-------|---------|------------------------|---------|
| htdemucs_ft (Meta) | drums, bass, vocals, other | Very good, the safe default | ~4× faster than realtime | MIT |
| htdemucs_6s | + guitar, piano | Guitar/piano stems are weaker | similar | MIT |
| BS-RoFormer / Mel-Band RoFormer (via MSST toolkit) | configurable, best vocals and bass | State of the art on SDX leaderboards | slower, higher VRAM | MIT code, weights vary |
| Spleeter | 2/4/5 | Dated | fast | MIT |

Recommendation: ship htdemucs_ft as the default separator plugin, add a
BS-RoFormer plugin as a second implementation of the same contract. Two
implementations of one contract is exactly the hot-swap story we want to prove.

Risk: low. Separation is a solved-enough problem for analysis purposes. Bleed
between stems is the main artefact; it matters for transcription (a bass note
leaking into "other" becomes a phantom low note) and is handled by confidence
thresholds downstream.

## Capability 2b: Transcribe each stem to notes

This is the weakest link and must be treated as an ensemble of specialists:

| Stem | Best available | Expected result |
|------|----------------|-----------------|
| Piano | ByteDance piano transcription, Onsets-and-Frames, MuScriptor | Good on solo piano; usable on separated piano stem |
| Bass | Basic Pitch, CREPE-style monophonic pitch tracking | Good; bass is nearly monophonic |
| Vocals | CREPE / pyin melody, Basic Pitch | Good for pitch; note segmentation is fuzzy |
| Drums | madmom / Omnizart drum transcription | Fine for kick/snare/hat; irrelevant to harmony |
| Guitar | Basic Pitch, MuScriptor | Mediocre. Strums are dense, voicings ambiguous |
| "Other" | MuScriptor / YourMT3+ (multi-instrument, instrument-aware) | Highly variable |

MuScriptor (Kyutai + Mirelo + IRCAM, July 2026, CC BY 4.0, open weights) is the
first open model that transcribes a mixed recording to instrument-tagged MIDI and
was trained to generalise to real mixes. It should be evaluated first on the mix
*and* per stem; the comparison itself is a useful early experiment.

Key insight: for *harmony* we do not need a perfect transcription. We need
pitch-class content per beat with confidence, plus the bass note. That is a much
easier target than note-perfect sheet music, and it is what the harmony engine
consumes. Sheet music is a rendering of the same data at lower confidence.

Risk: medium for harmony use, high for note-perfect notation. Mitigation: confidence
per note, human-in-the-loop correction in the UI, and the consensus mechanism
(audio chord recogniser as a second opinion).

## Capability 2b': Notes to sheet music

Needs beat and downbeat tracking (madmom, Beat This!, BeatNet), tempo, then
quantisation to a grid, voice separation, and rendering. Rendering is solved:
MusicXML into OpenSheetMusicDisplay (browser, VexFlow underneath) or Verovio.
Quantisation is where transcriptions become unreadable. Approach: quantise to
the beat grid at a chosen resolution (8ths or triplet 8ths by default), snap
durations, and accept that the first version reads like a lead sheet with
voicings rather than an engraved score.

Risk: medium. Readability will be the complaint, not correctness.

## Capability 2c: Chord and voicing naming from notes

Symbolic, deterministic, and the most tractable interesting problem in the brief.
Input: a set of sounding pitches (with the bass identified) over a time window.
Output: ranked chord labels with voicing type. There is no open-source tool that
does the voicing-type part well; music21 and tonal.js name the chord only. This
is the project's core intellectual property. Full design in `04-harmony-engine.md`.

Risk: low technically, medium in design effort. Chord naming is genuinely
ambiguous (C6 vs Am7/C, Cmaj9 rootless vs Em7) and the engine must return
candidates with reasons, not one answer.

## Capability 2d: Chord progressions

Two layers. Key finding (Krumhansl–Schmuckler profiles or a learned model over
chroma) gives a tonal centre per section. Then a functional parser turns the chord
sequence into Roman numerals and named idioms. This can start as a rule set
(ii–V–I, secondary dominants, tritone subs, backdoor, modal interchange) and
grow into a probabilistic grammar. Audio-only chord recognisers (Chordino,
madmom's CNN chord model, BTC transformer) give an independent coarse chord track
for the consensus vote.

Risk: low for rules, medium for the grammar. Both are pure TypeScript, easy to
test with known tunes.

## Capability 3: MIDI devices and live chord detection

Web MIDI API in the browser (Chromium; Firefox behind a permission prompt) or
`midir` / `mido` on the backend. Live chord naming reuses the harmony engine on
currently-held notes, debounced by ~30 ms. Latency is not a concern.

Risk: none.

## Capability 4: Cordis-style kernel, hot swap, blast radius, in-app agent

Cordis is a real, MIT-licensed TypeScript meta-framework (the kernel of Koishi
and DeepSeek Harness) with exactly the properties named: declarative plugin
loading with config reconciliation, `ctx.effect` for reversible side effects,
LIFO teardown, service-based dependency resolution with automatic suspend and
resume, and per-branch isolation of the context tree. We can use it directly
rather than imitate it.

The two design problems are ours:

1. **ML lives in Python; the kernel is TypeScript.** Each ML model becomes a
   Python worker process owned by a Cordis plugin. The plugin spawns the process
   inside `ctx.effect`, so hot-swapping the plugin kills and respawns the worker
   cleanly. Blast radius is the process boundary. Model load time (2–20 s) is hidden
   by blue/green: start the new worker, warm it, switch routing, dispose the old.
   Three GPUs make warm standby cheap.

2. **Agent-authored plugins must be safe to mount.** The plugin contract has to be
   small enough that Sonnet-class models write correct plugins from the spec, and
   the conformance test has to catch leaks (effects not registered), contract
   violations (bad provenance), and runaway resource use before the loader mounts
   anything. The agent works in a git worktree, the tests gate the merge, and a
   failing plugin is unmounted by tearing down its branch.

Risk: medium, mostly complexity. The payoff is that this *is* the learning
experience the owner asked for, and it gives us the discipline to make every
capability replaceable.

## Running on an ordinary laptop

Required (owner, 2026-09-18). Baseline is a 4-core CPU, 8 GB RAM, no GPU, and
Apple Silicon Macs are a first-class target. What changes per component:

| Component | Laptop reality | Lite choice |
|-----------|----------------|-------------|
| Kernel, harmony engine, UI, live MIDI | Identical. All pure TS, sub-millisecond | Same code |
| Stem separation | htdemucs on CPU takes roughly 1–3× song length; htdemucs_ft is a 4-model bag and ~4× slower; BS-RoFormer is impractical on CPU. Peak RAM 2–4 GB with a small `segment` | htdemucs (non-ft) |
| Transcription | Basic Pitch was built for CPU and runs in seconds; MuScriptor is a transformer and is slow on CPU | Basic Pitch; MuScriptor as `full` |
| Beat tracking, audio chords | madmom is CPU-native and fast | Same |
| Notation rendering | In the browser | Same |
| Apple Silicon (first-class, O-8) | PyTorch MPS works for Demucs and is several times faster than CPU. Basic Pitch runs on CPU or CoreML. madmom is CPU. MuScriptor on MPS is unverified; a worker must fall back to CPU when an op is unsupported | `mps` when detected, CPU fallback per worker |

So the laptop experience is: live MIDI analysis is instant; analysing a record is
a wait of a few minutes with progress shown, once per song, then everything is
cached in the workspace. That is acceptable. What would not be acceptable is a
design that needed a GPU to function, which is why ADR-002 makes device selection
automatic and makes the lite profile the conformance baseline.

## The honest list of hard things

1. Guitar and dense "other" transcription. Isolated in plugins; do not build the
   product on top of it.
2. Notation readability. Ship lead-sheet-quality first.
3. Chord ambiguity. Solved by ranking and provenance, not by pretending.
4. Keeping three transcription models, three separation models, and a beat tracker
   alive with different Python dependencies. Solved by one venv per worker and the
   process boundary.
5. Trusting agent-written code. Solved by contract tests and branch isolation, and
   by never granting a plugin more than the services it declares in `inject`.

## Log

- 2026-09-18: first draft.
- 2026-09-18: two of the libraries named above did not survive contact with an
  installer. This section was optimistic about availability in a way that a
  feasibility document specifically should not be.

  - **madmom is unusable.** Not a version pin away: madmom 0.16.1's source
    distribution needs a Cython and a setuptools from 2018, there are no wheels
    for any Python this project supports, and its last release was 2018. It is
    named above for drum transcription *and* for the audio chord recogniser
    *and* for beat tracking. `chord-audio` uses chroma and templates instead
    (ADR-009), `beat-tracker` uses librosa and Beat This!, and nobody needs drum
    transcription for harmony.
  - **MuScriptor's weights are gated.** The claim above that it has "open
    weights" under CC BY 4.0 is what the paper says; what the distribution does
    is put the checkpoints behind a HuggingFace licence an account has to accept
    first. The Python package installs fine and the plugin is written, but it
    has never run. See O-10 — and note that "open weights" and "downloadable
    without an account" turned out to be different claims, which is worth
    checking for any model this document names in future.
  - **basic-pitch requires TensorFlow on Linux even for the ONNX path**, and
    TensorFlow <2.15.1 has no CPython 3.12 wheels at all. Overridden away in the
    worker's `pyproject.toml`; half a gigabyte of never-imported dependency is
    not something the 8 GB baseline can carry.

  What worked: the plugin contract absorbed all three without anything outside
  the affected worker directory changing. That is the first time the kernel has
  paid for itself rather than costing.
