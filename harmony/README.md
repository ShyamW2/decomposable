# harmony

The harmony engine. Pure TypeScript, no I/O, no clock, no randomness (ADR-003).
`04-harmony-engine.md` is the design authority; this is a map of the code.

Nothing here knows about Cordis, SQLite or time. That is what lets the same code
answer a MIDI keyboard in a fraction of a millisecond and grind through a
three-minute transcription. `plugins/harmony/` is the thin layer that mounts it.

| File | Stage | What it does |
|------|-------|--------------|
| `src/pitch.ts` | — | Pitch classes, note names, the parser fixtures are written in. |
| `src/types.ts` | — | `PitchWindow` in, `ChordCandidate[]` out. The whole contract. |
| `src/vocabulary.ts` | — | Eighteen core qualities and the tensions each can carry (ADR-010), and how a symbol is spelled. |
| `src/profile.ts` | 1 | Notes with durations → one window → twelve weighted bins, keeping the MIDI numbers. |
| `src/chords.ts` | 2 | Every root against every quality, with the cost model. All the tunable constants live at the top of this file. |
| `src/voicing.ts` | 3 | How the notes were arranged: drop 2, rootless A, So What, upper structure, and the rest. |
| `src/index.ts` | — | `analyze(window)` runs 1 to 3 and returns a ranked list. |

Stages 4 (key finding) and 5 (progression parsing) are Phase 4 and are not here.
`keyHint` is consumed but nothing produces one yet.

## Reading it

Start with `chords.ts`. The constants at the top are the model, and every one of
them is there because a fixture failed without it:

```ts
const BASS_IS_ROOT = 0.14          // the single strongest cue in tonal music
const MISSING_DEFINING_TONE = -0.08 // a missing 3rd is not a missing 5th
const TENSION_CREDIT = 0.75        // explained, but not as cleanly as a chord tone
```

A fixture failure should be an argument about one named number, not an
expedition through a scoring loop. If it is not, the loop is wrong.

## Tests

```sh
npx vitest run harmony/
```

- `fixtures.test.ts` runs `fixtures/harmony/pitch-sets.json`: 230 cases, 192 of
  them a grid of every quality on every root, the rest hand-written hard cases
  with a `why` field explaining the music. A new hard case is a line of JSON.
- `engine.test.ts` covers what the fixtures cannot reach — window building from
  timed notes, spelling, ambiguity, edges.
- The fixture suite also fails if `analyze` takes more than 5 ms on a six-note
  voicing. The live budget is 50 ms (non-negotiable 4) and the real figure is
  about 0.3 ms; the check exists so that a future change cannot quietly eat it.
