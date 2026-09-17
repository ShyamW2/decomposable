import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import type { DeviceRequest, PluginManifest, ProfileRequest } from '#kernel/types.ts'
import '#kernel/contracts.ts'

export interface Config {
  /** Which build of the worker to run. Changing this is the hot-swap demo. */
  version?: 1 | 2
  device?: DeviceRequest
  profile?: ProfileRequest
  /** Seconds; 0 means no limit. */
  timeLimitSec?: number
}

export interface EchoResult {
  text: string
  workerVersion: string
  device: string
  model: string
  pid: number
}

export interface EchoService {
  echo(text: string, opts?: { delayMs?: number; signal?: AbortSignal }): Promise<EchoResult>
  info(): { workerVersion: number; device: string; profile: string; model: string }
}

declare module 'cordis' {
  interface Context {
    echo: EchoService
  }
}

export const name = 'echo'
export const inject = ['worker-supervisor']

export function apply(ctx: Context, config: Config = {}) {
  const version = config.version ?? 1
  const worker = ctx['worker-supervisor'].acquire({
    slot: 'echo',
    manifest: (manifest as PluginManifest).worker!,
    device: config.device ?? 'auto',
    profile: config.profile ?? 'auto',
    env: { ECHO_VERSION: String(version) },
    timeLimitSec: config.timeLimitSec ?? 0,
  })
  ctx.effect(() => () => worker.release(), 'echo:worker')

  ctx.provide('echo', {
    echo: (text, opts = {}) =>
      worker.run<EchoResult>(
        { kind: 'echo', text, delayMs: opts.delayMs ?? 0 },
        opts.signal ? { signal: opts.signal } : {},
      ),
    info: () => ({ workerVersion: version, device: worker.device, profile: worker.profile, model: worker.model }),
  } satisfies EchoService)
}
