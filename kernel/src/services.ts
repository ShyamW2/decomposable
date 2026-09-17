/**
 * Contracts that more than one plugin implements.
 *
 * A contract only lives here once a second implementation exists or is planned
 * in the current phase (ADR-007). `Separator` qualifies: htdemucs and
 * BS-RoFormer are both Phase 1, and the UI switches between them.
 */

export interface StemRef {
  /** `drums`, `bass`, `other`, `vocals`, ... */
  stem: string
  /** Path relative to the song workspace. */
  path: string
  sampleRate: number
  channels: number
  durationSec: number
  peak: number
  rms: number
  /** The `stem` layer event this file was recorded as. */
  eventId: string
}

export interface SeparateOptions {
  onProgress?: (fraction: number, message?: string) => void
  signal?: AbortSignal
  /** Re-separate even if this implementation already has stems for the song. */
  force?: boolean
}

export interface Separator {
  /** The plugin name, so the UI can say which one produced a set of stems. */
  readonly implementation: string
  readonly version: string
  /** Which device and model the worker actually resolved to. */
  info(): { device: string; profile: string; model: string }
  separate(songId: string, options?: SeparateOptions): Promise<StemRef[]>
}
