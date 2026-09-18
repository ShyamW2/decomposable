/**
 * Stage 3 — voicing classification.
 *
 * The chord label says which notes; the voicing says how they were arranged,
 * which is the thing a musician actually wants back. Every rule here is
 * structural — intervals from the bass, ordering, spacing — and returns a
 * reason, because "drop 2" without "the second voice from the top is an octave
 * down" teaches nobody anything.
 *
 * Several rules can fire at once (a rootless A form is also close), so the
 * output is one primary label plus the alternates, ordered by specificity.
 */
import { intervalFrom, noteName, pitchClass, type PitchClass } from './pitch.ts'
import { QUALITY_BY_ID, degreeName, type Quality } from './vocabulary.ts'
import type { ChordCandidate, Voicing, VoicingType } from './types.ts'

/** Most specific first: the first rule that fired becomes the primary label. */
const SPECIFICITY: VoicingType[] = [
  'unison', 'dyad', 'so-what', 'polychord', 'upper-structure', 'rootless-a', 'rootless-b',
  'quartal', 'drop2and4', 'drop3', 'drop2', 'shell', 'cluster', 'close', 'spread', 'open',
]

const NINTHS = new Set(['9th', 'b9', '#9'])
/** What can stand in the fifth's place in a rootless form. */
const FIFTHS = new Set(['5th', '13th', 'b13', '#11', 'b5'])

const MAJOR_TRIAD = [0, 4, 7]
const MINOR_TRIAD = [0, 3, 7]

const ROMAN = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII']

interface Match {
  type: VoicingType
  reason: string
  upper?: Voicing['upper']
}

/**
 * Classifies how `notes` were arranged, given what they were named. Returns null
 * for a window with no chord: there is nothing to say about the voicing of a
 * label that is not a chord.
 */
export function classifyVoicing(notes: number[], candidate: ChordCandidate): Voicing | null {
  const quality = QUALITY_BY_ID.get(candidate.quality)
  if (!quality || notes.length === 0) return null

  const sorted = [...new Set(notes)].sort((a, b) => a - b)
  const root = candidate.root
  const degree = (midi: number) => degreeName(quality, midi - root)
  const span = sorted.at(-1)! - sorted[0]!
  const gaps = sorted.slice(1).map((midi, i) => midi - sorted[i]!)

  const matches: Match[] = []
  const add = (match: Match | null) => {
    if (match) matches.push(match)
  }

  if (sorted.length === 1) add({ type: 'unison', reason: 'one note' })
  if (sorted.length === 2) add({ type: 'dyad', reason: 'two notes' })

  add(soWhat(gaps))
  add(polychord(sorted))
  add(upperStructure(sorted, root, quality))
  add(rootless(sorted, root, quality, degree))
  add(quartal(gaps, sorted.length))
  add(drops(sorted, span))
  add(shell(sorted, degree))
  if (sorted.length >= 3 && span <= 12) add({ type: 'close', reason: 'every voice inside one octave' })
  if (span > 24 && gaps.some((gap) => gap > 7)) {
    add({ type: 'spread', reason: 'over two octaves, with gaps wider than a fifth' })
  }
  // One tone between two voices is ordinary (a 6th chord has one); a semitone,
  // or two tight gaps in a row, is a cluster and sounds like one.
  const tight = gaps.filter((gap) => gap <= 2).length
  if (gaps.some((gap) => gap === 1) || tight >= 2) {
    add({ type: 'cluster', reason: 'voices a semitone or tone apart' })
  }
  if (sorted.length >= 3 && span > 12) add({ type: 'open', reason: 'spread beyond one octave' })

  const ordered = SPECIFICITY.flatMap((type) => matches.filter((match) => match.type === type))
  const primary = ordered[0] ?? { type: 'close' as VoicingType, reason: 'no rule fired' }

  const bassPc = pitchClass(sorted[0]!)
  const coreSemitones = quality.tones.map((tone) => tone.semitones).sort((a, b) => a - b)
  const inversionIndex = coreSemitones.indexOf(intervalFrom(root, bassPc))

  const topDegree = degree(sorted.at(-1)!)
  const bottomDegree = degree(sorted[0]!)

  return {
    type: primary.type,
    alternates: [...new Set(ordered.slice(1).map((match) => match.type))],
    label: labelFor(primary.type, inversionIndex, topDegree),
    inversion: inversionIndex < 0 ? null : inversionIndex,
    topDegree,
    bottomDegree,
    spanSemitones: span,
    voices: sorted.length,
    register: registerOf(sorted, span),
    reasons: [primary.reason, ...ordered.slice(1, 3).map((match) => match.reason)],
    ...(primary.upper ? { upper: primary.upper } : {}),
  }
}

