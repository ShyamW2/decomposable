import { join } from 'node:path'
import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import { QUALITY_BY_ID, symbolFor, type ChordCandidate } from '#harmony'
import type { BeatPayload, ChordPayload } from '#kernel/services.ts'
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import '#kernel/contracts.ts'

const PRODUCER = { plugin: manifest.name, version: manifest.version }

export interface Config {
  device?: DeviceRequest
  profile?: ProfileRequest
  /**
   * How much the smoother prefers the chord it is already on. Higher holds
   * chords through passing notes; too high and it never moves at all.
   */
  selfTransition?: number
  timeLimitSec?: number
}

export interface RecogniseOptions {
  onProgress?: (fraction: number, message?: string) => void
  signal?: AbortSignal
  force?: boolean
}

export interface AudioChords {
  chords: number
  /** Whether the chroma was averaged per beat or per frame. */
  grid: 'beats' | 'frames'
  model: string
  device: string
}

export interface ChordAudioService {
  readonly implementation: string
  readonly version: string
  info(): { device: string; profile: string; model: string }
  recognise(songId: string, options?: RecogniseOptions): Promise<AudioChords>
}

declare module 'cordis' {
  interface Context {
    'chord-audio': ChordAudioService
  }
}

interface WorkerChord {
  startSec: number
  endSec: number
  root: number
  quality: string
  symbol: string
  score: number
  runnerUp: string | null
}

export const name = 'chord-audio'
export const inject = ['worker-supervisor', 'analysis-store', 'ingest']

/**
 * The second opinion.
 *
 * `harmony` reaches a chord through transcribed notes; this reaches one through
 * the spectrum. Both write to the `chord` layer, tagged with who produced them,
 * and `consensus` merges them. Where the two roads disagree there is something
 * real to show the user rather than a single confident answer that happens to
 * be wrong (non-negotiable 5).
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const logger = ctx.logger(manifest.name)

  const worker = ctx['worker-supervisor'].acquire({
    slot: manifest.name,
    manifest: (manifest as PluginManifest).worker!,
    device: config.device ?? 'auto',
    profile: config.profile ?? 'auto',
    timeLimitSec: config.timeLimitSec ?? 0,
  })
  ctx.effect(() => () => worker.release(), `${manifest.name}:worker`)

  ctx.provide('chord-audio', {
    implementation: manifest.name,
    version: manifest.version,
    info: () => ({ device: worker.device, profile: worker.profile, model: worker.model }),

    async recognise(songId, options = {}) {
      const audio = store.query({ songId, layer: 'audio' }).at(-1)
      if (!audio) throw new Error(`song "${songId}" has no decoded audio; ingest it first`)

      const existing = store.query({ songId, layer: 'chord', producer: manifest.name })
      if (existing.length > 0 && !options.force) {
        return { chords: existing.length, grid: 'beats', model: worker.model, device: worker.device }
      }

      // Beats are an input, not a requirement: without them the recogniser
      // works per frame, which is worse but not nothing.
      const beatEvents = store.query({ songId, layer: 'beat' })
      const beats = beatEvents.map((event) => (event.payload as BeatPayload).timeSec).sort((a, b) => a - b)

      const result = await worker.run<{
        chords: WorkerChord[]
        model: string
        device: string
        grid: 'beats' | 'frames'
        elapsedSec: number
      }>(
        {
          kind: 'chords',
          input: join(store.workspacePath(songId), (audio.payload as { path: string }).path),
          beats,
          selfTransition: config.selfTransition ?? 0.85,
        },
        {
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )

      if (options.force) store.supersedeProducer(songId, manifest.name)

      const inputs = beatEvents.length ? [audio.id, ...beatEvents.map((event) => event.id)] : [audio.id]
      store.appendAll<ChordPayload>(
        result.chords.map((chord) => ({
          songId,
          producer: PRODUCER,
          inputs,
          confidence: clamp(chord.score),
          layer: 'chord' as const,
          tStart: chord.startSec,
          tEnd: chord.endSec,
          payload: {
            symbol: chord.symbol,
            root: chord.root,
            quality: chord.quality,
            candidates: toCandidates(chord),
            margin: 0,
            // A template recogniser has no calibrated notion of a close call;
            // `consensus` decides what disagreement means, not this plugin.
            ambiguous: false,
          },
        })),
      )
      logger.info(
        '%s: %d chords from the %s grid with %s in %ss',
        songId, result.chords.length, result.grid, result.model, result.elapsedSec,
      )
      return { chords: result.chords.length, grid: result.grid, model: result.model, device: result.device }
    },
  } satisfies ChordAudioService)
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/**
 * The worker answers with a symbol; the rest of the app speaks `ChordCandidate`.
 * Filling in the omitted and foreign fields would be a lie — this recogniser
 * never saw a note — so they stay empty and the reason says where it came from.
 */
function toCandidates(chord: WorkerChord): ChordCandidate[] {
  const quality = QUALITY_BY_ID.get(chord.quality)
  const symbol = quality && chord.root >= 0 ? symbolFor(chord.root, quality, [], []) : chord.symbol
  return [
    {
      root: Math.max(0, chord.root),
      quality: chord.quality,
      extensions: [],
      alterations: [],
      symbol,
      score: clamp(chord.score),
      reasons: ['matched against the chroma of the audio, not against transcribed notes'],
      omitted: [],
      foreign: [],
    },
  ]
}
