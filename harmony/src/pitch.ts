/**
 * Pitch primitives: the small amount of arithmetic everything else in the
 * harmony engine is written in terms of.
 *
 * ADR-003 allows tonal.js for primitives but reserves chord naming for us. This
 * file is the whole of the primitive layer and is about a hundred lines, so the
 * dependency is not worth taking: a wrong answer here would be indistinguishable
 * from a wrong answer in the naming, and we want to be able to test it directly.
 */

/** 0 = C, 1 = C#/Db, ... 11 = B. */
export type PitchClass = number

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

/**
 * Roots that read better flat than sharp on a lead sheet. This is spelling, not
 * theory: a properly spelled root needs a key, which is the Phase 4 key layer.
 * Until then we pick the name a musician is least surprised to see.
 */
const PREFER_FLAT = new Set<PitchClass>([1, 3, 6, 8, 10])

export function pitchClass(midi: number): PitchClass {
  return ((midi % 12) + 12) % 12
}

export function noteName(pc: PitchClass, flat = PREFER_FLAT.has(pitchClass(pc))): string {
  return (flat ? FLAT_NAMES : SHARP_NAMES)[pitchClass(pc)]!
}

/** "C4" is middle C = 60, matching the MIDI convention the Web MIDI API uses. */
export function midiName(midi: number): string {
  return `${noteName(pitchClass(midi))}${Math.floor(midi / 12) - 1}`
}

const LETTER_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * Parses "C", "Bb", "F#4", "Eb3". Without an octave the result is a pitch class
 * in octave 4, which is what makes fixtures readable: a case can be written as
 * "C E G Bb" and still be a real set of MIDI notes.
 */
export function parseNote(text: string): number {
  const match = /^([A-Ga-g])([#b♯♭]*)(-?\d+)?$/.exec(text.trim())
  if (!match) throw new Error(`not a note name: ${text}`)
  const letter = LETTER_SEMITONES[match[1]!.toUpperCase()]!
  let accidental = 0
  for (const character of match[2]!) accidental += character === '#' || character === '♯' ? 1 : -1
  const octave = match[3] === undefined ? 4 : Number(match[3])
  return (octave + 1) * 12 + letter + accidental
}

/** Parses a space-separated chord like "C4 E4 G4 Bb4" or "C E G Bb". */
export function parseNotes(text: string): number[] {
  return text.split(/[\s,]+/).filter(Boolean).map(parseNote)
}

/** Semitones from `root` up to `pc`, always 0..11. */
export function intervalFrom(root: PitchClass, pc: PitchClass): number {
  return ((pc - root) % 12 + 12) % 12
}

/** Distinct pitch classes of a set of MIDI notes, ascending. */
export function pitchClassesOf(notes: number[]): PitchClass[] {
  return [...new Set(notes.map(pitchClass))].sort((a, b) => a - b)
}
