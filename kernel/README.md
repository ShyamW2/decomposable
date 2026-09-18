# kernel

Everything here is either the bootstrap, a service that plugins inject, or the
suite that decides whether a plugin is allowed to exist.

| Path | What it is |
|------|------------|
| `src/app.ts`, `src/main.ts` | Boot: one root context, one loader, whatever the config says. |
| `src/loader.ts` | Reads `decomposable.config.yaml` and reconciles the running tree against it. |
| `src/analysis-store/` | The analysis document: append-only events with provenance, one SQLite file per song. |
| `src/worker-supervisor/` | Python worker processes: device detection, slots, swap policies, runaway limits. |
| `src/services.ts` | Contracts implemented by more than one plugin (`Separator`, `Transcriber`), and the payload shapes one plugin writes and another reads. |
| `src/separator-service.ts` | The half of a separator plugin that is the same whichever model does the work. |
| `src/transcriber-service.ts` | The same, for transcribers: which stems to point the model at, and writing the notes down with provenance. |
| `src/contracts.ts` | The service and event names, declared once so `ctx['analysis-store']` is typed. |
| `src/types.ts` | Events, layers, manifests, devices, profiles. |
| `src/wav.ts` | Enough WAV reading for peak envelopes and golden tests. |
| `conformance/` | The plugin contract, as a runnable suite. |

## The loader

The loader is ours rather than `@cordisjs/plugin-loader` because plugins here are
addressed by directory, not by npm package (ADR-007). It reconciles: a plugin
whose entry is untouched is never remounted, which is what makes swapping one
separator for another cost seconds instead of a restart.

It fingerprints each plugin's own source files and puts that in the import URL,
so editing a plugin and touching the config reloads the new code. Files a plugin
imports from outside its directory are not covered.

Two plugins cannot provide the same service at once — Cordis refuses — so a
reload is always dispose-then-mount. Whatever injected the service is suspended
by Cordis for the gap and resumes by itself.

## Worker slots

A worker call is made against a *slot*, not against a process. When the process
underneath is replaced, in-flight jobs are re-dispatched to the replacement, so
the caller sees a call that took longer rather than a call that failed. Worker
jobs must therefore be re-runnable; model inference is, and nothing else belongs
in a worker.

The two swap policies differ only in whether the old process is still alive
while the new one warms up:

- `blue-green` — start the new process, then kill the old. Two models in memory
  at once, a gap of nearly nothing.
- `stop-start` — kill the old process first. One model in memory, a gap as long
  as the new model takes to load.
- `auto` — blue-green when free memory covers the new worker's estimated peak.
  On the dev box that is the norm; on an 8 GB laptop it is not.

Releasing a slot kills its process immediately *unless* the loader announced a
replacement first, so an ordinary unload leaves no background timer for a
contract test to find.

Workers are spawned as `<worker>/.venv/bin/python main.py`, after a `uv sync`,
rather than through `uv run`. `uv run` makes Python a child of itself, which
would mean supervising a wrapper: the wrong process to measure the memory of and
the wrong one to kill.

## The analysis document

One song is one workspace folder with its own SQLite file, so copying the folder
moves the analysis to another machine. Every event carries `{producer, version,
inputs, layer}` and the store refuses one that does not. Re-running a producer
supersedes its events *and their descendants*, found by a recursive query over
the derivation edge; nothing is deleted, so a re-run stays diffable against what
it replaced (ADR-004).

Time is seconds from the start of the decoded audio, everywhere. Beats and bars
are a layer, not a coordinate system, so changing the beat tracker never moves a
note.
