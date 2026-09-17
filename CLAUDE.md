# Musician — project brief for Claude

Musician is a self-extending music analysis workbench. It takes a song (MP3), splits it
into stems, transcribes each stem to notes, and explains the harmony at the level a
working musician cares about: not just "Cmaj7" but *which* voicing, *why* it works in
the progression, and how it compares to what you are playing right now on the MIDI
keyboard plugged in. The app is built as a plugin kernel (Cordis) so every capability
can be hot-swapped without restarting, a crashing plugin cannot take down the rest,
and the app can ask a coding agent to write new plugins for it from inside the UI.

Status (2026-09-18): design phase. Nothing is implemented yet. ADR-001, 003, 004,
005 and 007 are **accepted**; ADR-002 was revised for laptop portability and, with 006
and 008, is still **proposed**. See `docs/06-decisions.md`.

## How to use this file and the docs

- Read `docs/README.md` first; it indexes everything.
- `docs/01-vision.md` is the "why" and the list of things that would make this new.
- `docs/03-architecture.md` and `docs/04-harmony-engine.md` are the design authority.
  If code and docs disagree, fix one of them in the same change.
- `docs/06-decisions.md` is an ADR log. Never silently reverse an accepted decision;
  add a new ADR that supersedes it.

## Roles by model tier

The owner wants this project to be a learning experience and a place to think big.
Work is split by how much judgement it needs:

| Tier | Use for | Examples |
|------|---------|----------|
| Fable / Mythos (this session) | Architecture, novel propositions, hard music-theory design, reviewing plans, writing ADRs, deciding what to delegate | Designing the voicing classifier, choosing the plugin contract, harmony grammar |
| Opus | Demanding but well-specified implementation, tricky debugging, integration across plugins | Wiring the Python worker supervisor, building the progression parser from its spec |
| Sonnet | Well-bounded tasks with a clear definition of done | A single plugin from a spec, tests, UI components, docs, refactors |

When you are the high tier: spend your effort on the thinking, then write a task
brief using the template in `docs/07-delegation.md` and hand it down. Do not do
Sonnet-shaped work yourself unless it is on the critical path of a design question.

When you are a lower tier: stay inside the brief. If the brief is wrong or under-specified,
say so and stop rather than improvising architecture. Do not touch ADRs.

## Non-negotiables (apply to every tier)

1. **Everything is a plugin.** New capability goes in `plugins/<name>/` with a manifest,
   a contract test, and no imports from other plugins except through services.
   See the plugin contract in `docs/03-architecture.md`.
2. **Provenance on every analysis result.** Every note, chord, beat, or label carries
   `{producer, version, confidence, inputs}`. No anonymous data in the analysis document.
3. **Music theory is deterministic and tested.** The harmony engine is pure TypeScript
   with table-driven tests. ML lives in Python workers behind a process boundary.
4. **Never block the kernel.** Anything that takes more than ~50 ms runs in a worker or
   a job. GPU work always runs in a separate process.
5. **Ambiguity is data, not a bug.** Chord labelling returns ranked candidates. The UI
   shows the runner-up when the margin is small.
6. **Hot-swap safety.** Every plugin registers all side effects through `ctx.effect` so
   teardown is complete. A plugin that leaks a handle fails its contract test.
7. **As simple as possible.** No abstraction until a second concrete use exists. No
   message broker, no job framework, no ORM, one SQLite file, one config file. A plugin
   is one file until it needs more. If a design doc describes machinery that the current
   phase does not need, build the smaller thing and note the gap.
8. **Runs on a laptop, and on a Mac.** Baseline is a 4-core CPU with 8 GB RAM and no
   GPU. Apple Silicon is a first-class target: every worker supports `mps` where its
   library can and falls back to CPU where it cannot. The dev box has CUDA GPUs; the
   tests, the defaults and the docs must not assume one. A worker is not "done" until
   it has run on a Mac, and its README says which.

## Conventions (fill in as the code appears)

- Language: TypeScript (Node 24) for the kernel, harmony engine, UI (Svelte), and agent
  bridge. Python 3.11+ (separate venv per worker) for ML workers. Do not mix.
- Licence: MIT. Model weights are downloaded on first use, never committed; each worker's
  README states the weight licence (MuScriptor is CC BY 4.0, some RoFormer weights are
  non-commercial).
- Privacy: song audio, stems and analysis workspaces are gitignored. Fixtures are only
  clips we own or synthesise. No secrets in the repo; agent CLIs use their own auth.
- Package manager: pnpm workspaces. Python: uv.
- Tests: vitest for TS, pytest for Python. A plugin without a contract test does not merge.
- Commit messages: imperative subject, a body that says *why*. Reference the ADR if
  the change implements one.
- Hardware on the dev box: 3× RTX 3060 (12 GB each), Linux. Treat it as the "full"
  profile. The "lite" profile (4 cores, 8 GB RAM, CPU only) is the baseline everything
  must pass on, and Apple Silicon (`mps`) is verified separately since Linux cannot.

## Owner decisions so far

Recorded under "Owner answers" in `docs/06-decisions.md`: Cordis kernel, Svelte, web
first with Tauri/Electron later, both Claude Code and Codex behind one agent interface,
MIT, no project name yet, private for now but shareable on GitHub later, 4-core/8 GB
laptop baseline, Apple Silicon first-class. Ask before assuming on anything still listed
as open there.
