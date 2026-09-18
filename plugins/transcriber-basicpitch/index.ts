import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import { createTranscriberService } from '#kernel/transcriber-service.ts'
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import '#kernel/contracts.ts'

export interface Config {
  device?: DeviceRequest
  profile?: ProfileRequest
  /** Louder onsets only. Raising it loses quiet inner voices; lowering it invents them. */
  onsetThreshold?: number
  frameThreshold?: number
  minimumNoteLengthMs?: number
  /** Lowest and highest note to look for, in Hz. Worth setting per stem. */
  minFrequency?: number
  maxFrequency?: number
  /** Transcribe the mix as well as the stems. */
  includeMix?: boolean
  timeLimitSec?: number
}

export const name = 'transcriber-basicpitch'
export const inject = ['worker-supervisor', 'analysis-store', 'ingest']

/**
 * Basic Pitch: the transcriber the lite profile is defined by.
 *
 * The bookkeeping — which stems to point it at, and writing the notes down with
 * provenance — is in `kernel/src/transcriber-service.ts`, shared with
 * `transcriber-muscriptor`. What is here is this model's own knobs.
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

  const job: Record<string, unknown> = {}
  for (const key of ['onsetThreshold', 'frameThreshold', 'minimumNoteLengthMs', 'minFrequency', 'maxFrequency'] as const) {
    if (config[key] !== undefined) job[key] = config[key]
  }

  ctx.provide(
    'transcriber',
    createTranscriberService(ctx, manifest as PluginManifest, worker, {
      job,
      ...(config.includeMix ? { includeMix: true } : {}),
    }),
  )
}
