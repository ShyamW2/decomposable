/**
 * Stage 2 — chord template matching with an explicit cost model.
 *
 * Every root against every quality, scored by how much of what is sounding the
 * label explains and how much of what the label claims is actually there, then
 * adjusted by the things that break ties in real music: the bass note, the key,
 * what was playing a moment ago, and a preference for the simplest label that
 * accounts for the same notes.
 *
 * The weights below are the model. They are gathered here, named, and commented
 * so that a fixture failure is a conversation about one number rather than an
 * archaeology expedition through the scoring loop.
 */
import { intervalFrom, pitchClass, type PitchClass } from './pitch.ts'
import { profileOf, type Profile } from './profile.ts'
import { NONE, QUALITIES, degreeName, symbolFor, type Quality } from './vocabulary.ts'
import type { Alt, AnalyzeOptions, ChordCandidate, Ext, Key, PitchWindow } from './types.ts'

/**
 * How the two halves of the base score trade off. Explaining what is sounding
 * counts for more than claiming everything the label promises, because a label
 * that leaves a note unaccounted for is wrong in a way a label with a missing
 * 5th is not.
 */
const EXPLAINED_SHARE = 0.62
const COMPLETENESS_SHARE = 0.38

/** A tension is explained, but not as cleanly as a chord tone. */
const TENSION_CREDIT = 0.75

/** The bass note is the single most useful disambiguator we have. */
const BASS_IS_ROOT = 0.14
const BASS_IS_CHORD_TONE = 0.04
const BASS_IS_FOREIGN = -0.1
/** When nobody told us the bass and we are guessing from the lowest note. */
const INFERRED_BASS_SCALE = 0.5

const KEY_FUNCTION = 0.035
const KEY_SCALE_TONE = 0.015

const CONTINUITY_SAME_CHORD = 0.035
const CONTINUITY_SAME_ROOT = 0.018

/** Parsimony: each step of elaborateness must earn its place. */
const COMPLEXITY_COST = 0.012

/**
 * Omitting the 5th, or the root under a bass player, is ordinary. Omitting the
 * tone that makes the quality what it is — the 3rd, the 7th, the flat 5 of a
 * half-diminished — is not, and a label that has to do it is reaching. Without
 * this an E and a B-flat under the hands read as E diminished, claiming a G
 * nobody played, rather than as the tritone of a dominant seventh missing only
 * its root and its 5th — which is what a keyboard player is telling you.
 */
const MISSING_DEFINING_TONE = -0.08
const DEFINING_WEIGHT = 0.9

/**
 * The base score tops out at 1 and every bonus is additive, so the best a label
 * can possibly do is a perfect match that the bass, the key and the previous
 * chord all agree with. Dividing by that keeps `score` inside 0..1 without
 * clipping — clipping would flatten exactly the distinctions at the top of the
 * ranking that the ranking exists to make.
 */
const SCORE_MAX = 1 + BASS_IS_ROOT + KEY_FUNCTION + CONTINUITY_SAME_CHORD

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
/** Natural minor plus the leading tone, because V7 in minor is not a modulation. */
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]

/** The seventh chord built on each degree, by quality family. */
const MAJOR_FUNCTIONS: Record<number, string[]> = {
  0: ['maj7', 'maj6', 'maj'], 2: ['min7', 'min'], 4: ['min7', 'min'], 5: ['maj7', 'maj6', 'maj'],
  7: ['dom7', 'maj', 'dom7sus4'], 9: ['min7', 'min'], 11: ['m7b5', 'dim'],
}
const MINOR_FUNCTIONS: Record<number, string[]> = {
  0: ['min7', 'min', 'minMaj7', 'min6'], 2: ['m7b5', 'dim'], 3: ['maj7', 'maj'], 5: ['min7', 'min'],
  7: ['dom7', 'min7', 'maj'], 8: ['maj7', 'maj'], 10: ['dom7', 'maj'], 11: ['dim7', 'dim'],
}

const EXT_ORDER: Ext[] = ['9', '11', '13']
const ALT_ORDER: Alt[] = ['b9', '#9', '#11', 'b5', '#5', 'b13']

interface Scored {
  root: PitchClass
  quality: Quality
  score: number
  extensions: Ext[]
  alterations: Alt[]
  omitted: PitchClass[]
  foreign: PitchClass[]
  bass?: PitchClass
  reasons: string[]
}

/**
 * Ranks every (root, quality) pair against one window. Exported separately from
 * `analyze` so the voicing stage — and the tests — can look at the ranking
 * without the classifier running.
 */
export function rankChords(window: PitchWindow, options: AnalyzeOptions = {}): ChordCandidate[] {
  const profile = profileOf(window)
  const top = options.top ?? 4

  // Fewer than two pitch classes is not a chord, and pretending otherwise is
  // how a chord track fills up with confident nonsense during a drum fill.
  if (profile.present.length < 2) {
    return [noChord(profile)]
  }

  const explicitBass = window.bassMidi
  const bassMidi = explicitBass ?? profile.notes[0]
  const bassPc = bassMidi === undefined ? undefined : pitchClass(bassMidi)
  const bassStrength = explicitBass === undefined ? INFERRED_BASS_SCALE : 1

  const scored: Scored[] = []
  for (let root = 0; root < 12; root++) {
    for (const quality of QUALITIES) {
      scored.push(score(root as PitchClass, quality, profile, window, bassPc, bassStrength))
    }
  }
  scored.sort((a, b) => b.score - a.score || a.quality.complexity - b.quality.complexity)

  return scored.slice(0, top).map(toCandidate)
}

