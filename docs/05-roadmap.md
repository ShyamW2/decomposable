# 05 — Roadmap

Phases are ordered so that something musically useful exists after each one and
so that the reliable parts carry the research-grade parts, not the reverse. Each
milestone names the model tier that should do the bulk of the work.

## Phase 0 — Skeleton that hot-swaps (the learning payoff first)

Goal: a running Cordis app with two trivial plugins, a config file, and a
demonstration that editing the config swaps a plugin with no restart and no leak.

- [ ] pnpm workspace, Node 24, TypeScript strict, vitest. **Sonnet**
- [ ] `kernel/`: bootstrap, loader over `musician.config.yaml`, `analysis-store`
      (SQLite, event log + per-layer views). **Opus** for the store's
      event/provenance model, **Sonnet** for the rest. No job queue (ADR-007).
- [ ] Conformance suite v0: mount/unmount ×3 leak check, provenance check,
      inject enforcement. **Opus**
- [ ] `worker-supervisor` + Python RPC shim in `workers/`, with an echo worker
      as the first py-worker plugin. Device detection (cpu/cuda/mps) with per-worker
      CPU fallback, and both swap policies, blue-green and stop-start. **Opus**
- [ ] Run the Phase 0 suite on a Mac once (O-9) so the mps path is real before
      any model worker is written.
- [ ] Exit criterion: a recorded demo of swapping `echo@1` for `echo@2` while a
      call is in flight; the call completes on the new worker. Run it once with
      blue-green and once with stop-start forced in config.

## Phase 1 — Hear and split

- [ ] `ingest` plugin (ffmpeg decode, song workspace). **Sonnet**
- [ ] `separator-htdemucs` py-worker, `lite` = htdemucs, `full` = htdemucs_ft,
      device auto. Must pass conformance on CPU and be verified on a Mac with `mps`.
      **Sonnet** from a brief.
- [ ] `ui` plugin serving a minimal browser app: upload, waveform, per-stem
      mute/solo playback. **Sonnet**
- [ ] `separator-bsroformer` as a second implementation; swap between them from
      the UI. **Sonnet**
- [ ] Exit criterion: drop in an MP3, get four stems, listen to each, swap the
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