/** Three stacked fourths with a major third on top: the Kind of Blue sound. */
function soWhat(gaps: number[]): Match | null {
  if (gaps.length !== 4) return null
  const [a, b, c, d] = gaps
  if (a === 5 && b === 5 && c === 5 && d === 4) {
    return { type: 'so-what', reason: 'three perfect fourths topped by a major third' }
  }
  return null
}

function quartal(gaps: number[], voices: number): Match | null {
  if (voices < 3) return null
  if (!gaps.every((gap) => gap === 5 || gap === 6)) return null
  if (!gaps.includes(5)) return null
  return { type: 'quartal', reason: 'built in fourths rather than thirds' }
}

/**
 * Shell voicings: the two notes that carry the quality, with or without the
 * root under them. Everything else is left for someone else to play.
 */
function shell(notes: number[], degree: (midi: number) => string): Match | null {
  const degrees = notes.map(degree)
  const set = new Set(degrees)
  if (notes.length === 2 && set.has('3rd') && set.has('7th')) {
    return { type: 'shell', reason: 'only the 3rd and the 7th: the guide tones' }
  }
  if (notes.length === 3 && set.size === 3 && set.has('root') && set.has('3rd') && set.has('7th')) {
    return { type: 'shell', reason: 'root, 3rd and 7th, with the 5th left out' }
  }
  return null
}

/**
 * Bill Evans' left-hand forms. A form is 3-5-7-9 from the bottom, B form is
 * 7-9-3-5; on a dominant the 13th stands in for the 5th, and the 9th may be
 * altered. The root is deliberately absent — the bass player has it — so per
 * the design this fires without asking whether a bass note exists.
 */
function rootless(
  notes: number[],
  root: PitchClass,
  quality: Quality,
  degree: (midi: number) => string,
): Match | null {
  if (notes.length !== 4) return null
  if (notes.some((midi) => pitchClass(midi) === root)) return null
  const [d0, d1, d2, d3] = notes.map(degree)

  if (d0 === '3rd' && FIFTHS.has(d1!) && d2 === '7th' && NINTHS.has(d3!)) {
    return { type: 'rootless-a', reason: `rootless A form: 3rd, ${d1}, 7th, ${d3} from the bottom` }
  }
  if (d0 === '7th' && NINTHS.has(d1!) && d2 === '3rd' && FIFTHS.has(d3!)) {
    return { type: 'rootless-b', reason: `rootless B form: 7th, ${d1}, 3rd, ${d3} from the bottom` }
  }
  return null
}

/**
 * Drop voicings: a close four-note voicing with one or two voices moved down an
 * octave. Detected by putting them back — raise the lowest voice (or the lowest
 * two) by an octave and see whether a close voicing falls out, and which voice
 * from the top the moved one was.
 */
function drops(notes: number[], span: number): Match | null {
  if (notes.length !== 4 || span <= 12) return null

  const undrop = (count: number): number[] | null => {
    const raised = [...notes.slice(0, count).map((midi) => midi + 12), ...notes.slice(count)].sort((a, b) => a - b)
    if (new Set(raised.map(pitchClass)).size !== 4) return null
    return raised.at(-1)! - raised[0]! <= 12 ? raised : null
  }

  const two = undrop(2)
  if (two) {
    const fromTop = notes.slice(0, 2).map((midi) => 3 - two.indexOf(midi + 12))
    if (fromTop.includes(1) && fromTop.includes(3)) {
      return { type: 'drop2and4', reason: 'the 2nd and 4th voices from the top are an octave down' }
    }
  }

  const one = undrop(1)
  if (one) {
    const fromTop = 3 - one.indexOf(notes[0]! + 12)
    if (fromTop === 1) return { type: 'drop2', reason: 'the 2nd voice from the top is an octave down' }
    if (fromTop === 2) return { type: 'drop3', reason: 'the 3rd voice from the top is an octave down' }
  }
  return null
}

