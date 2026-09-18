# midi

Turns a stream of MIDI note messages into a live reading: what chord is being
played, how it is voiced, and what else it could be. Provides the `midi` service.

This plugin owns no transport. The browser reaches the keyboard through Web MIDI,
the `ui` plugin's websocket carries the messages, and they arrive here as calls
to `midi.note(...)`. That is deliberate: ADR-005 wants a browser-only mode to
stay possible, so nothing on the MIDI path may assume a server exists.

## Inputs and outputs

```ts
midi.note({ type: 'on', midi: 60, velocity: 84 })   // -> the held set
midi.current()                                       // -> the last reading, or null
midi.attach(songId)                                  // -> also write it down
```

Every reading is emitted as the Cordis event `midi/reading`. A reading carries
the ranked candidates, so the UI can show the runner-up when `ambiguous` is set.

When attached to a song, the plugin appends `midi-live` events for the key
presses and one `voicing` event per reading, with the voicing pointing back at
the exact key presses it was read from.

## Config

| Key | Default | What it does |
|-----|---------|--------------|
| `settleMs` | 30 | how long the held set must stop changing before it is read |
| `minVelocity` | 1 | ignore anything softer |

`settleMs` is the whole of the latency budget in practice. A hand does not land
on five keys in the same millisecond, so without it every voicing would be
announced three times on the way to itself. The engine's own work is under a
millisecond, which leaves the 50 ms budget (non-negotiable 4) comfortable.

## Known failure modes

- **Arpeggios read as chords.** Holding the sustain pedal, or playing a line
  legato, accumulates a held set that was never a voicing. Sustain-pedal
  messages are not handled at all yet, which is the honest version of the same
  gap: the pedal is simply not heard.
- **Slow rolls beat the settle window.** A chord rolled over more than
  `settleMs` is read twice, once partially. Raising `settleMs` trades the exit
  criterion's 50 ms for it.
- **A left-hand rootless voicing has no bass.** The lowest key becomes the bass
  note, which is what makes E–G–B–D read as Em7 rather than Cmaj9. That is the
  engine being honest rather than wrong; play the root or accept the runner-up.
- **No note-off from a device that only sends note-on.** `panic()` exists for
  exactly that keyboard.
