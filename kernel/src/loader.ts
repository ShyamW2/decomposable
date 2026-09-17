import { existsSync, statSync, readdirSync, watch } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'
import type { Fiber } from 'cordis'
import { readConfig, splitEntry, type MusicianConfig } from './config.ts'
import './contracts.ts'

interface Mounted {
  fiber: Fiber
  config: Record<string, unknown>
  /** Fingerprint of the plugin's source, so editing a plugin remounts it. */
  source: string
}

export interface LoaderOptions {
  /** Repository root. */
  root: string
  /** Path of musician.config.yaml. */
  configPath: string
  /** Re-reconcile when the config file changes. */
  watch?: boolean
}

/**
 * Mounts the plugins named in `musician.config.yaml` and keeps the running tree
 * matching that file.
 *
 * Reconciliation touches only what changed: a plugin whose entry is untouched is
 * never remounted, which is what makes swapping one separator for another cost
 * seconds instead of a restart. Cordis suspends anything that injected a service
 * while its provider is away and resumes it when the replacement arrives, so the
 * gap is a pause rather than a failure.
 *
 * This is a small purpose-built loader rather than `@cordisjs/plugin-loader`
 * because we want plugins addressed by directory, not by npm package (ADR-007);
 * if the upstream loader grows that, this file should go.
 */
export class Loader {
  private readonly ctx: Context
  private readonly options: LoaderOptions
  private readonly mounted = new Map<string, Mounted>()
  private reconciling: Promise<void> = Promise.resolve()

  constructor(ctx: Context, options: LoaderOptions) {
    this.ctx = ctx
    this.options = options
  }

  get names(): string[] {
    return [...this.mounted.keys()]
  }

  /** Reads the config file and makes the running tree match it. */
  reconcile(config?: MusicianConfig): Promise<void> {
    // Serialise: two overlapping reconciles would fight over the same slots.
    this.reconciling = this.reconciling.then(() => this.doReconcile(config))
    return this.reconciling
  }

  private async doReconcile(given?: MusicianConfig): Promise<void> {
    const logger = this.ctx.logger('loader')
    const config = given ?? readConfig(this.options.configPath)
    const desired = new Map<string, { config: Record<string, unknown>; entry: string; source: string }>()

    for (const [name, raw] of Object.entries(config.plugins)) {
      const { enabled, entry, config: pluginConfig } = splitEntry(raw)
      if (!enabled) continue
      const modulePath = this.resolveEntry(name, entry)
      desired.set(name, { config: pluginConfig, entry: modulePath, source: fingerprint(modulePath) })
    }

    // Unmount what is gone or changed. A changed plugin is announced first so
    // the supervisor can keep its worker warm across the gap.
    for (const [name, current] of [...this.mounted]) {
      const next = desired.get(name)
      const unchanged =
        next && JSON.stringify(next.config) === JSON.stringify(current.config) && next.source === current.source
      if (unchanged) continue
      if (next) this.ctx.get('worker-supervisor')?.expectReplacement(name)
      logger.info(next ? 'reloading %s' : 'unloading %s', name)
      await current.fiber.dispose()
      this.mounted.delete(name)
    }

    for (const [name, want] of desired) {
      if (this.mounted.has(name)) continue
      const module = await import(pathToFileURL(want.entry).href + `?v=${encodeURIComponent(want.source)}`)
      const plugin = module.default ?? module
      logger.info('loading %s', name)
      const fiber = this.ctx.plugin(plugin, want.config)
      this.mounted.set(name, { fiber, config: want.config, source: want.source })
    }
  }

  /**
   * Watches the config file; every change is a reconcile.
   *
   * The watch is on the containing directory, not the file: most editors (and
   * `sed -i`) save by writing a temporary file and renaming it over the target,
   * which leaves a file watcher holding a deleted inode and silently blind from
   * the second save onwards.
   */
  startWatching(): () => void {
    const dir = resolve(this.options.configPath, '..')
    const file = basename(this.options.configPath)
    let timer: NodeJS.Timeout | null = null
    const watcher = watch(dir, (_event, name) => {
      if (name !== file) return
      if (timer) clearTimeout(timer)
      // Editors write in bursts; one reconcile per burst.
      timer = setTimeout(() => {
        this.reconcile().catch((error: Error) =>
          this.ctx.logger('loader').error('reconcile failed: %s', error.message),
        )
      }, 150)
      timer.unref()
    })
    return () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    }
  }

  async unloadAll(): Promise<void> {
    for (const [name, current] of [...this.mounted]) {
      await current.fiber.dispose()
      this.mounted.delete(name)
    }
  }

  private resolveEntry(name: string, override?: string): string {
    if (override) return resolve(this.options.root, override)
    const candidates = [
      join(this.options.root, 'kernel', 'src', name, 'index.ts'),
      join(this.options.root, 'plugins', name, 'index.ts'),
    ]
    const found = candidates.find((path) => existsSync(path))
    if (!found) {
      throw new Error(`plugin "${name}" not found; looked in ${candidates.join(' and ')}`)
    }
    return found
  }
}

/**
 * Mtimes of a plugin's own source files. Node caches modules by URL, so the
 * fingerprint goes in the import URL: edit a plugin and the next reconcile runs
 * the new code. Files the plugin imports from elsewhere are not covered; touch
 * the config to force a reload after changing those.
 */
function fingerprint(entry: string): string {
  const dir = resolve(entry, '..')
  let newest = 0
  const visit = (path: string, depth: number) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.name === '.venv' || item.name === 'node_modules' || item.name === '__pycache__') continue
      const child = join(path, item.name)
      if (item.isDirectory()) {
        if (depth > 0) visit(child, depth - 1)
        continue
      }
      if (!/\.(ts|json|py|sql)$/.test(item.name)) continue
      newest = Math.max(newest, statSync(child).mtimeMs)
    }
  }
  visit(dir, 2)
  return String(Math.round(newest))
}
