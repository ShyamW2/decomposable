# harmony

Names chords and classifies voicings. The engine itself is `harmony/` at the
repository root — pure TypeScript, no I/O, no clock, no randomness (ADR-003) —
and this plugin is the thin layer that mounts it: cut a song into windows, run
the engine, write the answers down with provenance.

Provides the `harmony` service.

## Inputs

- `note` layer events (`NotePayload`) from any transcriber.
- `beat` layer events (`BeatPayload`), when a beat tracker has run. Without them
  the song is cut into fixed `fallbackWindowSec` windows instead, which is worse
  but not useless.

## Outputs

Per window, in this order, each pointing at the last:

| Layer | Payload | Notes |
|-------|---------|-------|
| `chroma` | the twelve bins, the MIDI notes, the bass note | inputs: the note events that overlapped the window |
| `chord` | the ranked candidates, the margin, `ambiguous` | inputs: the chroma event; `confidence` is the winner's score |
| `voicing` | the winner's voicing, its symbol, the notes | inputs: the chord event |

A window with nothing sounding produces nothing at all, rather than a row of
`N.C.` that a lead sheet would have to filter out again.

## Config

| Key | Default | What it does |
|-----|---------|--------------|
| `top` | 4 | how many candidates each window keeps |
| `ambiguityMargin` | 0.05 | below this score gap the runner-up is flagged |
| `fallbackWindowSec` | 0.5 | window length when there is no beat track |
| `beatsPerWindow` | 1 | analyse per beat, or per 2 beats, or per bar |

One beat is the finest honest resolution and the plugin's default, but over a
real transcription it flickers: a passing note gets a whole window to itself and
becomes a chord. `decomposable.config.yaml` ships `beatsPerWindow: 2` — half a
bar in 4/4 — because that is what made `node scripts/demo-phase3.ts` read like a
chart rather than like a list of guesses. Lower it for a ballad, raise it for
fast swing.

## The service

```ts
harmony.analyzeNotes([60, 64, 67, 70])        // live keyboard: ranked candidates
harmony.analyze(window)                        // one window, built by the caller
harmony.analyzeSong(songId, { keyHint })       // the whole record, stored
```

`analyze` and `analyzeNotes` are synchronous and pure. They are well inside the
50 ms the live path is allowed (non-negotiable 4): about 0.3 ms for a six-note
voicing on the dev box, and the fixture suite fails if a call exceeds 5 ms.

## Known failure modes

- **A rootless voicing with no bass is a different chord.** E–G–B–D is E minor
  seventh until something says C underneath, and the engine says so rather than
  guessing. Feed it `bassMidi` from the bass stem or from the keyboard's left
  hand and it says Cmaj9.
- **The tritone belongs to two dominants.** Guide tones alone cannot distinguish
  C7 from Gb7. The engine ranks them level, breaks the tie by root order, and
  sets `ambiguous`; the UI is expected to show the runner-up.
- **No key finding yet.** `keyHint` is consumed but nothing produces one until
  Phase 4, so the key bonus only applies when a caller supplies a key.
- **Enharmonic spelling is by convention, not by key.** Roots are spelled flat
  where a chart usually would (`Eb`, not `D#`). Proper spelling needs the key
  layer.
- **Dense transcriptions make dense windows.** A window holding a whole scale
  from a run of sixteenth notes will produce a confident wrong answer. The
  short-note decay in stage 1 is the defence, and it is calibrated for half-bar
  windows; per-beat windows over fast passages are the weak spot.
