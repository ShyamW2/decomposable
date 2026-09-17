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

Phases 0 and 1 of [the roadmap](docs/05-roadmap.md) are implemented: the kernel
hot-swaps, and a song can be ingested, separated into stems and listened to in
the browser with mute and solo, with the separator swapped underneath without a
restart.

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
times the length of the song.

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

## Layout

| Path | What is in it |
|------|---------------|
| `kernel/src` | Bootstrap, loader, `analysis-store`, `worker-supervisor`. |
| `kernel/conformance` | The contract suite every plugin must pass. |
| `plugins/<name>` | One plugin each: manifest, `index.ts`, contract test, README. |
| `workers/shim` | The Python side of the worker protocol, shared by every worker. |
| `ui` | The Svelte app, built into `ui/dist` and served by the `ui` plugin. |
| `fixtures` | Synthesised audio. Nothing we do not own is committed. |
| `workspaces` | One folder per song: decoded audio, stems, and its own SQLite file. Gitignored. |

## Tests

```sh
pnpm test         # vitest: kernel, plugin contracts, golden tests. ~20 s.
pnpm test:slow    # the above plus separator-bsroformer's contract. ~5 min.
pnpm typecheck
```

`separator-bsroformer` is behind the slow flag because RoFormer needs about
eighty seconds just to read its checkpoint on a CPU; it is still the contract and
it still has to pass.

Every plugin has a `contract.test.ts` that runs the shared conformance suite: it
mounts and unmounts three times and fails on a leaked process, socket or timer;
it checks that everything the plugin writes carries provenance; and for a Python
worker it checks the warm-up budget and that a malformed job fails the call
rather than the process. A plugin without one does not merge.

The separator's golden test asserts that the stems sum back to the mix, which is
the property that distinguishes a separator from a noise generator.

## Licence

MIT. Model weights are downloaded on first use and never committed; each
worker's README states the licence of its weights.
