/**
 * The chord vocabulary, and how a label is spelled.
 *
 * `04-harmony-engine.md` asks whether the vocabulary should be a closed table or
 * generated from interval formulas. It is generated, in this sense: the table
 * below holds only *core* qualities — a triad, a sixth or a seventh — and the
 * tensions each one can carry. Cmaj9, Cmaj13 and Cmaj7(#11) are not entries;
 * they are `maj7` with whichever tensions the notes actually contain. That keeps
 * the table at eighteen rows instead of several hundred, and it means the
 * `extensions` and `alterations` fields of a candidate are found rather than
 * declared. Display symbols are curated, in `symbolFor` below, because the
 * spelling a musician expects is a convention and not a derivation.
 */
import type { Alt, Ext } from './types.ts'
import { noteName, type PitchClass } from './pitch.ts'

/** A chord tone, with how much its presence or absence matters. */
export interface Tone {
  /** Semitones above the root. */
  semitones: number
  /**
   * How much this tone counts, both as evidence when present and as a cost when
   * missing. The 3rd and the 7th carry the quality; the perfect 5th carries
   * almost nothing, because jazz voicings drop it first; the root is in between,
   * because rootless voicings are ordinary but a root is still good evidence.
   */
  weight: number
}

export type Family = 'major' | 'minor' | 'dominant' | 'diminished' | 'augmented' | 'suspended' | 'none'

export interface Quality {
  id: string
  /** Appended to the root name when no tension rewrites it. */
  symbol: string
  tones: Tone[]
  /** Semitones above the root → what that note is called on this quality. */
  tensions: Record<number, Ext | Alt>
  /**
   * How elaborate the label is. Parsimony prefers the simplest label that
   * explains the same notes, which is what makes C6 beat Am7/C over a C bass.
   */
  complexity: number
  family: Family
  /**
   * How the symbol changes when 9, 11 or 13 stack on top. Qualities without an
   * entry keep their symbol and list tensions in parentheses, which is how a
   * chart writes Cm7b5(9) rather than inventing "Cm9b5".
   */
  stack?: Record<Ext, string>
}

const ROOT = 0.7
const THIRD = 1.0
const SEVENTH = 1.0
/** Dropped first in any real voicing, so its absence must cost almost nothing. */
const FIFTH = 0.35
/** A 5th that defines the quality (dim, aug) or a 6th that does: not droppable. */
const COLOUR = 0.9

const t = (semitones: number, weight: number): Tone => ({ semitones, weight })

