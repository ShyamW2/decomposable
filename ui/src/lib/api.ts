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

export interface SeparatorState {
  implementation: string | null
  version: string | null
  info: { device: string; profile: string; model: string } | null
  available: string[]
}

export interface AppState {
  songs: SongState[]
  separator: SeparatorState
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

  chooseSeparator: (implementation: string) =>
    fetch('/api/separator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ implementation }),
    }).then(unwrap<{ requested: string }>),

  audioUrl: (songId: string, path: string) => `/api/songs/${songId}/audio?path=${encodeURIComponent(path)}`,
}

export type ServerMessage =
  | { type: 'state' }
  | { type: 'progress'; songId: string; implementation: string; fraction: number; message?: string; error?: string }
  | { type: 'worker-swapped'; slot: string; from: string | null; to: string; policy: string }

/** Reconnecting websocket; the server goes away whenever `ui` is reloaded. */
export function connect(onMessage: (message: ServerMessage) => void): () => void {
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

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    socket?.close()
  }
}