function score(
  root: PitchClass,
  quality: Quality,
  profile: Profile,
  window: PitchWindow,
  bassPc: PitchClass | undefined,
  bassStrength: number,
): Scored {
  const coreByPc = new Map<PitchClass, number>()
  let coreTotal = 0
  for (const tone of quality.tones) {
    coreByPc.set(pitchClass(root + tone.semitones), tone.weight)
    coreTotal += tone.weight
  }

  let matchedCore = 0
  let explained = 0
  let reaching = 0
  const omitted: PitchClass[] = []
  const foreign: PitchClass[] = []
  const extensions: Ext[] = []
  const alterations: Alt[] = []

  for (const [pc, weight] of coreByPc) {
    if (profile.bins[pc]! > 0) matchedCore += weight
    else {
      omitted.push(pc)
      if (weight >= DEFINING_WEIGHT) reaching++
    }
  }

  for (const pc of profile.present) {
    const share = profile.bins[pc]!
    if (coreByPc.has(pc)) {
      explained += share
      continue
    }
    const tension = quality.tensions[intervalFrom(root, pc)]
    if (tension) {
      explained += share * TENSION_CREDIT
      if (tension === '9' || tension === '11' || tension === '13') extensions.push(tension)
      else alterations.push(tension)
      continue
    }
    foreign.push(pc)
  }

  const completeness = coreTotal > 0 ? matchedCore / coreTotal : 0
  let value = EXPLAINED_SHARE * explained + COMPLETENESS_SHARE * completeness

  const reasons: string[] = []
  let bass: PitchClass | undefined

  if (bassPc !== undefined) {
    if (bassPc === root) {
      value += BASS_IS_ROOT * bassStrength
      reasons.push('the bass is the root')
    } else if (coreByPc.has(bassPc)) {
      value += BASS_IS_CHORD_TONE * bassStrength
      bass = bassPc
      reasons.push(`the bass is the ${degreeName(quality, intervalFrom(root, bassPc))}, so an inversion`)
    } else {
      value += BASS_IS_FOREIGN * bassStrength
    }
  }

  if (window.keyHint) {
    const keyed = keyBonus(root, quality, window.keyHint)
    value += keyed.bonus
    if (keyed.reason) reasons.push(keyed.reason)
  }

  if (window.prev) {
    if (window.prev.root === root && window.prev.quality === quality.id) {
      value += CONTINUITY_SAME_CHORD
      reasons.push('the same chord is still sounding')
    } else if (window.prev.root === root) {
      value += CONTINUITY_SAME_ROOT
    }
  }

  value -= COMPLEXITY_COST * quality.complexity
  value += MISSING_DEFINING_TONE * reaching

  return {
    root,
    quality,
    score: Math.max(0, Math.min(1, value / SCORE_MAX)),
    extensions: EXT_ORDER.filter((ext) => extensions.includes(ext)),
    alterations: ALT_ORDER.filter((alt) => alterations.includes(alt)),
    omitted: omitted.sort((a, b) => a - b),
    foreign: foreign.sort((a, b) => a - b),
    ...(bass === undefined ? {} : { bass }),
    reasons,
  }
}

function keyBonus(root: PitchClass, quality: Quality, key: Key): { bonus: number; reason?: string } {
  const degree = intervalFrom(key.tonic, root)
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
  if (!scale.includes(degree)) return { bonus: 0 }
  const functions = (key.mode === 'major' ? MAJOR_FUNCTIONS : MINOR_FUNCTIONS)[degree]
  if (functions?.includes(quality.id)) {
    return { bonus: KEY_FUNCTION, reason: 'diatonic in the key' }
  }
  return { bonus: KEY_SCALE_TONE }
}

function toCandidate(scored: Scored): ChordCandidate {
  const { root, quality, extensions, alterations } = scored
  const reasons = [...scored.reasons]

  const missingThird = quality.tones.some((tone) => tone.weight >= 1 && scored.omitted.includes(pitchClass(root + tone.semitones)))
  if (scored.omitted.includes(root)) reasons.unshift('rootless: the root is not sounding')
  if (missingThird) reasons.push('a tone that defines the quality is missing')
  if (extensions.length || alterations.length) {
    reasons.push(`tensions: ${[...extensions, ...alterations].join(', ')}`)
  }
  if (scored.foreign.length) {
    reasons.push(`${scored.foreign.length} note${scored.foreign.length > 1 ? 's' : ''} this label does not explain`)
  }

  return {
    root,
    quality: quality.id,
    extensions,
    alterations,
    ...(scored.bass === undefined ? {} : { bass: scored.bass }),
    symbol: symbolFor(root, quality, extensions, alterations, scored.bass),
    score: scored.score,
    reasons,
    omitted: scored.omitted,
    foreign: scored.foreign,
  }
}

function noChord(profile: Profile): ChordCandidate {
  return {
    root: profile.present[0] ?? 0,
    quality: NONE.id,
    extensions: [],
    alterations: [],
    symbol: NONE.symbol,
    score: 1,
    reasons: [profile.mass === 0 ? 'nothing is sounding' : 'a single pitch class is not a chord'],
    omitted: [],
    foreign: [],
  }
}