export const QUALITIES: Quality[] = [
  // --- triads -------------------------------------------------------------
  {
    id: 'maj', symbol: '', family: 'major', complexity: 0,
    tones: [t(0, ROOT), t(4, THIRD), t(7, FIFTH)],
    tensions: { 2: '9', 6: '#11' },
  },
  {
    id: 'min', symbol: 'm', family: 'minor', complexity: 0,
    tones: [t(0, ROOT), t(3, THIRD), t(7, FIFTH)],
    tensions: { 2: '9', 5: '11' },
  },
  {
    id: 'dim', symbol: 'dim', family: 'diminished', complexity: 3,
    tones: [t(0, ROOT), t(3, THIRD), t(6, COLOUR)],
    tensions: { 2: '9', 5: '11' },
  },
  {
    id: 'aug', symbol: '+', family: 'augmented', complexity: 3,
    tones: [t(0, ROOT), t(4, THIRD), t(8, COLOUR)],
    tensions: { 2: '9', 6: '#11' },
  },
  {
    id: 'sus4', symbol: 'sus4', family: 'suspended', complexity: 2,
    tones: [t(0, ROOT), t(5, THIRD), t(7, FIFTH)],
    tensions: { 2: '9' },
  },
  {
    id: 'sus2', symbol: 'sus2', family: 'suspended', complexity: 3,
    tones: [t(0, ROOT), t(2, THIRD), t(7, FIFTH)],
    tensions: {},
  },
  {
    // Guitar and rock keyboards really do play just these two notes, and every
    // other label would have to call the missing 3rd an omission.
    id: 'five', symbol: '5', family: 'none', complexity: 2,
    tones: [t(0, COLOUR), t(7, COLOUR)],
    tensions: {},
  },

  // --- sixths -------------------------------------------------------------
  {
    id: 'maj6', symbol: '6', family: 'major', complexity: 1,
    tones: [t(0, ROOT), t(4, THIRD), t(7, FIFTH), t(9, COLOUR)],
    tensions: { 2: '9', 6: '#11' },
    stack: { '9': '6/9', '11': '6/9', '13': '6/9' },
  },
  {
    id: 'min6', symbol: 'm6', family: 'minor', complexity: 2,
    tones: [t(0, ROOT), t(3, THIRD), t(7, FIFTH), t(9, COLOUR)],
    tensions: { 2: '9', 5: '11' },
    stack: { '9': 'm6/9', '11': 'm6/9', '13': 'm6/9' },
  },

  // --- sevenths -----------------------------------------------------------
  {
    id: 'maj7', symbol: 'maj7', family: 'major', complexity: 1,
    tones: [t(0, ROOT), t(4, THIRD), t(7, FIFTH), t(11, SEVENTH)],
    tensions: { 2: '9', 6: '#11', 9: '13' },
    stack: { '9': 'maj9', '11': 'maj11', '13': 'maj13' },
  },
  {
    id: 'min7', symbol: 'm7', family: 'minor', complexity: 1,
    tones: [t(0, ROOT), t(3, THIRD), t(7, FIFTH), t(10, SEVENTH)],
    tensions: { 2: '9', 5: '11', 9: '13' },
    stack: { '9': 'm9', '11': 'm11', '13': 'm13' },
  },
  {
    // The natural 11 is missing on purpose: over a major 3rd it is not a
    // tension but a suspension, which is why `dom7sus4` exists as its own row.
    id: 'dom7', symbol: '7', family: 'dominant', complexity: 1,
    tones: [t(0, ROOT), t(4, THIRD), t(7, FIFTH), t(10, SEVENTH)],
    tensions: { 1: 'b9', 2: '9', 3: '#9', 6: '#11', 8: 'b13', 9: '13' },
    stack: { '9': '9', '11': '11', '13': '13' },
  },
  {
    id: 'm7b5', symbol: 'm7b5', family: 'diminished', complexity: 2,
    tones: [t(0, ROOT), t(3, THIRD), t(6, COLOUR), t(10, SEVENTH)],
    tensions: { 1: 'b9', 2: '9', 5: '11', 8: 'b13' },
  },
  {
    id: 'dim7', symbol: 'dim7', family: 'diminished', complexity: 3,
    tones: [t(0, ROOT), t(3, THIRD), t(6, COLOUR), t(9, COLOUR)],
    tensions: { 2: '9', 5: '11', 8: 'b13' },
  },
  {
    id: 'minMaj7', symbol: 'mMaj7', family: 'minor', complexity: 4,
    tones: [t(0, ROOT), t(3, THIRD), t(7, FIFTH), t(11, SEVENTH)],
    tensions: { 2: '9', 5: '11', 9: '13' },
  },
  {
    id: 'aug7', symbol: '7#5', family: 'dominant', complexity: 4,
    tones: [t(0, ROOT), t(4, THIRD), t(8, COLOUR), t(10, SEVENTH)],
    tensions: { 1: 'b9', 2: '9', 3: '#9', 6: '#11' },
  },
  {
    id: 'augMaj7', symbol: 'maj7#5', family: 'augmented', complexity: 5,
    tones: [t(0, ROOT), t(4, THIRD), t(8, COLOUR), t(11, SEVENTH)],
    tensions: { 2: '9', 6: '#11' },
  },
  {
    id: 'dom7sus4', symbol: '7sus4', family: 'suspended', complexity: 2,
    tones: [t(0, ROOT), t(5, THIRD), t(7, FIFTH), t(10, SEVENTH)],
    tensions: { 1: 'b9', 2: '9', 9: '13' },
    stack: { '9': '9sus4', '11': '9sus4', '13': '13sus4' },
  },
]

