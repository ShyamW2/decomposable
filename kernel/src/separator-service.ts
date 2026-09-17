import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { SeparateOptions, Separator, StemRef } from './services.ts'
import type { AnalysisEvent, PluginManifest } from './types.ts'
import type { WorkerHandle } from './worker-supervisor/supervisor.ts'
import './contracts.ts'

/** What a separator worker answers a `separate` job with. */
export interface SeparateJobResult {
  stems: WorkerStem[]
  model: string
  device: string
  sampleRate: number
  elapsedSec: number
}

export interface WorkerStem {
  stem: string
  /** File name inside the output directory the worker was given. */
  path: string
  sampleRate: number
  channels: number
  durationSec: number
  peak: number
  rms: number
}

/**
 * The half of a separator plugin that is the same whichever model does the work:
 * find the decoded audio, hand the worker a directory, and record what came back
 * with provenance pointing at the audio it came from.
 *
 * This lives in the kernel rather than in one of the plugins because two plugins
 * now need it (ADR-007: the second concrete use is what earns the abstraction).
 * Each plugin keeps its own worker, its own config and its own README; only this
 * bookkeeping is shared.
 */
export function createSeparatorService(
  ctx: Context,
  manifest: PluginManifest,
  worker: WorkerHandle,
  jobExtras: Record<string, unknown> = {},
): Separator {
  const store = ctx['analysis-store']
  const logger = ctx.logger(manifest.name)
  const producer = { plugin: manifest.name, version: manifest.version }

  return {
    implementation: manifest.name,
    version: manifest.version,
    info: () => ({ device: worker.device, profile: worker.profile, model: worker.model }),

    async separate(songId: string, options: SeparateOptions = {}): Promise<StemRef[]> {
      const audio = store.query({ songId, layer: 'audio' }).at(-1)
      if (!audio) throw new Error(`song "${songId}" has no decoded audio; ingest it first`)

      if (!options.force) {
        const existing = store.query({ songId, layer: 'stem', producer: manifest.name })
        if (existing.length > 0) return existing.map(toStemRef)
      }

      const workspace = store.workspacePath(songId)
      // Stems are filed under the name of the implementation that made them, so
      // two separators can be compared on one song without overwriting each
      // other. That is the point of being able to swap them.
      const relativeDir = join('stems', manifest.name)
      mkdirSync(join(workspace, relativeDir), { recursive: true })

      const started = Date.now()
      const result = await worker.run<SeparateJobResult>(
        {
          kind: 'separate',
          input: join(workspace, (audio.payload as { path: string }).path),
          outDir: join(workspace, relativeDir),
          ...jobExtras,
        },
        {
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
      logger.info(
        'separated %s into %d stems with %s on %s in %ss',
        songId,
        result.stems.length,
        result.model,
        result.device,
        result.elapsedSec,
      )

      // Re-separating supersedes the previous attempt and everything derived
      // from it, rather than leaving two sets of stems both claiming to be current.
      if (options.force) store.supersedeProducer(songId, manifest.name)

      const events = store.appendAll(
        result.stems.map((stem) => ({
          songId,
          producer,
          inputs: [audio.id],
          layer: 'stem' as const,
          tStart: 0,
          tEnd: stem.durationSec,
          payload: {
            ...stem,
            path: join(relativeDir, stem.path),
            model: result.model,
            device: result.device,
            elapsedSec: result.elapsedSec,
            wallClockSec: Math.round((Date.now() - started) / 1000),
          },
        })),
      )
      return events.map(toStemRef)
    },
  }
}

function toStemRef(event: AnalysisEvent): StemRef {
  const payload = event.payload as WorkerStem
  return {
    stem: payload.stem,
    path: payload.path,
    sampleRate: payload.sampleRate,
    channels: payload.channels,
    durationSec: payload.durationSec,
    peak: payload.peak,
    rms: payload.rms,
    eventId: event.id,
  }
}
