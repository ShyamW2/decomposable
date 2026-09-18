/**
 * The harmony engine's public vocabulary. These types are the contract between
 * the pure engine and everything that uses it: the `harmony` plugin, the live
 * MIDI path, and the record analysis in Phase 3.
 *
 * `04-harmony-engine.md` is the design authority for this file.
 */
import type { PitchClass } from './pitch.ts'

/** Where a note came from. Used to weight it and to explain the answer. */
export type NoteSource = 'bass' | 'piano' | 'guitar' | 'vocals' | 'other' | 'midi'

export interface WindowNote {
  midi: number
  /** 0..1. Confidence × duration share, computed by whoever built the window. */
  weight: number
  source: NoteSource
}

export interface Key {
  tonic: PitchClass
  mode: 'major' | 'minor'
}

/** One analysis window: a beat, a half-bar, or a held chord on the keyboard. */
export interface PitchWindow {
  /** Seconds from the start of the decoded audio. Both 0 for a live chord. */
  start: number
  end: number
  notes: WindowNote[]
  /** Lowest confident note from the bass stem or from the MIDI keyboard. */
  bassMidi?: number
  keyHint?: Key
  /** The previous window's winner, so a sustained chord does not flicker. */
  prev?: ChordCandidate
}

/** Diatonic tensions. A 6th is a quality (maj6/min6), not a tension. */
export type Ext = '9' | '11' | '13'
/** Altered tensions. */
export type Alt = 'b9' | '#9' | '#11' | 'b13' | 'b5' | '#5'

export interface ChordCandidate {
  root: PitchClass
  /** A quality id from the vocabulary: 'maj7', 'min7', 'dom7', 'none', ... */
  quality: string
  extensions: Ext[]
  alterations: Alt[]
  /** Set only when the bass is not the root, i.e. this is a slash chord. */
  bass?: PitchClass
  /** What the UI prints: "Cmaj9/E". */
  symbol: string
  voicing?: Voicing
  /** 0..1. Comparable within one window only; see `margin` on the result. */
  score: number
  /** Human-readable, shown in the UI. Ordered most to least important. */
  reasons: string[]
  /** Chord tones the label claims that are not being played. */
  omitted: PitchClass[]
  /** Notes being played that the label does not explain. */
  foreign: PitchClass[]
}

export type VoicingType =
  | 'close'
  | 'drop2'
  | 'drop3'
  | 'drop2and4'
  | 'shell'
  | 'rootless-a'
  | 'rootless-b'
  | 'quartal'
  | 'so-what'
  | 'upper-structure'
  | 'polychord'
  | 'spread'
  | 'cluster'
  | 'unison'
  | 'dyad'
  | 'open'

export interface Voicing {
  type: VoicingType
  /** Other rules that also fired, most specific first. */
  alternates: VoicingType[]
  /** "drop 2, 7th on top" — the sentence a teacher would say. */
  label: string
  /** 0 root position, 1 first inversion, ... null when the bass is not a chord tone. */
  inversion: number | null
  /** Degree of the melody note: "7th", "9th", "3rd". */
  topDegree: string | null
  bottomDegree: string | null
  /** Highest minus lowest, in semitones. */
  spanSemitones: number
  voices: number
  register: 'low' | 'mid' | 'high' | 'wide'
  reasons: string[]
  /** For an upper-structure or polychord: the named upper triad, e.g. "D/C7". */
  upper?: { symbol: string; degree: string }
}

export interface HarmonyResult {
  /** Ranked, best first. Never empty: a silent window yields one `none`. */
  candidates: ChordCandidate[]
  /** score[0] - score[1]. The UI shows the runner-up when this is small. */
  margin: number
  /** The 12-bin weighted pitch-class profile the ranking was computed from. */
  profile: number[]
  /** MIDI notes the window was built from, ascending. */
  notes: number[]
}

export interface AnalyzeOptions {
  /** How many candidates to return. Default 4. */
  top?: number
  /** Below this the runner-up is worth showing. Default 0.05. */
  ambiguityMargin?: number
  /** Classify the voicing of the winner. Default true. */
  classifyVoicing?: boolean
}
