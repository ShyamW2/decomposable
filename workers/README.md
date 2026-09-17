# workers

`shim/` is the Python side of the worker protocol, shared by every worker as a
local editable dependency. Each worker keeps its own venv (`uv`) because Demucs,
BS-RoFormer, MuScriptor and madmom do not agree about their dependencies, and a
process boundary is the blast radius (ADR-002).

## Writing a worker

```python
from decomposable_worker import Job, Progress, Worker, log, serve

class MyWorker(Worker):
    name = "my-worker"
    version = "1.0.0"

    def load(self, device: str, model: str, profile: str, config) -> None:
        self.model = load_something(model, device)   # inside the warm-up budget

    def run(self, job: Job, progress: Progress):
        progress.raise_if_cancelled()
        progress(0.5, "halfway")
        return {"result": ...}

serve(MyWorker())
```

`pyproject.toml` next to it declares the dependencies and points at the shim:

```toml
[tool.uv.sources]
decomposable-worker = { path = "../../../workers/shim", editable = true }
```

## The protocol

Newline-delimited JSON on stdout, logs on stderr:

```
-> {"id": 1, "method": "hello",  "params": {"device": "cpu", "model": "...", "profile": "lite"}}
<- {"id": 1, "result": {"name": "...", "version": "...", ...}}
-> {"id": 2, "method": "run",    "params": {"kind": "...", ...}}
<- {"method": "progress", "params": {"id": 2, "progress": 0.5}}
<- {"id": 2, "result": {...}}
-> {"method": "cancel",   "params": {"id": 2}}
-> {"method": "shutdown", "params": {}}
```

Jobs run on a single background thread, so `cancel` and `shutdown` are still
heard while a model is busy. `sys.stdout` is rebound to stderr before any worker
code runs: a stray `print` cannot corrupt the protocol, which is the first
mistake everyone makes.

## Rules

1. **Every device path must degrade.** `cpu` is the baseline and always works.
   Ask for `cuda` or `mps`, check whether the library really has it, and fall
   back with a line in the log rather than failing.
2. **Jobs must be re-runnable.** A worker can be replaced mid-call and the job
   re-dispatched to its replacement.
3. **A bad job fails the call, not the process.** The shim catches everything
   and answers with an error; the process stays warm.
4. **Say what a model weighs.** The manifest's `peakMemoryMiB` is how the
   supervisor decides between blue-green and stop-start, and what it kills a
   runaway worker at.
5. **Record the licence of the weights** in the plugin's README. Some are not
   commercial-use.
