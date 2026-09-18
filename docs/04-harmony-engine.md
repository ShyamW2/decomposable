# 04 — Harmony engine

Status: stages 1–3 built and passing 258 tests (2026-09-18); stages 4 and 5 are
still design only. This is the project's core intellectual property and the part
the high-tier model should design personally. Pure TypeScript, no I/O,
table-driven tests. Lives in `harmony/`, mounted by `plugins/harmony/`.

Where the code and this document differ, the log at the bottom says why.

## Inputs and outputs

Input, per analysis window (a beat, a half-bar, or a MIDI "held chord"):

```ts
interface PitchWindow {
  start: number; end: number;                         // seconds
  notes: { midi: number; weight: number; source: 'bass'|'piano'|'guitar'|'vocals'|'other'|'midi' }[];
  bassMidi?: number;                                  // lowest confident note from the bass stem or MIDI
  keyHint?: Key;                                      // from the key layer if known
  prev?: ChordCandidate;                              // previous window's winner, for context
}
```

Output: a ranked list, never a single answer.

```ts
interface ChordCandidate {
  root: PitchClass; quality: Quality;                 // maj7, min7, dom7, m7b5, dim7, sus4, ...
  extensions: Ext[]; alterations: Alt[];              // 9, 11, 13 ; b9, #9, #11, b13
  bass?: PitchClass;                                  // slash chord if != root
  symbol: string;                                     // "Cmaj9/E"
  voicing?: Voicing;                                  // see below
  score: number;                                      // 0..1
  reasons: string[];                                  // human-readable, shown in the UI
  omitted: PitchClass[];                              // chord tones not present (e.g. no 5th, no root)
  foreign: PitchClass[];                              // notes not explained by the label
}
```

## Stage 1: pitch-class profile

Collapse notes to a 12-bin weighted pitch-class vector. Weights come from note
confidence and duration inside the window, with a bonus for the bass-stem note
and a decay for very short notes (passing tones). Keep the actual MIDI numbers
too; voicing analysis needs them.

## Stage 2: chord template matching with an explicit cost model

For every root (12) and every quality in the vocabulary (~25, covering triads,
sixths, sevenths, suspensions, and the common altered dominants), compute a score
from:

- matched chord tones (weighted by importance: 3rd and 7th high, 5th low, root
  medium since jazz voicings omit it),
- foreign notes (penalty scaled by their weight, less if they are diatonic
  extensions),
- bass agreement (strong bonus if the bass-stem note is the root; moderate if it
  is a chord tone, giving a slash chord),
- key context (bonus for diatonic function in `keyHint`),
- continuity (small bonus for the same root as `prev`, so a sustained chord does
  not flicker),
- parsimony (prefer the simplest label that explains the same notes: C6 over
  Am7/C when the bass is C).

Emit the top k with reasons. The classic ambiguities become explicit ties broken
by the bass note and key, with the runner-up still visible. Test fixtures should
encode the known hard cases: C6 vs Am7, Cmaj9(no root) vs Em7, C7#9 vs Eb/C, sus
vs quartal, the half-diminished vs minor-6 inversion.

## Stage 3: voicing classification

Given the winner and the actual MIDI notes, classify the voicing. This is
rule-based over intervals from the bass, ordering, and spacing:

| Voicing | Recognition rule (sketch) |
|---------|---------------------------|
| Close, root position / inversion | all chord tones within one octave; label the inversion by bass |
| Drop 2 / Drop 3 / Drop 2&4 | close voicing with the 2nd (3rd, 2nd+4th) voice from the top dropped an octave |
| Shell | only root(or bass)+3rd+7th, or 3rd+7th |
| Rootless A / B (Bill Evans forms) | 3-5-7-9 or 7-9-3-5 (with 13 for dominants), no root, in the mid register |
| Quartal | consecutive perfect/augmented 4ths, 3+ notes |
| "So What" | three 4ths topped by a major 3rd |
| Upper-structure triad | a major/minor triad in the upper voices whose notes are extensions/alterations of the underlying 7th chord; name the triad and its degree ("UST bII" ) |
| Spread / open | span > 2 octaves with gaps > a 5th between adjacent voices |
| Cluster | two or more adjacent semitones or whole tones in one hand's range |
| Polychord | two identifiable triads with disjoint pitch-class sets |

Also report: top note (melody) as a chord degree ("7th on top"), register, and
number of voices. Output one primary label plus alternates when rules overlap.

## Stage 4: key finding

Per section (segment boundaries come from the beat/structure layer or a fixed
window), correlate the pitch-class histogram with Krumhansl–Schmuckler major and
minor profiles; keep the top two keys. Modulation detection is a change in the
winning key sustained for more than N bars. Modes are reported when the chord
vocabulary suggests it (Dorian: min chords with natural 6; Mixolydian: maj with b7).

## Stage 5: progression parsing

Convert the chord track to Roman numerals in the local key, then run a pattern
layer and a grammar layer.

