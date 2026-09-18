/**
 * The harmony engine: pure TypeScript, no I/O, no clock, no randomness (ADR-003).
 *
 * One call runs stages 1 to 3 of `04-harmony-engine.md`: collapse the window to
 * a pitch-class profile, rank every root and quality against it, and classify
 * how the winner was voiced. The answer is always a ranked list with reasons,
 * never a single label, because ambiguity is data (CLAUDE.md non-negotiable 5).
 *
 * Stage 4 (key finding) and stage 5 (progression parsing) are Phase 4 and are
 * not here; `keyHint` on a window is consumed but not yet produced.
 */
import { rankChords } from './chords.ts'
import { profileOf } from './profile.ts'
import { classifyVoicing } from './voicing.ts'
import type { AnalyzeOptions, HarmonyResult, PitchWindow } from './types.ts'

export function analyze(window: PitchWindow, options: AnalyzeOptions = {}): HarmonyResult {
  const profile = profileOf(window)
  const candidates = rankChords(window, options)

  if (options.classifyVoicing !== false) {
    for (const candidate of candidates) {
      const voicing = classifyVoicing(profile.notes, candidate)
      if (voicing) candidate.voicing = voicing
    }
  }

  const margin = candidates.length > 1 ? candidates[0]!.score - candidates[1]!.score : 1
  return { candidates, margin, profile: profile.bins, notes: profile.notes }
}

/** True when the runner-up is close enough that the UI should show it. */
export function isAmbiguous(result: HarmonyResult, options: AnalyzeOptions = {}): boolean {
  return result.candidates.length > 1 && result.margin < (options.ambiguityMargin ?? 0.05)
}

export { rankChords } from './chords.ts'
export { buildWindow, profileOf, windowFromMidi, SOURCE_WEIGHT } from './profile.ts'
export type { Profile, TimedNote, BuildWindowOptions } from './profile.ts'
export { classifyVoicing } from './voicing.ts'
export { QUALITIES, QUALITY_BY_ID, degreeName, symbolFor } from './vocabulary.ts'
export type { Quality, Family, Tone } from './vocabulary.ts'
export * from './pitch.ts'
export type * from './types.ts'
