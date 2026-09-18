export interface StemState {
  stem: string
  path: string
  sampleRate: number
  channels: number
  durationSec: number
  peak: number
  rms: number
  model?: string
  device?: string
  elapsedSec?: number
  eventId: string
  producer: { plugin: string; version: string }
}

export interface SongState {
  songId: string
  title: string
  source: string
  createdAt: string
  duration: number | null
  sampleRate: number | null
  channels: number | null
  mix: string | null
  stems: StemState[]
}

export interface ServiceState {
  implementation: string | null
  version: string | null
  info: { device: string; profile: string; model: string } | null
}

export interface PipelineState {
  separator: ServiceState & { available: string[] }
  transcriber: ServiceState & { available: string[] }
  beats: ServiceState | null
  chordAudio: ServiceState | null
  harmony: boolean
  consensus: boolean
  midi: { attachedTo: string | null } | null
}

export interface ChordCandidate {
  root: number
  quality: string
  symbol: string
  score: number
  reasons: string[]
  omitted: number[]
  foreign: number[]
  voicing?: Voicing
}

export interface Voicing {
  type: string
  alternates: string[]
  label: string
  inversion: number | null
  topDegree: string | null
  bottomDegree: string | null
  spanSemitones: number
  voices: number
  register: string
  reasons: string[]
  upper?: { symbol: string; degree: string }
  symbol?: string
  notes?: number[]
}

export interface TrackChord {
  eventId: string
  startSec: number
  endSec: number
  symbol: string
  root: number
  quality: string
  candidates: ChordCandidate[]
  margin: number
  ambiguous: boolean
  confidence: number | null
  voicing: Voicing | null
  /** Consensus only. */
  agreement?: number
  contested?: boolean
  disagreement?: { producer: string; symbol: string; agreement: number }[]
  sources?: string[]
}

export interface ChordTrack {
  producer: string | null
  producers: string[]
  chords: TrackChord[]
}

export interface Reading {
  held: number[]
  symbol: string
  candidates: ChordCandidate[]
  voicing: Voicing | null
  margin: number
  ambiguous: boolean
  atMs: number
  latencyMs: number
}

export interface SeparatorState {
  implementation: string | null
  version: string | null
  info: { device: string; profile: string; model: string } | null
  available: string[]
}

export interface AppState {
  songs: SongState[]
  separator: SeparatorState
  pipeline: PipelineState
}

export interface PeakEnvelope {
  buckets: number
  durationSec: number
  peaks: number[]
  rms: number[]
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `${response.status}`)
  return body as T
}

export const api = {
  state: () => fetch('/api/state').then(unwrap<AppState>),

  upload: (file: File) =>
    fetch(`/api/songs?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }).then(unwrap<SongState>),

  separate: (songId: string, force = false) =>
    fetch(`/api/songs/${songId}/separate?force=${force}`, { method: 'POST' }).then(
      unwrap<{ stems: unknown[]; song: SongState }>,
    ),

  peaks: (songId: string, path: string, buckets = 900) =>
    fetch(`/api/songs/${songId}/peaks?path=${encodeURIComponent(path)}&buckets=${buckets}`).then(unwrap<PeakEnvelope>),

  choose: (service: 'separator' | 'transcriber', implementation: string) =>
    fetch(`/api/${service}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ implementation }),
    }).then(unwrap<{ requested: string }>),

  analyse: (songId: string, force = false) =>
    fetch(`/api/songs/${songId}/analyse?force=${force}`, { method: 'POST' }).then(
      unwrap<{ stages: string[]; chords: ChordTrack }>,
    ),

  chords: (songId: string, producer?: string) =>
    fetch(`/api/songs/${songId}/chords${producer ? `?producer=${encodeURIComponent(producer)}` : ''}`).then(
      unwrap<ChordTrack>,
    ),

  panic: () => fetch('/api/midi/panic', { method: 'POST' }).then(unwrap<{ held: number[] }>),

  audioUrl: (songId: string, path: string) => `/api/songs/${songId}/audio?path=${encodeURIComponent(path)}`,
}

export type ServerMessage =
  | { type: 'state' }
  | { type: 'progress'; songId: string; implementation: string; fraction: number; message?: string; error?: string }
  | { type: 'analysis'; songId: string; stage?: string; fraction: number; message?: string; error?: string }
  | { type: 'reading'; reading: Reading | null }
  | { type: 'worker-swapped'; slot: string; from: string | null; to: string; policy: string }

export interface Connection {
  /** Sends a MIDI note message to the `midi` service. Dropped while offline. */
  note(note: { type: 'on' | 'off'; midi: number; velocity?: number }): void
  close(): void
}

/**
 * Reconnecting websocket; the server goes away whenever `ui` is reloaded, which
 * during development is often. It carries state notifications and live readings
 * down, and MIDI note messages up — the only thing the page ever sends.
 */
export function connect(onMessage: (message: ServerMessage) => void): Connection {
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const open = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    socket.onmessage = (event) => onMessage(JSON.parse(event.data))
    socket.onclose = () => {
      if (!closed) timer = setTimeout(open, 1000)
    }
  }
  open()

  return {
    note(note) {
      // A dropped note while the socket is down is better than a queue that
      // replays a chord nobody is holding any more.
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'midi', note }))
    },
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    },
  }
}
