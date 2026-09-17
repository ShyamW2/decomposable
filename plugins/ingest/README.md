# ingest

The front door. Takes an audio file, decodes it to one canonical mix inside the
song's own workspace, and writes the first event of the analysis document.

Everything downstream reads `mix.wav`, never the file the user dropped in, so no
other plugin has to know about MP3, or about ffmpeg.

## Service

```ts
const { song, path, audio, event } = await ctx.ingest.ingest('/music/solar.mp3')
// workspaces/<songId>/mix.wav, 44100 Hz, stereo, 16-bit PCM
ctx.ingest.pathFor(song.songId, path)   // absolute path
```

`ingest` appends one `audio` event with no inputs: it is the root of the
provenance chain for that song. Its payload carries the duration, sample rate,
channel count, and the sha256 of the source file, so the same song ingested
twice is recognisable as the same audio.

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `sampleRate` | `44100` | What every separator and transcriber expects. |
| `channels` | `2` | Stereo. Demucs needs two channels and will duplicate a mono one. |
| `ffmpeg` / `ffprobe` | from `PATH` | Override if they live somewhere unusual. |

## Known failure modes

- ffmpeg must be on the `PATH`. There is no bundled binary and no fallback
  decoder; a missing ffmpeg is a loud error at the first ingest, not at mount.
- The canonical mix is 16-bit PCM. That is inaudibly lossy against a lossless
  source and half the disk of float32, which matters on the laptop baseline. If
  a later stage needs more headroom, change it here and re-ingest — everything
  derived from the audio event will be superseded with it.
- A file with no audio stream fails with ffmpeg's own message.

## Licence

MIT. No models, no weights.
