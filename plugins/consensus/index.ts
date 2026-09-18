import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import { QUALITY_BY_ID, type Family } from '#harmony'
import type { BeatPayload, ChordPayload } from '#kernel/services.ts'
import type { AnalysisEvent } from '#kernel/types.ts'
import '#kernel/contracts.ts'

const PRODUCER = { plugin: manifest.name, version: manifest.version }

export interface Config {
  /**
   * How much each producer's vote is worth, by plugin name. A producer with no
   * entry is weighted by its own mean confidence on the song — see the README
   * on why that is a stand-in for calibration rather than calibration.
   */
  weights?: Record<string, number>
  /** Window length when the song has no beat track. */
  fallbackWindowSec?: number
  /** Below this share of the total vote the merged chord is marked contested. */
  agreementFloor?: number
}

export interface Disagreement {
  producer: string
  symbol: string
  /** 0..1: how much this label and the winner have in common. */
  agreement: number
}

export interface ConsensusPayload extends ChordPayload {
  /** Share of the total vote the winner took, 0..1. */
  agreement: number
  /** True when the producers did not substantially agree. */
  contested: boolean
  /** What the losing producers said. Empty when everybody agreed. */
  disagreement: Disagreement[]
  /** Which producers had an opinion about this window at all. */
  sources: string[]
}

export interface MergeResult {
  windows: number
  merged: number
  contested: number
  producers: string[]
  weights: Record<string, number>
}

export interface ConsensusService {
  readonly version: string
  merge(songId: string, options?: { force?: boolean }): MergeResult
  /** Which producers have written a chord track for this song. */
  producersFor(songId: string): string[]
}

declare module 'cordis' {
  interface Context {
    consensus: ConsensusService
  }
}

/**
 * How much two labels have in common. Producers do not share a vocabulary —
 * `harmony` says Cmaj9 where `chord-audio` can only say Cmaj7 — so a vote that
 * demanded exact agreement would find disagreement everywhere and mean nothing.
 */
function agreementBetween(a: ChordPayload, b: ChordPayload): number {
  if (a.root !== b.root) return 0
  if (a.quality === b.quality) return 1
  const familyA = QUALITY_BY_ID.get(a.quality)?.family
  const familyB = QUALITY_BY_ID.get(b.quality)?.family
  if (!familyA || !familyB) return 0.4
  if (familyA === familyB) return 0.8
  // Major and dominant differ by one note and are routinely confused by a
  // template recogniser; that is a smaller disagreement than major and minor.
  if (nearby(familyA, familyB)) return 0.6
  return 0.35
}

const NEAR: [Family, Family][] = [
  ['major', 'dominant'],
  ['minor', 'diminished'],
  ['dominant', 'suspended'],
  ['augmented', 'dominant'],
]

function nearby(a: Family, b: Family): boolean {
  return NEAR.some(([x, y]) => (a === x && b === y) || (a === y && b === x))
}

export const name = 'consensus'
export const inject = ['analysis-store']