export const QUALITY_BY_ID = new Map(QUALITIES.map((quality) => [quality.id, quality]))

/** The empty label. Wins when there is not enough sounding to name (design §open). */
export const NONE: Quality = {
  id: 'none', symbol: 'N.C.', family: 'none', complexity: 0, tones: [], tensions: {},
}

const STACK_ORDER: Ext[] = ['9', '11', '13']

/**
 * Which tensions a symbol already implies. C13 is understood to contain the 9th
 * and not the 11th; Cm13 is understood to contain the 11th. Anything a symbol
 * does not imply is printed, so "C13(#11)" says exactly what is being played.
 */
function implied(stack: Ext, family: Family): Set<Ext> {
  if (stack === '9') return new Set<Ext>(['9'])
  if (stack === '11') return new Set<Ext>(['9', '11'])
  return family === 'minor' ? new Set<Ext>(['9', '11', '13']) : new Set<Ext>(['9', '13'])
}

/**
 * Spells a candidate the way a chart would. Kept separate from scoring so that
 * a change of house style never changes which chord wins.
 */
export function symbolFor(
  root: PitchClass,
  quality: Quality,
  extensions: Ext[],
  alterations: Alt[],
  bass?: PitchClass,
): string {
  if (quality.id === 'none') return 'N.C.'
  const name = noteName(root)
  const slash = bass !== undefined && bass !== root ? `/${noteName(bass)}` : ''

  // An altered dominant with two or more alterations is one thing on a chart,
  // not a dominant with a list of adjustments. `aug7` counts: its #5 is the b13
  // spelled differently, and nobody writes C7#5(b9,#9) when C7alt exists.
  if (quality.id === 'dom7' || quality.id === 'aug7') {
    const altered = alterations.filter((a) => a === 'b9' || a === '#9' || a === '#11' || a === 'b13')
    const count = altered.length + (quality.id === 'aug7' ? 1 : 0)
    if (count >= 2 && !extensions.includes('13')) return `${name}7alt${slash}`
  }

  let body = quality.symbol
  const parenthesised: string[] = []

  const present = new Set(extensions)
  // A stack only reads as "C13" when the ninth is under it; "C7(13)" otherwise.
  const stack = present.has('9')
    ? [...STACK_ORDER].reverse().find((ext) => present.has(ext))
    : undefined

  if (stack && quality.stack) {
    body = quality.stack[stack]
    const covered = implied(stack, quality.family)
    for (const ext of extensions) if (!covered.has(ext)) parenthesised.push(ext)
  } else {
    // A tension over a chord with no seventh is an addition, not a stack: what
    // a chart calls Cm(add9), never Cm9, which would promise a flat seventh.
    const hasSeventh = quality.tones.some((tone) => tone.semitones === 10 || tone.semitones === 11)
    parenthesised.push(...extensions.map((ext) => (hasSeventh ? ext : `add${ext}`)))
  }
  parenthesised.push(...alterations)

  const tail = parenthesised.length ? `(${parenthesised.join(',')})` : ''
  return `${name}${body}${tail}${slash}`
}

const CORE_DEGREE: Record<number, string> = {
  0: 'root', 3: '3rd', 4: '3rd', 5: '4th', 6: 'b5', 7: '5th', 8: '#5', 9: '6th', 10: '7th', 11: '7th',
}

/**
 * What a note is called over a given chord: "9th on top" is a thing a teacher
 * says, and it is the same question for the melody note and for an inner voice.
 */
export function degreeName(quality: Quality, semitones: number): string {
  const interval = ((semitones % 12) + 12) % 12
  if (quality.tones.some((tone) => tone.semitones === interval)) return CORE_DEGREE[interval] ?? String(interval)
  const tension = quality.tensions[interval]
  if (tension) return tension === '9' || tension === '11' || tension === '13' ? `${tension}th` : tension
  return 'foreign'
}
