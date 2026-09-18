# beat-tracker

Finds the beats, and the downbeats when the model knows them. Provides the
`beats` service and the `beat` layer.

| Profile | Model | Downbeats? | Weights |
|---------|-------|------------|---------|
| `lite` | librosa onset-strength beat tracker | no | none, ever |
| `full` | [Beat This!](https://github.com/CPJKU/beat_this) | yes | downloaded on first use, MIT |

`lite` is the 8 GB laptop baseline (O-7): it needs no GPU, no model download and
no network, and it is fast. It has no opinion about where the bar starts, so it
reports `beatInBar: 0`, which downstream must read as *unknown* rather than as
*not a downbeat*. The harmony engine only needs boundaries and does not care;
a lead sheet needs bar lines and should say when it does not have them.

## Output

One `beat` layer event per beat, not one event for the whole grid. A beat is the
unit that can be individually wrong, so a corrected downbeat supersedes one row
rather than the entire track, and the store's ordinary time queries work on
beats the way they work on everything else.

```ts
{ timeSec: 1.5, beatInBar: 1, bpm: 120 }
```

`bpm` is the median inter-beat interval over the whole song, which is steadier
than the mean when the playing is not.

## Devices

`cpu` always. `cuda` and `mps` apply to `full` only; `lite` is librosa and runs
on the CPU whatever it is asked for.

**Mac status:** not yet verified on Apple Silicon (O-9). `full` takes the `mps`
branch through `torch.backends.mps.is_available()` and falls back to CPU, but
nobody has run it on a Mac.

## Known failure modes

- **Rubato and free time.** Both models assume a pulse. Solo piano with heavy
  rubato produces a grid that drifts, and every chord window drifts with it.
- **`lite` has no bar lines.** If the bar matters, use `full`.
- **Re-running moves everything.** Forcing a new beat track supersedes the old
  grid and everything derived from it, because a chord cut against beats that
  have moved is no longer about the same piece of audio.
