# Decomposable

A self-extending music analysis workbench. It takes a song, splits it into
stems, transcribes each stem, and explains the harmony at the level a working
musician cares about — not just "Cmaj7" but *which* voicing, why it works where
it is, and how it compares to what you are playing on the keyboard right now.

It is built as a plugin kernel ([Cordis](https://github.com/cordiverse/cordis)),
so every capability can be replaced while the app runs, one plugin crashing
cannot take the rest down, and the app can eventually ask a coding agent to
write new plugins for it from inside the UI.

Design lives in [`docs/`](docs/README.md). Start with
[`docs/01-vision.md`](docs/01-vision.md), then
[`docs/03-architecture.md`](docs/03-architecture.md).

## Status

Phases 0 to 3 of [the roadmap](docs/05-roadmap.md) are implemented.

- The kernel hot-swaps: any capability can be replaced while the app runs.
- A song can be ingested, separated into stems, and listened to with mute and
  solo, with the separator swapped underneath without a restart.
- **Play a chord on a MIDI keyboard and the page names it, classifies the
  voicing, and says why — in about 30 ms.** Drop 2, rootless A and B, shell, So
  What, quartal, upper-structure triads, polychords. When two labels fit equally
  well it shows both, because ambiguity is information.
- A record goes through beat tracking, transcription, the same harmony engine,
  an independent chord recogniser that works from the spectrum instead, and a
  consensus pass that marks every window where the two disagreed.

Two things in Phase 3 are honestly unfinished. The exit criterion asks for a
real solo-piano and a real piano-trio recording, and the only audio here is
synthesised, so the pipeline has never met a record. And
`transcriber-muscriptor` has never run at all: its weights are behind a
HuggingFace licence somebody has to accept (**O-10** in
[the ADR log](docs/06-decisions.md)).

## Requirements

- Node 24 and [pnpm](https://pnpm.io). TypeScript runs directly; there is no
  build step outside the browser app.
- [uv](https://docs.astral.sh/uv/) and Python 3.11 or 3.12, for the workers.
  Each worker has its own venv, created on first use.
- ffmpeg and ffprobe on the `PATH`.
- A GPU is optional everywhere. The baseline is 4 cores, 8 GB of RAM and no GPU.

## Getting started

```sh
pnpm install
pnpm build:ui
pnpm start            # http://127.0.0.1:5883
```

Drop in an MP3, press Separate, and listen to the stems. The first separation
downloads the Demucs weights (~80 MB) and, on a laptop CPU, takes a couple of
times the length of the song. Then press Analyse for the chord track.

Plug in a MIDI keyboard and play something: the panel on the left names it as
you play. That needs Web MIDI, which Chrome and Edge have and Safari and Firefox
do not; everything else in the page works anywhere.

## Seeing the point of it

```sh
node scripts/demo-hot-swap.ts blue-green
node scripts/demo-hot-swap.ts stop-start
```

A call is made to a worker, the config file is edited mid-call, and the call
finishes on the worker that replaced it. Nothing restarts.

The same thing with real models, end to end, over the same HTTP API the browser
uses:

```sh
node scripts/demo-phase1.ts [path/to/song.mp3]
```

A song is uploaded, decoded, separated by Demucs, checked stem by stem, and then
the separator is switched to RoFormer from the UI and the song is separated
again — while the page is polled five times a second to show the web server
never goes down with it. Or do it by hand: with the app running, pick the other
separator from the menu in the page header, or change the name in
`decomposable.config.yaml`.

```sh
node scripts/demo-phase2.ts
```

Eight voicings are pushed down the same websocket the browser's Web MIDI handler
uses — one key at a time, with human gaps between them, because a hand does not
land on five keys at once. Each one comes back named, classified and explained,
and the script checks the latency against the 50 ms budget.

```sh
node scripts/demo-phase3.ts [--separate]
```

A recording goes in and a chord track comes out: beats, transcription, chords
from the spectrum, chords from the notes, and a merge that prints `?` against
every window where the two routes disagreed.

## Layout

| Path | What is in it |
|------|---------------|
| `kernel/src` | Bootstrap, loader, `analysis-store`, `worker-supervisor`. |
| `harmony/` | The harmony engine: pure TypeScript, no I/O, no clock. Chord naming and voicing classification. |
| `kernel/conformance` | The contract suite every plugin must pass. |
| `plugins/<name>` | One plugin each: manifest, `index.ts`, contract test, README. |
| `workers/shim` | The Python side of the worker protocol, shared by every worker. |
| `ui` | The Svelte app, built into `ui/dist` and served by the `ui` plugin. |
| `fixtures/audio` | Synthesised audio. Nothing we do not own is committed. |
| `fixtures/harmony` | 230 hand-written pitch-set cases: notes in, expected label and voicing out. |
| `workspaces` | One folder per song: decoded audio, stems, and its own SQLite file. Gitignored. |

## Tests

```sh
pnpm test         # vitest: kernel, harmony, plugin contracts, golden tests. ~90 s.
pnpm test:slow    # the above plus separator-bsroformer's contract. ~6 min.
pnpm typecheck
```

`separator-bsroformer` is behind the slow flag because RoFormer needs about
eighty seconds just to read its checkpoint on a CPU. `transcriber-muscriptor` is
behind it *and* behind `HF_TOKEN`, because its weights are gated. Both are still
the contract and both still have to pass.

Every plugin has a `contract.test.ts` that runs the shared conformance suite: it
mounts and unmounts three times and fails on a leaked process, socket or timer;
it checks that everything the plugin writes carries provenance; and for a Python
worker it checks the warm-up budget and that a malformed job fails the call
rather than the process. A plugin without one does not merge.

The separator's golden test asserts that the stems sum back to the mix, which is
the property that distinguishes a separator from a noise generator.

The harmony engine has its own suite: 230 pitch-set fixtures in
`fixtures/harmony/pitch-sets.json`, each one a set of notes and the label and
voicing it should come back as, including every classic ambiguity the design
names — C6 against Am7, a rootless Cmaj9 against Em7, C7#9 against Eb/C, a
half-diminished against a minor sixth, and the tritone that belongs to two
dominants at once. A new hard case is a line of JSON.

## Licence

MIT. Model weights are downloaded on first use and never committed; each
worker's README states the licence of its weights.
