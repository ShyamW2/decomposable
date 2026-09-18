import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import { analyze, buildWindow, isAmbiguous, profileOf } from '#harmony'
import type { AnalyzeOptions, HarmonyResult, Key, PitchWindow, TimedNote } from '#harmony'
import type { AnalysisEventInput } from '#kernel/types.ts'
import type { BeatPayload, ChordPayload, ChromaPayload, NotePayload, VoicingPayload } from '#kernel/services.ts'
import '#kernel/contracts.ts'

const PRODUCER = { plugin: manifest.name, version: manifest.version }

export interface Config {
  /** How many candidates each window keeps. */
  top?: number
  /** Below this score gap the runner-up is worth showing. */
  ambiguityMargin?: number
  /**
   * Window length used when the song has no beat track yet. Half a second is
   * about a beat at a medium tempo, which is the resolution a chord track wants.
   */
  fallbackWindowSec?: number
  /** Analyse every Nth beat boundary to boundary. 1 is per beat. */
  beatsPerWindow?: number
}

export interface AnalyseSongOptions {
  keyHint?: Key
  /** Re-analyse even if this version has already run on the song. */
  force?: boolean
  onProgress?: (fraction: number, message?: string) => void
}

export interface AnalyseSongResult {
  windows: number
  chords: number
  /** How the windows were cut: from the beat track, or from the clock. */
  grid: 'beats' | 'fixed'
  ambiguous: number
}

export interface HarmonyService {
  readonly version: string
  /** Stages 1 to 3 over one window. Pure: no I/O, no clock, nothing stored. */
  analyze(window: PitchWindow, options?: AnalyzeOptions): HarmonyResult
  /** The live-keyboard convenience: notes held right now. */
  analyzeNotes(midi: number[], extras?: Partial<PitchWindow>): HarmonyResult
  /** Runs the engine over a song's transcribed notes and stores the result. */
  analyzeSong(songId: string, options?: AnalyseSongOptions): AnalyseSongResult
}

declare module 'cordis' {
  interface Context {
    harmony: HarmonyService
  }
}

export const name = 'harmony'
export const inject = ['analysis-store']

