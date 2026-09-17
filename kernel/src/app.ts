import { Context } from 'cordis'
import { join, resolve } from 'node:path'
import { Loader } from './loader.ts'
import { useConsoleLogging } from './logging.ts'
import './contracts.ts'

export interface AppOptions {
  root?: string
  configPath?: string
  watch?: boolean
}

export interface App {
  ctx: Context
  loader: Loader
  stop(): Promise<void>
}

/**
 * Boots the kernel: one root context, one loader, whatever the config file says.
 * Nothing else is hard-coded here — the analysis store and the worker supervisor
 * are plugins like any other, which is the point (CLAUDE.md non-negotiable 1).
 */
export async function start(options: AppOptions = {}): Promise<App> {
  const root = resolve(options.root ?? process.cwd())
  const configPath = resolve(options.configPath ?? join(root, 'decomposable.config.yaml'))
  const ctx = new Context()
  useConsoleLogging(ctx)
  const loader = new Loader(ctx, { root, configPath, ...(options.watch ? { watch: true } : {}) })

  await loader.reconcile()
  const stopWatching = options.watch ? loader.startWatching() : () => {}

  return {
    ctx,
    loader,
    async stop() {
      stopWatching()
      await loader.unloadAll()
    },
  }
}
