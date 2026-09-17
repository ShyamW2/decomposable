# 06 — Decisions (ADR log)

Format: ID, title, status (proposed | accepted | superseded by X), date, context,
decision, consequences. Proposed ADRs are the high-tier model's recommendation and
need the owner's "accepted" before lower tiers build on them.

---

## ADR-001 — Use Cordis as the plugin kernel

Status: accepted · 2026-09-18

Context: the brief asked for Cordis-like decomposability, zero-downtime hot swap,
and blast-radius confinement. Cordis is a real MIT TypeScript meta-framework
(Koishi, DeepSeek Harness) that provides these via `ctx.effect`, a context tree,
service-based dependency resolution with suspend/resume, and a reconciling loader.

Decision: use Cordis directly rather than build an imitation. The kernel, harmony
engine, UI, and agent bridge are TypeScript on Node 24.

Consequences: TypeScript becomes the primary language. We inherit Cordis's
conventions (plugins as `apply(ctx, config)`, services via declaration merging).
Learning Cordis is part of the project. Risk: Cordis's docs are thinner than its
codebase; we will read source.

Alternatives considered: Elixir/OTP (best-in-class supervision and hot code loading,
but a second language far from the ML and UI ecosystems); Python-only with a
process supervisor (simplest, but hot swap and effect teardown would be hand-rolled
and the browser UI would still need TypeScript).

## ADR-002 — ML models run as device-agnostic Python worker processes

Status: proposed (revised for laptop portability) · 2026-09-18

Context: Demucs, BS-RoFormer, MuScriptor, madmom, and Beat This! are Python and
have conflicting dependency sets. The app is developed on a 3-GPU desktop but must
run on an ordinary laptop, and the desktop is not always on.

Decision: one venv per worker (uv), one process per worker, JSON-RPC over stdio,
spawned inside `ctx.effect` by the owning Cordis plugin. Each worker declares in its
manifest the devices it supports (`cpu`, `cuda`, `mps`), a `lite` and a `full`
model choice, and an estimated peak memory for each. The `worker-supervisor`
detects hardware at start, picks a device and model per worker (`auto`), and lets
`musician.config.yaml` override both. Replacement policy is also automatic:
`blue-green` (start new, warm, then dispose old) when free memory allows it,
otherwise `stop-start` (dispose old, then start new). Cordis service suspension
covers the gap in the second case.

Consequences: the process boundary is the blast radius on every machine. The
"lite" profile (htdemucs non-ft, Basic Pitch, madmom, CPU, 4 cores, 8 GB RAM) is
the baseline every worker must pass conformance on; "full" (htdemucs_ft or
BS-RoFormer, MuScriptor, CUDA) is what the dev box uses. Apple Silicon is a
first-class target (O-8): every worker must run on `mps` where the underlying
library supports it and fall back to CPU where it does not, and a worker is not
"done" until it has been run on a Mac. The Linux dev box cannot verify this, so
each worker README records the last Mac it was checked on. Analysis workspaces (SQLite file plus stems) are
plain folders, so a song analysed on the desktop can be opened on the laptop.
Because the protocol is stdio, running a worker on the desktop from the laptop
later is `ssh desktop python -m worker` with no protocol change; we do not build
that until it is needed (ADR-007).

## ADR-003 — The harmony engine is pure TypeScript and deterministic

Status: accepted · 2026-09-18

Decision: chord naming, voicing classification, key finding, and progression
parsing are pure functions in `harmony/` with table-driven fixtures. No ML in
this layer in phases 0–5. Ranked candidates with reasons are the output type.

Consequences: fast enough for live MIDI in-process; testable without audio;
usable both for the record and for the player. tonal.js may be used for
primitives (note names, intervals) but not for chord naming, which is ours.

## ADR-004 — Event-sourced analysis document with provenance

Status: accepted · 2026-09-18

Decision: every analysis result is an append-only event with producer, version,
inputs, confidence, and layer. Materialised per-layer views serve queries. SQLite
storage behind the `analysis-store` service.

