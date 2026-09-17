# ui

The browser app and the small server behind it: drop in a song, watch it decode,
separate it, and listen to the stems against the mix with mute and solo. It is
also where the separator is swapped without restarting anything.

Svelte 5 (ADR-005), built by Vite into `ui/dist`, served by this plugin. Binds to
`127.0.0.1` and has no authentication: it is the only network-facing plugin and
the single place authentication would go if there is ever a second user
(ADR-008).

## Running it

```sh
pnpm build:ui          # once, then http://127.0.0.1:5883
pnpm dev:ui            # hot-reloading Svelte on :5173, API proxied to the kernel
```

If `ui/dist` is missing the server still runs and the page tells you to build it.

## The one design decision worth knowing

`ui` injects `analysis-store` and `ingest`, but **not** `separator`. If it did,
unloading `separator-htdemucs` would take the web server down with it — and the
moment a musician most wants a working page is the moment they asked to swap the
separator. Instead the separator is held in a child fiber (`ctx.inject`), which
Cordis suspends on its own while no separator is mounted. The page stays up, the
chip in the header says "no separator mounted", and `POST /separate` answers 503
until the replacement arrives, at which point the fiber resumes and the page
updates over the websocket.

`injectOptional` in the manifest records that relationship for readers; the
kernel does not act on it, because Cordis v4 has no optional injection.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/state` | Songs, their stems, and which separator is mounted. |
| `POST /api/songs?name=…` | The file is the request body. No multipart parser, because there is no second kind of upload. |
| `GET /api/songs/:id` | One song. |
| `GET /api/songs/:id/audio?path=…` | Streams a wav from the workspace, with byte ranges so the browser can seek. |
| `GET /api/songs/:id/peaks?path=…&buckets=…` | A peak/rms envelope for drawing: a few thousand numbers instead of a few hundred megabytes. |
| `POST /api/songs/:id/separate?force=…` | Runs the mounted separator; progress goes out over the websocket. |
| `POST /api/separator` | Rewrites `decomposable.config.yaml`. The loader is already watching it, so the UI has no special path into the plugin tree. |
| `WS /ws` | `state`, `progress` and `worker-swapped` messages. |

Paths from the browser are resolved inside the song's workspace and refused if
they escape it.

## Playback

One `<audio>` element per track through Web Audio gain nodes, all started and
seeked together. Decoding stems into `AudioBuffer`s would sync to the sample, but
a four-minute song is roughly 340 MB of float32 across four stems, which the
8 GB baseline cannot spare. Streaming elements stay in a few megabytes and drift
by a few milliseconds. Solo beats mute, as on any mixer.

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `port` | `5883` | |
| `host` | `127.0.0.1` | Loopback. Changing this exposes an unauthenticated app to the network. |
| `root` | cwd | Repository root: where `ui/dist` and `decomposable.config.yaml` are found. |
| `configPath` | `<root>/decomposable.config.yaml` | The file the separator selector rewrites. |

## Known failure modes

- The port is not released until the plugin's effect finishes tearing down. The
  contract test mounts and unmounts three times to prove it is.
- Long stems are streamed, so seeking far ahead in a song that is still
  buffering can stall for a moment; playback resyncs on the next play.
- Uploads are streamed to `<workspaces>/.uploads` and kept, because the `audio`
  event's provenance names the source file.

## Licence

MIT. Svelte is MIT.
