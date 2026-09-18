# consensus

Merges every chord track on a song into one, and records where they disagreed
rather than hiding it. Provides the `consensus` service; writes to the `chord`
layer under its own producer name.

## Why it exists

`harmony` reaches a chord through separated stems and transcribed notes.
`chord-audio` reaches one through the chroma of the mixture. Two independent
routes to the same question is worth more than either alone — not because
averaging them is more accurate, but because **where they disagree is
information**. A marker the user can look into beats a single confident label
that happens to be wrong (CLAUDE.md non-negotiable 5).

The merge reads the `chord` layer grouped by producer and votes, so a third or
fourth chord track joins without a line of code here.

## How the vote works

Producers do not share a vocabulary: `harmony` says `Cmaj9` where `chord-audio`
can only say `Cmaj7`. A vote that demanded exact agreement would find
disagreement everywhere and mean nothing, so agreement is graded:

| Relationship | Agreement |
|---|---|
| same root, same quality | 1.0 |
| same root, same family (`maj7` vs `maj6`) | 0.8 |
| same root, neighbouring family (`maj` vs `dom7`, `min` vs `dim`) | 0.6 |
| same root, different family (`maj7` vs `min7`) | 0.35 |
| different root | 0 |

Each label scores the weighted agreement of every producer with it, including
itself. The best-supported label wins; `agreement` is its score over the total
weight available, and the losers are listed in `disagreement`.

A window is **contested** when agreement falls below `agreementFloor`, or when
only one producer had an opinion — agreeing with yourself is not agreement, and
a merged track of one is itself with no support behind it.

## Weights, and what calibration would be

`04-harmony-engine.md` asks for a calibrated scalar per producer, fitted by
running the fixtures. **That is not implemented**, because fitting it needs the
third kind of fixture in that document — audio clips with hand-labelled chord
tracks — and there are none yet.

What happens instead: a producer with no configured weight is weighted by its
own mean confidence on that song. A producer that was unsure everywhere counts
for less than one that was sure. That is a stand-in, not a calibration: it
measures how confident a producer *claims* to be, not how often it is right.
Configure `weights` explicitly to override it.

```yaml
consensus:
  weights:
    harmony: 1.0
    chord-audio: 0.6
  agreementFloor: 0.7
```

## Output

One `chord` event per window with `producer: consensus`, pointing at the source
chord events it merged:

```ts
{ symbol: 'Dm7', root: 2, quality: 'min7', candidates: [...],
  agreement: 0.78, contested: false,
  disagreement: [{ producer: 'chord-audio', symbol: 'F6', agreement: 0.35 }],
  sources: ['chord-audio', 'harmony'] }
```

Querying the `chord` layer returns every producer's track plus this one. Filter
by producer; the UI shows this one by default and the others on demand.

## Known failure modes

- **Two wrong producers outvote one right one.** Nothing here knows which
  producer is right, only which ones agree. Correlated errors — both producers
  misled by the same loud non-chord tone — merge into a confident wrong answer
  with no disagreement marker at all.
- **The live MIDI track is not a source yet.** The design wants three tracks
  including what the player is playing. `midi` records `midi-live` and `voicing`
  events but not `chord` events, because it has no song-time position to place
  them at until playback and MIDI are plumbed together. When that exists it
  joins the vote with no change here.
- **Segmentation is taken from the beat grid**, so two producers that segmented
  differently are compared at the midpoint of each beat. A chord that changes
  off the beat is attributed to whichever beat its midpoint falls in.