Consequences: re-analysis, plugin version diffs, and the consensus mechanism come
for free. Plugins never talk to the database directly. Storage grows; we keep
audio out of the log (references only).

## ADR-005 — UI is a Svelte web app served by a plugin

Status: accepted · 2026-09-18

Decision: the UI is a Svelte web app using Web MIDI, Web Audio,
OpenSheetMusicDisplay, and wavesurfer.js. Served and fed over websocket by the
`ui` plugin. Web first; a Tauri or Electron desktop wrapper comes later if the
functionality justifies it. Because the harmony engine is pure TypeScript and
Basic Pitch has a TensorFlow.js build, a browser-only "lite" mode (MIDI analysis
and light transcription with no server) is a possible hosted form later; it is
noted here so nothing in the UI assumes the server exists for the MIDI path.

## ADR-006 — Agent-authored plugins are gated by the conformance suite

Status: proposed · 2026-09-18

Decision: the in-app agent works in a git worktree; a plugin is mounted only after
the conformance suite passes and the user approves the diff. The brief handed to the
agent is generated from the template in `07-delegation.md`.

Consequences: the conformance suite is a first-class deliverable, not an
afterthought. The plugin contract stays small on purpose. The bridge talks to
agents through one small interface (`run(brief, worktree) → report`) with a
Claude Code adapter (`claude -p`) and a Codex adapter (`codex exec`); a DeepSeek
Harness adapter is a likely third since it shares the Cordis kernel.

## ADR-007 — Simplicity is a constraint, not a preference

Status: accepted · 2026-09-18

Context: the owner asked to keep the codebase as simple as possible, and the
project is a learning vehicle where every extra layer is a cost paid on every
future task, including those done by smaller models.

Decision: no abstraction until a second concrete use exists. Concretely, at the
start: no message broker, no job framework (a worker call is a promise with a
progress callback and a cancel), no ORM (plain SQL against one SQLite file), no
monorepo tooling beyond pnpm workspaces, a plugin is one file until it needs
more. Design docs may describe where something would go; the code builds only
what the current phase needs and the docs mark the gap.

Consequences: some things in `03-architecture.md` are explicitly "later". Reviewers
reject speculative generality. Delegation briefs must say what *not* to build.

## ADR-008 — Private by default, shareable by design

Status: proposed · 2026-09-18

Context: initially the owner's own tool; later likely public on GitHub and
possibly offered as an app.

Decision: repository is MIT. Song audio, stems, analysis workspaces, model weights
and agent credentials are never committed (gitignored from day one; fixtures are
owned or synthesised clips only). Each worker README states its model's licence
so a future release can exclude non-commercial weights. No authentication is
built now, but the `ui` plugin is the only network-facing plugin, binds to
localhost by default, and is the single place auth would be added. The agent
bridge is disabled unless explicitly enabled in config, since it executes generated
code; a hosted version would not ship it.

Consequences: sharing the repo later is a licence review, not a refactor. Hosting
is a separate design (probably the browser-only lite mode from ADR-005) because
processing other people's copyrighted audio server-side has legal weight we do
not want yet.

---

## Owner answers (2026-09-18)

- **O-1** Project name: none yet; "Musician" stays a placeholder.
- **O-2** UI framework: Svelte.
- **O-3** Agent bridge: both Claude Code and Codex behind one interface; DeepSeek
  Harness possibly later.
- **O-4** Licence: MIT.
- **O-5** GPU assignment: owner unsure, and the dev box is not always running.
  Resolved in ADR-002 as `auto` with config override.
- **O-6** Sharing: private now, GitHub later, possibly an app. Resolved in ADR-008.
- Laptop portability: required. Resolved in ADR-002 (lite/full profiles) and
  non-negotiable 8 in CLAUDE.md.

- **O-7** Minimum laptop for the lite profile: 4-core CPU, 8 GB RAM, no GPU.
  Separation may take up to 3× song length.
- **O-8** Apple Silicon (MPS) is a first-class target. Resolved in ADR-002.

## Open

- **O-9** Which Mac is available for verifying workers, and whether a Mac should run
  the test suite regularly (a GitHub Actions macOS runner once the repo is on GitHub).
