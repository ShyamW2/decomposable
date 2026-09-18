# 05 — Roadmap

Phases are ordered so that something musically useful exists after each one and
so that the reliable parts carry the research-grade parts, not the reverse. Each
milestone names the model tier that should do the bulk of the work.

## Phase 0 — Skeleton that hot-swaps (the learning payoff first)

Goal: a running Cordis app with two trivial plugins, a config file, and a
demonstration that editing the config swaps a plugin with no restart and no leak.

- [x] pnpm workspace, Node 24, TypeScript strict, vitest. **Sonnet**
- [x] `kernel/`: bootstrap, loader over `decomposable.config.yaml`, `analysis-store`
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

- [x] `harmony/` stages 1–3 (pitch profile, chord ranking, voicing classifier)
      with the pitch-set fixture suite. 230 pitch-set cases in
      `fixtures/harmony/pitch-sets.json` plus 28 unit tests. Vocabulary decision
      recorded as ADR-010.
- [x] `midi` service + Web MIDI in the browser; live voicing display.
- [x] Exit criterion: play any jazz voicing on the keyboard and see a ranked
      label with voicing type and reasons within 50 ms.
      `node scripts/demo-phase2.ts` pushes eight voicings — shell, drop 2, So
      What, upper-structure, altered, a bare tritone — down the same websocket
      the browser's Web MIDI handler uses, and checks the name, the voicing
      type, the reasons and the latency. Slowest answer on the dev box: 35 ms,
      of which 30 is the deliberate settle window.

## Phase 3 — Transcribe and analyse the record

- [x] `beat-tracker` py-worker. `lite` = librosa (no weights, no downbeats),
      `full` = Beat This!.
- [x] `transcriber-basicpitch` py-worker (CPU, the lite baseline).
- [~] `transcriber-muscriptor` as `full`. Written, typechecked, venv resolves —
      **but its weights are gated behind a HuggingFace licence and it has never
      run.** See O-9 and O-10. The `full` transcription profile does not exist
      until somebody accepts that licence.
- [x] `chord-audio` py-worker for the second opinion. **Not madmom**, which no
      longer builds; chroma and templates instead. See ADR-009.
- [x] chroma-per-beat from notes; run `harmony` over the record; `consensus`
      plugin.
- [~] Exit criterion: a chord track with voicings, with disagreement markers
      visible. `node scripts/demo-phase3.ts` does this end to end on the
      synthesised `groove.wav` fixture: five stages, two independent chord
      tracks merged, 8 of 14 windows marked contested, voicings on the chords.
      **What has not happened is the part the criterion is actually about: a
      real solo-piano recording and a real piano-trio recording.** There is no
      audio in this repository we own except what we synthesised (ADR-008), and
      a synthesised fixture cannot tell you whether this works on a record.
      That is the first thing to do with Phase 3, and it needs the owner to
      supply or record two clips.
- [ ] **Opus** evaluation harness comparing the transcribers on fixtures. Not
      built: with one working transcriber there is nothing to compare. It comes
      back with O-10.

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
    `pnpm test:slow`. Demucs stays the default in `decomposable.config.yaml`.
  - **Cordis 4.0.0-rc.10 ships extensionless relative imports in its `.d.ts`**,
    which `moduleResolution: nodenext` refuses; the repo typechecks with bundler
    resolution. Node runs the TypeScript directly, so there is no build step
    outside the browser app.
  - O-9 is now blocking two "verified on a Mac" boxes rather than one.

- 2026-09-18: Phases 2 and 3 implemented. What the next phase should know:

  - **The bass note is the strongest cue in the whole engine**, and it is worth
    more than the design's "strong bonus" implied. C6 and Am7 are the same four
    notes; Cmaj9-without-a-root and Em7 are the same four notes; Am7b5 and Cm6
    are the same four notes. In every case the bass decides and nothing else
    can. The weight ended up at 0.14 against a base score of at most 1, after a
    fixture (`C13(#11)` against `D7/C`) showed that 0.10 was not enough to beat
    a rival label that happened to be *complete*.
  - **Omitting a 5th is ordinary; omitting a 3rd is reaching.** Completeness
    alone does not express this, because it averages the omission away. An
    explicit penalty for a missing quality-defining tone is what stops E and
    B-flat reading as E diminished — claiming an absent G — rather than as the
    tritone of a dominant seventh missing only its root and its 5th.
  - **Scores must not be clipped at 1 before sorting.** Clipping flattens
    exactly the distinctions at the top of the ranking that the ranking exists
    to make; Csus2 and Gsus4 both hit the ceiling and the order became
    arbitrary. Normalising by the theoretical maximum keeps `score` in 0..1 and
    keeps the ordering.
  - **A fixture that is wrong is more useful than a fixture that passes.** Four
    of the hand-written hard cases were wrong about the music, not about the
    code: a C under a D triad is third-inversion D7 and not a foreign pedal; a
    ninth over a chord with no seventh is `add9`; E–A–D–G really is a complete
    A7sus4 until a bass says otherwise. The engine was right each time.
  - **`ii-v-i.wav` has no beats in it.** Its only strong onsets are the chord
    changes, so librosa reports 30 bpm and puts one beat on each bar line —
    correctly. `groove.wav` was added for anything that needs a pulse.
  - **madmom is gone** (ADR-009) and **MuScriptor is gated** (O-10). Two of the
    four Python libraries the roadmap named for Phase 3 could not be used as
    written. The plugin contract absorbed both without the rest of the app
    noticing, which is the first time the kernel has actually paid for itself.
  - **`harmony` windows want to be half a bar, not a beat.** Per beat, a passing
    note gets a whole window to itself and becomes a chord. The plugin default
    is still one beat (the finest honest resolution); the shipped config asks
    for two.
  - **Cordis v4's lack of optional injection bites once per optional service,
    not once.** `ui` now holds seven of them, so the child-fiber pattern from
    Phase 1 became `plugins/ui/optional.ts`. One fiber each, so unloading the
    separator does not also take the chord track away.
  - **`contractSuite` grew a `seed` hook.** A plugin that *consumes* a layer
    needs that layer present before its golden path runs, and those events are
    not its own — the provenance check would rightly object to them. `harmony`,
    `consensus`, `chord-audio` and `beat-tracker` all need it.
  - **Two kernel bugs that only four workers made easy to hit.** Booting the
    real config and shutting it down found both. First, SIGTERM reaches the
    whole process group, so the Python side exits before the supervisor writes
    `shutdown` to it — and the unhandled EPIPE on that closed pipe aborted Node,
    taking the kernel and every plugin with it. Second, a slot whose process
    died while *idle* never set `state = 'failed'` (that only happens in
    `pump`'s error handler, and there was no job in flight to fail), so the next
    job queued behind a worker that was never coming back and waited forever.
    Both are fixed with regression tests. Both would have been just as true in
    Phase 1; running four workers at once is what made them show up.
