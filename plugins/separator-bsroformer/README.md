# separator-bsroformer

Stem separation with Band-Split and Mel-Band RoFormer, through
[`audio-separator`](https://github.com/nomadkaraoke/python-audio-separator),
which carries the UVR model list and fetches the checkpoints.

It exists as the **second implementation** of the `separator` contract in
[`kernel/src/services.ts`](../../kernel/src/services.ts). Swapping it for
`separator-htdemucs` while the app is running — from the menu in the page header
or by editing `decomposable.config.yaml` — is the Phase 1 exit criterion.

## It does not produce the same stems as Demucs

These models split a song into **vocals and instrumental**, not into drums, bass,
other and vocals. That is the honest reason the contract returns a list of
*named* stems and never promises which ones: two implementations of the same
contract genuinely disagree about what a stem is. Anything downstream must read
the names.

## Models

| Profile | Model | Checkpoint | Peak memory | Notes |
|---------|-------|------------|-------------|-------|
| `lite` | `mel-roformer-1143` | `model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt` | ~3.2 GB | Vocals SDR 10.5, instrumental 15.1. |
| `full` | `bs-roformer-1297` | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | ~5.2 GB | Vocals SDR 11.8, instrumental 16.5. The best of the two, and the slower. |

Checkpoints are about 1 GB each and are downloaded to `worker/models/` on first
use. Never committed.

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `device` | `auto` | `auto`, `cpu`, `cuda`, `mps`. |
| `profile` | `auto` | `auto`, `lite`, `full`. |
| `timeLimitSec` | `0` | Per-job time limit. Leave unset on a CPU. |

## Known failure modes

- **Very slow on a CPU.** On a 12-core desktop: about 80 s to read the checkpoint
  (8 s when it is still in the page cache) and 120 s to separate nine seconds of
  audio — roughly 13× real time, against Demucs's 0.7× on the same machine. On
  the 4-core baseline this is a "start it and go and make tea" operation, which
  is why Demucs is the default in `decomposable.config.yaml`.
- **No progress fraction.** `audio-separator` exposes no progress callback, so
  this worker reports stages (`separating`, `writing stems`) and the progress bar
  in the UI sits at 5% for the duration. Demucs reports a real fraction. Fixing
  this means reaching into `audio-separator`'s internals and is not worth it yet.
- **It writes where it was constructed to write, and truncates the names it
  returns** at the first dot of the model name. The worker separates into a
  staging directory it owns and takes what is actually on disk rather than
  trusting the returned paths.
- `audio-separator` imports `onnxruntime` at module load even for these PyTorch
  models, so the CPU build of onnxruntime is a hard dependency on every platform.
  RoFormer's own acceleration comes from torch, not from ONNX.

## Tests

The contract test is opt-in because of the runtime above:

```sh
pnpm test:slow      # or DECOMPOSABLE_SLOW_TESTS=1 pnpm vitest run plugins/separator-bsroformer
```

## Licence

`audio-separator` is MIT. **The checkpoints are not ours and not uniformly
licensed**: the ViperX BS-RoFormer and Mel-Band RoFormer weights come from the
UVR community model list, and several UVR models are non-commercial. A release
that ships weights, or a hosted version, needs this checked model by model
(ADR-008). Nothing here is committed, so today this is a note rather than a
problem.

## Verified on

| Platform | Device | Model | Date | Result |
|----------|--------|-------|------|--------|
| Linux x86-64 (12 cores) | `cpu` | `mel-roformer-1143` | 2026-09-18 | pass, contract + golden (274 s for the file) |
| Linux x86-64 | `cuda` | — | — | **not yet run**: the CPU path is the one the contract requires. |
| Apple Silicon | `mps` | — | — | **not yet run** (O-9) |
