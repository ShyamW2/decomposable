import type { ChordCandidate, NoteSource, Voicing } from '#harmony'

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

export interface NoteRef extends NotePayload {
  /** The `note` layer event this note was recorded as. */
  eventId: string
}

export interface TranscribeOptions {
  onProgress?: (fraction: number, message?: string) => void
  signal?: AbortSignal
  /** Re-transcribe even if this implementation already has notes for the song. */
  force?: boolean
  /** Only these stems. Defaults to every separated stem the transcriber will take. */
  stems?: string[]
}

/**
 * Audio to notes. Two implementations in Phase 3 — Basic Pitch on the CPU
 * baseline and MuScriptor for the full profile — so, like `Separator`, the
 * contract lives here and the UI can swap between them.
 */
export interface Transcriber {
  readonly implementation: string
  readonly version: string
  info(): { device: string; profile: string; model: string }
  transcribe(songId: string, options?: TranscribeOptions): Promise<NoteRef[]>
}

// --- analysis payloads ------------------------------------------------------
//
// The shape of what one plugin appends and another reads. These live here for
// the same reason `Separator` does: more than one plugin depends on each of
// them, so the shape is a contract rather than an implementation detail. A
// payload with exactly one producer and one consumer stays in its own plugin.

/** `note` layer. Produced by any transcriber, read by `harmony`. */
export interface NotePayload {
  midi: number
  startSec: number
  endSec: number
  /** 0..1. */
  velocity?: number
  /** The stem it was transcribed from, or `mix`. */
  stem: string
  /** How much the harmony engine should trust it. */
  source: NoteSource
}

/** `beat` layer. One event per beat, so a wrong downbeat can be fixed alone. */
export interface BeatPayload {
  timeSec: number
  /** 1 is a downbeat; 0 when the meter is unknown. */
  beatInBar: number
  /** Local tempo, null when the tracker does not estimate one. */
  bpm: number | null
}

/** `chroma` layer. The twelve bins one window was ranked from. */
export interface ChromaPayload {
  bins: number[]
  /** MIDI notes the bins were built from, ascending. */
  notes: number[]
  bassMidi: number | null
}

/** `chord` layer. Ranked, never a single answer (non-negotiable 5). */
export interface ChordPayload {
  symbol: string
  root: number
  quality: string
  candidates: ChordCandidate[]
  /** Score gap between the winner and the runner-up. */
  margin: number
  ambiguous: boolean
}

/** `voicing` layer. How the winner was actually arranged. */
export interface VoicingPayload extends Voicing {
  symbol: string
  notes: number[]
}

/** `midi-live` layer. What the player did, in wall-clock and song time. */
export interface MidiLivePayload {
  type: 'on' | 'off'
  midi: number
  velocity: number
  /** Milliseconds since the epoch. */
  atMs: number
}

const STEM_SOURCES: Record<string, NoteSource> = {
  bass: 'bass', vocals: 'vocals', piano: 'piano', guitar: 'guitar', other: 'other',
}

/**
 * Which harmony-engine source a stem counts as. Separators disagree about what
 * a stem is — Demucs gives four, BS-RoFormer gives two — so anything not
 * recognised is `other`, which is heard but not especially trusted.
 */
export function sourceForStem(stem: string): NoteSource {
  return STEM_SOURCES[stem] ?? 'other'
}

/**
 * Which source an instrument name counts as. A transcriber that recognises
 * instruments (MuScriptor does) knows more about a note than which stem it came
 * from, and a bass line found inside the `other` stem should still be weighted
 * as a bass line.
 */
export function sourceForInstrument(instrument: string | undefined | null): NoteSource | null {
  if (!instrument) return null
  const name = instrument.toLowerCase()
  if (name.includes('bass')) return 'bass'
  if (name.includes('guitar')) return 'guitar'
  if (/piano|organ|harpsichord|rhodes|clavi|celesta|electric piano/.test(name)) return 'piano'
  if (/voice|vocal|choir|aahs|oohs/.test(name)) return 'vocals'
  return 'other'
}