/**
 * Where disagreement becomes visible.
 *
 * Several plugins write chord tracks by different routes — `harmony` through
 * separated stems and transcribed notes, `chord-audio` through the spectrum of
 * the mixture — and this merges them into one track that says how much they
 * agreed. It reads the `chord` layer by producer and votes, so a third or
 * fourth producer joins without a line of code here.
 *
 * The output is deliberately not "the right answer". It is the best-supported
 * answer plus what the others said, because a marker the user can look into is
 * worth more than a confident label that happens to be wrong (non-negotiable 5).
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const logger = ctx.logger(manifest.name)
  const fallbackWindowSec = config.fallbackWindowSec ?? 0.5
  const agreementFloor = config.agreementFloor ?? 0.7

  const chordTracks = (songId: string) => {
    const tracks = new Map<string, AnalysisEvent<ChordPayload>[]>()
    for (const event of store.query({ songId, layer: 'chord' }) as AnalysisEvent<ChordPayload>[]) {
      if (event.producer.plugin === manifest.name) continue
      tracks.set(event.producer.plugin, [...(tracks.get(event.producer.plugin) ?? []), event])
    }
    return tracks
  }

  ctx.provide('consensus', {
    version: manifest.version,

    producersFor: (songId) => [...chordTracks(songId).keys()].sort(),

    merge(songId, options = {}): MergeResult {
      const tracks = chordTracks(songId)
      if (tracks.size === 0) {
        throw new Error(`song "${songId}" has no chord tracks to merge; run harmony or chord-audio first`)
      }

      // A producer with no configured weight is weighted by how sure it was on
      // this song. See the README: this is a stand-in for calibration.
      const weights: Record<string, number> = {}
      for (const [producer, events] of tracks) {
        const configured = config.weights?.[producer]
        weights[producer] = configured ?? mean(events.map((event) => event.confidence ?? 0.5))
      }

      const boundaries = windowsFor(store, songId, tracks, fallbackWindowSec)
      if (options.force) store.supersedeProducer(songId, manifest.name)

      let contested = 0
      let merged = 0
      for (const [start, end] of boundaries) {
        const middle = (start + end) / 2
        const opinions: { producer: string; event: AnalysisEvent<ChordPayload> }[] = []
        for (const [producer, events] of tracks) {
          const event = events.find((candidate) => (candidate.tStart ?? 0) <= middle && (candidate.tEnd ?? 0) > middle)
          if (event) opinions.push({ producer, event })
        }
        if (opinions.length === 0) continue

        // Each opinion is scored by how much every other opinion supports it.
        // With one producer that is a vote of one, which is the honest result:
        // a single track merged is itself, marked as unsupported.
        let best = opinions[0]!
        let bestScore = -1
        let total = 0
        const scores = new Map<string, number>()
        for (const opinion of opinions) {
          let score = 0
          for (const other of opinions) {
            score += weights[other.producer]! * agreementBetween(opinion.event.payload, other.event.payload)
          }
          scores.set(opinion.producer, score)
          total += weights[opinion.producer]!
          if (score > bestScore) {
            bestScore = score
            best = opinion
          }
        }

        // The winner's score against the most it could possibly have scored:
        // unanimity. One producer alone therefore scores 1 and is still marked
        // contested below, because agreeing with yourself is not agreement.
        const agreement = clamp(total > 0 ? bestScore / total : 0)
        const disagreement: Disagreement[] = opinions
          .filter((opinion) => opinion.producer !== best.producer)
          .map((opinion) => ({
            producer: opinion.producer,
            symbol: opinion.event.payload.symbol,
            agreement: agreementBetween(best.event.payload, opinion.event.payload),
          }))
          .filter((entry) => entry.agreement < 1)

        const isContested = agreement < agreementFloor || opinions.length < 2
        if (isContested) contested++

        store.append<ConsensusPayload>({
          songId,
          producer: PRODUCER,
          inputs: opinions.map((opinion) => opinion.event.id),
          confidence: clamp(agreement * (best.event.confidence ?? 1)),
          layer: 'chord',
          tStart: start,
          tEnd: end,
          payload: {
            ...best.event.payload,
            agreement,
            contested: isContested,
            disagreement,
            sources: opinions.map((opinion) => opinion.producer).sort(),
          },
        })
        merged++
      }

      logger.info(
        '%s: merged %d windows from %s; %d contested',
        songId, merged, [...tracks.keys()].join(' + '), contested,
      )
      return { windows: boundaries.length, merged, contested, producers: [...tracks.keys()].sort(), weights }
    },
  } satisfies ConsensusService)
}

/**
 * The grid the merge happens on: the beat track when there is one, because that
 * is what the chords were cut against, and otherwise even windows over whatever
 * the producers covered.
 */
function windowsFor(
  store: Context['analysis-store'],
  songId: string,
  tracks: Map<string, AnalysisEvent<ChordPayload>[]>,
  fallbackWindowSec: number,
): [number, number][] {
  const beats = store
    .query({ songId, layer: 'beat' })
    .map((event) => (event.payload as BeatPayload).timeSec)
    .sort((a, b) => a - b)
  if (beats.length >= 2) {
    return beats.slice(0, -1).map((time, index) => [time, beats[index + 1]!] as [number, number])
  }
  let first = Infinity
  let last = 0
  for (const events of tracks.values()) {
    for (const event of events) {
      first = Math.min(first, event.tStart ?? 0)
      last = Math.max(last, event.tEnd ?? 0)
    }
  }
  if (!Number.isFinite(first) || last <= first) return []
  const out: [number, number][] = []
  for (let t = first; t < last; t += fallbackWindowSec) out.push([t, Math.min(t + fallbackWindowSec, last)])
  return out
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0.5)
