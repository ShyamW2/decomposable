/**
 * Core types shared by the kernel and every plugin.
 *
 * The analysis document (ADR-004) is an append-only log of events. Every event
 * says who produced it, from which other events, and how sure it is. Nothing
 * anonymous is ever stored: `analysis-store` rejects an event without
 * provenance rather than letting it in and hoping someone notices later.
 */

/**
 * Layers of the analysis document. Time is always seconds from the start of the
 * decoded audio; beats and bars are a layer, not a coordinate system, so
 * changing the beat tracker never moves a note.
 */
export const LAYERS = [
  'audio',
  'stem',
  'beat',
  'note',
  'chroma',
  'chord',
  'voicing',
  'progression',
  'key',
  'notation',
  'midi-live',
  'annotation',
] as const

export type Layer = (typeof LAYERS)[number]

export interface Producer {
  /** Plugin name, exactly as in its manifest. */
  plugin: string
  /** Plugin version, exactly as in its manifest. */
  version: string
}

/** An event as stored: provenance plus payload. */
export interface AnalysisEvent<T = unknown> {
  id: string
  songId: string
  /** ISO 8601, when the event was appended. */
  at: string
  producer: Producer
  /** Ids of the events this one was derived from. Empty for roots (e.g. ingest). */
  inputs: string[]
  /** 0..1, only when the producer has a meaningful notion of confidence. */
  confidence?: number
  layer: Layer
  /** Seconds from the start of the decoded audio; null for events without a position. */
  tStart?: number | null
  tEnd?: number | null
  payload: T
}

/** What a plugin hands to `analysis-store.append`. The store assigns id and at. */
export interface AnalysisEventInput<T = unknown> {
  songId: string
  producer: Producer
  inputs?: string[]
  confidence?: number
  layer: Layer
  tStart?: number | null
  tEnd?: number | null
  payload: T
}

export interface EventQuery {
  songId: string
  layer?: Layer | Layer[]
  /** Overlap window in seconds. */
  from?: number
  to?: number
  producer?: string
  version?: string
  /** Omit events superseded by a re-run of their producer. Defaults to true. */
  currentOnly?: boolean
  limit?: number
}

export interface SongRecord {
  songId: string
  title: string
  /** Absolute path of the file the song was ingested from. */
  source: string
  createdAt: string
  /** Seconds. Null until `ingest` has decoded the audio. */
  duration: number | null
  sampleRate: number | null
  channels: number | null
}

/** Devices a Python worker can run on. `auto` is resolved by the supervisor. */
export const DEVICES = ['cpu', 'cuda', 'mps'] as const
export type Device = (typeof DEVICES)[number]
export type DeviceRequest = Device | 'auto'

/** Model size profiles (ADR-002). `lite` is the 4-core/8 GB baseline. */
export type Profile = 'lite' | 'full'
export type ProfileRequest = Profile | 'auto'

/**
 * Policy for replacing a running worker process with a new one.
 * - `blue-green`: start the new process while the old one is still alive, then kill the old.
 * - `stop-start`: kill the old process first, then start the new one. Uses less memory.
 * - `auto`: blue-green when free memory covers the new worker's estimated peak, else stop-start.
 */
export type SwapPolicy = 'auto' | 'blue-green' | 'stop-start'

/** `manifest.json` next to every plugin's `index.ts`. */
export interface PluginManifest {
  name: string
  version: string
  kind: 'ts' | 'py-worker'
  description?: string
  inject?: string[]
  provides?: string[]
  /** py-worker only. */
  worker?: WorkerManifest
}

export interface WorkerManifest {
  /** Directory of the worker's venv and main.py, relative to the repository root. */
  dir: string
  /** Devices the underlying library actually supports. */
  devices: Device[]
  /** Seconds allowed between spawn and the worker's `hello` reply. */
  warmupBudget: number
  models: Record<Profile, WorkerModel>
}

export interface WorkerModel {
  id: string
  /** Estimated peak resident memory in MiB, used to choose a swap policy. */
  peakMemoryMiB: number
}