/**
 * The harmony engine, mounted.
 *
 * The engine itself is in `harmony/` and knows nothing about Cordis, SQLite or
 * time: that is what lets the same code answer a MIDI keyboard in a fraction of
 * a millisecond and grind through a three-minute transcription. This file is
 * only the two things the engine cannot do for itself — cut the song into
 * windows, and write what came back down with its provenance.
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const logger = ctx.logger('harmony')
  const options: AnalyzeOptions = {
    top: config.top ?? 4,
    ambiguityMargin: config.ambiguityMargin ?? 0.05,
  }
  const fallbackWindowSec = config.fallbackWindowSec ?? 0.5
  const beatsPerWindow = Math.max(1, Math.round(config.beatsPerWindow ?? 1))

  ctx.provide('harmony', {
    version: manifest.version,

    analyze: (window, overrides) => analyze(window, { ...options, ...overrides }),

    analyzeNotes(midi, extras = {}) {
      return analyze(
        {
          start: 0,
          end: 0,
          notes: midi.map((value) => ({ midi: value, weight: 1, source: 'midi' as const })),
          ...(midi.length ? { bassMidi: Math.min(...midi) } : {}),
          ...extras,
        },
        options,
      )
    },

    analyzeSong(songId, run = {}): AnalyseSongResult {
      const noteEvents = store.query({ songId, layer: 'note' })
      if (noteEvents.length === 0) {
        throw new Error(`song "${songId}" has no transcribed notes; run a transcriber first`)
      }
      const beats = store.query({ songId, layer: 'beat' })
      const boundaries = beats.length >= 2 ? beatGrid(beats, beatsPerWindow) : fixedGrid(noteEvents, fallbackWindowSec)
      const grid: AnalyseSongResult['grid'] = beats.length >= 2 ? 'beats' : 'fixed'

      if (run.force) store.supersedeProducer(songId, manifest.name)

      // Notes by id, so a window's provenance names the exact notes it saw
      // rather than "the note layer" (ADR-004).
      const notes: (TimedNote & { id: string })[] = noteEvents.map((event) => {
        const payload = event.payload as NotePayload
        return {
          id: event.id,
          midi: payload.midi,
          start: payload.startSec,
          end: payload.endSec,
          confidence: event.confidence ?? payload.velocity ?? 1,
          source: payload.source,
        }
      })
      notes.sort((a, b) => a.start - b.start)

      let cursor = 0
      let ambiguous = 0
      let chords = 0
      let prev: HarmonyResult['candidates'][number] | undefined
      const pending: AnalysisEventInput[] = []

      for (const [index, [start, end]] of boundaries.entries()) {
        // The notes are sorted, so the window only ever walks forwards; a
        // three-minute piano transcription is thousands of notes and this
        // should not be quadratic in them.
        while (cursor < notes.length && notes[cursor]!.end < start) cursor++
        const overlapping = []
        for (let i = cursor; i < notes.length && notes[i]!.start < end; i++) {
          if (notes[i]!.end > start) overlapping.push(notes[i]!)
        }
        if (overlapping.length === 0) {
          prev = undefined
          continue
        }

        const window = buildWindow(overlapping, {
          start,
          end,
          ...(run.keyHint ? { keyHint: run.keyHint } : {}),
          ...(prev ? { prev } : {}),
        })
        const result = analyze(window, options)
        const winner = result.candidates[0]!
        if (winner.quality === 'none') {
          prev = undefined
          continue
        }

        const inputs = overlapping.map((note) => note.id)
        const profile = profileOf(window)
        const chroma = store.append<ChromaPayload>({
          songId,
          producer: PRODUCER,
          inputs,
          layer: 'chroma',
          tStart: start,
          tEnd: end,
          payload: { bins: profile.bins, notes: profile.notes, bassMidi: window.bassMidi ?? null },
        })

        const flagged = isAmbiguous(result, options)
        if (flagged) ambiguous++
        const chord = store.append<ChordPayload>({
          songId,
          producer: PRODUCER,
          inputs: [chroma.id],
          confidence: winner.score,
          layer: 'chord',
          tStart: start,
          tEnd: end,
          payload: {
            symbol: winner.symbol,
            root: winner.root,
            quality: winner.quality,
            candidates: result.candidates,
            margin: result.margin,
            ambiguous: flagged,
          },
        })
        chords++

        if (winner.voicing) {
          pending.push({
            songId,
            producer: PRODUCER,
            inputs: [chord.id],
            layer: 'voicing',
            tStart: start,
            tEnd: end,
            payload: { ...winner.voicing, symbol: winner.symbol, notes: result.notes } satisfies VoicingPayload,
          })
        }
        prev = winner
        run.onProgress?.((index + 1) / boundaries.length)
      }

      if (pending.length) store.appendAll(pending)
      logger.info('%s: %d chords over %d windows from the %s grid', songId, chords, boundaries.length, grid)
      return { windows: boundaries.length, chords, grid, ambiguous }
    },
  } satisfies HarmonyService)
}

/** Beat boundaries, every `stride` beats. */
function beatGrid(beats: { payload: unknown }[], stride: number): [number, number][] {
  const times = beats
    .map((event) => (event.payload as BeatPayload).timeSec)
    .sort((a, b) => a - b)
  const out: [number, number][] = []
  for (let i = 0; i + stride < times.length; i += stride) out.push([times[i]!, times[i + stride]!])
  return out
}

/** Even windows over the span the notes cover, for a song with no beat track. */
function fixedGrid(noteEvents: { tStart?: number | null; tEnd?: number | null }[], length: number): [number, number][] {
  let first = Infinity
  let last = 0
  for (const event of noteEvents) {
    first = Math.min(first, event.tStart ?? 0)
    last = Math.max(last, event.tEnd ?? 0)
  }
  if (!Number.isFinite(first) || last <= first) return []
  const out: [number, number][] = []
  for (let t = first; t < last; t += length) out.push([t, Math.min(t + length, last)])
  return out
}
