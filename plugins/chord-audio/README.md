# chord-audio

Chord recognition from the spectrum rather than from transcribed notes.
Provides the `chord-audio` service and writes to the `chord` layer.

**This worker does not exist to be the best chord recogniser. It exists to be a
different one.** `harmony` reaches its answer through separated stems and
transcribed notes; this reaches its own through a constant-Q chroma of the
mixture. Where two independent roads agree, the answer is probably right. Where
they disagree, `consensus` has something real to mark, and the user learns
something about the recording rather than being handed one confident label that
happens to be wrong (non-negotiable 5).

## Not madmom

The roadmap asked for madmom's CNN chord recogniser. madmom 0.16.1 no longer
builds: its source distribution needs a Cython and a setuptools from 2018 and
there are no wheels for any Python this project supports. See **ADR-009**.

What is here instead is the classical method madmom's CNN would have been
compared against, and it is honest about being that.

## Method

1. Constant-Q chroma of the mixture at 22 050 Hz, hop 2048.
2. A second chroma over C1–C3 only: the register a bass line lives in. Without
   it the method cannot tell F6 from Dm7, or C from Am7 — the same pitch classes,
   and only the bass says which. The bass term credits the template's root, and
   its fifth at 0.4 weight, because a bass player alternating root and fifth is
   the most ordinary thing in music and crediting only the root makes the second
   half of every bar look like a new chord.
3. Cosine similarity against seven chord templates on each of twelve roots, plus
   a fixed level for "no chord". Tone weights match the harmony engine's, so a
   disagreement between the two producers is about the evidence rather than
   about two different ideas of what a chord is.
4. Beat-synchronous averaging, when a beat track exists. Chords change on beats.
5. Viterbi, where staying costs nothing and moving costs `switchPenalty`. The
   only prior is that a chord lasts longer than one frame; without it the method
   flickers between relative majors and minors on every passing note and floods
   the consensus layer with false disagreement.

## Profiles

| Profile | Model id | What changes |
|---------|----------|--------------|
| `lite` | `chroma-cqt` | plain CQT chroma |
| `full` | `chroma-cens-hpss` | harmonic extraction first, then CENS chroma |

Percussion is broadband and smears every chroma bin, so taking it out is most of
what separates the two. On the drum-bearing fixture `full` is clearly better;
`lite` is what runs when there is no time to spare.

## Vocabulary

Deliberately small: major, minor, dominant 7, major 7, minor 7, diminished,
major 6. A template recogniser cannot tell a 13th from a 6th on a real
recording, and offering to is how a second opinion becomes noise. Extensions are
`harmony`'s job, because `harmony` has actual notes to look at.

## Devices

`cpu` only, and it is fast: several times real time on a laptop.

**Mac status:** not yet verified on Apple Silicon (O-9). Pure librosa and numpy,
so the risk is low, but "low risk" is not "run".

## Known failure modes

- **Root–fifth bass lines still pull the label.** When the bass moves to the
  fifth for half a bar, the recogniser sometimes follows it and reports the
  chord built on the fifth. The fifth-weighting reduces this; it does not remove
  it. Per-bar windows would help more than per-beat ones.
- **Relative major and minor.** C and Am are three of four notes apart and the
  bass term is the only thing separating them. Expect this where the bass is
  quiet or absent.
- **Sevenths are under-detected in dense mixes**, because the seventh is often
  the quietest chord tone and the template match barely notices.
- **No inversions and no slash chords.** The label is a root and a quality.
