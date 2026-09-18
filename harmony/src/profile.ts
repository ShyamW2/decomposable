/**
 * Stage 1 — the pitch-class profile.
 *
 * Two jobs. `buildWindow` turns a list of notes with real start and end times
 * into one analysis window, applying the weighting the design calls for:
 * confidence, share of the window, a penalty for notes too short to be part of
 * the harmony, and a preference for the instruments that state it. `profileOf`
 * then collapses a window to twelve bins, keeping the MIDI numbers, because
 * stage 3 needs to know which octave everything was in.
 */
import { pitchClass, type PitchClass } from './pitch.ts'
import type { NoteSource, PitchWindow, WindowNote } from './types.ts'

/**
 * How much each instrument is trusted to be stating the harmony. The bass line
 * says what the chord is rooted on; a vocal is mostly melody, and melody is
 * where non-chord tones live, so it is heard but not believed.
 */
export const SOURCE_WEIGHT: Record<NoteSource, number> = {
  bass: 1.25,
  piano: 1,
  guitar: 1,
  midi: 1,
  other: 0.8,
  vocals: 0.55,
}

/**
 * A note sounding for less than this share of the window is treated as passing
 * and attenuated in proportion. Set so that an eighth-note run under a half-bar
 * window cannot outvote the chord being held under it.
 */
const SHORT_NOTE_SHARE = 0.25

export interface TimedNote {
  midi: number
  start: number
  end: number
  /** 0..1. Defaults to 1, which is what a MIDI keyboard gives. */
  confidence?: number
  source: NoteSource
}

export interface BuildWindowOptions {
  start: number
  end: number
  keyHint?: PitchWindow['keyHint']
  prev?: PitchWindow['prev']
  /**
   * Lowest note from a bass source inside the window. Computed here when any
   * note is marked `bass`; pass it explicitly to override.
   */
  bassMidi?: number
}

/** Builds one analysis window from notes that may start or end outside it. */
export function buildWindow(notes: TimedNote[], options: BuildWindowOptions): PitchWindow {
  const length = Math.max(options.end - options.start, 1e-6)
  const windowNotes: WindowNote[] = []
  let lowestBass: number | undefined

  for (const note of notes) {
    const overlap = Math.min(note.end, options.end) - Math.max(note.start, options.start)
    if (overlap <= 0) continue
    const share = overlap / length
    const decay = Math.min(1, share / SHORT_NOTE_SHARE)
    const weight = (note.confidence ?? 1) * share * decay * SOURCE_WEIGHT[note.source]
    if (weight <= 0) continue
    windowNotes.push({ midi: note.midi, weight, source: note.source })
    if (note.source === 'bass' && (lowestBass === undefined || note.midi < lowestBass)) lowestBass = note.midi
  }

  const bassMidi = options.bassMidi ?? lowestBass
  return {
    start: options.start,
    end: options.end,
    notes: windowNotes,
    ...(bassMidi === undefined ? {} : { bassMidi }),
    ...(options.keyHint ? { keyHint: options.keyHint } : {}),
    ...(options.prev ? { prev: options.prev } : {}),
  }
}

/** A window built from notes held right now, which is the live MIDI case. */
export function windowFromMidi(midiNotes: number[], extras: Partial<PitchWindow> = {}): PitchWindow {
  return {
    start: 0,
    end: 0,
    notes: midiNotes.map((midi) => ({ midi, weight: 1, source: 'midi' as const })),
    ...(midiNotes.length ? { bassMidi: Math.min(...midiNotes) } : {}),
    ...extras,
  }
}

export interface Profile {
  /** Twelve bins summing to 1, or all zero for an empty window. */
  bins: number[]
  /** Pitch classes with any weight at all, ascending. */
  present: PitchClass[]
  /** MIDI numbers in the window, ascending, de-duplicated. */
  notes: number[]
  /** Weight before normalisation: how much was sounding. */
  mass: number
}

export function profileOf(window: PitchWindow): Profile {
  const bins = new Array<number>(12).fill(0)
  let mass = 0
  for (const note of window.notes) {
    // Octave doubling is evidence, not noise: a root played in two octaves is
    // being asserted twice, so the weights add.
    bins[pitchClass(note.midi)]! += note.weight
    mass += note.weight
  }
  if (mass > 0) for (let i = 0; i < 12; i++) bins[i]! /= mass

  return {
    bins,
    present: bins.flatMap((weight, pc) => (weight > 0 ? [pc as PitchClass] : [])),
    notes: [...new Set(window.notes.map((note) => note.midi))].sort((a, b) => a - b),
    mass,
  }
}