Pattern layer (rules, ordered by specificity): ii–V–I (major and minor variants),
I–vi–ii–V turnaround, V/x secondary dominants, tritone substitution (bII7 where a
V7 fits), backdoor (bVII7 → I), modal interchange (iv, bVI, bVII in major),
Coltrane cycle (major thirds root motion with dominants), line cliché (chromatic
inner voice), pedal point, Neapolitan, augmented sixth, blues form, rhythm changes.

Grammar layer (later): a small probabilistic context-free grammar over functions
(T, S, D with prolongations and substitutions), parsed with CYK over the chord
sequence. Produces a tree so the UI can show nested cadences. Start with the
pattern layer; add the grammar when we have labelled fixtures.

## Consensus

Three chord tracks reach the `consensus` plugin: symbolic-from-stems, audio chord
recogniser, and (when playing) live MIDI. Merge per window by weighted vote where
the weight is the producer's calibrated confidence. Emit the merged chord with a
`disagreement` field listing the losing labels. The UI renders disagreement as a
marker, not an error. Calibration: run the fixtures and fit a scalar per producer.

## Fixtures and evaluation

`fixtures/harmony/` holds three kinds of cases:

1. **Pitch-set cases** (hundreds, hand-written): notes in, expected top label and
   voicing out. Cheap and the main regression net.
2. **Progression cases**: chord sequence + key in, expected Roman numerals and
   idioms out. Standards and pop tunes as public-domain-safe chord lists.
3. **Audio cases** (a few dozen clips we own): audio in, expected chord track.
   Used for calibrating consensus weights and catching transcription regressions.

Every change to `harmony/` runs 1 and 2 in CI and reports 3 via the time-travel
diff described in `03-architecture.md`.

## Open design questions for the high tier

All three are now settled, as recommended.

- ~~Closed table or generated vocabulary?~~ **Generated**, in the precise sense
  recorded in ADR-010: eighteen core qualities, each with the tensions it can
  carry, and extensions *found* in the notes rather than enumerated as separate
  qualities. Display spelling is curated separately in `symbolFor`.
- ~~How to represent "no chord"?~~ **A candidate with quality `none`**, returned
  alone when fewer than two pitch classes are present. `analyzeSong` drops those
  windows rather than writing a row of `N.C.` that a lead sheet would filter out
  again.
- ~~Must the rootless detector see the root in the bass?~~ **No.** It fires on
  the shape, reports `omitted: [root]`, and lets the bass cue in stage 2 and
  `consensus` decide. This is why E–G–B–D alone is `Em7` and the same notes over
  a stated C bass are `Cmaj9`, which is the correct answer to both questions.

## Log

- 2026-09-18: first draft.

- 2026-09-18: stages 1 to 3 built. What the design got right, and what it did not
  say:

  **Right, and load-bearing.** Ranked candidates with reasons as the output type
  is what makes every hard case in this document *expressible* rather than a
  coin toss. The explicit cost model means a fixture failure is an argument
  about one named constant. Keeping the MIDI numbers through stage 1 is what
  lets stage 3 exist at all.

  **Not said, and needed.**

  - *The bass is worth more than "a strong bonus".* It is the only thing that
    separates C6 from Am7, Cmaj9-no-root from Em7, and Am7b5 from Cm6 — three of
    the five hard cases this document names. It ended at 0.14 against a base
    score of at most 1, and 0.10 was demonstrably too little: it lost `C13(#11)`
    to `D7/C`, because the rival label was *complete* and the right one was
    missing its 5th.
  - *Completeness needs a floor under the tones that define the quality.* A
    missing 5th is ordinary and a missing 3rd is reaching, and averaging cannot
    say so. Without an explicit penalty, E and B-flat read as E diminished —
    claiming a G nobody played — as readily as they read as a dominant seventh
    missing only its root and its 5th.
  - *Do not clip the score before sorting.* Clipping at 1 flattens the
    distinctions at the top of the ranking, which is the only place the ranking
    matters. Normalise by the theoretical maximum instead.
  - *Tensions must be credited at a discount, not for free.* At full credit a
    label that explains a note as a tension beats one that explains it as a
    chord tone, and every chord becomes an altered dominant.
  - *A natural 11 over a major 3rd is not a tension.* `dom7sus4` has to be its
    own row, or every sus chord is read as a dominant with a foreign note.

  **Two spellings, one sound.** `C7alt` is reachable both as `dom7` with
  alterations and as `aug7` with alterations, because the #5 and the b13 are the
  same key. Both print `C7alt`, which is correct, but it means the UI must not
  show a runner-up whose symbol equals the winner's.

  **Stage 4 is still missing and stage 2 already wants it.** `keyHint` is
  consumed — the diatonic bonus works and is tested — but nothing produces one,
  so it only applies when a caller passes a key by hand. Enharmonic spelling is
  by convention (`Eb`, not `D#`) for the same reason: proper spelling needs a
  key.

  **Fixture kind 3 does not exist.** `fixtures/harmony/` has 230 pitch-set cases
  and no progression cases and no audio cases, because there is no audio in this
  repository we own except what we synthesised (ADR-008). The missing audio
  cases are what blocks calibrating `consensus`, which is why that plugin
  weights producers by their own confidence instead — a stand-in that measures
  how sure a producer *claims* to be, not how often it is right.
