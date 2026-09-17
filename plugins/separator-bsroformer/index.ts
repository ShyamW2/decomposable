import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import { createSeparatorService } from '#kernel/separator-service.ts'
import '#kernel/contracts.ts'

export interface Config {
  device?: DeviceRequest
  profile?: ProfileRequest
  /** Seconds. Roformer is slower than Demucs on a CPU; leave this unset there. */
  timeLimitSec?: number
}

export const name = 'separator-bsroformer'
export const inject = ['worker-supervisor', 'analysis-store', 'ingest']

/**
 * Stem separation with Band-Split / Mel-Band RoFormer.
 *
 * The second implementation of the `separator` contract, and the reason the
 * contract returns a list of *named* stems rather than promising four of them:
 * these models split a song into vocals and instrumental, not into a drum kit.
 * Switching to it from the UI is the Phase 1 exit criterion.
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

  ctx.provide('separator', createSeparatorService(ctx, manifest as PluginManifest, worker))
}
