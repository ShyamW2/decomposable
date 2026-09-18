import { Context } from 'cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnalysisEvent, PluginManifest } from '../src/types.ts'
import '../src/contracts.ts'

/** Service plugins the harness can stand up for a plugin under test. */
const SERVICES: Record<string, { entry: string; config: (tmp: string) => unknown }> = {
  // Insertion order is mount order, so a service always comes after the ones it
  // itself injects.
  'analysis-store': { entry: 'kernel/src/analysis-store/index.ts', config: (tmp) => ({ root: join(tmp, 'workspaces') }) },
  'worker-supervisor': { entry: 'kernel/src/worker-supervisor/index.ts', config: () => ({ swap: 'stop-start', graceMs: 0 }) },
  ingest: { entry: 'plugins/ingest/index.ts', config: () => ({}) },
  harmony: { entry: 'plugins/harmony/index.ts', config: () => ({}) },
  midi: { entry: 'plugins/midi/index.ts', config: () => ({ settleMs: 5 }) },
  consensus: { entry: 'plugins/consensus/index.ts', config: () => ({}) },
}

export interface Harness {
  ctx: Context
  manifest: PluginManifest
  /** Everything the plugin appended while mounted. */
  events: AnalysisEvent[]
  tmp: string
  mount(config?: Record<string, unknown>): Promise<void>
  unmount(): Promise<void>
  dispose(): Promise<void>
}

export function repoRoot(): string {
  return resolve(import.meta.dirname, '..', '..')
}

export function readManifest(dir: string): PluginManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PluginManifest
}

/**
 * Stands up the smallest context a plugin can run in: its declared services and
 * nothing else. A plugin that reaches for a service it did not declare fails to
 * mount here, because Cordis refuses the access — which is the enforcement
 * behind "it only accesses services listed in inject".
 */
export async function createHarness(dir: string): Promise<Harness> {
  const manifest = readManifest(dir)
  const tmp = mkdtempSync(join(tmpdir(), 'decomposable-contract-'))
  const ctx = new Context()
  const events: AnalysisEvent[] = []
  ctx.on('analysis/appended', (appended) => events.push(...appended))

  const order = Object.keys(SERVICES)
  const needed = [...(manifest.inject ?? [])].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  for (const name of needed) {
    const service = SERVICES[name]
    if (!service) throw new Error(`the conformance harness cannot provide service "${name}"`)
    const module = await import(pathToFileURL(join(repoRoot(), service.entry)).href)
    await ctx.plugin(module, service.config(tmp))
  }

  const pluginModule = await import(pathToFileURL(join(dir, 'index.ts')).href)
  const plugin = pluginModule.default ?? pluginModule
  let fiber: Awaited<ReturnType<Context['plugin']>> | null = null

  return {
    ctx,
    manifest,
    events,
    tmp,
    async mount(config = {}) {
      if (fiber) throw new Error('already mounted')
      fiber = await ctx.plugin(plugin, config)
    },
    async unmount() {
      await fiber?.dispose()
      fiber = null
    },
    async dispose() {
      await fiber?.dispose()
      fiber = null
      // Tear down the services too, so the leak check sees a clean slate.
      await Promise.all([...ctx.registry.values()].flatMap((r) => [...r.fibers].map((f) => f.dispose())))
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

export interface ResourceSnapshot {
  handles: Record<string, number>
  pids: number[]
}

/**
 * Node's own view of what is still open. Child processes, timers and sockets all
 * appear here, which is enough to catch the failure this check exists for: a
 * plugin that forgot to register a side effect with `ctx.effect`.
 */
export function snapshotResources(pids: number[] = []): ResourceSnapshot {
  const handles: Record<string, number> = {}
  for (const type of process.getActiveResourcesInfo()) handles[type] = (handles[type] ?? 0) + 1
  return { handles, pids: [...pids] }
}

export function leakedHandles(before: ResourceSnapshot, after: ResourceSnapshot): string[] {
  const leaks: string[] = []
  for (const [type, count] of Object.entries(after.handles)) {
    const was = before.handles[type] ?? 0
    if (count > was) leaks.push(`${type}: ${was} -> ${count}`)
  }
  return leaks
}

export function aliveProcesses(pids: number[]): number[] {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
}

export const settle = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms))
