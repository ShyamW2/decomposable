# 03 — Architecture

Status: ADR-001, 003, 004, 005, 007 accepted; ADR-002, 006, 008 proposed. Build only
what the current roadmap phase needs (ADR-007); sections marked *later* are direction, not scope.

## Shape in one picture

```
 ┌──────────────────────────────── Cordis root context (Node 24) ─────────────────────────────┐
 │                                                                                             │
 │  services (singletons provided by plugins, injected by name)                                │
 │   analysis-store   worker-supervisor   harmony   ws   midi   agent-bridge                    │
 │                                                                                             │
 │  plugin branches (each an isolated child context, torn down as a unit)                      │
 │   ┌─────────────┐ ┌────────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────┐   │
 │   │ ingest      │ │ separator      │ │ transcriber  │ │ beat-tracker │ │ chord-audio    │   │
 │   │ (ffmpeg)    │ │ (htdemucs_ft)  │ │ (muscriptor) │ │ (beat-this)  │ │ (madmom)       │   │
 │   └─────────────┘ └──────┬─────────┘ └──────┬───────┘ └──────┬───────┘ └──────┬─────────┘   │
 │                          │ owns              │ owns          │ owns           │ owns        │
 │   ┌─────────────┐ ┌──────▼─────────┐ ┌──────▼───────┐ ┌──────▼───────┐ ┌──────▼─────────┐   │
 │   │ harmony     │ │ py worker      │ │ py worker    │ │ py worker    │ │ py worker      │   │
 │   │ (pure TS)   │ │ (venv, GPU 0)  │ │ (venv, GPU1) │ │ (venv, CPU)  │ │ (venv, CPU)    │   │
 │   └─────────────┘ └────────────────┘ └──────────────┘ └──────────────┘ └────────────────┘   │
 │   ┌─────────────┐ ┌────────────────┐ ┌──────────────┐ ┌──────────────┐                      │
 │   │ progression │ │ consensus      │ │ notation     │ │ ui (server)  │ ◄── browser: Web MIDI,│
 │   │ (pure TS)   │ │ (pure TS)      │ │ (MusicXML)   │ │              │     OSMD, wavesurfer  │
 │   └─────────────┘ └────────────────┘ └──────────────┘ └──────────────┘                      │
 │   ┌─────────────┐                                                                           │
 │   │ agent-bridge│ ── spawns `claude -p` / `codex exec` in a git worktree, runs contract      │
 │   │             │    tests, asks the loader to mount the result                              │
 │   └─────────────┘                                                                           │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## The four load-bearing ideas

### 1. Cordis is the kernel; everything is a plugin

We use Cordis as-is (ADR-001). A plugin is a module exporting `name`, `inject`
(the services it needs), optionally `Config`, and `apply(ctx, config)`. Everything
a plugin does that has an inverse (spawn a process, open a socket, register a
route, subscribe to an event, start a timer) goes through `ctx.effect(() => {
...; return cleanup })`. Cordis records these in a LIFO stack and unwinds them on
dispose. That single rule is what makes hot swap and blast-radius confinement
mechanical rather than heroic.

Services are provided by plugins and injected by name. A plugin whose service
disappears (because its provider was unloaded) is suspended, not crashed, and
resumes when a provider returns. This is the "zero downtime" story: unload
`separator@htdemucs`, load `separator@bsroformer`; anything depending on the
`separator` service pauses for the seconds in between and resumes.

The loader reads a declarative `musician.config.yaml` listing plugins and their
config. Editing that file (or the UI doing so) triggers reconciliation: only
plugins whose entries changed are unmounted or remounted.

### 2. Python workers behind a process boundary

Every ML model is a Python process with its own venv (`uv`), speaking a tiny
JSON-RPC-over-stdio protocol (`hello`, `capabilities`, `run(job)`, `progress`,
`result`, `shutdown`). A Cordis plugin owns it:

```ts
export const name = 'separator-htdemucs'
export const inject = ['worker-supervisor', 'analysis-store']
export function apply(ctx: Context, config: Config) {
  const worker = ctx.effect(() => ctx['worker-supervisor'].spawn({
    venv: 'workers/separator-htdemucs',
    device: config.device ?? 'auto',    // cpu | cuda | mps | auto
    model: config.model ?? 'auto',      // lite | full | auto (from the manifest)
  }))                                   // cleanup kills the process
  ctx.provide('separator', {            // implements the Separator contract
    async separate(audioRef) { return worker.run({ kind: 'separate', audioRef }) },
  })
}
```

A worker call is a promise with a progress callback and a cancel. There is no
job framework (ADR-007).

Hardware profiles (ADR-002): the manifest lists supported devices and a `lite`
and `full` model with estimated peak memory. The supervisor detects CPU, CUDA
and MPS at start and resolves `auto` per worker; the config can pin anything.
Replacement policy: `blue-green` (start new, wait for its `hello` after model
load, then dispose old) when free memory allows, otherwise `stop-start`, during
which dependents are suspended by Cordis rather than failed. On the dev box
blue-green is the norm; on a laptop stop-start is.

Runaway protection: the supervisor enforces per-worker memory and time limits,
kills on breach, and the owning plugin reports a failed job. Nothing else in the
tree notices.

### 3. The analysis document is event-sourced with provenance

One song = one analysis document = an append-only log of events, each with:

```ts
interface Event<T> {
  id: string; songId: string; at: string;            // ISO time
  producer: { plugin: string; version: string };      // who made it
  inputs: string[];                                    // event ids it derived from
  confidence?: number;                                 // 0..1 when meaningful
  layer: 'audio' | 'stem' | 'beat' | 'note' | 'chroma' | 'chord' | 'voicing'
       | 'progression' | 'key' | 'notation' | 'midi-live' | 'annotation';
  payload: T;
}
```

A materialised view (per layer, per time range) is what the UI and other plugins
query. Because inputs are recorded, re-running one plugin invalidates exactly its
descendants. Because producer and version are recorded, two versions of the
harmony engine can be run on the same song and diffed (ADR-004). Storage: SQLite
via a single `analysis-store` service; no plugin touches the database directly.

Time is in seconds from the start of the decoded audio everywhere. Beats and bars
are a layer, not a coordinate system, so a change of beat tracker never moves notes.

A song workspace is a plain folder: `workspaces/<songId>/` holding the decoded
audio, stems, and its own SQLite file. Copy the folder to another machine and
the analysis opens there; this is how a song separated on the desktop is studied
on the laptop. Workspaces are gitignored (ADR-008).

### 4. The plugin contract is small enough for an agent to satisfy

A plugin directory:

```
plugins/<name>/
  manifest.json      name, version, inject[], provides[], kind (ts | py-worker), gpu?
  index.ts           the Cordis plugin
  worker/            (py-worker only) pyproject.toml, main.py implementing the RPC
  contract.test.ts   REQUIRED: passes the shared conformance suite for its kind
  README.md          what it does, inputs, outputs, known failure modes
