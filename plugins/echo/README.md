# echo

The smallest possible `py-worker` plugin. It has no model and does nothing
musical; it exists so that the things that are hard to get right — hot swap,
device detection, worker supervision, the conformance suite — can be exercised
and demonstrated before any of them are load-bearing for a real analysis.

## What it does

Provides the `echo` service:

```ts
const result = await ctx.echo.echo('hello', { delayMs: 3000 })
// { text: 'hello', workerVersion: '1.0.0', device: 'cpu', model: 'echo-small', pid: 12345 }
```

`workerVersion` is the point: it says which process answered, so a swap is
visible in the result of a call rather than only in the logs.

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `version` | `1` | `1` or `2`. Two otherwise identical builds of the worker; changing this is the hot-swap demo. |
| `device` | `auto` | `auto`, `cpu`, `cuda` or `mps`. |
| `profile` | `auto` | `auto`, `lite` (`echo-small`) or `full` (`echo-large`). |
| `timeLimitSec` | `0` | Per-job time limit; 0 means none. |

## Job kinds (the worker's own protocol)

| Kind | Purpose |
|------|---------|
| `echo` | Returns the text with the worker's identity. `delayMs` spreads the work over 20 progress reports, and cancellation is checked between them. |
| `crash` | Raises, to show that a failed job is a failed call and not a dead process. |
| `hog` | Allocates `mib` megabytes and sleeps, to show the supervisor's memory limit killing a runaway worker. |

## Known failure modes

- The first run in a fresh checkout pays for `uv` creating the worker's venv,
  which can exceed the 60 s warm-up budget on a slow connection. Run
  `uv sync --directory plugins/echo/worker` once before timing anything.
- A job in flight during a swap is re-dispatched to the replacement, so the
  worker's jobs must be re-runnable. `echo` is; a worker that mutates state
  would not be, and does not belong in this architecture.

## Licence

No model weights. The worker is MIT like the rest of the repository.

## Verified on

| Platform | Device | Date | Result |
|----------|--------|------|--------|
| Linux x86-64 (dev box, 3× RTX 3060) | `cpu`, `cuda` | 2026-09-18 | pass |
| Apple Silicon | `mps` | — | **not yet run** (O-9) |
