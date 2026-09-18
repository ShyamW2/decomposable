import { join } from 'node:path'
import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import type { BeatPayload } from '#kernel/services.ts'
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import '#kernel/contracts.ts'

const PRODUCER = { plugin: manifest.name, version: manifest.version }

export interface Config {
  device?: DeviceRequest
  profile?: ProfileRequest
  timeLimitSec?: number
}

export interface TrackBeatsOptions {
  onProgress?: (fraction: number, message?: string) => void
  signal?: AbortSignal
  force?: boolean
}

export interface BeatTrack {
  beats: BeatPayload[]
  bpm: number | null
  /** How many beats the model called downbeats. 0 means it has no opinion. */
  downbeats: number
  model: string
  device: string
}

export interface BeatsService {
  readonly implementation: string
  readonly version: string
  info(): { device: string; profile: string; model: string }
  track(songId: string, options?: TrackBeatsOptions): Promise<BeatTrack>
}

declare module 'cordis' {
  interface Context {
    beats: BeatsService
  }
}

export const name = 'beat-tracker'
export const inject = ['worker-supervisor', 'analysis-store', 'ingest']

/**
 * The beat layer.
 *
 * One event per beat, not one event for the grid: a beat is the unit that can
 * be individually wrong, and a corrected downbeat should supersede one row
 * rather than the whole track. It also means `analysis-store`'s time queries
 * work on beats the same way they work on everything else, which is what lets
 * `harmony` cut its windows without knowing anything about who tracked them.
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

  ctx.provide('beats', {
    implementation: manifest.name,
    version: manifest.version,
    info: () => ({ device: worker.device, profile: worker.profile, model: worker.model }),

    async track(songId, options = {}) {
      const audio = store.query({ songId, layer: 'audio' }).at(-1)
      if (!audio) throw new Error(`song "${songId}" has no decoded audio; ingest it first`)

      if (!options.force) {
        const existing = store.query({ songId, layer: 'beat', producer: manifest.name })
        if (existing.length > 0) {
          const payloads = existing.map((event) => event.payload as BeatPayload)
          return {
            beats: payloads,
            bpm: payloads[0]?.bpm ?? null,
            downbeats: payloads.filter((beat) => beat.beatInBar === 1).length,
            model: worker.model,
            device: worker.device,
          }
        }
      }

      const input = join(store.workspacePath(songId), (audio.payload as { path: string }).path)
      const result = await worker.run<{
        beats: BeatPayload[]
        bpm: number | null
        downbeats: number
        model: string
        device: string
        elapsedSec: number
      }>({ kind: 'beats', input }, {
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })

      // Re-running supersedes the old grid and everything cut against it, which
      // is every chord downstream — exactly what should happen when the bar
      // lines move (ADR-004).
      if (options.force) store.supersedeProducer(songId, manifest.name)

      store.appendAll(
        result.beats.map((beat) => ({
          songId,
          producer: PRODUCER,
          inputs: [audio.id],
          layer: 'beat' as const,
          tStart: beat.timeSec,
          tEnd: beat.timeSec,
          payload: beat,
        })),
      )
      logger.info(
        '%s: %d beats at %s bpm (%d downbeats) with %s on %s in %ss',
        songId, result.beats.length, result.bpm ?? '?', result.downbeats, result.model, result.device, result.elapsedSec,
      )
      return { beats: result.beats, bpm: result.bpm, downbeats: result.downbeats, model: result.model, device: result.device }
    },
  } satisfies BeatsService)
}
