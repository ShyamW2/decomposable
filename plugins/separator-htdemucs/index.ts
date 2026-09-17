import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import { createSeparatorService } from '#kernel/separator-service.ts'
import '#kernel/contracts.ts'

export interface Config {
  device?: DeviceRequest
  profile?: ProfileRequest
  /** Demucs random shifts: a slightly better result for another full pass each. */
  shifts?: number
  /** Overlap between the 8-second windows the song is split into. */
  overlap?: number
  /** Seconds. A whole song on a 4-core CPU can take 3× its own length (O-7). */
  timeLimitSec?: number
}

export const name = 'separator-htdemucs'
export const inject = ['worker-supervisor', 'analysis-store', 'ingest']

/**
 * Stem separation with Hybrid Transformer Demucs: drums, bass, other, vocals.
 *
 * The bookkeeping around the worker lives in `kernel/src/separator-service.ts`,
 * shared with `separator-bsroformer`. What is here is this model's own
 * knobs and the process that runs it.
 */
export function apply(ctx: Context, config: Config = {}) {
  const worker = ctx['worker-supervisor'].acquire({
    slot: manifest.name,
    manifest: (manifest as PluginManifest).worker!,
    device: config.device ?? 'auto',
    profile: config.profile ?? 'auto',
    timeLimitSec: config.timeLimitSec ?? 0,
  })
  ctx.effect(() => () => worker.release(), `${manifest.name}:worker`)

  ctx.provide(
    'separator',
    createSeparatorService(ctx, manifest as PluginManifest, worker, {
      shifts: config.shifts ?? 0,
      overlap: config.overlap ?? 0.25,
    }),
  )
}
