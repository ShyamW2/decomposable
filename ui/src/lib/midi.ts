/**
 * Web MIDI, which is all the keyboard handling there is on this side.
 *
 * The browser owns the device and nothing else; parsing a status byte into a
 * note message is the whole job, and the meaning of those messages is decided
 * by the `midi` plugin on the server. Keeping the split there is what leaves
 * ADR-005's browser-only mode open: the same events could be handed to the
 * harmony engine in this tab instead, because the engine is pure TypeScript.
 */
export interface MidiNote {
  type: 'on' | 'off'
  midi: number
  velocity: number
}

export interface MidiDevices {
  /** Names of the inputs currently attached. */
  inputs: string[]
  error: string | null
}

const NOTE_OFF = 0x80
const NOTE_ON = 0x90

/**
 * Listens to every MIDI input, including ones plugged in later. Returns a
 * teardown function; call it and nothing is left subscribed.
 */
export function listenToMidi(
  onNote: (note: MidiNote) => void,
  onDevices: (devices: MidiDevices) => void,
): () => void {
  let access: MIDIAccess | null = null
  let disposed = false

  const handle = (event: MIDIMessageEvent) => {
    const data = event.data
    if (!data || data.length < 3) return
    const status = data[0]! & 0xf0
    const midi = data[1]!
    const velocity = data[2]!
    // A note-on with zero velocity is a note-off. Every keyboard does this, and
    // not handling it is how a tool ends up with stuck notes.
    if (status === NOTE_ON && velocity > 0) onNote({ type: 'on', midi, velocity })
    else if (status === NOTE_OFF || status === NOTE_ON) onNote({ type: 'off', midi, velocity: 0 })
  }

  const subscribe = () => {
    if (!access) return
    const names: string[] = []
    for (const input of access.inputs.values()) {
      input.onmidimessage = handle
      names.push(input.name ?? 'unnamed input')
    }
    onDevices({ inputs: names, error: null })
  }

  if (!navigator.requestMIDIAccess) {
    onDevices({ inputs: [], error: 'this browser has no Web MIDI; Chrome and Edge do, Safari and Firefox do not' })
    return () => {}
  }

  navigator
    .requestMIDIAccess()
    .then((granted) => {
      if (disposed) return
      access = granted
      access.onstatechange = subscribe
      subscribe()
    })
    .catch((error: Error) => onDevices({ inputs: [], error: error.message }))

  return () => {
    disposed = true
    if (!access) return
    access.onstatechange = null
    for (const input of access.inputs.values()) input.onmidimessage = null
  }
}