/**
 * An ordinary triad sitting on top of a seventh chord, whose notes are the
 * chord's extensions. Named by where its root sits: "UST bII" is the D-flat
 * triad over C7 that every bebop pianist has under their fingers.
 */
function upperStructure(notes: number[], root: PitchClass, quality: Quality): Match | null {
  if (notes.length < 5) return null
  const upper = notes.slice(-3)
  const triad = triadOf(upper)
  if (!triad) return null

  const lowerDegrees = new Set(notes.slice(0, -3).map((midi) => degreeName(quality, midi - root)))
  if (!lowerDegrees.has('3rd') && !lowerDegrees.has('7th')) return null

  // At least one voice of the triad has to be a tension; otherwise it is just
  // the chord itself with a triad accidentally on top.
  const upperDegrees = upper.map((midi) => degreeName(quality, midi - root))
  const isCore = (name: string) => name === 'root' || name === '3rd' || name === '5th' || name === '7th'
  if (upperDegrees.every(isCore)) return null

  const interval = intervalFrom(root, triad.root)
  const symbol = `${noteName(triad.root)}${triad.minor ? 'm' : ''}`
  return {
    type: 'upper-structure',
    reason: `${article(symbol)} ${symbol} triad on top of the 3rd and 7th`,
    upper: { symbol, degree: `UST ${ROMAN[interval]}` },
  }
}

/** Two triads with nothing in common, stacked. */
function polychord(notes: number[]): Match | null {
  if (notes.length < 6) return null
  const lower = triadOf(notes.slice(0, 3))
  const upper = triadOf(notes.slice(-3))
  if (!lower || !upper) return null
  const lowerPcs = new Set(notes.slice(0, 3).map(pitchClass))
  if (notes.slice(-3).some((midi) => lowerPcs.has(pitchClass(midi)))) return null
  return {
    type: 'polychord',
    reason: `${noteName(upper.root)}${upper.minor ? 'm' : ''} over ${noteName(lower.root)}${lower.minor ? 'm' : ''}`,
    upper: {
      symbol: `${noteName(upper.root)}${upper.minor ? 'm' : ''}`,
      degree: `over ${noteName(lower.root)}${lower.minor ? 'm' : ''}`,
    },
  }
}

/** Any inversion of a major or minor triad, as a root and a flavour. */
function triadOf(notes: number[]): { root: PitchClass; minor: boolean } | null {
  const pcs = [...new Set(notes.map(pitchClass))]
  if (pcs.length !== 3) return null
  for (const root of pcs) {
    const intervals = pcs.map((pc) => intervalFrom(root, pc)).sort((a, b) => a - b)
    if (intervals.every((interval, i) => interval === MAJOR_TRIAD[i])) return { root, minor: false }
    if (intervals.every((interval, i) => interval === MINOR_TRIAD[i])) return { root, minor: true }
  }
  return null
}

/** A, E and F are read aloud as vowels, so "an A triad" and "an F# triad". */
function article(symbol: string): string {
  return 'AEF'.includes(symbol[0] ?? '') ? 'an' : 'a'
}

const INVERSION_NAMES = ['root position', 'first inversion', 'second inversion', 'third inversion']

const HUMAN: Record<VoicingType, string> = {
  close: 'close', drop2: 'drop 2', drop3: 'drop 3', drop2and4: 'drop 2 and 4', shell: 'shell',
  'rootless-a': 'rootless A form', 'rootless-b': 'rootless B form', quartal: 'quartal',
  'so-what': 'So What', 'upper-structure': 'upper-structure triad', polychord: 'polychord',
  spread: 'spread', cluster: 'cluster', unison: 'unison', dyad: 'dyad', open: 'open',
}

function labelFor(type: VoicingType, inversion: number, topDegree: string): string {
  const parts = [HUMAN[type]]
  if (type === 'close' && inversion >= 0) parts.push(INVERSION_NAMES[inversion] ?? `inversion ${inversion}`)
  if (topDegree !== 'foreign') parts.push(`${topDegree} on top`)
  return parts.join(', ')
}

function registerOf(notes: number[], span: number): Voicing['register'] {
  if (span > 24) return 'wide'
  const mean = notes.reduce((sum, midi) => sum + midi, 0) / notes.length
  if (mean < 52) return 'low'
  if (mean > 72) return 'high'
  return 'mid'
}