```

The shared conformance suite (in `kernel/conformance/`) checks, for every plugin:
mounts and unmounts cleanly three times with no leaked handles, timers, or child
processes; every event it emits has producer, version, inputs, and a valid layer;
it only accesses services listed in `inject`; a py-worker answers `hello` within
its declared warm-up budget and survives a malformed job without dying. Kind-
specific suites add golden tests (a separator must produce N stems summing
approximately to the input; a chord producer must label the fixtures in
`fixtures/harmony/` above a threshold).

This suite is the contract an in-app agent is given. See `07-delegation.md` for
the brief format; the agent-bridge plugin fills that template automatically.

## The agent bridge

`agent-bridge` provides a service and a UI panel. Flow:

1. User types a request ("detect Coltrane changes in the progression layer").
2. The bridge creates a git worktree, writes a task brief (template + contract +
   relevant fixtures + the two most similar existing plugins as examples) and runs
   `claude -p` or `codex exec` in that worktree with a tool allowlist limited to
   the worktree.
3. The agent's result is built and the conformance suite runs in the worktree.
4. On green, the bridge shows the diff and the test report; on user approval it
   copies the plugin into `plugins/` and edits `musician.config.yaml`. The loader
   mounts it. On red, the report is shown and the worktree kept for iteration.

Security boundary: an agent-written plugin never gets a service it did not
declare, runs its Python in its own venv and process, and can be unmounted from
the UI. That is not a sandbox against a hostile plugin; it is confinement against
a buggy one, which is the realistic threat here.

## Pipeline for one song (happy path)

```
ingest → separator → { transcriber(stem) × N , chord-audio(mix) } → beat-tracker
       → chroma-per-beat (from notes and from audio) → harmony (chords + voicings, ranked)
       → consensus (merge the audio, symbolic, and live-MIDI chord tracks)
       → progression (key, Roman numerals, idioms) → notation (MusicXML per stem + lead sheet)
```

Each arrow is an event subscription on the analysis store, not a function call, so
any stage can be re-run, replaced, or added to without touching its neighbours.

## Live MIDI path

Browser Web MIDI → websocket → `midi` service → `midi-live` layer events (note on/off
with wall-clock and, when playback is running, song-time). The `harmony` plugin
subscribes and emits `voicing` events with `producer=harmony`, `inputs=[midi
events]`. The UI shows them beside the record's voicing at the same song time.

## Repository layout (proposed)

```
musician/
  CLAUDE.md
  docs/
  kernel/            bootstrap, loader config, worker-supervisor, analysis-store, conformance suite
  harmony/           pure TS: pitch sets, chord naming, voicing classifier, progression parser
  plugins/           one directory per plugin (see contract)
  workers/           shared Python RPC shim used by every py-worker
  ui/                browser app (Svelte or React, ADR-005), served by the ui plugin
  fixtures/          audio clips, MIDI, and hand-labelled harmony cases
  musician.config.yaml
```

## Things deliberately left out for now (ADR-007)

- A message broker or job queue. Cordis events plus SQLite are enough on one
  machine.
- Remote workers. The stdio protocol means a worker on the desktop can later be
  reached from the laptop with `ssh desktop python -m worker`; nothing to build now.
- A desktop shell. The browser is the UI; Tauri or Electron can wrap it later.
- Authentication. Single user, `ui` binds to localhost. It is the one place auth
  would go (ADR-008).
- A browser-only lite mode (harmony engine plus Basic Pitch in TensorFlow.js).
  Possible because the harmony engine is pure TS; keep the MIDI path free of
  server assumptions so this stays open.

## Log

- 2026-09-18: first draft. Cordis identified as the actual kernel rather than a metaphor.
