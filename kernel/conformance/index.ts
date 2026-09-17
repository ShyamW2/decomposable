import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LAYERS, type PluginManifest } from '../src/types.ts'
import {
  aliveProcesses,
  createHarness,
  leakedHandles,
  readManifest,
  settle,
  snapshotResources,
  type Harness,
} from './harness.ts'

export interface ContractOptions {
  /** The plugin directory; pass `import.meta.dirname`. */
  dir: string
  /** Config the plugin is mounted with during the suite. */
  config?: Record<string, unknown>
  /** Kind-specific checks, run with the plugin mounted. */
  golden?: (harness: Harness) => Promise<void> | void
}

/**
 * The contract every plugin must satisfy (03-architecture). A plugin without a
 * passing contract test does not merge, and this is the same suite the in-app
 * agent is handed when it is asked to write a plugin (ADR-006), so it has to be
 * runnable without knowing anything about the plugin beyond its manifest.
 */
export function contractSuite(options: ContractOptions): void {
  const manifest = readManifest(options.dir)
  const config = options.config ?? {}

  describe(`plugin contract: ${manifest.name}@${manifest.version}`, () => {
    it('has a manifest the kernel can act on', () => {
      expectValidManifest(manifest, options.dir)
    })

    it('declares the same services it injects', async () => {
      const module = await import(join(options.dir, 'index.ts'))
      const declared = [...(module.inject ?? [])].sort()
      expect(declared).toEqual([...(manifest.inject ?? [])].sort())
      expect(module.name ?? module.default?.name).toBe(manifest.name)
    })

    it('mounts and unmounts three times without leaking', async () => {
      const harness = await createHarness(options.dir)
      try {
        // One warm-up cycle first: the first mount of anything pays for lazy
        // imports and venv resolution, which are not leaks.
        await harness.mount(config)
        await harness.unmount()
        await settle()

        const before = snapshotResources()
        const pids: number[] = []
        for (let i = 0; i < 3; i++) {
          await harness.mount(config)
          const supervisor = harness.ctx.get('worker-supervisor')
          if (supervisor) {
            await settle(50)
            for (const slot of supervisor.status()) if (slot.pid) pids.push(slot.pid)
          }
          await harness.unmount()
          await settle()
        }
        const after = snapshotResources()

        if (manifest.kind === 'py-worker') {
          // Otherwise the check below would pass by never having started anything.
          expect(pids.length, 'no worker process was observed, so nothing was checked').toBeGreaterThanOrEqual(3)
        }
        expect(aliveProcesses(pids), 'worker processes still running after unmount').toEqual([])
        expect(leakedHandles(before, after), 'handles still open after unmount').toEqual([])
      } finally {
        await harness.dispose()
      }
    })

    it('provides what its manifest promises', async () => {
      const harness = await createHarness(options.dir)
      try {
        await harness.mount(config)
        for (const provided of manifest.provides ?? []) {
          expect(harness.ctx.get(provided), `service "${provided}" was not provided`).toBeTruthy()
        }
      } finally {
        await harness.dispose()
      }
    })

    it('puts provenance on everything it appends', async () => {
      const harness = await createHarness(options.dir)
      try {
        await harness.mount(config)
        await options.golden?.(harness)
        for (const event of harness.events) {
          expect(event.producer.plugin, 'event producer must be the plugin').toBe(manifest.name)
          expect(event.producer.version, 'event producer version must match the manifest').toBe(manifest.version)
          expect(LAYERS, `unknown layer "${event.layer}"`).toContain(event.layer)
          expect(Array.isArray(event.inputs)).toBe(true)
          if (event.confidence !== undefined) {
            expect(event.confidence).toBeGreaterThanOrEqual(0)
            expect(event.confidence).toBeLessThanOrEqual(1)
          }
        }
      } finally {
        await harness.dispose()
      }
    })

    if (manifest.kind === 'py-worker') {
      it('answers hello inside its warm-up budget and survives a bad job', async () => {
        const harness = await createHarness(options.dir)
        try {
          await harness.mount(config)
          const supervisor = harness.ctx.get('worker-supervisor')
          expect(supervisor, 'a py-worker must inject worker-supervisor').toBeTruthy()
          // A slot of our own, so the plugin's own worker is left alone.
          const worker = supervisor!.acquire({
            slot: `${manifest.name}-contract`,
            manifest: manifest.worker!,
            device: 'cpu',
            profile: 'lite',
          })
          try {
            const started = Date.now()
            const hello = await worker.ready()
            expect(Date.now() - started).toBeLessThan(manifest.worker!.warmupBudget * 1000)
            expect(hello.name).toBe(manifest.name)

            await expect(worker.run({ kind: 'not-a-job-kind', nonsense: [1, null] })).rejects.toThrow()
            // Still alive: a malformed job is a failed call, not a dead process.
            const hello2 = await worker.ready()
            expect(hello2.name).toBe(manifest.name)
          } finally {
            await worker.release()
          }
        } finally {
          await harness.dispose()
        }
      })
    }
  })
}

function expectValidManifest(manifest: PluginManifest, dir: string): void {
  expect(manifest.name, 'manifest.name').toMatch(/^[a-z0-9][a-z0-9-]*$/)
  expect(manifest.version, 'manifest.version').toMatch(/^\d+\.\d+\.\d+/)
  expect(['ts', 'py-worker']).toContain(manifest.kind)
  expect(existsSync(join(dir, 'index.ts')), 'plugins/<name>/index.ts').toBe(true)
  expect(existsSync(join(dir, 'README.md')), 'plugins/<name>/README.md').toBe(true)
  if (manifest.kind === 'py-worker') {
    const worker = manifest.worker
    expect(worker, 'a py-worker manifest needs a "worker" section').toBeTruthy()
    expect(worker!.devices.length, 'a worker must support at least one device').toBeGreaterThan(0)
    expect(worker!.devices, 'every worker must run on the cpu baseline').toContain('cpu')
    expect(worker!.warmupBudget).toBeGreaterThan(0)
    for (const profile of ['lite', 'full'] as const) {
      expect(worker!.models[profile]?.id, `models.${profile}.id`).toBeTruthy()
      expect(worker!.models[profile]?.peakMemoryMiB, `models.${profile}.peakMemoryMiB`).toBeGreaterThan(0)
    }
  }
}

export { createHarness, type Harness } from './harness.ts'
