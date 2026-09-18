import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import { createTranscriberService } from '#kernel/transcriber-service.ts'
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import '#kernel/contracts.ts'

export interface Config {
  device?: DeviceRequest
  profile?: ProfileRequest
  /** Beam width. 1 is greedy and much faster; wider is slower and usually better. */
  beamSize?: number
  /** Restrict the model to these instruments, when the stem is known. */
  instruments?: string[]
  includeMix?: boolean
  /** Seconds. A `large` decode of a whole song on a CPU is minutes, not seconds. */
  timeLimitSec?: number
}

export const name = 'transcriber-muscriptor'
export const inject = ['worker-supervisor', 'analysis-store', 'ingest']

/**
 * MuScriptor: the transcriber for the full profile, and the second
 * implementation of the `transcriber` contract. Swapping it for Basic Pitch is
 * an edit to `decomposable.config.yaml`, exactly like swapping separators.
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
    'transcriber',
    createTranscriberService(ctx, manifest as PluginManifest, worker, {
      job: {
        beamSize: config.beamSize ?? 1,
        ...(config.instruments ? { instruments: config.instruments } : {}),
      },
      ...(config.includeMix ? { includeMix: true } : {}),
    }),
  )
}
