# 05 — Roadmap

Phases are ordered so that something musically useful exists after each one and
so that the reliable parts carry the research-grade parts, not the reverse. Each
milestone names the model tier that should do the bulk of the work.

## Phase 0 — Skeleton that hot-swaps (the learning payoff first)

Goal: a running Cordis app with two trivial plugins, a config file, and a
demonstration that editing the config swaps a plugin with no restart and no leak.

- [x] pnpm workspace, Node 24, TypeScript strict, vitest. **Sonnet**
- [x] `kernel/`: bootstrap, loader over `musician.config.yaml`, `analysis-store`
      (SQLite, event log + per-layer views). **Opus** for the store's
      event/provenance model, **Sonnet** for the rest. No job queue (ADR-007).
- [x] Conformance suite v0: mount/unmount ×3 leak check, provenance check,
      inject enforcement. **Opus**
- [x] `worker-supervisor` + Python RPC shim in `workers/`, with an echo worker
      as the first py-worker plugin. Device detection (cpu/cuda/mps) with per-worker
      CPU fallback, and both swap policies, blue-green and stop-start. **Opus**
- [ ] Run the Phase 0 suite on a Mac once (O-9) so the mps path is real before
      any model worker is written. **Still open: no Mac available to this session.**
- [x] Exit criterion: a recorded demo of swapping `echo@1` for `echo@2` while a
      call is in flight; the call completes on the new worker. Run it once with
      blue-green and once with stop-start forced in config.
      `node scripts/demo-hot-swap.ts blue-green|stop-start`, and the same thing
      asserted in `kernel/src/hot-swap.test.ts`.

## Phase 1 — Hear and split

- [x] `ingest` plugin (ffmpeg decode, song workspace). **Sonnet**
- [x] `separator-htdemucs` py-worker, `lite` = htdemucs, `full` = htdemucs_ft,
      device auto. Must pass conformance on CPU and be verified on a Mac with `mps`.
      **Sonnet** from a brief. *CPU and CUDA verified; `mps` still pending O-9.*
- [x] `ui` plugin serving a minimal browser app: upload, waveform, per-stem
      mute/solo playback. **Sonnet**
- [x] `separator-bsroformer` as a second implementation; swap between them from
      the UI. **Sonnet**
- [x] Exit criterion: drop in an MP3, get four stems, listen to each, swap the
      separator without restarting.

## Phase 2 — Harmony engine on MIDI (no transcription risk yet)

- [ ] `harmony/` stages 1–3 (pitch profile, chord ranking, voicing classifier)
      with the pitch-set fixture suite. **Fable designs, Opus implements**, Sonnet
      writes fixtures from the design's list of hard cases.
- [ ] `midi` service + Web MIDI in the browser; live voicing display. **Sonnet**
- [ ] Exit criterion: play any jazz voicing on the keyboard and see a ranked
      label with voicing type and reasons within 50 ms. This alone is a product.

## Phase 3 — Transcribe and analyse the record

- [ ] `beat-tracker` py-worker (Beat This! or madmom). **Sonnet**
- [ ] `transcriber-basicpitch` py-worker first (CPU, the lite baseline), then
      `transcriber-muscriptor` on the mix and per stem as `full`. **Sonnet**, with
      **Opus** for the evaluation harness comparing them on fixtures.
- [ ] `chord-audio` py-worker (madmom CNN chords) for the second opinion. **Sonnet**
- [ ] chroma-per-beat from notes; run `harmony` over the record; `consensus`
      plugin. **Opus**
- [ ] Exit criterion: a chord track with voicings for a solo-piano recording
      and for a piano-trio recording, with disagreement markers visible.

## Phase 4 — Progressions and notation

- [ ] Key finding and the pattern layer of the progression parser. **Fable specifies
      the pattern list, Opus implements, Sonnet writes progression fixtures.**
- [ ] `notation` plugin: quantise to the beat grid, emit MusicXML per stem and a
      lead sheet with chord symbols; render with OpenSheetMusicDisplay. **Sonnet**
- [ ] Play-along view: record voicing vs live voicing at the same beat. **Sonnet**
- [ ] Exit criterion: a lead sheet with Roman numerals and named idioms for a
      standard, readable without editing.

## Phase 5 — The workbench grows itself

- [ ] `agent-bridge` plugin: worktree, brief generation from the template,
      `claude -p` / `codex exec` runner, conformance gate, mount on approval. **Opus**
- [ ] UI panel for requests, diffs, and test reports. **Sonnet**
- [ ] First agent-authored plugin end to end (suggested: Coltrane-changes detector,
      because it is pure TS with obvious fixtures). **The agent, supervised by Fable.**
- [ ] Exit criterion: request a plugin in the UI, watch it appear and run, unload
      it from the UI.

## Phase 6 — Research-grade parts, each in its own swappable plugin

- Progression grammar (PCFG) replacing or augmenting the pattern layer.
- Guitar-specific transcription and voicing inference (string/fret assignment).
- Structure segmentation (verse/chorus) to scope key finding.
- Style corpus: "how would X voice this" from a corpus of transcribed voicings.

## Explicitly deferred

Cloud deployment, multi-user, authentication, DAW integration, audio editing, a
desktop shell (Tauri/Electron), remote workers over ssh, a browser-only lite mode.

## Log

- 2026-09-18: first draft.
- 2026-09-18: Phases 0 and 1 implemented. Notes for whoever picks up Phase 2,
  and things the design docs should probably absorb:

  - **Cordis v4 has no optional injection.** Everything in `inject` is required,
    and a plugin is suspended the moment any of them goes away. The `ui` plugin
    therefore does *not* inject `separator`; it holds it in a child fiber via
    `ctx.inject`, so the web server survives a separator swap. Any plugin that
    should outlive one of its dependencies needs the same shape.
  - **Two plugins cannot provide one service at the same time** — Cordis refuses
    the second `provide`. So a reload is always dispose-then-mount, and
    blue-green lives at the *process* level in the supervisor rather than at the
    plugin level. `03-architecture.md`'s "start new, wait for hello, then dispose
    old" is right about processes and not about plugins.
  - **`ctx.effect` returns a disposer, not the value.** The snippet in
    `03-architecture.md` (`const worker = ctx.effect(() => supervisor.spawn(...))`)
    does not typecheck against Cordis v4; the real shape is `const worker =
    supervisor.acquire(...)` followed by `ctx.effect(() => () => worker.release())`.
  - **Workers are spawned as `<venv>/bin/python`, after `uv sync`**, not via
    `uv run`: `uv run` makes Python a child of itself, so the supervisor would be
    measuring and killing a wrapper. This was found by a memory-limit test that
    never fired.
  - **A worker call survives its process.** Calls are made against a slot, and a
    job in flight when the process is replaced is re-dispatched to the
    replacement. That is what the Phase 0 exit criterion actually requires, and
    it means worker jobs must be re-runnable.
  - **Two separators disagree about what a stem is.** Demucs gives four stems,
    RoFormer gives vocals and instrumental. The `Separator` contract returns
    named stems and promises nothing about which; Phase 3 must read the names.
  - **RoFormer on a CPU is about 13× real time**, against Demucs's 0.7×, and takes
    80 s just to read its checkpoint. Its contract test is behind
    `pnpm test:slow`. Demucs stays the default in `musician.config.yaml`.
  - **Cordis 4.0.0-rc.10 ships extensionless relative imports in its `.d.ts`**,
    which `moduleResolution: nodenext` refuses; the repo typechecks with bundler
    resolution. Node runs the TypeScript directly, so there is no build step
    outside the browser app.
  - O-9 is now blocking two "verified on a Mac" boxes rather than one.
