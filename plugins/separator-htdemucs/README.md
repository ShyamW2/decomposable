# separator-htdemucs

Stem separation with [Hybrid Transformer Demucs](https://github.com/facebookresearch/demucs).
Splits the decoded mix into `drums`, `bass`, `other` and `vocals` at 44.1 kHz,
writes them into the song's workspace, and records each one as a `stem` event
whose input is the `audio` event it came from.

Implements the `separator` contract in [`kernel/src/services.ts`](../../kernel/src/services.ts).
`separator-bsroformer` implements the same contract; only one is mounted at a
time, and swapping them is an edit to `decomposable.config.yaml`.

## Service

```ts
const stems = await ctx.separator.separate(songId, { onProgress: (f) => ... })
// [{ stem: 'drums', path: 'stems/separator-htdemucs/drums.wav', eventId, ... }, ...]
```

Calling `separate` twice returns the first result; pass `{ force: true }` to
re-run, which supersedes the previous stems and everything derived from them
rather than leaving two sets both claiming to be current.

## Models

| Profile | Model | Peak memory | Notes |
|---------|-------|-------------|-------|
| `lite` | `htdemucs` | ~2.6 GB | The baseline. One pass. |
| `full` | `htdemucs_ft` | ~4.2 GB | Four fine-tuned models bagged; roughly 4× the time for about 0.3 dB SDR. |

`auto` picks `full` on a GPU with room and `lite` otherwise, so the 4-core/8 GB
laptop gets `htdemucs` on the CPU without being told (ADR-002).

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `device` | `auto` | `auto`, `cpu`, `cuda`, `mps`. |
| `profile` | `auto` | `auto`, `lite`, `full`. |
| `shifts` | `0` | Random time shifts averaged for a slightly better result; each one costs another full pass. |
| `overlap` | `0.25` | Overlap between the 8-second windows the song is split into. |
| `timeLimitSec` | `0` | Per-job time limit. A whole song on a 4-core CPU can take up to 3× its own length (O-7), so leave this generous or unset. |

## Known failure modes

- **First run downloads weights** (~80 MB for `htdemucs`, ~320 MB for
  `htdemucs_ft`) into the torch hub cache. The manifest's 300 s warm-up budget
  covers a normal connection; a slow one fails the first start and succeeds on
  the retry, since the download resumes from cache.
- **CPU separation is slow.** Roughly 0.7× real time on 12 cores here; expect
  around 3× the song's length on the 4-core baseline.
- **MPS falls back to CPU** for any op Metal does not implement. The worker
  checks `torch.backends.mps.is_available()` and drops to CPU rather than
  failing, and says so in its log.
- Input with more than two channels is truncated to stereo; mono is duplicated.

## Licence

Demucs is MIT (Meta). The pretrained weights are released under the same licence
and are downloaded on first use, never committed.

## Verified on

| Platform | Device | Model | Date | Result |
|----------|--------|-------|------|--------|
| Linux x86-64 (12 cores, 3× RTX 3060) | `cpu` | `htdemucs` | 2026-09-18 | pass, contract + golden |
| Linux x86-64 | `cuda` | `htdemucs_ft` | 2026-09-18 | pass, manual run |
| Apple Silicon | `mps` | — | — | **not yet run** (O-9) |
